import { describe, expect, it, vi } from "vitest";
import { CollapseStateManager } from "../../../src/utilities/collapse-state";

describe("CollapseStateManager", () => {
  it("tracks collapsed/expanded state and emits change events", () => {
    const manager = new CollapseStateManager();
    const events: Array<{ key: string; collapsed: boolean }> = [];
    const sub = manager.onDidChange((event) => events.push(event));

    expect(manager.isCollapsed("a")).toBe(true);
    expect(manager.isExpanded("a")).toBe(false);

    manager.expand("a");
    expect(manager.isExpanded("a")).toBe(true);

    manager.collapse("a");
    expect(manager.isCollapsed("a")).toBe(true);

    manager.expand("a");
    manager.toggle("a");
    expect(manager.isCollapsed("a")).toBe(true);

    manager.setCollapsed("a", true); // no-op branch
    expect(events).toEqual([
      { key: "a", collapsed: false },
      { key: "a", collapsed: true },
      { key: "a", collapsed: false },
      { key: "a", collapsed: true },
    ]);

    sub.dispose();
    manager.dispose();
  });

  it("handles expandAll/collapseAll/clear", () => {
    const manager = new CollapseStateManager();
    const events: Array<{ key: string; collapsed: boolean }> = [];
    const sub = manager.onDidChange((event) => events.push(event));

    manager.expandAll(["x", "y"]);
    expect(Array.from(manager.getExpandedKeys()).sort()).toEqual(["x", "y"]);

    manager.expandAll(); // branch without keys
    manager.collapseAll();
    expect(manager.getExpandedKeys().size).toBe(0);
    manager.clear();
    expect(manager.getExpandedKeys().size).toBe(0);

    expect(events).toContainEqual({ key: "*", collapsed: false });
    expect(events).toContainEqual({ key: "*", collapsed: true });
    sub.dispose();
  });
});
