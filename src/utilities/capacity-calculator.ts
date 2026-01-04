/**
 * Capacity Calculator for Personal Workload Visualization
 *
 * Calculates daily load by summing hours/day from concurrent tasks.
 * Used by capacity ribbon in "My Work" Gantt view.
 * Supports aggregation by zoom level (day, week, month, quarter, year).
 */

import { Issue } from "../redmine/models/issue";
import { WeeklySchedule, countWorkingDays } from "./flexibility-calculator";
import { parseLocalDate, getISOWeekNumber, getISOWeekYear } from "./date-utils";

export type CapacityStatus = "available" | "busy" | "overloaded";
export type CapacityZoomLevel = "day" | "week" | "month" | "quarter" | "year";

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

export interface PeriodCapacity {
  /** Start date of period (YYYY-MM-DD) */
  startDate: string;
  /** End date of period (YYYY-MM-DD) - inclusive */
  endDate: string;
  /** Sum of hours from all tasks in period */
  loadHours: number;
  /** Available working hours in period */
  capacityHours: number;
  /** Load as percentage of capacity */
  percentage: number;
  /** Status based on percentage */
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

  const startDate = parseLocalDate(issue.start_date);
  const dueDate = parseLocalDate(issue.due_date);
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
  // Filter to leaf issues only (no children) to avoid double-counting
  const leafIssues = issues.filter(i => !i.children || i.children.length === 0);

  if (leafIssues.length === 0) {
    // Still generate capacity entries for the range
    return generateEmptyCapacity(schedule, startDate, endDate);
  }

  // Pre-calculate hours/day for each issue
  const issueHoursPerDay = new Map<number, number>();
  for (const issue of leafIssues) {
    const hoursPerDay = getIssueHoursPerDay(issue, schedule);
    if (hoursPerDay > 0) {
      issueHoursPerDay.set(issue.id, hoursPerDay);
    }
  }

  const result: DailyCapacity[] = [];
  const current = new Date(startDate + "T00:00:00Z");  // Explicit UTC
  const end = new Date(endDate + "T00:00:00Z");

  while (current <= end) {
    const dateStr = current.toISOString().slice(0, 10);
    const dayOfWeek = current.getUTCDay();  // Use UTC day
    const capacityHours = schedule[DAY_KEYS[dayOfWeek]];

    // Skip non-working days
    if (capacityHours > 0) {
      // Sum hours from all issues that span this date
      let loadHours = 0;
      for (const issue of leafIssues) {
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

    current.setUTCDate(current.getUTCDate() + 1);  // Use UTC increment
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
  const current = new Date(startDate + "T00:00:00Z");  // Explicit UTC
  const end = new Date(endDate + "T00:00:00Z");

  while (current <= end) {
    const dateStr = current.toISOString().slice(0, 10);
    const dayOfWeek = current.getUTCDay();  // Use UTC day
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

    current.setUTCDate(current.getUTCDate() + 1);  // Use UTC increment
  }

  return result;
}

/**
 * Get a unique key for the period a date belongs to, based on zoom level.
 * Used for grouping daily data into periods.
 */
function getPeriodKey(date: Date, zoomLevel: CapacityZoomLevel): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();

  switch (zoomLevel) {
    case "day":
      return date.toISOString().slice(0, 10);
    case "week":
      // Use ISO week year to handle year boundaries correctly
      return `${getISOWeekYear(date)}-W${String(getISOWeekNumber(date)).padStart(2, "0")}`;
    case "month":
      return `${year}-${String(month + 1).padStart(2, "0")}`;
    case "quarter": {
      const quarter = Math.floor(month / 3) + 1;
      return `${year}-Q${quarter}`;
    }
    case "year":
      return `${year}`;
    default:
      return date.toISOString().slice(0, 10);
  }
}

/**
 * Aggregate an array of daily capacity data into a single period.
 * Days must be pre-sorted by date.
 */
function aggregatePeriod(days: DailyCapacity[]): PeriodCapacity {
  if (days.length === 0) {
    throw new Error("Cannot aggregate empty period");
  }

  const startDate = days[0].date;
  const endDate = days[days.length - 1].date;

  // Sum hours across all days
  let loadHours = 0;
  let capacityHours = 0;
  for (const day of days) {
    loadHours += day.loadHours;
    capacityHours += day.capacityHours;
  }

  // Calculate percentage and status
  const percentage = capacityHours > 0 ? (loadHours / capacityHours) * 100 : 0;

  return {
    startDate,
    endDate,
    loadHours: Math.round(loadHours * 100) / 100,
    capacityHours: Math.round(capacityHours * 100) / 100,
    percentage: Math.round(percentage),
    status: getCapacityStatus(percentage),
  };
}

/**
 * Calculate capacity aggregated by zoom level.
 * Returns array of PeriodCapacity for each period in range.
 *
 * @param issues - Issues to calculate load from
 * @param schedule - Weekly working hours schedule
 * @param startDate - Start of range (YYYY-MM-DD)
 * @param endDate - End of range (YYYY-MM-DD)
 * @param zoomLevel - Aggregation level (day, week, month, quarter, year)
 */
export function calculateCapacityByZoom(
  issues: Issue[],
  schedule: WeeklySchedule,
  startDate: string,
  endDate: string,
  zoomLevel: CapacityZoomLevel
): PeriodCapacity[] {
  // Get daily capacity first (reuse existing logic)
  const dailyData = calculateDailyCapacity(issues, schedule, startDate, endDate);

  if (dailyData.length === 0) {
    return [];
  }

  // For day zoom, convert directly to PeriodCapacity format
  if (zoomLevel === "day") {
    return dailyData.map(day => ({
      startDate: day.date,
      endDate: day.date,
      loadHours: day.loadHours,
      capacityHours: day.capacityHours,
      percentage: day.percentage,
      status: day.status,
    }));
  }

  // Group days by period key
  const periodGroups = new Map<string, DailyCapacity[]>();

  for (const day of dailyData) {
    const date = new Date(day.date + "T00:00:00Z");
    const key = getPeriodKey(date, zoomLevel);

    if (!periodGroups.has(key)) {
      periodGroups.set(key, []);
    }
    periodGroups.get(key)!.push(day);
  }

  // Aggregate each period and sort by start date
  const periods: PeriodCapacity[] = [];
  for (const days of periodGroups.values()) {
    // Days are already in date order from calculateDailyCapacity
    periods.push(aggregatePeriod(days));
  }

  // Sort by start date to ensure correct order
  periods.sort((a, b) => a.startDate.localeCompare(b.startDate));

  return periods;
}
