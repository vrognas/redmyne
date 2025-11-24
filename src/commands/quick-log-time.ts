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

export async function quickLogTime(
  props: ActionProperties,
  context: vscode.ExtensionContext
): Promise<void> {
  try {
    // 1. Get recent log from cache
    const recent = context.globalState.get<RecentTimeLog>("lastTimeLog");

    // 2. Prompt: recent issue or pick new?
    let selection: { issueId: number; activityId: number; issueSubject: string };

    if (recent && isRecent(recent.lastLogged)) {
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: `$(history) Log to #${recent.issueId}: ${recent.issueSubject}`,
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

    // 3. Input hours
    const hours = await vscode.window.showInputBox({
      prompt: `Hours worked on #${selection.issueId}`,
      placeHolder: "2.5",
      validateInput: (value: string) => {
        const num = parseFloat(value);
        if (isNaN(num) || num <= 0 || num > 24) {
          return "Must be 0.1-24 hours";
        }
        return null;
      },
    });

    if (!hours) return; // User cancelled

    // 4. Post time entry
    await props.server.addTimeEntry(
      selection.issueId,
      selection.activityId,
      hours,
      "" // No comment for quick logging
    );

    // 5. Update cache
    await context.globalState.update("lastTimeLog", {
      issueId: selection.issueId,
      issueSubject: selection.issueSubject,
      lastActivityId: selection.activityId,
      lastActivityName: "", // Not critical for cache
      lastLogged: new Date(),
    });

    // 6. Confirm with status bar flash (NOT notification)
    const statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left
    );
    statusBar.text = `$(check) Logged ${hours}h to #${selection.issueId}`;
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
  { issueId: number; activityId: number; issueSubject: string } | undefined
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
    issueSubject: picked.issue.subject,
  };
}
