import { describe, expect, it } from "vitest";
import { dateToX, endExclusiveX } from "../../../src/webviews/gantt/gantt-coords";

describe("dateToX", () => {
  const minMs = new Date("2026-01-01T00:00:00Z").getTime();
  const maxMs = new Date("2026-01-11T00:00:00Z").getTime(); // 10-day range
  const width = 1000;

  it("maps minDate → 0 and maxDate → width", () => {
    expect(dateToX(minMs, minMs, maxMs, width)).toBe(0);
    expect(dateToX(maxMs, minMs, maxMs, width)).toBe(width);
  });

  it("maps midpoint linearly", () => {
    const midMs = new Date("2026-01-06T00:00:00Z").getTime(); // day 5 of 10
    expect(dateToX(midMs, minMs, maxMs, width)).toBe(500);
  });

  it("returns 0 when min === max (degenerate range)", () => {
    expect(dateToX(minMs, minMs, minMs, width)).toBe(0);
  });
});

describe("endExclusiveX", () => {
  const minMs = new Date("2026-01-01T00:00:00Z").getTime();
  const maxMs = new Date("2026-01-11T00:00:00Z").getTime();
  const width = 1000;

  it("adds exactly 1 UTC day vs dateToX of same date", () => {
    const end = new Date("2026-01-06T00:00:00Z");
    const xWithout = dateToX(end.getTime(), minMs, maxMs, width);
    const xWith = endExclusiveX(end, minMs, maxMs, width);
    const oneDayMs = 24 * 60 * 60 * 1000;
    const oneDayPx = (oneDayMs / (maxMs - minMs)) * width;
    expect(xWith - xWithout).toBeCloseTo(oneDayPx, 10);
  });

  it("does not mutate the input date", () => {
    const end = new Date("2026-01-06T00:00:00Z");
    const original = end.getTime();
    endExclusiveX(end, minMs, maxMs, width);
    expect(end.getTime()).toBe(original);
  });
});
