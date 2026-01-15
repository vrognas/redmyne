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

      mockState.update("redmine.kanban", [
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
  });
});
