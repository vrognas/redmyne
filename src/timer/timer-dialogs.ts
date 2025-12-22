import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { Issue } from "../redmine/models/issue";
import { TimeEntryActivity } from "../redmine/models/time-entry-activity";
import { WorkUnit } from "./timer-state";

interface IssueQuickPickItem extends vscode.QuickPickItem {
  issue?: Issue;
  action?: "search" | "skip";
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

  const issueItems: IssueQuickPickItem[] = issues.map((issue) => ({
    label: `#${issue.id} ${issue.subject}`,
    description: issue.project?.name,
    issue,
  }));

  issueItems.push({
    label: "$(search) Search issues...",
    action: "search",
  });

  issueItems.push({
    label: "$(dash) Skip (assign later)",
    action: "skip",
  });

  const issueChoice = await vscode.window.showQuickPick(issueItems, {
    title: `Plan Day - ${title}`,
    placeHolder: "Select issue",
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

  let selectedIssue: Issue | undefined;

  if (issueChoice.action === "search") {
    // Search dialog
    const query = await vscode.window.showInputBox({
      title: `Plan Day - ${title}`,
      prompt: "Search issues by ID or text",
      placeHolder: "e.g., 1234 or keyword",
    });
    if (!query) return undefined;

    // Try as issue ID first
    const issueId = parseInt(query, 10);
    if (!isNaN(issueId)) {
      try {
        const result = await server.getIssueById(issueId);
        selectedIssue = result.issue;
      } catch {
        vscode.window.showErrorMessage(`Issue #${issueId} not found`);
        return undefined;
      }
    } else {
      // Search by text - for now just show error, could add full search later
      vscode.window.showErrorMessage("Text search not yet implemented");
      return undefined;
    }
  } else {
    // Re-fetch issue to ensure we have complete and fresh data
    try {
      const result = await server.getIssueById(issueChoice.issue!.id);
      selectedIssue = result.issue;
    } catch {
      // Fallback to cached data if re-fetch fails
      selectedIssue = issueChoice.issue;
    }
  }

  if (!selectedIssue) return undefined;

  // Pick activity for this issue's project
  if (!selectedIssue.project?.id) {
    vscode.window.showErrorMessage("Issue has no associated project");
    return undefined;
  }

  let activities: TimeEntryActivity[];
  try {
    activities = await server.getProjectTimeEntryActivities(
      selectedIssue.project.id
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
    placeHolder: `Activity for #${selectedIssue.id}`,
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
    issueId: selectedIssue.id,
    issueSubject: selectedIssue.subject,
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

/**
 * Format minutes as H:MM (e.g., 60 → "1:00", 45 → "0:45", 90 → "1:30")
 */
function formatMinutesAsHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${m.toString().padStart(2, "0")}`;
}

/**
 * Format decimal hours as H:MM (e.g., 1.0 → "1:00", 0.75 → "0:45", 1.5 → "1:30")
 */
export function formatHoursAsHHMM(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${m.toString().padStart(2, "0")}`;
}
