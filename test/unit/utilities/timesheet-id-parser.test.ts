import { describe, expect, it } from "vitest";
import {
  isValidTimesheetDayIndex,
  parseAggregatedRowKey,
  parseAggregatedTempId,
  parseRowDayTempId,
} from "../../../src/utilities/timesheet-id-parser";

describe("parseAggregatedRowKey", () => {
  it("parses issue/activity/comments from aggregated row id", () => {
    expect(parseAggregatedRowKey("agg-123::9::dev-work")).toEqual({
      issueId: 123,
      activityId: 9,
      comments: "dev-work",
    });
  });

  it("handles null ids and empty comments", () => {
    expect(parseAggregatedRowKey("agg-null::null::")).toEqual({
      issueId: null,
      activityId: null,
      comments: null,
    });
  });

  it("returns null for non-aggregated ids", () => {
    expect(parseAggregatedRowKey("existing-123")).toBeNull();
  });
});

describe("parseAggregatedTempId", () => {
  it("parses aggregated tempId and extracts dayIndex from the last colon", () => {
    expect(parseAggregatedTempId("agg-123::9::note:with:colon:6")).toEqual({
      issueId: 123,
      activityId: 9,
      comments: "note:with:colon",
      dayIndex: 6,
    });
  });

  it("returns a non-valid day index when suffix is not numeric", () => {
    const parsed = parseAggregatedTempId("agg-123::9::note:new");
    expect(parsed).not.toBeNull();
    expect(parsed?.issueId).toBe(123);
    expect(parsed?.activityId).toBe(9);
    expect(parsed?.comments).toBe("note");
    expect(Number.isNaN(parsed?.dayIndex)).toBe(true);
  });
});

describe("parseRowDayTempId", () => {
  it("parses rowId and dayIndex", () => {
    expect(parseRowDayTempId("draft-timeentry-abc:4")).toEqual({
      rowId: "draft-timeentry-abc",
      dayIndex: 4,
    });
  });

  it("parses using the last colon", () => {
    expect(parseRowDayTempId("row:with:colon:5")).toEqual({
      rowId: "row:with:colon",
      dayIndex: 5,
    });
  });

  it("returns null when format is invalid", () => {
    expect(parseRowDayTempId("no-day-index")).toBeNull();
  });
});

describe("isValidTimesheetDayIndex", () => {
  it("validates index range", () => {
    expect(isValidTimesheetDayIndex(0)).toBe(true);
    expect(isValidTimesheetDayIndex(6)).toBe(true);
    expect(isValidTimesheetDayIndex(-1)).toBe(false);
    expect(isValidTimesheetDayIndex(7)).toBe(false);
    expect(isValidTimesheetDayIndex(Number.NaN)).toBe(false);
  });
});
