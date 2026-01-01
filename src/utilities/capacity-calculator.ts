/**
 * Capacity Calculator for Personal Workload Visualization
 *
 * Calculates daily load by summing hours/day from concurrent tasks.
 * Used by capacity ribbon in "My Work" Gantt view.
 */

import { Issue } from "../redmine/models/issue";
import { WeeklySchedule, countWorkingDays } from "./flexibility-calculator";

export type CapacityStatus = "available" | "busy" | "overloaded";

export interface DailyCapacity {
  /** Date in YYYY-MM-DD format */
  date: string;
  /** Sum of hours from all concurrent tasks */
  loadHours: number;
  /** Available working hours from schedule */
  capacityHours: number;
  /** Load as percentage of capacity */
  percentage: number;
  /** Status based on percentage: available < 80%, busy 80-100%, overloaded > 100% */
  status: CapacityStatus;
}

/** Day keys for WeeklySchedule lookup */
const DAY_KEYS: (keyof WeeklySchedule)[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Get hours/day that an issue contributes over its duration.
 * Returns 0 if issue lacks required data.
 */
function getIssueHoursPerDay(issue: Issue, schedule: WeeklySchedule): number {
  if (!issue.start_date || !issue.due_date || !issue.estimated_hours) {
    return 0;
  }

  const startDate = new Date(issue.start_date);
  const dueDate = new Date(issue.due_date);
  const workingDays = countWorkingDays(startDate, dueDate, schedule);

  if (workingDays <= 0) return 0;

  return issue.estimated_hours / workingDays;
}

/**
 * Check if a date falls within an issue's date range (inclusive)
 */
function isDateInIssueRange(dateStr: string, issue: Issue): boolean {
  if (!issue.start_date || !issue.due_date) return false;
  return dateStr >= issue.start_date && dateStr <= issue.due_date;
}

/**
 * Get capacity status based on load percentage
 * < 80% = available (green)
 * 80-100% = busy (yellow)
 * > 100% = overloaded (red)
 */
function getCapacityStatus(percentage: number): CapacityStatus {
  if (percentage < 80) return "available";
  if (percentage <= 100) return "busy";
  return "overloaded";
}

/**
 * Calculate daily capacity for a date range.
 * Returns array of DailyCapacity for each working day in range.
 *
 * @param issues - Issues to calculate load from
 * @param schedule - Weekly working hours schedule
 * @param startDate - Start of range (YYYY-MM-DD)
 * @param endDate - End of range (YYYY-MM-DD)
 */
export function calculateDailyCapacity(
  issues: Issue[],
  schedule: WeeklySchedule,
  startDate: string,
  endDate: string
): DailyCapacity[] {
  if (issues.length === 0) {
    // Still generate capacity entries for the range
    return generateEmptyCapacity(schedule, startDate, endDate);
  }

  // Pre-calculate hours/day for each issue
  const issueHoursPerDay = new Map<number, number>();
  for (const issue of issues) {
    const hoursPerDay = getIssueHoursPerDay(issue, schedule);
    if (hoursPerDay > 0) {
      issueHoursPerDay.set(issue.id, hoursPerDay);
    }
  }

  const result: DailyCapacity[] = [];
  const current = new Date(startDate);
  const end = new Date(endDate);

  while (current <= end) {
    const dateStr = current.toISOString().slice(0, 10);
    const dayOfWeek = current.getDay();
    const capacityHours = schedule[DAY_KEYS[dayOfWeek]];

    // Skip non-working days
    if (capacityHours > 0) {
      // Sum hours from all issues that span this date
      let loadHours = 0;
      for (const issue of issues) {
        if (isDateInIssueRange(dateStr, issue)) {
          loadHours += issueHoursPerDay.get(issue.id) ?? 0;
        }
      }

      const percentage = capacityHours > 0 ? (loadHours / capacityHours) * 100 : 0;

      result.push({
        date: dateStr,
        loadHours: Math.round(loadHours * 100) / 100, // Round to 2 decimals
        capacityHours,
        percentage: Math.round(percentage),
        status: getCapacityStatus(percentage),
      });
    }

    current.setDate(current.getDate() + 1);
  }

  return result;
}

/**
 * Generate empty capacity entries for a date range (no issues)
 */
function generateEmptyCapacity(
  schedule: WeeklySchedule,
  startDate: string,
  endDate: string
): DailyCapacity[] {
  const result: DailyCapacity[] = [];
  const current = new Date(startDate);
  const end = new Date(endDate);

  while (current <= end) {
    const dateStr = current.toISOString().slice(0, 10);
    const dayOfWeek = current.getDay();
    const capacityHours = schedule[DAY_KEYS[dayOfWeek]];

    if (capacityHours > 0) {
      result.push({
        date: dateStr,
        loadHours: 0,
        capacityHours,
        percentage: 0,
        status: "available",
      });
    }

    current.setDate(current.getDate() + 1);
  }

  return result;
}
