import { beforeEach, describe, expect, it, vi } from "vitest";
import { toGanttIssue, nodeToGanttRow } from "../../../src/webviews/gantt-model";
import { adHocTracker } from "../../../src/utilities/adhoc-tracker";
import * as dependencyGraph from "../../../src/utilities/dependency-graph";

function createIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    subject: "Issue 100",
    project: { id: 10, name: "Project 10" },
    status: { id: 2, name: "In Progress" },
    priority: { id: 3, name: "High" },
    assigned_to: { id: 7, name: "Alice" },
    start_date: "2026-02-01",
    due_date: "2026-02-05",
    done_ratio: 40,
    estimated_hours: 8,
    spent_hours: 2,
    relations: [],
    ...overrides,
  } as unknown as import("../../../src/redmine/models/issue").Issue;
}

describe("gantt model", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("maps issue fields and filters non-renderable relations", () => {
    vi.spyOn(adHocTracker, "isAdHoc").mockReturnValue(true);

    const issue = createIssue({
      relations: [
        { id: 1, relation_type: "blocks", issue_to_id: 200, issue_id: 100 },
        { id: 2, relation_type: "blocked", issue_to_id: 300, issue_id: 100 },
        { id: 3, relation_type: "duplicated", issue_to_id: 300, issue_id: 100 },
        { id: 4, relation_type: "copied_from", issue_to_id: 300, issue_id: 100 },
        { id: 5, relation_type: "follows", issue_to_id: 300, issue_id: 100 },
        { id: 6, relation_type: "precedes", issue_to_id: 100, issue_id: 100 },
      ],
    });
    const flexibility = new Map([
      [100, { status: "on-track", initial: 25 }],
    ]) as unknown as Map<number, import("../../../src/utilities/flexibility-calculator").FlexibilityScore | null>;

    const result = toGanttIssue(issue, flexibility, new Set([2]), null, null, true);

    expect(result.isClosed).toBe(true);
    expect(result.status).toBe("on-track");
    expect(result.flexibilityPercent).toBe(25);
    expect(result.isExternal).toBe(true);
    expect(result.isAdHoc).toBe(true);
    expect(result.relations).toEqual([
      { id: 1, targetId: 200, type: "blocks" },
    ]);
  });

  it("uses dependency graph helpers when provided", () => {
    vi.spyOn(adHocTracker, "isAdHoc").mockReturnValue(false);
    vi.spyOn(dependencyGraph, "countDownstream").mockReturnValue(3);
    vi.spyOn(dependencyGraph, "getDownstream").mockReturnValue([
      { id: 201, subject: "Downstream A", assignee: "Bob" },
    ] as never);
    vi.spyOn(dependencyGraph, "getBlockers").mockReturnValue([
      { id: 301, subject: "Blocker A", assignee: "Eve" },
    ] as never);

    const issue = createIssue({ id: 101, status: { id: 9, name: "Closed" } });
    const issueMap = new Map([[101, issue]]);
    const result = toGanttIssue(
      issue,
      new Map(),
      new Set(),
      {} as never,
      issueMap as never,
      false,
      issueMap as never
    );

    expect(result.isClosed).toBe(true);
    expect(result.downstreamCount).toBe(3);
    expect(result.blocks).toEqual([{ id: 201, subject: "Downstream A", assignee: "Bob" }]);
    expect(result.blockedBy).toEqual([{ id: 301, subject: "Blocker A", assignee: "Eve" }]);
  });

  it("maps project, time-group, container, and issue nodes", () => {
    const projectNode = {
      type: "project",
      id: 10,
      label: "Project 10",
      depth: 0,
      collapseKey: "project-10",
      parentKey: null,
      children: [{ id: 1 }],
      childDateRanges: [{ startDate: "2026-01-01", dueDate: "2026-01-02", issueId: 100 }],
      isVisible: true,
      isExpanded: true,
      health: { progress: 50 },
      description: "Project desc",
      identifier: "project-10",
      customFields: [{ name: "Team", value: "A" }],
    };
    const timeGroupNode = {
      ...projectNode,
      type: "time-group",
      timeGroup: "this-week",
      icon: "⏱",
      childCount: 3,
    };
    const containerNode = {
      ...projectNode,
      type: "container",
      children: [],
    };
    const issueNode = {
      ...projectNode,
      type: "issue",
      id: 100,
      children: [{ id: 200 }],
      issue: createIssue({ id: 100 }),
      projectName: "Project 10",
      isExternal: false,
    };

    const projectRow = nodeToGanttRow(projectNode as never, new Map(), new Set(), null, null);
    const timeGroupRow = nodeToGanttRow(timeGroupNode as never, new Map(), new Set(), null, null);
    const containerRow = nodeToGanttRow(containerNode as never, new Map(), new Set(), null, null);
    const issueRow = nodeToGanttRow(
      issueNode as never,
      new Map(),
      new Set(),
      null,
      null
    );

    expect(projectRow.type).toBe("project");
    expect(projectRow.hasChildren).toBe(true);
    expect(timeGroupRow.type).toBe("time-group");
    expect(timeGroupRow.childCount).toBe(3);
    expect(containerRow.type).toBe("project");
    expect(containerRow.hasChildren).toBe(false);
    expect(issueRow.type).toBe("issue");
    expect(issueRow.isParent).toBe(true);
    expect(issueRow.projectName).toBe("Project 10");
  });
});
