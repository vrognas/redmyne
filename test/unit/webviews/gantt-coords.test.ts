import { describe, expect, it } from "vitest";
import {
  dateToX,
  endExclusiveX,
  barXRange,
  clampMinDateToLookback,
  addUtcDays,
} from "../../../src/webviews/gantt/gantt-coords";

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

describe("barXRange", () => {
  const minMs = new Date("2026-01-01T00:00:00Z").getTime();
  const maxMs = new Date("2026-01-11T00:00:00Z").getTime(); // 10-day range
  const width = 1000;

  it("resolves a normal start/due pair to dateToX + endExclusiveX", () => {
    const r = barXRange("2026-01-03", "2026-01-06", minMs, maxMs, width)!;
    expect(r.startX).toBe(dateToX(new Date("2026-01-03").getTime(), minMs, maxMs, width));
    expect(r.endX).toBe(endExclusiveX(new Date("2026-01-06"), minMs, maxMs, width));
    expect(r.endX).toBeGreaterThan(r.startX);
  });

  it("extends an open-ended bar (start, no due) to openEndedMax, else 1 day", () => {
    const maxStr = "2026-01-11";
    const open = barXRange("2026-01-03", null, minMs, maxMs, width, maxStr)!;
    // Matches a bar that closes exactly at maxDate.
    expect(open.endX).toBe(barXRange("2026-01-03", maxStr, minMs, maxMs, width)!.endX);
    // Without openEndedMax the due falls back to the start (single-day strip).
    const oneDay = barXRange("2026-01-03", null, minMs, maxMs, width)!;
    expect(oneDay.endX).toBe(endExclusiveX(new Date("2026-01-03"), minMs, maxMs, width));
    // both dates absent → null (caller emits an empty group)
    expect(barXRange(null, null, minMs, maxMs, width)).toBeNull();
  });
});

describe("addUtcDays", () => {
  it("shifts a date forward/backward by whole UTC days without mutating", () => {
    const base = new Date("2026-06-11T00:00:00Z");
    expect(addUtcDays(base, 28).toISOString().slice(0, 10)).toBe("2026-07-09");
    expect(addUtcDays(base, -28).toISOString().slice(0, 10)).toBe("2026-05-14");
    expect(base.toISOString().slice(0, 10)).toBe("2026-06-11");
  });
});

describe("clampMinDateToLookback", () => {
  const todayUTC = new Date("2026-06-11T00:00:00Z");
  const maxDate = new Date("2026-12-01T00:00:00Z");

  it("clamps an ancient minDate to today minus the lookback (730 days = 2 years)", () => {
    const ancient = new Date("2016-03-01T00:00:00Z");
    const clamped = clampMinDateToLookback(ancient, maxDate, todayUTC, 730);
    expect(clamped.toISOString().slice(0, 10)).toBe("2024-06-11");
  });

  it("clamps to a short horizon (28 days = 4 weeks)", () => {
    const ancient = new Date("2016-03-01T00:00:00Z");
    const clamped = clampMinDateToLookback(ancient, maxDate, todayUTC, 28);
    expect(clamped.toISOString().slice(0, 10)).toBe("2026-05-14");
  });

  it("leaves minDate alone when within the horizon or unlimited", () => {
    const recent = new Date("2026-01-01T00:00:00Z");
    expect(clampMinDateToLookback(recent, maxDate, todayUTC, 730)).toBe(recent);

    const ancient = new Date("2016-03-01T00:00:00Z");
    expect(clampMinDateToLookback(ancient, maxDate, todayUTC, null)).toBe(ancient);
  });

  it("never inverts the range when the whole board predates the horizon", () => {
    const oldMin = new Date("2015-01-01T00:00:00Z");
    const oldMax = new Date("2016-01-01T00:00:00Z");
    expect(clampMinDateToLookback(oldMin, oldMax, todayUTC, 730)).toBe(oldMin);
  });
});
