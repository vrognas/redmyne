import * as vscode from "vscode";
import Fuse, { IFuseOptions } from "fuse.js";
import type { IRedmineServer } from "../redmine/redmine-server-interface";
import { Issue } from "../redmine/models/issue";
import { TimeEntryActivity } from "../redmine/models/common";
import { RedmineProject } from "../redmine/redmine-project";
import { debounce } from "./debounce";
import { recordRecentIssue, getRecentIssueIds } from "./recent-issues";

const SEARCH_DEBOUNCE_MS = 250;
const PROJECT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isNonZeroNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && value !== 0 && !Number.isNaN(value);
}

type QuickPickWithSortByLabel<T extends vscode.QuickPickItem> = vscode.QuickPick<T> & {
  sortByLabel: boolean;
};

function hasSortByLabel<T extends vscode.QuickPickItem>(
  quickPick: vscode.QuickPick<T>
): quickPick is QuickPickWithSortByLabel<T> {
  return "sortByLabel" in quickPick;
}

// Project path cache (module-level, shared across picker invocations)
interface ProjectPathCache {
  map: Map<number, string>;
  timestamp: number;
  serverAddress: string;
}
let projectPathCache: ProjectPathCache | null = null;

// Time tracking status cache (module-level, shared across picker invocations)
interface TimeTrackingStatusCache {
  map: Map<number, boolean>;
  timestamp: number;
  serverAddress: string;
}
let timeTrackingStatusCache: TimeTrackingStatusCache | null = null;

/**
 * Get or check time tracking status for projects with caching.
 * Returns cached results immediately, fetches only uncached project IDs.
 */
async function getTimeTrackingStatusCached(
  server: IRedmineServer,
  projectIds: number[]
): Promise<Map<number, boolean>> {
  const serverAddress = server.options.address;
  const isCacheValid =
    timeTrackingStatusCache &&
    timeTrackingStatusCache.serverAddress === serverAddress &&
    Date.now() - timeTrackingStatusCache.timestamp < PROJECT_CACHE_TTL_MS;

  // Copy cached map to avoid mutating the live cache during concurrent reads
  const result = isCacheValid
    ? new Map(timeTrackingStatusCache!.map)
    : new Map<number, boolean>();
  const uncached = projectIds.filter((id) => !result.has(id));

  if (uncached.length > 0) {
    await Promise.all(
      uncached.map(async (projectId) => {
        try {
          const enabled = await server.isTimeTrackingEnabled(projectId);
          result.set(projectId, enabled);
        } catch {
          result.set(projectId, true); // Fail open
        }
      })
    );
    // Merge into existing cache (don't overwrite concurrent writes)
    timeTrackingStatusCache = {
      map: new Map([...(timeTrackingStatusCache?.map ?? []), ...result]),
      timestamp: Date.now(),
      serverAddress,
    };
  }

  return result;
}

/**
 * Build QuickPick items from categorized issue lists
 */
function buildIssuePickerItems(
  trackableOpen: Issue[],
  trackableClosed: Issue[],
  nonTrackable: Issue[],
  projectPathMap: Map<number, string>,
  allowSkip: boolean
): IssueQuickPickItem[] {
  // Collect recent issues from all trackable lists (open + closed), sorted by recency
  const recentIssueIdsList = getRecentIssueIds();
  const allTrackable = [...trackableOpen, ...trackableClosed];
  const recentIssues = recentIssueIdsList
    .filter((id) => allTrackable.some((i) => i.id === id))
    .slice(0, 5)
    .map((id) => allTrackable.find((i) => i.id === id)!);
  const recentIdSet = new Set(recentIssues.map((i) => i.id));

  const otherOpen = trackableOpen.filter((i) => !recentIdSet.has(i.id));
  const otherClosed = trackableClosed.filter((i) => !recentIdSet.has(i.id));
  const items: IssueQuickPickItem[] = [];

  if (recentIssues.length > 0) {
    items.push({ label: "Recent", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
    for (const issue of recentIssues) {
      const isClosed = issue.status?.is_closed ?? false;
      const icon = isClosed ? "$(archive)" : "$(history)";
      const statusTag = isClosed ? ` · ${issue.status?.name ?? "closed"}` : "";
      items.push({
        label: `${icon} #${issue.id} ${issue.subject}`,
        description: `${issue.assigned_to?.name ?? "Unassigned"}${statusTag}`,
        detail: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name,
        issue,
        disabled: false,
      });
    }
  }

  if (otherOpen.length > 0) {
    items.push({ label: "My Open", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
    for (const issue of otherOpen) {
      items.push({
        label: `#${issue.id} ${issue.subject}`,
        description: issue.assigned_to?.name ?? "Unassigned",
        detail: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name,
        issue,
        disabled: false,
      });
    }
  }

  if (otherClosed.length > 0) {
    items.push({ label: "My Closed", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
    for (const issue of otherClosed.slice(0, 20)) {
      items.push({
        label: `$(archive) #${issue.id} ${issue.subject}`,
        description: `${issue.assigned_to?.name ?? "Unassigned"} · ${issue.status?.name ?? "closed"}`,
        detail: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name,
        issue,
        disabled: false,
      });
    }
  }

  if (nonTrackable.length > 0) {
    items.push({ label: "No Time Tracking", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
    for (const issue of nonTrackable) {
      items.push({
        label: `$(circle-slash) #${issue.id} ${issue.subject}`,
        description: issue.assigned_to?.name ?? "Unassigned",
        detail: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name ?? "Unknown",
        issue,
        disabled: true,
      });
    }
  }

  if (allowSkip) {
    items.push({ label: "$(dash) Skip (assign later)", action: "skip" });
  }

  return items;
}

/**
 * Get or build project path map with caching
 */
export async function getProjectPathMap(server: IRedmineServer): Promise<Map<number, string>> {
  const now = Date.now();
  const serverAddress = server.options.address;

  // Return cached if valid and same server
  if (
    projectPathCache &&
    projectPathCache.serverAddress === serverAddress &&
    now - projectPathCache.timestamp < PROJECT_CACHE_TTL_MS
  ) {
    return projectPathCache.map;
  }

  // Fetch fresh data
  try {
    const projects = await server.getProjects();
    const map = buildProjectPathMap(projects);
    projectPathCache = { map, timestamp: now, serverAddress };
    return map;
  } catch {
    // Return empty map on error (fallback to direct project name)
    return projectPathCache?.map ?? new Map();
  }
}

/**
 * Search result from searchIssuesWithFuzzy
 */
interface IssueSearchResult {
  results: Issue[];
  exactMatch: Issue | null;
  exactMatchError: string | null; // "no access" | "not found" | null
}

// Search result cache for prefix-extension optimization
interface SearchResultCache {
  query: string;
  candidates: Issue[];
  timestamp: number;
  serverAddress: string;
}
let searchResultCache: SearchResultCache | null = null;
const SEARCH_CACHE_TTL_MS = 5 * 1000; // 5 seconds

/**
 * Search issues across multiple sources with fuzzy matching
 * - Searches server with the full query string
 * - Searches projects by name and fetches their issues
 * - Applies fuzzy matching to rank all candidates
 * - Uses prefix cache: if new query extends a recent cached query, skips server
 */
async function searchIssuesWithFuzzy(
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

// Fuzzy search configuration
interface SearchableIssue {
  id: string;
  subject: string;
  project: string;
  original: Issue;
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

// Score penalties for ranking (lower score = higher rank)
// Fuse.js scores are 0.0-0.4, penalties create clear tier separation
const NON_ASSIGNED_PENALTY = 1.0;  // Non-assigned below assigned
const CLOSED_PENALTY = 0.5;        // Closed below open
const RECENT_BOOST = -0.3;         // Recent issues get priority

// Fuse index cache (module-level)
interface FuseCache {
  fuse: Fuse<SearchableIssue>;
  issueIds: Set<number>;
  timestamp: number;
}
let fuseCache: FuseCache | null = null;
const FUSE_CACHE_TTL_MS = 60 * 1000; // 1 minute

// Search operators regex
const OPERATOR_REGEX = /\b(project|status):("[^"]+"|[^\s]+)/gi;

/**
 * Parse search operators from query (project:xxx, status:xxx)
 * Returns the remaining query and extracted filters
 */
function parseSearchOperators(query: string): {
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
function fuzzyFilterIssues(
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
    const results = fuse.search(tokens[0]);
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
  const firstMap = tokenResultMaps[0];
  const intersection: Array<{ totalScore: number; item: SearchableIssue }> = [];

  for (const [id, { score, item }] of firstMap) {
    let totalScore = score;
    let inAll = true;

    for (let i = 1; i < tokenResultMaps.length; i++) {
      const match = tokenResultMaps[i].get(id);
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

interface IssueQuickPickItem extends vscode.QuickPickItem {
  issue?: Issue;
  action?: "search" | "skip";
  disabled?: boolean;
}

interface ActivityQuickPickItem extends vscode.QuickPickItem {
  activity: TimeEntryActivity;
}

/**
 * Show activity picker QuickPick
 */
async function showActivityPicker(
  activities: TimeEntryActivity[],
  title: string,
  placeHolder: string
): Promise<TimeEntryActivity | undefined> {
  const items: ActivityQuickPickItem[] = activities.map((a) => ({
    label: a.name,
    description: a.is_default ? "Default" : undefined,
    activity: a,
  }));

  const choice = await vscode.window.showQuickPick(items, { title, placeHolder });
  return choice?.activity;
}

export interface PickedIssueAndActivity {
  issueId: number;
  issueSubject: string;
  activityId: number;
  activityName: string;
}

/**
 * Pick an issue with inline search and activity selection
 * Shared between timer dialogs and quick-log-time
 */
export async function pickIssueWithSearch(
  server: IRedmineServer,
  title: string,
  options?: {
    allowSkip?: boolean; // Show "Skip" option (default: false)
  }
): Promise<PickedIssueAndActivity | "skip" | undefined> {
  const allowSkip = options?.allowSkip ?? false;

  // Show picker IMMEDIATELY — load data in background
  const selectedIssue = await new Promise<Issue | "skip" | undefined>((resolve) => {
    const quickPick = vscode.window.createQuickPick<IssueQuickPickItem>();
    quickPick.title = title;
    quickPick.placeholder = "Loading issues...";
    quickPick.busy = true;
    if (hasSortByLabel(quickPick)) {
      quickPick.sortByLabel = false;
    }
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    // Mutable shared state — populated asynchronously
    let baseItems: IssueQuickPickItem[] = [];
    let issues: Issue[] = [];
    let myIssueIds = new Set<number>();
    let projectPathMap = new Map<number, string>();
    let recentIds = new Set<number>();
    let timeTrackingByProject = new Map<number, boolean>();

    let resolved = false;
    let searchVersion = 0;

    const handleSelection = (selected: IssueQuickPickItem): boolean => {
      if (resolved) return false;

      if (selected.action === "skip") {
        resolved = true;
        quickPick.dispose();
        resolve("skip");
        return true;
      }

      if (selected.disabled) {
        vscode.window.showInformationMessage(
          `Project "${selected.issue?.project?.name}" has no time tracking enabled`
        );
        return false;
      }

      if (selected.issue) {
        resolved = true;
        recordRecentIssue(
          selected.issue.id,
          selected.issue.subject,
          selected.issue.project?.name ?? ""
        );
        quickPick.dispose();
        resolve(selected.issue);
        return true;
      }
      return false;
    };

    const debouncedSearch = debounce(SEARCH_DEBOUNCE_MS, async (query: string) => {
      if (query.length < 2) return;

      const thisSearchVersion = ++searchVersion;
      quickPick.busy = true;

      try {
        const cleanQuery = query.replace(/^#/, "");
        const possibleId = parseInt(cleanQuery, 10);
        const isNumericQuery = !isNaN(possibleId) && cleanQuery === String(possibleId);

        const { results: allResults, exactMatchError } = await searchIssuesWithFuzzy(
          server,
          query,
          issues,
          projectPathMap,
          recentIds
        );

        // Check time tracking for new projects (uses cache)
        const newProjectIds = [...new Set(
          allResults
            .map(i => i.project?.id)
            .filter((id): id is number => id !== null && id !== undefined && !timeTrackingByProject.has(id))
        )];

        if (newProjectIds.length > 0) {
          const newStatuses = await getTimeTrackingStatusCached(server, newProjectIds);
          for (const [id, enabled] of newStatuses) {
            timeTrackingByProject.set(id, enabled);
          }
        }

        const trackableResults = allResults.filter((issue) => {
          const projectId = issue.project?.id;
          return projectId !== null && projectId !== undefined && timeTrackingByProject.get(projectId) !== false;
        });

        if (thisSearchVersion !== searchVersion || resolved) return;

        const limitedResults = trackableResults.slice(0, 15);
        const resultItems: IssueQuickPickItem[] = [];

        if (isNumericQuery && exactMatchError && limitedResults.length === 0) {
          resultItems.push({
            label: `$(error) #${possibleId} ${exactMatchError}`,
            disabled: true,
            alwaysShow: true,
          });
        }

        if (limitedResults.length === 0 && resultItems.length === 0) {
          resultItems.push({
            label: `$(info) No results for "${query}"`,
            disabled: true,
            alwaysShow: true,
          });
        }

        for (const issue of limitedResults) {
          const isMine = myIssueIds.has(issue.id);
          const isClosed = issue.status?.is_closed ?? false;
          const icon = isClosed ? "$(archive)" : isMine ? "$(account)" : "$(search)";
          const tagStr = isClosed ? " (closed)" : "";
          resultItems.push({
            label: `${icon} #${issue.id} ${issue.subject}`,
            description: `${issue.assigned_to?.name ?? "Unassigned"}${tagStr}`,
            detail: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name ?? "",
            issue,
            alwaysShow: true,
          });
        }

        const resultIds = new Set(limitedResults.map(i => i.id));
        const filteredBaseItems = baseItems.filter(item => !item.issue || !resultIds.has(item.issue.id));

        quickPick.items = [
          ...resultItems,
          { label: "", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem,
          ...filteredBaseItems,
        ];
      } catch {
        if (thisSearchVersion === searchVersion && !resolved) {
          quickPick.items = [
            { label: `$(error) Search failed`, disabled: true },
            { label: "", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem,
            ...baseItems,
          ];
        }
      } finally {
        if (thisSearchVersion === searchVersion) {
          quickPick.busy = false;
        }
      }
    });

    quickPick.onDidChangeValue((value) => {
      const query = value.trim();
      if (!query) {
        debouncedSearch.cancel();
        quickPick.items = baseItems;
        return;
      }
      debouncedSearch(query);
    });

    quickPick.onDidAccept(() => {
      const selected = quickPick.activeItems[0];
      if (selected) handleSelection(selected);
    });

    quickPick.onDidChangeSelection((items) => {
      if (items.length > 0) handleSelection(items[0]);
    });

    quickPick.onDidHide(() => {
      debouncedSearch.cancel();
      if (!resolved) {
        resolved = true;
        resolve(undefined);
      }
      quickPick.dispose();
    });

    quickPick.show();

    // Load data in background — picker is already visible
    (async () => {
      try {
        // Phase 1: Fetch issues + project paths in parallel
        const [openResult, closedResult, pathMap] = await Promise.all([
          server.getFilteredIssues({ assignee: "me", status: "open" }),
          server.getFilteredIssues({ assignee: "me", status: "closed" }),
          getProjectPathMap(server),
        ]);
        const myOpenIssues = openResult.issues;
        const myClosedIssues = closedResult.issues;

        if (resolved) return;
        myIssueIds = new Set([...myOpenIssues, ...myClosedIssues].map(i => i.id));
        projectPathMap = pathMap;
        recentIds = new Set(getRecentIssueIds());

        // Hydrate recent issues not in "my issues" (e.g., unassigned issues picked via search)
        const missingRecentIds = getRecentIssueIds().filter((id) => !myIssueIds.has(id));
        if (missingRecentIds.length > 0) {
          const hydrated = await Promise.all(
            missingRecentIds.slice(0, 10).map(async (id) => {
              try {
                const result = await server.getIssueById(id);
                return result.issue;
              } catch {
                return null;
              }
            })
          );
          for (const issue of hydrated) {
            if (issue) {
              const isClosed = issue.status?.is_closed ?? false;
              if (isClosed) myClosedIssues.push(issue);
              else myOpenIssues.push(issue);
              myIssueIds.add(issue.id);
            }
          }
        }

        issues = [...myOpenIssues, ...myClosedIssues];

        // Show issues immediately (all enabled optimistically)
        baseItems = buildIssuePickerItems(
          myOpenIssues, myClosedIssues, [], projectPathMap, allowSkip
        );

        if (!resolved && !quickPick.value) {
          quickPick.items = baseItems;
          quickPick.busy = false;
          quickPick.placeholder = "Type to search, or select from list";
        }

        // Phase 2: Check time tracking in background (cached)
        const projectIds = [...new Set(issues.map(i => i.project?.id).filter(isNonZeroNumber))];
        timeTrackingByProject = await getTimeTrackingStatusCached(server, projectIds);

        if (resolved) return;

        // Rebuild items with correct trackability
        const trackableOpen = myOpenIssues.filter(
          (i) => i.project?.id && timeTrackingByProject.get(i.project.id) !== false
        );
        const trackableClosed = myClosedIssues.filter(
          (i) => i.project?.id && timeTrackingByProject.get(i.project.id) !== false
        );
        const nonTrackable = issues.filter(
          (i) => !i.project?.id || timeTrackingByProject.get(i.project.id) === false
        );
        baseItems = buildIssuePickerItems(
          trackableOpen, trackableClosed, nonTrackable, projectPathMap, allowSkip
        );

        if (!resolved && !quickPick.value) {
          quickPick.items = baseItems;
        }
      } catch (error) {
        if (!resolved) {
          resolved = true;
          quickPick.dispose();
          vscode.window.showErrorMessage(`Failed to fetch issues: ${error}`);
          resolve(undefined);
        }
      }
    })();
  });

  if (selectedIssue === undefined) return undefined;
  if (selectedIssue === "skip") return "skip";

  // Re-fetch to ensure fresh data
  let finalIssue: Issue;
  try {
    const result = await server.getIssueById(selectedIssue.id);
    finalIssue = result.issue;
  } catch {
    finalIssue = selectedIssue;
  }

  // Pick activity for this issue's project
  if (!finalIssue.project?.id) {
    vscode.window.showErrorMessage("Issue has no associated project");
    return undefined;
  }

  // Check if project has time tracking enabled (uses cache)
  const ttStatus = await getTimeTrackingStatusCached(server, [finalIssue.project.id]);
  if (ttStatus.get(finalIssue.project.id) === false) {
    vscode.window.showErrorMessage(
      `Cannot log time: Project "${finalIssue.project.name}" does not have time tracking enabled`
    );
    return undefined;
  }

  let activities: TimeEntryActivity[];
  try {
    activities = await server.getProjectTimeEntryActivities(finalIssue.project.id);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to fetch activities: ${error}`);
    return undefined;
  }

  if (activities.length === 0) {
    vscode.window.showErrorMessage("No activities available for this project");
    return undefined;
  }

  const activity = await showActivityPicker(
    activities,
    title,
    `Activity for #${finalIssue.id}`
  );
  if (!activity) return undefined;

  return {
    issueId: finalIssue.id,
    issueSubject: finalIssue.subject,
    activityId: activity.id,
    activityName: activity.name,
  };
}

/**
 * Pick an issue with inline search (no activity selection)
 * Used for moving time entries to another issue
 */
export interface PickIssueOptions {
  /** Skip time tracking validation - allows selecting any issue */
  skipTimeTrackingCheck?: boolean;
}

export async function pickIssue(
  server: IRedmineServer,
  title: string,
  options: PickIssueOptions = {}
): Promise<Issue | undefined> {
  const { skipTimeTrackingCheck = false } = options;

  // Get assigned issues
  let issues: Issue[];
  try {
    const result = await server.getIssuesAssignedToMe();
    issues = result.issues;
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to fetch issues: ${error}`);
    return undefined;
  }

  // Fetch project path map (cached) + check time_tracking (cached) in parallel
  const projectIds = [...new Set(issues.map(i => i.project?.id).filter(isNonZeroNumber))];

  const [projectPathMap, timeTrackingByProject] = await Promise.all([
    getProjectPathMap(server),
    skipTimeTrackingCheck
      ? Promise.resolve(new Map<number, boolean>())
      : getTimeTrackingStatusCached(server, projectIds),
  ]);

  // Get recent issue IDs for boosting
  const recentIds = new Set(getRecentIssueIds());

  // Sort issues: recent first
  const sortByRecency = (a: Issue, b: Issue): number => {
    const recentIssueIdsList = getRecentIssueIds();
    const aRecent = recentIssueIdsList.indexOf(a.id);
    const bRecent = recentIssueIdsList.indexOf(b.id);
    if (aRecent !== -1 && bRecent !== -1) return aRecent - bRecent;
    if (aRecent !== -1) return -1;
    if (bRecent !== -1) return 1;
    return 0;
  };

  // Build base items with visual grouping
  const baseItems: IssueQuickPickItem[] = [];

  if (skipTimeTrackingCheck) {
    // All issues selectable - sort by recency
    issues.sort(sortByRecency);
    const recentIssues = issues.filter(i => recentIds.has(i.id));
    const otherIssues = issues.filter(i => !recentIds.has(i.id));

    if (recentIssues.length > 0) {
      baseItems.push({ label: "Recent", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
      for (const issue of recentIssues) {
        baseItems.push({
          label: `$(history) #${issue.id} ${issue.subject}`,
          description: issue.assigned_to?.name ?? "Unassigned",
          detail: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name,
          issue,
          disabled: false,
        });
      }
    }
    if (otherIssues.length > 0) {
      baseItems.push({ label: "All Issues", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
      for (const issue of otherIssues) {
        baseItems.push({
          label: `#${issue.id} ${issue.subject}`,
          description: issue.assigned_to?.name ?? "Unassigned",
          detail: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name,
          issue,
          disabled: false,
        });
      }
    }
  } else {
    // Split by time tracking (fail-open: unchecked projects treated as trackable)
    const trackableIssues = issues.filter(
      (issue) => issue.project?.id && timeTrackingByProject.get(issue.project.id) !== false
    );
    const nonTrackableIssues = issues.filter(
      (issue) => !issue.project?.id || timeTrackingByProject.get(issue.project.id) === false
    );

    trackableIssues.sort(sortByRecency);

    const recentTrackable = trackableIssues.filter(i => recentIds.has(i.id));
    const otherTrackable = trackableIssues.filter(i => !recentIds.has(i.id));

    if (recentTrackable.length > 0) {
      baseItems.push({ label: "Recent", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
      for (const issue of recentTrackable) {
        baseItems.push({
          label: `$(history) #${issue.id} ${issue.subject}`,
          description: issue.assigned_to?.name ?? "Unassigned",
          detail: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name,
          issue,
          disabled: false,
        });
      }
    }
    if (otherTrackable.length > 0) {
      baseItems.push({ label: "Assigned", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
      for (const issue of otherTrackable) {
        baseItems.push({
          label: `#${issue.id} ${issue.subject}`,
          description: issue.assigned_to?.name ?? "Unassigned",
          detail: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name,
          issue,
          disabled: false,
        });
      }
    }
    if (nonTrackableIssues.length > 0) {
      baseItems.push({ label: "No Time Tracking", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
      for (const issue of nonTrackableIssues) {
        baseItems.push({
          label: `$(circle-slash) #${issue.id} ${issue.subject}`,
          description: issue.assigned_to?.name ?? "Unassigned",
          detail: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name ?? "Unknown",
          issue,
          disabled: true,
        });
      }
    }
  }

  // Use createQuickPick for inline search
  return new Promise<Issue | undefined>((resolve) => {
    const quickPick = vscode.window.createQuickPick<IssueQuickPickItem>();
    quickPick.title = title;
    quickPick.placeholder = "Type to search, or select from list";
    if (hasSortByLabel(quickPick)) {
      quickPick.sortByLabel = false; // Preserve our custom sort order
    }
    quickPick.items = baseItems;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    let resolved = false;
    let searchVersion = 0;

    const handleSelection = (selected: IssueQuickPickItem): boolean => {
      if (resolved) return false;
      if (selected.disabled) return false;
      if (selected.issue) {
        resolved = true;
        // Record selection for recent issues
        recordRecentIssue(
          selected.issue.id,
          selected.issue.subject,
          selected.issue.project?.name ?? ""
        );
        quickPick.dispose();
        resolve(selected.issue);
        return true;
      }
      return false;
    };

    const debouncedSearch = debounce(SEARCH_DEBOUNCE_MS, async (query: string) => {
      if (query.length < 2) return;

      const thisSearchVersion = ++searchVersion;
      quickPick.busy = true;

      try {
        // Use shared search helper
        const { results: allResults } = await searchIssuesWithFuzzy(
          server,
          query,
          issues,
          projectPathMap,
          recentIds
        );

        if (thisSearchVersion !== searchVersion || resolved) return;

        // Check time tracking for any new projects in search results (unless skipped)
        if (!skipTimeTrackingCheck) {
          const newProjectIds = [...new Set(
            allResults
              .map(i => i.project?.id)
              .filter((id): id is number => id !== undefined && !timeTrackingByProject.has(id))
          )];
          await Promise.all(
            newProjectIds.map(async (projectId) => {
              const enabled = await server.isTimeTrackingEnabled(projectId);
              timeTrackingByProject.set(projectId, enabled);
            })
          );
        }

        if (thisSearchVersion !== searchVersion || resolved) return;

        // Build result items
        const assignedIds = new Set(issues.map(i => i.id));
        const limitedResults = allResults.slice(0, 15);

        const resultItems: IssueQuickPickItem[] = limitedResults.length === 0
          ? [{ label: `$(info) No results for "${query}"`, disabled: true, alwaysShow: true }]
          : limitedResults.map((issue) => {
              const isAssigned = assignedIds.has(issue.id);
              const projectId = issue.project?.id;
              const hasTimeTracking = skipTimeTrackingCheck || (projectId ? timeTrackingByProject.get(projectId) : false);
              const projectPath = projectPathMap.get(projectId ?? 0) ?? issue.project?.name ?? "";
              if (!hasTimeTracking) {
                return {
                  label: `$(circle-slash) #${issue.id} ${issue.subject}`,
                  description: `${issue.assigned_to?.name ?? "Unassigned"} (no time tracking)`,
                  detail: projectPath,
                  issue,
                  disabled: true,
                  alwaysShow: true,
                };
              }
              const icon = isAssigned ? "$(account)" : "$(search)";
              return {
                label: `${icon} #${issue.id} ${issue.subject}`,
                description: `${issue.assigned_to?.name ?? "Unassigned"}${isAssigned ? " (assigned)" : ""}`,
                detail: projectPath,
                issue,
                alwaysShow: true,  // Bypass VSCode's built-in filter
              };
            });

        // Filter baseItems to exclude issues already in search results
        const resultIds = new Set(limitedResults.map(i => i.id));
        const filteredBaseItems = baseItems.filter(item => !item.issue || !resultIds.has(item.issue.id));

        quickPick.items = [
          ...resultItems,
          { label: "", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem,
          ...filteredBaseItems,
        ];
      } catch {
        if (thisSearchVersion === searchVersion && !resolved) {
          quickPick.items = [
            { label: `$(error) Search failed`, disabled: true },
            { label: "", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem,
            ...baseItems,
          ];
        }
      } finally {
        if (thisSearchVersion === searchVersion) {
          quickPick.busy = false;
        }
      }
    });

    quickPick.onDidChangeValue((value) => {
      const query = value.trim();
      if (!query) {
        debouncedSearch.cancel();
        quickPick.items = baseItems;
        return;
      }
      debouncedSearch(query);
    });

    quickPick.onDidAccept(() => {
      const selected = quickPick.activeItems[0];
      if (selected) handleSelection(selected);
    });

    quickPick.onDidChangeSelection((items) => {
      if (items.length > 0) handleSelection(items[0]);
    });

    quickPick.onDidHide(() => {
      debouncedSearch.cancel();
      if (!resolved) {
        resolved = true;
        resolve(undefined);
      }
      quickPick.dispose();
    });

    quickPick.show();
  });
}

/**
 * Pick activity for a known project (skip issue selection)
 * Used when issue is already known (e.g., personal tasks)
 */
export async function pickActivityForProject(
  server: IRedmineServer,
  projectId: number,
  title: string,
  issueHint?: string
): Promise<{ activityId: number; activityName: string } | undefined> {
  // Check if project has time tracking enabled
  const hasTimeTracking = await server.isTimeTrackingEnabled(projectId);
  if (!hasTimeTracking) {
    vscode.window.showErrorMessage("Project does not have time tracking enabled");
    return undefined;
  }

  let activities: TimeEntryActivity[];
  try {
    activities = await server.getProjectTimeEntryActivities(projectId);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to fetch activities: ${error}`);
    return undefined;
  }

  if (activities.length === 0) {
    vscode.window.showErrorMessage("No activities available for this project");
    return undefined;
  }

  const activity = await showActivityPicker(
    activities,
    title,
    issueHint ? `Activity for ${issueHint}` : "Select activity"
  );
  if (!activity) return undefined;

  return {
    activityId: activity.id,
    activityName: activity.name,
  };
}

// Test-only surface for internal logic with high branch complexity.
export const __testIssuePicker = {
  hasSortByLabel,
  parseSearchOperators,
  fuzzyFilterIssues,
  searchIssuesWithFuzzy,
  showActivityPicker,
  getTimeTrackingStatusCached,
  buildIssuePickerItems,
};
