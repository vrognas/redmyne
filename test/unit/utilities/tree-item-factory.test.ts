import { describe, it, expect } from "vitest";
import {
  createIssueTreeItem,
  createEnhancedIssueTreeItem,
} from "../../../src/utilities/tree-item-factory";
import { Issue } from "../../../src/redmine/models/issue";
import { FlexibilityScore } from "../../../src/utilities/flexibility-calculator";

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
    const server = { options: { address: "https://test.com" } };
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

describe("createEnhancedIssueTreeItem", () => {
  const mockIssue: Issue = {
    id: 7392,
    subject: "Test Issue",
    tracker: { id: 1, name: "Tasks" },
    status: { id: 1, name: "In Progress" },
    author: { id: 1, name: "Author" },
    project: { id: 1, name: "Test Project" },
    priority: { id: 1, name: "Normal" },
    assigned_to: { id: 2, name: "Assignee" },
    description: "Test description",
    start_date: "2025-11-01",
    due_date: "2025-11-30",
    done_ratio: 50,
    is_private: false,
    estimated_hours: 40,
    spent_hours: 20,
    created_on: "2024-01-01",
    updated_on: "2024-01-01",
    closed_on: null,
  };

  const mockFlexibility: FlexibilityScore = {
    initial: 100,
    remaining: 50,
    status: "on-track",
    daysRemaining: 10,
    hoursRemaining: 20,
  };

  it("shows On Track status with icon", () => {
    const treeItem = createEnhancedIssueTreeItem(
      mockIssue,
      mockFlexibility,
      undefined,
      "test.command"
    );

    expect(treeItem.description).toContain("On Track");
    expect(treeItem.iconPath).toBeDefined();
  });

  it("shows Overbooked status for negative flexibility", () => {
    const overbooked: FlexibilityScore = {
      ...mockFlexibility,
      remaining: -30,
      status: "overbooked",
    };

    const treeItem = createEnhancedIssueTreeItem(
      mockIssue,
      overbooked,
      undefined,
      "test.command"
    );

    expect(treeItem.description).toContain("Overbooked");
  });

  it("shows Done for completed issues", () => {
    const completed: FlexibilityScore = {
      ...mockFlexibility,
      status: "completed",
    };

    const treeItem = createEnhancedIssueTreeItem(
      mockIssue,
      completed,
      undefined,
      "test.command"
    );

    expect(treeItem.description).toContain("Done");
  });

  it("falls back to simple display when no flexibility", () => {
    const treeItem = createEnhancedIssueTreeItem(
      mockIssue,
      null,
      undefined,
      "test.command"
    );

    expect(treeItem.description).toBe("#7392");
  });

  it("includes tracker name in tooltip", () => {
    const treeItem = createEnhancedIssueTreeItem(
      mockIssue,
      mockFlexibility,
      undefined,
      "test.command"
    );

    // tooltip is MarkdownString
    const tooltipValue = (treeItem.tooltip as { value: string })?.value;
    expect(tooltipValue).toContain("**Tracker:**");
    expect(tooltipValue).toContain("Tasks"); // tracker.name from mockIssue
  });

  it("dims non-billable issues (tracker !== Task)", () => {
    const nonBillableIssue: Issue = {
      ...mockIssue,
      tracker: { id: 2, name: "Non-billable" },
    };

    const treeItem = createEnhancedIssueTreeItem(
      nonBillableIssue,
      mockFlexibility,
      undefined,
      "test.command"
    );

    // iconPath should use deemphasizedForeground color
    const iconPath = treeItem.iconPath as { color?: { id: string } };
    expect(iconPath?.color?.id).toBe("list.deemphasizedForeground");
  });

  it("does NOT dim billable issues (tracker === Task)", () => {
    const billableIssue: Issue = {
      ...mockIssue,
      tracker: { id: 1, name: "Task" },
    };

    const treeItem = createEnhancedIssueTreeItem(
      billableIssue,
      mockFlexibility,
      undefined,
      "test.command"
    );

    // iconPath should NOT use deemphasizedForeground color
    const iconPath = treeItem.iconPath as { color?: { id: string } };
    expect(iconPath?.color?.id).not.toBe("list.deemphasizedForeground");
  });

  it("shows blocked indicator when issue has blocked relation", () => {
    const blockedIssue: Issue = {
      ...mockIssue,
      relations: [
        {
          id: 1,
          issue_id: mockIssue.id,
          issue_to_id: 100,
          relation_type: "blocked",
        },
      ],
    };

    const treeItem = createEnhancedIssueTreeItem(
      blockedIssue,
      mockFlexibility,
      undefined,
      "test.command"
    );

    // Description should include blocked indicator
    expect(treeItem.description).toContain("🚫");
  });

  it("includes relations in tooltip", () => {
    const issueWithRelations: Issue = {
      ...mockIssue,
      relations: [
        {
          id: 1,
          issue_id: mockIssue.id,
          issue_to_id: 100,
          relation_type: "blocked",
        },
        {
          id: 2,
          issue_id: mockIssue.id,
          issue_to_id: 200,
          relation_type: "blocks",
        },
      ],
    };

    const treeItem = createEnhancedIssueTreeItem(
      issueWithRelations,
      mockFlexibility,
      undefined,
      "test.command"
    );

    const tooltipValue = (treeItem.tooltip as { value: string })?.value;
    expect(tooltipValue).toContain("Blocked by");
    expect(tooltipValue).toContain("#100");
    expect(tooltipValue).toContain("Blocks");
    expect(tooltipValue).toContain("#200");
  });
});
