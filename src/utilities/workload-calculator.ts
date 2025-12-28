/**
 * Workload Calculator for Status Bar Overview
 *
 * Calculates total workload across all assigned issues:
 * - Remaining work (estimated - spent)
 * - Available capacity this week
 * - Buffer (available - remaining)
 * - Top 3 urgent issues
 */

import { Issue } from "../redmine/models/issue";
import {
  WeeklySchedule,
  countWorkingDays,
  countAvailableHours,
} from "./flexibility-calculator";

export interface WorkloadSummary {
  /** Total estimated hours across all issues */
  totalEstimated: number;
  /** Total spent hours across all issues */
  totalSpent: number;
  /** Remaining work (estimated - spent) */
  remaining: number;
  /** Available working hours this week */
  availableThisWeek: number;
  /** Buffer = available - remaining (positive = capacity, negative = overbooked) */
  buffer: number;
  /** Top 3 most urgent issues (by days remaining) */
  topUrgent: UrgentIssue[];
}

export interface UrgentIssue {
  id: number;
  subject: string;
  daysLeft: number;
  hoursLeft: number;
}

/**
 * Calculate workload summary for status bar display
 */
export function calculateWorkload(
  issues: Issue[],
  schedule: WeeklySchedule,
  today: Date = new Date()
): WorkloadSummary {
  // Filter issues with estimates
  const withEstimates = issues.filter((i) => i.estimated_hours !== null);

  // Total estimated and spent
  const totalEstimated = withEstimates.reduce(
    (sum, i) => sum + (i.estimated_hours ?? 0),
    0
  );
  const totalSpent = withEstimates.reduce(
    (sum, i) => sum + (i.spent_hours ?? 0),
    0
  );
  const remaining = Math.max(totalEstimated - totalSpent, 0);

  // Available capacity this week
  const weekEnd = getWeekEnd(today);
  const availableThisWeek = countAvailableHours(today, weekEnd, schedule);
  const buffer = availableThisWeek - remaining;

  // Top 3 urgent (open issues with due dates, sorted by days remaining)
  // Optimization: pre-sort by raw due_date (cheap), then only compute daysLeft for top candidates
  const withDueDates = issues
    .filter((i) => i.due_date && i.done_ratio !== 100)
    .sort((a, b) => new Date(a.due_date!).getTime() - new Date(b.due_date!).getTime())
    .slice(0, 6); // Take top 6 candidates (due date order approximates urgency)

  const topUrgent = withDueDates
    .map((i) => ({
      id: i.id,
      subject: i.subject,
      daysLeft: countWorkingDays(today, new Date(i.due_date!), schedule),
      hoursLeft: Math.max((i.estimated_hours ?? 0) - (i.spent_hours ?? 0), 0),
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, 3);

  return {
    totalEstimated,
    totalSpent,
    remaining,
    availableThisWeek,
    buffer,
    topUrgent,
  };
}

/**
 * Get Friday of the current week
 */
function getWeekEnd(today: Date): Date {
  const date = new Date(today);
  const dayOfWeek = date.getDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  const daysToFriday = dayOfWeek <= 5 ? 5 - dayOfWeek : -1; // If Sat, go back to Fri
  date.setDate(date.getDate() + daysToFriday);
  return date;
}
