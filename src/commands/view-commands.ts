/**
 * View Commands
 * Commands for toggling views, API output, and refresh
 */

import * as vscode from "vscode";
import { ProjectsTree, ProjectsViewStyle } from "../trees/projects-tree";
import { showStatusBarMessage } from "../utilities/status-bar";

const CONFIG_DEBOUNCE_MS = 300;

export interface ViewCommandDeps {
  projectsTree: ProjectsTree;
  outputChannel: vscode.OutputChannel;
  updateConfiguredContext: () => Promise<void>;
}

export function registerViewCommands(
  context: vscode.ExtensionContext,
  deps: ViewCommandDeps
): void {
  let refreshTimeout: ReturnType<typeof setTimeout> | null = null;

  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.refreshIssues", () => {
      if (refreshTimeout) {
        clearTimeout(refreshTimeout);
      }
      refreshTimeout = setTimeout(() => {
        deps.projectsTree.clearProjects();
        deps.projectsTree.refresh();
      }, CONFIG_DEBOUNCE_MS);
    }),

    vscode.commands.registerCommand("redmine.toggleTreeView", () => {
      vscode.commands.executeCommand(
        "setContext",
        "redmine:treeViewStyle",
        ProjectsViewStyle.LIST
      );
      deps.projectsTree.setViewStyle(ProjectsViewStyle.LIST);
    }),

    vscode.commands.registerCommand("redmine.toggleListView", () => {
      vscode.commands.executeCommand(
        "setContext",
        "redmine:treeViewStyle",
        ProjectsViewStyle.TREE
      );
      deps.projectsTree.setViewStyle(ProjectsViewStyle.TREE);
    }),

    vscode.commands.registerCommand("redmine.showApiOutput", () => {
      deps.outputChannel.show();
    }),

    vscode.commands.registerCommand("redmine.clearApiOutput", () => {
      deps.outputChannel.clear();
      showStatusBarMessage("$(check) API output cleared", 2000);
    }),

    vscode.commands.registerCommand("redmine.toggleApiLogging", async () => {
      const config = vscode.workspace.getConfiguration("redmine");
      const currentValue = config.get<boolean>("logging.enabled") || false;
      await config.update(
        "logging.enabled",
        !currentValue,
        vscode.ConfigurationTarget.Global
      );
      showStatusBarMessage(
        `$(check) API logging ${!currentValue ? "enabled" : "disabled"}`,
        2000
      );
      await deps.updateConfiguredContext();
    })
  );
}
