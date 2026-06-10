import { CustomField } from "../redmine/models/common";

/** Minimal shape needed for task-type filtering (Issue satisfies this). */
interface HasCustomFields {
  custom_fields?: CustomField[];
}

/**
 * Read the string value of the named custom field ("task type") on an issue,
 * or null when absent/empty/non-string.
 */
function taskTypeValue(issue: HasCustomFields, fieldName: string): string | null {
  const cf = issue.custom_fields?.find((c) => c.name === fieldName);
  const v = cf?.value;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Distinct task-type values present in the issues, sorted by name. Drives the
 * Issues-pane task-type filter picker, so it only offers values the user has.
 */
export function deriveTaskTypes(
  issues: readonly HasCustomFields[],
  fieldName: string
): string[] {
  const set = new Set<string>();
  for (const issue of issues) {
    const v = taskTypeValue(issue, fieldName);
    if (v) set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Keep only issues whose task-type matches. "any"/undefined passes all through.
 */
export function filterIssuesByTaskType<T extends HasCustomFields>(
  issues: readonly T[],
  fieldName: string,
  value: string | "any" | undefined
): T[] {
  if (value === undefined || value === null || value === "any") return [...issues];
  return issues.filter((i) => taskTypeValue(i, fieldName) === value);
}
