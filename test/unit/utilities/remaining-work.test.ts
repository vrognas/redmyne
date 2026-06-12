import { describe, it, expect } from "vitest";
import { remainingHours } from "../../../src/utilities/remaining-work";

describe("remainingHours", () => {
  it("internal estimate wins outright, clamped at zero", () => {
    expect(remainingHours({ estimatedHours: 16, spentHours: 2, doneRatio: 0, internalHoursRemaining: 4 })).toBe(4);
    expect(remainingHours({ estimatedHours: 16, spentHours: 2, doneRatio: 0, internalHoursRemaining: -3 })).toBe(0);
    expect(remainingHours({ estimatedHours: null, spentHours: 0, doneRatio: 0, internalHoursRemaining: 6 })).toBe(6);
  });

  it("budget heuristic: consumed + unmaintained done_ratio counts as done", () => {
    expect(remainingHours({ estimatedHours: 16, spentHours: 18, doneRatio: 0 })).toBe(0);
    expect(remainingHours({ estimatedHours: 16, spentHours: 18, doneRatio: 50 })).toBe(8);
    expect(remainingHours({ estimatedHours: 16, spentHours: 5, doneRatio: 30 })).toBe(11);
    expect(remainingHours({ estimatedHours: 16, spentHours: 5, doneRatio: 100 })).toBe(0);
  });

  it("no estimate of any kind is unknowable (null)", () => {
    expect(remainingHours({ estimatedHours: null, spentHours: 9, doneRatio: 0 })).toBeNull();
    expect(remainingHours({ estimatedHours: 0, spentHours: 0, doneRatio: 50 })).toBeNull();
  });
});
