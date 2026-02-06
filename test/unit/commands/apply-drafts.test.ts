import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyDraftsWithTracking } from "../../../src/commands/draft-mode-commands";
import type { DraftOperation } from "../../../src/draft-mode/draft-operation";
import { DRAFT_COMMAND_SOURCE } from "../../../src/draft-mode/draft-change-sources";

describe("applyDraftsWithTracking", () => {
  let mockServer: {
    setIssueStatus: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
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
      put: vi.fn().mockResolvedValue({}),
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
});
