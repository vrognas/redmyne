import { describe, it, expect } from "vitest";
import {
  getInitials,
  getAvatarColorIndices,
  formatHoursAsTime,
  formatShortName,
  generateIssueLabel,
  generateProjectLabel,
  generateTimeGroupLabel,
  generateIdCell,
  generateStartDateCell,
  generateStatusCell,
  generateDueDateCell,
  generateAssigneeCell,
  generateIssueBar,
  generateZebraStripes,
  generateIndentGuides,
} from "../src/webviews/gantt/gantt-html-generator";
import type { GanttRow } from "../src/webviews/gantt-model";

describe("gantt-html-generator", () => {
  describe("helper functions", () => {
    it("getInitials extracts initials from names", () => {
      expect(getInitials("Viktor Rognås")).toBe("VR");
      expect(getInitials("John")).toBe("JO");
      expect(getInitials("Mary Jane Watson")).toBe("MW");
      expect(getInitials("  Alice   Bob  ")).toBe("AB");
    });

    it("getAvatarColorIndices returns consistent colors for same name", () => {
      const colors1 = getAvatarColorIndices("Viktor");
      const colors2 = getAvatarColorIndices("Viktor");
      expect(colors1).toEqual(colors2);

      // Different names should (usually) get different colors
      const colors3 = getAvatarColorIndices("Alice");
      expect(colors3.fill !== colors1.fill || colors3.stroke !== colors1.stroke).toBe(true);
    });

    it("formatHoursAsTime formats decimal hours as HH:MM", () => {
      expect(formatHoursAsTime(null)).toBe("—");
      expect(formatHoursAsTime(0)).toBe("0:00");
      expect(formatHoursAsTime(1.5)).toBe("1:30");
      expect(formatHoursAsTime(8)).toBe("8:00");
      expect(formatHoursAsTime(0.25)).toBe("0:15");
    });

    it("formatShortName formats as Firstname L.", () => {
      expect(formatShortName("Viktor Rognås")).toBe("Viktor R.");
      expect(formatShortName("John")).toBe("John");
      expect(formatShortName("Mary Jane Watson")).toBe("Mary W.");
    });
  });

  describe("label generation", () => {
    const baseContext = {
      barHeight: 22,
      indentSize: 8,
      chevronWidth: 10,
      currentUserId: 1,
      viewFocus: "project" as const,
      getStatusDescription: () => "On track",
    };

    it("generateIssueLabel creates issue row SVG", () => {
      const row: GanttRow = {
        type: "issue",
        id: 123,
        label: "Test Issue",
        depth: 1,
        collapseKey: "issue-123",
        parentKey: "project-1",
        isVisible: true,
        isExpanded: false,
        hasChildren: false,
        issue: {
          id: 123,
          subject: "Test Issue",
          project: "Test Project",
          projectId: 1,
          parentId: null,
          start_date: "2025-01-01",
          due_date: "2025-01-15",
          done_ratio: 50,
          estimated_hours: 8,
          spent_hours: 4,
          status: "on-track",
          statusName: "In Progress",
          isClosed: false,
          isExternal: false,
          isAdHoc: false,
          assignee: "Viktor",
          assigneeId: 1,
          flexibilityPercent: 25,
          relations: [],
          blocks: [],
          blockedBy: [],
        },
      };

      const svg = generateIssueLabel(row, 0, 0, 0, baseContext as any);

      expect(svg).toContain('class="issue-label');
      expect(svg).toContain('data-issue-id="123"');
      expect(svg).toContain('data-collapse-key="issue-123"');
      expect(svg).toContain("Test Issue");
    });

    it("generateProjectLabel creates project header SVG", () => {
      const row: GanttRow = {
        type: "project",
        id: 1,
        label: "Test Project",
        depth: 0,
        collapseKey: "project-1",
        parentKey: "",
        isVisible: true,
        isExpanded: true,
        hasChildren: true,
        health: {
          status: "on-track",
          progress: 60,
          counts: { total: 10, open: 4, blocked: 1, overdue: 0 },
        },
      };

      const mockContext = {
        ...baseContext,
        getHealthDot: () => '<tspan fill="green">●</tspan>',
        buildProjectTooltip: () => "Project tooltip",
      };

      const svg = generateProjectLabel(row, 0, 0, 0, mockContext as any);

      expect(svg).toContain('class="project-label');
      expect(svg).toContain('data-project-id="1"');
      expect(svg).toContain("Test Project");
      // Project label shows only name (no health dot, progress, or counts)
      expect(svg).not.toContain("4 open");
      expect(svg).not.toContain("●");
    });
  });

  describe("bar generation", () => {
    it("generateIssueBar creates timeline bar with correct positioning", () => {
      const row: GanttRow = {
        type: "issue",
        id: 456,
        label: "Bar Test",
        depth: 0,
        collapseKey: "issue-456",
        parentKey: "",
        isVisible: true,
        isExpanded: false,
        hasChildren: false,
        issue: {
          id: 456,
          subject: "Bar Test",
          project: "Project",
          projectId: 1,
          parentId: null,
          start_date: "2025-01-10",
          due_date: "2025-01-20",
          done_ratio: 30,
          estimated_hours: 16,
          spent_hours: 5,
          status: "on-track",
          statusName: "In Progress",
          isClosed: false,
          isExternal: false,
          isAdHoc: false,
          assignee: null,
          assigneeId: null,
          flexibilityPercent: 10,
          relations: [],
          blocks: [],
          blockedBy: [],
        },
      };

      const mockContext = {
        barHeight: 22,
        barPadding: 3,
        barContentHeight: 16,
        timelineWidth: 1000,
        minDate: new Date("2025-01-01"),
        maxDate: new Date("2025-01-31"),
        today: new Date("2025-01-15"),
        viewFocus: "project" as const,
        showIntensity: false,
        currentUserId: null,
        schedule: { Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8, Sat: 0, Sun: 0 },
        issueScheduleMap: new Map(),
        getStatusColor: () => "var(--vscode-charts-blue)",
        getStatusTextColor: () => "white",
        getStatusOpacity: () => 0.6,
        getStatusDescription: () => "On track",
        getInternalEstimate: () => null,
        hasPrecedence: () => false,
        isAutoUpdateEnabled: () => true,
      };

      const svg = generateIssueBar(row, 0, 0, 0, mockContext as any);

      expect(svg).toContain('class="issue-bar');
      expect(svg).toContain('data-issue-id="456"');
      expect(svg).toContain('data-start-date="2025-01-10"');
      expect(svg).toContain('data-due-date="2025-01-20"');
      expect(svg).toContain("bar-main"); // solid bar
      expect(svg).toContain("drag-handle"); // resize handles
    });

    it("generateIssueBar handles project and time-group aggregate bars", () => {
      const ctx = {
        barHeight: 22,
        barPadding: 3,
        barContentHeight: 16,
        timelineWidth: 500,
        minDate: new Date("2025-01-01"),
        maxDate: new Date("2025-01-31"),
        today: new Date("2025-01-15"),
        buildProjectTooltip: () => "Project tooltip",
      } as any;

      const projectRow: GanttRow = {
        type: "project",
        id: 1,
        label: "Proj",
        depth: 0,
        collapseKey: "project-1",
        parentKey: "",
        isVisible: true,
        isExpanded: true,
        hasChildren: true,
        childDateRanges: [{ startDate: "2025-01-05", dueDate: "2025-01-10" }],
      };
      const projectBar = generateIssueBar(projectRow, 0, 0, 0, ctx);
      expect(projectBar).toContain("aggregate-bars");
      expect(projectBar).toContain("data-project-id=\"1\"");

      const timeGroupRow: GanttRow = {
        type: "time-group",
        id: 2,
        label: "Overdue",
        depth: 0,
        collapseKey: "group-overdue",
        parentKey: "",
        isVisible: true,
        isExpanded: true,
        hasChildren: true,
        timeGroup: "overdue",
        childDateRanges: [{ startDate: "2025-01-08", dueDate: "2025-01-09" }],
      };
      const timeGroupBar = generateIssueBar(timeGroupRow, 0, 0, 0, ctx);
      expect(timeGroupBar).toContain("time-group-bars");
      expect(timeGroupBar).toContain("var(--vscode-charts-red)");
    });

    it("generateIssueBar handles parent issue and no-date guards", () => {
      const ctx = {
        barHeight: 22,
        barPadding: 3,
        barContentHeight: 16,
        timelineWidth: 1000,
        minDate: new Date("2025-01-01"),
        maxDate: new Date("2025-01-31"),
        today: new Date("2025-01-15"),
        viewFocus: "project" as const,
        showIntensity: false,
        currentUserId: null,
        schedule: { Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8, Sat: 0, Sun: 0 },
        issueScheduleMap: new Map(),
        getStatusColor: () => "blue",
        getStatusTextColor: () => "white",
        getStatusOpacity: () => 0.6,
        getStatusDescription: () => "Status",
        getInternalEstimate: () => null,
        hasPrecedence: () => false,
        isAutoUpdateEnabled: () => true,
        contributionSources: new Map(),
        donationTargets: new Map(),
      };

      const noDateRow: GanttRow = {
        type: "issue",
        id: 3,
        label: "No date",
        depth: 0,
        collapseKey: "issue-3",
        parentKey: "",
        isVisible: true,
        isExpanded: false,
        hasChildren: false,
        issue: {
          id: 3,
          subject: "No date",
          project: "P",
          projectId: 1,
          parentId: null,
          start_date: null,
          due_date: null,
          done_ratio: 0,
          estimated_hours: 2,
          spent_hours: 0,
          status: "new",
          statusName: "New",
          isClosed: false,
          isExternal: false,
          isAdHoc: false,
          assignee: null,
          assigneeId: null,
          flexibilityPercent: null,
          relations: [],
          blocks: [],
          blockedBy: [],
        },
      };
      expect(generateIssueBar(noDateRow, 0, 0, 0, ctx as any)).toBe("");

      const parentRow: GanttRow = {
        ...noDateRow,
        id: 4,
        collapseKey: "issue-4",
        issue: {
          ...noDateRow.issue!,
          id: 4,
          subject: "Parent",
          start_date: "2025-01-05",
          due_date: "2025-01-20",
          done_ratio: 40,
        },
        isParent: true,
      };
      const parentBar = generateIssueBar(parentRow, 0, 0, 0, ctx as any);
      expect(parentBar).toContain("parent-bar");
      expect(parentBar).toContain("40%");
    });
  });

  describe("column and group generation", () => {
    const baseCtx = {
      barHeight: 22,
      indentSize: 8,
      chevronWidth: 10,
      idColumnWidth: 60,
      statusColumnWidth: 70,
      dueDateColumnWidth: 90,
      assigneeColumnWidth: 100,
      today: new Date("2025-01-15"),
    } as any;

    const baseIssueRow: GanttRow = {
      type: "issue",
      id: 10,
      label: "Issue",
      depth: 0,
      collapseKey: "issue-10",
      parentKey: "",
      isVisible: true,
      isExpanded: false,
      hasChildren: false,
      issue: {
        id: 10,
        subject: "Issue",
        project: "P",
        projectId: 1,
        parentId: null,
        start_date: "2025-01-10",
        due_date: "2025-01-14",
        done_ratio: 25,
        estimated_hours: 8,
        spent_hours: 1,
        status: "new",
        statusName: "New",
        isClosed: false,
        isExternal: false,
        isAdHoc: false,
        assignee: "Alice Cooper",
        assigneeId: 5,
        flexibilityPercent: 10,
        relations: [],
        blocks: [],
        blockedBy: [],
      },
    };

    it("renders time-group label and id/start/status/due/assignee cells", () => {
      const timeGroupRow: GanttRow = {
        type: "time-group",
        id: 1,
        label: "This Week",
        depth: 1,
        collapseKey: "group-week",
        parentKey: "",
        isVisible: true,
        isExpanded: true,
        hasChildren: true,
        timeGroup: "this-week",
        icon: "🗓️",
        childCount: 3,
      };
      const timeGroupSvg = generateTimeGroupLabel(timeGroupRow, 0, 0, 0, baseCtx);
      expect(timeGroupSvg).toContain("time-group-label");
      expect(timeGroupSvg).toContain("(3)");

      expect(generateIdCell(baseIssueRow, 0, 0, baseCtx)).toContain("#10");
      expect(generateStartDateCell(baseIssueRow, 0, 0, baseCtx)).toContain("Jan 10");
      expect(generateStatusCell(baseIssueRow, 0, 0, baseCtx)).toContain("var(--vscode-charts-blue)");
      expect(generateDueDateCell(baseIssueRow, 0, 0, baseCtx)).toContain("due-overdue");

      const assigneeSvg = generateAssigneeCell(baseIssueRow, 0, 0, {
        ...baseCtx,
        currentUserId: 5,
      });
      expect(assigneeSvg).toContain("current-user");
      expect(assigneeSvg).toContain("AC");
    });

    it("renders non-issue placeholders and empty-value variants", () => {
      const projectRow: GanttRow = {
        type: "project",
        id: 2,
        label: "Project",
        depth: 0,
        collapseKey: "project-2",
        parentKey: "",
        isVisible: false,
        isExpanded: false,
        hasChildren: false,
      };
      expect(generateIdCell(projectRow, 0, 0, baseCtx)).toContain("gantt-row");
      expect(generateStartDateCell(projectRow, 0, 0, baseCtx)).toContain("gantt-row");

      const noDates = {
        ...baseIssueRow,
        issue: { ...baseIssueRow.issue!, start_date: null, due_date: null, assignee: null, isClosed: true, done_ratio: 100 },
      };
      expect(generateStartDateCell(noDates, 0, 0, baseCtx)).toContain("—");
      expect(generateDueDateCell(noDates, 0, 0, { ...baseCtx, today: new Date("2025-01-01") })).toContain("—");
      expect(generateStatusCell(noDates, 0, 0, baseCtx)).toContain("var(--vscode-charts-green)");
      expect(generateAssigneeCell(noDates, 0, 0, baseCtx)).toContain("—");
    });
  });

  describe("zebra and indent layers", () => {
    it("generates zebra stripes and indent guides", () => {
      const rows: GanttRow[] = [
        { type: "project", id: 1, label: "P", depth: 0, collapseKey: "p1", parentKey: "", isVisible: true, isExpanded: true, hasChildren: true },
        { type: "issue", id: 2, label: "C1", depth: 1, collapseKey: "c1", parentKey: "p1", isVisible: true, isExpanded: false, hasChildren: false, issue: {} as any },
        { type: "issue", id: 3, label: "C2", depth: 1, collapseKey: "c2", parentKey: "p1", isVisible: true, isExpanded: false, hasChildren: false, issue: {} as any },
      ];
      const stripes = generateZebraStripes(
        [{ startIdx: 0, endIdx: 2, groupIdx: 0 }],
        rows,
        [0, 24, 48],
        [22, 22, 22]
      );
      expect(stripes).toContain("zebra-stripe");
      expect(stripes).toContain("data-row-contributions");

      const guides = generateIndentGuides(rows, [0, 24, 48], 22, 8);
      expect(guides).toContain("indent-guides-layer");
      expect(guides).toContain("data-for-parent=\"p1\"");
    });

    it("returns empty indent layer when no expandable hierarchy exists", () => {
      const rows: GanttRow[] = [
        { type: "issue", id: 1, label: "A", depth: 0, collapseKey: "a", parentKey: "", isVisible: true, isExpanded: false, hasChildren: false, issue: {} as any },
      ];
      expect(generateIndentGuides(rows, [0], 22, 8)).toBe("");
    });
  });
});
