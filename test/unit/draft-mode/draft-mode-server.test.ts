import { describe, it, expect, vi, beforeEach } from "vitest";
import { DraftModeServer } from "../../../src/draft-mode/draft-mode-server";
import { DraftQueue } from "../../../src/draft-mode/draft-queue";
import { DraftModeManager } from "../../../src/draft-mode/draft-mode-manager";
import type { RedmineServer } from "../../../src/redmine/redmine-server";

function createMockServer(): RedmineServer {
  return {
    // Write methods
    createIssue: vi.fn().mockResolvedValue({ issue: { id: 123 } }),
    setIssueStatus: vi.fn().mockResolvedValue(null),
    updateIssueDates: vi.fn().mockResolvedValue(null),
    updateDoneRatio: vi.fn().mockResolvedValue(null),
    setIssuePriority: vi.fn().mockResolvedValue(null),
    addTimeEntry: vi.fn().mockResolvedValue({ time_entry: { id: 456 } }),
    updateTimeEntry: vi.fn().mockResolvedValue(null),
    deleteTimeEntry: vi.fn().mockResolvedValue(null),
    createVersion: vi.fn().mockResolvedValue({ id: 789 }),
    updateVersion: vi.fn().mockResolvedValue(null),
    deleteVersion: vi.fn().mockResolvedValue(null),
    createRelation: vi.fn().mockResolvedValue({ relation: { id: 111 } }),
    deleteRelation: vi.fn().mockResolvedValue(null),
    applyQuickUpdate: vi.fn().mockResolvedValue({ differences: [] }),
    // Read methods (all passthrough methods)
    getIssueById: vi.fn().mockResolvedValue({ issue: { id: 123 } }),
    getIssueWithJournals: vi.fn().mockResolvedValue({ issue: { id: 123 } }),
    getIssuesByIds: vi.fn().mockResolvedValue([]),
    getFilteredIssues: vi.fn().mockResolvedValue({ issues: [] }),
    getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [] }),
    getAllOpenIssues: vi.fn().mockResolvedValue({ issues: [] }),
    getOpenIssuesForProject: vi.fn().mockResolvedValue({ issues: [] }),
    searchIssues: vi.fn().mockResolvedValue([]),
    getProjects: vi.fn().mockResolvedValue([]),
    clearProjectsCache: vi.fn(),
    getTimeEntries: vi.fn().mockResolvedValue({ time_entries: [] }),
    getProjectTimeEntries: vi.fn().mockResolvedValue([]),
    getAllTimeEntries: vi.fn().mockResolvedValue([]),
    getTimeEntriesForIssues: vi.fn().mockResolvedValue([]),
    getTimeEntryActivities: vi.fn().mockResolvedValue({ time_entry_activities: [] }),
    getProjectTimeEntryActivities: vi.fn().mockResolvedValue([]),
    getProjectVersions: vi.fn().mockResolvedValue([]),
    getVersionsForProjects: vi.fn().mockResolvedValue(new Map()),
    getIssueStatuses: vi.fn().mockResolvedValue({ issue_statuses: [] }),
    getIssueStatusesTyped: vi.fn().mockResolvedValue([]),
    getIssuePriorities: vi.fn().mockResolvedValue({ issue_priorities: [] }),
    getPriorities: vi.fn().mockResolvedValue([]),
    getTrackers: vi.fn().mockResolvedValue([]),
    getCurrentUser: vi.fn().mockResolvedValue(undefined),
    getCustomFields: vi.fn().mockResolvedValue([]),
    getMemberships: vi.fn().mockResolvedValue([]),
    isTimeTrackingEnabled: vi.fn().mockResolvedValue(true),
    compare: vi.fn().mockReturnValue(true),
    options: { address: "https://test.com", key: "test" },
  } as unknown as RedmineServer;
}

function createMockQueue(): DraftQueue {
  const ops: unknown[] = [];
  return {
    add: vi.fn().mockImplementation((op) => {
      ops.push(op);
      return Promise.resolve();
    }),
    getAll: vi.fn().mockImplementation(() => ops),
    count: ops.length,
    onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  } as unknown as DraftQueue;
}

function createMockManager(enabled: boolean): DraftModeManager {
  return {
    isEnabled: enabled,
    onDidChangeEnabled: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  } as unknown as DraftModeManager;
}

describe("DraftModeServer", () => {
  let innerServer: RedmineServer;
  let queue: DraftQueue;

  beforeEach(() => {
    innerServer = createMockServer();
    queue = createMockQueue();
  });

  describe("when draft mode OFF", () => {
    it("passes through setIssueStatus to inner server", async () => {
      const manager = createMockManager(false);
      const server = new DraftModeServer(innerServer, queue, manager);

      await server.setIssueStatus({ id: 123 }, 5);

      expect(innerServer.setIssueStatus).toHaveBeenCalledWith({ id: 123 }, 5);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("passes through createIssue to inner server", async () => {
      const manager = createMockManager(false);
      const server = new DraftModeServer(innerServer, queue, manager);

      const result = await server.createIssue({
        project_id: 1,
        tracker_id: 1,
        subject: "Test",
      });

      expect(innerServer.createIssue).toHaveBeenCalled();
      expect(result).toEqual({ issue: { id: 123 } });
    });

    it("passes through read methods unchanged", async () => {
      const manager = createMockManager(false);
      const server = new DraftModeServer(innerServer, queue, manager);

      await server.getIssueById(123);

      expect(innerServer.getIssueById).toHaveBeenCalledWith(123);
    });
  });

  describe("when draft mode ON", () => {
    it("queues setIssueStatus instead of calling server", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      await server.setIssueStatus({ id: 123 }, 5);

      expect(innerServer.setIssueStatus).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "setIssueStatus",
          issueId: 123,
          resourceKey: "issue:123:status",
        })
      );
    });

    it("queues updateIssueDates", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      await server.updateIssueDates(123, "2026-01-01", "2026-01-31");

      expect(innerServer.updateIssueDates).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "setIssueDates",
          issueId: 123,
          resourceKey: "issue:123:dates",
        })
      );
    });

    it("queues updateDoneRatio", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      await server.updateDoneRatio(123, 50);

      expect(innerServer.updateDoneRatio).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "setIssueDoneRatio",
          issueId: 123,
          resourceKey: "issue:123:done_ratio",
        })
      );
    });

    it("queues addTimeEntry with temp ID", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      const result = await server.addTimeEntry(123, 1, "2.5", "Work", "2026-01-18");

      expect(innerServer.addTimeEntry).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "createTimeEntry",
          issueId: 123,
        })
      );
      // Should return stub result with temp ID
      expect(result.time_entry.id).toBeLessThan(0);
    });

    it("queues createIssue with temp ID", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      const result = await server.createIssue({
        project_id: 1,
        tracker_id: 1,
        subject: "Test Issue",
      });

      expect(innerServer.createIssue).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "createIssue",
        })
      );
      // Should return stub result with temp ID
      expect(result.issue.id).toBeLessThan(0);
    });

    it("always passes through read methods", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      await server.getIssueById(123);

      expect(innerServer.getIssueById).toHaveBeenCalledWith(123);
    });
  });

  describe("bypass flag", () => {
    it("passes through when _bypassDraft is true", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      await server.setIssueStatus({ id: 123 }, 5, { _bypassDraft: true });

      expect(innerServer.setIssueStatus).toHaveBeenCalledWith({ id: 123 }, 5);
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe("additional write methods when draft ON", () => {
    it("queues setIssuePriority", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      await server.setIssuePriority(123, 3);

      expect(innerServer.setIssuePriority).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "setIssuePriority",
          issueId: 123,
          resourceKey: "issue:123:priority",
        })
      );
    });

    it("queues updateTimeEntry", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      await server.updateTimeEntry(456, { hours: 3, comments: "Updated" });

      expect(innerServer.updateTimeEntry).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "updateTimeEntry",
          resourceId: 456,
          resourceKey: "timeentry:456:update",
        })
      );
    });

    it("queues deleteTimeEntry", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      await server.deleteTimeEntry(456);

      expect(innerServer.deleteTimeEntry).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "deleteTimeEntry",
          resourceId: 456,
          resourceKey: "timeentry:456:delete",
        })
      );
    });

    it("queues createVersion with temp ID", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      const result = await server.createVersion(1, { name: "v1.0" });

      expect(innerServer.createVersion).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "createVersion",
        })
      );
      expect(result.id).toBeLessThan(0); // temp ID
      expect(result.name).toBe("v1.0");
    });

    it("queues updateVersion", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      await server.updateVersion(789, { status: "closed" });

      expect(innerServer.updateVersion).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "updateVersion",
          resourceId: 789,
          resourceKey: "version:789:update",
        })
      );
    });

    it("queues deleteVersion", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      await server.deleteVersion(789);

      expect(innerServer.deleteVersion).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "deleteVersion",
          resourceId: 789,
          resourceKey: "version:789:delete",
        })
      );
    });

    it("queues createRelation with delay", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      const result = await server.createRelation(100, 200, "precedes", 5);

      expect(innerServer.createRelation).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "createRelation",
          issueId: 100,
          description: expect.stringContaining("delay: 5"),
        })
      );
      expect(result.relation.id).toBeLessThan(0);
      expect(result.relation.delay).toBe(5);
    });

    it("queues createRelation without delay for non-precedes", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      const result = await server.createRelation(100, 200, "blocks");

      expect(queue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "createRelation",
          description: expect.not.stringContaining("delay"),
        })
      );
      expect(result.relation.relation_type).toBe("blocks");
    });

    it("queues deleteRelation", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      await server.deleteRelation(111);

      expect(innerServer.deleteRelation).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "deleteRelation",
          resourceId: 111,
          resourceKey: "relation:111:delete",
        })
      );
    });
  });

  describe("applyQuickUpdate", () => {
    it("splits into multiple operations when draft ON", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      await server.applyQuickUpdate({
        issueId: 123,
        status: { statusId: 2, name: "In Progress" },
        assignee: { id: 5, name: "John" },
        message: "Note text",
        startDate: "2026-01-01",
        dueDate: "2026-01-31",
      });

      expect(innerServer.applyQuickUpdate).not.toHaveBeenCalled();
      // Should create 4 operations: status, assignee, note, dates
      expect(queue.add).toHaveBeenCalledTimes(4);
      expect(queue.add).toHaveBeenCalledWith(expect.objectContaining({ type: "setIssueStatus" }));
      expect(queue.add).toHaveBeenCalledWith(expect.objectContaining({ type: "setIssueAssignee" }));
      expect(queue.add).toHaveBeenCalledWith(expect.objectContaining({ type: "addIssueNote" }));
      expect(queue.add).toHaveBeenCalledWith(expect.objectContaining({ type: "setIssueDates" }));
    });

    it("skips note operation when no message", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      await server.applyQuickUpdate({
        issueId: 123,
        status: { statusId: 2, name: "In Progress" },
        assignee: { id: 5, name: "John" },
      });

      // Should create 2 operations: status, assignee (no note, no dates)
      expect(queue.add).toHaveBeenCalledTimes(2);
    });

    it("passes through when draft OFF", async () => {
      const manager = createMockManager(false);
      const server = new DraftModeServer(innerServer, queue, manager);

      await server.applyQuickUpdate({
        issueId: 123,
        status: { statusId: 2, name: "In Progress" },
        assignee: { id: 5, name: "John" },
      });

      expect(innerServer.applyQuickUpdate).toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe("options passthrough", () => {
    it("returns inner server options", () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);

      expect(server.options).toEqual(innerServer.options);
    });
  });

  describe("generic HTTP passthroughs", () => {
    it("post passes through", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);
      (innerServer as unknown as { post: ReturnType<typeof vi.fn> }).post = vi.fn().mockResolvedValue({ data: "ok" });

      await server.post("/path", { key: "value" });

      expect((innerServer as unknown as { post: ReturnType<typeof vi.fn> }).post).toHaveBeenCalledWith("/path", { key: "value" });
    });

    it("put passes through", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);
      (innerServer as unknown as { put: ReturnType<typeof vi.fn> }).put = vi.fn().mockResolvedValue({ data: "ok" });

      await server.put("/path", { key: "value" });

      expect((innerServer as unknown as { put: ReturnType<typeof vi.fn> }).put).toHaveBeenCalledWith("/path", { key: "value" });
    });

    it("delete passes through", async () => {
      const manager = createMockManager(true);
      const server = new DraftModeServer(innerServer, queue, manager);
      (innerServer as unknown as { delete: ReturnType<typeof vi.fn> }).delete = vi.fn().mockResolvedValue(null);

      await server.delete("/path");

      expect((innerServer as unknown as { delete: ReturnType<typeof vi.fn> }).delete).toHaveBeenCalledWith("/path");
    });
  });
});
