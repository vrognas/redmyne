import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as vscode from "vscode";

function createMockContext() {
  const stateStore: Record<string, unknown> = {};
  return {
    globalState: {
      get: <T>(key: string, defaultValue?: T) =>
        (stateStore[key] as T) ?? (defaultValue as T),
      update: vi.fn((key: string, value: unknown) => {
        stateStore[key] = value;
      }),
    },
    _stateStore: stateStore,
  } as unknown as vscode.ExtensionContext & {
    _stateStore: Record<string, unknown>;
  };
}

describe("recent-issues", () => {
  let initRecentIssues: (context: vscode.ExtensionContext) => void;
  let recordRecentIssue: (
    issueId: number,
    subject: string,
    projectName: string
  ) => void;
  let getRecentIssueIds: () => number[];
  let getRecentIssues: () => {
    id: number;
    subject: string;
    projectName: string;
    timestamp: number;
  }[];
  let clearRecentIssues: () => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const module = await import("../../../src/utilities/recent-issues");
    initRecentIssues = module.initRecentIssues;
    recordRecentIssue = module.recordRecentIssue;
    getRecentIssueIds = module.getRecentIssueIds;
    getRecentIssues = module.getRecentIssues;
    clearRecentIssues = module.clearRecentIssues;
  });

  describe("without initialization", () => {
    it("returns empty array from getRecentIssues", () => {
      expect(getRecentIssues()).toEqual([]);
    });

    it("returns empty array from getRecentIssueIds", () => {
      expect(getRecentIssueIds()).toEqual([]);
    });

    it("recordRecentIssue does nothing", () => {
      expect(() => recordRecentIssue(1, "Test", "Project")).not.toThrow();
    });

    it("clearRecentIssues does nothing", () => {
      expect(() => clearRecentIssues()).not.toThrow();
    });
  });

  describe("with initialization", () => {
    let context: vscode.ExtensionContext & {
      _stateStore: Record<string, unknown>;
    };

    beforeEach(() => {
      context = createMockContext();
      initRecentIssues(context);
    });

    it("records and retrieves recent issues", () => {
      recordRecentIssue(123, "Fix bug", "ProjectA");

      const issues = getRecentIssues();
      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe(123);
      expect(issues[0].subject).toBe("Fix bug");
      expect(issues[0].projectName).toBe("ProjectA");
      expect(issues[0].timestamp).toBeDefined();
    });

    it("returns issue IDs in order", () => {
      recordRecentIssue(1, "First", "P1");
      recordRecentIssue(2, "Second", "P2");
      recordRecentIssue(3, "Third", "P3");

      const ids = getRecentIssueIds();
      expect(ids).toEqual([3, 2, 1]); // Most recent first
    });

    it("moves existing issue to front when re-recorded", () => {
      recordRecentIssue(1, "First", "P1");
      recordRecentIssue(2, "Second", "P2");
      recordRecentIssue(1, "First Updated", "P1");

      const ids = getRecentIssueIds();
      expect(ids).toEqual([1, 2]);

      const issues = getRecentIssues();
      expect(issues[0].subject).toBe("First Updated");
    });

    it("limits to MAX_RECENT_ISSUES (20)", () => {
      for (let i = 1; i <= 25; i++) {
        recordRecentIssue(i, `Issue ${i}`, `Project`);
      }

      const issues = getRecentIssues();
      expect(issues).toHaveLength(20);
      expect(issues[0].id).toBe(25); // Most recent
      expect(issues[19].id).toBe(6); // Oldest kept
    });

    it("clears all recent issues", () => {
      recordRecentIssue(1, "Issue 1", "P1");
      recordRecentIssue(2, "Issue 2", "P2");

      clearRecentIssues();

      expect(getRecentIssues()).toEqual([]);
      expect(getRecentIssueIds()).toEqual([]);
    });

    it("persists to globalState", () => {
      recordRecentIssue(42, "Persisted Issue", "TestProject");

      expect(context.globalState.update).toHaveBeenCalledWith(
        "recentIssues",
        expect.arrayContaining([
          expect.objectContaining({
            id: 42,
            subject: "Persisted Issue",
            projectName: "TestProject",
          }),
        ])
      );
    });
  });
});
