/**
 * Time Entry Clipboard
 *
 * Manages clipboard state for copy/paste of time entries.
 * Supports copying single entries, days, or weeks.
 */

import * as vscode from "vscode";
import { WeeklySchedule, getDayName } from "./flexibility-calculator";
import { MonthlyScheduleOverrides, getMonthKey } from "./monthly-schedule";
import { formatLocalDate, parseLocalDate } from "./date-utils";

export type ClipboardKind = "entry" | "day" | "week";

export interface ClipboardEntry {
  issue_id: number;
  activity_id: number;
  hours: string;
  comments: string;
  project_id?: number;
}

export interface TimeEntryClipboard {
  kind: ClipboardKind;
  entries: ClipboardEntry[];
  /** For week: map of day-of-week (0=Mon ISO) to entries */
  weekMap?: Map<number, ClipboardEntry[]>;
  /** For entry/day */
  sourceDate?: string;
  /** For week */
  sourceWeekStart?: string;
}

// Module-level clipboard state
let clipboard: TimeEntryClipboard | null = null;

/**
 * Store clipboard data
 */
export function setClipboard(data: TimeEntryClipboard): void {
  clipboard = data;
  updateClipboardContext();
}

/**
 * Get current clipboard data
 */
export function getClipboard(): TimeEntryClipboard | null {
  return clipboard;
}

/**
 * Clear clipboard data
 */
export function clearClipboard(): void {
  clipboard = null;
  updateClipboardContext();
}

/**
 * Update VS Code context for conditional menu visibility
 */
export function updateClipboardContext(): void {
  const clipboardType = clipboard?.kind ?? "";
  vscode.commands.executeCommand(
    "setContext",
    "redmyne:timeEntryClipboardType",
    clipboardType
  );
}

/**
 * Get ISO day-of-week (0=Monday, 6=Sunday) from Date
 */
export function getISODayOfWeek(date: Date): number {
  const day = date.getDay();
  return day === 0 ? 6 : day - 1; // Convert Sun=0..Sat=6 to Mon=0..Sun=6
}

/**
 * Get schedule for a specific date, respecting monthly overrides
 */
function getScheduleForDate(
  date: Date,
  defaultSchedule: WeeklySchedule,
  overrides: MonthlyScheduleOverrides
): WeeklySchedule {
  const monthKey = getMonthKey(date);
  return overrides[monthKey] ?? defaultSchedule;
}

/**
 * Check if a date is a working day
 */
function isWorkingDay(
  date: Date,
  defaultSchedule: WeeklySchedule,
  overrides: MonthlyScheduleOverrides
): boolean {
  const schedule = getScheduleForDate(date, defaultSchedule, overrides);
  const dayName = getDayName(date);
  return schedule[dayName] > 0;
}

/**
 * Get all working days in a week (Mon-Sun) starting from weekStart
 * @returns Array of date strings (YYYY-MM-DD)
 */
export function getWorkingDaysInWeek(
  weekStart: string,
  defaultSchedule: WeeklySchedule,
  overrides: MonthlyScheduleOverrides
): string[] {
  const workingDays: string[] = [];
  const monday = parseLocalDate(weekStart);

  for (let i = 0; i < 7; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);

    if (isWorkingDay(day, defaultSchedule, overrides)) {
      workingDays.push(formatLocalDate(day));
    }
  }

  return workingDays;
}

/**
 * Calculate target dates for paste operation
 *
 * @param clipboard Source clipboard data
 * @param targetKind Target type (day or week)
 * @param targetDate Target date (for day paste)
 * @param targetWeekStart Target week Monday (for week paste)
 * @returns Array of target dates, or null if operation is disallowed
 */
export function calculatePasteTargetDates(
  clipboard: TimeEntryClipboard,
  targetKind: "day" | "week",
  targetDate: string | undefined,
  targetWeekStart: string | undefined,
  defaultSchedule: WeeklySchedule,
  overrides: MonthlyScheduleOverrides
): string[] | null {
  // week → day is disallowed
  if (clipboard.kind === "week" && targetKind === "day") {
    return null;
  }

  // Entry or Day → Day: single target date
  if (targetKind === "day" && targetDate) {
    return [targetDate];
  }

  // Entry or Day → Week: all working days in target week
  if (
    (clipboard.kind === "entry" || clipboard.kind === "day") &&
    targetKind === "week" &&
    targetWeekStart
  ) {
    return getWorkingDaysInWeek(targetWeekStart, defaultSchedule, overrides);
  }

  // Week → Week: map by day-of-week
  if (
    clipboard.kind === "week" &&
    targetKind === "week" &&
    targetWeekStart &&
    clipboard.weekMap
  ) {
    const targetMonday = parseLocalDate(targetWeekStart);
    const targetDates: string[] = [];

    // Only include days that have entries in the source weekMap
    for (const [dayOffset] of clipboard.weekMap) {
      const targetDay = new Date(targetMonday);
      targetDay.setDate(targetMonday.getDate() + dayOffset);
      targetDates.push(formatLocalDate(targetDay));
    }

    return targetDates.sort();
  }

  return [];
}

/**
 * Get entries for a specific target date during week→week paste
 */
export function getEntriesForTargetDate(
  clipboard: TimeEntryClipboard,
  targetDate: string,
  targetWeekStart: string
): ClipboardEntry[] {
  if (clipboard.kind !== "week" || !clipboard.weekMap) {
    return clipboard.entries;
  }

  const targetDay = parseLocalDate(targetDate);
  const targetMonday = parseLocalDate(targetWeekStart);
  const dayOffset = Math.floor(
    (targetDay.getTime() - targetMonday.getTime()) / (1000 * 60 * 60 * 24)
  );

  return clipboard.weekMap.get(dayOffset) ?? [];
}
