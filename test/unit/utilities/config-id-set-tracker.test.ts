import { describe, it, expect, beforeEach, vi } from "vitest";

let stored: number[] = [];

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, def?: unknown) => stored.length > 0 ? [...stored] : def),
      update: vi.fn(async (_key: string, value: number[]) => { stored = value; }),
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  },
  ConfigurationTarget: { Global: 1 },
}));

describe("createConfigIdSetTracker", () => {
  let create: typeof import("../../../src/utilities/config-id-set-tracker").createConfigIdSetTracker;

  beforeEach(async () => {
    stored = [];
    vi.clearAllMocks();
    vi.resetModules();
    create = (await import("../../../src/utilities/config-id-set-tracker")).createConfigIdSetTracker;
  });

  it("add/remove/has/getAll round-trip against config", async () => {
    const t = create("someKey");
    expect(t.has(1)).toBe(false);
    expect(t.getAllArray()).toEqual([]);

    await t.add(1);
    await t.add(2);
    expect(t.has(1)).toBe(true);
    expect(t.getAllSet()).toEqual(new Set([1, 2]));

    await t.add(1); // duplicate guard
    expect(stored).toEqual([1, 2]);

    await t.remove(1);
    expect(t.has(1)).toBe(false);
    expect(stored).toEqual([2]);
  });

  it("toggle flips membership and reports new state", async () => {
    const t = create("someKey");
    expect(await t.toggle(7)).toBe(true);
    expect(t.has(7)).toBe(true);
    expect(await t.toggle(7)).toBe(false);
    expect(t.has(7)).toBe(false);
  });

  it("lazyCache re-reads after onDidChangeConfiguration invalidation", async () => {
    const t = create("someKey", { lazyCache: true });
    expect(t.has(9)).toBe(false); // primes cache
    t.registerCacheListener!(); // register invalidation listener

    const onChange = vi.mocked(
      (await import("vscode")).workspace.onDidChangeConfiguration,
    ).mock.calls[0][0];

    stored = [9]; // external change bypassing setIds
    expect(t.has(9)).toBe(false); // still cached
    onChange({ affectsConfiguration: () => true } as never); // invalidate
    expect(t.has(9)).toBe(true);
  });
});
