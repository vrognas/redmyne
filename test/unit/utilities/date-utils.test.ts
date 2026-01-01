import { describe, it, expect } from "vitest";
import { parseLocalDate, getLocalToday, formatLocalDate } from "../../../src/utilities/date-utils";

describe("parseLocalDate", () => {
  it("parses YYYY-MM-DD as local date", () => {
    const date = parseLocalDate("2025-01-15");
    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(0); // January = 0
    expect(date.getDate()).toBe(15);
    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(0);
  });

  it("returns same local date regardless of timezone", () => {
    // This test verifies the date is interpreted as local, not UTC
    // The local date should always be 2025-01-15, not shifted by timezone
    const date = parseLocalDate("2025-01-15");
    const formatted = formatLocalDate(date);
    expect(formatted).toBe("2025-01-15");
  });

  it("handles edge case dates", () => {
    // First day of month
    const jan1 = parseLocalDate("2025-01-01");
    expect(jan1.getDate()).toBe(1);
    expect(jan1.getMonth()).toBe(0);

    // Last day of month
    const jan31 = parseLocalDate("2025-01-31");
    expect(jan31.getDate()).toBe(31);

    // Year boundary
    const dec31 = parseLocalDate("2024-12-31");
    expect(dec31.getFullYear()).toBe(2024);
    expect(dec31.getMonth()).toBe(11);
    expect(dec31.getDate()).toBe(31);
  });
});

describe("getLocalToday", () => {
  it("returns today at midnight", () => {
    const today = getLocalToday();
    const now = new Date();

    expect(today.getFullYear()).toBe(now.getFullYear());
    expect(today.getMonth()).toBe(now.getMonth());
    expect(today.getDate()).toBe(now.getDate());
    expect(today.getHours()).toBe(0);
    expect(today.getMinutes()).toBe(0);
    expect(today.getSeconds()).toBe(0);
    expect(today.getMilliseconds()).toBe(0);
  });
});

describe("formatLocalDate", () => {
  it("formats date as YYYY-MM-DD", () => {
    const date = new Date(2025, 0, 15); // Jan 15, 2025
    expect(formatLocalDate(date)).toBe("2025-01-15");
  });

  it("pads single-digit months and days", () => {
    const date = new Date(2025, 0, 5); // Jan 5, 2025
    expect(formatLocalDate(date)).toBe("2025-01-05");
  });

  it("round-trips with parseLocalDate", () => {
    const original = "2025-06-15";
    const parsed = parseLocalDate(original);
    const formatted = formatLocalDate(parsed);
    expect(formatted).toBe(original);
  });
});
