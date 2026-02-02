import { describe, it, expect } from "vitest";
import {
  findDescendants,
  findVisibleDescendants,
  buildChildrenCache,
} from "../../../src/webviews/gantt/collapse-utils.js";

describe("gantt collapse utilities", () => {
  describe("findDescendants", () => {
    it("returns empty array when no children", () => {
      const childrenCache = new Map<string, Set<string>>();
      expect(findDescendants("root", childrenCache)).toEqual([]);
    });

    it("returns direct children", () => {
      const childrenCache = new Map<string, Set<string>>([
        ["root", new Set(["child1", "child2"])],
      ]);
      const result = findDescendants("root", childrenCache);
      expect(result.sort()).toEqual(["child1", "child2"]);
    });

    it("returns nested descendants (grandchildren)", () => {
      // root -> child1 -> grandchild1, grandchild2
      //      -> child2
      const childrenCache = new Map<string, Set<string>>([
        ["root", new Set(["child1", "child2"])],
        ["child1", new Set(["grandchild1", "grandchild2"])],
      ]);
      const result = findDescendants("root", childrenCache);
      expect(result.sort()).toEqual([
        "child1",
        "child2",
        "grandchild1",
        "grandchild2",
      ]);
    });

    it("handles deep hierarchy", () => {
      // root -> a -> b -> c -> d
      const childrenCache = new Map<string, Set<string>>([
        ["root", new Set(["a"])],
        ["a", new Set(["b"])],
        ["b", new Set(["c"])],
        ["c", new Set(["d"])],
      ]);
      const result = findDescendants("root", childrenCache);
      expect(result).toEqual(["a", "b", "c", "d"]);
    });

    it("handles wide hierarchy", () => {
      // root -> child1, child2, child3, child4, child5
      const childrenCache = new Map<string, Set<string>>([
        ["root", new Set(["c1", "c2", "c3", "c4", "c5"])],
      ]);
      const result = findDescendants("root", childrenCache);
      expect(result.length).toBe(5);
    });
  });

  describe("findVisibleDescendants", () => {
    it("returns empty array when no children", () => {
      const childrenCache = new Map<string, Set<string>>();
      const expandedState = new Map<string, boolean>();
      expect(
        findVisibleDescendants("root", childrenCache, expandedState)
      ).toEqual([]);
    });

    it("returns all direct children regardless of their expanded state", () => {
      const childrenCache = new Map<string, Set<string>>([
        ["root", new Set(["child1", "child2"])],
      ]);
      const expandedState = new Map<string, boolean>([
        ["child1", false],
        ["child2", true],
      ]);
      const result = findVisibleDescendants("root", childrenCache, expandedState);
      expect(result.sort()).toEqual(["child1", "child2"]);
    });

    it("excludes grandchildren of collapsed children", () => {
      // root -> child1 (collapsed) -> grandchild1
      //      -> child2 (expanded) -> grandchild2
      const childrenCache = new Map<string, Set<string>>([
        ["root", new Set(["child1", "child2"])],
        ["child1", new Set(["grandchild1"])],
        ["child2", new Set(["grandchild2"])],
      ]);
      const expandedState = new Map<string, boolean>([
        ["child1", false], // collapsed - grandchild1 should be excluded
        ["child2", true], // expanded - grandchild2 should be included
      ]);
      const result = findVisibleDescendants("root", childrenCache, expandedState);
      expect(result.sort()).toEqual(["child1", "child2", "grandchild2"]);
    });

    it("stops traversal at collapsed nodes in deep hierarchy", () => {
      // root -> a (expanded) -> b (collapsed) -> c -> d
      const childrenCache = new Map<string, Set<string>>([
        ["root", new Set(["a"])],
        ["a", new Set(["b"])],
        ["b", new Set(["c"])],
        ["c", new Set(["d"])],
      ]);
      const expandedState = new Map<string, boolean>([
        ["a", true],
        ["b", false], // collapsed - c and d should be excluded
        ["c", true],
      ]);
      const result = findVisibleDescendants("root", childrenCache, expandedState);
      expect(result).toEqual(["a", "b"]);
    });

    it("includes all descendants when all expanded", () => {
      const childrenCache = new Map<string, Set<string>>([
        ["root", new Set(["a"])],
        ["a", new Set(["b"])],
        ["b", new Set(["c"])],
      ]);
      const expandedState = new Map<string, boolean>([
        ["a", true],
        ["b", true],
        ["c", true],
      ]);
      const result = findVisibleDescendants("root", childrenCache, expandedState);
      expect(result).toEqual(["a", "b", "c"]);
    });

    it("handles missing expanded state as collapsed", () => {
      const childrenCache = new Map<string, Set<string>>([
        ["root", new Set(["child"])],
        ["child", new Set(["grandchild"])],
      ]);
      const expandedState = new Map<string, boolean>(); // empty - child not in cache
      const result = findVisibleDescendants("root", childrenCache, expandedState);
      // child is included, but grandchild excluded since child's state is undefined (falsy)
      expect(result).toEqual(["child"]);
    });
  });

  describe("buildChildrenCache", () => {
    it("returns empty map for empty ancestor cache", () => {
      const ancestorCache = new Map<string, string[]>();
      const result = buildChildrenCache(ancestorCache);
      expect(result.size).toBe(0);
    });

    it("builds parent-child relationships from ancestors", () => {
      // child1 has parent "root", child2 has parent "root"
      const ancestorCache = new Map<string, string[]>([
        ["child1", ["root"]],
        ["child2", ["root"]],
      ]);
      const result = buildChildrenCache(ancestorCache);
      expect(result.get("root")).toEqual(new Set(["child1", "child2"]));
    });

    it("handles deep hierarchy", () => {
      // grandchild ancestors: [child, root]
      // child ancestors: [root]
      const ancestorCache = new Map<string, string[]>([
        ["child", ["root"]],
        ["grandchild", ["child", "root"]],
      ]);
      const result = buildChildrenCache(ancestorCache);
      expect(result.get("root")).toEqual(new Set(["child"]));
      expect(result.get("child")).toEqual(new Set(["grandchild"]));
    });

    it("ignores nodes without parents", () => {
      const ancestorCache = new Map<string, string[]>([
        ["orphan", []], // no ancestors
        ["child", ["root"]],
      ]);
      const result = buildChildrenCache(ancestorCache);
      expect(result.has("orphan")).toBe(false);
      expect(result.get("root")).toEqual(new Set(["child"]));
    });
  });
});
