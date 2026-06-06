import { describe, it, expect } from "vitest";
import {
  parseTranslateY,
  pickRowKeyByY,
} from "../../../src/webviews/gantt/selection-utils.js";

describe("gantt selection utilities", () => {
  it("parseTranslateY extracts y from transform, falls back when absent", () => {
    expect(parseTranslateY("translate(5, 42.5)", 0)).toBe(42.5);
    expect(parseTranslateY("translate(0, -8)", 0)).toBe(-8);
    expect(parseTranslateY("", 17)).toBe(17);
    expect(parseTranslateY(undefined, 17)).toBe(17);
  });

  it("pickRowKeyByY returns the row whose band contains y", () => {
    const rows = [
      { key: "a", y: 0, height: 24 },
      { key: "b", y: 24, height: 24 },
      { key: "c", y: 48, height: 24 },
    ];
    expect(pickRowKeyByY(rows, 0)).toBe("a");
    expect(pickRowKeyByY(rows, 30)).toBe("b");
    expect(pickRowKeyByY(rows, 71.9)).toBe("c");
  });

  it("pickRowKeyByY returns null outside rows incl. collapse gaps", () => {
    const rows = [
      { key: "a", y: 0, height: 24 },
      { key: "c", y: 72, height: 24 }, // gap: rows under collapsed parent
    ];
    expect(pickRowKeyByY(rows, -1)).toBe(null);
    expect(pickRowKeyByY(rows, 30)).toBe(null);
    expect(pickRowKeyByY(rows, 96)).toBe(null);
  });
});
