import { describe, it, expect } from "vitest";
import { calculateRemainingWork } from "../../../src/utilities/capacity-calculator";
import { remainingHours } from "../../../src/utilities/remaining-work";
import type { Issue } from "../../../src/redmine/models/issue";
import type { InternalEstimates } from "../../../src/utilities/internal-estimates";

const issue = (o: Partial<Issue> & { id: number }): Issue => o as unknown as Issue;
const estimates = (entries: Array<[number, number]> = []): InternalEstimates =>
  new Map(entries.map(([id, h]) => [id, { hoursRemaining: h, updatedAt: "2025-01-01T00:00:00Z" }]));

describe("calculateRemainingWork delegates to the single-owner heuristic", () => {
  it("no longer scales by done_ratio while budget is unconsumed (the drift fix)", () => {
    // done=50, spent=0, est=10: owner returns est-spent=10; the old copy returned 5.
    expect(calculateRemainingWork(issue({ id: 1, estimated_hours: 10, done_ratio: 50, spent_hours: 0 }), estimates())).toBe(10);
  });

  it("internal estimate wins outright (clamped at 0)", () => {
    expect(calculateRemainingWork(issue({ id: 1, estimated_hours: 10, done_ratio: 50, spent_hours: 3 }), estimates([[1, 4]]))).toBe(4);
    expect(calculateRemainingWork(issue({ id: 1, estimated_hours: 10 }), estimates([[1, -2]]))).toBe(0);
  });

  it("coalesces the unknown-estimate (null) case to 0", () => {
    expect(calculateRemainingWork(issue({ id: 1, estimated_hours: 0, spent_hours: 5 }), estimates())).toBe(0);
    expect(calculateRemainingWork(issue({ id: 1 }), estimates())).toBe(0);
  });

  it("stays in lockstep with remainingHours() across cases", () => {
    const cases: Array<Partial<Issue> & { id: number }> = [
      { id: 1, estimated_hours: 10, done_ratio: 50, spent_hours: 0 },
      { id: 2, estimated_hours: 10, done_ratio: 0, spent_hours: 4 },
      { id: 3, estimated_hours: 10, done_ratio: 40, spent_hours: 12 },
      { id: 4, estimated_hours: 10, done_ratio: 100, spent_hours: 0 },
    ];
    for (const c of cases) {
      const owner = remainingHours({ estimatedHours: c.estimated_hours, spentHours: c.spent_hours, doneRatio: c.done_ratio }) ?? 0;
      expect(calculateRemainingWork(issue(c), estimates())).toBe(owner);
    }
  });
});
