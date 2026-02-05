/**
 * Time Entry Commands
 * Commands for managing time entries (edit, delete, open in browser)
 */

import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { formatHoursAsHHMM, parseTimeInput } from "../utilities/time-input";
import { showStatusBarMessage } from "../utilities/status-bar";
import { validateDateInput } from "../utilities/date-picker";
import { quickLogTime } from "./quick-log-time";
import { pickIssue } from "../utilities/issue-picker";
import {
  setClipboard,
  getClipboard,
  ClipboardEntry,
  calculatePasteTargetDates,
  getEntriesForTargetDate,
} from "../utilities/time-entry-clipboard";
import { parseLocalDate, getWeekStart, formatLocalDate } from "../utilities/date-utils";
import { DEFAULT_WEEKLY_SCHEDULE, WeeklySchedule } from "../utilities/flexibility-calculator";
import { MonthlyScheduleOverrides } from "../utilities/monthly-schedule";
import { pickCustomFields, TimeEntryCustomFieldValue } from "../utilities/custom-field-picker";
import { confirmLogTimeOnClosedIssues } from "../utilities/closed-issue-guard";

/** Time entry node from tree view */
interface TimeEntryNode {
  _entry?: {
    id?: number;
    hours: string;
    comments: string;
    activity?: { id: number; name: string };
    spent_on?: string;
    issue_id?: number;
    issue?: { id: number; subject: string };
    custom_fields?: Array<{ id: number; name: string; value: unknown }>;
  };
}

/** Day group node from tree view */
interface DayGroupNode {
  _date?: string; // YYYY-MM-DD
  _cachedEntries?: Array<{
    id?: number;
    issue_id?: number;
    issue?: { id: number };
    activity_id?: number;
    activity?: { id: number };
    hours: string;
    comments: string;
    spent_on?: string;
    custom_fields?: Array<{ id: number; name: string; value: unknown }>;
  }>;
}

/** Week group node from tree view */
interface WeekGroupNode {
  _weekStart?: string; // YYYY-MM-DD (Monday)
  _cachedEntries?: Array<{
    id?: number;
    issue_id?: number;
    issue?: { id: number };
    activity_id?: number;
    activity?: { id: number };
    hours: string;
    comments: string;
    spent_on?: string;
    custom_fields?: Array<{ id: number; name?: string; value: unknown }>;
  }>;
}

export interface TimeEntryCommandDeps {
  getServer: () => RedmineServer | undefined;
  refreshTree: () => void;
  getMonthlySchedules?: () => MonthlyScheduleOverrides;
}

export function registerTimeEntryCommands(
  context: vscode.ExtensionContext,
  deps: TimeEntryCommandDeps
): void {
  // Open time entry's issue in browser
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.openTimeEntryInBrowser", async (...args: unknown[]) => {
      let issueId: number | undefined;

      // Handle command URI (tooltip link passes [issueId] as first arg)
      if (typeof args[0] === "number") {
        issueId = args[0];
      }
      // Handle context menu (tree node with _entry)
      else if (args[0] && typeof args[0] === "object" && "_entry" in args[0]) {
        const node = args[0] as TimeEntryNode;
        issueId = node._entry?.issue_id ?? node._entry?.issue?.id;
      }
      // Handle object with issue_id
      else if (args[0] && typeof args[0] === "object" && "issue_id" in args[0]) {
        const params = args[0] as { issue_id: number };
        issueId = params.issue_id;
      }
      // Handle string
      else if (typeof args[0] === "string") {
        const parsed = parseInt(args[0], 10);
        if (!isNaN(parsed)) {
          issueId = parsed;
        }
      }

      if (!issueId) {
        vscode.window.showErrorMessage("Could not determine issue ID");
        return;
      }

      // Get URL from config
      const config = vscode.workspace.getConfiguration("redmyne");
      const url = config.get<string>("serverUrl");
      if (!url) {
        vscode.window.showErrorMessage("Redmine URL not configured");
        return;
      }

      await vscode.env.openExternal(vscode.Uri.parse(`${url}/issues/${issueId}`));
    })
  );

  // Edit time entry
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.editTimeEntry", async (node: TimeEntryNode) => {
      const entry = node?._entry;
      if (!entry?.id) {
        vscode.window.showErrorMessage("No time entry selected");
        return;
      }

      const server = deps.getServer();
      if (!server) {
        vscode.window.showErrorMessage("No Redmine server configured");
        return;
      }

      // Show what to edit
      const hoursDisplay = formatHoursAsHHMM(parseFloat(entry.hours));
      const issueDisplay = entry.issue ? `#${entry.issue.id} ${entry.issue.subject || ""}`.trim() : `#${entry.issue_id || "?"}`;

      // Fetch custom fields to determine if option should be shown
      const customFieldDefs = await server.getTimeEntryCustomFields();

      const options: Array<{ label: string; field: "issue" | "hours" | "comments" | "activity" | "date" | "customFields" }> = [
        { label: `Issue: ${issueDisplay}`, field: "issue" },
        { label: `Hours: ${hoursDisplay}`, field: "hours" },
        { label: `Comment: ${entry.comments || "(none)"}`, field: "comments" },
        { label: `Activity: ${entry.activity?.name || "Unknown"}`, field: "activity" },
        { label: `Date: ${entry.spent_on || "Unknown"}`, field: "date" },
      ];

      // Only show Custom Fields option if there are custom fields configured
      // and entry is not a draft (drafts have negative IDs and can't be fetched)
      const isDraft = (entry.id ?? 0) < 0;
      if (customFieldDefs.length > 0 && !isDraft) {
        options.push({ label: "$(symbol-field) Custom Fields", field: "customFields" });
      }

      const choice = await vscode.window.showQuickPick(options, {
        title: `Edit Time Entry #${entry.id}`,
        placeHolder: `#${entry.issue?.id} ${entry.issue?.subject || ""}`,
      });

      if (!choice) return;

      try {
        if (choice.field === "issue") {
          const newIssue = await pickIssue(server, "Move Time Entry to Issue");
          if (!newIssue) return;
          if (newIssue.id === (entry.issue?.id || entry.issue_id)) {
            vscode.window.showInformationMessage("Same issue selected, no change made");
            return;
          }
          await server.updateTimeEntry(entry.id, { issue_id: newIssue.id });
          showStatusBarMessage(`$(check) Moved to #${newIssue.id}`, 2000);
        } else if (choice.field === "hours") {
          const input = await vscode.window.showInputBox({
            title: "Edit Hours",
            value: formatHoursAsHHMM(parseFloat(entry.hours)),
            placeHolder: "e.g., 1:30, 1.5, 1h 30min",
            validateInput: (v) => {
              const parsed = parseTimeInput(v);
              if (parsed === null || parsed <= 0) return "Enter valid hours (e.g., 1:30, 1.5, 1h 30min)";
              return null;
            },
          });
          if (input === undefined) return;
          const hours = parseTimeInput(input)!;
          await server.updateTimeEntry(entry.id, { hours: hours.toString() });
        } else if (choice.field === "comments") {
          const input = await vscode.window.showInputBox({
            title: "Edit Comment",
            value: entry.comments,
            placeHolder: "Comment (optional)",
          });
          if (input === undefined) return;
          await server.updateTimeEntry(entry.id, { comments: input });
        } else if (choice.field === "activity") {
          // Need to fetch activities for this issue's project
          const issueResult = await server.getIssueById(entry.issue?.id || 0);
          const projectId = issueResult.issue.project?.id;
          if (!projectId) {
            vscode.window.showErrorMessage("Could not determine project");
            return;
          }
          const activities = await server.getProjectTimeEntryActivities(projectId);
          const activityChoice = await vscode.window.showQuickPick(
            activities.map((a: { name: string; id: number }) => ({ label: a.name, activityId: a.id })),
            { title: "Select Activity", placeHolder: "Activity" }
          );
          if (!activityChoice) return;
          await server.updateTimeEntry(entry.id, { activity_id: activityChoice.activityId });
        } else if (choice.field === "date") {
          const input = await vscode.window.showInputBox({
            title: "Edit Date",
            value: entry.spent_on || "",
            placeHolder: "YYYY-MM-DD",
            validateInput: (v) => validateDateInput(v, true),
          });
          if (input === undefined) return;
          await server.updateTimeEntry(entry.id, { spent_on: input });
        } else if (choice.field === "customFields") {
          // Fetch full entry to get existing custom field values
          const fullEntry = await server.getTimeEntryById(entry.id);
          const existing = (fullEntry.time_entry.custom_fields as TimeEntryCustomFieldValue[] | undefined)?.map(
            (f) => ({ id: f.id, value: f.value })
          );
          const { values, cancelled } = await pickCustomFields(customFieldDefs, existing);
          if (cancelled) return;
          await server.updateTimeEntry(entry.id, { custom_fields: values });
        }

        showStatusBarMessage("$(check) Time entry updated", 2000);
        deps.refreshTree();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to update: ${error}`);
      }
    })
  );

  // Delete time entry
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.deleteTimeEntry", async (node: TimeEntryNode) => {
      const entry = node?._entry;
      if (!entry?.id) {
        vscode.window.showErrorMessage("No time entry selected");
        return;
      }

      const server = deps.getServer();
      if (!server) {
        vscode.window.showErrorMessage("No Redmine server configured");
        return;
      }

      const hoursDisplay = formatHoursAsHHMM(parseFloat(entry.hours));
      const issueInfo = entry.issue ? `#${entry.issue.id} ${entry.issue.subject || ""}`.trim() : "Unknown issue";
      const activityInfo = entry.activity?.name ? `[${entry.activity.name}]` : "";
      const confirm = await vscode.window.showWarningMessage(
        "Delete time entry?",
        { modal: true, detail: `${issueInfo}\n${hoursDisplay} ${activityInfo} on ${entry.spent_on || "?"}` },
        "Delete"
      );

      if (confirm !== "Delete") return;

      try {
        await server.deleteTimeEntry(entry.id);
        showStatusBarMessage("$(check) Time entry deleted", 2000);
        deps.refreshTree();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to delete: ${error}`);
      }
    })
  );

  // Add time entry for a specific date (context menu on day-group)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.addTimeEntryForDate", async (node: DayGroupNode) => {
      const server = deps.getServer();
      if (!server) {
        vscode.window.showErrorMessage("No Redmine server configured");
        return;
      }

      const config = vscode.workspace.getConfiguration("redmyne");
      const url = config.get<string>("serverUrl") || "";

      await quickLogTime(
        { server, config: { ...config, serverUrl: url } },
        context,
        node?._date
      );
      deps.refreshTree();
    })
  );

  // Copy single time entry
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.copyTimeEntry", (node: TimeEntryNode) => {
      const entry = node?._entry;
      if (!entry) {
        vscode.window.showErrorMessage("No time entry selected");
        return;
      }

      const clipEntry: ClipboardEntry = {
        issue_id: entry.issue_id ?? entry.issue?.id ?? 0,
        activity_id: entry.activity?.id ?? 0,
        hours: entry.hours,
        comments: entry.comments || "",
        custom_fields: entry.custom_fields?.map((cf) => ({
          id: cf.id,
          value: cf.value as string | string[],
        })),
      };

      setClipboard({
        kind: "entry",
        entries: [clipEntry],
        sourceDate: entry.spent_on,
      });

      showStatusBarMessage("$(copy) Copied", 2000);
    })
  );

  // Copy all entries from a day
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.copyDayTimeEntries", (node: DayGroupNode) => {
      const entries = node?._cachedEntries;
      if (!entries || entries.length === 0) {
        // Allow copying empty day (results in empty paste)
        setClipboard({
          kind: "day",
          entries: [],
          sourceDate: node?._date,
        });
        showStatusBarMessage("$(copy) Day copied (empty)", 2000);
        return;
      }

      // Filter out drafts (negative IDs)
      const clipEntries: ClipboardEntry[] = entries
        .filter((e) => (e.id ?? 0) >= 0)
        .map((e) => ({
          issue_id: e.issue_id ?? e.issue?.id ?? 0,
          activity_id: e.activity_id ?? e.activity?.id ?? 0,
          hours: e.hours,
          comments: e.comments || "",
          custom_fields: e.custom_fields?.map((cf) => ({
            id: cf.id,
            value: cf.value as string | string[],
          })),
        }));

      setClipboard({
        kind: "day",
        entries: clipEntries,
        sourceDate: node._date,
      });

      const count = clipEntries.length;
      showStatusBarMessage(`$(copy) ${count} ${count === 1 ? "entry" : "entries"} copied`, 2000);
    })
  );

  // Copy all entries from a week
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.copyWeekTimeEntries", async (node?: WeekGroupNode) => {
      let entries = node?._cachedEntries;
      let weekStart = node?._weekStart;

      // If no node (toolbar invocation), fetch current week from server
      if (!weekStart) {
        const server = deps.getServer();
        if (!server) {
          vscode.window.showErrorMessage("No Redmine server configured");
          return;
        }
        weekStart = getWeekStart();
        const today = formatLocalDate(new Date());
        try {
          const result = await server.getTimeEntries({ from: weekStart, to: today });
          entries = result.time_entries;
        } catch {
          vscode.window.showErrorMessage("Failed to fetch time entries");
          return;
        }
      }

      // Group entries by day-of-week (0=Mon)
      const weekMap = new Map<number, ClipboardEntry[]>();
      const allEntries: ClipboardEntry[] = [];

      if (entries && entries.length > 0) {
        const monday = parseLocalDate(weekStart);

        for (const e of entries) {
          // Filter out drafts
          if ((e.id ?? 0) < 0) continue;

          const clipEntry: ClipboardEntry = {
            issue_id: e.issue_id ?? e.issue?.id ?? 0,
            activity_id: e.activity_id ?? e.activity?.id ?? 0,
            hours: e.hours,
            comments: e.comments || "",
            custom_fields: e.custom_fields?.map((cf) => ({
              id: cf.id,
              value: cf.value as string | string[],
            })),
          };
          allEntries.push(clipEntry);

          // Calculate day offset from Monday
          if (e.spent_on) {
            const entryDate = parseLocalDate(e.spent_on);
            const dayOffset = Math.floor(
              (entryDate.getTime() - monday.getTime()) / (1000 * 60 * 60 * 24)
            );
            if (dayOffset >= 0 && dayOffset < 7) {
              if (!weekMap.has(dayOffset)) {
                weekMap.set(dayOffset, []);
              }
              weekMap.get(dayOffset)!.push(clipEntry);
            }
          }
        }
      }

      setClipboard({
        kind: "week",
        entries: allEntries,
        weekMap,
        sourceWeekStart: weekStart,
      });

      const count = allEntries.length;
      showStatusBarMessage(
        count === 0
          ? "$(copy) Week copied (empty)"
          : `$(copy) ${count} ${count === 1 ? "entry" : "entries"} copied`,
        2000
      );
    })
  );

  // Paste time entries
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "redmyne.pasteTimeEntries",
      async (node?: DayGroupNode | WeekGroupNode) => {
        const clipboard = getClipboard();
        if (!clipboard || clipboard.entries.length === 0) {
          vscode.window.showInformationMessage("Clipboard is empty");
          return;
        }

        const server = deps.getServer();
        if (!server) {
          vscode.window.showErrorMessage("No Redmine server configured");
          return;
        }

        // Determine target type and date
        const isDayTarget = node && "_date" in node && !!node._date;
        const isWeekTarget = node && "_weekStart" in node && !!node._weekStart;

        // Default to "This Week" if no node (toolbar invocation)
        let targetKind: "day" | "week";
        let targetDate: string | undefined;
        let targetWeekStart: string | undefined;

        if (isDayTarget) {
          targetKind = "day";
          targetDate = (node as DayGroupNode)._date;
        } else if (isWeekTarget) {
          targetKind = "week";
          targetWeekStart = (node as WeekGroupNode)._weekStart;
        } else {
          // Toolbar: default to current week
          targetKind = "week";
          targetWeekStart = getWeekStart();
        }

        // Get schedule config
        const config = vscode.workspace.getConfiguration("redmyne.workingHours");
        const schedule = config.get<WeeklySchedule>("weeklySchedule", DEFAULT_WEEKLY_SCHEDULE);
        const overrides = deps.getMonthlySchedules?.() ?? {};

        // Calculate target dates
        const targetDates = calculatePasteTargetDates(
          clipboard,
          targetKind,
          targetDate,
          targetWeekStart,
          schedule,
          overrides
        );

        if (targetDates === null) {
          vscode.window.showErrorMessage("Cannot paste week to a single day");
          return;
        }

        if (targetDates.length === 0) {
          vscode.window.showInformationMessage("No working days in target range");
          return;
        }

        // Calculate total entries to create
        let totalEntries = 0;
        if (clipboard.kind === "week" && targetKind === "week" && clipboard.weekMap) {
          // Week→Week: entries per mapped day
          for (const date of targetDates) {
            const dayEntries = getEntriesForTargetDate(clipboard, date, targetWeekStart!);
            totalEntries += dayEntries.length;
          }
        } else {
          // Entry/Day→Day or Entry/Day→Week: all entries for each target date
          totalEntries = clipboard.entries.length * targetDates.length;
        }

        if (totalEntries === 0) {
          vscode.window.showInformationMessage("No entries to paste");
          return;
        }

        // Check for closed issues in batch
        const issueIds = clipboard.entries.map((e) => e.issue_id);
        const closedConfirmed = await confirmLogTimeOnClosedIssues(server, issueIds);
        if (!closedConfirmed) return;

        // Confirmation
        const confirm = await vscode.window.showInformationMessage(
          `Create ${totalEntries} time ${totalEntries === 1 ? "entry" : "entries"}?`,
          { modal: true },
          "Create"
        );
        if (confirm !== "Create") return;

        // Execute paste with progress
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Creating time entries..." },
          async (progress) => {
            let created = 0;
            const errors: string[] = [];

            for (const date of targetDates) {
              // Get entries for this date
              const entriesToCreate =
                clipboard.kind === "week" && targetKind === "week"
                  ? getEntriesForTargetDate(clipboard, date, targetWeekStart!)
                  : clipboard.entries;

              for (const entry of entriesToCreate) {
                try {
                  await server.addTimeEntry(
                    entry.issue_id,
                    entry.activity_id,
                    entry.hours,
                    entry.comments,
                    date,
                    entry.custom_fields
                  );
                  created++;
                  progress.report({
                    increment: (1 / totalEntries) * 100,
                    message: `${created}/${totalEntries}`,
                  });
                } catch (error) {
                  errors.push(`${date}: ${error}`);
                }
              }
            }

            if (errors.length > 0) {
              vscode.window.showWarningMessage(
                `Created ${created}/${totalEntries} entries. ${errors.length} failed.`
              );
            } else {
              showStatusBarMessage(`$(check) Created ${created} entries`, 2000);
            }
          }
        );

        deps.refreshTree();
        // Refresh Gantt if open
        vscode.commands.executeCommand("redmyne.refreshGanttData");
      }
    )
  );
}
