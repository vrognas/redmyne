/**
 * Shared date utilities
 */

/**
 * Format date as ISO string (YYYY-MM-DD)
 */
export function formatDateISO(date: Date): string {
  return date.toISOString().split("T")[0];
}
