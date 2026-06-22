import { describe, expect, it } from "vitest";
import { parseLookbackDays } from "../../../src/webviews/gantt-webview-messages";

describe("parseLookbackDays", () => {
  it("returns fallback for undefined and invalid inputs", () => {
    expect(parseLookbackDays(undefined, 730)).toBe(730);
    expect(parseLookbackDays("invalid", 1825)).toBe(1825);
  });

  it("returns null for empty input (All Time)", () => {
    expect(parseLookbackDays("", 3650)).toBeNull();
  });

  it("parses month/year lookback values (in days)", () => {
    expect(parseLookbackDays("90", null)).toBe(90);
    expect(parseLookbackDays("730", null)).toBe(730);
    expect(parseLookbackDays("3650", null)).toBe(3650);
  });

  it("parses short week-level lookback values", () => {
    expect(parseLookbackDays("14", null)).toBe(14);
    expect(parseLookbackDays("28", null)).toBe(28);
  });
});
