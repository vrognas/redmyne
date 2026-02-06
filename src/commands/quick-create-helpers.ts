import * as vscode from "vscode";
import { RedmineProject } from "../redmine/redmine-project";
import { WizardPickItem } from "../utilities/wizard";

export interface LabeledId {
  label: string;
  id: number;
}

export function mapNamedItemsToWizardPickItems<T extends { id: number; name: string }>(
  items: T[]
): WizardPickItem<LabeledId>[] {
  return items.map((item) => ({
    label: item.name,
    data: { label: item.name, id: item.id },
  }));
}

export function mapProjectsToWizardPickItems(
  projects: RedmineProject[]
): WizardPickItem<LabeledId>[] {
  return projects.map((project) => {
    const pickItem = project.toQuickPickItem();
    return {
      label: pickItem.label,
      description: pickItem.description,
      data: { label: pickItem.label, id: project.id },
    };
  });
}

export function findProjectByIdAsLabeledId(
  projects: RedmineProject[],
  projectId: number
): LabeledId | undefined {
  const project = projects.find((p) => p.id === projectId);
  return project ? { label: project.name, id: project.id } : undefined;
}

export function validateOptionalIsoDate(value: string): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(new Date(value).getTime())
    ? null
    : "Use YYYY-MM-DD format";
}

export function requireValueOrShowError<T>(
  value: T | undefined,
  message: string
): T | undefined {
  if (value === undefined) {
    vscode.window.showErrorMessage(message);
    return undefined;
  }
  return value;
}

export function requireNonEmptyStringOrShowError(
  value: string | undefined,
  message: string
): string | undefined {
  if (!value?.trim()) {
    vscode.window.showErrorMessage(message);
    return undefined;
  }
  return value;
}
