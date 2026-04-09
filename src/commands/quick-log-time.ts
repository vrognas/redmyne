import * as vscode from "vscode";
import type { ActionProperties } from "./action-properties";
import { parseTimeInput, validateTimeInput, formatHoursAsHHMM } from "../utilities/time-input";
import { showStatusBarMessage } from "../utilities/status-bar";
import { pickIssueWithSearch, pickActivityForProject } from "../utilities/issue-picker";
import { recordRecentIssue } from "../utilities/recent-issues";
import { pickDate } from "../utilities/date-picker";
import { errorToString } from "../utilities/error-feedback";
import { pickRequiredCustomFields, TimeEntryCustomFieldValue } from "../utilities/custom-field-picker";
import { confirmLogTimeOnClosedIssue } from "../utilities/closed-issue-guard";

function truncateSubject(subject: string, max = 30): string {
  return subject.length > max ? subject.slice(0, max - 1) + "…" : subject;
}

export async function quickLogTime(
  props: ActionProperties,
  presetDate?: string, // Optional pre-selected date (YYYY-MM-DD)
  presetIssueId?: number // Optional pre-selected issue ID (from context menu)
): Promise<void> {
  let promptedForCustomFields = false;
  try {
    // 1. Determine issue + activity selection
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
        `Log Time · #${issue.id} ${truncateSubject(issue.subject)}`,
        "What type of work?"
      );
      if (!activity) return;
      selection = {
        issueId: issue.id,
        issueSubject: issue.subject,
        activityId: activity.activityId,
        activityName: activity.activityName,
      };
      recordRecentIssue(issue.id, issue.subject, issue.project?.name ?? "");
    } else {
      // Searchable picker with recent issues at the top
      const picked = await pickIssueWithSearch(props.server, "Log Time");
      if (!picked || picked === "skip") return;
      selection = picked;
    }

    // 2b. Confirm if issue is closed (reuse fetched issue to avoid duplicate API call)
    const confirmed = await confirmLogTimeOnClosedIssue(props.server, selection.issueId, fetchedIssue);
    if (!confirmed) return;

    // Build progressive context string
    const issueCtx = `#${selection.issueId} ${truncateSubject(selection.issueSubject)}`;
    const activityCtx = `[${selection.activityName}]`;

    // 3. Pick date (skip if presetDate provided)
    const selectedDate = presetDate ?? (await pickDate({
      title: `Log Time · ${issueCtx} ${activityCtx}`,
    }));
    if (selectedDate === undefined) return; // User cancelled

    // 4. Fetch time entries for selected date
    const timeEntriesPromise = props.server.getTimeEntries({
      from: selectedDate,
      to: selectedDate,
    });

    const dateEntries = await timeEntriesPromise;
    const dateTotal = dateEntries.time_entries.reduce(
      (sum, entry) => sum + parseFloat(entry.hours),
      0
    );

    // 5. Input hours — title shows context, prompt shows the question
    const today = new Date().toISOString().split("T")[0];
    const dateLabel = selectedDate === today ? "Today" : selectedDate;
    const hoursInput = await vscode.window.showInputBox({
      title: `Log Time · ${issueCtx} ${activityCtx} · ${dateLabel}`,
      prompt: dateTotal > 0
        ? `Hours? (${formatHoursAsHHMM(dateTotal)} already logged ${dateLabel.toLowerCase()})`
        : "Hours?",
      placeHolder: "e.g., 2.5, 1:45, 1h 45min",
      validateInput: (value: string) => validateTimeInput(value, dateTotal),
    });

    if (!hoursInput) return; // User cancelled

    const hours = parseTimeInput(hoursInput)!; // Already validated
    const hoursStr = hours.toString();

    // 6. Input comment — full context in title
    const comment = await vscode.window.showInputBox({
      title: `Log Time · ${issueCtx} · ${formatHoursAsHHMM(hours)} ${activityCtx} · ${dateLabel}`,
      prompt: "Comment (optional, press Enter to skip)",
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

    // 10. Confirm with status bar flash (NOT notification)
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

