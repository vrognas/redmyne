import { describe, expect, it } from "vitest";
import { buildWeekInfo } from "../../../src/webviews/timesheet-webview-messages";

describe("timesheet webview message date helpers", () => {
  it("builds consistent week info for a Monday", () => {
    const monday = new Date(2026, 1, 2);
    const week = buildWeekInfo(monday);

    expect(week.weekNumber).toBe(6);
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
