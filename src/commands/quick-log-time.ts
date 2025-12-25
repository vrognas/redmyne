import * as vscode from "vscode";
import type { ActionProperties } from "./action-properties";
import { parseTimeInput, validateTimeInput, formatHoursAsHHMM } from "../utilities/time-input";
import { showStatusBarMessage } from "../utilities/status-bar";
import { pickIssueWithSearch } from "../utilities/issue-picker";
import { pickDate } from "../utilities/date-picker";

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
  context: vscode.ExtensionContext,
  presetDate?: string // Optional pre-selected date (YYYY-MM-DD)
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
        const picked = await pickIssueWithSearch(props.server, "Log Time (1/2)");
        if (!picked || picked === "skip") return;
        selection = picked;
      }
    } else {
      const picked = await pickIssueWithSearch(props.server, "Log Time (1/2)");
      if (!picked || picked === "skip") return;
      selection = picked;
    }

    // 3. Pick date (skip if presetDate provided)
    const selectedDate = presetDate ?? (await pickDate());
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
      prompt: `Log time to #${selection.issueId} (${selection.activityName})${dateTotal > 0 ? ` | ${dateLabel}: ${formatHoursAsHHMM(dateTotal)} logged` : ""}`,
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
      `$(check) Logged ${formatHoursAsHHMM(hours)} to #${selection.issueId}${dateConfirmation}`
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to log time: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

