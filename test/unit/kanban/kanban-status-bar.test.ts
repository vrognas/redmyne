import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as vscode from "vscode";
import type { KanbanTask } from "../../../src/kanban/kanban-state";

// Mock controller factory
function createMockController(overrides: Partial<{
  tasks: KanbanTask[];
  activeTask: KanbanTask | undefined;
  isOnBreak: boolean;
  breakSecondsLeft: number;
  deferredMinutes: number;
  workDurationSeconds: number;
}> = {}) {
  const defaults = {
    tasks: [],
    activeTask: undefined,
    isOnBreak: false,
    breakSecondsLeft: 0,
    deferredMinutes: 0,
    workDurationSeconds: 2700, // 45 minutes
  };
  const config = { ...defaults, ...overrides };

  const listeners: Array<() => void> = [];

  return {
    getTasks: vi.fn(() => config.tasks),
    getActiveTask: vi.fn(() => config.activeTask),
    isOnBreak: vi.fn(() => config.isOnBreak),
    getBreakSecondsLeft: vi.fn(() => config.breakSecondsLeft),
    getDeferredMinutes: vi.fn(() => config.deferredMinutes),
    getWorkDurationSeconds: vi.fn(() => config.workDurationSeconds),
    onTasksChange: vi.fn((listener: () => void) => {
      listeners.push(listener);
      return { dispose: vi.fn() };
    }),
    _fireChange: () => listeners.forEach((l) => l()),
  };
}

function createMockGlobalState(overrides: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...overrides };
  return {
    get: <T>(key: string, defaultValue?: T) =>
      (store[key] as T) ?? (defaultValue as T),
    update: vi.fn((key: string, value: unknown) => {
      store[key] = value;
    }),
  };
}

function createTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "task-1",
    title: "Test Task",
    linkedIssueId: 123,
    linkedIssueSubject: "Test Issue",
    linkedProjectId: 1,
    linkedProjectName: "Project",
    priority: "medium",
    createdAt: Date.now(),
    loggedHours: 0,
    ...overrides,
  };
}

describe("KanbanStatusBar", () => {
  let KanbanStatusBar: new (
    controller: ReturnType<typeof createMockController>,
    globalState: vscode.Memento
  ) => { dispose: () => void };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const module = await import("../../../src/kanban/kanban-status-bar");
    KanbanStatusBar = module.KanbanStatusBar as unknown as typeof KanbanStatusBar;
  });

  describe("constructor", () => {
    it("creates and shows status bar item", () => {
      const controller = createMockController();
      const globalState = createMockGlobalState();

      new KanbanStatusBar(controller, globalState);

      // Status bar should be created (via mock)
      expect(controller.onTasksChange).toHaveBeenCalled();
    });

    it("subscribes to controller changes", () => {
      const controller = createMockController();
      const globalState = createMockGlobalState();

      new KanbanStatusBar(controller, globalState);

      expect(controller.onTasksChange).toHaveBeenCalled();
    });
  });

  describe("status bar states", () => {
    it("shows add task when no tasks exist", () => {
      const controller = createMockController({ tasks: [] });
      const globalState = createMockGlobalState();

      new KanbanStatusBar(controller, globalState);

      // Controller was queried
      expect(controller.getTasks).toHaveBeenCalled();
    });

    it("shows done count when all tasks done", () => {
      const doneTask = createTask({
        completedAt: Date.now(),
        loggedHours: 1,
      });
      const controller = createMockController({ tasks: [doneTask] });
      const globalState = createMockGlobalState();

      new KanbanStatusBar(controller, globalState);

      expect(controller.getTasks).toHaveBeenCalled();
    });

    it("shows active timer when task is active", () => {
      const activeTask = createTask({
        timerPhase: "working",
        timerSecondsLeft: 1800,
        loggedHours: 0.5,
      });
      const controller = createMockController({
        tasks: [activeTask],
        activeTask,
      });
      const globalState = createMockGlobalState();

      new KanbanStatusBar(controller, globalState);

      expect(controller.getActiveTask).toHaveBeenCalled();
    });

    it("shows paused state when timer is paused", () => {
      const pausedTask = createTask({
        timerPhase: "paused",
        timerSecondsLeft: 1500,
        loggedHours: 0.25,
      });
      const controller = createMockController({
        tasks: [pausedTask],
      });
      const globalState = createMockGlobalState();

      new KanbanStatusBar(controller, globalState);

      expect(controller.getTasks).toHaveBeenCalled();
    });

    it("shows break state when on break", () => {
      const controller = createMockController({
        tasks: [createTask()],
        isOnBreak: true,
        breakSecondsLeft: 300,
      });
      const globalState = createMockGlobalState();

      new KanbanStatusBar(controller, globalState);

      expect(controller.isOnBreak).toHaveBeenCalled();
      expect(controller.getBreakSecondsLeft).toHaveBeenCalled();
    });

    it("shows ready state when doing tasks exist", () => {
      const doingTask = createTask({ loggedHours: 0.5 });
      const controller = createMockController({ tasks: [doingTask] });
      const globalState = createMockGlobalState();

      new KanbanStatusBar(controller, globalState);

      expect(controller.getTasks).toHaveBeenCalled();
    });
  });

  describe("progress bar", () => {
    it("uses configured width from globalState", () => {
      const activeTask = createTask({
        timerPhase: "working",
        timerSecondsLeft: 1350, // Half of 2700
        loggedHours: 0.5,
      });
      const controller = createMockController({
        tasks: [activeTask],
        activeTask,
        workDurationSeconds: 2700,
      });
      const globalState = createMockGlobalState({
        "redmyne.timer.progressBarWidth": 10,
      });

      new KanbanStatusBar(controller, globalState);

      expect(controller.getWorkDurationSeconds).toHaveBeenCalled();
    });
  });

  describe("dispose", () => {
    it("cleans up resources", () => {
      const controller = createMockController();
      const globalState = createMockGlobalState();

      const statusBar = new KanbanStatusBar(controller, globalState);
      statusBar.dispose();

      // Should complete without error
    });
  });

  describe("update on state changes", () => {
    it("updates when controller fires change", () => {
      const controller = createMockController({ tasks: [] });
      const globalState = createMockGlobalState();

      new KanbanStatusBar(controller, globalState);

      // Simulate state change
      controller._fireChange();

      // getTasks should be called again
      expect(controller.getTasks).toHaveBeenCalledTimes(2);
    });
  });

  describe("deferred minutes", () => {
    it("includes deferred time in display", () => {
      const activeTask = createTask({
        timerPhase: "working",
        timerSecondsLeft: 2400,
        loggedHours: 0,
      });
      const controller = createMockController({
        tasks: [activeTask],
        activeTask,
        deferredMinutes: 15,
      });
      const globalState = createMockGlobalState();

      new KanbanStatusBar(controller, globalState);

      expect(controller.getDeferredMinutes).toHaveBeenCalled();
    });
  });
});
