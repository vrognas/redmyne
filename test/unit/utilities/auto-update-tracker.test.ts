import { describe, expect, it, vi } from "vitest";
import { autoUpdateTracker } from "../../../src/utilities/auto-update-tracker";

describe("auto-update-tracker", () => {
  it("returns false when not initialized and no-ops enable/disable", () => {
    expect(autoUpdateTracker.isEnabled(10)).toBe(false);
    expect(() => autoUpdateTracker.enable(10)).not.toThrow();
    expect(() => autoUpdateTracker.disable(10)).not.toThrow();
  });

  it("persists enable/disable/toggle to global state after initialize", () => {
    let stored: number[] = [];
    const context = {
      globalState: {
        get: vi.fn(() => stored),
        update: vi.fn((_key: string, value: number[]) => {
          stored = value;
        }),
      },
    };

    autoUpdateTracker.initialize(context as never);
    autoUpdateTracker.enable(1);
    autoUpdateTracker.enable(2);
    expect(autoUpdateTracker.isEnabled(1)).toBe(true);
    expect(autoUpdateTracker.isEnabled(2)).toBe(true);

    autoUpdateTracker.disable(1);
    expect(autoUpdateTracker.isEnabled(1)).toBe(false);
    expect(stored).toEqual([2]);

    expect(autoUpdateTracker.toggle(2)).toBe(false);
    expect(autoUpdateTracker.toggle(2)).toBe(true);
  });
});
