import * as vscode from "vscode";
import type { ActionProperties } from "./action-properties";
import { showStatusBarMessage } from "../utilities/status-bar";
import { wizardPick, wizardInput, isBack, WizardPickItem } from "../utilities/wizard";
import { errorToString } from "../utilities/error-feedback";

interface CreatedIssue {
  id: number;
  subject: string;
}

// Validators
const validateHours = (v: string): string | null => {
  if (!v) return null; // empty is valid (optional field)
  const num = Number(v); // Number() returns NaN for "5abc", unlike parseFloat
  return !isNaN(num) && num >= 0 ? null : "Must be positive number";
};

const validateDate = (v: string): string | null => {
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v).getTime())
    ? null
    : "Use YYYY-MM-DD format";
};

/**
 * Quick create issue wizard with back navigation
 * @param props Action properties with server
 * @param preselectedProjectId Optional project ID to skip project selection step
 */
export async function quickCreateIssue(
  props: ActionProperties,
  preselectedProjectId?: number
): Promise<CreatedIssue | undefined> {
  try {
    // Parallel fetch metadata
    const [projects, trackers, priorities] = await Promise.all([
      props.server.getProjects(),
      props.server.getTrackers(),
      props.server.getPriorities(),
    ]);

    // State machine for wizard with back navigation
    type WizardState = {
      project?: { label: string; id: number };
      tracker?: { label: string; id: number };
      priority?: { label: string; id: number };
      subject?: string;
      description?: string;
      hours?: string;
      dueDate?: string;
    };

    const state: WizardState = {};
    let step = 1;

    // Pre-fill project if provided
    if (preselectedProjectId) {
      const project = projects.find(p => p.id === preselectedProjectId);
      if (project) {
        state.project = { label: project.name, id: project.id };
        step = 2; // Skip project selection
      }
    }

    while (step <= 7) {
      const showBack = step > 1;

      switch (step) {
        case 1: {
          const items: WizardPickItem<{ label: string; id: number }>[] = projects.map((p) => {
            const item = p.toQuickPickItem();
            return { label: item.label, description: item.description, data: { label: item.label, id: p.id } };
          });
          const result = await wizardPick(items, {
            title: "Create Issue (1/7) - Project",
            placeHolder: "Select project",
          }, showBack);

          if (result === undefined) return undefined;
          if (isBack(result)) { step--; continue; }
          state.project = result;
          step++;
          break;
        }

        case 2: {
          const items: WizardPickItem<{ label: string; id: number }>[] = trackers.map((t) => ({
            label: t.name,
            data: { label: t.name, id: t.id },
          }));
          const result = await wizardPick(items, {
            title: "Create Issue (2/7) - Tracker",
            placeHolder: "Select tracker",
          }, showBack);

          if (result === undefined) return undefined;
          if (isBack(result)) { step--; continue; }
          state.tracker = result;
          step++;
          break;
        }

        case 3: {
          const items: WizardPickItem<{ label: string; id: number }>[] = priorities.map((p) => ({
            label: p.name,
            data: { label: p.name, id: p.id },
          }));
          const result = await wizardPick(items, {
            title: "Create Issue (3/7) - Priority",
            placeHolder: "Select priority",
          }, showBack);

          if (result === undefined) return undefined;
          if (isBack(result)) { step--; continue; }
          state.priority = result;
          step++;
          break;
        }

        case 4: {
          const result = await wizardInput({
            title: "Create Issue (4/7) - Subject",
            prompt: `Issue subject for ${state.project?.label}`,
            placeHolder: "e.g., Implement login feature",
            validateInput: (v) => (v ? null : "Subject is required"),
            value: state.subject,
          }, showBack);

          if (result === undefined) return undefined;
          if (isBack(result)) { step--; continue; }
          state.subject = result;
          step++;
          break;
        }

        case 5: {
          const result = await wizardInput({
            title: "Create Issue (5/7) - Description",
            prompt: "Description (optional, Enter to skip)",
            placeHolder: "Detailed description...",
            value: state.description,
          }, showBack);

          if (result === undefined) return undefined;
          if (isBack(result)) { step--; continue; }
          state.description = result || undefined;
          step++;
          break;
        }

        case 6: {
          const result = await wizardInput({
            title: "Create Issue (6/7) - Estimated Hours",
            prompt: "Estimated hours (optional, Enter to skip)",
            placeHolder: "e.g., 8",
            validateInput: validateHours,
            value: state.hours,
          }, showBack);

          if (result === undefined) return undefined;
          if (isBack(result)) { step--; continue; }
          state.hours = result || undefined;
          step++;
          break;
        }

        case 7: {
          const result = await wizardInput({
            title: "Create Issue (7/7) - Due Date",
            prompt: "Due date (optional, Enter to skip)",
            placeHolder: "YYYY-MM-DD",
            validateInput: validateDate,
            value: state.dueDate,
          }, showBack);

          if (result === undefined) return undefined;
          if (isBack(result)) { step--; continue; }
          state.dueDate = result || undefined;
          step++;
          break;
        }
      }
    }

    // All steps completed - create issue
    const response = await props.server.createIssue({
      project_id: state.project!.id,
      tracker_id: state.tracker!.id,
      priority_id: state.priority!.id,
      subject: state.subject!,
      description: state.description,
      estimated_hours: state.hours ? parseFloat(state.hours) : undefined,
      due_date: state.dueDate,
    });

    showStatusBarMessage(`$(check) Created #${response.issue.id}: ${response.issue.subject}`);
    return { id: response.issue.id, subject: response.issue.subject };
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to create issue: ${errorToString(error)}`
    );
    return undefined;
  }
}

/**
 * Quick create sub-issue with back navigation - inherits parent's project and tracker
 */
export async function quickCreateSubIssue(
  props: ActionProperties,
  parentIssueId: number
): Promise<CreatedIssue | undefined> {
  try {
    const [parentResponse, priorities] = await Promise.all([
      props.server.getIssueById(parentIssueId),
      props.server.getPriorities(),
    ]);
    const parent = parentResponse.issue;
    if (parent.parent?.id) {
      vscode.window.showWarningMessage("Create Sub-Issue is only available for issues without a parent.");
      return undefined;
    }
    const prefix = `Sub-Issue of #${parent.id}`;

    // State machine for wizard
    type WizardState = {
      priority?: { label: string; id: number };
      subject?: string;
      description?: string;
      hours?: string;
      dueDate?: string;
    };

    const state: WizardState = {};
    let step = 1;

    while (step <= 5) {
      const showBack = step > 1;

      switch (step) {
        case 1: {
          const items: WizardPickItem<{ label: string; id: number }>[] = priorities.map((p) => ({
            label: p.name,
            data: { label: p.name, id: p.id },
          }));
          const result = await wizardPick(items, {
            title: `${prefix} (1/5) - Priority`,
            placeHolder: "Select priority",
          }, showBack);

          if (result === undefined) return undefined;
          if (isBack(result)) { step--; continue; }
          state.priority = result;
          step++;
          break;
        }

        case 2: {
          const result = await wizardInput({
            title: `${prefix} (2/5) - Subject`,
            prompt: `Sub-issue of #${parent.id}: ${parent.subject}`,
            placeHolder: "e.g., Subtask description",
            validateInput: (v) => (v ? null : "Subject is required"),
            value: state.subject,
          }, showBack);

          if (result === undefined) return undefined;
          if (isBack(result)) { step--; continue; }
          state.subject = result;
          step++;
          break;
        }

        case 3: {
          const result = await wizardInput({
            title: `${prefix} (3/5) - Description`,
            prompt: "Description (optional, Enter to skip)",
            placeHolder: "Detailed description...",
            value: state.description,
          }, showBack);

          if (result === undefined) return undefined;
          if (isBack(result)) { step--; continue; }
          state.description = result || undefined;
          step++;
          break;
        }

        case 4: {
          const result = await wizardInput({
            title: `${prefix} (4/5) - Estimated Hours`,
            prompt: "Estimated hours (optional, Enter to skip)",
            placeHolder: "e.g., 8",
            validateInput: validateHours,
            value: state.hours,
          }, showBack);

          if (result === undefined) return undefined;
          if (isBack(result)) { step--; continue; }
          state.hours = result || undefined;
          step++;
          break;
        }

        case 5: {
          const result = await wizardInput({
            title: `${prefix} (5/5) - Due Date`,
            prompt: "Due date (optional, Enter to skip)",
            placeHolder: "YYYY-MM-DD",
            validateInput: validateDate,
            value: state.dueDate,
          }, showBack);

          if (result === undefined) return undefined;
          if (isBack(result)) { step--; continue; }
          state.dueDate = result || undefined;
          step++;
          break;
        }
      }
    }

    const response = await props.server.createIssue({
      project_id: parent.project.id,
      tracker_id: parent.tracker.id,
      priority_id: state.priority!.id,
      subject: state.subject!,
      parent_issue_id: parentIssueId,
      description: state.description,
      estimated_hours: state.hours ? parseFloat(state.hours) : undefined,
      due_date: state.dueDate,
    });

    showStatusBarMessage(`$(check) Created #${response.issue.id} under #${parentIssueId}`);
    return { id: response.issue.id, subject: response.issue.subject };
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to create sub-issue: ${errorToString(error)}`
    );
    return undefined;
  }
}
