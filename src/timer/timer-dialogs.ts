import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { Issue } from "../redmine/models/issue";
import { TimeEntryActivity } from "../redmine/models/time-entry-activity";
import { WorkUnit } from "./timer-state";
import { formatHoursAsHHMM, formatMinutesAsHHMM } from "../utilities/time-input";

interface IssueQuickPickItem extends vscode.QuickPickItem {
  issue?: Issue;
  action?: "search" | "skip";
  disabled?: boolean;
}

interface ActivityQuickPickItem extends vscode.QuickPickItem {
  activity: TimeEntryActivity;
}

/**
 * Day planning wizard
 * Returns array of WorkUnits or undefined if cancelled
 */
export async function showPlanDayDialog(
  server: RedmineServer,
  unitDurationMinutes: number = 60,
  workDurationSeconds: number = 45 * 60
): Promise<WorkUnit[] | undefined> {
  // Step 1: How many units?
  const unitDurationStr = formatMinutesAsHHMM(unitDurationMinutes);
  const countInput = await vscode.window.showInputBox({
    title: "Plan Day",
    prompt: `How many units? (${unitDurationStr} each)`,
    placeHolder: "e.g., 8",
    value: "8",
    validateInput: (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1) return "Enter a number ≥ 1";
      if (n > 16) return "Max 16 units";
      return null;
    },
  });

  if (!countInput) return undefined;
  const unitCount = parseInt(countInput, 10);

  const units: WorkUnit[] = [];

  // Skip mode selection for single unit - go straight to picking
  if (unitCount === 1) {
    const unit = await pickIssueAndActivity(server, "Unit 1", workDurationSeconds);
    if (!unit) return undefined;
    return [unit];
  }

  // Step 2: Assignment mode (only for multiple units)
  const modeOptions = [
    {
      label: "$(history) Same task for all units",
      mode: "same" as const,
    },
    {
      label: "$(list) Pick issue for each unit",
      mode: "each" as const,
    },
    {
      label: "$(sparkle) Start empty (assign later)",
      mode: "empty" as const,
    },
  ];

  const modeChoice = await vscode.window.showQuickPick(modeOptions, {
    title: "Plan Day - Assignment",
    placeHolder: `${unitCount} units to plan`,
  });

  if (!modeChoice) return undefined;

  if (modeChoice.mode === "empty") {
    // Create empty units
    for (let i = 0; i < unitCount; i++) {
      units.push({
        issueId: 0,
        issueSubject: "(not assigned)",
        activityId: 0,
        activityName: "",
        logged: false,
        secondsLeft: workDurationSeconds,
        unitPhase: "pending",
      });
    }
    return units;
  }

  if (modeChoice.mode === "same") {
    // Pick one issue/activity for all units
    const unit = await pickIssueAndActivity(server, "All Units", workDurationSeconds);
    if (!unit) return undefined;

    for (let i = 0; i < unitCount; i++) {
      // Each unit gets its own timer state
      units.push({ ...unit, logged: false, secondsLeft: workDurationSeconds, unitPhase: "pending" });
    }
    return units;
  }

  // "each" mode - pick for each unit
  for (let i = 0; i < unitCount; i++) {
    const unit = await pickIssueAndActivity(
      server,
      `Unit ${i + 1} of ${unitCount}`,
      workDurationSeconds
    );

    if (unit === undefined) {
      // User cancelled - abort entire wizard
      return undefined;
    }

    units.push(unit);
  }

  return units;
}

/**
 * Pick an issue and activity for a single unit
 */
export async function pickIssueAndActivity(
  server: RedmineServer,
  title: string,
  workDurationSeconds: number = 45 * 60
): Promise<WorkUnit | undefined> {
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
    // Skip at the end
    {
      label: "$(dash) Skip (assign later)",
      action: "skip",
    },
  ];

  // Use createQuickPick for inline search with proper click handling
  const selectedIssue = await new Promise<Issue | "skip" | undefined>((resolve) => {
    const quickPick = vscode.window.createQuickPick<IssueQuickPickItem>();
    quickPick.title = `Plan Day - ${title}`;
    quickPick.placeholder = "Type to search, or select from list";
    quickPick.items = baseItems;
    quickPick.matchOnDescription = true;

    let searchTimeout: ReturnType<typeof setTimeout> | undefined;
    let resolved = false;
    let searchVersion = 0; // Track search version to discard stale results

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

    quickPick.onDidChangeValue(async (value) => {
      if (searchTimeout) clearTimeout(searchTimeout);

      if (!value.trim()) {
        quickPick.items = baseItems;
        return;
      }

      // Debounce search (300ms)
      searchTimeout = setTimeout(async () => {
        const query = value.trim();
        if (!query) return;

        // Require at least 2 chars to search
        if (query.length < 2) return;

        // Track this search version to detect stale results
        const thisSearchVersion = ++searchVersion;
        quickPick.busy = true;

        try {
          const lowerQuery = query.toLowerCase();
          const cleanQuery = query.replace(/^#/, "");
          const possibleId = parseInt(cleanQuery, 10);
          const isNumericQuery = !isNaN(possibleId) && cleanQuery === String(possibleId);

          // 1. Search local assigned issues (instant, no API)
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
            // Exact ID fetch for numeric queries
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
            // Server text search (always - numeric queries might match subjects like "2024 report")
            (async () => {
              searchResult.serverResults = await server.searchIssues(query, 10);
            })(),
          ]);

          const { exactMatch, exactMatchError, serverResults } = searchResult;

          // 3. Merge results (exact match first, then local, then server)
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
              .filter((id): id is number => id != null && !timeTrackingByProject.has(id))
          )];

          if (newProjectIds.length > 0) {
            await Promise.all(
              newProjectIds.map(async (projectId) => {
                try {
                  const enabled = await server.isTimeTrackingEnabled(projectId);
                  timeTrackingByProject.set(projectId, enabled);
                } catch {
                  // If can't check, assume not trackable
                  timeTrackingByProject.set(projectId, false);
                }
              })
            );
          }

          // 5. Filter to trackable issues and rank assigned issues higher
          const assignedIds = new Set(issues.map(i => i.id));
          const trackableResults = allResults.filter((issue) => {
            const projectId = issue.project?.id;
            return projectId != null && timeTrackingByProject.get(projectId) === true;
          });

          // Sort: assigned issues first, then by ID (most recent first)
          trackableResults.sort((a, b) => {
            const aAssigned = assignedIds.has(a.id);
            const bAssigned = assignedIds.has(b.id);
            if (aAssigned && !bAssigned) return -1;
            if (!aAssigned && bAssigned) return 1;
            return b.id - a.id; // Higher ID = more recent
          });

          // 6. Check if results are still relevant (not stale, picker not closed)
          if (thisSearchVersion !== searchVersion || resolved) {
            return; // Discard stale results
          }

          // 7. Build result items with visual distinction for assigned issues
          const limitedResults = trackableResults.slice(0, 15);
          const resultItems: IssueQuickPickItem[] = [];

          // Show exact match error if no results
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

          // Add search results with visual distinction
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
        } catch (error) {
          // Show error feedback if this search is still current
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
      }, 300);
    });

    // Handle Enter key
    quickPick.onDidAccept(() => {
      const selected = quickPick.activeItems[0];
      if (selected) handleSelection(selected);
    });

    // Handle click (onDidChangeSelection fires on click)
    quickPick.onDidChangeSelection((items) => {
      if (items.length > 0) handleSelection(items[0]);
    });

    quickPick.onDidHide(() => {
      if (searchTimeout) clearTimeout(searchTimeout);
      if (!resolved) {
        resolved = true;
        resolve(undefined);
      }
      quickPick.dispose();
    });

    quickPick.show();
  });

  if (selectedIssue === undefined) return undefined;

  if (selectedIssue === "skip") {
    return {
      issueId: 0,
      issueSubject: "(not assigned)",
      activityId: 0,
      activityName: "",
      logged: false,
      secondsLeft: workDurationSeconds,
      unitPhase: "pending",
    };
  }

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
    activities = await server.getProjectTimeEntryActivities(
      finalIssue.project.id
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to fetch activities: ${error}`);
    return undefined;
  }

  if (activities.length === 0) {
    vscode.window.showErrorMessage("No activities available for this project");
    return undefined;
  }

  const activityItems: ActivityQuickPickItem[] = activities.map((a) => ({
    label: a.name,
    activity: a,
  }));

  const activityChoice = await vscode.window.showQuickPick(activityItems, {
    title: `Plan Day - ${title}`,
    placeHolder: `Activity for #${finalIssue.id}`,
  });

  if (!activityChoice) return undefined;

  // Optional comment
  const comment = await vscode.window.showInputBox({
    title: `Plan Day - ${title}`,
    prompt: "Comment (optional)",
    placeHolder: "e.g., Sprint planning",
  });

  if (comment === undefined) return undefined;

  return {
    issueId: finalIssue.id,
    issueSubject: finalIssue.subject,
    activityId: activityChoice.activity.id,
    activityName: activityChoice.activity.name,
    comment: comment || undefined,
    logged: false,
    secondsLeft: workDurationSeconds,
    unitPhase: "pending",
  };
}

/**
 * Show completion dialog when timer ends
 * Returns hours to log, or undefined if skipped/cancelled
 */
export async function showCompletionDialog(
  unit: WorkUnit,
  defaultHours: number
): Promise<{ hours: number; comment?: string } | undefined> {
  const hoursStr = formatHoursAsHHMM(defaultHours);
  const options = [
    {
      label: `$(check) Log ${hoursStr} & Start Break`,
      action: "log" as const,
    },
    {
      label: "$(close) Skip (don't log)",
      action: "skip" as const,
    },
  ];

  const choice = await vscode.window.showQuickPick(options, {
    title: `Unit Complete! Log to #${unit.issueId}?`,
    placeHolder: `${unit.issueSubject} • ${unit.activityName}`,
  });

  if (!choice || choice.action === "skip") {
    return undefined;
  }

  // Ask for comment update (pre-filled with existing)
  const comment = await vscode.window.showInputBox({
    title: `Log Time - #${unit.issueId}`,
    prompt: "Comment (optional)",
    value: unit.comment || "",
    placeHolder: "e.g., Completed feature X",
  });

  if (comment === undefined) return undefined;

  return {
    hours: defaultHours,
    comment: comment || undefined,
  };
}

