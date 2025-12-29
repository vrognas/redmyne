import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  KanbanController,
  MockGlobalState,
} from "../../src/kanban/kanban-controller";
import {
  getTaskStatus,
  groupTasksByStatus,
  sortTasksByPriority,
} from "../../src/kanban/kanban-state";

/**
 * E2E Integration Tests: Kanban Task Lifecycle
 *
 * Tests complete kanban workflows: CRUD, status transitions,
 * time tracking accumulation, and persistence.
 */
describe("E2E: Kanban Task Lifecycle", () => {
  let controller: KanbanController;
  let mockStorage: Map<string, unknown>;
  let mockGlobalState: MockGlobalState;

  beforeEach(() => {
    mockStorage = new Map();
    mockGlobalState = {
      get<T>(key: string, defaultValue: T): T {
        return (mockStorage.get(key) as T) ?? defaultValue;
      },
      update: vi.fn((key: string, value: unknown) => {
        mockStorage.set(key, value);
        return Promise.resolve();
      }),
    };

    controller = new KanbanController(mockGlobalState);
  });

  describe("Task CRUD Workflow", () => {
    it("should complete full lifecycle: create → update → mark done → reopen → delete", async () => {
      const events: number[] = [];
      controller.onTasksChange(() => events.push(controller.getTasks().length));

      // Create task
      const task = await controller.addTask(
        "Implement login form",
        123,
        "User Authentication",
        1,
        "Project Alpha",
        { priority: "high", estimatedHours: 4 }
      );

      expect(task.id).toBeDefined();
      expect(task.title).toBe("Implement login form");
      expect(task.priority).toBe("high");
      expect(task.estimatedHours).toBe(4);
      expect(task.loggedHours).toBe(0);
      expect(getTaskStatus(task)).toBe("todo");

      // Update task
      await controller.updateTask(task.id, {
        title: "Implement secure login form",
        description: "With password validation",
      });

      const updated = controller.getTaskById(task.id);
      expect(updated?.title).toBe("Implement secure login form");
      expect(updated?.description).toBe("With password validation");

      // Log hours (transitions to in-progress)
      await controller.addLoggedHours(task.id, 2.5);
      const afterLog = controller.getTaskById(task.id);
      expect(afterLog?.loggedHours).toBe(2.5);
      expect(getTaskStatus(afterLog!)).toBe("in-progress");

      // Mark done
      await controller.markDone(task.id);
      const afterDone = controller.getTaskById(task.id);
      expect(afterDone?.completedAt).toBeDefined();
      expect(getTaskStatus(afterDone!)).toBe("done");

      // Reopen
      await controller.reopen(task.id);
      const afterReopen = controller.getTaskById(task.id);
      expect(afterReopen?.completedAt).toBeUndefined();
      expect(getTaskStatus(afterReopen!)).toBe("in-progress"); // Still has logged hours

      // Delete
      await controller.deleteTask(task.id);
      expect(controller.getTaskById(task.id)).toBeUndefined();
      expect(controller.getTasks()).toHaveLength(0);

      // Verify events fired
      expect(events.length).toBeGreaterThan(0);
    });

    it("should handle multiple tasks with different priorities", async () => {
      // Create tasks with different priorities
      await controller.addTask("Low task", 1, "Issue 1", 1, "Project", { priority: "low" });
      await controller.addTask("High task", 2, "Issue 2", 1, "Project", { priority: "high" });
      await controller.addTask("Medium task", 3, "Issue 3", 1, "Project", { priority: "medium" });

      const tasks = controller.getTasks();
      expect(tasks).toHaveLength(3);

      // Sort and verify order
      const sorted = sortTasksByPriority(tasks);
      expect(sorted[0].priority).toBe("high");
      expect(sorted[1].priority).toBe("medium");
      expect(sorted[2].priority).toBe("low");
    });
  });

  describe("Time Tracking Accumulation", () => {
    it("should accumulate logged hours across multiple log entries", async () => {
      const task = await controller.addTask(
        "Long running task",
        100,
        "Feature development",
        1,
        "Project"
      );

      expect(task.loggedHours).toBe(0);

      // Log multiple times
      await controller.addLoggedHours(task.id, 2.0);
      expect(controller.getTaskById(task.id)?.loggedHours).toBe(2.0);

      await controller.addLoggedHours(task.id, 1.5);
      expect(controller.getTaskById(task.id)?.loggedHours).toBe(3.5);

      await controller.addLoggedHours(task.id, 0.5);
      expect(controller.getTaskById(task.id)?.loggedHours).toBe(4.0);
    });

    it("should reject non-positive hours", async () => {
      const task = await controller.addTask(
        "Test task",
        1,
        "Issue",
        1,
        "Project"
      );

      await controller.addLoggedHours(task.id, 0);
      expect(controller.getTaskById(task.id)?.loggedHours).toBe(0);

      await controller.addLoggedHours(task.id, -1);
      expect(controller.getTaskById(task.id)?.loggedHours).toBe(0);

      await controller.addLoggedHours(task.id, 1);
      expect(controller.getTaskById(task.id)?.loggedHours).toBe(1);
    });
  });

  describe("Status Grouping Workflow", () => {
    it("should correctly group tasks by derived status", async () => {
      // Create tasks in various states
      const todo1 = await controller.addTask("Todo 1", 1, "I1", 1, "P");
      const todo2 = await controller.addTask("Todo 2", 2, "I2", 1, "P");
      const inProgress = await controller.addTask("In Progress", 3, "I3", 1, "P");
      const done = await controller.addTask("Done", 4, "I4", 1, "P");

      // Transition to in-progress (log hours)
      await controller.addLoggedHours(inProgress.id, 1);

      // Transition to done
      await controller.markDone(done.id);

      // Group
      const groups = groupTasksByStatus(controller.getTasks());

      expect(groups.todo).toHaveLength(2);
      expect(groups.inProgress).toHaveLength(1);
      expect(groups.done).toHaveLength(1);

      expect(groups.todo.map((t) => t.id)).toContain(todo1.id);
      expect(groups.todo.map((t) => t.id)).toContain(todo2.id);
      expect(groups.inProgress[0].id).toBe(inProgress.id);
      expect(groups.done[0].id).toBe(done.id);
    });
  });

  describe("Bulk Operations", () => {
    it("should clear all done tasks", async () => {
      const task1 = await controller.addTask("Keep 1", 1, "I1", 1, "P");
      const task2 = await controller.addTask("Remove 1", 2, "I2", 1, "P");
      const task3 = await controller.addTask("Remove 2", 3, "I3", 1, "P");
      const task4 = await controller.addTask("Keep 2", 4, "I4", 1, "P");

      await controller.markDone(task2.id);
      await controller.markDone(task3.id);

      expect(controller.getTasks()).toHaveLength(4);

      await controller.clearDone();

      const remaining = controller.getTasks();
      expect(remaining).toHaveLength(2);
      expect(remaining.map((t) => t.id)).toContain(task1.id);
      expect(remaining.map((t) => t.id)).toContain(task4.id);
    });
  });

  describe("Persistence & Recovery", () => {
    it("should persist tasks and restore on new controller instance", async () => {
      // Add tasks
      await controller.addTask("Persistent task 1", 1, "I1", 1, "Project A");
      await controller.addTask("Persistent task 2", 2, "I2", 2, "Project B", {
        priority: "high",
      });

      const task1 = controller.getTasks()[0];
      await controller.addLoggedHours(task1.id, 2.5);
      await controller.markDone(controller.getTasks()[1].id);

      // Create new controller with same storage
      const newController = new KanbanController(mockGlobalState);

      // Verify state restored
      const restored = newController.getTasks();
      expect(restored).toHaveLength(2);

      const restoredTask1 = restored.find((t) => t.id === task1.id);
      expect(restoredTask1?.title).toBe("Persistent task 1");
      expect(restoredTask1?.loggedHours).toBe(2.5);

      const restoredTask2 = restored.find((t) => t.linkedIssueId === 2);
      expect(restoredTask2?.priority).toBe("high");
      expect(restoredTask2?.completedAt).toBeDefined();

      newController.dispose();
    });

    it("should filter invalid tasks on restore", async () => {
      // Manually set invalid data in storage
      mockStorage.set("redmine.kanban", [
        { id: "valid", title: "Valid", linkedIssueId: 1, linkedIssueSubject: "I", linkedProjectId: 1, linkedProjectName: "P", loggedHours: 0, priority: "medium", createdAt: "2025-01-01", updatedAt: "2025-01-01" },
        { id: "missing-fields" }, // Invalid
        null, // Invalid
        { id: "bad-priority", title: "Bad", linkedIssueId: 2, linkedIssueSubject: "I", linkedProjectId: 1, linkedProjectName: "P", loggedHours: 0, priority: "invalid", createdAt: "2025-01-01", updatedAt: "2025-01-01" }, // Invalid priority
        { id: "negative-hours", title: "Neg", linkedIssueId: 3, linkedIssueSubject: "I", linkedProjectId: 1, linkedProjectName: "P", loggedHours: -5, priority: "low", createdAt: "2025-01-01", updatedAt: "2025-01-01" }, // Invalid loggedHours
      ]);

      const newController = new KanbanController(mockGlobalState);
      const tasks = newController.getTasks();

      // Only the first valid task should be restored
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe("valid");

      newController.dispose();
    });
  });

  describe("Issue Linking", () => {
    it("should find tasks by linked issue ID", async () => {
      await controller.addTask("Subtask 1", 100, "Main Issue", 1, "P");
      await controller.addTask("Subtask 2", 100, "Main Issue", 1, "P");
      await controller.addTask("Other task", 200, "Other Issue", 1, "P");

      const linkedTasks = controller.getTasksByIssueId(100);
      expect(linkedTasks).toHaveLength(2);
      expect(linkedTasks.every((t) => t.linkedIssueId === 100)).toBe(true);

      const otherTasks = controller.getTasksByIssueId(200);
      expect(otherTasks).toHaveLength(1);
    });
  });
});
