/**
 * Shared date utilities
 */

/**
 * Format date as ISO string (YYYY-MM-DD)
 */
export function formatDateISO(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Get Monday of current week as YYYY-MM-DD
 */
export function getWeekStart(): string {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Monday
  const weekStart = new Date(now.setDate(diff));
  return weekStart.toISOString().split("T")[0];
}

/**
 * Get first day of current month as YYYY-MM-DD
 */
export function getMonthStart(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .split("T")[0];
}

/**
 * Get last month's date range and display name
 */
export function getLastMonthRange(): { start: string; end: string; name: string } {
  const now = new Date();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0); // Day 0 = last day of prev month
  return {
    start: lastMonthStart.toISOString().split("T")[0],
    end: lastMonthEnd.toISOString().split("T")[0],
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
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

/**
 * Get ISO week number for a date
 */
export function getISOWeekNumber(date: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // Set to nearest Thursday (current date + 4 - current day number, making Sunday = 7)
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  // Get first day of year
  const yearStart = new Date(d.getFullYear(), 0, 1);
  // Calculate full weeks to nearest Thursday
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * Get ISO week year for a date (may differ from calendar year at year boundaries)
 */
export function getISOWeekYear(date: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // Set to nearest Thursday
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  return d.getFullYear();
}

/**
 * Get date range (Mon-Sun) for a given ISO week number and year
 */
export function getWeekDateRange(
  weekNum: number,
  year: number
): { start: string; end: string } {
  // January 4th is always in week 1
  const jan4 = new Date(year, 0, 4);
  // Find the Monday of week 1
  const dayOfWeek = jan4.getDay() || 7; // Sunday = 7
  const week1Monday = new Date(jan4);
  week1Monday.setDate(jan4.getDate() - dayOfWeek + 1);

  // Calculate target week's Monday
  const targetMonday = new Date(week1Monday);
  targetMonday.setDate(week1Monday.getDate() + (weekNum - 1) * 7);

  // Calculate Sunday
  const targetSunday = new Date(targetMonday);
  targetSunday.setDate(targetMonday.getDate() + 6);

  return {
    start: targetMonday.toISOString().split("T")[0],
    end: targetSunday.toISOString().split("T")[0],
  };
}
