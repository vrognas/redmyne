/**
 * Issue Sorting Utility
 * Shared logic for sorting issues by risk/flexibility
 */

import { Issue } from "../redmine/models/issue";
import { FlexibilityScore } from "./flexibility-calculator";
import { SortConfig, IssueSortField } from "../redmine/models/common";
import { isBlocked } from "./tree-item-factory";

type FlexibilityStatus = FlexibilityScore["status"];

/**
 * Get sort priority for flexibility status (lower = more urgent)
 */
function getStatusPriority(status: FlexibilityStatus): number {
  switch (status) {
    case "overbooked": return 0;
    case "at-risk": return 1;
    case "on-track": return 2;
    case "completed": return 3;
    default: return 4;
  }
}

/**
 * Sort issues by risk/flexibility
 * Blocked issues sink to bottom, then sorted by flexibility status and remaining hours
 */
export function sortIssuesByRisk(
  issues: Issue[],
  flexibilityCache: Map<number, FlexibilityScore | null>
): Issue[] {
  return [...issues].sort((a, b) => {
    // Blocked issues sink to bottom
    const blockedA = isBlocked(a);
    const blockedB = isBlocked(b);
    if (blockedA && !blockedB) return 1;
    if (!blockedA && blockedB) return -1;

    const flexA = flexibilityCache.get(a.id);
    const flexB = flexibilityCache.get(b.id);

    // No flexibility data - sort by ID
    if (!flexA && !flexB) return b.id - a.id;
    if (!flexA) return 1;
    if (!flexB) return -1;

    // Sort by status priority
    const priorityA = getStatusPriority(flexA.status);
    const priorityB = getStatusPriority(flexB.status);
    if (priorityA !== priorityB) return priorityA - priorityB;

    // Same status - sort by remaining hours (ascending)
    return flexA.remaining - flexB.remaining;
  });
}

/**
 * Sort issues by field
 */
export function sortIssuesByField(
  issues: Issue[],
  sort: SortConfig<IssueSortField>
): Issue[] {
  const dir = sort.direction === "asc" ? 1 : -1;
  return [...issues].sort((a, b) => {
    switch (sort.field) {
      case "id":
        return (a.id - b.id) * dir;
      case "subject":
        return a.subject.localeCompare(b.subject) * dir;
      case "assignee": {
        const nameA = a.assigned_to?.name || "";
        const nameB = b.assigned_to?.name || "";
        return nameA.localeCompare(nameB) * dir;
      }
      default:
        return 0;
    }
  });
}
