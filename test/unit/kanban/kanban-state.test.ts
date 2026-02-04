import { describe, it, expect } from "vitest";
import {
  getTaskStatus,
  groupTasksByStatus,
  createKanbanTask,
  sortTasksByPriority,
  KanbanTask,
} from "../../../src/kanban/kanban-state";

function createTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "test-id",
    title: "Test Task",
    priority: "medium",
    linkedIssueId: 123,
    linkedIssueSubject: "Test Issue",
    linkedProjectId: 1,
    linkedProjectName: "Test Project",
    loggedHours: 0,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("getTaskStatus", () => {
  describe("3-column status derivation", () => {
    it("returns todo for task with no hours, no timer, not completed", () => {
      const task = createTask({ loggedHours: 0 });
      expect(getTaskStatus(task)).toBe("todo");
    });

    it("returns doing for task with loggedHours > 0", () => {
      const task = createTask({ loggedHours: 0.5 });
      expect(getTaskStatus(task)).toBe("doing");
    });

    it("returns doing for task with timerPhase=working", () => {
      const task = createTask({ timerPhase: "working" });
      expect(getTaskStatus(task)).toBe("doing");
    });

    it("returns doing for task with timerPhase=paused", () => {
      const task = createTask({ timerPhase: "paused" });
      expect(getTaskStatus(task)).toBe("doing");
    });

    it("returns done for task with completedAt set", () => {
      const task = createTask({ completedAt: "2025-01-02T00:00:00Z" });
      expect(getTaskStatus(task)).toBe("done");
    });

    it("done takes precedence over doing", () => {
      const task = createTask({
        loggedHours: 2.5,
        timerPhase: "paused",
        completedAt: "2025-01-02T00:00:00Z",
      });
      expect(getTaskStatus(task)).toBe("done");
    });

    it("timerPhase=pending does not trigger doing", () => {
      const task = createTask({ timerPhase: "pending", loggedHours: 0 });
      expect(getTaskStatus(task)).toBe("todo");
    });

    it("timerPhase=completed without hours stays todo", () => {
      const task = createTask({ timerPhase: "completed", loggedHours: 0 });
      expect(getTaskStatus(task)).toBe("todo");
    });

    it("returns doing for task with doingAt set (drag-drop initialized)", () => {
      const task = createTask({ doingAt: "2025-01-02T00:00:00Z", loggedHours: 0 });
      expect(getTaskStatus(task)).toBe("doing");
    });

    it("returns doing for task with doingAt + timerSecondsLeft (initialized timer)", () => {
      const task = createTask({
        doingAt: "2025-01-02T00:00:00Z",
        timerSecondsLeft: 2700, // 45 min
        loggedHours: 0,
      });
      expect(getTaskStatus(task)).toBe("doing");
    });

    it("done takes precedence over doingAt", () => {
      const task = createTask({
        doingAt: "2025-01-02T00:00:00Z",
        completedAt: "2025-01-03T00:00:00Z",
      });
      expect(getTaskStatus(task)).toBe("done");
    });
  });
});

describe("groupTasksByStatus", () => {
  it("groups tasks into todo, doing, done columns", () => {
    const tasks = [
      createTask({ id: "1", loggedHours: 0 }),
      createTask({ id: "2", loggedHours: 1 }),
      createTask({ id: "3", timerPhase: "working" }),
      createTask({ id: "4", completedAt: "2025-01-02T00:00:00Z" }),
    ];

    const grouped = groupTasksByStatus(tasks);

    expect(grouped.todo).toHaveLength(1);
    expect(grouped.todo[0].id).toBe("1");

    expect(grouped.doing).toHaveLength(2);
    expect(grouped.doing.map(t => t.id).sort()).toEqual(["2", "3"]);

    expect(grouped.done).toHaveLength(1);
    expect(grouped.done[0].id).toBe("4");
  });
});

describe("createKanbanTask", () => {
  it("creates task with required fields", () => {
    const task = createKanbanTask("Test Task", 123, "Issue Subject", 1, "Project");

    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.title).toBe("Test Task");
    expect(task.linkedIssueId).toBe(123);
    expect(task.linkedIssueSubject).toBe("Issue Subject");
    expect(task.linkedProjectId).toBe(1);
    expect(task.linkedProjectName).toBe("Project");
    expect(task.priority).toBe("medium"); // Default
    expect(task.loggedHours).toBe(0);
    expect(task.createdAt).toBeDefined();
    expect(task.updatedAt).toBeDefined();
  });

  it("creates task with optional fields", () => {
    const task = createKanbanTask("Test Task", 123, "Issue", 1, "Project", {
      description: "Task description",
      priority: "high",
      estimatedHours: 2.5,
      linkedParentProjectId: 10,
      linkedParentProjectName: "Parent Project",
    });

    expect(task.description).toBe("Task description");
    expect(task.priority).toBe("high");
    expect(task.estimatedHours).toBe(2.5);
    expect(task.linkedParentProjectId).toBe(10);
    expect(task.linkedParentProjectName).toBe("Parent Project");
  });

  it("generates unique IDs", () => {
    const task1 = createKanbanTask("Task 1", 1, "Issue 1", 1, "Project");
    const task2 = createKanbanTask("Task 2", 2, "Issue 2", 1, "Project");

    expect(task1.id).not.toBe(task2.id);
  });
});

describe("sortTasksByPriority", () => {
  it("sorts by priority (high first)", () => {
    const tasks = [
      createTask({ id: "low", priority: "low", createdAt: "2025-01-01T00:00:00Z" }),
      createTask({ id: "high", priority: "high", createdAt: "2025-01-01T00:00:00Z" }),
      createTask({ id: "medium", priority: "medium", createdAt: "2025-01-01T00:00:00Z" }),
    ];

    const sorted = sortTasksByPriority(tasks);

    expect(sorted.map(t => t.id)).toEqual(["high", "medium", "low"]);
  });

  it("sorts by sortOrder before priority", () => {
    const tasks = [
      createTask({ id: "high-no-order", priority: "high" }),
      createTask({ id: "low-order-2", priority: "low", sortOrder: 2 }),
      createTask({ id: "med-order-1", priority: "medium", sortOrder: 1 }),
    ];

    const sorted = sortTasksByPriority(tasks);

    expect(sorted.map(t => t.id)).toEqual(["med-order-1", "low-order-2", "high-no-order"]);
  });

  it("sorts by creation date within same priority (newest first)", () => {
    const tasks = [
      createTask({ id: "old", priority: "high", createdAt: "2025-01-01T00:00:00Z" }),
      createTask({ id: "new", priority: "high", createdAt: "2025-01-03T00:00:00Z" }),
      createTask({ id: "mid", priority: "high", createdAt: "2025-01-02T00:00:00Z" }),
    ];

    const sorted = sortTasksByPriority(tasks);

    expect(sorted.map(t => t.id)).toEqual(["new", "mid", "old"]);
  });

  it("handles invalid priority by defaulting to medium", () => {
    const tasks = [
      createTask({ id: "valid", priority: "low" }),
      createTask({ id: "invalid", priority: "unknown" as "medium" }), // Invalid priority
    ];

    const sorted = sortTasksByPriority(tasks);

    // Invalid priority defaults to medium (1), low is 2
    expect(sorted.map(t => t.id)).toEqual(["invalid", "valid"]);
  });

  it("handles invalid dates by treating as oldest", () => {
    const tasks = [
      createTask({ id: "valid", priority: "high", createdAt: "2025-01-01T00:00:00Z" }),
      createTask({ id: "invalid", priority: "high", createdAt: "invalid-date" }),
    ];

    const sorted = sortTasksByPriority(tasks);

    // Valid date is newer (has actual timestamp), invalid date is 0 (oldest)
    expect(sorted.map(t => t.id)).toEqual(["valid", "invalid"]);
  });

  it("does not mutate original array", () => {
    const tasks = [
      createTask({ id: "b", priority: "low" }),
      createTask({ id: "a", priority: "high" }),
    ];
    const original = [...tasks];

    sortTasksByPriority(tasks);

    expect(tasks).toEqual(original);
  });
});
