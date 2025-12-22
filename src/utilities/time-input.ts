/**
 * Shared time input parsing utility
 * Supports flexible time formats for user input
 */

/**
 * Parse time input string to hours
 * Supports: decimal (1.75), colon (1:45), units (1h 45min)
 * @returns Parsed hours or null if invalid
 */
export function parseTimeInput(input: string): number | null {
  const trimmed = input.trim();

  // Format: "1.75" or "1,75" (decimal hours)
  const decimalMatch = trimmed.match(/^(\d+(?:[.,]\d+)?)$/);
  if (decimalMatch) {
    return parseFloat(decimalMatch[1].replace(",", "."));
  }

  // Format: "1:45" (hours:minutes)
  const colonMatch = trimmed.match(/^(\d+):(\d+)$/);
  if (colonMatch) {
    const hours = parseInt(colonMatch[1], 10);
    const minutes = parseInt(colonMatch[2], 10);
    if (minutes >= 60) return null; // Invalid minutes
    return hours + minutes / 60;
  }

  // Format: "1h 45min" or "1 h 45 min" (with units and optional spaces)
  const unitMatch = trimmed.match(
    /^(?:(\d+)\s*h(?:our)?s?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?$/i
  );
  if (unitMatch) {
    const hours = unitMatch[1] ? parseInt(unitMatch[1], 10) : 0;
    const minutes = unitMatch[2] ? parseInt(unitMatch[2], 10) : 0;
    if (hours === 0 && minutes === 0) return null; // No input
    if (minutes >= 60) return null; // Invalid minutes
    return hours + minutes / 60;
  }

  return null; // Invalid format
}

/**
 * Validate time input for logging
 * @returns Error message or null if valid
 */
export function validateTimeInput(
  value: string,
  todayTotal = 0
): string | null {
  const hours = parseTimeInput(value);
  if (hours === null || hours < 0.1 || hours > 24) {
    return "Must be 0.1-24 hours (e.g. 1.75, 1:45, or 1h 45min)";
  }
  if (todayTotal + hours > 24) {
    return `Would exceed 24h/day limit (already logged ${formatHoursAsHHMM(todayTotal)} today)`;
  }
  return null;
}

/**
 * Format decimal hours as H:MM (e.g., 1.0 → "1:00", 0.75 → "0:45", 1.5 → "1:30")
 */
export function formatHoursAsHHMM(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${m.toString().padStart(2, "0")}`;
}
