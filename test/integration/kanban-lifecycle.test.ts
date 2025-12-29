import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  KanbanController,
  MockGlobalState,
} from "../../src/kanban/kanban-controller";
import { getTaskStatus } from "../../src/kanban/kanban-state";

/**
 * Integration Tests: Kanban Task Lifecycle
 *
 * Tests complete multi-step kanban workflows.
 * Unit tests cover individual operations; these test realistic user scenarios.
 */
describe("Integration: Kanban Task Lifecycle", () => {
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

  it("full task lifecycle: create → update → log hours → done → reopen → delete", async () => {
    // Create
    const task = await controller.addTask(
      "Implement feature",
      123,
      "Main Issue",
      1,
      "Project",
      { priority: "high" }
    );
    expect(getTaskStatus(task)).toBe("todo");

    // Update
    await controller.updateTask(task.id, { title: "Implement secure feature" });
    expect(controller.getTaskById(task.id)?.title).toBe("Implement secure feature");

    // Log hours → in-progress
    await controller.addLoggedHours(task.id, 2.5);
    expect(getTaskStatus(controller.getTaskById(task.id)!)).toBe("in-progress");

    // Mark done
    await controller.markDone(task.id);
    expect(getTaskStatus(controller.getTaskById(task.id)!)).toBe("done");

    // Reopen (stays in-progress due to logged hours)
    await controller.reopen(task.id);
    expect(getTaskStatus(controller.getTaskById(task.id)!)).toBe("in-progress");

    // Delete
    await controller.deleteTask(task.id);
    expect(controller.getTasks()).toHaveLength(0);
  });

  it("cross-instance persistence: tasks survive controller recreation", async () => {
    // Create tasks with various states
    const task1 = await controller.addTask("Task 1", 1, "I1", 1, "P");
    await controller.addTask("Task 2", 2, "I2", 1, "P", { priority: "high" });
    await controller.addLoggedHours(task1.id, 2.5);
    await controller.markDone(controller.getTasks()[1].id);

    // New controller instance
    const newController = new KanbanController(mockGlobalState);

    const restored = newController.getTasks();
    expect(restored).toHaveLength(2);
    expect(restored.find(t => t.id === task1.id)?.loggedHours).toBe(2.5);
    expect(restored.find(t => t.linkedIssueId === 2)?.completedAt).toBeDefined();

    newController.dispose();
  });

  it("corrupted storage recovery: filters invalid tasks on restore", async () => {
    mockStorage.set("redmine.kanban", [
      { id: "valid", title: "Valid", linkedIssueId: 1, linkedIssueSubject: "I", linkedProjectId: 1, linkedProjectName: "P", loggedHours: 0, priority: "medium", createdAt: "2025-01-01", updatedAt: "2025-01-01" },
      { id: "missing-fields" },
      null,
      { id: "bad-priority", title: "Bad", linkedIssueId: 2, linkedIssueSubject: "I", linkedProjectId: 1, linkedProjectName: "P", loggedHours: 0, priority: "invalid", createdAt: "2025-01-01", updatedAt: "2025-01-01" },
    ]);

    const newController = new KanbanController(mockGlobalState);
    expect(newController.getTasks()).toHaveLength(1);
    expect(newController.getTasks()[0].id).toBe("valid");

    newController.dispose();
  });
});
