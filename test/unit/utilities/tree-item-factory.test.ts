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
      "redmyne.openActionsForIssue"
    );

    expect(treeItem.command?.command).toBe("redmyne.openActionsForIssue");
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
    description: "",
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

  // New format tests: label has ID+subject, description has hours+days only
  it("includes issue ID and subject in label", () => {
    const treeItem = createEnhancedIssueTreeItem(
      mockIssue,
      mockFlexibility,
      undefined,
      "test.command"
    );

    expect(treeItem.label).toBe("#7392 Test Issue");
  });

  it("shows hours and days in description without status text", () => {
    const treeItem = createEnhancedIssueTreeItem(
      mockIssue,
      mockFlexibility,
      undefined,
      "test.command"
    );

    // Description should have hours/estimate and days, but NO status text
    expect(treeItem.description).toContain("20:00/40:00");
    expect(treeItem.description).toContain("10d");
    expect(treeItem.description).not.toContain("On Track");
    expect(treeItem.description).not.toContain("Overbooked");
    expect(treeItem.description).not.toContain("Done");
    expect(treeItem.description).not.toContain("At Risk");
  });

  it("uses icon to convey status (not description text)", () => {
    const treeItem = createEnhancedIssueTreeItem(
      mockIssue,
      mockFlexibility,
      undefined,
      "test.command"
    );

    // Icon should be defined and colored for status
    expect(treeItem.iconPath).toBeDefined();
    const iconPath = treeItem.iconPath as { id: string; color?: { id: string } };
    expect(iconPath.id).toBe("git-pull-request-draft"); // on-track icon
  });

  it("uses error icon for overbooked status", () => {
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

    const iconPath = treeItem.iconPath as { id: string; color?: { id: string } };
    expect(iconPath.id).toBe("error");
    // Description should NOT contain status text
    expect(treeItem.description).not.toContain("Overbooked");
  });

  it("uses pass icon for completed status", () => {
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

    const iconPath = treeItem.iconPath as { id: string; color?: { id: string } };
    expect(iconPath.id).toBe("pass");
    // Description should NOT contain status text
    expect(treeItem.description).not.toContain("Done");
  });

  it("falls back to hours display when no flexibility", () => {
    const treeItem = createEnhancedIssueTreeItem(
      mockIssue,
      null,
      undefined,
      "test.command"
    );

    // Without flexibility, show hours (no days since we don't know)
    expect(treeItem.description).toBe("20:00/40:00");
    // Label still has ID + subject
    expect(treeItem.label).toBe("#7392 Test Issue");
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

  it("does not show billable prefix in description (moved to tooltip)", () => {
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

    // Non-billable indicator NOT in description (reduces density)
    expect(treeItem.description).not.toContain("○");
    // Tracker info is in tooltip
    const tooltipValue = (treeItem.tooltip as { value: string })?.value;
    expect(tooltipValue).toContain("Non-billable");
  });

  it("uses status color for icon regardless of billability", () => {
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

    // iconPath should use status color
    const iconPath = treeItem.iconPath as { color?: { id: string } };
    expect(iconPath?.color?.id).toBe("testing.iconPassed");
  });

  it("shows blocked info in tooltip not description", () => {
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

    // Blocked indicator NOT in description (reduces density)
    expect(treeItem.description).not.toContain("[B]");
    // Blocked info IS in tooltip
    const tooltipValue = (treeItem.tooltip as { value: string })?.value;
    expect(tooltipValue).toContain("Blocked by");
    expect(tooltipValue).toContain("#100");
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
