import { describe, it, expect } from "vitest";
import {
  getTaskStatus,
  groupTasksByStatus,
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
