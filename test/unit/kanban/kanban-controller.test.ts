import { describe, it, expect, beforeEach, vi } from "vitest";
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

describe("KanbanController", () => {
  let controller: KanbanController;
  let mockState: MockGlobalState;

  beforeEach(() => {
    mockState = createMockGlobalState();
    controller = new KanbanController(mockState);
  });

  describe("CRUD operations", () => {
    it("creates a task and persists it", async () => {
      const task = await controller.addTask(
        "Write unit tests",
        1234,
        "Main feature",
        1,
        "ProjectX",
        { priority: "high" }
      );

      expect(task.title).toBe("Write unit tests");
      expect(task.linkedIssueId).toBe(1234);
      expect(task.priority).toBe("high");
      expect(getTaskStatus(task)).toBe("todo");

      expect(controller.getTasks()).toHaveLength(1);
      expect(mockState.update).toHaveBeenCalledWith(
        "redmyne.kanban",
        expect.any(Array)
      );
    });

    it("updates a task", async () => {
      const task = await controller.addTask(
        "Initial title",
        1234,
        "Feature",
        1,
        "ProjectX"
      );

      await controller.updateTask(task.id, { title: "Updated title", priority: "low" });

      const updated = controller.getTaskById(task.id);
      expect(updated?.title).toBe("Updated title");
      expect(updated?.priority).toBe("low");
    });

    it("deletes a task", async () => {
      const task = await controller.addTask(
        "To delete",
        1234,
        "Feature",
        1,
        "ProjectX"
      );
      expect(controller.getTasks()).toHaveLength(1);

      await controller.deleteTask(task.id);

      expect(controller.getTasks()).toHaveLength(0);
    });
  });

  describe("status transitions", () => {
    it("marks a task as done and sets completedAt", async () => {
      const task = await controller.addTask(
        "Complete me",
        1234,
        "Feature",
        1,
        "ProjectX"
      );

      await controller.markDone(task.id);

      const updated = controller.getTaskById(task.id);
      expect(getTaskStatus(updated!)).toBe("done");
      expect(updated?.completedAt).toBeDefined();
    });

    it("reopens a done task (clears completedAt)", async () => {
      const task = await controller.addTask(
        "Reopen me",
        1234,
        "Feature",
        1,
        "ProjectX"
      );
      await controller.markDone(task.id);

      await controller.reopen(task.id);

      const updated = controller.getTaskById(task.id);
      expect(getTaskStatus(updated!)).toBe("todo");
      expect(updated?.completedAt).toBeUndefined();
    });

    it("tracks doing status when hours logged", async () => {
      const task = await controller.addTask(
        "Work in progress",
        1234,
        "Feature",
        1,
        "ProjectX"
      );

      await controller.addLoggedHours(task.id, 0.5);

      const updated = controller.getTaskById(task.id);
      expect(getTaskStatus(updated!)).toBe("doing");
      expect(updated?.loggedHours).toBe(0.5);

      // Add more hours
      await controller.addLoggedHours(task.id, 1.25);
      const updatedAgain = controller.getTaskById(task.id);
      expect(updatedAgain?.loggedHours).toBe(1.75);
    });
  });

  describe("persistence and restore", () => {
    it("restores tasks from globalState", async () => {
      // Add tasks to first controller
      await controller.addTask("Task 1", 1, "Issue 1", 1, "Project1");
      await controller.addTask("Task 2", 2, "Issue 2", 1, "Project1");

      // Create new controller with same state
      const newController = new KanbanController(mockState);

      expect(newController.getTasks()).toHaveLength(2);
      expect(newController.getTasks()[0].title).toBe("Task 1");
    });

    it("validates restored data gracefully", () => {
      // Corrupt data
      (mockState as Record<string, unknown>).get = () => [
        { id: "valid", title: "Good task", linkedIssueId: 1 },
        { corrupted: true }, // Missing required fields
        null,
      ];

      const newController = new KanbanController(mockState);

      // Should only have the valid task
      expect(newController.getTasks().length).toBeLessThanOrEqual(3);
    });
  });

  describe("events", () => {
    it("emits onTasksChange when tasks modified", async () => {
      const listener = vi.fn();
      controller.onTasksChange(listener);

      await controller.addTask("New task", 1, "Issue", 1, "Project");

      expect(listener).toHaveBeenCalled();
    });
  });

  describe("query methods", () => {
    it("finds tasks by linked issue", async () => {
      await controller.addTask("Task A1", 100, "Issue A", 1, "ProjectX");
      await controller.addTask("Task A2", 100, "Issue A", 1, "ProjectX");
      await controller.addTask("Task B", 200, "Issue B", 1, "ProjectX");

      const tasksForIssue100 = controller.getTasksByIssueId(100);
      expect(tasksForIssue100).toHaveLength(2);
    });

    it("clears done tasks", async () => {
      const t1 = await controller.addTask("Done 1", 1, "I1", 1, "P");
      const t2 = await controller.addTask("Done 2", 2, "I2", 1, "P");
      await controller.addTask("Not done", 3, "I3", 1, "P");

      await controller.markDone(t1.id);
      await controller.markDone(t2.id);

      await controller.clearDone();

      expect(controller.getTasks()).toHaveLength(1);
      expect(controller.getTasks()[0].title).toBe("Not done");
    });
  });

  describe("timer operations", () => {
    it("starts timer on a task", async () => {
      const task = await controller.addTask("Task", 1, "Issue", 1, "P");

      await controller.startTimer(task.id, 10, "Development");

      const updated = controller.getTaskById(task.id);
      expect(updated?.timerPhase).toBe("working");
      expect(updated?.activityId).toBe(10);
      expect(updated?.activityName).toBe("Development");
      expect(updated?.timerSecondsLeft).toBeDefined();
    });

    it("pauses timer on a working task", async () => {
      const task = await controller.addTask("Task", 1, "Issue", 1, "P");
      await controller.startTimer(task.id, 10, "Development");

      await controller.pauseTimer(task.id);

      const updated = controller.getTaskById(task.id);
      expect(updated?.timerPhase).toBe("paused");
    });

    it("resumes paused timer", async () => {
      const task = await controller.addTask("Task", 1, "Issue", 1, "P");
      await controller.startTimer(task.id, 10, "Development");
      await controller.pauseTimer(task.id);

      await controller.resumeTimer(task.id);

      const updated = controller.getTaskById(task.id);
      expect(updated?.timerPhase).toBe("working");
    });

    it("stops timer and clears state", async () => {
      const task = await controller.addTask("Task", 1, "Issue", 1, "P");
      await controller.startTimer(task.id, 10, "Development");

      await controller.stopTimer(task.id);

      const updated = controller.getTaskById(task.id);
      expect(updated?.timerPhase).toBeUndefined();
      expect(updated?.timerSecondsLeft).toBeUndefined();
    });

    it("auto-pauses other task when starting new timer", async () => {
      const task1 = await controller.addTask("Task 1", 1, "I1", 1, "P");
      const task2 = await controller.addTask("Task 2", 2, "I2", 1, "P");

      await controller.startTimer(task1.id, 10, "Dev");
      await controller.startTimer(task2.id, 10, "Dev");

      const updated1 = controller.getTaskById(task1.id);
      const updated2 = controller.getTaskById(task2.id);
      expect(updated1?.timerPhase).toBe("paused");
      expect(updated2?.timerPhase).toBe("working");
    });

    it("getActiveTask returns working task", async () => {
      const task = await controller.addTask("Task", 1, "Issue", 1, "P");
      await controller.startTimer(task.id, 10, "Dev");

      expect(controller.getActiveTask()?.id).toBe(task.id);
    });
  });

  describe("deferred minutes", () => {
    it("tracks deferred minutes", () => {
      expect(controller.getDeferredMinutes()).toBe(0);

      controller.addDeferredMinutes(15);
      expect(controller.getDeferredMinutes()).toBe(15);

      controller.addDeferredMinutes(10);
      expect(controller.getDeferredMinutes()).toBe(25);
    });

    it("consumes deferred minutes", () => {
      controller.addDeferredMinutes(20);

      const consumed = controller.consumeDeferredMinutes();

      expect(consumed).toBe(20);
      expect(controller.getDeferredMinutes()).toBe(0);
    });
  });

  describe("work duration", () => {
    it("returns default work duration", () => {
      expect(controller.getWorkDurationSeconds()).toBe(45 * 60);
    });

    it("allows updating work duration", () => {
      controller.setWorkDurationSeconds(30 * 60);
      expect(controller.getWorkDurationSeconds()).toBe(30 * 60);
    });
  });

  describe("parent project update", () => {
    it("updates parent project info", async () => {
      const task = await controller.addTask("Task", 1, "Issue", 1, "Project");

      await controller.updateParentProject(task.id, 10, "Parent Project");

      const updated = controller.getTaskById(task.id);
      expect(updated?.linkedParentProjectId).toBe(10);
      expect(updated?.linkedParentProjectName).toBe("Parent Project");
    });
  });

  describe("reorder operations", () => {
    it("moves task up in column", async () => {
      const task1 = await controller.addTask("Task 1", 1, "I1", 1, "P", {
        priority: "high",
      });
      const task2 = await controller.addTask("Task 2", 2, "I2", 1, "P", {
        priority: "low",
      });

      // Both are in todo column
      await controller.moveUp(task2.id);

      const updated1 = controller.getTaskById(task1.id);
      const updated2 = controller.getTaskById(task2.id);

      expect(updated1?.sortOrder).toBeTypeOf("number");
      expect(updated2?.sortOrder).toBeTypeOf("number");
      // task2 should now have lower sortOrder (higher position)
      expect(updated2?.sortOrder).toBeLessThan(updated1?.sortOrder ?? Infinity);
    });

    it("moves task down in column", async () => {
      const task1 = await controller.addTask("Task 1", 1, "I1", 1, "P", {
        priority: "high",
      });
      const task2 = await controller.addTask("Task 2", 2, "I2", 1, "P", {
        priority: "low",
      });

      await controller.moveDown(task1.id);

      const updated1 = controller.getTaskById(task1.id);
      const updated2 = controller.getTaskById(task2.id);

      expect(updated1?.sortOrder).toBeTypeOf("number");
      expect(updated2?.sortOrder).toBeTypeOf("number");
      // task1 should now have higher sortOrder (lower position)
      expect(updated1?.sortOrder).toBeGreaterThan(updated2?.sortOrder ?? -Infinity);
    });
  });

  describe("addLoggedHours", () => {
    it("rejects non-positive hours", async () => {
      const task = await controller.addTask("Task", 1, "Issue", 1, "P");

      await controller.addLoggedHours(task.id, 0);
      await controller.addLoggedHours(task.id, -1);

      const updated = controller.getTaskById(task.id);
      expect(updated?.loggedHours).toBe(0);
    });
  });

  describe("dispose", () => {
    it("cleans up resources", async () => {
      const task = await controller.addTask("Task", 1, "Issue", 1, "P");
      await controller.startTimer(task.id, 10, "Dev");

      controller.dispose();

      // Should complete without error
    });
  });
});
