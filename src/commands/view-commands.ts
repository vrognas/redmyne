/**
 * View Commands
 * Commands for toggling views, API output, and refresh
 */

import * as vscode from "vscode";
import { ProjectsTree, ProjectsViewStyle } from "../trees/projects-tree";
import { MyTimeEntriesTreeDataProvider } from "../trees/my-time-entries-tree";
import { showStatusBarMessage } from "../utilities/status-bar";
import { debounce } from "../utilities/debounce";

const REFRESH_DEBOUNCE_MS = 300;

export interface ViewCommandDeps {
  projectsTree: ProjectsTree;
  timeEntriesTree: MyTimeEntriesTreeDataProvider;
  outputChannel: vscode.OutputChannel;
  updateConfiguredContext: () => Promise<void>;
}

export function registerViewCommands(
  context: vscode.ExtensionContext,
  deps: ViewCommandDeps
): void {
  const debouncedRefresh = debounce(REFRESH_DEBOUNCE_MS, () => {
    deps.projectsTree.clearProjects();
    deps.projectsTree.refresh();
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.refreshIssues", debouncedRefresh),

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
    }),

    // Issue filter commands
    vscode.commands.registerCommand("redmine.filterMyOpen", () => {
      deps.projectsTree.setFilter({ assignee: "me", status: "open" });
      showStatusBarMessage("$(account) My Open Issues", 2000);
    }),

    vscode.commands.registerCommand("redmine.filterAllOpen", () => {
      deps.projectsTree.setFilter({ assignee: "any", status: "open" });
      showStatusBarMessage("$(eye) All Open Issues", 2000);
    }),

    vscode.commands.registerCommand("redmine.filterMyClosed", () => {
      deps.projectsTree.setFilter({ assignee: "me", status: "closed" });
      showStatusBarMessage("$(archive) My Closed Issues", 2000);
    }),

    vscode.commands.registerCommand("redmine.filterAll", () => {
      deps.projectsTree.setFilter({ assignee: "any", status: "any" });
      showStatusBarMessage("$(list-flat) All Issues", 2000);
    }),

    // Time entries filter commands
    vscode.commands.registerCommand("redmine.timeFilterMy", () => {
      deps.timeEntriesTree.setShowAllUsers(false);
      showStatusBarMessage("$(account) My Time Entries", 2000);
    }),

    vscode.commands.registerCommand("redmine.timeFilterAll", () => {
      deps.timeEntriesTree.setShowAllUsers(true);
      showStatusBarMessage("$(eye) All Time Entries", 2000);
    }),

    // Issue sort commands
    vscode.commands.registerCommand("redmine.issueSortId", () => {
      deps.projectsTree.setSort("id");
      showStatusBarMessage("$(arrow-swap) Sort by #ID", 2000);
    }),

    vscode.commands.registerCommand("redmine.issueSortSubject", () => {
      deps.projectsTree.setSort("subject");
      showStatusBarMessage("$(arrow-swap) Sort by Subject", 2000);
    }),

    vscode.commands.registerCommand("redmine.issueSortAssignee", () => {
      deps.projectsTree.setSort("assignee");
      showStatusBarMessage("$(arrow-swap) Sort by Assignee", 2000);
    }),

    // Time entries sort commands
    vscode.commands.registerCommand("redmine.timeSortId", () => {
      deps.timeEntriesTree.setSort("id");
      showStatusBarMessage("$(arrow-swap) Sort by #ID", 2000);
    }),

    vscode.commands.registerCommand("redmine.timeSortSubject", () => {
      deps.timeEntriesTree.setSort("subject");
      showStatusBarMessage("$(arrow-swap) Sort by Subject", 2000);
    }),

    vscode.commands.registerCommand("redmine.timeSortComment", () => {
      deps.timeEntriesTree.setSort("comment");
      showStatusBarMessage("$(arrow-swap) Sort by Comment", 2000);
    }),

    vscode.commands.registerCommand("redmine.timeSortUser", () => {
      deps.timeEntriesTree.setSort("user");
      showStatusBarMessage("$(arrow-swap) Sort by User", 2000);
    })
  );
}
