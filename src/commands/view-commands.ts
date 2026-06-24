/**
 * View Commands
 * Commands for toggling views, API output, and refresh
 */

import * as vscode from "vscode";
import { redmyneConfig } from "../utilities/redmyne-config";
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

  // Initialize toggle state from persisted value
  vscode.commands.executeCommand("setContext", "redmyne:showZeroDays", !deps.timeEntriesTree.getHideZeroDays());
  vscode.commands.executeCommand("setContext", "redmyne:showEmptyProjects", deps.projectsTree.getShowEmptyProjects());

  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.refreshIssues", debouncedRefresh),

    vscode.commands.registerCommand("redmyne.toggleTreeView", () => {
      vscode.commands.executeCommand(
        "setContext",
        "redmyne:treeViewStyle",
        ProjectsViewStyle.LIST
      );
      deps.projectsTree.setViewStyle(ProjectsViewStyle.LIST);
    }),

    vscode.commands.registerCommand("redmyne.toggleListView", () => {
      vscode.commands.executeCommand(
        "setContext",
        "redmyne:treeViewStyle",
        ProjectsViewStyle.TREE
      );
      deps.projectsTree.setViewStyle(ProjectsViewStyle.TREE);
    }),

    vscode.commands.registerCommand("redmyne.showApiOutput", () => {
      deps.outputChannel.show();
    }),

    vscode.commands.registerCommand("redmyne.clearApiOutput", () => {
      deps.outputChannel.clear();
      showStatusBarMessage("$(check) API output cleared", 2000);
    }),

    vscode.commands.registerCommand("redmyne.toggleApiLogging", async () => {
      const config = vscode.workspace.getConfiguration("redmyne");
      const currentValue = redmyneConfig.loggingEnabled();
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
    vscode.commands.registerCommand("redmyne.filterMyOpen", () => {
      deps.projectsTree.setFilter({ assignee: "me", status: "open" });
      showStatusBarMessage("$(account) My Open Issues", 2000);
    }),

    vscode.commands.registerCommand("redmyne.filterAllOpen", () => {
      deps.projectsTree.setFilter({ assignee: "any", status: "open" });
      showStatusBarMessage("$(eye) All Open Issues", 2000);
    }),

    vscode.commands.registerCommand("redmyne.filterMyClosed", () => {
      deps.projectsTree.setFilter({ assignee: "me", status: "closed" });
      showStatusBarMessage("$(archive) My Closed Issues", 2000);
    }),

    vscode.commands.registerCommand("redmyne.filterAll", () => {
      // The single show-everything action: any assignee/status, and also clears
      // the orthogonal, otherwise-invisible task-type filter (which setFilter
      // would preserve) and reveals empty projects.
      deps.projectsTree.setFilter({ assignee: "any", status: "any", showEmptyProjects: true, taskType: "any" });
      // Keep the menu's Show/Hide toggle in sync — filterAll forces empties on.
      vscode.commands.executeCommand("setContext", "redmyne:showEmptyProjects", true);
      showStatusBarMessage("$(list-flat) All Issues", 2000);
    }),

    vscode.commands.registerCommand("redmyne.filterMyIssues", () => {
      deps.projectsTree.setFilter({ assignee: "me", status: "any" });
      showStatusBarMessage("$(account) My Issues", 2000);
    }),

    // Empty-project visibility toggle (side pane only; the Gantt has its own).
    vscode.commands.registerCommand("redmyne.showEmptyProjects", () => {
      deps.projectsTree.setShowEmptyProjects(true);
      vscode.commands.executeCommand("setContext", "redmyne:showEmptyProjects", true);
      showStatusBarMessage("$(eye) Showing Empty Projects", 2000);
    }),

    vscode.commands.registerCommand("redmyne.hideEmptyProjects", () => {
      deps.projectsTree.setShowEmptyProjects(false);
      vscode.commands.executeCommand("setContext", "redmyne:showEmptyProjects", false);
      showStatusBarMessage("$(eye-closed) Hiding Empty Projects", 2000);
    }),

    vscode.commands.registerCommand("redmyne.filterByTaskType", async () => {
      const taskTypes = deps.projectsTree.getAvailableTaskTypes();
      if (taskTypes.length === 0) {
        const field = redmyneConfig.taskTypeField();
        showStatusBarMessage(`$(info) No "${field}" values in the loaded issues`, 3000);
        return;
      }
      const current = deps.projectsTree.getTaskTypeFilter();
      const items: (vscode.QuickPickItem & { value: string | "any" })[] = [
        { label: "All Task Types", value: "any", description: current === "any" ? "current" : undefined },
        ...taskTypes.map((t) => ({
          label: t,
          value: t,
          description: current === t ? "current" : undefined,
        })),
      ];
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Filter Issues by task type",
      });
      if (!pick) return;
      deps.projectsTree.setTaskTypeFilter(pick.value);
      showStatusBarMessage(`$(filter) Task type: ${pick.value === "any" ? "All" : pick.value}`, 2000);
    }),

    // Time entries filter commands
    vscode.commands.registerCommand("redmyne.timeFilterMy", () => {
      deps.timeEntriesTree.setShowAllUsers(false);
      showStatusBarMessage("$(account) My Time Entries", 2000);
    }),

    vscode.commands.registerCommand("redmyne.timeFilterAll", () => {
      deps.timeEntriesTree.setShowAllUsers(true);
      showStatusBarMessage("$(eye) All Time Entries", 2000);
    }),

    vscode.commands.registerCommand("redmyne.timeFilterToggleZeroDays", () => {
      deps.timeEntriesTree.setHideZeroDays(false);
      vscode.commands.executeCommand("setContext", "redmyne:showZeroDays", true);
      showStatusBarMessage("$(eye) Show 0% Days", 2000);
    }),

    vscode.commands.registerCommand("redmyne.timeFilterToggleZeroDaysOff", () => {
      deps.timeEntriesTree.setHideZeroDays(true);
      vscode.commands.executeCommand("setContext", "redmyne:showZeroDays", false);
      showStatusBarMessage("$(eye-closed) Hide 0% Days", 2000);
    }),

    // Issue sort commands
    vscode.commands.registerCommand("redmyne.issueSortId", () => {
      deps.projectsTree.setSort("id");
      showStatusBarMessage("$(arrow-swap) Sort by #ID", 2000);
    }),

    vscode.commands.registerCommand("redmyne.issueSortSubject", () => {
      deps.projectsTree.setSort("subject");
      showStatusBarMessage("$(arrow-swap) Sort by Subject", 2000);
    }),

    vscode.commands.registerCommand("redmyne.issueSortAssignee", () => {
      deps.projectsTree.setSort("assignee");
      showStatusBarMessage("$(arrow-swap) Sort by Assignee", 2000);
    }),

    // Time entries sort commands
    vscode.commands.registerCommand("redmyne.timeSortId", () => {
      deps.timeEntriesTree.setSort("id");
      showStatusBarMessage("$(arrow-swap) Sort by #ID", 2000);
    }),

    vscode.commands.registerCommand("redmyne.timeSortSubject", () => {
      deps.timeEntriesTree.setSort("subject");
      showStatusBarMessage("$(arrow-swap) Sort by Subject", 2000);
    }),

    vscode.commands.registerCommand("redmyne.timeSortComment", () => {
      deps.timeEntriesTree.setSort("comment");
      showStatusBarMessage("$(arrow-swap) Sort by Comment", 2000);
    }),

    vscode.commands.registerCommand("redmyne.timeSortUser", () => {
      deps.timeEntriesTree.setSort("user");
      showStatusBarMessage("$(arrow-swap) Sort by User", 2000);
    }),

    vscode.commands.registerCommand("redmyne.openTimeEntriesSettings", () => {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "redmyne.workingHours.weeklySchedule"
      );
    })
  );
}
