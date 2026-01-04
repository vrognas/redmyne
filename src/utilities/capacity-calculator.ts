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
import { DependencyGraph, countDownstream } from "./dependency-graph";
import type { InternalEstimates } from "./internal-estimates";

// Re-export for convenience
export type { InternalEstimates } from "./internal-estimates";

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

/** Entry showing scheduled hours for a single issue on a single day */
export interface IssueScheduleEntry {
  issueId: number;
  hours: number;
  /** True if scheduled past issue's due_date */
  isSlippage: boolean;
}

/** Daily capacity with breakdown by issue (priority-based scheduling) */
export interface ScheduledDailyCapacity extends DailyCapacity {
  /** Breakdown of scheduled hours per issue */
  breakdown: IssueScheduleEntry[];
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

// ============================================================================
// Priority-Based Scheduled Capacity (frontloading with priority ordering)
// ============================================================================

/** Priority weights for scheduling */
const PRECEDENCE_BONUS = 10000; // Massive bonus for user-tagged precedence issues
const URGENCY_WEIGHT = 10; // Points per day earlier due date
const EXTERNAL_BLOCK_BONUS = 100; // Bonus for blocking external assignee
const DOWNSTREAM_WEIGHT = 5; // Points per downstream issue
const EXTERNAL_BLOCK_MULTIPLIER = 2; // 2x priority for external blocks

/**
 * Calculate remaining work for an issue
 * Priority: internal estimate > done_ratio > spent_hours fallback
 */
function calculateRemainingWork(
  issue: Issue,
  internalEstimates: InternalEstimates
): number {
  // 1. Internal estimate takes highest priority
  const internal = internalEstimates.get(issue.id);
  if (internal) {
    return Math.max(0, internal.hoursRemaining);
  }

  const estimated = issue.estimated_hours ?? 0;
  const doneRatio = issue.done_ratio ?? 0;
  const spent = issue.spent_hours ?? 0;

  // 2. Use done_ratio if > 0, or if no spent hours
  if (doneRatio > 0 || spent === 0) {
    return Math.max(0, estimated * (1 - doneRatio / 100));
  }

  // 3. Fallback: use spent_hours when done_ratio=0 but spent>0
  return Math.max(0, estimated - spent);
}

/**
 * Check if all blockers for an issue are complete
 */
function allBlockersComplete(
  issue: Issue,
  completedIssues: Set<number>,
  graph: DependencyGraph
): boolean {
  const node = graph.get(issue.id);
  if (!node) return true; // No dependency info = not blocked

  for (const blockerId of node.upstream) {
    // If blocker is not in our completed set, issue is still blocked
    if (!completedIssues.has(blockerId)) {
      return false;
    }
  }
  return true;
}

/**
 * Calculate priority score for scheduling
 * Higher score = higher priority (scheduled first)
 */
function calculatePriorityScore(
  issue: Issue,
  graph: DependencyGraph,
  issueMap: Map<number, Issue>,
  maxDueDate: Date,
  myUserId?: number,
  precedenceIssues?: Set<number>
): number {
  let score = 0;

  // 0. Precedence tag: user-tagged issues always come first
  if (precedenceIssues?.has(issue.id)) {
    score += PRECEDENCE_BONUS;
  }

  // 1. Due date urgency: earlier due = higher priority
  if (issue.due_date) {
    const dueDate = parseLocalDate(issue.due_date);
    const daysUntilDue = Math.floor(
      (maxDueDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    score += daysUntilDue * URGENCY_WEIGHT;
  }

  // 2. Downstream impact: more dependents = higher priority
  const downstreamCount = countDownstream(issue.id, graph);
  score += downstreamCount * DOWNSTREAM_WEIGHT;

  // 3. External block bonus: 2x if blocking someone else's work
  if (myUserId !== undefined) {
    const node = graph.get(issue.id);
    if (node) {
      for (const downstreamId of node.downstream) {
        const downstream = issueMap.get(downstreamId);
        if (downstream?.assigned_to?.id && downstream.assigned_to.id !== myUserId) {
          // Blocking external assignee - major priority boost
          score += EXTERNAL_BLOCK_BONUS * EXTERNAL_BLOCK_MULTIPLIER;
          break; // Only count once
        }
      }
    }
  }

  return score;
}

/**
 * Calculate daily capacity using priority-based frontloading.
 * Unlike uniform distribution, this schedules high-priority work ASAP.
 *
 * Priority order:
 * 1. Issues blocking external assignees (2x weight)
 * 2. Earlier due dates
 * 3. More downstream dependents
 *
 * Constraints:
 * - Cannot schedule before start_date
 * - Cannot schedule if blockers incomplete (hard constraint)
 * - Cannot exceed daily capacity
 *
 * @param issues - Issues to schedule
 * @param schedule - Weekly working hours schedule
 * @param startDate - Start of range (YYYY-MM-DD)
 * @param endDate - End of range (YYYY-MM-DD)
 * @param graph - Dependency graph for blocking relations
 * @param internalEstimates - User-provided remaining hours overrides
 * @param myUserId - Current user ID for external block detection
 * @param allIssuesMap - Optional map of all issues (for external block detection)
 * @param precedenceIssues - User-tagged issues that always get scheduled first
 */
export function calculateScheduledCapacity(
  issues: Issue[],
  schedule: WeeklySchedule,
  startDate: string,
  endDate: string,
  graph: DependencyGraph,
  internalEstimates: InternalEstimates,
  myUserId?: number,
  allIssuesMap?: Map<number, Issue>,
  precedenceIssues?: Set<number>
): ScheduledDailyCapacity[] {
  // Filter to schedulable issues (has start_date AND work to schedule)
  // Work can come from estimated_hours OR internal estimate
  const schedulableIssues = issues.filter(
    (i) =>
      i.start_date &&
      ((i.estimated_hours && i.estimated_hours > 0) || internalEstimates.has(i.id))
  );

  // Build issue map for priority calculation (use provided or build from issues)
  const issueMap = allIssuesMap ?? new Map<number, Issue>();
  if (!allIssuesMap) {
    for (const issue of issues) {
      issueMap.set(issue.id, issue);
    }
  }

  // Find max due date for priority calculation
  let maxDueDate = parseLocalDate(endDate);
  for (const issue of schedulableIssues) {
    if (issue.due_date) {
      const dueDate = parseLocalDate(issue.due_date);
      if (dueDate > maxDueDate) {
        maxDueDate = dueDate;
      }
    }
  }

  // Initialize remaining work per issue
  const remainingWork = new Map<number, number>();
  for (const issue of schedulableIssues) {
    remainingWork.set(issue.id, calculateRemainingWork(issue, internalEstimates));
  }

  // Track completed issues for blocker resolution
  const completedIssues = new Set<number>();

  const result: ScheduledDailyCapacity[] = [];
  const current = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");

  while (current <= end) {
    const dateStr = current.toISOString().slice(0, 10);
    const dayOfWeek = current.getUTCDay();
    const capacityHours = schedule[DAY_KEYS[dayOfWeek]];

    // Skip non-working days
    if (capacityHours > 0) {
      // Get issues that can be scheduled today
      const todaysIssues = schedulableIssues.filter((issue) => {
        // Must have started
        if (issue.start_date! > dateStr) return false;
        // Must have remaining work
        if ((remainingWork.get(issue.id) ?? 0) <= 0) return false;
        // All blockers must be complete
        if (!allBlockersComplete(issue, completedIssues, graph)) return false;
        return true;
      });

      // Sort by priority (highest first)
      todaysIssues.sort((a, b) => {
        const scoreA = calculatePriorityScore(a, graph, issueMap, maxDueDate, myUserId, precedenceIssues);
        const scoreB = calculatePriorityScore(b, graph, issueMap, maxDueDate, myUserId, precedenceIssues);
        if (scoreB !== scoreA) return scoreB - scoreA;
        // Tiebreaker: earlier due date
        if (a.due_date && b.due_date) {
          if (a.due_date !== b.due_date) return a.due_date.localeCompare(b.due_date);
        }
        // Tiebreaker: earlier start date
        if (a.start_date !== b.start_date) return a.start_date!.localeCompare(b.start_date!);
        // Tiebreaker: lower ID
        return a.id - b.id;
      });

      // Fill capacity from highest priority
      const breakdown: IssueScheduleEntry[] = [];
      let loadHours = 0;
      let available = capacityHours;

      for (const issue of todaysIssues) {
        if (available <= 0) break;

        const issueRemaining = remainingWork.get(issue.id) ?? 0;
        const hours = Math.min(available, issueRemaining);

        if (hours > 0) {
          // Check if past due date (slippage)
          const isSlippage = issue.due_date ? dateStr > issue.due_date : false;

          breakdown.push({
            issueId: issue.id,
            hours: Math.round(hours * 100) / 100,
            isSlippage,
          });

          loadHours += hours;
          available -= hours;

          // Update remaining work
          const newRemaining = issueRemaining - hours;
          remainingWork.set(issue.id, newRemaining);

          // Mark as completed if no remaining work
          if (newRemaining <= 0) {
            completedIssues.add(issue.id);
          }
        }
      }

      const percentage = capacityHours > 0 ? (loadHours / capacityHours) * 100 : 0;

      result.push({
        date: dateStr,
        loadHours: Math.round(loadHours * 100) / 100,
        capacityHours,
        percentage: Math.round(percentage),
        status: getCapacityStatus(percentage),
        breakdown,
      });
    }

    current.setUTCDate(current.getUTCDate() + 1);
  }

  return result;
}

/**
 * Aggregate scheduled capacity by zoom level.
 * Wraps calculateScheduledCapacity and aggregates results.
 */
export function calculateScheduledCapacityByZoom(
  issues: Issue[],
  schedule: WeeklySchedule,
  startDate: string,
  endDate: string,
  graph: DependencyGraph,
  internalEstimates: InternalEstimates,
  zoomLevel: CapacityZoomLevel,
  myUserId?: number,
  allIssuesMap?: Map<number, Issue>,
  precedenceIssues?: Set<number>
): PeriodCapacity[] {
  // Get daily scheduled capacity first
  const dailyData = calculateScheduledCapacity(
    issues,
    schedule,
    startDate,
    endDate,
    graph,
    internalEstimates,
    myUserId,
    allIssuesMap,
    precedenceIssues
  );

  if (dailyData.length === 0) {
    return [];
  }

  // For day zoom, convert directly to PeriodCapacity format
  if (zoomLevel === "day") {
    return dailyData.map((day) => ({
      startDate: day.date,
      endDate: day.date,
      loadHours: day.loadHours,
      capacityHours: day.capacityHours,
      percentage: day.percentage,
      status: day.status,
    }));
  }

  // Group days by period key (reusing existing logic)
  const periodGroups = new Map<string, ScheduledDailyCapacity[]>();

  for (const day of dailyData) {
    const date = new Date(day.date + "T00:00:00Z");
    const key = getPeriodKey(date, zoomLevel);

    if (!periodGroups.has(key)) {
      periodGroups.set(key, []);
    }
    periodGroups.get(key)!.push(day);
  }

  // Aggregate each period
  const periods: PeriodCapacity[] = [];
  for (const days of periodGroups.values()) {
    periods.push(aggregatePeriod(days));
  }

  // Sort by start date
  periods.sort((a, b) => a.startDate.localeCompare(b.startDate));

  return periods;
}
