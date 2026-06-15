import * as vscode from "vscode";
import type { ActionProperties } from "./action-properties";
import { showStatusBarMessage } from "../utilities/status-bar";
import { wizardPick, wizardInput, wizardStep, runWizard } from "../utilities/wizard";
import { errorToString } from "../utilities/error-feedback";
import {
  findProjectByIdAsLabeledId,
  mapNamedItemsToWizardPickItems,
  mapProjectsToWizardPickItems,
  requireNonEmptyStringOrShowError,
  requireValueOrShowError,
  validateOptionalIsoDate,
} from "./quick-create-helpers";

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
    let startIndex = 0;

    // Pre-fill project if provided
    if (preselectedProjectId) {
      const project = findProjectByIdAsLabeledId(projects, preselectedProjectId);
      if (project) {
        state.project = project;
        startIndex = 1; // Skip project selection
      }
    }

    const steps = [
      wizardStep(
        (showBack) => wizardPick(mapProjectsToWizardPickItems(projects), {
          title: "Create Issue (1/7) - Project",
          placeHolder: "Select project",
        }, showBack),
        (v) => { state.project = v; }
      ),
      wizardStep(
        (showBack) => wizardPick(mapNamedItemsToWizardPickItems(trackers), {
          title: "Create Issue (2/7) - Tracker",
          placeHolder: "Select tracker",
        }, showBack),
        (v) => { state.tracker = v; }
      ),
      wizardStep(
        (showBack) => wizardPick(mapNamedItemsToWizardPickItems(priorities), {
          title: "Create Issue (3/7) - Priority",
          placeHolder: "Select priority",
        }, showBack),
        (v) => { state.priority = v; }
      ),
      wizardStep(
        (showBack) => wizardInput({
          title: "Create Issue (4/7) - Subject",
          prompt: `Issue subject for ${state.project?.label}`,
          placeHolder: "e.g., Implement login feature",
          validateInput: (v) => (v ? null : "Subject is required"),
          value: state.subject,
        }, showBack),
        (v) => { state.subject = v; }
      ),
      wizardStep(
        (showBack) => wizardInput({
          title: "Create Issue (5/7) - Description",
          prompt: "Description (optional, Enter to skip)",
          placeHolder: "Detailed description...",
          value: state.description,
        }, showBack),
        (v) => { state.description = v || undefined; }
      ),
      wizardStep(
        (showBack) => wizardInput({
          title: "Create Issue (6/7) - Estimated Hours",
          prompt: "Estimated hours (optional, Enter to skip)",
          placeHolder: "e.g., 8",
          validateInput: validateHours,
          value: state.hours,
        }, showBack),
        (v) => { state.hours = v || undefined; }
      ),
      wizardStep(
        (showBack) => wizardInput({
          title: "Create Issue (7/7) - Due Date",
          prompt: "Due date (optional, Enter to skip)",
          placeHolder: "YYYY-MM-DD",
          validateInput: validateOptionalIsoDate,
          value: state.dueDate,
        }, showBack),
        (v) => { state.dueDate = v || undefined; }
      ),
    ];

    if (!(await runWizard(steps, startIndex))) return undefined;

    const project = requireValueOrShowError(state.project, "Could not determine project");
    const tracker = requireValueOrShowError(state.tracker, "Could not determine tracker");
    const priority = requireValueOrShowError(state.priority, "Could not determine priority");
    const subject = requireNonEmptyStringOrShowError(state.subject, "Could not determine subject");
    if (!project || !tracker || !priority || !subject) return undefined;

    // All steps completed - create issue
    const response = await props.server.createIssue({
      project_id: project.id,
      tracker_id: tracker.id,
      priority_id: priority.id,
      subject,
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

    const steps = [
      wizardStep(
        (showBack) => wizardPick(mapNamedItemsToWizardPickItems(priorities), {
          title: `${prefix} (1/5) - Priority`,
          placeHolder: "Select priority",
        }, showBack),
        (v) => { state.priority = v; }
      ),
      wizardStep(
        (showBack) => wizardInput({
          title: `${prefix} (2/5) - Subject`,
          prompt: `Sub-issue of #${parent.id}: ${parent.subject}`,
          placeHolder: "e.g., Subtask description",
          validateInput: (v) => (v ? null : "Subject is required"),
          value: state.subject,
        }, showBack),
        (v) => { state.subject = v; }
      ),
      wizardStep(
        (showBack) => wizardInput({
          title: `${prefix} (3/5) - Description`,
          prompt: "Description (optional, Enter to skip)",
          placeHolder: "Detailed description...",
          value: state.description,
        }, showBack),
        (v) => { state.description = v || undefined; }
      ),
      wizardStep(
        (showBack) => wizardInput({
          title: `${prefix} (4/5) - Estimated Hours`,
          prompt: "Estimated hours (optional, Enter to skip)",
          placeHolder: "e.g., 8",
          validateInput: validateHours,
          value: state.hours,
        }, showBack),
        (v) => { state.hours = v || undefined; }
      ),
      wizardStep(
        (showBack) => wizardInput({
          title: `${prefix} (5/5) - Due Date`,
          prompt: "Due date (optional, Enter to skip)",
          placeHolder: "YYYY-MM-DD",
          validateInput: validateOptionalIsoDate,
          value: state.dueDate,
        }, showBack),
        (v) => { state.dueDate = v || undefined; }
      ),
    ];

    if (!(await runWizard(steps))) return undefined;

    const priority = requireValueOrShowError(state.priority, "Could not determine priority");
    const subject = requireNonEmptyStringOrShowError(state.subject, "Could not determine subject");
    if (!priority || !subject) return undefined;

    const response = await props.server.createIssue({
      project_id: parent.project.id,
      tracker_id: parent.tracker.id,
      priority_id: priority.id,
      subject,
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
