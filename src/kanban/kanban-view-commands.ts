import * as vscode from "vscode";
import { showStatusBarMessage } from "../utilities/status-bar";
import { KanbanCommandDeps } from "./kanban-command-helpers";

/** Filter/sort commands (tree-provider gated). */
export function registerKanbanViewCommands(deps: KanbanCommandDeps): vscode.Disposable[] {
  const { treeProvider } = deps;
  const disposables: vscode.Disposable[] = [];

  // Filter/sort commands (only if tree provider is available)
  if (treeProvider) {
    // Filter commands
    disposables.push(
      vscode.commands.registerCommand("redmyne.kanban.filterAll", () => {
        treeProvider.setFilter("all");
        showStatusBarMessage("$(check) Showing all priorities", 2000);
      })
    );
    disposables.push(
      vscode.commands.registerCommand("redmyne.kanban.filterHigh", () => {
        treeProvider.setFilter("high");
        showStatusBarMessage("$(check) Showing high priority", 2000);
      })
    );
    disposables.push(
      vscode.commands.registerCommand("redmyne.kanban.filterMedium", () => {
        treeProvider.setFilter("medium");
        showStatusBarMessage("$(check) Showing medium priority", 2000);
      })
    );
    disposables.push(
      vscode.commands.registerCommand("redmyne.kanban.filterLow", () => {
        treeProvider.setFilter("low");
        showStatusBarMessage("$(check) Showing low priority", 2000);
      })
    );

    // Sort commands
    disposables.push(
      vscode.commands.registerCommand("redmyne.kanban.sortPriority", () => {
        treeProvider.setSort("priority");
        const { direction } = treeProvider.getSort();
        const arrow = direction === "asc" ? "↑" : "↓";
        showStatusBarMessage(`$(check) Sort by priority ${arrow}`, 2000);
      })
    );
    disposables.push(
      vscode.commands.registerCommand("redmyne.kanban.sortIssueId", () => {
        treeProvider.setSort("issueId");
        const { direction } = treeProvider.getSort();
        const arrow = direction === "asc" ? "↑" : "↓";
        showStatusBarMessage(`$(check) Sort by issue ID ${arrow}`, 2000);
      })
    );
  }

  return disposables;
}
