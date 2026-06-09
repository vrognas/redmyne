import { describe, it, expect } from "vitest";
import {
  findDescendants,
  findVisibleDescendants,
  buildChildrenCache,
  buildAncestorChains,
  computeVisibleStripeHeight,
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

    it("returns document (pre-order DFS) order for nested expanded parents", () => {
      // Regression: the expand repositioning in toggleCollapseClientSide
      // consumes this array as the top-to-bottom visual sequence. BFS order
      // (all children before any grandchild) wedges a later sibling between
      // an expanded child and its own children -> overlapping rows.
      // parent -> c1 (expanded) -> gc1, gc2
      //        -> c2 (expanded) -> gc3, gc4
      const childrenCache = new Map<string, Set<string>>([
        ["parent", new Set(["c1", "c2"])],
        ["c1", new Set(["gc1", "gc2"])],
        ["c2", new Set(["gc3", "gc4"])],
      ]);
      const expandedState = new Map<string, boolean>([
        ["c1", true],
        ["c2", true],
      ]);
      const result = findVisibleDescendants("parent", childrenCache, expandedState);
      expect(result).toEqual(["c1", "gc1", "gc2", "c2", "gc3", "gc4"]);
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

  describe("buildAncestorChains", () => {
    it("builds direct-parent ancestors and children from (key, parentKey) pairs", () => {
      const { ancestorCache, childrenCache } = buildAncestorChains([
        { key: "c1", parentKey: "root" },
        { key: "c2", parentKey: "root" },
      ]);
      expect(ancestorCache.get("c1")).toEqual(["root"]);
      expect(ancestorCache.get("c2")).toEqual(["root"]);
      expect(childrenCache.get("root")).toEqual(new Set(["c1", "c2"]));
    });

    it("walks the full chain and dedups repeated pairs (a row spans many column SVGs)", () => {
      const { ancestorCache, childrenCache } = buildAncestorChains([
        { key: "gc", parentKey: "child" },
        { key: "gc", parentKey: "child" }, // duplicate: same row, another column
        { key: "child", parentKey: "root" },
      ]);
      expect(ancestorCache.get("gc")).toEqual(["child", "root"]);
      expect(ancestorCache.get("child")).toEqual(["root"]);
      expect(childrenCache.get("child")).toEqual(new Set(["gc"]));
    });

    it("terminates on a parent cycle instead of looping forever", () => {
      const { ancestorCache } = buildAncestorChains([
        { key: "a", parentKey: "b" },
        { key: "b", parentKey: "a" },
      ]);
      expect(ancestorCache.get("a")).toEqual(["b", "a"]);
      expect(ancestorCache.get("b")).toEqual(["a", "b"]);
    });
  });

  describe("computeVisibleStripeHeight", () => {
    // band: client > P (p1), Q (q1) — all rows 22px
    const contributions = { client: 22, P: 22, p1: 22, Q: 22, q1: 22 };
    const ancestorCache = new Map<string, string[]>([
      ["P", ["client"]],
      ["Q", ["client"]],
      ["p1", ["P", "client"]],
      ["q1", ["Q", "client"]],
    ]);

    it("excludes rows hidden under OTHER collapsed parents (sibling overcount)", () => {
      // Q collapsed first, then P: q1 AND p1 must both be excluded
      const collapsedKeys = new Set(["P", "Q"]);
      expect(computeVisibleStripeHeight(contributions, collapsedKeys, ancestorCache)).toBe(66); // client+P+Q
    });

    it("returns 0 when every contributing row is hidden (band fully collapsed away)", () => {
      const collapsedKeys = new Set(["client"]);
      expect(
        computeVisibleStripeHeight({ P: 22, p1: 22 }, collapsedKeys, ancestorCache)
      ).toBe(0);
    });

    it("counts keys without ancestor entries (band roots) as visible", () => {
      expect(
        computeVisibleStripeHeight({ client: 22, P: 22 }, new Set<string>(), ancestorCache)
      ).toBe(44);
    });
  });
});
