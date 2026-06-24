import * as vscode from "vscode";
import { KanbanController } from "./kanban-controller";
import type { IRedmineServer } from "../redmine/redmine-server-interface";
import { KanbanTreeProvider } from "./kanban-tree-provider";
import { registerKanbanTaskCommands } from "./kanban-task-commands";
import { registerKanbanTimerCommands } from "./kanban-timer-commands";
import { registerKanbanSettingsCommands } from "./kanban-settings-commands";
import { registerKanbanViewCommands } from "./kanban-view-commands";

/**
 * Register all kanban commands. Thin orchestrator — each family lives in its
 * own kanban-*-commands.ts module; shared helpers in kanban-command-helpers.ts.
 */
export function registerKanbanCommands(
  context: vscode.ExtensionContext,
  controller: KanbanController,
  getServer: () => IRedmineServer | undefined,
  treeProvider?: KanbanTreeProvider
): vscode.Disposable[] {
  const deps = { context, controller, getServer, treeProvider };
  return [
    ...registerKanbanTaskCommands(deps),
    ...registerKanbanTimerCommands(deps),
    ...registerKanbanSettingsCommands(deps),
    ...registerKanbanViewCommands(deps),
  ];
}
