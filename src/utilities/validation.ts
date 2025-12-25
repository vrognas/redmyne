/**
 * Shared validation utilities
 */

/**
 * Validate issue ID string
 * Returns true if valid numeric issue ID
 */
function validateIssueId(issueId: string | null | undefined): boolean {
  if (!issueId || !issueId.trim()) return false;
  const parsed = parseInt(issueId, 10);
  return !isNaN(parsed) && parsed > 0;
}

/**
 * Parse issue ID string to number
 * Returns null if invalid
 */
export function parseIssueId(issueId: string | null | undefined): number | null {
  if (!validateIssueId(issueId)) return null;
  return parseInt(issueId!, 10);
}
