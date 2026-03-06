import { describe, expect, it } from "vitest";
import {
  buildWeekInfo,
  formatDate,
  getISOWeekNumber,
  getWeekStart,
} from "../../../src/webviews/timesheet-webview-messages";

describe("timesheet webview message date helpers", () => {
  it("formats dates as yyyy-mm-dd", () => {
    expect(formatDate(new Date(2026, 0, 7))).toBe("2026-01-07");
  });

  it("returns monday for regular and sunday inputs", () => {
    const wednesday = new Date(2026, 1, 4);
    expect(formatDate(getWeekStart(wednesday))).toBe("2026-02-02");

    const sunday = new Date(2026, 1, 8);
    expect(formatDate(getWeekStart(sunday))).toBe("2026-02-02");
  });

  it("builds consistent week info and iso week number", () => {
    const monday = new Date(2026, 1, 2);
    const week = buildWeekInfo(monday);

    expect(week.weekNumber).toBe(getISOWeekNumber(monday));
    expect(week.year).toBe(2026);
    expect(week.startDate).toBe("2026-02-02");
    expect(week.endDate).toBe("2026-02-08");
    expect(week.dayDates).toEqual([
      "2026-02-02",
      "2026-02-03",
      "2026-02-04",
      "2026-02-05",
      "2026-02-06",
      "2026-02-07",
      "2026-02-08",
    ]);
  });
});
