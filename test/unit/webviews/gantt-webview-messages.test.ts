import { describe, expect, it } from "vitest";
import { parseLookbackYears } from "../../../src/webviews/gantt-webview-messages";

describe("parseLookbackYears", () => {
  it("returns fallback for undefined and invalid inputs", () => {
    expect(parseLookbackYears(undefined, 2)).toBe(2);
    expect(parseLookbackYears("invalid", 5)).toBe(5);
  });

  it("returns null for empty input", () => {
    expect(parseLookbackYears("", 10)).toBeNull();
  });

  it("parses valid lookback values", () => {
    expect(parseLookbackYears("2", null)).toBe(2);
    expect(parseLookbackYears("5", null)).toBe(5);
    expect(parseLookbackYears("10", null)).toBe(10);
  });
});
