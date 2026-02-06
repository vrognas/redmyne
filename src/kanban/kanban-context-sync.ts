import * as vscode from "vscode";
import type { KanbanTask } from "./kanban-state";
import { getTaskStatus } from "./kanban-state";

type KanbanContextController = {
  getTasks: () => KanbanTask[];
  onTasksChange: (listener: () => void) => vscode.Disposable;
};

export interface KanbanDoneTasksContextDeps {
  controller: KanbanContextController;
}

export function registerKanbanDoneTasksContext(
  deps: KanbanDoneTasksContextDeps
): vscode.Disposable[] {
  const updateKanbanContext = () => {
    const tasks = deps.controller.getTasks();
    const hasDone = tasks.some((task) => getTaskStatus(task) === "done");
    vscode.commands.executeCommand(
      "setContext",
      "redmyne:hasKanbanDoneTasks",
      hasDone
    );
  };

  updateKanbanContext();

  return [deps.controller.onTasksChange(() => updateKanbanContext())];
}
