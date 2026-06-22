import { describe, it, expect } from "vitest";
import {
  computeHeaderDimRects,
  computeFutureDimStartMs,
} from "../../../../src/webviews/gantt/header-dim";

// dateToX is linear: dateToX(ms, 0, 100, 1000) === ms * 10
describe("computeHeaderDimRects", () => {
  it("dims past (left of period start) and future (right of window end)", () => {
    const { past, future } = computeHeaderDimRects(50, 80, 0, 100, 1000);
    expect(past).toEqual({ x: 0, width: 500 });
    expect(future).toEqual({ x: 800, width: 200 });
  });

  it("omits the past rect when the current period starts at/before the axis", () => {
    const { past } = computeHeaderDimRects(0, 80, 0, 100, 1000);
    expect(past).toBeNull();
  });

  it("omits the future rect when there are no dated tasks (windowEnd null)", () => {
    const { past, future } = computeHeaderDimRects(50, null, 0, 100, 1000);
    expect(past).toEqual({ x: 0, width: 500 });
    expect(future).toBeNull();
  });

  it("emits no dim for a degenerate axis (max <= min)", () => {
    expect(computeHeaderDimRects(50, 80, 100, 100, 1000)).toEqual({ past: null, future: null });
  });
});

describe("computeFutureDimStartMs", () => {
  const DAY = 86400000;

  it("starts the day after the last task when it's beyond today's period", () => {
    // periodStart=0, periodDays=10 (period ends day 10); last task day 20
    expect(computeFutureDimStartMs(20 * DAY, 0, 10)).toBe(21 * DAY);
  });

  it("falls back to today's period end when the last task is earlier (keep today bright)", () => {
    // last task day 5, period ends day 10 -> period end wins
    expect(computeFutureDimStartMs(5 * DAY, 0, 10)).toBe(10 * DAY);
  });

  it("returns null when there are no dated tasks", () => {
    expect(computeFutureDimStartMs(null, 0, 10)).toBeNull();
  });
});
