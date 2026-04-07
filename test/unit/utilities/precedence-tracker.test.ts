import { describe, it, expect, beforeEach, vi } from "vitest";

let stored: number[] = [];

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, def?: unknown) => stored.length > 0 ? [...stored] : def),
      update: vi.fn(async (_key: string, value: number[]) => { stored = value; }),
    })),
  },
  ConfigurationTarget: { Global: 1 },
}));

describe("precedence-tracker", () => {
  let getPrecedenceIssues: () => Set<number>;
  let hasPrecedence: (issueId: number) => boolean;
  let setPrecedence: (issueId: number) => Promise<void>;
  let clearPrecedence: (issueId: number) => Promise<void>;
  let togglePrecedence: (issueId: number) => Promise<boolean>;

  beforeEach(async () => {
    stored = [];
    vi.clearAllMocks();
    vi.resetModules();
    const module = await import("../../../src/utilities/precedence-tracker");
    getPrecedenceIssues = module.getPrecedenceIssues;
    hasPrecedence = module.hasPrecedence;
    setPrecedence = module.setPrecedence;
    clearPrecedence = module.clearPrecedence;
    togglePrecedence = module.togglePrecedence;
  });

  it("returns empty set when none stored", () => {
    expect(getPrecedenceIssues()).toEqual(new Set());
    expect(hasPrecedence(123)).toBe(false);
  });

  it("set/clear/toggle via settings", async () => {
    await setPrecedence(123);
    expect(hasPrecedence(123)).toBe(true);

    await setPrecedence(456);
    expect(getPrecedenceIssues()).toEqual(new Set([123, 456]));

    await clearPrecedence(123);
    expect(hasPrecedence(123)).toBe(false);
    expect(stored).toEqual([456]);

    expect(await togglePrecedence(456)).toBe(false);
    expect(await togglePrecedence(456)).toBe(true);
  });
});
