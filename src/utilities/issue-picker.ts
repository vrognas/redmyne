import * as vscode from "vscode";
import type { IRedmineServer } from "../redmine/redmine-server-interface";
import { Issue } from "../redmine/models/issue";
import { TimeEntryActivity } from "../redmine/models/common";
import { debounce } from "./debounce";
import { recordRecentIssue, getRecentIssueIds } from "./recent-issues";
import { fetchMyOpenAndClosedIssues } from "./get-my-issues";
import { formatIssueLabel } from "./issue-label";
import { searchIssuesWithFuzzy, buildProjectPathMap } from "./issue-search";

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

// My issues cache (module-level, pre-warmable)
interface MyIssuesCache {
  openIssues: Issue[];
  closedIssues: Issue[];
  timestamp: number;
  serverAddress: string;
}
let myIssuesCache: MyIssuesCache | null = null;
let myIssuesFetchPromise: Promise<void> | null = null;

/**
 * Pre-warm the issues cache for the quick picker.
 * Call on extension activate / server change so picker opens instantly.
 */
export function prewarmIssuePicker(server: IRedmineServer): void {
  const serverAddress = server.options.address;
  const isCacheValid =
    myIssuesCache &&
    myIssuesCache.serverAddress === serverAddress &&
    Date.now() - myIssuesCache.timestamp < PROJECT_CACHE_TTL_MS;
  if (isCacheValid || myIssuesFetchPromise) return;

  myIssuesFetchPromise = (async () => {
    try {
      const { open, closed } = await fetchMyOpenAndClosedIssues(server);
      myIssuesCache = {
        openIssues: open,
        closedIssues: closed,
        timestamp: Date.now(),
        serverAddress,
      };
    } catch {
      // Fail silently — picker will fetch on demand
    } finally {
      myIssuesFetchPromise = null;
    }
  })();
}

/**
 * Get cached issues or fetch them. Returns instantly if cache is warm.
 */
async function getMyIssues(server: IRedmineServer): Promise<{ openIssues: Issue[]; closedIssues: Issue[] }> {
  const serverAddress = server.options.address;
  const isCacheValid =
    myIssuesCache &&
    myIssuesCache.serverAddress === serverAddress &&
    Date.now() - myIssuesCache.timestamp < PROJECT_CACHE_TTL_MS;

  // Return shallow copies so callers (e.g. recent-issue hydration) can mutate
  // their lists without polluting the shared module cache.
  if (isCacheValid) {
    return { openIssues: [...myIssuesCache!.openIssues], closedIssues: [...myIssuesCache!.closedIssues] };
  }

  // If a fetch is in flight, wait for it
  if (myIssuesFetchPromise) {
    await myIssuesFetchPromise;
    if (myIssuesCache && myIssuesCache.serverAddress === serverAddress) {
      return { openIssues: [...myIssuesCache.openIssues], closedIssues: [...myIssuesCache.closedIssues] };
    }
  }

  // Fetch fresh
  const { open, closed } = await fetchMyOpenAndClosedIssues(server);
  myIssuesCache = {
    openIssues: open,
    closedIssues: closed,
    timestamp: Date.now(),
    serverAddress,
  };
  return { openIssues: [...myIssuesCache.openIssues], closedIssues: [...myIssuesCache.closedIssues] };
}

/**
 * Invalidate the issues cache (e.g., after logging time).
 */
export function invalidateIssuePickerCache(): void {
  myIssuesCache = null;
}

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
 * Build a single QuickPick item for an issue. Centralizes the shared shape
 * (label `[icon ]#id subject`, description `assignee[tag]`, project-path detail)
 * so the ~dozen call sites stay consistent.
 *
 * @param opts.icon      Codicon prefix (e.g. "$(history)"); omitted → no prefix
 * @param opts.tag       Trailing description tag (e.g. " · closed"); appended raw
 * @param opts.detail    Pre-resolved detail string; overrides projectPathMap lookup
 * @param opts.fallback  Detail fallback when project path + name are unavailable
 * @param opts.disabled  Mark item as non-selectable
 * @param opts.alwaysShow Bypass VSCode's built-in filtering
 */
function issueToQuickPickItem(
  issue: Issue,
  projectPathMap: Map<number, string>,
  opts: {
    icon?: string;
    tag?: string;
    detail?: string;
    fallback?: string;
    disabled?: boolean;
    alwaysShow?: boolean;
  } = {}
): IssueQuickPickItem {
  const detail =
    opts.detail ??
    projectPathMap.get(issue.project?.id ?? 0) ??
    issue.project?.name ??
    opts.fallback;
  const item: IssueQuickPickItem = {
    label: formatIssueLabel({ id: issue.id, subject: issue.subject }, { icon: opts.icon }),
    description: `${issue.assigned_to?.name ?? "Unassigned"}${opts.tag ?? ""}`,
    detail,
    issue,
  };
  if (opts.disabled !== undefined) item.disabled = opts.disabled;
  if (opts.alwaysShow !== undefined) item.alwaysShow = opts.alwaysShow;
  return item;
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
      const icon = isClosed ? "archive" : "history";
      const statusTag = isClosed ? ` · ${issue.status?.name ?? "closed"}` : "";
      items.push(
        issueToQuickPickItem(issue, projectPathMap, {
          icon,
          tag: statusTag,
          disabled: false,
        })
      );
    }
  }

  if (otherOpen.length > 0) {
    items.push({ label: "My Open", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
    for (const issue of otherOpen) {
      items.push(issueToQuickPickItem(issue, projectPathMap, { disabled: false }));
    }
  }

  if (otherClosed.length > 0) {
    items.push({ label: "My Closed", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
    for (const issue of otherClosed.slice(0, 20)) {
      items.push(
        issueToQuickPickItem(issue, projectPathMap, {
          icon: "archive",
          tag: ` · ${issue.status?.name ?? "closed"}`,
          disabled: false,
        })
      );
    }
  }

  if (nonTrackable.length > 0) {
    items.push({ label: "No Time Tracking", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
    for (const issue of nonTrackable) {
      items.push(
        issueToQuickPickItem(issue, projectPathMap, {
          icon: "circle-slash",
          fallback: "Unknown",
          disabled: true,
        })
      );
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
      // Bump version even on a too-short query so any in-flight search is superseded.
      const thisSearchVersion = ++searchVersion;
      if (query.length < 2) return;

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
          const icon = isClosed ? "archive" : isMine ? "account" : "search";
          const tagStr = isClosed ? " (closed)" : "";
          resultItems.push(
            issueToQuickPickItem(issue, projectPathMap, {
              icon,
              tag: tagStr,
              fallback: "",
              alwaysShow: true,
            })
          );
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
        // Bump version so a slow in-flight search can't overwrite the restored base list.
        ++searchVersion;
        debouncedSearch.cancel();
        quickPick.items = baseItems;
        quickPick.busy = false;
        return;
      }
      void debouncedSearch(query);
    });

    quickPick.onDidAccept(() => {
      const selected = quickPick.activeItems[0];
      if (selected) handleSelection(selected);
    });

    quickPick.onDidChangeSelection((items) => {
      if (items.length > 0) handleSelection(items[0]!);
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
    void (async () => {
      try {
        // Phase 1: Fetch issues (from cache if warm) + project paths in parallel
        const [{ openIssues: myOpenIssues, closedIssues: myClosedIssues }, pathMap] = await Promise.all([
          getMyIssues(server),
          getProjectPathMap(server),
        ]);

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
        baseItems.push(
          issueToQuickPickItem(issue, projectPathMap, { icon: "history", disabled: false })
        );
      }
    }
    if (otherIssues.length > 0) {
      baseItems.push({ label: "All Issues", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
      for (const issue of otherIssues) {
        baseItems.push(issueToQuickPickItem(issue, projectPathMap, { disabled: false }));
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
        baseItems.push(
          issueToQuickPickItem(issue, projectPathMap, { icon: "history", disabled: false })
        );
      }
    }
    if (otherTrackable.length > 0) {
      baseItems.push({ label: "Assigned", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
      for (const issue of otherTrackable) {
        baseItems.push(issueToQuickPickItem(issue, projectPathMap, { disabled: false }));
      }
    }
    if (nonTrackableIssues.length > 0) {
      baseItems.push({ label: "No Time Tracking", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem);
      for (const issue of nonTrackableIssues) {
        baseItems.push(
          issueToQuickPickItem(issue, projectPathMap, {
            icon: "circle-slash",
            fallback: "Unknown",
            disabled: true,
          })
        );
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
      // Bump version even on a too-short query so any in-flight search is superseded.
      const thisSearchVersion = ++searchVersion;
      if (query.length < 2) return;

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

        // Check time tracking for any new projects in search results (unless skipped).
        // Route through getTimeTrackingStatusCached so a single flaky project fails
        // open (its own per-project catch) instead of rejecting the whole search —
        // matching pickIssueWithSearch and the base-section build.
        if (!skipTimeTrackingCheck) {
          const newProjectIds = [...new Set(
            allResults
              .map(i => i.project?.id)
              .filter((id): id is number => id !== undefined && !timeTrackingByProject.has(id))
          )];
          if (newProjectIds.length > 0) {
            const statuses = await getTimeTrackingStatusCached(server, newProjectIds);
            for (const projectId of newProjectIds) {
              timeTrackingByProject.set(projectId, statuses.get(projectId) ?? true);
            }
          }
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
                return issueToQuickPickItem(issue, projectPathMap, {
                  icon: "circle-slash",
                  tag: " (no time tracking)",
                  detail: projectPath,
                  disabled: true,
                  alwaysShow: true,
                });
              }
              return issueToQuickPickItem(issue, projectPathMap, {
                icon: isAssigned ? "account" : "search",
                tag: isAssigned ? " (assigned)" : "",
                detail: projectPath,
                alwaysShow: true,  // Bypass VSCode's built-in filter
              });
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
        // Bump version so a slow in-flight search can't overwrite the restored base list.
        ++searchVersion;
        debouncedSearch.cancel();
        quickPick.items = baseItems;
        quickPick.busy = false;
        return;
      }
      void debouncedSearch(query);
    });

    quickPick.onDidAccept(() => {
      const selected = quickPick.activeItems[0];
      if (selected) handleSelection(selected);
    });

    quickPick.onDidChangeSelection((items) => {
      if (items.length > 0) handleSelection(items[0]!);
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
  showActivityPicker,
  getTimeTrackingStatusCached,
  buildIssuePickerItems,
  issueToQuickPickItem,
};
