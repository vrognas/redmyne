import * as vscode from "vscode";
import type { KanbanController } from "./kanban-controller";
import { KanbanTreeProvider } from "./kanban-tree-provider";

export interface KanbanTreeSetupDeps {
  controller: KanbanController;
  globalState: vscode.Memento;
}

export interface KanbanTreeSetup {
  provider: KanbanTreeProvider;
  treeView: vscode.TreeView<unknown>;
}

export function createKanbanTreeSetup(
  deps: KanbanTreeSetupDeps
): KanbanTreeSetup {
  const provider = new KanbanTreeProvider(deps.controller, deps.globalState);

  const treeView = vscode.window.createTreeView("redmyne-explorer-kanban", {
    treeDataProvider: provider,
    dragAndDropController: provider,
    canSelectMany: true,
  });

  return { provider, treeView };
}
