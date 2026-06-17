import { describe, it, expect, beforeEach, vi } from "vitest";

let stored: number[] = [];
const onDidChangeConfigurationMock = vi.fn(() => ({ dispose: vi.fn() }));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, def?: unknown) => stored.length > 0 ? [...stored] : def),
      update: vi.fn(async (_key: string, value: number[]) => { stored = value; }),
    })),
    onDidChangeConfiguration: onDidChangeConfigurationMock,
  },
  ConfigurationTarget: { Global: 1 },
}));

describe("AdHocTracker", () => {
  let tracker: typeof import("../../../src/utilities/adhoc-tracker").adHocTracker;
  let initAdHocTracker: typeof import("../../../src/utilities/adhoc-tracker").initAdHocTracker;

  beforeEach(async () => {
    stored = [];
    vi.clearAllMocks();
    vi.resetModules();
    const module = await import("../../../src/utilities/adhoc-tracker");
    tracker = module.adHocTracker;
    initAdHocTracker = module.initAdHocTracker;
  });

  it("returns false for untagged issues", () => {
    expect(tracker.isAdHoc(1234)).toBe(false);
  });

  it("tag/untag/toggle via settings", async () => {
    await tracker.tag(1234);
    expect(tracker.isAdHoc(1234)).toBe(true);

    await tracker.tag(5678);
    expect(tracker.getAll()).toContain(1234);
    expect(tracker.getAll()).toContain(5678);

    await tracker.untag(1234);
    expect(tracker.isAdHoc(1234)).toBe(false);
    expect(stored).toEqual([5678]);

    expect(await tracker.toggle(5678)).toBe(false);
    expect(await tracker.toggle(5678)).toBe(true);
  });

  it("getAll returns empty when none tagged", () => {
    expect(tracker.getAll()).toEqual([]);
  });

  it("importing the module does NOT register onDidChangeConfiguration listener", async () => {
    // The mock is already fresh after vi.resetModules() + re-import in beforeEach.
    // onDidChangeConfigurationMock should not have been called at import time.
    expect(onDidChangeConfigurationMock).not.toHaveBeenCalled();
  });

  it("initAdHocTracker pushes exactly one Disposable into context.subscriptions", () => {
    const fakeContext = { subscriptions: [] as { dispose(): void }[] };
    initAdHocTracker(fakeContext as never);
    expect(fakeContext.subscriptions).toHaveLength(1);
    expect(typeof fakeContext.subscriptions[0].dispose).toBe("function");
    expect(onDidChangeConfigurationMock).toHaveBeenCalledTimes(1);
  });
});
