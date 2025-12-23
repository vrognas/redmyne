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

  const issueItems: IssueQuickPickItem[] = [
    // Search option at top
    {
      label: "$(search) Search by #ID or text...",
      action: "search",
      description: "Find any issue",
    },
    // Separator
    {
      label: "",
      kind: vscode.QuickPickItemKind.Separator,
    } as IssueQuickPickItem,
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

  // Loop to handle search and disabled issue selection
  let selectedIssue: Issue | undefined;
  while (true) {
    const issueChoice = await vscode.window.showQuickPick(issueItems, {
      title: `Plan Day - ${title}`,
      placeHolder: "Select issue or search",
      matchOnDescription: true,
    });

    if (!issueChoice) return undefined;

    if (issueChoice.action === "skip") {
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

    if (issueChoice.action === "search") {
      const query = await vscode.window.showInputBox({
        title: `Plan Day - ${title}`,
        prompt: "Enter #ID or search text",
        placeHolder: "e.g., 1234 or keyword",
      });
      if (!query) continue;

      // Check if it's an issue ID (#123 or 123)
      const cleanQuery = query.replace(/^#/, "");
      const issueId = parseInt(cleanQuery, 10);

      if (!isNaN(issueId) && cleanQuery === String(issueId)) {
        try {
          const result = await server.getIssueById(issueId);
          selectedIssue = result.issue;
          break;
        } catch {
          vscode.window.showErrorMessage(`Issue #${issueId} not found`);
          continue;
        }
      } else if (query.length >= 2) {
        const searchResults = await server.searchIssues(query, 10);
        if (searchResults.length === 0) {
          vscode.window.showInformationMessage(`No results for "${query}"`);
          continue;
        }
        const searchItems = searchResults.map((issue) => ({
          label: `#${issue.id} ${issue.subject}`,
          description: issue.project?.name,
          detail: issue.status?.name,
          issue,
        }));
        const searchChoice = await vscode.window.showQuickPick(searchItems, {
          title: `Search Results - "${query}"`,
          placeHolder: `${searchResults.length} result(s)`,
        });
        if (!searchChoice) continue;
        selectedIssue = searchChoice.issue;
        break;
      } else {
        vscode.window.showInformationMessage("Enter at least 2 characters to search");
        continue;
      }
    }

    if (issueChoice.disabled) {
      vscode.window.showInformationMessage(
        `Project "${issueChoice.issue?.project?.name}" has no time tracking enabled`
      );
      continue;
    }

    selectedIssue = issueChoice.issue;
    break;
  }

  if (!selectedIssue) return undefined;

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

