import * as vscode from "vscode";
import type { RedmineServer } from "../redmine/redmine-server";
import { KanbanController } from "./kanban-controller";
import { KanbanStatusBar } from "./kanban-status-bar";
import type { KanbanTreeProvider } from "./kanban-tree-provider";
import { registerKanbanCommands } from "./kanban-commands";
import { registerKanbanTimerHandlers } from "./kanban-timer-handlers";
import { registerKanbanDoneTasksContext } from "./kanban-context-sync";
import { createKanbanTreeSetup } from "./kanban-tree-setup";

export interface KanbanSetupDeps {
  context: vscode.ExtensionContext;
  getServer: () => RedmineServer | undefined;
  refreshAfterTimeLog: () => void;
}

export interface KanbanSetupResult {
  controller: KanbanController;
  statusBar: KanbanStatusBar;
  treeProvider: KanbanTreeProvider;
  treeView: vscode.TreeView<unknown>;
}

export function setupKanban(deps: KanbanSetupDeps): KanbanSetupResult {
  const unitDuration = deps.context.globalState.get<number>(
    "redmyne.timer.unitDuration",
    60
  );
  const workDuration = Math.max(
    1,
    Math.min(
      deps.context.globalState.get<number>("redmyne.timer.workDuration", 45),
      unitDuration
    )
  );

  const controller = new KanbanController(deps.context.globalState, {
    workDurationSeconds: workDuration * 60,
  });

  const statusBar = new KanbanStatusBar(controller, deps.context.globalState);
  deps.context.subscriptions.push({ dispose: () => statusBar.dispose() });

  deps.context.subscriptions.push(
    ...registerKanbanTimerHandlers({
      controller,
      getServer: deps.getServer,
      globalState: deps.context.globalState,
      refreshAfterTimeLog: deps.refreshAfterTimeLog,
    })
  );

  const { provider: treeProvider, treeView } = createKanbanTreeSetup({
    controller,
    globalState: deps.context.globalState,
  });
  deps.context.subscriptions.push(treeView);

  deps.context.subscriptions.push(
    ...registerKanbanDoneTasksContext({
      controller,
    })
  );

  deps.context.subscriptions.push(
    ...registerKanbanCommands(
      deps.context,
      controller,
      deps.getServer,
      treeProvider
    )
  );

  return {
    controller,
    statusBar,
    treeProvider,
    treeView,
  };
}
