import * as vscode from "vscode";
import { adHocTracker } from "../utilities/adhoc-tracker";
import { parseTargetIssueId } from "../utilities/contribution-calculator";
import { TimeEntryNode } from "../trees/my-time-entries-tree";
import { RedmineServer } from "../redmine/redmine-server";

/** Issue tree item passed from context menu */
interface IssueItem {
  id: number;
}

/**
 * Toggle ad-hoc budget tag on an issue
 */
export async function toggleAdHoc(item: IssueItem | undefined): Promise<void> {
  if (!item?.id) {
    vscode.window.showErrorMessage("No issue selected");
    return;
  }

  const isNowAdHoc = adHocTracker.toggle(item.id);

  vscode.window.showInformationMessage(
    isNowAdHoc
      ? `Issue #${item.id} tagged as ad-hoc budget`
      : `Issue #${item.id} ad-hoc tag removed`
  );
}

/**
 * Set contribution target for a time entry on an ad-hoc issue
 */
export async function contributeToIssue(
  item: TimeEntryNode,
  server: RedmineServer | undefined,
  refreshCallback: () => void
): Promise<void> {
  if (!item?._entry) {
    vscode.window.showErrorMessage("No time entry selected");
    return;
  }

  if (!server) {
    vscode.window.showErrorMessage("Not connected to Redmine");
    return;
  }

  const entry = item._entry;
  const issueId = entry.issue?.id ?? entry.issue_id;

  // Verify entry is on an ad-hoc issue
  if (!adHocTracker.isAdHoc(issueId)) {
    vscode.window.showErrorMessage("Time entry is not on an ad-hoc issue");
    return;
  }

  // Get project ID from entry's issue
  let projectId: number | undefined;
  try {
    const { issue } = await server.getIssueById(issueId);
    projectId = issue.project?.id;
  } catch {
    vscode.window.showErrorMessage("Could not fetch issue details");
    return;
  }

  if (!projectId) {
    vscode.window.showErrorMessage("Could not determine project");
    return;
  }

  // Search for target issue within same project
  const targetIdStr = await vscode.window.showInputBox({
    prompt: "Enter target issue ID to contribute hours to",
    placeHolder: "e.g., 1234",
    validateInput: (value) => {
      if (!value) return "Issue ID required";
      if (!/^\d+$/.test(value)) return "Must be a number";
      if (parseInt(value, 10) === issueId) return "Cannot contribute to self";
      return null;
    },
  });

  if (!targetIdStr) return;

  const targetId = parseInt(targetIdStr, 10);

  // Verify target issue exists
  let targetIssue;
  try {
    const result = await server.getIssueById(targetId);
    targetIssue = result.issue;
  } catch {
    vscode.window.showErrorMessage(`Issue #${targetId} not found`);
    return;
  }

  // Warn if cross-project contribution
  if (targetIssue.project?.id !== projectId) {
    const proceed = await vscode.window.showWarningMessage(
      `Issue #${targetId} is in a different project (${targetIssue.project?.name ?? "unknown"}). Continue?`,
      "Yes",
      "Cancel"
    );
    if (proceed !== "Yes") return;
  }

  // Update comment to include target reference
  const currentComment = entry.comments || "";
  const existingTarget = parseTargetIssueId(currentComment);

  let newComment: string;
  if (existingTarget) {
    // Replace existing #<id> with new target
    newComment = currentComment.replace(/#\d+/, `#${targetId}`);
  } else {
    // Append target reference
    newComment = currentComment ? `${currentComment} #${targetId}` : `#${targetId}`;
  }

  try {
    await server.updateTimeEntry(entry.id!, { comments: newComment });
    vscode.window.showInformationMessage(
      `Time entry now contributes to issue #${targetId}`
    );
    refreshCallback();
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to update time entry: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Remove contribution target from a time entry
 */
export async function removeContribution(
  item: TimeEntryNode,
  server: RedmineServer | undefined,
  refreshCallback: () => void
): Promise<void> {
  if (!item?._entry) {
    vscode.window.showErrorMessage("No time entry selected");
    return;
  }

  if (!server) {
    vscode.window.showErrorMessage("Not connected to Redmine");
    return;
  }

  const entry = item._entry;
  const currentComment = entry.comments || "";
  const targetId = parseTargetIssueId(currentComment);

  if (!targetId) {
    vscode.window.showErrorMessage("Time entry has no contribution target");
    return;
  }

  // Remove #<id> from comment
  const newComment = currentComment.replace(/#\d+\s*/, "").trim();

  try {
    await server.updateTimeEntry(entry.id!, { comments: newComment });
    vscode.window.showInformationMessage(
      `Removed contribution to issue #${targetId}`
    );
    refreshCallback();
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to update time entry: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
