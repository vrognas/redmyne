import { describe, it, expect } from "vitest";
import { computeHeaderDimRects } from "../../../../src/webviews/gantt/header-dim";

// dateToX is linear: dateToX(ms, 0, 100, 1000) === ms * 10
describe("computeHeaderDimRects", () => {
  it("dims past (left of period start) and future (right of last task)", () => {
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
});
