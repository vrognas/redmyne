import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  KanbanController,
  MockGlobalState,
} from "../../../src/kanban/kanban-controller";
import { getTaskStatus } from "../../../src/kanban/kanban-state";

function createMockGlobalState(): MockGlobalState {
  const store: Record<string, unknown> = {};
  return {
    get: <T>(key: string, defaultValue: T) => (store[key] as T) ?? defaultValue,
    update: vi.fn(async (key: string, value: unknown) => {
      store[key] = value;
    }),
  };
}

describe("KanbanController Timer", () => {
  let controller: KanbanController;
  let mockState: MockGlobalState;

  beforeEach(() => {
    vi.useFakeTimers();
    mockState = createMockGlobalState();
    controller = new KanbanController(mockState, { workDurationSeconds: 10 });
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
  });

  describe("startTimer", () => {
    it("sets timerPhase to working and starts countdown", async () => {
      const task = await controller.addTask("Test", 1, "Issue", 1, "Project");
      await controller.startTimer(task.id, 1, "Development");

      const updated = controller.getTaskById(task.id);
      expect(updated?.timerPhase).toBe("working");
      expect(updated?.timerSecondsLeft).toBe(10);
      expect(updated?.activityId).toBe(1);
      expect(updated?.activityName).toBe("Development");
      expect(getTaskStatus(updated!)).toBe("doing");
    });

    it("auto-pauses other working task when starting new one", async () => {
      const task1 = await controller.addTask("Task1", 1, "I1", 1, "P");
      const task2 = await controller.addTask("Task2", 2, "I2", 1, "P");

      await controller.startTimer(task1.id, 1, "Dev");
      await controller.startTimer(task2.id, 2, "Test");

      expect(controller.getTaskById(task1.id)?.timerPhase).toBe("paused");
      expect(controller.getTaskById(task2.id)?.timerPhase).toBe("working");
    });
  });

  describe("pauseTimer", () => {
    it("sets timerPhase to paused and stops countdown", async () => {
      const task = await controller.addTask("Test", 1, "Issue", 1, "Project");
      await controller.startTimer(task.id, 1, "Dev");

      vi.advanceTimersByTime(3000);
      await controller.pauseTimer(task.id);

      const updated = controller.getTaskById(task.id);
      expect(updated?.timerPhase).toBe("paused");
      expect(updated?.timerSecondsLeft).toBe(7); // 10 - 3

      // Time should not advance while paused
      vi.advanceTimersByTime(5000);
      expect(controller.getTaskById(task.id)?.timerSecondsLeft).toBe(7);
    });
  });

  describe("resumeTimer", () => {
    it("resumes from paused state", async () => {
      const task = await controller.addTask("Test", 1, "Issue", 1, "Project");
      await controller.startTimer(task.id, 1, "Dev");
      await controller.pauseTimer(task.id);
      await controller.resumeTimer(task.id);

      expect(controller.getTaskById(task.id)?.timerPhase).toBe("working");
    });
  });

  describe("stopTimer", () => {
    it("clears timer state but keeps task in doing (has hours)", async () => {
      const task = await controller.addTask("Test", 1, "Issue", 1, "Project");
      await controller.startTimer(task.id, 1, "Dev");
      await controller.addLoggedHours(task.id, 0.5);
      await controller.stopTimer(task.id);

      const updated = controller.getTaskById(task.id);
      expect(updated?.timerPhase).toBeUndefined();
      expect(updated?.timerSecondsLeft).toBeUndefined();
      expect(getTaskStatus(updated!)).toBe("doing"); // Still doing due to logged hours
    });
  });

  describe("moveToTodo", () => {
    it("clears timer state AND logged hours", async () => {
      const task = await controller.addTask("Test", 1, "Issue", 1, "Project");
      await controller.startTimer(task.id, 1, "Dev");
      await controller.addLoggedHours(task.id, 0.5);
      await controller.moveToTodo(task.id);

      const updated = controller.getTaskById(task.id);
      expect(updated?.timerPhase).toBeUndefined();
      expect(updated?.loggedHours).toBe(0);
      expect(getTaskStatus(updated!)).toBe("todo");
    });

    it("clears doingAt when moving to todo", async () => {
      const task = await controller.addTask("Test", 1, "Issue", 1, "Project");
      await controller.moveToDoing(task.id);
      await controller.moveToTodo(task.id);

      const updated = controller.getTaskById(task.id);
      expect(updated?.doingAt).toBeUndefined();
      expect(updated?.timerSecondsLeft).toBeUndefined();
      expect(getTaskStatus(updated!)).toBe("todo");
    });
  });

  describe("moveToDoing", () => {
    it("sets doingAt and initializes timerSecondsLeft", async () => {
      const task = await controller.addTask("Test", 1, "Issue", 1, "Project");
      await controller.moveToDoing(task.id);

      const updated = controller.getTaskById(task.id);
      expect(updated?.doingAt).toBeDefined();
      expect(updated?.timerSecondsLeft).toBe(10); // workDurationSeconds from test setup
      expect(updated?.timerPhase).toBeUndefined(); // NOT running
      expect(getTaskStatus(updated!)).toBe("doing");
    });

    it("clears completedAt when moving from done to doing", async () => {
      const task = await controller.addTask("Test", 1, "Issue", 1, "Project");
      await controller.markDone(task.id);
      expect(getTaskStatus(controller.getTaskById(task.id)!)).toBe("done");

      await controller.moveToDoing(task.id);

      const updated = controller.getTaskById(task.id);
      expect(updated?.completedAt).toBeUndefined();
      expect(updated?.doingAt).toBeDefined();
      expect(getTaskStatus(updated!)).toBe("doing");
    });

    it("does not start timer interval (not running)", async () => {
      const task = await controller.addTask("Test", 1, "Issue", 1, "Project");
      await controller.moveToDoing(task.id);

      vi.advanceTimersByTime(5000);

      // Timer should NOT have decremented since it's only initialized
      const updated = controller.getTaskById(task.id);
      expect(updated?.timerSecondsLeft).toBe(10);
    });
  });

  describe("timer tick", () => {
    it("decrements secondsLeft every second", async () => {
      const task = await controller.addTask("Test", 1, "Issue", 1, "Project");
      await controller.startTimer(task.id, 1, "Dev");

      vi.advanceTimersByTime(5000);
      expect(controller.getTaskById(task.id)?.timerSecondsLeft).toBe(5);
    });

    it("fires onTimerComplete when timer hits 0", async () => {
      const listener = vi.fn();
      controller.onTimerComplete(listener);

      const task = await controller.addTask("Test", 1, "Issue", 1, "Project");
      await controller.startTimer(task.id, 1, "Dev");

      vi.advanceTimersByTime(11000);

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));
      expect(controller.getTaskById(task.id)?.timerSecondsLeft).toBe(0);
    });
  });

  describe("getActiveTask", () => {
    it("returns task with timerPhase=working", async () => {
      const task = await controller.addTask("Test", 1, "Issue", 1, "Project");
      await controller.startTimer(task.id, 1, "Dev");

      const active = controller.getActiveTask();
      expect(active?.id).toBe(task.id);
    });

    it("returns undefined when no active timer", async () => {
      await controller.addTask("Test", 1, "Issue", 1, "Project");
      expect(controller.getActiveTask()).toBeUndefined();
    });
  });

  describe("session recovery", () => {
    it("calculates elapsed time from lastActiveAt on restore", async () => {
      // Simulate previous session: timer was working with 100 seconds left, 30 seconds ago
      const now = new Date();
      const thirtySecondsAgo = new Date(now.getTime() - 30000);

      mockState.update("redmyne.kanban", [
        {
          id: "test-id",
          title: "Recovering task",
          priority: "medium",
          linkedIssueId: 1,
          linkedIssueSubject: "Issue",
          linkedProjectId: 1,
          linkedProjectName: "Project",
          loggedHours: 0,
          createdAt: "2025-01-01",
          updatedAt: "2025-01-01",
          timerSecondsLeft: 100,
          timerPhase: "working",
          activityId: 1,
          activityName: "Dev",
          lastActiveAt: thirtySecondsAgo.toISOString(),
        },
      ]);

      const newController = new KanbanController(mockState, { workDurationSeconds: 10 });
      const task = newController.getTaskById("test-id");

      // Timer should be paused (recovered from working), seconds adjusted
      expect(task?.timerPhase).toBe("paused");
      expect(task?.timerSecondsLeft).toBe(70); // 100 - 30

      newController.dispose();
    });

    it("clears timer if it would have completed during restart", async () => {
      // Timer was working with 10 seconds left, 60 seconds ago (would have completed)
      const now = new Date();
      const sixtySecondsAgo = new Date(now.getTime() - 60000);

      mockState.update("redmyne.kanban", [
        {
          id: "completed-id",
          title: "Completed task",
          priority: "medium",
          linkedIssueId: 2,
          linkedIssueSubject: "Issue 2",
          linkedProjectId: 1,
          linkedProjectName: "Project",
          loggedHours: 0,
          createdAt: "2025-01-01",
          updatedAt: "2025-01-01",
          timerSecondsLeft: 10,
          timerPhase: "working",
          activityId: 1,
          activityName: "Dev",
          lastActiveAt: sixtySecondsAgo.toISOString(),
        },
      ]);

      const newController = new KanbanController(mockState, { workDurationSeconds: 10 });
      const task = newController.getTaskById("completed-id");

      // Timer should be cleared (not stuck in working with 0 seconds)
      expect(task?.timerPhase).toBeUndefined();
      expect(task?.timerSecondsLeft).toBeUndefined();

      newController.dispose();
    });

    it("clears timer if timerSecondsLeft was exactly 0", async () => {
      // Edge case: timer completed but extension restarted before user responded
      mockState.update("redmyne.kanban", [
        {
          id: "zero-id",
          title: "Zero seconds task",
          priority: "medium",
          linkedIssueId: 3,
          linkedIssueSubject: "Issue 3",
          linkedProjectId: 1,
          linkedProjectName: "Project",
          loggedHours: 0,
          createdAt: "2025-01-01",
          updatedAt: "2025-01-01",
          timerSecondsLeft: 0,
          timerPhase: "working",
          activityId: 1,
          activityName: "Dev",
          lastActiveAt: new Date().toISOString(),
        },
      ]);

      const newController = new KanbanController(mockState, { workDurationSeconds: 10 });
      const task = newController.getTaskById("zero-id");

      // Timer should be cleared (not stuck in working with 0 seconds)
      expect(task?.timerPhase).toBeUndefined();
      expect(task?.timerSecondsLeft).toBeUndefined();

      newController.dispose();
    });
  });
});
