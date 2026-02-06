import * as vscode from "vscode";
import { quickLogTime } from "./quick-log-time";
import { quickCreateIssue, quickCreateSubIssue } from "./quick-create-issue";
import { quickCreateVersion } from "./quick-create-version";
import type { RegisterConfiguredCommand } from "./configured-command-registrar";
import type { ProjectsTree } from "../trees/projects-tree";
import type { MyTimeEntriesTreeDataProvider } from "../trees/my-time-entries-tree";
import type { WorkloadStatusBar } from "../status-bars/workload-status-bar";

export interface QuickIssueCommandsDeps {
  registerConfiguredCommand: RegisterConfiguredCommand;
  context: vscode.ExtensionContext;
  projectsTree: ProjectsTree;
  timeEntriesTree: MyTimeEntriesTreeDataProvider;
  getWorkloadStatusBar: () => WorkloadStatusBar | undefined;
}

function getNumericId(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function getIssueIdFromArg(value: unknown): number | undefined {
  if (value && typeof value === "object" && "id" in value) {
    return getNumericId((value as { id?: unknown }).id);
  }
  return getNumericId(value);
}

function getProjectIdFromArg(value: unknown): number | undefined {
  if (value && typeof value === "object" && "project" in value) {
    const project = (value as { project?: { id?: unknown } }).project;
    return getNumericId(project?.id);
  }
  return getNumericId(value);
}

export function registerQuickIssueCommands(deps: QuickIssueCommandsDeps): void {
  const registerCommand = deps.registerConfiguredCommand;

  registerCommand("quickLogTime", (props, ...args) => {
    // Extract issue ID from tree node (Issue) or Gantt context ({ id: number }).
    const issueId = getIssueIdFromArg(args[0]);
    return quickLogTime(props, deps.context, undefined, issueId);
  });

  registerCommand("quickCreateIssue", async (props, ...args) => {
    // Extract project ID from tree node if invoked from context menu.
    // ProjectNode has project.id, not direct id.
    const projectId = getProjectIdFromArg(args[0]);
    const created = await quickCreateIssue(props, projectId);
    if (created) {
      deps.projectsTree.clearProjects();
      deps.projectsTree.refresh();
    }
  });

  registerCommand("quickCreateSubIssue", async (props, ...args) => {
    // Extract parent issue ID from tree node or command argument
    let parentId = getIssueIdFromArg(args[0]);
    if (parentId === undefined && typeof args[0] === "string") {
      const parsed = parseInt(args[0], 10);
      if (!isNaN(parsed)) {
        parentId = parsed;
      }
    }

    if (!parentId) {
      const input = await vscode.window.showInputBox({
        prompt: "Enter parent issue ID",
        placeHolder: "e.g., 123",
        validateInput: (v) => /^\d+$/.test(v) ? null : "Must be a number",
      });
      if (!input) return;
      parentId = parseInt(input, 10);
    }

    const created = await quickCreateSubIssue(props, parentId);
    if (created) {
      deps.projectsTree.clearProjects();
      deps.projectsTree.refresh();
    }
  });

  registerCommand("quickCreateVersion", async (props, ...args) => {
    // Extract project ID from tree node if invoked from context menu.
    // ProjectNode has project.id, not direct id.
    const projectId = getProjectIdFromArg(args[0]);
    const created = await quickCreateVersion(props, projectId);
    if (created) {
      // Refresh Gantt if open to show new milestone
      vscode.commands.executeCommand("redmyne.refreshGantt");
    }
  });

  registerCommand("refreshTimeEntries", () => {
    deps.timeEntriesTree.refresh();
  });

  registerCommand("loadEarlierTimeEntries", () => {
    deps.timeEntriesTree.loadEarlierMonths();
  });

  // Refresh after issue update (status change, etc.) - updates workload and trees
  registerCommand("refreshAfterIssueUpdate", () => {
    deps.projectsTree.refresh();
    deps.getWorkloadStatusBar()?.update();
  });
}
