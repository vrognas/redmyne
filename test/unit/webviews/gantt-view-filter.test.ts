import { describe, it, expect } from "vitest";
import { deriveAssigneeState, filterIssuesForView } from "../../../src/webviews/gantt-view-filter";
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
      selectedProjectId: null,
      currentFilter: { assignee: "me", status: "any" },
      currentUserId: 10,
    });

    expect(result.selectedProjectId).toBe(1);
    expect(result.filteredIssues.map((issue) => issue.id).sort()).toEqual([1, 2]);
  });
});
