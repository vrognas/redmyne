import { describe, it, expect } from "vitest";
import {
  buildMyWorkHierarchy,
  flattenHierarchy,
  HierarchyNode,
} from "../../../src/utilities/hierarchy-builder";
import type { Issue } from "../../../src/redmine/models/issue";
import type { FlexibilityScore } from "../../../src/utilities/flexibility-calculator";

function createMockIssue(overrides: Partial<Issue> & { id: number }): Issue {
  return {
    id: overrides.id,
    subject: overrides.subject ?? `Issue ${overrides.id}`,
    project: overrides.project ?? { id: 1, name: "Project A" },
    tracker: { id: 1, name: "Task" },
    status: { id: 1, name: "In Progress" },
    priority: { id: 2, name: "Normal" },
    author: { id: 1, name: "Author" },
    assigned_to: overrides.assigned_to ?? { id: 1, name: "Me" },
    description: "",
    done_ratio: 0,
    is_private: false,
    created_on: "2025-01-01T00:00:00Z",
    updated_on: "2025-01-01T00:00:00Z",
    closed_on: null,
    start_date: overrides.start_date ?? "2025-01-15",
    due_date: overrides.due_date ?? "2025-01-30",
    estimated_hours: overrides.estimated_hours ?? 8,
    spent_hours: overrides.spent_hours ?? 0,
    parent: overrides.parent,
  };
}

describe("buildMyWorkHierarchy", () => {
  const emptyCache = new Map<number, FlexibilityScore | null>();

  it("returns flat list without project grouping", () => {
    const issues = [
      createMockIssue({ id: 1, project: { id: 10, name: "Project A" } }),
      createMockIssue({ id: 2, project: { id: 20, name: "Project B" } }),
      createMockIssue({ id: 3, project: { id: 10, name: "Project A" } }),
    ];

    const result = buildMyWorkHierarchy(issues, emptyCache);

    // Should be flat - all nodes at depth 0, type "issue"
    expect(result.every(n => n.type === "issue")).toBe(true);
    expect(result.every(n => n.depth === 0)).toBe(true);
    expect(result.every(n => n.parentKey === null)).toBe(true);
  });

  it("sorts by start_date ascending", () => {
    const issues = [
      createMockIssue({ id: 1, start_date: "2025-01-20" }),
      createMockIssue({ id: 2, start_date: "2025-01-10" }),
      createMockIssue({ id: 3, start_date: "2025-01-15" }),
    ];

    const result = buildMyWorkHierarchy(issues, emptyCache);

    expect(result.map(n => n.id)).toEqual([2, 3, 1]); // Jan 10, 15, 20
  });

  it("puts issues without start_date at end", () => {
    const issues = [
      createMockIssue({ id: 1, start_date: "2025-01-15" }),
      createMockIssue({ id: 2, start_date: undefined as any }),
      createMockIssue({ id: 3, start_date: "2025-01-10" }),
    ];

    const result = buildMyWorkHierarchy(issues, emptyCache);

    expect(result.map(n => n.id)).toEqual([3, 1, 2]); // Jan 10, 15, then no-date
  });

  it("includes projectName on each node", () => {
    const issues = [
      createMockIssue({ id: 1, project: { id: 10, name: "Alpha" } }),
      createMockIssue({ id: 2, project: { id: 20, name: "Beta" } }),
    ];

    const result = buildMyWorkHierarchy(issues, emptyCache);

    expect(result[0].projectName).toBe("Alpha");
    expect(result[1].projectName).toBe("Beta");
  });

  it("ignores parent/child relationships (flat output)", () => {
    const issues = [
      createMockIssue({ id: 1, start_date: "2025-01-10" }),
      createMockIssue({ id: 2, start_date: "2025-01-20", parent: { id: 1 } }),
      createMockIssue({ id: 3, start_date: "2025-01-15" }),
    ];

    const result = buildMyWorkHierarchy(issues, emptyCache);

    // Child issue 2 should NOT be nested under parent 1
    expect(result.length).toBe(3);
    expect(result.every(n => n.children.length === 0)).toBe(true);
    expect(result.map(n => n.id)).toEqual([1, 3, 2]); // sorted by date, not hierarchy
  });

  it("returns empty array for empty input", () => {
    const result = buildMyWorkHierarchy([], emptyCache);
    expect(result).toEqual([]);
  });

  it("preserves issue data on each node", () => {
    const issue = createMockIssue({
      id: 42,
      subject: "Important Task",
      estimated_hours: 16,
    });

    const result = buildMyWorkHierarchy([issue], emptyCache);

    expect(result[0].issue).toBeDefined();
    expect(result[0].issue!.id).toBe(42);
    expect(result[0].issue!.subject).toBe("Important Task");
    expect(result[0].label).toBe("Important Task");
  });
});

describe("flattenHierarchy with My Work nodes", () => {
  it("returns all nodes at once (no collapse logic for flat list)", () => {
    const nodes: HierarchyNode[] = [
      {
        type: "issue",
        id: 1,
        label: "Task 1",
        depth: 0,
        children: [],
        collapseKey: "issue-1",
        parentKey: null,
        projectName: "Project A",
      },
      {
        type: "issue",
        id: 2,
        label: "Task 2",
        depth: 0,
        children: [],
        collapseKey: "issue-2",
        parentKey: null,
        projectName: "Project B",
      },
    ];

    const result = flattenHierarchy(nodes, new Set());

    expect(result.length).toBe(2);
    expect(result.map(n => n.id)).toEqual([1, 2]);
  });
});
