import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyDraftsWithTracking } from "../../../src/commands/draft-mode-commands";
import type { DraftOperation } from "../../../src/draft-mode/draft-operation";
import { DRAFT_COMMAND_SOURCE } from "../../../src/draft-mode/draft-change-sources";

describe("applyDraftsWithTracking", () => {
  let mockServer: {
    setIssueStatus: ReturnType<typeof vi.fn>;
    updateIssueDates: ReturnType<typeof vi.fn>;
    updateDoneRatio: ReturnType<typeof vi.fn>;
    setIssuePriority: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    createIssue: ReturnType<typeof vi.fn>;
    addTimeEntry: ReturnType<typeof vi.fn>;
    updateTimeEntry: ReturnType<typeof vi.fn>;
    deleteTimeEntry: ReturnType<typeof vi.fn>;
    createVersion: ReturnType<typeof vi.fn>;
    updateVersion: ReturnType<typeof vi.fn>;
    deleteVersion: ReturnType<typeof vi.fn>;
    createRelation: ReturnType<typeof vi.fn>;
    deleteRelation: ReturnType<typeof vi.fn>;
  };

  let mockQueue: {
    remove: ReturnType<typeof vi.fn>;
    removeMany?: ReturnType<typeof vi.fn>;
  };

  const createOp = (id: string, description: string): DraftOperation => ({
    id,
    type: "setIssueStatus",
    timestamp: Date.now(),
    issueId: 123,
    description,
    resourceKey: `issue:123:status:${id}`,
    http: {
      method: "PUT",
      path: "/issues/123.json",
      data: { issue: { status_id: 2 } },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = {
      setIssueStatus: vi.fn().mockResolvedValue({}),
      updateIssueDates: vi.fn().mockResolvedValue({}),
      updateDoneRatio: vi.fn().mockResolvedValue({}),
      setIssuePriority: vi.fn().mockResolvedValue({}),
      put: vi.fn().mockResolvedValue({}),
      createIssue: vi.fn().mockResolvedValue({}),
      addTimeEntry: vi.fn().mockResolvedValue({}),
      updateTimeEntry: vi.fn().mockResolvedValue({}),
      deleteTimeEntry: vi.fn().mockResolvedValue({}),
      createVersion: vi.fn().mockResolvedValue({}),
      updateVersion: vi.fn().mockResolvedValue({}),
      deleteVersion: vi.fn().mockResolvedValue({}),
      createRelation: vi.fn().mockResolvedValue({}),
      deleteRelation: vi.fn().mockResolvedValue({}),
    };
    mockQueue = {
      remove: vi.fn().mockResolvedValue(undefined),
      removeMany: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("tracks all successful operations", async () => {
    const ops = [createOp("1", "Op 1"), createOp("2", "Op 2")];

    const result = await applyDraftsWithTracking(
      mockServer as never,
      mockQueue as never,
      ops,
      () => true
    );

    expect(result.succeeded).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("tracks failed operations separately", async () => {
    const ops = [createOp("1", "Op 1"), createOp("2", "Op 2"), createOp("3", "Op 3")];
    
    mockServer.setIssueStatus
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({});

    const result = await applyDraftsWithTracking(
      mockServer as never,
      mockQueue as never,
      ops,
      () => true
    );

    expect(result.succeeded).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toBe("Network error");
    expect(result.failed[0].operation.id).toBe("2");
  });

  it("stops processing when onError returns false", async () => {
    const ops = [createOp("1", "Op 1"), createOp("2", "Op 2"), createOp("3", "Op 3")];
    
    mockServer.setIssueStatus
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("Stop here"));

    const result = await applyDraftsWithTracking(
      mockServer as never,
      mockQueue as never,
      ops,
      () => false
    );

    expect(result.succeeded).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].id).toBe("3");
  });

  it("removes successful operations from queue", async () => {
    const ops = [createOp("1", "Op 1")];

    await applyDraftsWithTracking(
      mockServer as never,
      mockQueue as never,
      ops,
      () => true
    );

    expect(mockQueue.removeMany).toHaveBeenCalledWith(["1"], DRAFT_COMMAND_SOURCE);
    expect(mockQueue.remove).not.toHaveBeenCalled();
  });

  it("does not remove failed operations from queue", async () => {
    const ops = [createOp("1", "Op 1")];
    mockServer.setIssueStatus.mockRejectedValue(new Error("Fail"));

    await applyDraftsWithTracking(
      mockServer as never,
      mockQueue as never,
      ops,
      () => true
    );

    expect(mockQueue.removeMany).not.toHaveBeenCalled();
    expect(mockQueue.remove).not.toHaveBeenCalled();
  });

  it("falls back to remove when removeMany is unavailable", async () => {
    const ops = [createOp("1", "Op 1"), createOp("2", "Op 2")];
    delete mockQueue.removeMany;

    await applyDraftsWithTracking(
      mockServer as never,
      mockQueue as never,
      ops,
      () => true
    );

    expect(mockQueue.remove).toHaveBeenCalledTimes(2);
    expect(mockQueue.remove).toHaveBeenNthCalledWith(1, "1", DRAFT_COMMAND_SOURCE);
    expect(mockQueue.remove).toHaveBeenNthCalledWith(2, "2", DRAFT_COMMAND_SOURCE);
  });

  it("fails operation when issueId is missing for issue-based drafts", async () => {
    const opWithoutIssueId: DraftOperation = {
      ...createOp("missing-issue", "Op missing issueId"),
      issueId: undefined,
    };

    const result = await applyDraftsWithTracking(
      mockServer as never,
      mockQueue as never,
      [opWithoutIssueId],
      () => true
    );

    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain("missing issueId");
    expect(mockServer.setIssueStatus).not.toHaveBeenCalled();
  });

  it("fails operation when resourceId is missing for resource-based drafts", async () => {
    const opWithoutResourceId: DraftOperation = {
      id: "missing-resource",
      type: "updateTimeEntry",
      timestamp: Date.now(),
      description: "Update entry without resourceId",
      resourceKey: "timeentry:missing-resource",
      http: {
        method: "PUT",
        path: "/time_entries/123.json",
        data: { time_entry: { hours: "1.0" } },
      },
      resourceId: undefined,
    };

    const result = await applyDraftsWithTracking(
      mockServer as never,
      mockQueue as never,
      [opWithoutResourceId],
      () => true
    );

    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain("missing resourceId");
    expect(mockServer.updateTimeEntry).not.toHaveBeenCalled();
  });

  it("routes supported operation types to server methods", async () => {
    const ops: DraftOperation[] = [
      createOp("status", "Set status"),
      {
        ...createOp("dates", "Set dates"),
        type: "setIssueDates",
        http: { method: "PUT", path: "/issues/123.json", data: { issue: { start_date: "2026-02-01", due_date: "2026-02-02" } } },
      },
      {
        ...createOp("done", "Set done"),
        type: "setIssueDoneRatio",
        http: { method: "PUT", path: "/issues/123.json", data: { issue: { done_ratio: 60 } } },
      },
      {
        ...createOp("priority", "Set priority"),
        type: "setIssuePriority",
        http: { method: "PUT", path: "/issues/123.json", data: { issue: { priority_id: 5 } } },
      },
      {
        ...createOp("assignee", "Set assignee"),
        type: "setIssueAssignee",
        http: { method: "PUT", path: "/issues/123.json", data: { issue: { assigned_to_id: 11 } } },
      },
      {
        ...createOp("note", "Add note"),
        type: "addIssueNote",
        http: { method: "PUT", path: "/issues/123.json", data: { issue: { notes: "hello" } } },
      },
      {
        ...createOp("create-issue", "Create issue"),
        type: "createIssue",
        issueId: undefined,
        http: { method: "POST", path: "/issues.json", data: { issue: { project_id: 1, subject: "X" } } },
      },
      {
        ...createOp("create-entry", "Create entry"),
        type: "createTimeEntry",
        issueId: undefined,
        http: {
          method: "POST",
          path: "/time_entries.json",
          data: { time_entry: { issue_id: 123, activity_id: 9, hours: "1.5", comments: "work" } },
        },
      },
      {
        ...createOp("update-entry", "Update entry"),
        type: "updateTimeEntry",
        issueId: undefined,
        resourceId: 77,
        http: { method: "PUT", path: "/time_entries/77.json", data: { time_entry: { comments: "new" } } },
      },
      {
        ...createOp("delete-entry", "Delete entry"),
        type: "deleteTimeEntry",
        issueId: undefined,
        resourceId: 78,
        http: { method: "DELETE", path: "/time_entries/78.json", data: {} },
      },
      {
        ...createOp("create-version", "Create version"),
        type: "createVersion",
        issueId: undefined,
        http: { method: "POST", path: "/projects/ops/versions.json", data: { version: { name: "v1" } } },
      },
      {
        ...createOp("update-version", "Update version"),
        type: "updateVersion",
        issueId: undefined,
        resourceId: 99,
        http: { method: "PUT", path: "/versions/99.json", data: { version: { name: "v2" } } },
      },
      {
        ...createOp("delete-version", "Delete version"),
        type: "deleteVersion",
        issueId: undefined,
        resourceId: 100,
        http: { method: "DELETE", path: "/versions/100.json", data: {} },
      },
      {
        ...createOp("create-relation", "Create relation"),
        type: "createRelation",
        issueId: undefined,
        http: {
          method: "POST",
          path: "/issues/123/relations.json",
          data: { relation: { issue_to_id: 200, relation_type: "blocks", delay: 1 } },
        },
      },
      {
        ...createOp("delete-relation", "Delete relation"),
        type: "deleteRelation",
        issueId: undefined,
        resourceId: 101,
        http: { method: "DELETE", path: "/relations/101.json", data: {} },
      },
    ];

    const result = await applyDraftsWithTracking(
      mockServer as never,
      mockQueue as never,
      ops,
      () => true
    );

    expect(result.failed).toHaveLength(0);
    expect(result.succeeded).toHaveLength(ops.length);
    expect(mockServer.updateIssueDates).toHaveBeenCalledWith(123, "2026-02-01", "2026-02-02", { _bypassDraft: true });
    expect(mockServer.updateDoneRatio).toHaveBeenCalledWith(123, 60, { _bypassDraft: true });
    expect(mockServer.setIssuePriority).toHaveBeenCalledWith(123, 5, { _bypassDraft: true });
    expect(mockServer.createIssue).toHaveBeenCalled();
    expect(mockServer.addTimeEntry).toHaveBeenCalled();
    expect(mockServer.createVersion).toHaveBeenCalledWith("ops", { name: "v1" }, { _bypassDraft: true });
    expect(mockServer.createRelation).toHaveBeenCalledWith(123, 200, "blocks", 1, { _bypassDraft: true });
    expect(mockServer.deleteRelation).toHaveBeenCalledWith(101, { _bypassDraft: true });
  });

  it("falls back to per-item removal when removeMany throws", async () => {
    const ops = [createOp("1", "Op 1"), createOp("2", "Op 2")];
    mockQueue.removeMany = vi.fn().mockRejectedValue(new Error("persist fail"));

    await applyDraftsWithTracking(
      mockServer as never,
      mockQueue as never,
      ops,
      () => true
    );

    expect(mockQueue.remove).toHaveBeenCalledTimes(2);
    expect(mockQueue.remove).toHaveBeenNthCalledWith(1, "1", DRAFT_COMMAND_SOURCE);
    expect(mockQueue.remove).toHaveBeenNthCalledWith(2, "2", DRAFT_COMMAND_SOURCE);
  });

  it("reports unknown operation type as failure", async () => {
    const unknownOp = {
      ...createOp("unknown", "Unknown op"),
      type: "unknownOperation",
    } as unknown as DraftOperation;

    const result = await applyDraftsWithTracking(
      mockServer as never,
      mockQueue as never,
      [unknownOp],
      () => true
    );

    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain("Unknown operation type");
  });
});
