/**
 * Flexibility Calculator for Issue Timeline & Progress
 *
 * Calculates dual flexibility scores:
 * - Initial: Planning quality (how much buffer was planned)
 * - Remaining: Current risk (how much buffer remains)
 */

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
}

/** Status priority for sorting (lower = higher priority) */
export const STATUS_PRIORITY: Record<FlexibilityScore["status"], number> = {
  overbooked: 0,
  "at-risk": 1,
  "on-track": 2,
  completed: 3,
};

// Memoization cache for working days calculation
const workingDaysCache = new Map<string, number>();

/**
 * Calculate flexibility score for an issue.
 * Returns null if issue lacks required data (due_date, estimated_hours).
 */
export function calculateFlexibility(
  issue: FlexibilityIssue,
  schedule: WeeklySchedule
): FlexibilityScore | null {
  // Can't calculate without due date or estimate
  if (!issue.due_date || !issue.estimated_hours) {
    return null;
  }

  const startDate = new Date(issue.start_date);
  const dueDate = new Date(issue.due_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const spentHours = issue.spent_hours ?? 0;
  const hoursRemaining = Math.max(issue.estimated_hours - spentHours, 0);

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

/**
 * Count working days between two dates (inclusive)
 * Uses memoization for performance
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

  let count = 0;
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const endDate = new Date(end);
  endDate.setHours(0, 0, 0, 0);

  while (current <= endDate) {
    const dayName = getDayName(current);
    if (schedule[dayName] > 0) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }

  workingDaysCache.set(key, count);
  return count;
}

/**
 * Count available working hours between two dates (inclusive)
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

  let hours = 0;
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const endDate = new Date(end);
  endDate.setHours(0, 0, 0, 0);

  while (current <= endDate) {
    const dayName = getDayName(current);
    hours += schedule[dayName];
    current.setDate(current.getDate() + 1);
  }

  workingDaysCache.set(key, hours);
  return hours;
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
 * Clear memoization cache (call on config change)
 */
export function clearFlexibilityCache(): void {
  workingDaysCache.clear();
}
