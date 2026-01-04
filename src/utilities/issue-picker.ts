import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { Issue } from "../redmine/models/issue";
import { TimeEntryActivity } from "../redmine/models/common";
import { debounce } from "./debounce";

const SEARCH_DEBOUNCE_MS = 300;

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

  // Filter out issues from projects without time_tracking enabled
  const projectIds = [...new Set(issues.map(i => i.project?.id).filter(Boolean))] as number[];
  const timeTrackingByProject = new Map<number, boolean>();

  // Check time_tracking for all projects in parallel
  await Promise.all(
    projectIds.map(async (projectId) => {
      const enabled = await server.isTimeTrackingEnabled(projectId);
      timeTrackingByProject.set(projectId, enabled);
    })
  );

  // Build issue list: trackable issues first, then non-trackable (disabled)
  const trackableIssues = issues.filter(
    (issue) => issue.project?.id && timeTrackingByProject.get(issue.project.id)
  );
  const nonTrackableIssues = issues.filter(
    (issue) => !issue.project?.id || !timeTrackingByProject.get(issue.project.id)
  );

  // Build base items from assigned issues
  const baseItems: IssueQuickPickItem[] = [
    // Trackable issues (selectable)
    ...trackableIssues.map((issue) => ({
      label: `#${issue.id} ${issue.subject}`,
      description: issue.project?.name,
      issue,
      disabled: false,
    })),
    // Non-trackable issues (disabled, greyed out)
    ...nonTrackableIssues.map((issue) => ({
      label: `$(circle-slash) #${issue.id} ${issue.subject}`,
      description: `${issue.project?.name ?? "Unknown"} (no time tracking)`,
      issue,
      disabled: true,
    })),
  ];

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
        const lowerQuery = query.toLowerCase();
        const cleanQuery = query.replace(/^#/, "");
        const possibleId = parseInt(cleanQuery, 10);
        const isNumericQuery = !isNaN(possibleId) && cleanQuery === String(possibleId);

        // 1. Search local assigned issues
        const localMatches = issues.filter((issue) =>
          String(issue.id).includes(cleanQuery) ||
          issue.subject.toLowerCase().includes(lowerQuery) ||
          issue.project?.name?.toLowerCase().includes(lowerQuery)
        );

        // 2. Parallel: exact ID fetch + server text search
        type SearchResult = {
          exactMatch: Issue | null;
          exactMatchError: string | null;
          serverResults: Issue[];
        };

        const searchResult: SearchResult = { exactMatch: null, exactMatchError: null, serverResults: [] };

        await Promise.all([
          (async () => {
            if (isNumericQuery) {
              try {
                const result = await server.getIssueById(possibleId);
                searchResult.exactMatch = result.issue;
              } catch (error: unknown) {
                if (error instanceof Error) {
                  searchResult.exactMatchError = error.message.includes("403") ? "no access" :
                                   error.message.includes("404") ? "not found" : null;
                }
              }
            }
          })(),
          (async () => {
            searchResult.serverResults = await server.searchIssues(query, 10);
          })(),
        ]);

        const { exactMatch, exactMatchError, serverResults } = searchResult;

        // 3. Merge results
        const seenIds = new Set<number>();
        const allResults: Issue[] = [];

        if (exactMatch) {
          allResults.push(exactMatch);
          seenIds.add(exactMatch.id);
        }
        for (const issue of localMatches) {
          if (!seenIds.has(issue.id)) {
            allResults.push(issue);
            seenIds.add(issue.id);
          }
        }
        for (const issue of serverResults) {
          if (!seenIds.has(issue.id)) {
            allResults.push(issue);
            seenIds.add(issue.id);
          }
        }

        // 4. Check time tracking for new projects
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

        // Sort: assigned issues first
        trackableResults.sort((a, b) => {
          const aAssigned = assignedIds.has(a.id);
          const bAssigned = assignedIds.has(b.id);
          if (aAssigned && !bAssigned) return -1;
          if (!aAssigned && bAssigned) return 1;
          return b.id - a.id;
        });

        // 6. Check if results are still relevant
        if (thisSearchVersion !== searchVersion || resolved) return;

        // 7. Build result items
        const limitedResults = trackableResults.slice(0, 15);
        const resultItems: IssueQuickPickItem[] = [];

        if (isNumericQuery && exactMatchError && limitedResults.length === 0) {
          resultItems.push({
            label: `$(error) #${possibleId} ${exactMatchError}`,
            disabled: true,
          });
        }

        if (limitedResults.length === 0 && resultItems.length === 0) {
          resultItems.push({
            label: `$(info) No results for "${query}"`,
            disabled: true,
          });
        }

        for (const issue of limitedResults) {
          const isAssigned = assignedIds.has(issue.id);
          const icon = isAssigned ? "$(account)" : "$(search)";
          const assignedTag = isAssigned ? " (assigned)" : "";
          resultItems.push({
            label: `${icon} #${issue.id} ${issue.subject}`,
            description: `${issue.project?.name ?? ""}${assignedTag}`,
            detail: issue.status?.name,
            issue,
          });
        }

        quickPick.items = [
          ...resultItems,
          { label: "", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem,
          ...baseItems,
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

  // Check time_tracking for all projects (unless skipped)
  const timeTrackingByProject = new Map<number, boolean>();

  if (!skipTimeTrackingCheck) {
    const projectIds = [...new Set(issues.map(i => i.project?.id).filter(Boolean))] as number[];
    await Promise.all(
      projectIds.map(async (projectId) => {
        const enabled = await server.isTimeTrackingEnabled(projectId);
        timeTrackingByProject.set(projectId, enabled);
      })
    );
  }

  // Build base items
  let baseItems: IssueQuickPickItem[];

  if (skipTimeTrackingCheck) {
    // All issues selectable
    baseItems = issues.map((issue) => ({
      label: `#${issue.id} ${issue.subject}`,
      description: issue.project?.name,
      issue,
      disabled: false,
    }));
  } else {
    // Split by time tracking: trackable first, then non-trackable (disabled)
    const trackableIssues = issues.filter(
      (issue) => issue.project?.id && timeTrackingByProject.get(issue.project.id)
    );
    const nonTrackableIssues = issues.filter(
      (issue) => !issue.project?.id || !timeTrackingByProject.get(issue.project.id)
    );

    baseItems = [
      ...trackableIssues.map((issue) => ({
        label: `#${issue.id} ${issue.subject}`,
        description: issue.project?.name,
        issue,
        disabled: false,
      })),
      ...nonTrackableIssues.map((issue) => ({
        label: `$(circle-slash) #${issue.id} ${issue.subject}`,
        description: `${issue.project?.name ?? "Unknown"} (no time tracking)`,
        issue,
        disabled: true,
      })),
    ];
  }

  // Use createQuickPick for inline search
  return new Promise<Issue | undefined>((resolve) => {
    const quickPick = vscode.window.createQuickPick<IssueQuickPickItem>();
    quickPick.title = title;
    quickPick.placeholder = "Type to search, or select from list";
    quickPick.items = baseItems;
    quickPick.matchOnDescription = true;

    let resolved = false;
    let searchVersion = 0;

    const handleSelection = (selected: IssueQuickPickItem): boolean => {
      if (resolved) return false;
      if (selected.disabled) return false;
      if (selected.issue) {
        resolved = true;
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
        const lowerQuery = query.toLowerCase();
        const cleanQuery = query.replace(/^#/, "");
        const possibleId = parseInt(cleanQuery, 10);
        const isNumericQuery = !isNaN(possibleId) && cleanQuery === String(possibleId);

        // Search local + server in parallel
        const localMatches = issues.filter((issue) =>
          String(issue.id).includes(cleanQuery) ||
          issue.subject.toLowerCase().includes(lowerQuery) ||
          issue.project?.name?.toLowerCase().includes(lowerQuery)
        );

        type SearchResult = { exactMatch: Issue | null; serverResults: Issue[] };
        const searchResult: SearchResult = { exactMatch: null, serverResults: [] };

        await Promise.all([
          (async () => {
            if (isNumericQuery) {
              try {
                const result = await server.getIssueById(possibleId);
                searchResult.exactMatch = result.issue;
              } catch { /* ignore */ }
            }
          })(),
          (async () => {
            searchResult.serverResults = await server.searchIssues(query, 10);
          })(),
        ]);

        // Merge results
        const seenIds = new Set<number>();
        const allResults: Issue[] = [];

        if (searchResult.exactMatch) {
          allResults.push(searchResult.exactMatch);
          seenIds.add(searchResult.exactMatch.id);
        }
        for (const issue of localMatches) {
          if (!seenIds.has(issue.id)) {
            allResults.push(issue);
            seenIds.add(issue.id);
          }
        }
        for (const issue of searchResult.serverResults) {
          if (!seenIds.has(issue.id)) {
            allResults.push(issue);
            seenIds.add(issue.id);
          }
        }

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
          ? [{ label: `$(info) No results for "${query}"`, disabled: true }]
          : limitedResults.map((issue) => {
              const isAssigned = assignedIds.has(issue.id);
              const projectId = issue.project?.id;
              const hasTimeTracking = skipTimeTrackingCheck || (projectId ? timeTrackingByProject.get(projectId) : false);
              if (!hasTimeTracking) {
                return {
                  label: `$(circle-slash) #${issue.id} ${issue.subject}`,
                  description: `${issue.project?.name ?? "Unknown"} (no time tracking)`,
                  detail: issue.status?.name,
                  issue,
                  disabled: true,
                };
              }
              const icon = isAssigned ? "$(account)" : "$(search)";
              return {
                label: `${icon} #${issue.id} ${issue.subject}`,
                description: `${issue.project?.name ?? ""}${isAssigned ? " (assigned)" : ""}`,
                detail: issue.status?.name,
                issue,
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
