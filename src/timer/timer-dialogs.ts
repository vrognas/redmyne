import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { WorkUnit } from "./timer-state";
import { formatHoursAsHHMM, formatMinutesAsHHMM } from "../utilities/time-input";
import { pickIssueWithSearch } from "../utilities/issue-picker";

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
  const result = await pickIssueWithSearch(server, `Plan Day - ${title}`, { allowSkip: true });

  if (result === undefined) return undefined;

  if (result === "skip") {
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

  // Optional comment for timer units
  const comment = await vscode.window.showInputBox({
    title: `Plan Day - ${title}`,
    prompt: "Comment (optional)",
    placeHolder: "e.g., Sprint planning",
  });

  if (comment === undefined) return undefined;

  return {
    issueId: result.issueId,
    issueSubject: result.issueSubject,
    activityId: result.activityId,
    activityName: result.activityName,
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

