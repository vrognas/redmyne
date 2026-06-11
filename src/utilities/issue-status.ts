import type { Issue } from "../redmine/models/issue";

/**
 * Whether an issue is closed RIGHT NOW.
 *
 * Check status.is_closed, never closed_on alone: reopened issues keep
 * their old closed_on timestamp forever. Falls back to closed_on only
 * when the payload's status lacks is_closed.
 */
export function isIssueClosed(
  issue: Pick<Issue, "closed_on"> & { status?: { is_closed?: boolean } }
): boolean {
  if (typeof issue.status?.is_closed === "boolean") {
    return issue.status.is_closed;
  }
  return issue.closed_on != null;
}
