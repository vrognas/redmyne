import { NamedEntity } from "../redmine/models/common";

/** Minimal shape needed for tracker filtering (Issue satisfies this). */
interface HasTracker {
  tracker?: NamedEntity | null;
}

/**
 * Unique trackers ("task types") present in the issues, sorted by name.
 * Drives the Issues-pane task-type filter picker, so it only offers types the
 * user actually has.
 */
export function deriveTrackers(issues: readonly HasTracker[]): NamedEntity[] {
  const byId = new Map<number, string>();
  for (const issue of issues) {
    const t = issue.tracker;
    if (t && !byId.has(t.id)) byId.set(t.id, t.name);
  }
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Keep only issues matching the tracker id. "any"/undefined passes all through.
 */
export function filterIssuesByTracker<T extends HasTracker>(
  issues: readonly T[],
  tracker: number | "any" | undefined
): T[] {
  if (tracker == null || tracker === "any") return [...issues];
  return issues.filter((i) => i.tracker?.id === tracker);
}
