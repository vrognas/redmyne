import * as vscode from "vscode";
import type { ActionProperties } from "./action-properties";
import { parseTimeInput, validateTimeInput } from "../utilities/time-input";
import { showStatusBarMessage } from "../utilities/status-bar";

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
        { title: "Quick Log Time", placeHolder: "Log time to..." }
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

    // 3. Pick date (Today/Yesterday/Custom)
    const selectedDate = await pickDate();
    if (selectedDate === undefined) return; // User cancelled

    // 4. Fetch time entries for selected date (runs during date picker)
    const timeEntriesPromise = props.server.getTimeEntries({
      from: selectedDate,
      to: selectedDate,
    });

    const dateEntries = await timeEntriesPromise;
    const dateTotal = dateEntries.time_entries.reduce(
      (sum, entry) => sum + parseFloat(entry.hours),
      0
    );

    // 5. Input hours
    const today = new Date().toISOString().split("T")[0];
    const dateLabel = selectedDate === today ? "Today" : selectedDate;
    const hoursInput = await vscode.window.showInputBox({
      prompt: `Log time to #${selection.issueId} (${selection.activityName})${dateTotal > 0 ? ` | ${dateLabel}: ${dateTotal.toFixed(1)}h logged` : ""}`,
      placeHolder: "e.g., 2.5, 1:45, 1h 45min",
      validateInput: (value: string) => validateTimeInput(value, dateTotal),
    });

    if (!hoursInput) return; // User cancelled

    const hours = parseTimeInput(hoursInput)!; // Already validated
    const hoursStr = hours.toString();

    // 6. Input comment (optional)
    const comment = await vscode.window.showInputBox({
      prompt: `Comment for #${selection.issueId} (optional)`,
      placeHolder: "e.g., Implemented feature X",
    });

    if (comment === undefined) return; // User cancelled

    // 7. Post time entry (only pass spentOn if not today)
    if (selectedDate === today) {
      await props.server.addTimeEntry(
        selection.issueId,
        selection.activityId,
        hoursStr,
        comment || ""
      );
    } else {
      await props.server.addTimeEntry(
        selection.issueId,
        selection.activityId,
        hoursStr,
        comment || "",
        selectedDate
      );
    }

    // 8. Refresh time entries tree
    vscode.commands.executeCommand("redmine.refreshTimeEntries");

    // 9. Update cache
    await context.globalState.update("lastTimeLog", {
      issueId: selection.issueId,
      issueSubject: selection.issueSubject,
      lastActivityId: selection.activityId,
      lastActivityName: selection.activityName,
      lastLogged: new Date(),
    });

    // 10. Confirm with status bar flash (NOT notification)
    const dateConfirmation = selectedDate === today ? "" : ` on ${selectedDate}`;
    showStatusBarMessage(
      `$(check) Logged ${hours.toFixed(2).replace(/\.?0+$/, "")}h to #${selection.issueId}${dateConfirmation}`
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to log time: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function pickDate(): Promise<string | undefined> {
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  const dateChoice = await vscode.window.showQuickPick(
    [
      { label: "$(calendar) Today", value: "today", date: todayStr },
      { label: "$(history) Yesterday", value: "yesterday", date: yesterdayStr },
      { label: "$(edit) Pick date...", value: "pick", date: "" },
    ],
    { title: "Log Time - Select Date", placeHolder: "Which day?" }
  );

  if (!dateChoice) return undefined;

  if (dateChoice.value === "pick") {
    const customDate = await vscode.window.showInputBox({
      prompt: "Enter date (YYYY-MM-DD)",
      placeHolder: yesterdayStr,
      validateInput: (value: string) => {
        if (!value) return "Date required";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Use YYYY-MM-DD format";
        const parsed = new Date(value);
        if (isNaN(parsed.getTime())) return "Invalid date";
        if (parsed > today) return "Cannot log time in the future";
        return null;
      },
    });
    return customDate;
  }

  return dateChoice.date;
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

  // Pick activity (use project-specific activities if configured)
  const activities = await props.server.getProjectTimeEntryActivities(
    picked.issue.project.id
  );
  const activity = await vscode.window.showQuickPick(
    activities.map((a) => ({
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
