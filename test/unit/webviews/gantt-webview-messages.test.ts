import { describe, it, expect } from "vitest";
import { parseLookbackYears } from "../../../src/webviews/gantt-webview-messages";

describe("parseLookbackYears", () => {
  it("returns fallback for undefined input", () => {
    expect(parseLookbackYears(undefined, 2)).toBe(2);
  });

  it("returns null for empty input", () => {
    expect(parseLookbackYears("", 2)).toBeNull();
  });

  it("returns allowed numeric values", () => {
    expect(parseLookbackYears("2", 5)).toBe(2);
    expect(parseLookbackYears("5", 2)).toBe(5);
    expect(parseLookbackYears("10", 2)).toBe(10);
  });

  it("returns fallback for invalid input", () => {
    expect(parseLookbackYears("7", 5)).toBe(5);
  });
});
