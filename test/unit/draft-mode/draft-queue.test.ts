import { describe, it, expect, vi, beforeEach } from "vitest";
import { DraftQueue } from "../../../src/draft-mode/draft-queue";
import type { DraftOperation } from "../../../src/draft-mode/draft-operation";
import type * as vscode from "vscode";

function createOp(overrides: Partial<DraftOperation> = {}): DraftOperation {
  return {
    id: crypto.randomUUID(),
    type: "setIssueStatus",
    timestamp: Date.now(),
    issueId: 123,
    description: "Test operation",
    http: { method: "PUT", path: "/issues/123.json", data: {} },
    resourceKey: "issue:123:status",
    ...overrides,
  };
}

describe("DraftQueue", () => {
  let queue: DraftQueue;
  let mockFileData: Uint8Array | null;
  let mockFs: vscode.FileSystem;
  const storagePath = { fsPath: "/test/drafts.json", scheme: "file" } as vscode.Uri;
  const serverIdentity = "test-server-identity-hash";

  beforeEach(() => {
    mockFileData = null;
    mockFs = {
      readFile: vi.fn().mockImplementation(async () => {
        if (mockFileData === null) {
          throw new Error("File not found");
        }
        return mockFileData;
      }),
      writeFile: vi.fn().mockImplementation(async (_uri: vscode.Uri, data: Uint8Array) => {
        mockFileData = data;
      }),
      stat: vi.fn(),
      readDirectory: vi.fn(),
      createDirectory: vi.fn(),
      delete: vi.fn(),
      rename: vi.fn(),
      copy: vi.fn(),
      isWritableFileSystem: vi.fn(),
    } as unknown as vscode.FileSystem;

    queue = new DraftQueue({ storagePath, fs: mockFs });
  });

  describe("load", () => {
    it("starts with empty queue when file doesn't exist", async () => {
      await queue.load(serverIdentity);
      expect(queue.getAll()).toEqual([]);
    });

    it("loads operations from file", async () => {
      const saved: DraftOperation[] = [createOp({ id: "persisted" })];
      mockFileData = new TextEncoder().encode(JSON.stringify({
        version: 1,
        serverIdentity,
        operations: saved,
      }));

      await queue.load(serverIdentity);

      expect(queue.getAll()).toHaveLength(1);
      expect(queue.getAll()[0].id).toBe("persisted");
    });

    it("throws error when server changed and has drafts (without force)", async () => {
      mockFileData = new TextEncoder().encode(JSON.stringify({
        version: 1,
        serverIdentity: "different-server",
        operations: [createOp()],
      }));

      await expect(queue.load(serverIdentity)).rejects.toThrow("Server changed");
    });

    it("clears queue from different server when force=true", async () => {
      mockFileData = new TextEncoder().encode(JSON.stringify({
        version: 1,
        serverIdentity: "different-server",
        operations: [createOp()],
      }));

      await queue.load(serverIdentity, { force: true });

      expect(queue.getAll()).toHaveLength(0);
    });
  });

  describe("checkServerConflict", () => {
    it("returns null when no file exists", async () => {
      const result = await queue.checkServerConflict(serverIdentity);
      expect(result).toBeNull();
    });

    it("returns null when server matches", async () => {
      mockFileData = new TextEncoder().encode(JSON.stringify({
        version: 1,
        serverIdentity,
        operations: [createOp()],
      }));

      const result = await queue.checkServerConflict(serverIdentity);
      expect(result).toBeNull();
    });

    it("returns null when different server but no operations", async () => {
      mockFileData = new TextEncoder().encode(JSON.stringify({
        version: 1,
        serverIdentity: "different-server",
        operations: [],
      }));

      const result = await queue.checkServerConflict(serverIdentity);
      expect(result).toBeNull();
    });

    it("returns count when different server with operations", async () => {
      mockFileData = new TextEncoder().encode(JSON.stringify({
        version: 1,
        serverIdentity: "different-server",
        operations: [createOp(), createOp({ id: "op2" })],
      }));

      const result = await queue.checkServerConflict(serverIdentity);
      expect(result).toEqual({ count: 2 });
    });
  });

  describe("add", () => {
    it("throws error when queue not loaded", async () => {
      const op = createOp();
      await expect(queue.add(op)).rejects.toThrow("DraftQueue not loaded");
    });

    describe("when loaded", () => {
      beforeEach(async () => {
        await queue.load(serverIdentity);
      });

      it("adds operation to queue", async () => {
      const op = createOp();
      await queue.add(op);
      expect(queue.getAll()).toContain(op);
    });

    it("replaces operation with same resourceKey (conflict resolution)", async () => {
      const op1 = createOp({ id: "1", resourceKey: "issue:123:status", description: "First" });
      const op2 = createOp({ id: "2", resourceKey: "issue:123:status", description: "Second" });

      await queue.add(op1);
      await queue.add(op2);

      const all = queue.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].description).toBe("Second");
    });

    it("keeps operations with different resourceKeys", async () => {
      const op1 = createOp({ resourceKey: "issue:123:status" });
      const op2 = createOp({ resourceKey: "issue:123:dates" });

      await queue.add(op1);
      await queue.add(op2);

      expect(queue.getAll()).toHaveLength(2);
    });

    it("appends notes instead of replacing", async () => {
      const note1 = createOp({
        type: "addIssueNote",
        resourceKey: "issue:123:note:1",
        description: "Note 1"
      });
      const note2 = createOp({
        type: "addIssueNote",
        resourceKey: "issue:123:note:2",
        description: "Note 2"
      });

      await queue.add(note1);
      await queue.add(note2);

      expect(queue.getAll()).toHaveLength(2);
    });

    it("emits change event", async () => {
      const handler = vi.fn();
      queue.onDidChange(handler);

      await queue.add(createOp());

      expect(handler).toHaveBeenCalled();
    });

    it("persists to file after add", async () => {
      await queue.add(createOp());

      expect(mockFs.writeFile).toHaveBeenCalled();
    });
    });
  });

  describe("remove", () => {
    beforeEach(async () => {
      await queue.load(serverIdentity);
    });

    it("removes operation by id", async () => {
      const op = createOp({ id: "to-remove" });
      await queue.add(op);
      await queue.remove("to-remove");

      expect(queue.getAll()).toHaveLength(0);
    });

    it("does nothing for non-existent id", async () => {
      const op = createOp({ id: "exists" });
      await queue.add(op);
      await queue.remove("non-existent");

      expect(queue.getAll()).toHaveLength(1);
    });

    it("emits change event on removal", async () => {
      const op = createOp({ id: "to-remove" });
      await queue.add(op);

      const handler = vi.fn();
      queue.onDidChange(handler);
      await queue.remove("to-remove");

      expect(handler).toHaveBeenCalled();
    });
  });

  describe("getAll", () => {
    beforeEach(async () => {
      await queue.load(serverIdentity);
    });

    it("returns empty array initially", () => {
      expect(queue.getAll()).toEqual([]);
    });

    it("returns operations in order added", async () => {
      const op1 = createOp({ id: "1", resourceKey: "a" });
      const op2 = createOp({ id: "2", resourceKey: "b" });

      await queue.add(op1);
      await queue.add(op2);

      const all = queue.getAll();
      expect(all[0].id).toBe("1");
      expect(all[1].id).toBe("2");
    });
  });

  describe("clear", () => {
    beforeEach(async () => {
      await queue.load(serverIdentity);
    });

    it("removes all operations", async () => {
      await queue.add(createOp({ resourceKey: "a" }));
      await queue.add(createOp({ resourceKey: "b" }));

      await queue.clear();

      expect(queue.getAll()).toHaveLength(0);
    });

    it("emits change event", async () => {
      await queue.add(createOp());

      const handler = vi.fn();
      queue.onDidChange(handler);
      await queue.clear();

      expect(handler).toHaveBeenCalled();
    });
  });

  describe("count", () => {
    beforeEach(async () => {
      await queue.load(serverIdentity);
    });

    it("returns 0 for empty queue", () => {
      expect(queue.count).toBe(0);
    });

    it("returns correct count", async () => {
      await queue.add(createOp({ resourceKey: "a" }));
      await queue.add(createOp({ resourceKey: "b" }));

      expect(queue.count).toBe(2);
    });
  });

  describe("getByIssueId", () => {
    beforeEach(async () => {
      await queue.load(serverIdentity);
    });

    it("returns operations for given issue", async () => {
      await queue.add(createOp({ issueId: 123, resourceKey: "a" }));
      await queue.add(createOp({ issueId: 456, resourceKey: "b" }));
      await queue.add(createOp({ issueId: 123, resourceKey: "c" }));

      const ops = queue.getByIssueId(123);

      expect(ops).toHaveLength(2);
      expect(ops.every(o => o.issueId === 123)).toBe(true);
    });
  });

  describe("removeByKey", () => {
    beforeEach(async () => {
      await queue.load(serverIdentity);
    });

    it("removes operation matching resourceKey", async () => {
      await queue.add(createOp({ id: "1", resourceKey: "issue:123:status" }));
      await queue.add(createOp({ id: "2", resourceKey: "issue:123:dates" }));

      await queue.removeByKey("issue:123:status");

      expect(queue.getAll()).toHaveLength(1);
      expect(queue.getAll()[0].id).toBe("2");
    });

    it("does nothing for non-existent key", async () => {
      await queue.add(createOp({ resourceKey: "issue:123:status" }));
      await queue.removeByKey("non-existent");

      expect(queue.getAll()).toHaveLength(1);
    });

    it("emits change event on removal", async () => {
      await queue.add(createOp({ resourceKey: "issue:123:status" }));

      const handler = vi.fn();
      queue.onDidChange(handler);
      await queue.removeByKey("issue:123:status");

      expect(handler).toHaveBeenCalled();
    });
  });

  describe("removeByTempIdPrefix", () => {
    beforeEach(async () => {
      await queue.load(serverIdentity);
    });

    it("removes operations matching tempId prefix", async () => {
      await queue.add(createOp({ id: "1", resourceKey: "a", tempId: "draft-issue-abc" }));
      await queue.add(createOp({ id: "2", resourceKey: "b", tempId: "draft-version-xyz" }));
      await queue.add(createOp({ id: "3", resourceKey: "c", tempId: "draft-issue-def" }));

      await queue.removeByTempIdPrefix("draft-issue-");

      expect(queue.getAll()).toHaveLength(1);
      expect(queue.getAll()[0].tempId).toBe("draft-version-xyz");
    });

    it("does nothing when no match", async () => {
      await queue.add(createOp({ resourceKey: "a", tempId: "draft-version-xyz" }));
      await queue.removeByTempIdPrefix("draft-issue-");

      expect(queue.getAll()).toHaveLength(1);
    });

    it("handles operations without tempId", async () => {
      await queue.add(createOp({ resourceKey: "a" })); // no tempId
      await queue.removeByTempIdPrefix("draft-issue-");

      expect(queue.getAll()).toHaveLength(1);
    });
  });

  describe("getByKeyPrefix", () => {
    beforeEach(async () => {
      await queue.load(serverIdentity);
    });

    it("returns operations matching key prefix", async () => {
      await queue.add(createOp({ resourceKey: "issue:123:status" }));
      await queue.add(createOp({ resourceKey: "issue:123:dates" }));
      await queue.add(createOp({ resourceKey: "timeentry:456:update" }));

      const ops = queue.getByKeyPrefix("issue:123");

      expect(ops).toHaveLength(2);
      expect(ops.every(o => o.resourceKey.startsWith("issue:123"))).toBe(true);
    });

    it("returns empty array when no match", async () => {
      await queue.add(createOp({ resourceKey: "issue:123:status" }));

      const ops = queue.getByKeyPrefix("version:");

      expect(ops).toHaveLength(0);
    });
  });

  describe("dispose", () => {
    beforeEach(async () => {
      await queue.load(serverIdentity);
    });

    it("clears all change handlers", async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      queue.onDidChange(handler1);
      queue.onDidChange(handler2);

      queue.dispose();
      await queue.add(createOp());

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });
  });

  describe("load edge cases", () => {
    it("ignores file with version !== 1", async () => {
      mockFileData = new TextEncoder().encode(JSON.stringify({
        version: 2, // future version
        serverIdentity,
        operations: [createOp()],
      }));

      await queue.load(serverIdentity);

      expect(queue.getAll()).toHaveLength(0);
    });

    it("emits change event on successful load", async () => {
      mockFileData = new TextEncoder().encode(JSON.stringify({
        version: 1,
        serverIdentity,
        operations: [createOp()],
      }));

      const handler = vi.fn();
      queue.onDidChange(handler);
      await queue.load(serverIdentity);

      expect(handler).toHaveBeenCalled();
    });
  });

  describe("change handler error isolation", () => {
    beforeEach(async () => {
      await queue.load(serverIdentity);
    });

    it("continues calling handlers even if one throws", async () => {
      const handler1 = vi.fn().mockImplementation(() => { throw new Error("oops"); });
      const handler2 = vi.fn();

      queue.onDidChange(handler1);
      queue.onDidChange(handler2);
      await queue.add(createOp());

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });
  });
});
