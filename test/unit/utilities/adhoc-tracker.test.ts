import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock vscode module
vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(),
    })),
  },
}));

// Create mock context
function createMockContext() {
  const storage = new Map<string, unknown>();
  return {
    globalState: {
      get: vi.fn((key: string, defaultValue?: unknown) => storage.get(key) ?? defaultValue),
      update: vi.fn((key: string, value: unknown) => {
        storage.set(key, value);
        return Promise.resolve();
      }),
    },
  };
}

describe("AdHocTracker", () => {
  let tracker: typeof import("../../../src/utilities/adhoc-tracker").adHocTracker;
  let mockContext: ReturnType<typeof createMockContext>;

  beforeEach(async () => {
    vi.resetModules();
    mockContext = createMockContext();
    const module = await import("../../../src/utilities/adhoc-tracker");
    tracker = module.adHocTracker;
    tracker.initialize(mockContext as any);
  });

  describe("isAdHoc", () => {
    it("returns false for untagged issues", () => {
      expect(tracker.isAdHoc(1234)).toBe(false);
    });

    it("returns true for tagged issues", () => {
      tracker.tag(1234);
      expect(tracker.isAdHoc(1234)).toBe(true);
    });
  });

  describe("tag", () => {
    it("adds issue to ad-hoc set", () => {
      tracker.tag(1234);
      expect(tracker.isAdHoc(1234)).toBe(true);
    });

    it("persists to storage", () => {
      tracker.tag(1234);
      expect(mockContext.globalState.update).toHaveBeenCalledWith(
        "redmine.adHocIssues",
        [1234]
      );
    });

    it("handles multiple issues", () => {
      tracker.tag(1234);
      tracker.tag(5678);
      expect(tracker.isAdHoc(1234)).toBe(true);
      expect(tracker.isAdHoc(5678)).toBe(true);
    });
  });

  describe("untag", () => {
    it("removes issue from ad-hoc set", () => {
      tracker.tag(1234);
      tracker.untag(1234);
      expect(tracker.isAdHoc(1234)).toBe(false);
    });

    it("persists removal to storage", () => {
      tracker.tag(1234);
      tracker.untag(1234);
      expect(mockContext.globalState.update).toHaveBeenLastCalledWith(
        "redmine.adHocIssues",
        []
      );
    });
  });

  describe("toggle", () => {
    it("tags untagged issue and returns true", () => {
      const result = tracker.toggle(1234);
      expect(result).toBe(true);
      expect(tracker.isAdHoc(1234)).toBe(true);
    });

    it("untags tagged issue and returns false", () => {
      tracker.tag(1234);
      const result = tracker.toggle(1234);
      expect(result).toBe(false);
      expect(tracker.isAdHoc(1234)).toBe(false);
    });
  });

  describe("getAll", () => {
    it("returns empty array when no issues tagged", () => {
      expect(tracker.getAll()).toEqual([]);
    });

    it("returns all tagged issue IDs", () => {
      tracker.tag(1234);
      tracker.tag(5678);
      expect(tracker.getAll()).toContain(1234);
      expect(tracker.getAll()).toContain(5678);
      expect(tracker.getAll().length).toBe(2);
    });
  });

  describe("initialization", () => {
    it("loads existing tags from storage", async () => {
      // Pre-populate storage
      mockContext.globalState.get = vi.fn(() => [1234, 5678]);

      vi.resetModules();
      const module = await import("../../../src/utilities/adhoc-tracker");
      module.adHocTracker.initialize(mockContext as any);

      expect(module.adHocTracker.isAdHoc(1234)).toBe(true);
      expect(module.adHocTracker.isAdHoc(5678)).toBe(true);
    });
  });
});
