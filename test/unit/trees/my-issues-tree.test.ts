import { describe, it, expect } from "vitest";
import {
  MyIssuesTree,
  isParentContainer,
  ParentContainer,
} from "../../../src/trees/my-issues-tree";
import { Issue } from "../../../src/redmine/models/issue";

describe("MyIssuesTree", () => {
  it("should format issue label as subject only", () => {
    const tree = new MyIssuesTree();
    const issue: Issue = {
      id: 7392,
      subject: "Test Issue 1234",
      tracker: { id: 1, name: "Tasks" },
      status: { id: 1, name: "Not Yet Started" },
      author: { id: 1, name: "Viktor Rognås" },
      project: { id: 1, name: "Test Project" },
      priority: { id: 1, name: "Normal" },
      description: "Test description",
      created_on: "2024-01-01",
      updated_on: "2024-01-01",
    };

    const treeItem = tree.getTreeItem(issue);

    expect(treeItem.label).toBe("Test Issue 1234");
  });

  it("should format issue description as issue number with reduced opacity", () => {
    const tree = new MyIssuesTree();
    const issue: Issue = {
      id: 7392,
      subject: "Test Issue 1234",
      tracker: { id: 1, name: "Tasks" },
      status: { id: 1, name: "Not Yet Started" },
      author: { id: 1, name: "Viktor Rognås" },
      project: { id: 1, name: "Test Project" },
      priority: { id: 1, name: "Normal" },
      description: "Test description",
      created_on: "2024-01-01",
      updated_on: "2024-01-01",
    };

    const treeItem = tree.getTreeItem(issue);

    expect(treeItem.description).toBe("#7392");
  });

  it("should set command to open actions for issue", () => {
    const tree = new MyIssuesTree();
    const issue: Issue = {
      id: 7392,
      subject: "Test Issue 1234",
      tracker: { id: 1, name: "Tasks" },
      status: { id: 1, name: "Not Yet Started" },
      author: { id: 1, name: "Viktor Rognås" },
      project: { id: 1, name: "Test Project" },
      priority: { id: 1, name: "Normal" },
      description: "Test description",
      created_on: "2024-01-01",
      updated_on: "2024-01-01",
    };

    const treeItem = tree.getTreeItem(issue);

    expect(treeItem.command?.command).toBe("redmine.openActionsForIssue");
    expect(treeItem.command?.arguments?.[2]).toBe("7392");
  });
});

describe("isParentContainer", () => {
  it("returns true for ParentContainer", () => {
    const container: ParentContainer = {
      id: 100,
      subject: "Parent Issue",
      isContainer: true,
      childCount: 3,
      aggregatedHours: { spent: 10, estimated: 40 },
    };

    expect(isParentContainer(container)).toBe(true);
  });

  it("returns false for Issue", () => {
    const issue: Issue = {
      id: 7392,
      subject: "Test Issue",
      tracker: { id: 1, name: "Task" },
      status: { id: 1, name: "New" },
      author: { id: 1, name: "Author" },
      project: { id: 1, name: "Project" },
      priority: { id: 1, name: "Normal" },
      description: "",
      created_on: "2024-01-01",
      updated_on: "2024-01-01",
    };

    expect(isParentContainer(issue)).toBe(false);
  });
});
