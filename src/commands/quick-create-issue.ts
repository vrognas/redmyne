import * as vscode from "vscode";
import type { ActionProperties } from "./action-properties";
import { showStatusBarMessage } from "../utilities/status-bar";
import { Issue } from "../redmine/models/issue";

interface CreatedIssue {
  id: number;
  subject: string;
}

/**
 * Validates estimated hours input
 */
function validateEstimatedHours(value: string): string | null {
  if (!value) return null; // optional
  const hours = parseFloat(value);
  if (isNaN(hours) || hours < 0) {
    return "Must be a positive number";
  }
  return null;
}

/**
 * Validates due date format (YYYY-MM-DD)
 */
function validateDueDate(value: string): string | null {
  if (!value) return null; // optional
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(value)) {
    return "Use YYYY-MM-DD format (e.g., 2025-12-31)";
  }
  // Validate it's a real date
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return "Invalid date";
  }
  return null;
}

/**
 * Quick create issue wizard - full flow
 */
export async function quickCreateIssue(
  props: ActionProperties
): Promise<CreatedIssue | undefined> {
  try {
    // 1. Select project
    const projects = await props.server.getProjects();
    const projectPick = await vscode.window.showQuickPick(
      projects.map((p) => ({
        label: p.name,
        identifier: p.identifier,
        id: p.id,
      })),
      {
        title: "Create Issue (1/6) - Project",
        placeHolder: "Select project",
      }
    );
    if (!projectPick) return undefined;

    // 2. Select tracker
    const trackers = await props.server.getTrackers();
    const trackerPick = await vscode.window.showQuickPick(
      trackers.map((t) => ({
        label: t.name,
        id: t.id,
      })),
      {
        title: "Create Issue (2/6) - Tracker",
        placeHolder: "Select tracker type",
      }
    );
    if (!trackerPick) return undefined;

    // 3. Select priority
    const priorities = await props.server.getPriorities();
    const priorityPick = await vscode.window.showQuickPick(
      priorities.map((p) => ({
        label: p.name,
        id: p.id,
      })),
      {
        title: "Create Issue (3/6) - Priority",
        placeHolder: "Select priority",
      }
    );
    if (!priorityPick) return undefined;

    // 4. Enter subject (required)
    const subject = await vscode.window.showInputBox({
      title: "Create Issue (4/6) - Subject",
      prompt: `Issue subject for ${projectPick.label}`,
      placeHolder: "e.g., Implement login feature",
      validateInput: (value) => (value ? null : "Subject is required"),
    });
    if (subject === undefined) return undefined;

    // 5. Enter description (optional)
    const description = await vscode.window.showInputBox({
      title: "Create Issue (5/6) - Description",
      prompt: "Description (optional, press Enter to skip)",
      placeHolder: "Detailed description...",
    });
    if (description === undefined) return undefined;

    // 6. Enter estimated hours (optional)
    const estimatedHoursInput = await vscode.window.showInputBox({
      title: "Create Issue (6/6) - Estimated Hours",
      prompt: "Estimated hours (optional, press Enter to skip)",
      placeHolder: "e.g., 8",
      validateInput: validateEstimatedHours,
    });
    if (estimatedHoursInput === undefined) return undefined;

    // 7. Enter due date (optional)
    const dueDate = await vscode.window.showInputBox({
      title: "Create Issue (7/7) - Due Date",
      prompt: "Due date (optional, press Enter to skip)",
      placeHolder: "YYYY-MM-DD",
      validateInput: validateDueDate,
    });
    if (dueDate === undefined) return undefined;

    // Build issue payload
    const issuePayload: {
      project_id: number;
      tracker_id: number;
      subject: string;
      description?: string;
      priority_id: number;
      estimated_hours?: number;
      due_date?: string;
    } = {
      project_id: projectPick.id,
      tracker_id: trackerPick.id,
      subject,
      priority_id: priorityPick.id,
    };

    if (description) {
      issuePayload.description = description;
    }
    if (estimatedHoursInput) {
      issuePayload.estimated_hours = parseFloat(estimatedHoursInput);
    }
    if (dueDate) {
      issuePayload.due_date = dueDate;
    }

    // Create issue
    const response = await props.server.createIssue(issuePayload);
    const created = response.issue;

    showStatusBarMessage(`$(check) Created #${created.id}: ${created.subject}`);

    return { id: created.id, subject: created.subject };
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to create issue: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

/**
 * Quick create sub-issue - inherits parent's project and tracker
 */
export async function quickCreateSubIssue(
  props: ActionProperties,
  parentIssueId: number
): Promise<CreatedIssue | undefined> {
  try {
    // Fetch parent issue to get project and tracker
    const parentResponse = await props.server.getIssueById(parentIssueId);
    const parent: Issue = parentResponse.issue;

    // 1. Select priority
    const priorities = await props.server.getPriorities();
    const priorityPick = await vscode.window.showQuickPick(
      priorities.map((p) => ({
        label: p.name,
        id: p.id,
      })),
      {
        title: `Sub-Issue of #${parent.id} (1/4) - Priority`,
        placeHolder: "Select priority",
      }
    );
    if (!priorityPick) return undefined;

    // 2. Enter subject (required)
    const subject = await vscode.window.showInputBox({
      title: `Sub-Issue of #${parent.id} (2/4) - Subject`,
      prompt: `Sub-issue of #${parent.id}: ${parent.subject}`,
      placeHolder: "e.g., Subtask description",
      validateInput: (value) => (value ? null : "Subject is required"),
    });
    if (subject === undefined) return undefined;

    // 3. Enter description (optional)
    const description = await vscode.window.showInputBox({
      title: `Sub-Issue of #${parent.id} (3/4) - Description`,
      prompt: "Description (optional, press Enter to skip)",
      placeHolder: "Detailed description...",
    });
    if (description === undefined) return undefined;

    // 4. Enter estimated hours (optional)
    const estimatedHoursInput = await vscode.window.showInputBox({
      title: `Sub-Issue of #${parent.id} (4/4) - Estimated Hours`,
      prompt: "Estimated hours (optional, press Enter to skip)",
      placeHolder: "e.g., 4",
      validateInput: validateEstimatedHours,
    });
    if (estimatedHoursInput === undefined) return undefined;

    // 5. Enter due date (optional)
    const dueDate = await vscode.window.showInputBox({
      title: `Sub-Issue of #${parent.id} (5/5) - Due Date`,
      prompt: "Due date (optional, press Enter to skip)",
      placeHolder: "YYYY-MM-DD",
      validateInput: validateDueDate,
    });
    if (dueDate === undefined) return undefined;

    // Build issue payload - inherit project and tracker from parent
    const issuePayload: {
      project_id: number;
      tracker_id: number;
      subject: string;
      description?: string;
      priority_id: number;
      estimated_hours?: number;
      due_date?: string;
      parent_issue_id: number;
    } = {
      project_id: parent.project.id,
      tracker_id: parent.tracker.id,
      subject,
      priority_id: priorityPick.id,
      parent_issue_id: parentIssueId,
    };

    if (description) {
      issuePayload.description = description;
    }
    if (estimatedHoursInput) {
      issuePayload.estimated_hours = parseFloat(estimatedHoursInput);
    }
    if (dueDate) {
      issuePayload.due_date = dueDate;
    }

    // Create sub-issue
    const response = await props.server.createIssue(issuePayload);
    const created = response.issue;

    showStatusBarMessage(
      `$(check) Created #${created.id} under #${parentIssueId}`
    );

    return { id: created.id, subject: created.subject };
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to create sub-issue: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}
