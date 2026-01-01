/**
 * Dependency Extractor
 *
 * Extracts scheduling dependency IDs from issues for "My Work" view.
 * Only includes direct dependencies (blocks/blocked/precedes/follows).
 */

import type { Issue, IssueRelation } from "../redmine/models/issue";

/** Relation types that affect scheduling (not just informational) */
export const SCHEDULING_RELATION_TYPES: IssueRelation["relation_type"][] = [
  "blocks",
  "blocked",
  "precedes",
  "follows",
  // Extended scheduling types (Gantt plugin)
  "finish_to_start",
  "start_to_start",
  "finish_to_finish",
  "start_to_finish",
];

/**
 * Extract external dependency issue IDs from scheduling relations.
 *
 * @param issues - Issues to extract dependencies from
 * @returns Set of issue IDs that are scheduling dependencies but not in input
 */
export function extractSchedulingDependencyIds(issues: Issue[]): Set<number> {
  const ownIds = new Set(issues.map((i) => i.id));
  const dependencyIds = new Set<number>();

  for (const issue of issues) {
    if (!issue.relations) continue;

    for (const rel of issue.relations) {
      // Only scheduling relations
      if (!SCHEDULING_RELATION_TYPES.includes(rel.relation_type)) continue;

      // Target is external (not in our set)
      if (!ownIds.has(rel.issue_to_id)) {
        dependencyIds.add(rel.issue_to_id);
      }
    }
  }

  return dependencyIds;
}
