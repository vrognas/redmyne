import * as vscode from "vscode";
import type { ActionProperties } from "./action-properties";

interface RecentTimeLog {
  issueId: number;
  issueSubject: string;
  lastActivityId: number;
  lastActivityName: string;
  lastLogged: Date;
}

function isRecent(date: Date): boolean {
  return Date.now() - new Date(date).getTime() < 24 * 60 * 60 * 1000; // 24h
}

function parseTimeInput(input: string): number | null {
  const trimmed = input.trim();

  // Format: "1.75" or "1,75" (decimal hours)
  const decimalMatch = trimmed.match(/^(\d+(?:[.,]\d+)?)$/);
  if (decimalMatch) {
    return parseFloat(decimalMatch[1].replace(",", "."));
  }

  // Format: "1:45" (hours:minutes)
  const colonMatch = trimmed.match(/^(\d+):(\d+)$/);
  if (colonMatch) {
    const hours = parseInt(colonMatch[1], 10);
    const minutes = parseInt(colonMatch[2], 10);
    if (minutes >= 60) return null; // Invalid minutes
    return hours + minutes / 60;
  }

  // Format: "1h 45min" or "1 h 45 min" (with units and optional spaces)
  const unitMatch = trimmed.match(
    /^(?:(\d+)\s*h(?:our)?s?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?$/i
  );
  if (unitMatch) {
    const hours = unitMatch[1] ? parseInt(unitMatch[1], 10) : 0;
    const minutes = unitMatch[2] ? parseInt(unitMatch[2], 10) : 0;
    if (hours === 0 && minutes === 0) return null; // No input
    if (minutes >= 60) return null; // Invalid minutes
    return hours + minutes / 60;
  }

  return null; // Invalid format
}

export async function quickLogTime(
  props: ActionProperties,
  context: vscode.ExtensionContext
): Promise<void> {
  try {
    // Start fetching today's time entries early (runs during UI interactions)
    const today = new Date().toISOString().split("T")[0];
    const timeEntriesPromise = props.server.getTimeEntries({
      from: today,
      to: today,
    });

    // 1. Get recent log from cache
    const recent = context.globalState.get<RecentTimeLog>("lastTimeLog");

    // 2. Prompt: recent issue or pick new?
    let selection: {
      issueId: number;
      activityId: number;
      activityName: string;
      issueSubject: string;
    };

    if (recent && isRecent(recent.lastLogged)) {
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: `$(history) Log to #${recent.issueId}: ${recent.issueSubject} [${recent.lastActivityName}]`,
            value: "recent",
          },
          { label: "$(search) Pick different issue", value: "pick" },
        ],
        { placeHolder: "Log time to..." }
      );

      if (!choice) return; // User cancelled

      if (choice.value === "recent") {
        selection = {
          issueId: recent.issueId,
          activityId: recent.lastActivityId,
          activityName: recent.lastActivityName,
          issueSubject: recent.issueSubject,
        };
      } else {
        const picked = await pickIssueAndActivity(props, context);
        if (!picked) return;
        selection = picked;
      }
    } else {
      const picked = await pickIssueAndActivity(props, context);
      if (!picked) return;
      selection = picked;
    }

    // 3. Await time entries (started earlier, likely ready now)
    const todayEntries = await timeEntriesPromise;
    const todayTotal = todayEntries.time_entries.reduce(
      (sum, entry) => sum + parseFloat(entry.hours),
      0
    );

    // 4. Input hours
    const hoursInput = await vscode.window.showInputBox({
      prompt: `Log time to #${selection.issueId} (${selection.activityName})${todayTotal > 0 ? ` | Today: ${todayTotal.toFixed(1)}h logged` : ""}`,
      placeHolder: "e.g., 2.5, 1:45, 1h 45min",
      validateInput: (value: string) => {
        const hours = parseTimeInput(value);
        if (hours === null || hours < 0.1 || hours > 24) {
          return "Must be 0.1-24 hours (e.g. equivalent: 1.75, 1:45, or 1h 45min)";
        }
        // Check if adding this entry would exceed 24h for today
        if (todayTotal + hours > 24) {
          return `Would exceed 24h/day limit (already logged ${todayTotal.toFixed(1)}h today)`;
        }
        return null;
      },
    });

    if (!hoursInput) return; // User cancelled

    const hours = parseTimeInput(hoursInput)!; // Already validated
    const hoursStr = hours.toString();

    // 5. Input comment (optional)
    const comment = await vscode.window.showInputBox({
      prompt: `Comment for #${selection.issueId} (optional)`,
      placeHolder: "e.g., Implemented feature X",
    });

    if (comment === undefined) return; // User cancelled

    // 6. Post time entry
    await props.server.addTimeEntry(
      selection.issueId,
      selection.activityId,
      hoursStr,
      comment || "" // Empty string if no comment
    );

    // 7. Update cache
    await context.globalState.update("lastTimeLog", {
      issueId: selection.issueId,
      issueSubject: selection.issueSubject,
      lastActivityId: selection.activityId,
      lastActivityName: selection.activityName,
      lastLogged: new Date(),
    });

    // 8. Confirm with status bar flash (NOT notification)
    const statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left
    );
    statusBar.text = `$(check) Logged ${hours.toFixed(2).replace(/\.?0+$/, "")}h to #${selection.issueId}`;
    statusBar.show();
    setTimeout(() => {
      statusBar.hide();
      statusBar.dispose();
    }, 3000);
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to log time: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function pickIssueAndActivity(
  props: ActionProperties,
  context: vscode.ExtensionContext
): Promise<
  | {
      issueId: number;
      activityId: number;
      activityName: string;
      issueSubject: string;
    }
  | undefined
> {
  // Get recent issue IDs from cache (LRU 10)
  const recentIds = context.globalState.get<number[]>("recentIssueIds", []);

  // Fetch assigned issues
  const { issues } = await props.server.getIssuesAssignedToMe();

  if (issues.length === 0) {
    vscode.window.showErrorMessage(
      "No issues assigned to you. Please use browser to create issues."
    );
    return undefined;
  }

  // Sort: recent first, then by due date
  const sortedIssues = [
    ...issues.filter((i) => recentIds.includes(i.id)),
    ...issues.filter((i) => !recentIds.includes(i.id)),
  ].slice(0, 10); // Limit to 10 for instant UX

  const quickPickItems = sortedIssues.map((i) => ({
    label: `#${i.id} ${i.subject}`,
    description: i.project.name,
    detail: `${i.status.name}${i.due_date ? ` | Due: ${i.due_date}` : ""}`,
    issue: i,
  }));

  const picked = await vscode.window.showQuickPick(quickPickItems, {
    title: "Log Time (1/2)",
    placeHolder: "Select issue to log time",
    matchOnDescription: true,
  });

  if (!picked) return undefined;

  // Update recent issues cache
  const updatedRecent = [
    picked.issue.id,
    ...recentIds.filter((id: number) => id !== picked.issue.id),
  ].slice(0, 10);
  await context.globalState.update("recentIssueIds", updatedRecent);

  // Pick activity
  const activities = await props.server.getTimeEntryActivities();
  const activity = await vscode.window.showQuickPick(
    activities.time_entry_activities.map((a) => ({
      label: a.name,
      description: a.is_default ? "Default" : undefined,
      activity: a,
    })),
    {
      title: "Log Time (2/2)",
      placeHolder: "Select activity",
    }
  );

  if (!activity) return undefined;

  return {
    issueId: picked.issue.id,
    activityId: activity.activity.id,
    activityName: activity.activity.name,
    issueSubject: picked.issue.subject,
  };
}
