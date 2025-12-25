/**
 * Monthly Working Hours Schedule
 *
 * Supports different working hour schedules per month.
 * Use case: FTE varies monthly (e.g., 100% in Jan, 50% in Feb)
 * and hours can be distributed unevenly within a week.
 */

import * as vscode from "vscode";
import { WeeklySchedule } from "./flexibility-calculator";

/** Storage key for monthly schedule overrides */
export const MONTHLY_SCHEDULES_KEY = "redmine.monthlySchedules";

/** Month key format: "YYYY-MM" */
export type MonthKey = string;

/** Monthly schedule overrides stored in globalState */
export type MonthlyScheduleOverrides = Record<MonthKey, WeeklySchedule>;

/**
 * Get month key from a Date object
 * @returns "YYYY-MM" format
 */
export function getMonthKey(date: Date): MonthKey {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Parse month key to year and month
 */
export function parseMonthKey(key: MonthKey): { year: number; month: number } {
  const [year, month] = key.split("-").map(Number);
  return { year, month };
}

/**
 * Get schedule for a specific month, falling back to default
 */
export function getScheduleForMonth(
  monthKey: MonthKey,
  overrides: MonthlyScheduleOverrides,
  defaultSchedule: WeeklySchedule
): WeeklySchedule {
  return overrides[monthKey] ?? defaultSchedule;
}

/**
 * Get schedule for a specific date
 */
export function getScheduleForDate(
  date: Date,
  overrides: MonthlyScheduleOverrides,
  defaultSchedule: WeeklySchedule
): WeeklySchedule {
  const monthKey = getMonthKey(date);
  return getScheduleForMonth(monthKey, overrides, defaultSchedule);
}

/**
 * Count available hours between dates using monthly schedules
 * Handles date ranges spanning multiple months correctly
 */
export function countAvailableHoursMonthly(
  start: Date,
  end: Date,
  overrides: MonthlyScheduleOverrides,
  defaultSchedule: WeeklySchedule
): number {
  let hours = 0;
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const endDate = new Date(end);
  endDate.setHours(0, 0, 0, 0);

  // Track current month to avoid repeated lookups
  let currentMonthKey = getMonthKey(current);
  let currentSchedule = getScheduleForMonth(
    currentMonthKey,
    overrides,
    defaultSchedule
  );

  while (current <= endDate) {
    // Check if month changed
    const monthKey = getMonthKey(current);
    if (monthKey !== currentMonthKey) {
      currentMonthKey = monthKey;
      currentSchedule = getScheduleForMonth(
        monthKey,
        overrides,
        defaultSchedule
      );
    }

    const dayName = getDayName(current);
    hours += currentSchedule[dayName];
    current.setDate(current.getDate() + 1);
  }

  return hours;
}

/**
 * Count working days between dates using monthly schedules
 */
export function countWorkingDaysMonthly(
  start: Date,
  end: Date,
  overrides: MonthlyScheduleOverrides,
  defaultSchedule: WeeklySchedule
): number {
  let count = 0;
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const endDate = new Date(end);
  endDate.setHours(0, 0, 0, 0);

  let currentMonthKey = getMonthKey(current);
  let currentSchedule = getScheduleForMonth(
    currentMonthKey,
    overrides,
    defaultSchedule
  );

  while (current <= endDate) {
    const monthKey = getMonthKey(current);
    if (monthKey !== currentMonthKey) {
      currentMonthKey = monthKey;
      currentSchedule = getScheduleForMonth(
        monthKey,
        overrides,
        defaultSchedule
      );
    }

    const dayName = getDayName(current);
    if (currentSchedule[dayName] > 0) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }

  return count;
}

/**
 * Get hours for a specific date using monthly schedules
 */
export function getHoursForDateMonthly(
  date: Date,
  overrides: MonthlyScheduleOverrides,
  defaultSchedule: WeeklySchedule
): number {
  const schedule = getScheduleForDate(date, overrides, defaultSchedule);
  const dayName = getDayName(date);
  return schedule[dayName];
}

/**
 * Calculate total working hours for a given month
 */
export function calculateMonthlyTotal(
  monthKey: MonthKey,
  schedule: WeeklySchedule
): number {
  const { year, month } = parseMonthKey(monthKey);

  // Get first and last day of month
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0); // Day 0 of next month = last day of this month

  let total = 0;
  const current = new Date(firstDay);

  while (current <= lastDay) {
    const dayName = getDayName(current);
    total += schedule[dayName];
    current.setDate(current.getDate() + 1);
  }

  return total;
}

/**
 * Get day name from Date object
 */
function getDayName(date: Date): keyof WeeklySchedule {
  const days: (keyof WeeklySchedule)[] = [
    "Sun",
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
    "Sat",
  ];
  return days[date.getDay()];
}

/**
 * Load monthly schedule overrides from globalState
 */
export function loadMonthlySchedules(
  globalState: vscode.Memento
): MonthlyScheduleOverrides {
  return globalState.get<MonthlyScheduleOverrides>(MONTHLY_SCHEDULES_KEY, {});
}

/**
 * Save monthly schedule overrides to globalState
 */
export async function saveMonthlySchedules(
  globalState: vscode.Memento,
  overrides: MonthlyScheduleOverrides
): Promise<void> {
  await globalState.update(MONTHLY_SCHEDULES_KEY, overrides);
}

/**
 * Format month key for display (e.g., "2025-01" -> "January 2025")
 */
export function formatMonthKeyDisplay(monthKey: MonthKey): string {
  const { year, month } = parseMonthKey(monthKey);
  const date = new Date(year, month - 1, 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/**
 * Get list of months for selection (current + next 6 + past 3)
 */
export function getMonthOptions(): { key: MonthKey; label: string }[] {
  const options: { key: MonthKey; label: string }[] = [];
  const now = new Date();

  // Past 3 months
  for (let i = 3; i >= 1; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    options.push({
      key: getMonthKey(date),
      label: formatMonthKeyDisplay(getMonthKey(date)),
    });
  }

  // Current month
  options.push({
    key: getMonthKey(now),
    label: `${formatMonthKeyDisplay(getMonthKey(now))} (current)`,
  });

  // Next 6 months
  for (let i = 1; i <= 6; i++) {
    const date = new Date(now.getFullYear(), now.getMonth() + i, 1);
    options.push({
      key: getMonthKey(date),
      label: formatMonthKeyDisplay(getMonthKey(date)),
    });
  }

  return options;
}

/**
 * Format weekly schedule for display
 */
export function formatScheduleDisplay(schedule: WeeklySchedule): string {
  const parts: string[] = [];
  const days: (keyof WeeklySchedule)[] = [
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
    "Sat",
    "Sun",
  ];

  for (const day of days) {
    if (schedule[day] > 0) {
      parts.push(`${day}: ${schedule[day]}h`);
    }
  }

  if (parts.length === 0) {
    return "No working days";
  }

  return parts.join(", ");
}

/**
 * Calculate weekly total hours
 */
export function calculateWeeklyTotal(schedule: WeeklySchedule): number {
  return (
    schedule.Mon +
    schedule.Tue +
    schedule.Wed +
    schedule.Thu +
    schedule.Fri +
    schedule.Sat +
    schedule.Sun
  );
}

/**
 * Create schedule from hours per day preset
 */
export function createScheduleFromPreset(
  hoursPerDay: number,
  workingDays: (keyof WeeklySchedule)[] = ["Mon", "Tue", "Wed", "Thu", "Fri"]
): WeeklySchedule {
  const schedule: WeeklySchedule = {
    Mon: 0,
    Tue: 0,
    Wed: 0,
    Thu: 0,
    Fri: 0,
    Sat: 0,
    Sun: 0,
  };

  for (const day of workingDays) {
    schedule[day] = hoursPerDay;
  }

  return schedule;
}
