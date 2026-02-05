/**
 * Closed Issue Guard
 * Confirms with user before logging time on closed issues
 */

import * as vscode from "vscode";
import type { RedmineServer } from "../redmine/redmine-server";
import type { Issue } from "../redmine/models/issue";

/**
 * Check if issue is closed and prompt for confirmation if so.
 * @param server Redmine server to fetch issue from
 * @param issueId Issue ID to check
 * @param issue Optional pre-fetched issue (skips fetch if provided)
 * @returns true to proceed, false to cancel
 */
export async function confirmLogTimeOnClosedIssue(
  server: RedmineServer,
  issueId: number,
  issue?: Pick<Issue, "id" | "status">
): Promise<boolean> {
  // Fetch issue if not provided
  const issueData = issue ?? (await server.getIssueById(issueId)).issue;

  // Open issue - proceed without dialog
  if (!issueData.status?.is_closed) {
    return true;
  }

  // Closed issue - confirm with user
  const choice = await vscode.window.showWarningMessage(
    `Issue #${issueId} is closed. Log time anyway?`,
    { modal: true },
    "Log Time"
  );

  return choice === "Log Time";
}

/**
 * Check if any issues in batch are closed and prompt once for all.
 * @param server Redmine server to fetch issues from
 * @param issueIds Issue IDs to check
 * @returns true to proceed, false to cancel
 */
export async function confirmLogTimeOnClosedIssues(
  server: RedmineServer,
  issueIds: number[]
): Promise<boolean> {
  // Deduplicate
  const uniqueIds = [...new Set(issueIds)];
  if (uniqueIds.length === 0) return true;

  // Fetch all issues in parallel
  const issues = await Promise.all(
    uniqueIds.map(async (id) => {
      const result = await server.getIssueById(id);
      return result.issue;
    })
  );

  // Find closed issues
  const closedIssues = issues.filter((i) => i.status?.is_closed);

  // All open - proceed without dialog
  if (closedIssues.length === 0) {
    return true;
  }

  // Show single confirmation for batch
  const message =
    closedIssues.length === 1
      ? `Issue #${closedIssues[0].id} is closed. Log time anyway?`
      : `${closedIssues.length} issues are closed (#${closedIssues.map((i) => i.id).join(", #")}). Log time anyway?`;

  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    "Log Time"
  );

  return choice === "Log Time";
}
