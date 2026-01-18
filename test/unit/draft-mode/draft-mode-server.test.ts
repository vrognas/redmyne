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
});
