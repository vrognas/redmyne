import { describe, it, expect } from "vitest";
import { groupBy } from "../../../src/utilities/collection-utils";

describe("groupBy", () => {
  it("groups items by key function", () => {
    const items = [
      { type: "a", value: 1 },
      { type: "b", value: 2 },
      { type: "a", value: 3 },
    ];
    const result = groupBy(items, (x) => x.type);

    expect(result.get("a")).toEqual([
      { type: "a", value: 1 },
      { type: "a", value: 3 },
    ]);
    expect(result.get("b")).toEqual([{ type: "b", value: 2 }]);
  });

  it("returns empty map for empty array", () => {
    const result = groupBy([], (x: { id: number }) => x.id);
    expect(result.size).toBe(0);
  });

  it("handles multiple items per group", () => {
    const items = [1, 2, 3, 4, 5, 6];
    const result = groupBy(items, (x) => (x % 2 === 0 ? "even" : "odd"));

    expect(result.get("even")).toEqual([2, 4, 6]);
    expect(result.get("odd")).toEqual([1, 3, 5]);
  });
});
