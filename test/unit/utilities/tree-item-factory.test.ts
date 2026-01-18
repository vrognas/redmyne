import { describe, it, expect } from "vitest";
import {
  createIssueTreeItem,
  createEnhancedIssueTreeItem,
  createProjectTooltip,
} from "../../../src/utilities/tree-item-factory";
import { Issue } from "../../../src/redmine/models/issue";
import { RedmineProject } from "../../../src/redmine/redmine-project";
import { FlexibilityScore } from "../../../src/utilities/flexibility-calculator";

describe("createIssueTreeItem", () => {
  const mockIssue: Issue = {
    id: 7392,
    subject: "Test Issue 1234",
    tracker: { id: 1, name: "Tasks" },
    status: { id: 1, name: "Not Yet Started", is_closed: false },
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
    status: { id: 1, name: "In Progress", is_closed: false },
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

  it("uses minimal circle icon for open issues", () => {
    const treeItem = createEnhancedIssueTreeItem(
      mockIssue,
      mockFlexibility,
      undefined,
      "test.command"
    );

    // Minimal icons: open issues get neutral dot
    expect(treeItem.iconPath).toBeDefined();
    const iconPath = treeItem.iconPath as { id: string; color?: { id: string } };
    expect(iconPath.id).toBe("circle-filled");
    expect(iconPath.color?.id).toBe("list.deemphasizedForeground");
  });

  it("uses grayed pass icon for closed issues", () => {
    const closedIssue: Issue = {
      ...mockIssue,
      status: { id: 5, name: "Closed", is_closed: true },
    };

    const treeItem = createEnhancedIssueTreeItem(
      closedIssue,
      mockFlexibility,
      undefined,
      "test.command"
    );

    const iconPath = treeItem.iconPath as { id: string; color?: { id: string } };
    expect(iconPath.id).toBe("pass");
    expect(iconPath.color?.id).toBe("list.deemphasizedForeground");
  });

  it("description does not contain status text", () => {
    const treeItem = createEnhancedIssueTreeItem(
      mockIssue,
      mockFlexibility,
      undefined,
      "test.command"
    );

    // Description should NOT contain status text
    expect(treeItem.description).not.toContain("On Track");
    expect(treeItem.description).not.toContain("Overbooked");
    expect(treeItem.description).not.toContain("Done");
    expect(treeItem.description).not.toContain("At Risk");
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

  it("includes tracker name in compact metadata line", () => {
    const treeItem = createEnhancedIssueTreeItem(
      mockIssue,
      mockFlexibility,
      undefined,
      "test.command"
    );

    // tooltip has compact metadata line: "Tracker · Priority · Status"
    const tooltipValue = (treeItem.tooltip as { value: string })?.value;
    expect(tooltipValue).toContain("Tasks · Normal"); // tracker · priority
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

  it("uses same minimal icon regardless of tracker", () => {
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

    // Minimal icons: all open issues use same neutral icon
    const iconPath = treeItem.iconPath as { id: string; color?: { id: string } };
    expect(iconPath.id).toBe("circle-filled");
    expect(iconPath?.color?.id).toBe("list.deemphasizedForeground");
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

  it("includes non-empty custom fields in tooltip", () => {
    const issueWithCustomFields: Issue = {
      ...mockIssue,
      custom_fields: [
        { id: 1, name: "Client", value: "Acme Corp" },
        { id: 2, name: "Department", value: "Engineering" },
      ],
    };

    const treeItem = createEnhancedIssueTreeItem(
      issueWithCustomFields,
      mockFlexibility,
      undefined,
      "test.command"
    );

    const tooltipValue = (treeItem.tooltip as { value: string })?.value;
    expect(tooltipValue).toContain("**Client:** Acme Corp");
    expect(tooltipValue).toContain("**Department:** Engineering");
  });

  it("excludes empty and zero custom fields from tooltip", () => {
    const issueWithEmptyFields: Issue = {
      ...mockIssue,
      custom_fields: [
        { id: 1, name: "Client", value: "Acme Corp" },
        { id: 2, name: "Empty", value: "" },
        { id: 3, name: "Null", value: null },
        { id: 4, name: "Zero", value: "0" },
        { id: 5, name: "ZeroFloat", value: 0 },
      ],
    };

    const treeItem = createEnhancedIssueTreeItem(
      issueWithEmptyFields,
      mockFlexibility,
      undefined,
      "test.command"
    );

    const tooltipValue = (treeItem.tooltip as { value: string })?.value;
    expect(tooltipValue).toContain("**Client:** Acme Corp");
    expect(tooltipValue).not.toContain("**Empty:**");
    expect(tooltipValue).not.toContain("**Null:**");
    expect(tooltipValue).not.toContain("**Zero:**");
    expect(tooltipValue).not.toContain("**ZeroFloat:**");
  });

  it("handles array custom field values in tooltip", () => {
    const issueWithArrayField: Issue = {
      ...mockIssue,
      custom_fields: [
        { id: 1, name: "Tags", multiple: true, value: ["urgent", "frontend"] },
      ],
    };

    const treeItem = createEnhancedIssueTreeItem(
      issueWithArrayField,
      mockFlexibility,
      undefined,
      "test.command"
    );

    const tooltipValue = (treeItem.tooltip as { value: string })?.value;
    expect(tooltipValue).toContain("**Tags:** urgent, frontend");
  });

  it("includes custom fields in basic tooltip (no flexibility)", () => {
    const issueWithCustomFields: Issue = {
      ...mockIssue,
      custom_fields: [
        { id: 1, name: "Priority Level", value: "High" },
      ],
    };

    const treeItem = createEnhancedIssueTreeItem(
      issueWithCustomFields,
      null,
      undefined,
      "test.command"
    );

    const tooltipValue = (treeItem.tooltip as { value: string })?.value;
    expect(tooltipValue).toContain("**Priority Level:** High");
  });
});

describe("createProjectTooltip", () => {
  it("includes project ID and name in bold", () => {
    const project = new RedmineProject({
      id: 1,
      name: "Test Project",
      description: "",
      identifier: "test-project",
    });

    const tooltip = createProjectTooltip(project, undefined);
    expect(tooltip.value).toContain("**#1 Test Project**");
  });

  it("includes description when present", () => {
    const project = new RedmineProject({
      id: 1,
      name: "Test Project",
      description: "Project description here",
      identifier: "test-project",
    });

    const tooltip = createProjectTooltip(project, undefined);
    expect(tooltip.value).toContain("Project description here");
  });

  it("includes non-empty custom fields", () => {
    const project = new RedmineProject({
      id: 1,
      name: "Test Project",
      description: "",
      identifier: "test-project",
      custom_fields: [
        { id: 1, name: "Drug", value: "Aspirin" },
        { id: 2, name: "Indication", value: "Pain relief" },
      ],
    });

    const tooltip = createProjectTooltip(project, undefined);
    expect(tooltip.value).toContain("**Drug:** Aspirin");
    expect(tooltip.value).toContain("**Indication:** Pain relief");
  });

  it("excludes empty custom fields", () => {
    const project = new RedmineProject({
      id: 1,
      name: "Test Project",
      description: "",
      identifier: "test-project",
      custom_fields: [
        { id: 1, name: "Drug", value: "Aspirin" },
        { id: 2, name: "Empty", value: "" },
        { id: 3, name: "Null", value: null },
      ],
    });

    const tooltip = createProjectTooltip(project, undefined);
    expect(tooltip.value).toContain("**Drug:** Aspirin");
    expect(tooltip.value).not.toContain("**Empty:**");
    expect(tooltip.value).not.toContain("**Null:**");
  });

  it("handles array custom field values", () => {
    const project = new RedmineProject({
      id: 1,
      name: "Test Project",
      description: "",
      identifier: "test-project",
      custom_fields: [
        { id: 1, name: "Roles", multiple: true, value: ["Lead", "Analyst"] },
      ],
    });

    const tooltip = createProjectTooltip(project, undefined);
    expect(tooltip.value).toContain("**Roles:** Lead, Analyst");
  });

  it("includes browser link with project identifier", () => {
    const project = new RedmineProject({
      id: 1,
      name: "Test Project",
      description: "",
      identifier: "test-project",
    });

    const server = { options: { address: "https://redmine.example.com" } };
    const tooltip = createProjectTooltip(project, server as never);
    expect(tooltip.value).toContain("[Open in Browser](https://redmine.example.com/projects/test-project)");
  });

  it("works without custom fields", () => {
    const project = new RedmineProject({
      id: 42,
      name: "Test Project",
      description: "",
      identifier: "test-project",
    });

    const tooltip = createProjectTooltip(project, undefined);
    expect(tooltip.value).toContain("**#42 Test Project**");
  });
});
