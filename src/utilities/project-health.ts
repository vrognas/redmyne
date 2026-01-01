import type { Issue } from "../redmine/models/issue";
import { formatLocalDate } from "./date-utils";

/**
 * Project health status
 */
export type HealthStatus = "green" | "yellow" | "red" | "grey";

/**
 * Aggregated health metrics for a project
 */
export interface ProjectHealth {
  status: HealthStatus;
  counts: {
    total: number;
    open: number;
    closed: number;
    inProgress: number;
    blocked: number;
    overdue: number;
    atRisk: number;
  };
  progress: number; // 0-100
  hours: {
    estimated: number;
    spent: number;
  };
  reasons: string[]; // Human-readable explanations
}

// Thresholds for health calculation
const AT_RISK_DAYS = 5; // Due within N days
const AT_RISK_PROGRESS = 70; // Must be < N% done to be at-risk
const BLOCKED_YELLOW_THRESHOLD = 0.1; // >10% blocked = yellow
const BLOCKED_RED_THRESHOLD = 0.2; // >20% blocked = red
const DEFAULT_ESTIMATE_HOURS = 4; // Fallback for issues without estimates

// Status names that indicate "in progress"
const IN_PROGRESS_PATTERNS = ["progress", "doing", "active", "working"];

/**
 * Calculate project health from a list of issues
 * @param issues All issues in the project (including subprojects)
 * @param blockedIds Set of issue IDs that are blocked by unresolved dependencies
 */
export function calculateProjectHealth(
  issues: Issue[],
  blockedIds: Set<number>
): ProjectHealth {
  if (issues.length === 0) {
    return {
      status: "grey",
      counts: {
        total: 0,
        open: 0,
        closed: 0,
        inProgress: 0,
        blocked: 0,
        overdue: 0,
        atRisk: 0,
      },
      progress: 0,
      hours: { estimated: 0, spent: 0 },
      reasons: ["No issues"],
    };
  }

  const today = formatLocalDate(new Date());
  const atRiskDate = getDatePlusDays(new Date(), AT_RISK_DAYS);

  // Counters
  let total = 0;
  let open = 0;
  let closed = 0;
  let inProgress = 0;
  let blocked = 0;
  let overdue = 0;
  let atRisk = 0;

  // Hours
  let totalEstimated = 0;
  let totalSpent = 0;

  // Progress (weighted)
  let weightedProgress = 0;
  let totalWeight = 0;

  for (const issue of issues) {
    total++;

    const isClosed = issue.closed_on !== null;

    // Count by status
    if (isClosed) {
      closed++;
    } else {
      open++;

      // Check for "in progress" status
      const statusName = issue.status?.name?.toLowerCase() ?? "";
      if (IN_PROGRESS_PATTERNS.some((p) => statusName.includes(p))) {
        inProgress++;
      }

      // Check for blocked (only open issues)
      if (blockedIds.has(issue.id)) {
        blocked++;
      }

      // Check for overdue (only open issues with due date)
      if (issue.due_date && issue.due_date < today) {
        overdue++;
      }
      // Check for at-risk (due soon, low progress, not already overdue)
      else if (issue.due_date && issue.due_date <= atRiskDate) {
        const progress = issue.done_ratio ?? 0;
        if (progress < AT_RISK_PROGRESS) {
          atRisk++;
        }
      }
    }

    // Hours aggregation
    if (issue.estimated_hours !== null && issue.estimated_hours !== undefined) {
      totalEstimated += issue.estimated_hours;
    }
    totalSpent += issue.spent_hours ?? 0;

    // Progress calculation (weighted by estimate)
    const weight = issue.estimated_hours ?? DEFAULT_ESTIMATE_HOURS;
    const issueProgress = isClosed ? 100 : (issue.done_ratio ?? 0);
    weightedProgress += weight * issueProgress;
    totalWeight += weight;
  }

  // Calculate final progress percentage
  const progress = totalWeight > 0 ? Math.round(weightedProgress / totalWeight) : 0;

  // Calculate blocked ratio (against open issues only)
  const blockedRatio = open > 0 ? blocked / open : 0;

  // Determine health status and reasons
  const reasons: string[] = [];
  let status: HealthStatus;

  if (overdue > 0 || blockedRatio > BLOCKED_RED_THRESHOLD) {
    status = "red";
    if (overdue > 0) {
      reasons.push(`${overdue} overdue`);
    }
    if (blockedRatio > BLOCKED_RED_THRESHOLD) {
      reasons.push(`${blocked} blocked (${Math.round(blockedRatio * 100)}%)`);
    }
  } else if (atRisk > 0 || blockedRatio > BLOCKED_YELLOW_THRESHOLD) {
    status = "yellow";
    if (atRisk > 0) {
      reasons.push(`${atRisk} at risk`);
    }
    if (blockedRatio > BLOCKED_YELLOW_THRESHOLD) {
      reasons.push(`${blocked} blocked`);
    }
  } else {
    status = "green";
    reasons.push("On track");
  }

  return {
    status,
    counts: {
      total,
      open,
      closed,
      inProgress,
      blocked,
      overdue,
      atRisk,
    },
    progress,
    hours: {
      estimated: totalEstimated,
      spent: totalSpent,
    },
    reasons,
  };
}

/**
 * Get date string N days from now
 */
function getDatePlusDays(date: Date, days: number): string {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return formatLocalDate(result);
}
