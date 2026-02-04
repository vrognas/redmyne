import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as vscode from "vscode";

function createMockGlobalState() {
  const store: Record<string, unknown> = {};
  return {
    get: <T>(key: string, defaultValue?: T) =>
      (store[key] as T) ?? (defaultValue as T),
    update: vi.fn(async (key: string, value: unknown) => {
      store[key] = value;
    }),
    _store: store,
  } as vscode.Memento & { _store: Record<string, unknown> };
}

describe("precedence-tracker", () => {
  let getPrecedenceIssues: (globalState: vscode.Memento) => Set<number>;
  let hasPrecedence: (globalState: vscode.Memento, issueId: number) => boolean;
  let setPrecedence: (globalState: vscode.Memento, issueId: number) => Promise<void>;
  let clearPrecedence: (globalState: vscode.Memento, issueId: number) => Promise<void>;
  let togglePrecedence: (globalState: vscode.Memento, issueId: number) => Promise<boolean>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const module = await import("../../../src/utilities/precedence-tracker");
    getPrecedenceIssues = module.getPrecedenceIssues;
    hasPrecedence = module.hasPrecedence;
    setPrecedence = module.setPrecedence;
    clearPrecedence = module.clearPrecedence;
    togglePrecedence = module.togglePrecedence;
  });

  describe("getPrecedenceIssues", () => {
    it("returns empty set when no precedence issues stored", () => {
      const state = createMockGlobalState();
      const result = getPrecedenceIssues(state);
      expect(result).toEqual(new Set());
    });

    it("returns stored precedence issues as Set", () => {
      const state = createMockGlobalState();
      state._store["redmyne.precedenceIssues"] = [1, 2, 3];

      const result = getPrecedenceIssues(state);
      expect(result).toEqual(new Set([1, 2, 3]));
    });
  });

  describe("hasPrecedence", () => {
    it("returns false for issue without precedence", () => {
      const state = createMockGlobalState();
      expect(hasPrecedence(state, 123)).toBe(false);
    });

    it("returns true for issue with precedence", () => {
      const state = createMockGlobalState();
      state._store["redmyne.precedenceIssues"] = [123, 456];

      expect(hasPrecedence(state, 123)).toBe(true);
      expect(hasPrecedence(state, 456)).toBe(true);
      expect(hasPrecedence(state, 789)).toBe(false);
    });
  });

  describe("setPrecedence", () => {
    it("adds issue to precedence list", async () => {
      const state = createMockGlobalState();

      await setPrecedence(state, 123);

      expect(state.update).toHaveBeenCalledWith(
        "redmyne.precedenceIssues",
        [123]
      );
    });

    it("preserves existing precedence issues", async () => {
      const state = createMockGlobalState();
      state._store["redmyne.precedenceIssues"] = [100, 200];

      await setPrecedence(state, 300);

      expect(state.update).toHaveBeenCalledWith(
        "redmyne.precedenceIssues",
        expect.arrayContaining([100, 200, 300])
      );
    });

    it("does not duplicate existing issue", async () => {
      const state = createMockGlobalState();
      state._store["redmyne.precedenceIssues"] = [123];

      await setPrecedence(state, 123);

      const updateCall = (state.update as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(updateCall[1]).toHaveLength(1);
    });
  });

  describe("clearPrecedence", () => {
    it("removes issue from precedence list", async () => {
      const state = createMockGlobalState();
      state._store["redmyne.precedenceIssues"] = [123, 456, 789];

      await clearPrecedence(state, 456);

      expect(state.update).toHaveBeenCalledWith(
        "redmyne.precedenceIssues",
        expect.arrayContaining([123, 789])
      );
      const updateCall = (state.update as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(updateCall[1]).not.toContain(456);
    });

    it("handles non-existent issue gracefully", async () => {
      const state = createMockGlobalState();
      state._store["redmyne.precedenceIssues"] = [123];

      await clearPrecedence(state, 999);

      expect(state.update).toHaveBeenCalledWith(
        "redmyne.precedenceIssues",
        [123]
      );
    });
  });

  describe("togglePrecedence", () => {
    it("sets precedence and returns true when issue has no precedence", async () => {
      const state = createMockGlobalState();

      const result = await togglePrecedence(state, 123);

      expect(result).toBe(true);
      expect(state.update).toHaveBeenCalledWith(
        "redmyne.precedenceIssues",
        [123]
      );
    });

    it("clears precedence and returns false when issue has precedence", async () => {
      const state = createMockGlobalState();
      state._store["redmyne.precedenceIssues"] = [123];

      const result = await togglePrecedence(state, 123);

      expect(result).toBe(false);
      expect(state.update).toHaveBeenCalledWith(
        "redmyne.precedenceIssues",
        []
      );
    });
  });
});
