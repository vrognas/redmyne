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

export function registerQuickIssueCommands(deps: QuickIssueCommandsDeps): void {
  const registerCommand = deps.registerConfiguredCommand;

  registerCommand("quickLogTime", (props, ...args) => {
    // Extract issue ID from tree node (Issue) or Gantt context ({ id: number })
    let issueId: number | undefined;
    const arg = args[0] as Record<string, unknown> | undefined;
    if (arg && typeof arg === "object" && typeof arg.id === "number") {
      issueId = arg.id;
    }
    return quickLogTime(props, deps.context, undefined, issueId);
  });

  registerCommand("quickCreateIssue", async (props, ...args) => {
    // Extract project ID from tree node if invoked from context menu
    // ProjectNode has project.id, not direct id
    let projectId: number | undefined;
    if (args[0] && typeof args[0] === "object" && "project" in args[0]) {
      projectId = (args[0] as { project: { id: number } }).project.id;
    } else if (typeof args[0] === "number") {
      projectId = args[0];
    }
    const created = await quickCreateIssue(props, projectId);
    if (created) {
      deps.projectsTree.clearProjects();
      deps.projectsTree.refresh();
    }
  });

  registerCommand("quickCreateSubIssue", async (props, ...args) => {
    // Extract parent issue ID from tree node or command argument
    let parentId: number | undefined;
    if (args[0] && typeof args[0] === "object" && "id" in args[0]) {
      parentId = (args[0] as { id: number }).id;
    } else if (typeof args[0] === "number") {
      parentId = args[0];
    } else if (typeof args[0] === "string") {
      parentId = parseInt(args[0], 10);
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
    // Extract project ID from tree node if invoked from context menu
    // ProjectNode has project.id, not direct id
    let projectId: number | undefined;
    if (args[0] && typeof args[0] === "object" && "project" in args[0]) {
      projectId = (args[0] as { project: { id: number } }).project.id;
    } else if (typeof args[0] === "number") {
      projectId = args[0];
    }
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
