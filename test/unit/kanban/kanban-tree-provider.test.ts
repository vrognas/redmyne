import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { KanbanTreeProvider, type TaskTreeItem } from "../../../src/kanban/kanban-tree-provider";
import type { KanbanController } from "../../../src/kanban/kanban-controller";
import type { KanbanTask } from "../../../src/kanban/kanban-state";

type MockController = {
  onTasksChange: ReturnType<typeof vi.fn>;
  getTasks: ReturnType<typeof vi.fn>;
  isOnBreak: ReturnType<typeof vi.fn>;
  getBreakSecondsLeft: ReturnType<typeof vi.fn>;
  getTaskById: ReturnType<typeof vi.fn>;
  moveToTodo: ReturnType<typeof vi.fn>;
  moveToDoing: ReturnType<typeof vi.fn>;
  markDone: ReturnType<typeof vi.fn>;
};

function createTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "task-id",
    title: "Task title",
    priority: "medium",
    linkedIssueId: 100,
    linkedIssueSubject: "Issue subject",
    linkedProjectId: 10,
    linkedProjectName: "Project",
    loggedHours: 0,
    createdAt: "2026-02-07T00:00:00.000Z",
    updatedAt: "2026-02-07T00:00:00.000Z",
    ...overrides,
  };
}

function createController(tasks: KanbanTask[], options?: {
  onBreak?: boolean;
  breakSecondsLeft?: number;
}): MockController {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return {
    onTasksChange: vi.fn(() => ({ dispose: vi.fn() })),
    getTasks: vi.fn(() => tasks),
    isOnBreak: vi.fn(() => options?.onBreak ?? false),
    getBreakSecondsLeft: vi.fn(() => options?.breakSecondsLeft ?? 0),
    getTaskById: vi.fn((id: string) => byId.get(id)),
    moveToTodo: vi.fn().mockResolvedValue(undefined),
    moveToDoing: vi.fn().mockResolvedValue(undefined),
    markDone: vi.fn().mockResolvedValue(undefined),
  };
}

function createMemento(
  seed: Record<string, unknown> = {}
): vscode.Memento {
  const store = new Map(Object.entries(seed));
  return {
    get: vi.fn((key: string, fallback?: unknown) =>
      store.has(key) ? store.get(key) : fallback
    ),
    update: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
  } as unknown as vscode.Memento;
}

function findTaskItem(children: TaskTreeItem[], id: string): TaskTreeItem {
  const item = children.find((child) => child.type === "task" && child.task?.id === id);
  if (!item) {
    throw new Error(`Task item not found: ${id}`);
  }
  return item;
}

function createTransfer(ids: string[]): vscode.DataTransfer {
  return {
    get: (mimeType: string) =>
      mimeType === "application/vnd.code.tree.redmyne-kanban"
        ? ({ value: ids } as unknown as vscode.DataTransferItem)
        : undefined,
  } as unknown as vscode.DataTransfer;
}

describe("kanban-tree-provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restores and persists filter/sort state", () => {
    const controller = createController([]);
    const globalState = createMemento({
      "redmyne.kanban.filterPriority": "high",
      "redmyne.kanban.sortField": "issueId",
      "redmyne.kanban.sortDirection": "asc",
    });
    const provider = new KanbanTreeProvider(
      controller as unknown as KanbanController,
      globalState
    );
    const refreshSpy = vi.spyOn(provider, "refresh");

    expect(provider.getFilter()).toBe("high");
    expect(provider.getSort()).toEqual({ field: "issueId", direction: "asc" });

    provider.setFilter("low");
    provider.setSort("issueId");
    provider.setSort("priority");

    expect(provider.getFilter()).toBe("low");
    expect(provider.getSort()).toEqual({ field: "priority", direction: "desc" });
    expect(globalState.update).toHaveBeenCalledWith("redmyne.kanban.filterPriority", "low");
    expect(globalState.update).toHaveBeenCalledWith("redmyne.kanban.sortField", "issueId");
    expect(globalState.update).toHaveBeenCalledWith("redmyne.kanban.sortDirection", "desc");
    expect(globalState.update).toHaveBeenCalledWith("redmyne.kanban.sortField", "priority");
    expect(refreshSpy).toHaveBeenCalledTimes(3);
  });

  it("builds root/status/client/project children with stable grouping", () => {
    const tasks: KanbanTask[] = [
      createTask({
        id: "todo-client-web",
        title: "Web",
        priority: "high",
        linkedProjectId: 101,
        linkedProjectName: "Web",
        linkedParentProjectId: 10,
        linkedParentProjectName: "Acme",
      }),
      createTask({
        id: "todo-client-api",
        title: "API",
        priority: "low",
        linkedProjectId: 102,
        linkedProjectName: "API",
        linkedParentProjectId: 10,
        linkedParentProjectName: "Acme",
      }),
      createTask({
        id: "todo-standalone",
        title: "Standalone",
        linkedProjectId: 201,
        linkedProjectName: "Standalone",
      }),
      createTask({
        id: "doing-high",
        title: "Doing high",
        priority: "high",
        loggedHours: 1,
      }),
      createTask({
        id: "doing-low",
        title: "Doing low",
        priority: "low",
        loggedHours: 1,
      }),
      createTask({
        id: "done-task",
        title: "Done",
        completedAt: "2026-02-07T01:00:00.000Z",
      }),
    ];

    const controller = createController(tasks, { onBreak: true, breakSecondsLeft: 95 });
    const provider = new KanbanTreeProvider(controller as unknown as KanbanController);

    const root = provider.getChildren();
    expect(root.map((item) => item.type)).toEqual([
      "break-status",
      "status-header",
      "status-header",
      "status-header",
    ]);
    expect(root[1]).toMatchObject({ type: "status-header", status: "done" });
    expect(root[2]).toMatchObject({ type: "status-header", status: "doing" });
    expect(root[3]).toMatchObject({ type: "status-header", status: "todo" });

    const doingChildren = provider.getChildren(root[2]);
    expect(doingChildren.map((item) => item.task?.id)).toEqual(["doing-high", "doing-low"]);

    const todoChildren = provider.getChildren(root[3]);
    expect(todoChildren).toHaveLength(2);
    expect(todoChildren[0]).toMatchObject({
      type: "client-folder",
      clientName: "Acme",
      status: "todo",
    });
    expect(todoChildren[1]).toMatchObject({
      type: "project-folder",
      projectName: "Standalone",
      status: "todo",
    });

    const clientProjects = provider.getChildren(todoChildren[0]);
    expect(clientProjects.map((item) => item.projectName)).toEqual(["API", "Web"]);

    const standaloneTasks = provider.getChildren(todoChildren[1]);
    expect(standaloneTasks.map((item) => item.task?.id)).toEqual(["todo-standalone"]);

    const noChildren = provider.getChildren(findTaskItem(doingChildren, "doing-high"));
    expect(noChildren).toEqual([]);
  });

  it("creates tree items for timers/status and moves tasks on drop", async () => {
    const workingTask = createTask({
      id: "working-task",
      title: "Working task",
      priority: "high",
      timerPhase: "working",
      timerSecondsLeft: 600,
      activityName: "Development",
    });
    const pausedTask = createTask({
      id: "paused-task",
      title: "Paused task",
      timerPhase: "paused",
      timerSecondsLeft: 300,
      loggedHours: 1,
    });
    const readyTask = createTask({
      id: "ready-task",
      title: "Ready task",
      timerSecondsLeft: 120,
    });
    const doneTask = createTask({
      id: "done-task",
      title: "Done task",
      completedAt: "2026-02-07T02:00:00.000Z",
      loggedHours: 1.5,
    });
    const lowTask = createTask({
      id: "low-task",
      title: "Low task",
      priority: "low",
    });
    const todoTask = createTask({
      id: "todo-task",
      title: "Todo task",
    });
    const doingTask = createTask({
      id: "doing-task",
      title: "Doing task",
      loggedHours: 0.25,
    });

    const controller = createController([
      workingTask,
      pausedTask,
      readyTask,
      doneTask,
      lowTask,
      todoTask,
      doingTask,
    ]);
    const provider = new KanbanTreeProvider(controller as unknown as KanbanController);

    const breakItem = provider.getTreeItem({ type: "break-status", breakSecondsLeft: 65 });
    expect(breakItem.label).toBe("☕ Break: 1:05");
    expect(breakItem.contextValue).toBe("break-status");
    expect(breakItem.command?.command).toBe("redmyne.kanban.skipBreak");

    const doneHeaderItem = provider.getTreeItem({ type: "status-header", status: "done" });
    expect(doneHeaderItem.label).toBe("Done (1)");
    expect(doneHeaderItem.contextValue).toBe("status-header-done");
    expect(doneHeaderItem.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);

    const workingItem = provider.getTreeItem({ type: "task", task: workingTask });
    expect(workingItem.contextValue).toBe("task-doing-working");
    expect(workingItem.command?.command).toBe("redmyne.kanban.pauseTimer");
    expect(workingItem.description).toContain("10:00");
    expect(workingItem.description).toContain("[Development]");

    const pausedItem = provider.getTreeItem({ type: "task", task: pausedTask });
    expect(pausedItem.contextValue).toBe("task-doing-paused");
    expect(pausedItem.command?.command).toBe("redmyne.kanban.resumeTimer");

    const readyItem = provider.getTreeItem({ type: "task", task: readyTask });
    expect(readyItem.contextValue).toBe("task-todo-initialized");
    expect(readyItem.command?.command).toBe("redmyne.kanban.startTimer");
    expect(readyItem.description).toContain("(ready)");

    const doneItem = provider.getTreeItem({ type: "task", task: doneTask });
    expect(doneItem.contextValue).toBe("task-done");
    expect(doneItem.command).toBeUndefined();

    const lowItem = provider.getTreeItem({ type: "task", task: lowTask });
    expect((lowItem.iconPath as vscode.ThemeIcon).id).toBe("arrow-down");

    await provider.handleDrop(
      { type: "status-header", status: "todo" },
      createTransfer(["doing-task", "done-task", "todo-task"]),
      {} as vscode.CancellationToken
    );
    expect(controller.moveToTodo).toHaveBeenCalledWith("doing-task");
    expect(controller.moveToTodo).toHaveBeenCalledWith("done-task");
    expect(controller.moveToTodo).toHaveBeenCalledTimes(2);

    await provider.handleDrop(
      { type: "status-header", status: "doing" },
      createTransfer(["todo-task"]),
      {} as vscode.CancellationToken
    );
    expect(controller.moveToDoing).toHaveBeenCalledWith("todo-task");

    await provider.handleDrop(
      { type: "status-header", status: "done" },
      createTransfer(["todo-task"]),
      {} as vscode.CancellationToken
    );
    expect(controller.markDone).toHaveBeenCalledWith("todo-task");

    await provider.handleDrop(
      undefined,
      createTransfer(["todo-task"]),
      {} as vscode.CancellationToken
    );
    expect(controller.markDone).toHaveBeenCalledTimes(1);
  });
});
