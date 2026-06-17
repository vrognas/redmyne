import Fuse, { IFuseOptions } from "fuse.js";
import type { IRedmineServer } from "../redmine/redmine-server-interface";
import { Issue } from "../redmine/models/issue";
import { RedmineProject } from "../redmine/redmine-project";

/**
 * Pure issue fuzzy-search engine for the issue picker.
 *
 * Owns query/operator parsing, the Fuse.js index + ranking boosts, the
 * multi-source candidate fan-out, and the search-side caches (prefix cache +
 * Fuse index cache). No vscode dependency — only the server interface and
 * issue/project models — so the search logic is unit-testable in isolation.
 *
 * QuickPick orchestration, item construction, and the my-issues / project-path
 * / time-tracking data caches stay in issue-picker.ts.
 */

// Fuzzy search configuration
interface SearchableIssue {
  id: string;
  subject: string;
  project: string;
  original: Issue;
}

/**
 * Search result from searchIssuesWithFuzzy
 */
export interface IssueSearchResult {
  results: Issue[];
  exactMatch: Issue | null;
  exactMatchError: string | null; // "no access" | "not found" | null
}

const FUSE_OPTIONS: IFuseOptions<SearchableIssue> = {
  keys: [
    { name: "subject", weight: 2 },
    { name: "project", weight: 1.5 },
    { name: "id", weight: 1 },
  ],
  threshold: 0.4,
  ignoreLocation: true,
  includeScore: true,
  useExtendedSearch: true,  // Enable space-separated AND queries
};

// Score penalties for ranking (lower score = higher rank)
// Fuse.js scores are 0.0-0.4, penalties create clear tier separation
const NON_ASSIGNED_PENALTY = 1.0;  // Non-assigned below assigned
const CLOSED_PENALTY = 0.5;        // Closed below open
const RECENT_BOOST = -0.3;         // Recent issues get priority

// Search operators regex
const OPERATOR_REGEX = /\b(project|status):("[^"]+"|[^\s]+)/gi;

// Search result cache for prefix-extension optimization
interface SearchResultCache {
  query: string;
  candidates: Issue[];
  timestamp: number;
  serverAddress: string;
}
let searchResultCache: SearchResultCache | null = null;
const SEARCH_CACHE_TTL_MS = 5 * 1000; // 5 seconds

// Fuse index cache (module-level)
interface FuseCache {
  fuse: Fuse<SearchableIssue>;
  issueIds: Set<number>;
  timestamp: number;
}
let fuseCache: FuseCache | null = null;
const FUSE_CACHE_TTL_MS = 60 * 1000; // 1 minute

/**
 * Build map of projectId → full ancestor path (e.g., "Nuvalent > Subproject")
 */
export function buildProjectPathMap(projects: RedmineProject[]): Map<number, string> {
  const projectMap = new Map<number, RedmineProject>();
  for (const p of projects) {
    projectMap.set(p.id, p);
  }

  const pathCache = new Map<number, string>();

  // Check if project is a root (client) - has no parent
  function isRoot(projectId: number): boolean {
    const project = projectMap.get(projectId);
    return !project?.parent?.id;
  }

  function getPath(projectId: number): string {
    if (pathCache.has(projectId)) return pathCache.get(projectId)!;

    const project = projectMap.get(projectId);
    if (!project) return "";

    let path = project.name;
    if (project.parent?.id) {
      const parentPath = getPath(project.parent.id);
      if (parentPath) {
        // Use ": " after client (root), " / " for deeper levels
        const separator = isRoot(project.parent.id) ? ": " : " / ";
        path = `${parentPath}${separator}${project.name}`;
      }
    }
    pathCache.set(projectId, path);
    return path;
  }

  for (const p of projects) {
    getPath(p.id);
  }
  return pathCache;
}

/**
 * Parse search operators from query (project:xxx, status:xxx)
 * Returns the remaining query and extracted filters
 */
export function parseSearchOperators(query: string): {
  textQuery: string;
  projectFilter?: string;
  statusFilter?: string;
} {
  let textQuery = query;
  let projectFilter: string | undefined;
  let statusFilter: string | undefined;

  const matches = query.matchAll(OPERATOR_REGEX);
  for (const match of matches) {
    const [fullMatch, operator, value] = match;
    if (!operator || value === undefined) continue;
    const cleanValue = value.replace(/^"|"$/g, "").toLowerCase();
    if (operator.toLowerCase() === "project") {
      projectFilter = cleanValue;
    } else if (operator.toLowerCase() === "status") {
      statusFilter = cleanValue;
    }
    textQuery = textQuery.replace(fullMatch, "");
  }

  return { textQuery: textQuery.trim(), projectFilter, statusFilter };
}

/**
 * Get or create Fuse index with caching
 */
function getOrCreateFuse(
  issues: Issue[],
  projectPathMap?: Map<number, string>
): Fuse<SearchableIssue> {
  const now = Date.now();
  const currentIds = new Set(issues.map(i => i.id));

  // Check cache validity
  if (
    fuseCache &&
    now - fuseCache.timestamp < FUSE_CACHE_TTL_MS &&
    currentIds.size === fuseCache.issueIds.size &&
    [...currentIds].every(id => fuseCache!.issueIds.has(id))
  ) {
    return fuseCache.fuse;
  }

  // Build new index
  const searchable: SearchableIssue[] = issues.map((i) => ({
    id: String(i.id),
    subject: i.subject,
    project: projectPathMap?.get(i.project?.id ?? 0) ?? i.project?.name ?? "",
    original: i,
  }));

  const fuse = new Fuse(searchable, FUSE_OPTIONS);
  fuseCache = { fuse, issueIds: currentIds, timestamp: now };
  return fuse;
}

/**
 * Fuzzy search issues by query (searches id, subject, project path)
 * For multi-word queries, all terms must match (AND logic)
 * Ranking: recent > assigned+open > assigned+closed > unassigned+open > unassigned+closed
 * Supports operators: project:xxx, status:xxx
 */
export function fuzzyFilterIssues(
  issues: Issue[],
  query: string,
  projectPathMap?: Map<number, string>,
  assignedIds?: Set<number>,
  recentIds?: Set<number>
): Issue[] {
  // Parse search operators
  const { textQuery, projectFilter, statusFilter } = parseSearchOperators(query);

  // Pre-filter by operators
  let filtered = issues;
  if (projectFilter) {
    filtered = filtered.filter(i => {
      const projectPath = projectPathMap?.get(i.project?.id ?? 0) ?? i.project?.name ?? "";
      return projectPath.toLowerCase().includes(projectFilter);
    });
  }
  if (statusFilter) {
    filtered = filtered.filter(i =>
      i.status?.name?.toLowerCase().includes(statusFilter)
    );
  }

  const tokens = textQuery.split(/\s+/).filter(t => t);
  if (tokens.length === 0) return filtered;

  // Get cached Fuse index (rebuild if issues changed)
  const fuse = getOrCreateFuse(filtered, projectPathMap);

  // Helper to apply ranking boosts
  const applyBoosts = (score: number, issue: Issue): number => {
    let adjusted = score;

    // Recent boost
    if (recentIds?.has(issue.id)) {
      adjusted += RECENT_BOOST;
    }

    // Assignment penalty
    if (!assignedIds?.has(issue.id)) {
      adjusted += NON_ASSIGNED_PENALTY;
    }

    // Closed penalty
    if (issue.status?.is_closed) {
      adjusted += CLOSED_PENALTY;
    }

    return adjusted;
  };

  if (tokens.length === 1) {
    const results = fuse.search(tokens[0]!);
    const scored = results.map(r => ({
      score: applyBoosts(r.score ?? 0, r.item.original),
      item: r.item,
      matches: r.matches,
    }));
    scored.sort((a, b) => a.score - b.score);
    return scored.map(r => r.item.original);
  }

  // Multi-token: search once per token, intersect results
  const tokenResultMaps = tokens.map(token => {
    const results = fuse.search(token);
    return new Map(results.map(r => [r.item.id, { score: r.score ?? 1, item: r.item, matches: r.matches }]));
  });

  // Find items present in ALL token results, sum scores
  const firstMap = tokenResultMaps[0]!;
  const intersection: Array<{ totalScore: number; item: SearchableIssue }> = [];

  for (const [id, { score, item }] of firstMap) {
    let totalScore = score;
    let inAll = true;

    for (let i = 1; i < tokenResultMaps.length; i++) {
      const match = tokenResultMaps[i]!.get(id);
      if (!match) {
        inAll = false;
        break;
      }
      totalScore += match.score;
    }

    if (inAll) {
      totalScore = applyBoosts(totalScore, item.original);
      intersection.push({ totalScore, item });
    }
  }

  intersection.sort((a, b) => a.totalScore - b.totalScore);
  return intersection.map((i) => i.item.original);
}

/**
 * Search issues across multiple sources with fuzzy matching
 * - Searches server with the full query string
 * - Searches projects by name and fetches their issues
 * - Applies fuzzy matching to rank all candidates
 * - Uses prefix cache: if new query extends a recent cached query, skips server
 */
export async function searchIssuesWithFuzzy(
  server: IRedmineServer,
  query: string,
  localIssues: Issue[],
  projectPathMap: Map<number, string>,
  recentIds?: Set<number>
): Promise<IssueSearchResult> {
  const cleanQuery = query.replace(/^#/, "");
  const possibleId = parseInt(cleanQuery, 10);
  const isNumericQuery = !isNaN(possibleId) && cleanQuery === String(possibleId);
  const queryTokens = query.trim().split(/\s+/).filter(t => t.length >= 2);

  // Prefix cache: if query extends a recent cached query, skip server calls
  const serverAddress = server.options?.address ?? "";
  const hasOperators = query.includes(":");
  if (
    searchResultCache &&
    searchResultCache.serverAddress === serverAddress &&
    Date.now() - searchResultCache.timestamp < SEARCH_CACHE_TTL_MS &&
    searchResultCache.query.length >= 2 &&
    query.toLowerCase().startsWith(searchResultCache.query.toLowerCase()) &&
    !isNumericQuery && // Always fetch fresh for exact ID lookups
    !hasOperators // Operators change filter semantics — don't reuse cached set
  ) {
    const assignedIds = new Set(localIssues.map(i => i.id));
    const results = fuzzyFilterIssues(
      searchResultCache.candidates, query, projectPathMap, assignedIds, recentIds
    );
    return { results, exactMatch: null, exactMatchError: null };
  }

  // Find projects matching any token (for project-name search)
  const matchingProjectIds: number[] = [];
  for (const token of queryTokens) {
    const lowerToken = token.toLowerCase();
    for (const [projectId, path] of projectPathMap.entries()) {
      if (path.toLowerCase().includes(lowerToken) && !matchingProjectIds.includes(projectId)) {
        matchingProjectIds.push(projectId);
      }
    }
  }

  // Parallel fetch: exact ID + search + project issues
  let exactMatch: Issue | null = null;
  let exactMatchError: string | null = null;
  const serverResults: Issue[] = [];

  await Promise.all([
    // Exact ID lookup
    (async () => {
      if (isNumericQuery) {
        try {
          const result = await server.getIssueById(possibleId);
          exactMatch = result.issue;
        } catch (error: unknown) {
          if (error instanceof Error) {
            exactMatchError = error.message.includes("403") ? "no access" :
                             error.message.includes("404") ? "not found" : null;
          }
        }
      }
    })(),
    // Search full query (Redmine handles multi-word natively; Fuse.js ranks client-side)
    (async () => {
      const results = await server.searchIssues(query, 25);
      serverResults.push(...results);
    })(),
    // Fetch issues from projects matching search tokens (include subprojects + closed)
    ...matchingProjectIds.slice(0, 3).map(async (projectId) => {
      try {
        const result = await server.getOpenIssuesForProject(projectId, true, 30, false);
        serverResults.push(...result.issues);
      } catch { /* ignore - project may not be accessible */ }
    }),
  ]);

  // Collect all unique candidates
  const seenIds = new Set<number>();
  const candidateIssues: Issue[] = [];

  if (exactMatch !== null) {
    // Type assertion needed: TS can't track mutations inside Promise.all closures
    const matchedIssue = exactMatch as Issue;
    candidateIssues.push(matchedIssue);
    seenIds.add(matchedIssue.id);
  }
  for (const issue of localIssues) {
    if (!seenIds.has(issue.id)) {
      candidateIssues.push(issue);
      seenIds.add(issue.id);
    }
  }
  for (const issue of serverResults) {
    if (!seenIds.has(issue.id)) {
      candidateIssues.push(issue);
      seenIds.add(issue.id);
    }
  }

  // Cache candidates for prefix-extension optimization
  searchResultCache = {
    query,
    candidates: candidateIssues,
    timestamp: Date.now(),
    serverAddress,
  };

  // Apply fuzzy search for ranking (assigned issues ranked higher)
  const assignedIds = new Set(localIssues.map(i => i.id));
  const results = fuzzyFilterIssues(candidateIssues, query, projectPathMap, assignedIds, recentIds);

  return { results, exactMatch, exactMatchError };
}
