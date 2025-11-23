import { describe, it, expect } from "vitest";
import { createIssueTreeItem } from "../../../src/utilities/tree-item-factory";
import { Issue } from "../../../src/redmine/models/issue";

describe("createIssueTreeItem", () => {
  const mockIssue: Issue = {
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

  it("should set label to issue subject", () => {
    const treeItem = createIssueTreeItem(mockIssue, undefined, "test.command");

    expect(treeItem.label).toBe("Test Issue 1234");
  });

  it("should set description to issue number", () => {
    const treeItem = createIssueTreeItem(mockIssue, undefined, "test.command");

    expect(treeItem.description).toBe("#7392");
  });

  it("should set command with issue id", () => {
    const server = { options: { address: "http://test.com" } };
    const treeItem = createIssueTreeItem(
      mockIssue,
      server,
      "redmine.openActionsForIssue"
    );

    expect(treeItem.command?.command).toBe("redmine.openActionsForIssue");
    expect(treeItem.command?.arguments).toEqual([false, { server }, "7392"]);
    expect(treeItem.command?.title).toBe("Open actions for issue #7392");
  });

  it("should set collapsible state to None", () => {
    const treeItem = createIssueTreeItem(mockIssue, undefined, "test.command");

    expect(treeItem.collapsibleState).toBe(0); // TreeItemCollapsibleState.None
  });
});
