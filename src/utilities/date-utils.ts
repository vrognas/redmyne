/**
 * Shared date utilities
 */

import { getISOWeek, getISOWeekYear, startOfISOWeek, endOfISOWeek } from "date-fns";

/**
 * Format date as YYYY-MM-DD in local timezone (avoids UTC conversion issues)
 */
export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Format date as ISO string (YYYY-MM-DD) - uses local timezone
 */
export function formatDateISO(date: Date): string {
  return formatLocalDate(date);
}

/**
 * Get Monday of current week as YYYY-MM-DD (uses date-fns for reliability)
 */
export function getWeekStart(): string {
  const now = new Date();
  return formatLocalDate(startOfISOWeek(now));
}

/**
 * Get first day of current month as YYYY-MM-DD
 */
export function getMonthStart(): string {
  const now = new Date();
  return formatLocalDate(new Date(now.getFullYear(), now.getMonth(), 1));
}

/**
 * Get last month's date range and display name
 */
export function getLastMonthRange(): { start: string; end: string; name: string } {
  const now = new Date();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0); // Day 0 = last day of prev month
  return {
    start: formatLocalDate(lastMonthStart),
    end: formatLocalDate(lastMonthEnd),
    name: lastMonthStart.toLocaleDateString("en-US", { month: "short" }),
  };
}

/**
 * Generate all dates between start and end (inclusive)
 */
export function getDateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const current = new Date(start + "T12:00:00");
  const endDate = new Date(end + "T12:00:00");

  while (current <= endDate) {
    dates.push(formatLocalDate(current));
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

/**
 * Get ISO week number for a date (uses date-fns for reliability)
 */
export function getISOWeekNumber(date: Date): number {
  return getISOWeek(date);
}

/**
 * Get ISO week year for a date (may differ from calendar year at year boundaries)
 * Uses date-fns for reliable calculations
 */
export { getISOWeekYear };

/**
 * Get date range (Mon-Sun) for a given ISO week number and year
 * Uses date-fns for reliable week boundary calculations
 */
export function getWeekDateRange(
  weekNum: number,
  year: number
): { start: string; end: string } {
  // Create a date in the target week (using Jan 4 as reference since it's always in week 1)
  const jan4 = new Date(year, 0, 4, 12, 0, 0);
  const week1Start = startOfISOWeek(jan4);

  // Calculate target week's Monday by adding (weekNum - 1) weeks
  const targetMonday = new Date(week1Start);
  targetMonday.setDate(week1Start.getDate() + (weekNum - 1) * 7);

  // Get start and end of that week using date-fns
  const start = startOfISOWeek(targetMonday);
  const end = endOfISOWeek(targetMonday);

  return {
    start: formatLocalDate(start),
    end: formatLocalDate(end),
  };
}
