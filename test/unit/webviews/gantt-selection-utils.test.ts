import { describe, it, expect } from "vitest";
import { parseTranslateY } from "../../../src/webviews/gantt/selection-utils.js";

describe("gantt selection utilities", () => {
  it("parseTranslateY extracts y from transform, falls back when absent", () => {
    expect(parseTranslateY("translate(5, 42.5)", 0)).toBe(42.5);
    expect(parseTranslateY("translate(0, -8)", 0)).toBe(-8);
    expect(parseTranslateY("", 17)).toBe(17);
    expect(parseTranslateY(undefined, 17)).toBe(17);
  });
});
