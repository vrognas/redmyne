import { describe, expect, it } from "vitest";
import { parseLookbackDays, resolveLookbackDays } from "../../../src/webviews/gantt-webview-messages";

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

describe("resolveLookbackDays", () => {
  it("uses the stored days value when present", () => {
    expect(resolveLookbackDays(90, undefined, 730)).toBe(90);
    expect(resolveLookbackDays(null, 5, 730)).toBeNull();
  });

  it("migrates the old years value (x365) when days is absent", () => {
    expect(resolveLookbackDays(undefined, 5, 730)).toBe(1825);
    expect(resolveLookbackDays(undefined, null, 730)).toBeNull();
  });

  it("falls back to the default when neither is stored", () => {
    expect(resolveLookbackDays(undefined, undefined, 730)).toBe(730);
  });
});
