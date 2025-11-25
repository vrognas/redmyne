import * as vscode from "vscode";
import type { ActionProperties } from "./action-properties";
import { parseTimeInput, validateTimeInput } from "../utilities/time-input";

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
      validateInput: (value: string) => validateTimeInput(value, todayTotal),
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
