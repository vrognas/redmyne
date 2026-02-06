import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerKanbanDoneTasksContext } from "../../../src/kanban/kanban-context-sync";
import { createKanbanTask, type KanbanTask } from "../../../src/kanban/kanban-state";

describe("registerKanbanDoneTasksContext", () => {
  let tasks: KanbanTask[];
  let onTasksChangeListener: (() => void) | undefined;

  let controller: {
    getTasks: ReturnType<typeof vi.fn>;
    onTasksChange: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    tasks = [];
    onTasksChangeListener = undefined;

    controller = {
      getTasks: vi.fn(() => tasks),
      onTasksChange: vi.fn((listener: () => void) => {
        onTasksChangeListener = listener;
        return { dispose: vi.fn() } as unknown as vscode.Disposable;
      }),
    };
  });

  it("registers listener and sets context to false when no done tasks", () => {
    const disposables = registerKanbanDoneTasksContext({
      controller: controller as never,
    });

    expect(disposables).toHaveLength(1);
    expect(controller.onTasksChange).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "redmyne:hasKanbanDoneTasks",
      false
    );
  });

  it("sets context to true when at least one task is done", () => {
    const doneTask = createKanbanTask("Done", 1, "Issue", 1, "Project");
    doneTask.completedAt = new Date().toISOString();
    tasks = [doneTask];

    registerKanbanDoneTasksContext({
      controller: controller as never,
    });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "redmyne:hasKanbanDoneTasks",
      true
    );
  });

  it("updates context on task changes", () => {
    registerKanbanDoneTasksContext({
      controller: controller as never,
    });

    vi.mocked(vscode.commands.executeCommand).mockClear();

    const doneTask = createKanbanTask("Done", 2, "Issue 2", 1, "Project");
    doneTask.completedAt = new Date().toISOString();
    tasks = [doneTask];

    onTasksChangeListener?.();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "redmyne:hasKanbanDoneTasks",
      true
    );
  });
});
