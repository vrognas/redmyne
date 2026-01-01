import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
    due_date: "due_date" in overrides ? overrides.due_date : "2025-01-30",
    estimated_hours: overrides.estimated_hours ?? 8,
    spent_hours: overrides.spent_hours ?? 0,
    parent: overrides.parent,
  };
}

// Helper to get all issue nodes from time-grouped result
function getIssueNodes(result: HierarchyNode[]): HierarchyNode[] {
  return result.flatMap(group => group.children);
}

describe("buildMyWorkHierarchy", () => {
  const emptyCache = new Map<number, FlexibilityScore | null>();

  // Mock dates to have consistent test behavior
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns time-group nodes containing issues", () => {
    const issues = [
      createMockIssue({ id: 1, due_date: "2025-01-10" }), // overdue
      createMockIssue({ id: 2, due_date: "2025-01-17" }), // this week
      createMockIssue({ id: 3, due_date: "2025-01-25" }), // later
    ];

    const result = buildMyWorkHierarchy(issues, emptyCache);

    // Should have time-group nodes at top level
    expect(result.every(n => n.type === "time-group")).toBe(true);
    expect(result.every(n => n.depth === 0)).toBe(true);

    // Issues should be children at depth 1
    const issueNodes = getIssueNodes(result);
    expect(issueNodes.every(n => n.type === "issue")).toBe(true);
    expect(issueNodes.every(n => n.depth === 1)).toBe(true);
  });

  it("groups issues by due date category", () => {
    const issues = [
      createMockIssue({ id: 1, due_date: "2025-01-10" }), // overdue (before today)
      createMockIssue({ id: 2, due_date: "2025-01-17" }), // this week
      createMockIssue({ id: 3, due_date: "2025-02-01" }), // later
      createMockIssue({ id: 4, due_date: null as any }), // no date
    ];

    const result = buildMyWorkHierarchy(issues, emptyCache);

    // Should have 4 groups (overdue, this-week, later, no-date)
    expect(result.length).toBe(4);
    expect(result.map(g => g.timeGroup)).toEqual(["overdue", "this-week", "later", "no-date"]);

    // Each group should have 1 issue
    expect(result[0].children.length).toBe(1); // overdue
    expect(result[1].children.length).toBe(1); // this-week
    expect(result[2].children.length).toBe(1); // later
    expect(result[3].children.length).toBe(1); // no-date
  });

  it("sorts issues within each group by due_date ascending", () => {
    const issues = [
      createMockIssue({ id: 1, due_date: "2025-01-05" }), // overdue
      createMockIssue({ id: 2, due_date: "2025-01-08" }), // overdue
      createMockIssue({ id: 3, due_date: "2025-01-03" }), // overdue
    ];

    const result = buildMyWorkHierarchy(issues, emptyCache);

    // All in overdue group
    expect(result.length).toBe(1);
    expect(result[0].timeGroup).toBe("overdue");

    // Sorted by due_date: Jan 3, 5, 8
    const issueIds = result[0].children.map(n => n.id);
    expect(issueIds).toEqual([3, 1, 2]);
  });

  it("skips empty groups", () => {
    const issues = [
      createMockIssue({ id: 1, due_date: "2025-01-10" }), // overdue only
    ];

    const result = buildMyWorkHierarchy(issues, emptyCache);

    // Only overdue group should exist
    expect(result.length).toBe(1);
    expect(result[0].timeGroup).toBe("overdue");
  });

  it("includes projectName on each issue node", () => {
    const issues = [
      createMockIssue({ id: 1, project: { id: 10, name: "Alpha" }, due_date: "2025-01-20" }),
      createMockIssue({ id: 2, project: { id: 20, name: "Beta" }, due_date: "2025-01-21" }),
    ];

    const result = buildMyWorkHierarchy(issues, emptyCache);
    const issueNodes = getIssueNodes(result);

    expect(issueNodes[0].projectName).toBe("Alpha");
    expect(issueNodes[1].projectName).toBe("Beta");
  });

  it("ignores parent/child relationships (flat output within groups)", () => {
    const issues = [
      createMockIssue({ id: 1, due_date: "2025-01-20" }),
      createMockIssue({ id: 2, due_date: "2025-01-21", parent: { id: 1 } }),
      createMockIssue({ id: 3, due_date: "2025-01-22" }),
    ];

    const result = buildMyWorkHierarchy(issues, emptyCache);
    const issueNodes = getIssueNodes(result);

    // Child issue 2 should NOT be nested under parent 1
    expect(issueNodes.length).toBe(3);
    expect(issueNodes.every(n => n.children.length === 0)).toBe(true);
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
      due_date: "2025-01-20",
    });

    const result = buildMyWorkHierarchy([issue], emptyCache);
    const issueNodes = getIssueNodes(result);

    expect(issueNodes[0].issue).toBeDefined();
    expect(issueNodes[0].issue!.id).toBe(42);
    expect(issueNodes[0].issue!.subject).toBe("Important Task");
    expect(issueNodes[0].label).toBe("Important Task");
  });

  it("includes child count and aggregated hours on time-group nodes", () => {
    const issues = [
      createMockIssue({ id: 1, due_date: "2025-01-20", estimated_hours: 8, spent_hours: 2 }),
      createMockIssue({ id: 2, due_date: "2025-01-21", estimated_hours: 4, spent_hours: 1 }),
    ];

    const result = buildMyWorkHierarchy(issues, emptyCache);

    // Both in "later" group
    expect(result.length).toBe(1);
    expect(result[0].childCount).toBe(2);
    expect(result[0].aggregatedHours).toEqual({ spent: 3, estimated: 12 });
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

  it("respects expand state for time-group nodes", () => {
    const nodes: HierarchyNode[] = [
      {
        type: "time-group",
        id: 0,
        label: "Overdue",
        depth: 0,
        collapseKey: "time-group-overdue",
        parentKey: null,
        children: [
          {
            type: "issue",
            id: 1,
            label: "Task 1",
            depth: 1,
            children: [],
            collapseKey: "issue-1",
            parentKey: "time-group-overdue",
          },
        ],
      },
    ];

    // Collapsed: only group visible
    const collapsed = flattenHierarchy(nodes, new Set());
    expect(collapsed.length).toBe(1);
    expect(collapsed[0].type).toBe("time-group");

    // Expanded: group and children visible
    const expanded = flattenHierarchy(nodes, new Set(["time-group-overdue"]));
    expect(expanded.length).toBe(2);
    expect(expanded.map(n => n.type)).toEqual(["time-group", "issue"]);
  });
});
