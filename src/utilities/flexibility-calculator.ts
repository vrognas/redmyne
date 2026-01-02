/**
 * Flexibility Calculator for Issue Timeline & Progress
 *
 * Calculates dual flexibility scores:
 * - Initial: Planning quality (how much buffer was planned)
 * - Remaining: Current risk (how much buffer remains)
 */

import * as vscode from "vscode";
import { parseLocalDate, getLocalToday } from "./date-utils";

export type WeeklySchedule = {
  Mon: number;
  Tue: number;
  Wed: number;
  Thu: number;
  Fri: number;
  Sat: number;
  Sun: number;
};

/** Default working schedule: 8h Mon-Fri, 0h Sat-Sun */
export const DEFAULT_WEEKLY_SCHEDULE: WeeklySchedule = {
  Mon: 8,
  Tue: 8,
  Wed: 8,
  Thu: 8,
  Fri: 8,
  Sat: 0,
  Sun: 0,
};

export interface FlexibilityScore {
  /** Initial flexibility at start (planning quality) */
  initial: number;
  /** Current remaining flexibility (risk indicator) */
  remaining: number;
  /** Risk status based on remaining flexibility */
  status: "overbooked" | "at-risk" | "on-track" | "completed";
  /** Working days until due date */
  daysRemaining: number;
  /** Hours of work remaining */
  hoursRemaining: number;
}

export interface FlexibilityIssue {
  start_date: string;
  due_date: string | null;
  estimated_hours: number | null;
  spent_hours?: number;
  done_ratio?: number;
  closed_on?: string | null;
}

// Memoization cache for working days calculation
const workingDaysCache = new Map<string, number>();

/**
 * Calculate flexibility score for an issue.
 * Returns null if issue lacks required data (due_date, estimated_hours).
 * @param effectiveSpentHours Optional override for spent hours (for ad-hoc budget contributions)
 */
export function calculateFlexibility(
  issue: FlexibilityIssue,
  schedule: WeeklySchedule,
  effectiveSpentHours?: number
): FlexibilityScore | null {
  // Can't calculate without due date or estimate
  if (!issue.due_date || !issue.estimated_hours) {
    return null;
  }

  const startDate = parseLocalDate(issue.start_date);
  const dueDate = parseLocalDate(issue.due_date);
  const today = getLocalToday();

  // Use effective spent hours if provided (for ad-hoc contributions)
  const spentHours = effectiveSpentHours ?? issue.spent_hours ?? 0;
  const doneRatio = issue.done_ratio ?? 0;

  // Calculate remaining work hours
  // If over budget but not done, use done_ratio to estimate remaining work
  let hoursRemaining: number;
  if (spentHours > issue.estimated_hours && doneRatio < 100) {
    // Over budget: estimate remaining based on done_ratio
    // e.g., 80% done with 32h estimate → 32 × 0.2 = 6.4h remaining
    hoursRemaining = issue.estimated_hours * (1 - doneRatio / 100);
  } else {
    hoursRemaining = Math.max(issue.estimated_hours - spentHours, 0);
  }

  // Initial flexibility: total available vs estimated
  const totalAvailableHours = countAvailableHours(
    startDate,
    dueDate,
    schedule
  );
  const initial = calculateFlexibilityPercent(
    totalAvailableHours,
    issue.estimated_hours
  );

  // Remaining flexibility: remaining time vs remaining work
  const daysRemaining = countWorkingDays(today, dueDate, schedule);
  const availableRemaining = countAvailableHours(today, dueDate, schedule);
  const remaining =
    hoursRemaining > 0
      ? calculateFlexibilityPercent(availableRemaining, hoursRemaining)
      : 100; // Completed = 100% flexibility

  // Status based on remaining flexibility
  const isCompleted = issue.done_ratio === 100;
  const status: FlexibilityScore["status"] = isCompleted
    ? "completed"
    : remaining < 0
      ? "overbooked"
      : remaining < 20
        ? "at-risk"
        : "on-track";

  return {
    initial: Math.round(initial),
    remaining: Math.round(remaining),
    status,
    daysRemaining,
    hoursRemaining,
  };
}

/**
 * Calculate flexibility percentage
 * Formula: (available / needed - 1) * 100
 * +100% = double the time needed
 * 0% = exactly enough time
 * -50% = need 50% more time
 */
function calculateFlexibilityPercent(
  available: number,
  needed: number
): number {
  if (needed <= 0) return 100;
  return (available / needed - 1) * 100;
}

// Day index to schedule key mapping (0=Sun, 1=Mon, ..., 6=Sat)
const DAY_KEYS: (keyof WeeklySchedule)[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Count working days between two dates (inclusive)
 * Returns negative if end < start (past due)
 * Uses O(1) week-based math instead of day-by-day iteration
 */
export function countWorkingDays(
  start: Date,
  end: Date,
  schedule: WeeklySchedule
): number {
  const key = `${start.toISOString().split("T")[0]}_${end.toISOString().split("T")[0]}_${JSON.stringify(schedule)}`;

  if (workingDaysCache.has(key)) {
    return workingDaysCache.get(key)!;
  }

  const startNorm = new Date(start);
  startNorm.setHours(0, 0, 0, 0);
  const endNorm = new Date(end);
  endNorm.setHours(0, 0, 0, 0);

  // Determine direction: positive if end >= start, negative if past due
  const isPastDue = endNorm < startNorm;
  const [from, to] = isPastDue ? [endNorm, startNorm] : [startNorm, endNorm];

  // Calculate total days (inclusive)
  const totalDays = Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)) + 1;

  // Pre-compute working days per week from schedule
  const workingDaysPerWeek = DAY_KEYS.reduce((sum, day) => sum + (schedule[day] > 0 ? 1 : 0), 0);

  // Full weeks contribute a fixed number of working days
  const fullWeeks = Math.floor(totalDays / 7);
  let count = fullWeeks * workingDaysPerWeek;

  // Handle remaining days (0-6)
  const remainingDays = totalDays % 7;
  const startDayIndex = from.getDay();
  for (let i = 0; i < remainingDays; i++) {
    const dayIndex = (startDayIndex + fullWeeks * 7 + i) % 7;
    if (schedule[DAY_KEYS[dayIndex]] > 0) {
      count++;
    }
  }

  // Subtract 1 to not count today, then negate if past due
  const result = isPastDue ? -(count - 1) : count;

  workingDaysCache.set(key, result);
  return result;
}

/**
 * Count available working hours between two dates (inclusive)
 * Uses O(1) week-based math instead of day-by-day iteration
 */
export function countAvailableHours(
  start: Date,
  end: Date,
  schedule: WeeklySchedule
): number {
  const key = `hours_${start.toISOString().split("T")[0]}_${end.toISOString().split("T")[0]}_${JSON.stringify(schedule)}`;

  if (workingDaysCache.has(key)) {
    return workingDaysCache.get(key)!;
  }

  const startNorm = new Date(start);
  startNorm.setHours(0, 0, 0, 0);
  const endNorm = new Date(end);
  endNorm.setHours(0, 0, 0, 0);

  // Handle case where end < start (return 0 hours)
  if (endNorm < startNorm) {
    workingDaysCache.set(key, 0);
    return 0;
  }

  // Calculate total days (inclusive)
  const totalDays = Math.floor((endNorm.getTime() - startNorm.getTime()) / (1000 * 60 * 60 * 24)) + 1;

  // Pre-compute hours per week from schedule
  const hoursPerWeek = DAY_KEYS.reduce((sum, day) => sum + schedule[day], 0);

  // Full weeks contribute a fixed number of hours
  const fullWeeks = Math.floor(totalDays / 7);
  let hours = fullWeeks * hoursPerWeek;

  // Handle remaining days (0-6)
  const remainingDays = totalDays % 7;
  const startDayIndex = startNorm.getDay();
  for (let i = 0; i < remainingDays; i++) {
    const dayIndex = (startDayIndex + fullWeeks * 7 + i) % 7;
    hours += schedule[DAY_KEYS[dayIndex]];
  }

  workingDaysCache.set(key, hours);
  return hours;
}

/**
 * Get day name from Date object
 */
export function getDayName(date: Date): keyof WeeklySchedule {
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
 * Clear memoization cache (call on config change)
 */
export function clearFlexibilityCache(): void {
  workingDaysCache.clear();
}

/**
 * Contribution data for effective spent hours calculation
 */
export interface ContributionData {
  /** Hours contributed TO each issue (from ad-hoc pools) */
  contributedTo: Map<number, number>;
  /** Hours donated FROM each ad-hoc issue */
  donatedFrom: Map<number, number>;
  /** Set of ad-hoc issue IDs */
  adHocIssues: Set<number>;
}

/**
 * Build flexibility cache for a set of issues
 * Common pattern used by tree providers
 * @param contributions Optional contribution data for ad-hoc budget calculations
 */
export function buildFlexibilityCache(
  issues: FlexibilityIssue[],
  cache: Map<number, FlexibilityScore | null>,
  schedule: WeeklySchedule,
  contributions?: ContributionData
): void {
  cache.clear();
  for (const issue of issues) {
    const issueWithId = issue as FlexibilityIssue & { id: number };
    const issueId = issueWithId.id;

    // Skip closed issues - no flexibility calculation needed
    if (issue.closed_on !== null && issue.closed_on !== undefined) {
      cache.set(issueId, null);
      continue;
    }

    // Calculate effective spent hours if contributions provided
    let effectiveSpent: number | undefined;
    if (contributions) {
      const spentHours = issue.spent_hours ?? 0;
      if (contributions.adHocIssues.has(issueId)) {
        // Ad-hoc issue: show negative (donated hours as spent)
        const donated = contributions.donatedFrom.get(issueId) ?? 0;
        effectiveSpent = -donated;
      } else {
        // Normal issue: add contributed hours
        const contributed = contributions.contributedTo.get(issueId) ?? 0;
        effectiveSpent = spentHours + contributed;
      }
    }

    cache.set(issueId, calculateFlexibility(issue, schedule, effectiveSpent));
  }
}

/**
 * Get the weekly schedule from configuration
 * Supports both new weeklySchedule format and deprecated hoursPerDay/workingDays
 */
export function getWeeklySchedule(): WeeklySchedule {
  const config = vscode.workspace.getConfiguration("redmine.workingHours");

  // Try new format first
  const schedule = config.get<WeeklySchedule>("weeklySchedule");
  if (schedule) {
    return schedule;
  }

  // Fallback to deprecated format (backward compatibility)
  const hoursPerDay = config.get<number>("hoursPerDay", 8);
  const workingDays = config.get<string[]>("workingDays", [
    "Mon", "Tue", "Wed", "Thu", "Fri",
  ]);

  const result: WeeklySchedule = {
    Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0,
  };

  workingDays.forEach((day) => {
    if (day in result) {
      result[day as keyof WeeklySchedule] = hoursPerDay;
    }
  });

  return result;
}
