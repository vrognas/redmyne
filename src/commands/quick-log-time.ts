import * as vscode from "vscode";
import type { ActionProperties } from "./action-properties";
import { parseTimeInput, validateTimeInput, formatHoursAsHHMM } from "../utilities/time-input";
import { showStatusBarMessage } from "../utilities/status-bar";
import { pickIssueWithSearch, pickActivityForProject } from "../utilities/issue-picker";
import { pickDate } from "../utilities/date-picker";
import { errorToString } from "../utilities/error-feedback";
import { pickRequiredCustomFields, TimeEntryCustomFieldValue } from "../utilities/custom-field-picker";
import { confirmLogTimeOnClosedIssue } from "../utilities/closed-issue-guard";

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
  presetDate?: string, // Optional pre-selected date (YYYY-MM-DD)
  presetIssueId?: number // Optional pre-selected issue ID (from context menu)
): Promise<void> {
  let promptedForCustomFields = false;
  try {
    // 1. Get recent log from cache
    const recent = context.globalState.get<RecentTimeLog>("lastTimeLog");

    // 2. Determine issue selection
    let selection: {
      issueId: number;
      activityId: number;
      activityName: string;
      issueSubject: string;
    };

    // If issue pre-selected (from context menu), fetch it and pick activity only
    let fetchedIssue: Pick<import("../redmine/models/issue").Issue, "id" | "status"> | undefined;
    if (presetIssueId) {
      const issueResult = await props.server.getIssueById(presetIssueId);
      const issue = issueResult.issue;
      fetchedIssue = issue;
      if (!issue.project?.id) {
        vscode.window.showErrorMessage("Issue has no associated project");
        return;
      }
      const activity = await pickActivityForProject(
        props.server,
        issue.project.id,
        "Log Time",
        `#${issue.id}`
      );
      if (!activity) return;
      selection = {
        issueId: issue.id,
        issueSubject: issue.subject,
        activityId: activity.activityId,
        activityName: activity.activityName,
      };
    } else if (recent && isRecent(recent.lastLogged)) {
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

    // 2b. Confirm if issue is closed (reuse fetched issue to avoid duplicate API call)
    const confirmed = await confirmLogTimeOnClosedIssue(props.server, selection.issueId, fetchedIssue);
    if (!confirmed) return;

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

    // 7. Check for required custom fields
    let customFieldValues: TimeEntryCustomFieldValue[] | undefined;
    try {
      const customFieldDefs = await props.server.getTimeEntryCustomFields();
      const required = customFieldDefs.filter((f) => f.is_required);
      if (required.length > 0) {
        promptedForCustomFields = true;
        const { values, cancelled } = await pickRequiredCustomFields(required);
        if (cancelled) return;
        customFieldValues = values;
      }
    } catch {
      // Custom fields API not accessible (non-admin) - continue without
    }

    // 8. Post time entry (always pass date for draft mode compatibility)
    await props.server.addTimeEntry(
      selection.issueId,
      selection.activityId,
      hoursStr,
      comment || "",
      selectedDate,
      customFieldValues
    );

    // 9. Refresh time entries tree
    vscode.commands.executeCommand("redmyne.refreshTimeEntries");

    // 10. Update cache
    await context.globalState.update("lastTimeLog", {
      issueId: selection.issueId,
      issueSubject: selection.issueSubject,
      lastActivityId: selection.activityId,
      lastActivityName: selection.activityName,
      lastLogged: new Date(),
    });

    // 11. Confirm with status bar flash (NOT notification)
    const dateConfirmation = selectedDate === today ? "" : ` on ${selectedDate}`;
    showStatusBarMessage(
      `$(check) Logged ${formatHoursAsHHMM(hours)} to #${selection.issueId}${dateConfirmation}`
    );
  } catch (error) {
    const errorMsg = errorToString(error);
    // Detect custom field validation errors (e.g., "Custom field 'X' cannot be blank")
    const isCustomFieldError = /custom.?field/i.test(errorMsg);

    if (isCustomFieldError && !promptedForCustomFields) {
      // Server requires custom fields but we didn't prompt - likely non-admin user
      vscode.window.showErrorMessage(
        `${errorMsg} - The custom fields API requires admin access. ` +
        "Log time via Redmine web interface or contact your administrator.",
        "Open Redmine"
      ).then((choice) => {
        if (choice === "Open Redmine") {
          const url = props.config.serverUrl;
          if (url) {
            vscode.env.openExternal(vscode.Uri.parse(`${url}/time_entries/new`));
          }
        }
      });
    } else {
      vscode.window.showErrorMessage(`Failed to log time: ${errorMsg}`);
    }
  }
}

