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
  buildRowsPayload,
  buildArrowsPayload,
  projectDaysForHours,
  calculateDailyIntensity,
  collapseKeyAttrs,
} from "../src/webviews/gantt/gantt-html-generator";
import type { GanttRow } from "../src/webviews/gantt-model";
import type { GanttIssue } from "../src/webviews/gantt-model";
import type { WeeklySchedule } from "../src/utilities/flexibility-calculator";

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
      // Rounds to the nearest minute via canonical formatHoursAsHHMM (was a
      // local Math.ceil copy: 0.341h * 60 = 20.46min → ceil "0:21", now "0:20").
      expect(formatHoursAsTime(0.341)).toBe("0:20");
    });

    it("formatShortName formats as Firstname L.", () => {
      expect(formatShortName("Viktor Rognås")).toBe("Viktor R.");
      expect(formatShortName("John")).toBe("John");
      expect(formatShortName("Mary Jane Watson")).toBe("Mary W.");
    });

    it("collapseKeyAttrs builds the row-window identity attribute pair", () => {
      // Normal keys: both attributes rendered verbatim, no fallback applied.
      expect(collapseKeyAttrs("issue-123", "project-1")).toBe(
        'data-collapse-key="issue-123" data-parent-key="project-1"'
      );
      // Root rows: null/empty parentKey falls back to "" (collapseKey stays).
      expect(collapseKeyAttrs("project-1", null)).toBe(
        'data-collapse-key="project-1" data-parent-key=""'
      );
      expect(collapseKeyAttrs("project-1", "")).toBe(
        'data-collapse-key="project-1" data-parent-key=""'
      );
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

      const svg = generateIssueLabel(row, baseContext as any);

      expect(svg).toContain('class="issue-label');
      expect(svg).toContain('data-issue-id="123"');
      expect(svg).toContain('data-collapse-key="issue-123"');
      expect(svg).toContain("Test Issue");
      // assigneeId 1 === ctx.currentUserId 1 → tagged for the blue highlight
      expect(svg).toContain("my-issue");

      const othersRow = {
        ...row,
        issue: { ...(row.issue as object), assigneeId: 2 },
      } as GanttRow;
      expect(generateIssueLabel(othersRow, baseContext as any)).not.toContain("my-issue");
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

      const svg = generateProjectLabel(row, mockContext as any);

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

      const svg = generateIssueBar(row, mockContext as any);

      expect(svg).toContain('class="issue-bar');
      expect(svg).toContain('data-issue-id="456"');
      expect(svg).toContain('data-start-date="2025-01-10"');
      expect(svg).toContain('data-due-date="2025-01-20"');
      expect(svg).toContain("bar-main"); // solid bar
      expect(svg).toContain("drag-handle"); // resize handles
      expect(svg).not.toContain("ghost-projection"); // not overdue
    });

    it("overdue bars get a days-late badge and a ghost projection from today", () => {
      const row: GanttRow = {
        type: "issue",
        id: 457,
        label: "Late",
        depth: 0,
        collapseKey: "issue-457",
        parentKey: "",
        isVisible: true,
        isExpanded: false,
        hasChildren: false,
        issue: {
          id: 457,
          subject: "Late task",
          project: "Project",
          projectId: 1,
          parentId: null,
          start_date: "2025-01-02",
          due_date: "2025-01-10", // 5 days before ctx.today
          done_ratio: 50,
          estimated_hours: 16,
          spent_hours: 5, // 11h remaining → 2 working days
          status: "on-track",
          statusName: "In Progress",
          isClosed: false,
          isExternal: false,
          isAdHoc: false,
          assignee: null,
          assigneeId: null,
          flexibilityPercent: -100,
          relations: [],
          blocks: [],
          blockedBy: [],
        } as never,
      };
      const ctx = {
        barHeight: 22,
        barPadding: 3,
        barContentHeight: 16,
        timelineWidth: 1000,
        minDate: new Date("2025-01-01"),
        maxDate: new Date("2025-01-31"),
        today: new Date("2025-01-15"),
        viewFocus: "project" as const,
        currentUserId: null,
        schedule: { Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8, Sat: 0, Sun: 0 },
        issueScheduleMap: new Map(),
        getStatusColor: () => "blue",
        getStatusTextColor: () => "white",
        getStatusOpacity: () => 0.6,
        getStatusDescription: () => "On track",
        getInternalEstimate: () => null,
        hasPrecedence: () => false,
        isAutoUpdateEnabled: () => true,
      };

      const svg = generateIssueBar(row, ctx as never);

      expect(svg).not.toContain("d late"); // lateness lives in the tooltip
      expect(svg).not.toContain(">-100%<"); // no constant flex pill either
      expect(svg).toContain("ghost-projection"); // remaining work from today
      expect(svg).toContain("Overdue 5d"); // tooltip carries the day count
      expect(svg).not.toContain("bar-critical"); // overdue owns the signal

      // No-estimate overdue: unknowable remaining work is still LATE
      // (red border + tooltip) — it must agree with the late chip.
      const noEstimate: GanttRow = {
        ...row,
        issue: {
          ...(row.issue as object),
          estimated_hours: null,
          spent_hours: 0,
          flexibilityPercent: null,
        } as never,
      };
      const noEstSvg = generateIssueBar(noEstimate, ctx as never);
      expect(noEstSvg).toContain("bar-overdue");
      expect(noEstSvg).toContain("Overdue 5d");
      expect(noEstSvg).not.toContain("ghost-projection"); // nothing to project

      // Negative flexibility (due in the future, work doesn't fit): ghost
      // shows the spillover past the due date, no late badge.
      const negativeFlex: GanttRow = {
        ...row,
        issue: {
          ...(row.issue as object),
          due_date: "2025-01-20", // 5 days ahead of ctx.today
          done_ratio: 0,
          estimated_hours: 80, // 80h left needs 14 calendar days
          spent_hours: 0,
        } as never,
      };
      const flexSvg = generateIssueBar(negativeFlex, ctx as never);
      expect(flexSvg).toContain("ghost-projection");
      expect(flexSvg).toContain("Projected 8d past due");
      expect(flexSvg).not.toContain("d late");

      // Essentially-done task: budget consumed, done_ratio never maintained
      // (0) — must NOT read as late work even though it is past due.
      const essentiallyDone: GanttRow = {
        ...row,
        issue: {
          ...(row.issue as object),
          done_ratio: 0,
          estimated_hours: 16,
          spent_hours: 18,
        } as never,
      };
      const doneSvg = generateIssueBar(essentiallyDone, ctx as never);
      expect(doneSvg).not.toContain("d late");
      expect(doneSvg).not.toContain("ghost-projection");
      expect(doneSvg).toContain('font-style="italic"'); // ~100% time-derived
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
      const projectBar = generateIssueBar(projectRow, ctx);
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
      const timeGroupBar = generateIssueBar(timeGroupRow, ctx);
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
      expect(generateIssueBar(noDateRow, ctx as any)).toBe("");

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
      const parentBar = generateIssueBar(parentRow, ctx as any);
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
      const timeGroupSvg = generateTimeGroupLabel(timeGroupRow, baseCtx);
      expect(timeGroupSvg).toContain("time-group-label");
      expect(timeGroupSvg).toContain("(3)");

      expect(generateIdCell(baseIssueRow, baseCtx)).toContain("#10");
      expect(generateStartDateCell(baseIssueRow, baseCtx)).toContain("Jan 10");
      expect(generateStatusCell(baseIssueRow, baseCtx)).toContain("var(--vscode-charts-blue)");
      expect(generateDueDateCell(baseIssueRow, baseCtx)).toContain("due-overdue");

      const assigneeSvg = generateAssigneeCell(baseIssueRow, {
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
      expect(generateIdCell(projectRow, baseCtx)).toContain("gantt-row");
      expect(generateStartDateCell(projectRow, baseCtx)).toContain("gantt-row");

      const noDates = {
        ...baseIssueRow,
        issue: { ...baseIssueRow.issue!, start_date: null, due_date: null, assignee: null, isClosed: true, done_ratio: 100 },
      };
      expect(generateStartDateCell(noDates, baseCtx)).toContain("—");
      expect(generateDueDateCell(noDates, { ...baseCtx, today: new Date("2025-01-01") })).toContain("—");
      expect(generateStatusCell(noDates, baseCtx)).toContain("var(--vscode-charts-green)");
      expect(generateAssigneeCell(noDates, baseCtx)).toContain("—");
    });
  });

  describe("ghost projection day walk", () => {
    // ctx.today is UTC-midnight anchored and stepped in UTC days — the
    // weekday lookup must read the SAME frame. Local getDay() shifted
    // every weekday back one day for hosts west of UTC.
    const wedOnly = { Sun: 0, Mon: 0, Tue: 0, Wed: 8, Thu: 0, Fri: 0, Sat: 0 };

    it("counts schedule days in the UTC frame", () => {
      const wednesday = new Date("2026-06-10"); // UTC Wednesday
      expect(projectDaysForHours(wednesday, 8, wedOnly)).toBe(1);
      expect(projectDaysForHours(wednesday, 16, wedOnly)).toBe(8); // next Wed
    });

    it("caps an unschedulable walk at maxDays", () => {
      const empty = { Sun: 0, Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0 };
      expect(projectDaysForHours(new Date("2026-06-10"), 8, empty, 30)).toBe(30);
    });
  });

  describe("calculateDailyIntensity day walk", () => {
    // Dates are parsed as local midnight and the weekday is read with local
    // getDay(), so the day walk must step in the local frame too. UTC stepping
    // dropped/shifted a day for bars spanning a DST transition: a Fri→Mon span
    // crossing the EU spring-forward (2026-03-29) lost its final Monday.
    const monFri8h: WeeklySchedule = { Sun: 0, Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8, Sat: 0 };

    const makeIssue = (start: string, due: string): GanttIssue => ({
      id: 10, subject: "I", project: "P", projectId: 1, parentId: null,
      start_date: start, due_date: due, done_ratio: 0, estimated_hours: 40,
      spent_hours: 0, status: "new", statusName: "New", isClosed: false,
      isExternal: false, isAdHoc: false, assignee: null, assigneeId: null,
      flexibilityPercent: null, relations: [], blocks: [], blockedBy: [],
    });

    it("aligns each day to its local weekday across a DST-crossing span", () => {
      // Fri 2026-03-27 .. Mon 2026-03-30 spans the EU spring-forward.
      const result = calculateDailyIntensity(makeIssue("2026-03-27", "2026-03-30"), monFri8h);
      // One segment per calendar day, inclusive — the final Monday must survive.
      expect(result.map((d) => d.dayOffset)).toEqual([0, 1, 2, 3]);
      // Sat/Sun (offsets 1,2) are off-schedule → 0; Fri/Mon are working days → > 0.
      expect(result[0]!.intensity).toBeGreaterThan(0); // Fri
      expect(result[1]!.intensity).toBe(0); // Sat
      expect(result[2]!.intensity).toBe(0); // Sun
      expect(result[3]!.intensity).toBeGreaterThan(0); // Mon
    });
  });

  describe("payload assembly", () => {
    const ctx = {
      barHeight: 22,
      barPadding: 3,
      barContentHeight: 16,
      indentSize: 8,
      chevronWidth: 10,
      timelineWidth: 1000,
      minDate: new Date("2025-01-01"),
      maxDate: new Date("2025-01-31"),
      today: new Date("2025-01-15"),
      viewFocus: "project" as const,
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
      buildProjectTooltip: () => "Project tooltip",
    } as any;

    const issueRow: GanttRow = {
      type: "issue",
      id: 456,
      label: "Bar Test",
      depth: 1,
      collapseKey: "issue-456",
      parentKey: "project-1",
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
        relations: [
          { id: 9, targetId: 99, type: "blocks" },
          { id: 10, targetId: 88, type: "relates" },
        ],
        blocks: [],
        blockedBy: [],
      } as any,
    };

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
    };

    it("buildRowsPayload maps rows to y=0 fragments with meta", () => {
      const payload = buildRowsPayload([projectRow, issueRow], ctx);
      expect(payload).toHaveLength(2);
      expect(payload[1]).toMatchObject({
        key: "issue-456",
        parentKey: "project-1",
        type: "issue",
        issueId: 456,
        startDate: "2025-01-10",
        dueDate: "2025-01-20",
      });
      expect(typeof payload[1]!.barStartX).toBe("number");
      expect(typeof payload[1]!.barEndX).toBe("number");
      for (const p of ["status", "id", "labels", "start", "due", "assignee", "timeline"] as const) {
        expect(typeof payload[1]!.panels[p], p).toBe("string");
      }
      // Non-issue rows carry no bar geometry or dates
      expect(payload[0]).toMatchObject({
        key: "project-1",
        issueId: null,
        barStartX: null,
        startDate: null,
      });
      // Fragments are position-independent: no baked transform
      expect(payload[1]!.panels.labels).not.toContain("translate(");
    });

    it("buildRowsPayload extends open-ended bars to maxDate like the render", () => {
      const openEnded: GanttRow = {
        ...issueRow,
        issue: { ...(issueRow.issue as object), due_date: null } as never,
      };
      const closedAtMax: GanttRow = {
        ...issueRow,
        issue: { ...(issueRow.issue as object), due_date: "2025-01-31" } as never,
      };

      const [open, closed] = buildRowsPayload([openEnded, closedAtMax], ctx);
      // Open-ended bars render to the timeline's right edge — payload
      // geometry must match or arrows jump when the row mounts.
      expect(open!.barEndX).toBe(closed!.barEndX);
      expect(open!.barEndX!).toBeGreaterThan(open!.barStartX!);
    });

    it("buildArrowsPayload filters by visible relation types", () => {
      const arrows = buildArrowsPayload([projectRow, issueRow], new Set(["blocks"]));
      expect(arrows).toEqual([{ relationId: 9, fromId: 456, toId: 99, type: "blocks", risk: false }]);

      // risk rides the panel's unified lateness set
      const risky = buildArrowsPayload([projectRow, issueRow], new Set(["blocks"]), new Set([456]));
      expect(risky[0]!.risk).toBe(true);
    });
  });

});
