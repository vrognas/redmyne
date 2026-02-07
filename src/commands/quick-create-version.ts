import * as vscode from "vscode";
import type { ActionProperties } from "./action-properties";
import { showStatusBarMessage } from "../utilities/status-bar";
import { wizardPick, wizardInput, isBack, WizardPickItem } from "../utilities/wizard";
import { errorToString } from "../utilities/error-feedback";
import {
  findProjectByIdAsLabeledId,
  mapProjectsToWizardPickItems,
  requireNonEmptyStringOrShowError,
  requireValueOrShowError,
  validateOptionalIsoDate,
} from "./quick-create-helpers";

interface CreatedVersion {
  id: number;
  name: string;
}

/**
 * Quick create version wizard
 * @param props Action properties with server
 * @param preselectedProjectId Optional project ID to skip project selection
 */
export async function quickCreateVersion(
  props: ActionProperties,
  preselectedProjectId?: number
): Promise<CreatedVersion | undefined> {
  try {
    const projects = await props.server.getProjects();

    type WizardState = {
      project?: { label: string; id: number };
      name?: string;
      description?: string;
      dueDate?: string;
      status?: "open" | "locked" | "closed";
    };

    const state: WizardState = {};
    let step = 1;

    // Pre-fill project if provided
    if (preselectedProjectId) {
      const project = findProjectByIdAsLabeledId(projects, preselectedProjectId);
      if (project) {
        state.project = project;
        step = 2;
      }
    }

    while (step <= 5) {
      const showBack = step > 1;

      switch (step) {
        case 1: {
          const items = mapProjectsToWizardPickItems(projects);
          const result = await wizardPick(items, {
            title: "Create Version (1/5) - Project",
            placeHolder: "Select project",
          }, showBack);

          if (result === undefined) return undefined;
          if (isBack(result)) return undefined;
          state.project = result;
          step++;
          break;
        }

        case 2: {
          const result = await wizardInput({
            title: "Create Version (2/5) - Name",
            prompt: "Version name (e.g., v1.0, Sprint 23, Q1 Release)",
            value: state.name,
            validateInput: (v) => v.trim() ? null : "Name is required",
          }, showBack);

          if (result === undefined) return undefined;
          if (isBack(result)) { step--; continue; }
          state.name = result;
          step++;
          break;
        }

        case 3: {
          const result = await wizardInput({
            title: "Create Version (3/5) - Due Date",
            prompt: "Due date (YYYY-MM-DD, optional)",
            value: state.dueDate,
            validateInput: validateOptionalIsoDate,
          }, showBack);

          if (result === undefined) return undefined;
          if (isBack(result)) { step--; continue; }
          state.dueDate = result || undefined;
          step++;
          break;
        }

        case 4: {
          const result = await wizardInput({
            title: "Create Version (4/5) - Description",
            prompt: "Description (optional)",
            value: state.description,
          }, showBack);

          if (result === undefined) return undefined;
          if (isBack(result)) { step--; continue; }
          state.description = result || undefined;
          step++;
          break;
        }

        case 5: {
          const items: WizardPickItem<"open" | "locked" | "closed">[] = [
            { label: "Open", description: "Active version, issues can be assigned", data: "open" },
            { label: "Locked", description: "No new issues, existing can be modified", data: "locked" },
            { label: "Closed", description: "Completed version, no modifications", data: "closed" },
          ];
          const result = await wizardPick(items, {
            title: "Create Version (5/5) - Status",
            placeHolder: "Select status",
          }, showBack);

          if (result === undefined) return undefined;
          if (isBack(result)) { step--; continue; }
          state.status = result;
          step++;
          break;
        }
      }
    }

    const project = requireValueOrShowError(state.project, "Could not determine project");
    const name = requireNonEmptyStringOrShowError(state.name, "Could not determine version name");
    if (!project || !name) return undefined;

    // Create the version
    const version = await props.server.createVersion(project.id, {
      name,
      description: state.description,
      due_date: state.dueDate,
      status: state.status,
    });

    showStatusBarMessage(`Created version: ${version.name}`);
    return { id: version.id, name: version.name };
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to create version: ${errorToString(error)}`);
    return undefined;
  }
}
