import * as vscode from "vscode";
import Fuse, { IFuseOptions } from "fuse.js";
import { RedmineServer } from "../redmine/redmine-server";
import { Issue } from "../redmine/models/issue";
import { TimeEntryActivity } from "../redmine/models/common";
import { RedmineProject } from "../redmine/redmine-project";
import { debounce } from "./debounce";
import { recordRecentIssue, getRecentIssueIds } from "./recent-issues";

const SEARCH_DEBOUNCE_MS = 150;
const PROJECT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Project path cache (module-level, shared across picker invocations)
interface ProjectPathCache {
  map: Map<number, string>;
  timestamp: number;
  serverAddress: string;
}
let projectPathCache: ProjectPathCache | null = null;

/**
 * Get or build project path map with caching
 */
async function getProjectPathMap(server: RedmineServer): Promise<Map<number, string>> {
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

/**
 * Search issues across multiple sources with fuzzy matching
 * - Searches server by each query token (for multi-word queries)
 * - Searches projects by name and fetches their issues
 * - Applies fuzzy matching to rank all candidates
 */
async function searchIssuesWithFuzzy(
  server: RedmineServer,
  query: string,
  localIssues: Issue[],
  projectPathMap: Map<number, string>,
  recentIds?: Set<number>
): Promise<IssueSearchResult> {
  const cleanQuery = query.replace(/^#/, "");
  const possibleId = parseInt(cleanQuery, 10);
  const isNumericQuery = !isNaN(possibleId) && cleanQuery === String(possibleId);
  const queryTokens = query.trim().split(/\s+/).filter(t => t.length >= 2);

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

  // Parallel fetch: exact ID + token searches + project issues
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
    // Search each token separately for multi-word queries
    ...(queryTokens.length > 1
      ? queryTokens.map(async (token) => {
          const results = await server.searchIssues(token, 10);
          serverResults.push(...results);
        })
      : [(async () => {
          const results = await server.searchIssues(query, 10);
          serverResults.push(...results);
        })()]),
    // Fetch issues from projects matching search tokens (include closed issues)
    ...matchingProjectIds.slice(0, 5).map(async (projectId) => {
      try {
        const result = await server.getOpenIssuesForProject(projectId, true, 10, false);
        serverResults.push(...result.issues);
      } catch { /* ignore - project may not be accessible */ }
    }),
  ]);

  // Collect all unique candidates
  const seenIds = new Set<number>();
  const candidateIssues: Issue[] = [];

  if (exactMatch) {
    candidateIssues.push(exactMatch);
    seenIds.add(exactMatch.id);
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
function buildProjectPathMap(projects: RedmineProject[]): Map<number, string> {
  const projectMap = new Map<number, RedmineProject>();
  for (const p of projects) {
    projectMap.set(p.id, p);
  }

  const pathCache = new Map<number, string>();

  function getPath(projectId: number): string {
    if (pathCache.has(projectId)) return pathCache.get(projectId)!;

    const project = projectMap.get(projectId);
    if (!project) return "";

    let path = project.name;
    if (project.parent?.id) {
      const parentPath = getPath(project.parent.id);
      if (parentPath) path = `${parentPath} ${project.name}`;
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
  server: RedmineServer,
  title: string,
  options?: {
    allowSkip?: boolean; // Show "Skip" option (default: false)
  }
): Promise<PickedIssueAndActivity | "skip" | undefined> {
  const allowSkip = options?.allowSkip ?? false;

  // Get assigned issues
  let issues: Issue[];
  try {
    const result = await server.getIssuesAssignedToMe();
    issues = result.issues;
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to fetch issues: ${error}`);
    return undefined;
  }

  // Fetch project path map (cached) + check time_tracking in parallel
  const projectIds = [...new Set(issues.map(i => i.project?.id).filter(Boolean))] as number[];
  const timeTrackingByProject = new Map<number, boolean>();

  const [projectPathMap] = await Promise.all([
    getProjectPathMap(server),
    // Check time_tracking for all projects
    ...projectIds.map(async (projectId) => {
      const enabled = await server.isTimeTrackingEnabled(projectId);
      timeTrackingByProject.set(projectId, enabled);
    }),
  ]);

  // Get recent issue IDs for boosting
  const recentIds = new Set(getRecentIssueIds());

  // Build issue list: trackable issues first, then non-trackable (disabled)
  const trackableIssues = issues.filter(
    (issue) => issue.project?.id && timeTrackingByProject.get(issue.project.id)
  );
  const nonTrackableIssues = issues.filter(
    (issue) => !issue.project?.id || !timeTrackingByProject.get(issue.project.id)
  );

  // Sort trackable issues: recent first
  const sortByRecency = (a: Issue, b: Issue): number => {
    const recentIssueIdsList = getRecentIssueIds();
    const aRecent = recentIssueIdsList.indexOf(a.id);
    const bRecent = recentIssueIdsList.indexOf(b.id);
    // Both recent: sort by recency
    if (aRecent !== -1 && bRecent !== -1) return aRecent - bRecent;
    // Only one recent
    if (aRecent !== -1) return -1;
    if (bRecent !== -1) return 1;
    return 0;
  };

  trackableIssues.sort(sortByRecency);

  // Build base items from assigned issues with visual grouping
  const recentTrackable = trackableIssues.filter(i => recentIds.has(i.id));
  const otherTrackable = trackableIssues.filter(i => !recentIds.has(i.id));

  const baseItems: IssueQuickPickItem[] = [];

  // Recent issues section
  if (recentTrackable.length > 0) {
    baseItems.push({ label: "Recent", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
    for (const issue of recentTrackable) {
      baseItems.push({
        label: `$(history) #${issue.id} ${issue.subject}`,
        description: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name,
        issue,
        disabled: false,
      });
    }
  }

  // Other assigned issues
  if (otherTrackable.length > 0) {
    baseItems.push({ label: "Assigned", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
    for (const issue of otherTrackable) {
      baseItems.push({
        label: `#${issue.id} ${issue.subject}`,
        description: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name,
        issue,
        disabled: false,
      });
    }
  }

  // Non-trackable issues (disabled, greyed out)
  if (nonTrackableIssues.length > 0) {
    baseItems.push({ label: "No Time Tracking", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
    for (const issue of nonTrackableIssues) {
      baseItems.push({
        label: `$(circle-slash) #${issue.id} ${issue.subject}`,
        description: `${projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name ?? "Unknown"}`,
        issue,
        disabled: true,
      });
    }
  }

  // Add skip option if allowed
  if (allowSkip) {
    baseItems.push({
      label: "$(dash) Skip (assign later)",
      action: "skip",
    });
  }

  // Use createQuickPick for inline search
  const selectedIssue = await new Promise<Issue | "skip" | undefined>((resolve) => {
    const quickPick = vscode.window.createQuickPick<IssueQuickPickItem>();
    quickPick.title = title;
    quickPick.placeholder = "Type to search, or select from list";
    quickPick.sortByLabel = false;  // Preserve our custom sort order
    quickPick.items = baseItems;
    quickPick.matchOnDescription = true;

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
        const cleanQuery = query.replace(/^#/, "");
        const possibleId = parseInt(cleanQuery, 10);
        const isNumericQuery = !isNaN(possibleId) && cleanQuery === String(possibleId);

        // Use shared search helper
        const { results: allResults, exactMatchError } = await searchIssuesWithFuzzy(
          server,
          query,
          issues,
          projectPathMap,
          recentIds
        );

        // Check time tracking for new projects
        const newProjectIds = [...new Set(
          allResults
            .map(i => i.project?.id)
            .filter((id): id is number => id !== null && id !== undefined && !timeTrackingByProject.has(id))
        )];

        if (newProjectIds.length > 0) {
          await Promise.all(
            newProjectIds.map(async (projectId) => {
              try {
                const enabled = await server.isTimeTrackingEnabled(projectId);
                timeTrackingByProject.set(projectId, enabled);
              } catch {
                timeTrackingByProject.set(projectId, false);
              }
            })
          );
        }

        // 5. Filter to trackable issues
        const assignedIds = new Set(issues.map(i => i.id));
        const trackableResults = allResults.filter((issue) => {
          const projectId = issue.project?.id;
          return projectId !== null && projectId !== undefined && timeTrackingByProject.get(projectId) === true;
        });

        // Note: Results are already sorted by fuzzy relevance - don't override

        // 6. Check if results are still relevant
        if (thisSearchVersion !== searchVersion || resolved) return;

        // 7. Build result items
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
          const isAssigned = assignedIds.has(issue.id);
          const icon = isAssigned ? "$(account)" : "$(search)";
          const assignedTag = isAssigned ? " (assigned)" : "";
          // Use full project path for description (enables fuzzy match on parent projects)
          const projectPath = projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name ?? "";
          resultItems.push({
            label: `${icon} #${issue.id} ${issue.subject}`,
            description: `${projectPath}${assignedTag}`,
            detail: issue.status?.name,
            issue,
            alwaysShow: true,  // Bypass VSCode's built-in filter
          });
        }

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

  // Check if project has time tracking enabled
  const hasTimeTracking = await server.isTimeTrackingEnabled(finalIssue.project.id);
  if (!hasTimeTracking) {
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
  server: RedmineServer,
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

  // Fetch project path map (cached) + check time_tracking in parallel
  const timeTrackingByProject = new Map<number, boolean>();
  const projectIds = [...new Set(issues.map(i => i.project?.id).filter(Boolean))] as number[];

  const [projectPathMap] = await Promise.all([
    getProjectPathMap(server),
    // Check time_tracking for all projects (unless skipped)
    ...(skipTimeTrackingCheck ? [] : projectIds.map(async (projectId) => {
      const enabled = await server.isTimeTrackingEnabled(projectId);
      timeTrackingByProject.set(projectId, enabled);
    })),
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
          description: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name,
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
          description: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name,
          issue,
          disabled: false,
        });
      }
    }
  } else {
    // Split by time tracking
    const trackableIssues = issues.filter(
      (issue) => issue.project?.id && timeTrackingByProject.get(issue.project.id)
    );
    const nonTrackableIssues = issues.filter(
      (issue) => !issue.project?.id || !timeTrackingByProject.get(issue.project.id)
    );

    trackableIssues.sort(sortByRecency);

    const recentTrackable = trackableIssues.filter(i => recentIds.has(i.id));
    const otherTrackable = trackableIssues.filter(i => !recentIds.has(i.id));

    if (recentTrackable.length > 0) {
      baseItems.push({ label: "Recent", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
      for (const issue of recentTrackable) {
        baseItems.push({
          label: `$(history) #${issue.id} ${issue.subject}`,
          description: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name,
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
          description: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name,
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
          description: `${projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name ?? "Unknown"}`,
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
    quickPick.sortByLabel = false;  // Preserve our custom sort order
    quickPick.items = baseItems;
    quickPick.matchOnDescription = true;

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
              // Use full project path for description (enables fuzzy match on parent projects)
              const projectPath = projectPathMap.get(projectId ?? 0) ?? issue.project?.name ?? "";
              if (!hasTimeTracking) {
                return {
                  label: `$(circle-slash) #${issue.id} ${issue.subject}`,
                  description: `${projectPath} (no time tracking)`,
                  detail: issue.status?.name,
                  issue,
                  disabled: true,
                  alwaysShow: true,
                };
              }
              const icon = isAssigned ? "$(account)" : "$(search)";
              return {
                label: `${icon} #${issue.id} ${issue.subject}`,
                description: `${projectPath}${isAssigned ? " (assigned)" : ""}`,
                detail: issue.status?.name,
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
  server: RedmineServer,
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
