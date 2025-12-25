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
 * Normalize date to midnight (00:00:00.000)
 * Returns a new Date object
 */
export function normalizeToMidnight(date: Date): Date {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

/**
 * Get today's date normalized to midnight
 */
export function getToday(): Date {
  return normalizeToMidnight(new Date());
}

/**
 * Add days to a date string, returning YYYY-MM-DD
 */
export function addDaysToDateString(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return formatDateISO(d);
}
