import { describe, expect, it, vi, beforeEach } from "vitest";

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

describe("auto-update-tracker", () => {
  let tracker: typeof import("../../../src/utilities/auto-update-tracker").autoUpdateTracker;

  beforeEach(async () => {
    stored = [];
    vi.clearAllMocks();
    vi.resetModules();
    const module = await import("../../../src/utilities/auto-update-tracker");
    tracker = module.autoUpdateTracker;
  });

  it("reads and writes via settings", async () => {
    expect(tracker.isEnabled(1)).toBe(false);

    await tracker.enable(1);
    await tracker.enable(2);
    expect(tracker.isEnabled(1)).toBe(true);
    expect(tracker.isEnabled(2)).toBe(true);

    await tracker.disable(1);
    expect(tracker.isEnabled(1)).toBe(false);
    expect(stored).toEqual([2]);

    expect(await tracker.toggle(2)).toBe(false);
    expect(await tracker.toggle(2)).toBe(true);
  });
});
