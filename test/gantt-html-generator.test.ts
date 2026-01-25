import { describe, it, expect } from "vitest";
import {
  getInitials,
  getAvatarColorIndices,
  formatHoursAsTime,
  formatShortName,
  generateIssueLabel,
  generateProjectLabel,
  generateIdCell,
  generateIssueBar,
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
      expect(svg).toContain("4 open");
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
  });
});
