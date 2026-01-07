import * as vscode from "vscode";
import { adHocTracker } from "../utilities/adhoc-tracker";
import { parseTargetIssueId } from "../utilities/contribution-calculator";
import { TimeEntryNode } from "../trees/my-time-entries-tree";
import { RedmineServer } from "../redmine/redmine-server";
import { pickIssue } from "../utilities/issue-picker";

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

  // Pick target issue using search (skip time tracking - we're linking, not logging)
  const targetIssue = await pickIssue(server, "Contribute Time To...", {
    skipTimeTrackingCheck: true,
  });
  if (!targetIssue) return;

  const targetId = targetIssue.id;

  // Prevent self-contribution
  if (targetId === issueId) {
    vscode.window.showErrorMessage("Cannot contribute to self");
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

  // Update comment to include target reference with subject
  const currentComment = entry.comments || "";
  const existingTarget = parseTargetIssueId(currentComment);
  const targetRef = `#${targetId} ${targetIssue.subject}`;

  let newComment: string;
  if (existingTarget) {
    // Replace existing #<id> (and any following text) with new target
    newComment = currentComment.replace(/#\d+.*$/, targetRef).trim();
  } else {
    // Append target reference
    newComment = currentComment ? `${currentComment} ${targetRef}` : targetRef;
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

  // Remove #<id> and any following subject text from comment
  const newComment = currentComment.replace(/#\d+.*$/, "").trim();

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
