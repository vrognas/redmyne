/**
 * Time Entry Commands
 * Commands for managing time entries (edit, delete, open in browser)
 */

import * as vscode from "vscode";
import type { IRedmineServer } from "../redmine/redmine-server-interface";
import { formatHoursAsHHMM, parseTimeInput } from "../utilities/time-input";
import { showStatusBarMessage } from "../utilities/status-bar";
import { validateDateInput } from "../utilities/date-picker";
import { quickLogTime } from "./quick-log-time";
import { pickIssue } from "../utilities/issue-picker";
import {
  setClipboard,
  getClipboard,
  ClipboardEntry,
  TimeEntryClipboard,
  calculatePasteTargetDates,
  getEntriesForTargetDate,
  toClipboardEntry,
  isDraftEntry,
} from "../utilities/time-entry-clipboard";
import { parseLocalDate, getWeekStart, formatLocalDate, getISOWeekNumber } from "../utilities/date-utils";
import { differenceInCalendarDays, addDays } from "date-fns";
import { getWeeklySchedule } from "../utilities/flexibility-calculator";
import { MonthlyScheduleOverrides } from "../utilities/monthly-schedule";
import { pickCustomFields, TimeEntryCustomFieldValue } from "../utilities/custom-field-picker";
import { confirmLogTimeOnClosedIssues } from "../utilities/closed-issue-guard";
import { errorToString } from "../utilities/error-feedback";
import {
  getConfiguredServerUrlOrShowError,
  getIssueIdOrShowError,
  getServerOrShowError,
} from "./command-guards";
import { buildIssueUrl } from "./command-urls";

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

/** Cached time entry shape shared by day/week group nodes */
interface CachedEntry {
  id?: number;
  issue_id?: number;
  issue?: { id: number; subject?: string };
  project?: { id: number; name?: string };
  activity_id?: number;
  activity?: { id: number; name?: string };
  hours: string;
  comments: string;
  spent_on?: string;
  custom_fields?: Array<{ id: number; name?: string; value: unknown }>;
}

/** Day group node from tree view */
interface DayGroupNode {
  _date?: string; // YYYY-MM-DD
  _cachedEntries?: CachedEntry[];
}

/** Week group node from tree view */
interface WeekGroupNode {
  _weekStart?: string; // YYYY-MM-DD (Monday)
  _cachedEntries?: CachedEntry[];
}

export interface TimeEntryCommandDeps {
  getServer: () => IRedmineServer | undefined;
  refreshTree: () => void;
  getMonthlySchedules?: () => MonthlyScheduleOverrides;
  /** Returns currently focused tree node — used as fallback when commands are invoked via keybinding */
  getSelectedNode?: () => SelectableNode | undefined;
  /** True when draft mode is active — paste queues drafts instead of committing to the server */
  isDraftMode?: () => boolean;
}

/**
 * Structural shape covering any tree node that can be the target of copy/paste.
 * All fields optional — commands check which fields are present to dispatch.
 */
export interface SelectableNode {
  _entry?: TimeEntryNode["_entry"];
  _date?: string;
  _weekStart?: string;
  _cachedEntries?: CachedEntry[];
  contextValue?: string;
}

function getTimeEntryOrShowError(
  node: TimeEntryNode | undefined
): NonNullable<TimeEntryNode["_entry"]> | undefined {
  const entry = node?._entry;
  if (!entry) {
    vscode.window.showErrorMessage("No time entry selected");
    return undefined;
  }
  return entry;
}

/** Max entry lines shown per section in the paste confirm dialog before "... N more". */
const PASTE_CONFIRM_ENTRY_CAP = 5;

/** Format a YYYY-MM-DD string as a short human label, e.g. "Mon, Mar 16". */
function formatDayLabel(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatClipboardEntryLine(e: ClipboardEntry): string {
  const label = e.issueSubject ? `#${e.issue_id} ${e.issueSubject}` : `#${e.issue_id}`;
  const activity = e.activityName ? ` [${e.activityName}]` : "";
  return `${label}${activity} — ${formatHoursAsHHMM(parseFloat(e.hours))}`;
}

export interface PasteConfirmContext {
  clipboard: TimeEntryClipboard;
  targetKind: "day" | "week";
  targetDate?: string;
  targetWeekStart?: string;
  targetDates: string[];
  isWeekToWeekPaste: boolean;
  targetWeekStartForPaste: string;
  /** Non-draft entries already present on the target day (day paste) or whole week (week paste). */
  existingEntries: CachedEntry[];
}

/**
 * Build the lines for the paste confirmation dialog. Scenario-aware so the user
 * sees what lands where before committing:
 * - Entry/Day → Day: flat entry list + what's already on that day
 * - Entry/Day → Week: entry list with an "× working days" multiplier note
 * - Week → Week: per-day breakdown of which entries map to which day
 * Week targets also summarise entries already in the week to flag duplicates.
 */
export function buildPasteConfirmLines(ctx: PasteConfirmContext): string[] {
  const {
    clipboard,
    targetKind,
    targetDate,
    targetWeekStart,
    targetDates,
    isWeekToWeekPaste,
    targetWeekStartForPaste,
    existingEntries,
  } = ctx;
  const lines: string[] = [];
  const weekNum = targetWeekStart
    ? getISOWeekNumber(new Date(targetWeekStart + "T00:00:00"))
    : undefined;

  // ---- What's being pasted ----
  if (targetKind === "day" && targetDate) {
    lines.push(`Paste to ${formatDayLabel(targetDate)}:`);
    pushEntryLines(lines, clipboard.entries);
  } else if (isWeekToWeekPaste) {
    lines.push(`Paste to Week ${weekNum ?? "?"}:`);
    for (const date of targetDates) {
      const dayEntries = getEntriesForTargetDate(clipboard, date, targetWeekStartForPaste);
      if (dayEntries.length === 0) continue;
      lines.push(`  ${formatDayLabel(date)}:`);
      pushEntryLines(lines, dayEntries, "    ");
    }
  } else {
    // Entry/Day → Week: the same entries are created on each working day
    const dayCount = targetDates.length;
    lines.push(`Paste to Week ${weekNum ?? "?"} — on each of ${dayCount} working ${dayCount === 1 ? "day" : "days"}:`);
    pushEntryLines(lines, clipboard.entries);
    lines.push(`  = ${clipboard.entries.length * dayCount} entries total`);
  }

  // ---- Existing entries on the target ----
  const existing = existingEntries.filter((e) => !isDraftEntry(e));
  if (existing.length === 0) return lines;

  if (targetKind === "day") {
    const total = existing.reduce((sum, e) => sum + parseFloat(e.hours), 0);
    lines.push("");
    lines.push(`Already on this day (${formatHoursAsHHMM(total)}):`);
    for (const e of existing.slice(0, PASTE_CONFIRM_ENTRY_CAP)) {
      const id = e.issue_id ?? e.issue?.id ?? 0;
      const label = e.issue?.subject ? `#${id} ${e.issue.subject}` : `#${id}`;
      lines.push(`  ${label} — ${formatHoursAsHHMM(parseFloat(e.hours))}`);
    }
    if (existing.length > PASTE_CONFIRM_ENTRY_CAP) {
      lines.push(`  ... and ${existing.length - PASTE_CONFIRM_ENTRY_CAP} more`);
    }
  } else {
    // Week target: compact per-day summary so duplicates are visible at a glance
    const byDate = new Map<string, CachedEntry[]>();
    for (const e of existing) {
      const date = e.spent_on ?? "unknown";
      const bucket = byDate.get(date) ?? [];
      bucket.push(e);
      byDate.set(date, bucket);
    }
    lines.push("");
    lines.push("Already in target week:");
    for (const date of [...byDate.keys()].sort()) {
      const dayEntries = byDate.get(date)!;
      const total = dayEntries.reduce((sum, e) => sum + parseFloat(e.hours), 0);
      const label = date === "unknown" ? "(no date)" : formatDayLabel(date);
      lines.push(`  ${label} — ${dayEntries.length} ${dayEntries.length === 1 ? "entry" : "entries"}, ${formatHoursAsHHMM(total)}`);
    }
  }

  return lines;

  function pushEntryLines(target: string[], entries: ClipboardEntry[], indent = "  "): void {
    for (const e of entries.slice(0, PASTE_CONFIRM_ENTRY_CAP)) {
      target.push(`${indent}${formatClipboardEntryLine(e)}`);
    }
    if (entries.length > PASTE_CONFIRM_ENTRY_CAP) {
      target.push(`${indent}... and ${entries.length - PASTE_CONFIRM_ENTRY_CAP} more`);
    }
  }
}

/** One time entry to create on one date — the unit of work for paste + retry. */
export interface PasteWorkItem {
  date: string;
  entry: ClipboardEntry;
}

/**
 * Flatten a paste into a list of (date, entry) work items — the single source
 * of truth for the total count, execution, and retry. Week→week paste maps each
 * target day to its source-day entries; every other shape applies all clipboard
 * entries to every target date.
 */
export function buildPasteWorkItems(
  clipboard: TimeEntryClipboard,
  targetDates: string[],
  isWeekToWeekPaste: boolean,
  targetWeekStartForPaste: string
): PasteWorkItem[] {
  const items: PasteWorkItem[] = [];
  for (const date of targetDates) {
    const entries = isWeekToWeekPaste
      ? getEntriesForTargetDate(clipboard, date, targetWeekStartForPaste)
      : clipboard.entries;
    for (const entry of entries) {
      items.push({ date, entry });
    }
  }
  return items;
}

/**
 * Create one time entry per work item, sequentially. Returns the success count
 * and the items that failed, so the caller can retry just those without
 * duplicating entries that already succeeded.
 *
 * Sequential by design: in draft mode every addTimeEntry serializes on the
 * draft-queue persist lock (concurrency buys nothing); in direct mode it avoids
 * hammering the Redmine server with parallel writes.
 */
async function executePaste(
  server: IRedmineServer,
  items: PasteWorkItem[],
  onProgress: (done: number) => void
): Promise<{ created: number; failures: PasteWorkItem[]; firstError?: string }> {
  let created = 0;
  let firstError: string | undefined;
  const failures: PasteWorkItem[] = [];
  for (const item of items) {
    try {
      await server.addTimeEntry(
        item.entry.issue_id,
        item.entry.activity_id,
        item.entry.hours,
        item.entry.comments,
        item.date,
        item.entry.custom_fields
      );
      created++;
      onProgress(created);
    } catch (error) {
      firstError ??= errorToString(error);
      failures.push(item);
    }
  }
  return { created, failures, firstError };
}

/**
 * Fetch all time entries for the full Mon–Sun week beginning at weekStart.
 * Copy/paste need the whole week, but the tree's current-week cache stops at
 * today (it drives the in-progress display), so both refetch through here when
 * the target is the current week.
 */
async function fetchFullWeekEntries(
  server: IRedmineServer,
  weekStart: string
): Promise<CachedEntry[]> {
  const weekEnd = formatLocalDate(addDays(parseLocalDate(weekStart), 6));
  const result = await server.getTimeEntries({ from: weekStart, to: weekEnd });
  return result.time_entries;
}

/**
 * Resolve the paste target from the focused node: a day node → that day, a week
 * node → that week, no node (toolbar) → the supplied fallback week. Kept pure —
 * the fallback is passed in rather than read from the clock — so it's unit-testable.
 */
export function resolvePasteTarget(
  resolved: SelectableNode | undefined,
  fallbackWeekStart: string
): { targetKind: "day" | "week"; targetDate?: string; targetWeekStart?: string } {
  if (resolved?._date) {
    return { targetKind: "day", targetDate: resolved._date };
  }
  if (resolved?._weekStart) {
    return { targetKind: "week", targetWeekStart: resolved._weekStart };
  }
  return { targetKind: "week", targetWeekStart: fallbackWeekStart };
}

/**
 * Run a paste, then offer to retry just the failed items so a mid-batch error
 * doesn't force re-pasting (and duplicating) the entries that already succeeded.
 * The success total accumulates across retry attempts.
 */
async function runPasteWithRetry(
  server: IRedmineServer,
  workItems: PasteWorkItem[],
  draftMode: boolean,
  refreshTree: () => void
): Promise<void> {
  const verb = draftMode ? "Queued" : "Created";
  const noun = (n: number) => (n === 1 ? "entry" : "entries");

  const runPaste = (items: PasteWorkItem[]) =>
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: draftMode ? "Queueing time entries..." : "Creating time entries...",
      },
      (progress) =>
        executePaste(server, items, (done) =>
          progress.report({
            increment: (1 / items.length) * 100,
            message: `${done}/${items.length}`,
          })
        )
    );

  let pending = workItems;
  let totalCreated = 0;
  for (;;) {
    const { created, failures, firstError } = await runPaste(pending);
    totalCreated += created;
    refreshTree();
    // Refresh Gantt if open
    vscode.commands.executeCommand("redmyne.refreshGanttData");

    if (failures.length === 0) {
      const suffix = draftMode ? " to draft" : "";
      showStatusBarMessage(
        `$(check) ${verb} ${totalCreated} ${noun(totalCreated)}${suffix}`,
        2000
      );
      return;
    }

    const reason = firstError ? ` First error: ${firstError}` : "";
    const choice = await vscode.window.showWarningMessage(
      `${verb} ${created}/${pending.length} ${noun(pending.length)}. ${failures.length} failed.${reason}`,
      "Retry Failed"
    );
    if (choice !== "Retry Failed") return;
    pending = failures;
  }
}

function getTimeEntryWithIdOrShowError(
  node: TimeEntryNode | undefined
): (NonNullable<TimeEntryNode["_entry"]> & { id: number }) | undefined {
  const entry = getTimeEntryOrShowError(node); // shows its own error when missing
  if (!entry) return undefined;
  if (!entry.id) {
    vscode.window.showErrorMessage("Time entry has no id");
    return undefined;
  }
  return entry as NonNullable<TimeEntryNode["_entry"]> & { id: number };
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

      const resolvedIssueId = getIssueIdOrShowError({ id: issueId });
      if (!resolvedIssueId) return;

      const url = getConfiguredServerUrlOrShowError("Redmine URL not configured");
      if (!url) return;

      await vscode.env.openExternal(vscode.Uri.parse(buildIssueUrl(url, resolvedIssueId)));
    })
  );

  // Edit time entry
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.editTimeEntry", async (node: TimeEntryNode) => {
      const entry = getTimeEntryWithIdOrShowError(node);
      if (!entry) return;

      const server = getServerOrShowError(deps.getServer);
      if (!server) return;

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
      const isDraft = isDraftEntry(entry);
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
          if (!entry.issue?.id) {
            vscode.window.showErrorMessage("No issue linked to this time entry");
            return;
          }
          // Need to fetch activities for this issue's project
          const issueResult = await server.getIssueById(entry.issue.id);
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
      const entry = getTimeEntryWithIdOrShowError(node);
      if (!entry) return;

      const server = getServerOrShowError(deps.getServer);
      if (!server) return;

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
      const server = getServerOrShowError(deps.getServer);
      if (!server) return;

      const config = vscode.workspace.getConfiguration("redmyne");
      const url = config.get<string>("serverUrl") || "";

      await quickLogTime(
        { server, config: { ...config, serverUrl: url } },
        node?._date
      );
    })
  );

  // Copy single time entry
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.copyTimeEntry", (node?: TimeEntryNode) => {
      const resolved = node ?? deps.getSelectedNode?.();
      const entry = getTimeEntryOrShowError(resolved);
      if (!entry) return;

      setClipboard({
        kind: "entry",
        entries: [toClipboardEntry(entry)],
        sourceDate: entry.spent_on,
      });

      showStatusBarMessage("$(copy) Copied", 2000);
    })
  );

  // Copy all entries from a day
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.copyDayTimeEntries", (node?: DayGroupNode) => {
      const resolved = node ?? deps.getSelectedNode?.();
      const entries = resolved?._cachedEntries;
      if (!entries || entries.length === 0) {
        // Don't clobber a previously-copied clipboard with an empty day —
        // an empty clipboard can't be pasted, so this would be a dead end.
        showStatusBarMessage("$(info) Nothing to copy — day is empty", 2000);
        return;
      }

      // Filter out drafts (negative IDs)
      const clipEntries: ClipboardEntry[] = entries
        .filter((e) => !isDraftEntry(e))
        .map(toClipboardEntry);

      setClipboard({
        kind: "day",
        entries: clipEntries,
        sourceDate: resolved._date,
      });

      const count = clipEntries.length;
      showStatusBarMessage(`$(copy) ${count} ${count === 1 ? "entry" : "entries"} copied`, 2000);
    })
  );

  // Copy all entries from a week
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.copyWeekTimeEntries", async (node?: WeekGroupNode) => {
      const resolved = node ?? deps.getSelectedNode?.();
      const currentWeekStart = getWeekStart();
      const weekStart = resolved?._weekStart ?? currentWeekStart;

      // The current week's cached entries stop at today (they drive the
      // in-progress display), and a toolbar invocation has no node at all.
      // Refetch the full Mon–Sun week so copy captures future-dated entries too;
      // past-week nodes already carry the complete week in _cachedEntries.
      let entries = resolved?._cachedEntries;
      if (!entries || weekStart === currentWeekStart) {
        const server = getServerOrShowError(deps.getServer);
        if (!server) return;
        try {
          entries = await fetchFullWeekEntries(server, weekStart);
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
          if (isDraftEntry(e)) continue;

          const clipEntry = toClipboardEntry(e);
          allEntries.push(clipEntry);

          // Calculate day offset from Monday (calendar-day diff, DST-safe)
          if (e.spent_on) {
            const entryDate = parseLocalDate(e.spent_on);
            const dayOffset = differenceInCalendarDays(entryDate, monday);
            if (dayOffset >= 0 && dayOffset < 7) {
              if (!weekMap.has(dayOffset)) {
                weekMap.set(dayOffset, []);
              }
              weekMap.get(dayOffset)!.push(clipEntry);
            }
          }
        }
      }

      if (allEntries.length === 0) {
        // Don't clobber a previously-copied clipboard with an empty week —
        // an empty clipboard can't be pasted, so this would be a dead end.
        showStatusBarMessage("$(info) Nothing to copy — week is empty", 2000);
        return;
      }

      setClipboard({
        kind: "week",
        entries: allEntries,
        weekMap,
        sourceWeekStart: weekStart,
      });

      const count = allEntries.length;
      showStatusBarMessage(
        `$(copy) ${count} ${count === 1 ? "entry" : "entries"} copied`,
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

        const server = getServerOrShowError(deps.getServer);
        if (!server) return;

        const resolved = node ?? deps.getSelectedNode?.();
        const currentWeekStart = getWeekStart();
        // Day node → that day; week node → that week; no node (toolbar) → current week.
        const { targetKind, targetDate, targetWeekStart } = resolvePasteTarget(
          resolved,
          currentWeekStart
        );

        // Get schedule config
        const schedule = getWeeklySchedule();
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

        const isWeekToWeekPaste =
          clipboard.kind === "week" && targetKind === "week" && Boolean(clipboard.weekMap);
        let targetWeekStartForPaste = "";
        if (isWeekToWeekPaste) {
          if (!targetWeekStart) {
            vscode.window.showErrorMessage("Could not determine target week");
            return;
          }
          targetWeekStartForPaste = targetWeekStart;
        }

        // Flatten into (date, entry) work items — the unit of work for the
        // count, execution, and targeted retry.
        const workItems = buildPasteWorkItems(
          clipboard,
          targetDates,
          isWeekToWeekPaste,
          targetWeekStartForPaste
        );

        if (workItems.length === 0) {
          vscode.window.showInformationMessage("No entries to paste");
          return;
        }

        // Existing entries on the target — day node carries that day's, week node
        // the whole week's (both on _cachedEntries). For a current-week target the
        // cache stops at today, so refetch the full week (best-effort) to keep the
        // "already in week" duplicate summary complete for future days too.
        let existingEntries: CachedEntry[] = resolved?._cachedEntries ?? [];
        if (targetKind === "week" && targetWeekStart === currentWeekStart) {
          try {
            existingEntries = await fetchFullWeekEntries(server, targetWeekStart);
          } catch {
            /* keep the cached fallback — the summary is only informational */
          }
        }

        const confirmLines = buildPasteConfirmLines({
          clipboard,
          targetKind,
          targetDate,
          targetWeekStart,
          targetDates,
          isWeekToWeekPaste,
          targetWeekStartForPaste,
          existingEntries,
        });

        const confirm = await vscode.window.showInformationMessage(
          confirmLines.join("\n"),
          { modal: true },
          "Create"
        );
        if (confirm !== "Create") return;

        // Check for closed issues — only after the user commits to pasting, so a
        // cancelled paste doesn't pay for the issue-status lookup. A lookup
        // failure (deleted issue, network blip) must not silently abort a
        // confirmed paste — proceed and let addTimeEntry surface real errors.
        const issueIds = clipboard.entries.map((e) => e.issue_id);
        let closedConfirmed = true;
        try {
          closedConfirmed = await confirmLogTimeOnClosedIssues(server, issueIds);
        } catch {
          // proceed: the guard is best-effort advice, not a gate
        }
        if (!closedConfirmed) return;

        // In draft mode the server wrapper queues entries instead of committing
        // them, so phrase progress/results as "queued" rather than "created".
        const draftMode = deps.isDraftMode?.() ?? false;
        await runPasteWithRetry(server, workItems, draftMode, deps.refreshTree);
      }
    )
  );

  // Copy dispatcher — bound to Ctrl/Cmd+C. VS Code's `viewItem` context key only
  // applies in menu when-clauses, so a single keybinding inspects the focused
  // tree node's contextValue and routes to the right command.
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.copyFromTimeEntriesPane", async () => {
      const node = deps.getSelectedNode?.();
      const cv = node?.contextValue;
      if (!cv) return;
      if (cv === "time-entry-draft") return;
      if (cv.startsWith("time-entry")) {
        await vscode.commands.executeCommand("redmyne.copyTimeEntry", node);
      } else if (cv === "day-group") {
        await vscode.commands.executeCommand("redmyne.copyDayTimeEntries", node);
      } else if (cv === "week-group") {
        await vscode.commands.executeCommand("redmyne.copyWeekTimeEntries", node);
      }
    })
  );
}
