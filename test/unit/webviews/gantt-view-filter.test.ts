import { describe, it, expect } from "vitest";
import { deriveAssigneeState, filterIssuesForView, isLateIssue, isIssueVisibleInGanttView } from "../../../src/webviews/gantt-view-filter";
import { RedmineProject } from "../../../src/redmine/redmine-project";
import { Issue } from "../../../src/redmine/models/issue";

const createIssue = (overrides: Partial<Issue> = {}): Issue => ({
  id: 1,
  project: { id: 1, name: "Project" },
  tracker: { id: 1, name: "Task" },
  status: { id: 1, name: "New", is_closed: false },
  priority: { id: 1, name: "Normal" },
  author: { id: 1, name: "Author" },
  assigned_to: { id: 1, name: "Alice" },
  subject: "Issue",
  description: "",
  start_date: "2024-01-01",
  due_date: null,
  done_ratio: 0,
  is_private: false,
  estimated_hours: null,
  created_on: "2024-01-01",
  updated_on: "2024-01-01",
  closed_on: null,
  ...overrides,
});

describe("deriveAssigneeState", () => {
  it("prioritizes the current user in the assignee list", () => {
    const issues = [
      createIssue({ id: 1, assigned_to: { id: 2, name: "Zoe" } }),
      createIssue({ id: 2, assigned_to: { id: 3, name: "Alex" } }),
    ];

    const state = deriveAssigneeState(issues, 3, null);

    expect(state.currentUserName).toBe("Alex");
    expect(state.uniqueAssignees).toEqual(["Alex", "Zoe"]);
  });
});

describe("isIssueVisibleInGanttView", () => {
  const baseState = {
    viewFocus: "project" as const,
    selectedAssignee: null,
    selectedProjectId: null,
    taskTypeField: null,
    taskTypeFilter: "any",
    lateOnly: false,
    currentFilter: { assignee: "any" as const, status: "any" as const },
  };
  const call = (issueId: number, issues: Issue[], stateOverrides: Partial<typeof baseState> = {}) =>
    isIssueVisibleInGanttView({
      issueId,
      issues,
      projects: [],
      state: { ...baseState, ...stateOverrides },
      currentUserId: null,
      currentUserName: null,
      internalEstimates: new Map(),
      todayStr: "2024-06-01",
      contributedHoursFor: () => 0,
    });

  it("is visible under the broad by-project view", () => {
    const issues = [createIssue({ id: 7 })];
    expect(call(7, issues)).toBe(true);
  });

  it("is hidden when a task-type filter excludes it", () => {
    const issues = [createIssue({ id: 7 })];
    expect(call(7, issues, { taskTypeField: "Task Type", taskTypeFilter: "Bug" })).toBe(false);
  });

  it("is hidden by late-only when the issue isn't late", () => {
    const issues = [createIssue({ id: 7, due_date: "2099-01-01" })];
    expect(call(7, issues, { lateOnly: true })).toBe(false);
  });
});

describe("filterIssuesForView", () => {
  it("filters person view by the effective assignee", () => {
    const issues = [
      createIssue({ id: 1, assigned_to: { id: 2, name: "Zoe" } }),
      createIssue({ id: 2, assigned_to: { id: 3, name: "Alex" } }),
    ];

    const result = filterIssuesForView({
      issues,
      projects: [],
      viewFocus: "person",
      selectedAssignee: null,
      currentUserName: "Alex",
      uniqueAssignees: ["Alex", "Zoe"],
      selectedProjectId: null,
      currentFilter: { assignee: "any", status: "any" },
      currentUserId: 3,
    });

    expect(result.selectedAssignee).toBe("Alex");
    expect(result.filteredIssues.map((issue) => issue.id)).toEqual([2]);
  });

  it("filters project view by descendants and assignee", () => {
    const root = new RedmineProject({
      id: 1,
      name: "Root",
      description: "",
      identifier: "root",
    });
    const child = new RedmineProject({
      id: 2,
      name: "Child",
      description: "",
      identifier: "child",
      parent: { id: 1, name: "Root" },
    });
    const other = new RedmineProject({
      id: 3,
      name: "Other",
      description: "",
      identifier: "other",
    });
    const issues = [
      createIssue({ id: 1, project: { id: 1, name: "Root" }, assigned_to: { id: 10, name: "Me" } }),
      createIssue({ id: 2, project: { id: 2, name: "Child" }, assigned_to: { id: 10, name: "Me" } }),
      createIssue({ id: 3, project: { id: 3, name: "Other" }, assigned_to: { id: 10, name: "Me" } }),
    ];

    const result = filterIssuesForView({
      issues,
      projects: [root, child, other],
      viewFocus: "project",
      selectedAssignee: null,
      currentUserName: null,
      uniqueAssignees: [],
      selectedProjectId: 1, // Explicitly select root project
      currentFilter: { assignee: "me", status: "any" },
      currentUserId: 10,
    });

    expect(result.selectedProjectId).toBe(1);
    expect(result.filteredIssues.map((issue) => issue.id).sort()).toEqual([1, 2]);
  });

  it("preserves null selectedProjectId for All Projects view", () => {
    const proj1 = new RedmineProject({
      id: 1,
      name: "Project 1",
      description: "",
      identifier: "p1",
    });
    const proj2 = new RedmineProject({
      id: 2,
      name: "Project 2",
      description: "",
      identifier: "p2",
    });
    const issues = [
      createIssue({ id: 1, project: { id: 1, name: "Project 1" } }),
      createIssue({ id: 2, project: { id: 2, name: "Project 2" } }),
    ];

    const result = filterIssuesForView({
      issues,
      projects: [proj1, proj2],
      viewFocus: "project",
      selectedAssignee: null,
      currentUserName: null,
      uniqueAssignees: [],
      selectedProjectId: null, // All Projects
      currentFilter: { assignee: "any", status: "any" },
      currentUserId: null,
    });

    // null should be preserved (All Projects) and all issues returned
    expect(result.selectedProjectId).toBeNull();
    expect(result.filteredIssues.map((i) => i.id).sort()).toEqual([1, 2]);
  });

  it("falls back to first project when selectedProjectId does not exist", () => {
    const proj1 = new RedmineProject({
      id: 10,
      name: "Project 10",
      description: "",
      identifier: "p10",
    });
    const proj2 = new RedmineProject({
      id: 20,
      name: "Project 20",
      description: "",
      identifier: "p20",
    });
    const issues = [
      createIssue({ id: 1, project: { id: 10, name: "Project 10" } }),
      createIssue({ id: 2, project: { id: 20, name: "Project 20" } }),
    ];

    const result = filterIssuesForView({
      issues,
      projects: [proj1, proj2],
      viewFocus: "project",
      selectedAssignee: null,
      currentUserName: null,
      uniqueAssignees: [],
      // Invalid project ID that doesn't exist
      selectedProjectId: 999,
      currentFilter: { assignee: "any", status: "any" },
      currentUserId: null,
    });

    // Should fall back to first project (ID 10)
    expect(result.selectedProjectId).toBe(10);
    expect(result.filteredIssues.map((i) => i.id)).toEqual([1]);
  });
});

describe("isLateIssue", () => {
  const today = "2026-06-11";
  const noEstimates = new Map();

  it("flags past-due open work with remaining hours", () => {
    const late = createIssue({
      due_date: "2026-05-20",
      estimated_hours: 16,
      spent_hours: 5,
    } as Partial<Issue>);
    expect(isLateIssue(late, noEstimates, today)).toBe(true);
  });

  it("ignores future-due, closed, done, and effectively-done issues", () => {
    expect(isLateIssue(createIssue({ due_date: "2026-07-01" }), noEstimates, today)).toBe(false);
    expect(isLateIssue(createIssue({
      due_date: "2026-05-20",
      status: { id: 5, name: "Closed", is_closed: true },
    }), noEstimates, today)).toBe(false);
    expect(isLateIssue(createIssue({ due_date: "2026-05-20", done_ratio: 100 }), noEstimates, today)).toBe(false);
    // consumed budget + unmaintained done_ratio = essentially done
    expect(isLateIssue(createIssue({
      due_date: "2026-05-20",
      estimated_hours: 16,
      spent_hours: 18,
    } as Partial<Issue>), noEstimates, today)).toBe(false);
  });

  it("internal estimate overrides the budget heuristic", () => {
    const issue = createIssue({
      id: 7,
      due_date: "2026-05-20",
      estimated_hours: 16,
      spent_hours: 18, // budget says done...
    } as Partial<Issue>);
    const estimates = new Map([[7, { hoursRemaining: 4, updatedAt: "2026-06-01" }]]);
    expect(isLateIssue(issue, estimates, today)).toBe(true); // ...internal says 4h left
  });
});
