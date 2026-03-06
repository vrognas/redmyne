import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { GanttPanel } from "../../../src/webviews/gantt-panel";
import { TimeSheetPanel } from "../../../src/webviews/timesheet-panel";
import {
  buildWeekInfo,
  OTHERS_PARENT_ID,
  TimeSheetRow,
  WeekInfo,
} from "../../../src/webviews/timesheet-webview-messages";
import { TimeEntry } from "../../../src/redmine/models/time-entry";
import { getLocalToday } from "../../../src/utilities/date-utils";
import { WeeklySchedule } from "../../../src/utilities/flexibility-calculator";

type MessageHandler = (message: unknown) => void;

interface MockWebviewPanelBundle {
  panel: vscode.WebviewPanel;
  webview: {
    html: string;
    cspSource: string;
    postMessage: ReturnType<typeof vi.fn>;
    asWebviewUri: ReturnType<typeof vi.fn>;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
  };
}

function createDraftModeManager(
  enabled: boolean
): import("../../../src/draft-mode/draft-mode-manager").DraftModeManager {
  return {
    isEnabled: enabled,
    onDidChangeEnabled: vi.fn(() => ({ dispose: vi.fn() })),
  } as unknown as import("../../../src/draft-mode/draft-mode-manager").DraftModeManager;
}

function createMockPanel(): MockWebviewPanelBundle {
  let _messageHandler: MessageHandler | undefined;

  const webview = {
    html: "",
    cspSource: "vscode-resource:",
    postMessage: vi.fn().mockResolvedValue(true),
    asWebviewUri: vi.fn((uri: unknown) => String(uri)),
    onDidReceiveMessage: vi.fn(
      (handler: MessageHandler, _thisArg?: unknown, disposables?: Array<{ dispose: () => void }>) => {
        _messageHandler = handler;
        const disposable = { dispose: vi.fn() };
        if (Array.isArray(disposables)) disposables.push(disposable);
        return disposable;
      }
    ),
  };

  const panel = {
    webview,
    visible: true,
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidDispose: vi.fn(
      (_handler: () => void, _thisArg?: unknown, disposables?: Array<{ dispose: () => void }>) => {
        const disposable = { dispose: vi.fn() };
        if (Array.isArray(disposables)) disposables.push(disposable);
        return disposable;
      }
    ),
    onDidChangeViewState: vi.fn(
      (_handler: () => void, _thisArg?: unknown, disposables?: Array<{ dispose: () => void }>) => {
        const disposable = { dispose: vi.fn() };
        if (Array.isArray(disposables)) disposables.push(disposable);
        return disposable;
      }
    ),
  } as unknown as vscode.WebviewPanel;

  return { panel, webview };
}

function createContext(): vscode.ExtensionContext {
  return {
    globalState: {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as vscode.ExtensionContext;
}

interface GanttInternals {
  _getBaseHtml: () => string;
  _getEmptyPayload: () => { html: string; state: { timelineWidth: number; stickyLeftWidth: number } };
  _generateDateMarkers: (
    minDate: Date,
    maxDate: Date,
    svgWidth: number,
    leftMargin: number,
    zoomLevel?: "day" | "week" | "month" | "quarter" | "year"
  ) => { header: string; body: string; todayMarker: string };
  _getStatusColor: (status: string | null) => string;
  _getStatusTextColor: (status: string | null) => string;
  _getStatusOpacity: (status: string | null) => number;
  _getStatusDescription: (status: string | null) => string;
}

interface TimesheetInternals {
  _getHtml: () => string;
  _entriesToRows: (entries: TimeEntry[], week: WeekInfo) => TimeSheetRow[];
  _createEmptyRow: () => TimeSheetRow;
  _calculateTotals: () => {
    days: number[];
    weekTotal: number;
    targetHours: number[];
    weekTargetTotal: number;
  };
  _getFieldValue: (
    row: TimeSheetRow,
    field: "parentProject" | "project" | "issue" | "activity" | "comments"
  ) => number | string | null;
  _getDraftModeManagerFn?: () => import("../../../src/draft-mode/draft-mode-manager").DraftModeManager | undefined;
  _projects: Array<{ id: number; name: string; identifier: string; path: string; parentId: number | null }>;
  _parentProjects: Array<{ id: number; name: string; identifier: string; path: string; parentId: number | null }>;
  _rows: TimeSheetRow[];
  _schedule: WeeklySchedule;
}

describe("webview panel internal methods", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    GanttPanel.currentPanel = undefined;
    TimeSheetPanel.currentPanel = undefined;

    vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(
      () =>
        ({
          get: vi.fn((_key: string, fallback?: unknown) => fallback),
          update: vi.fn(),
        }) as unknown as vscode.WorkspaceConfiguration
    );

    (vscode.Uri as unknown as { joinPath: (...parts: unknown[]) => string }).joinPath = vi.fn(
      (...parts: unknown[]) => parts.map((part) => String(part)).join("/")
    );
  });

  it("covers gantt base html and empty payload helpers", () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");

    GanttPanel.restore(mock.panel, extensionUri, () => undefined);
    const panel = GanttPanel.currentPanel as unknown as GanttInternals;

    const html = panel._getBaseHtml();
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("webview-common.css");
    expect(html).toContain("gantt.css");
    expect(html).toContain("gantt.js");
    expect(html).toContain('id="ganttRoot"');
    expect(html).toContain("window.__GANTT_INITIAL_PAYLOAD__ = null");
    expect(html).toMatch(/script nonce="[^"]+"/);

    const payload = panel._getEmptyPayload();
    expect(payload.html).toContain("No issues with dates to display");
    expect(payload.state.timelineWidth).toBe(600);
    expect(payload.state.stickyLeftWidth).toBeGreaterThan(0);
  });

  it("covers gantt status helper mapping branches", () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");

    GanttPanel.restore(mock.panel, extensionUri, () => undefined);
    const panel = GanttPanel.currentPanel as unknown as GanttInternals;

    expect(panel._getStatusColor("at-risk")).toBe("var(--vscode-charts-yellow)");
    expect(panel._getStatusTextColor("at-risk")).toBe("rgba(0,0,0,0.87)");
    expect(panel._getStatusOpacity("on-track")).toBe(0.6);
    expect(panel._getStatusDescription("completed")).toBe("Completed: Issue is done");

    expect(panel._getStatusColor("unknown")).toBe("var(--vscode-descriptionForeground)");
    expect(panel._getStatusTextColor(null)).toBe("rgba(255,255,255,0.95)");
    expect(panel._getStatusOpacity("unknown")).toBe(0.5);
    expect(panel._getStatusDescription(null)).toBe("");
  });

  it("covers gantt date marker generation for key zoom paths", () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");

    GanttPanel.restore(mock.panel, extensionUri, () => undefined);
    const panel = GanttPanel.currentPanel as unknown as GanttInternals;

    const dayMarkers = panel._generateDateMarkers(
      new Date(Date.UTC(2026, 0, 1)),
      new Date(Date.UTC(2026, 0, 15)),
      700,
      0,
      "day"
    );
    expect(dayMarkers.header).toMatch(/W\d+/);
    expect(dayMarkers.body).toContain('class="weekend-layer"');
    expect(dayMarkers.body).toContain('class="day-grid"');

    const quarterMarkers = panel._generateDateMarkers(
      new Date(Date.UTC(2026, 0, 1)),
      new Date(Date.UTC(2026, 5, 30)),
      900,
      0,
      "quarter"
    );
    expect(quarterMarkers.header).toContain("Q1 2026");
    expect(quarterMarkers.header).toContain("Jan");

    const today = getLocalToday();
    const rangeStart = new Date(today);
    rangeStart.setDate(rangeStart.getDate() - 1);
    const rangeEnd = new Date(today);
    rangeEnd.setDate(rangeEnd.getDate() + 1);
    const todayMarkers = panel._generateDateMarkers(rangeStart, rangeEnd, 300, 0, "day");
    expect(todayMarkers.todayMarker).toContain("today-marker");
  });

  it("covers timesheet html rendering branches for draft mode", () => {
    vi.spyOn(
      TimeSheetPanel.prototype as unknown as { _getNonce: () => string },
      "_getNonce"
    ).mockReturnValue("fixednonce");

    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");
    const context = createContext();

    TimeSheetPanel.restore(
      mock.panel,
      extensionUri,
      context,
      () => undefined,
      () => undefined,
      () => createDraftModeManager(false)
    );
    const panel = TimeSheetPanel.currentPanel as unknown as TimesheetInternals;

    const htmlDraftOff = panel._getHtml();
    expect(htmlDraftOff).toContain("timesheet.css");
    expect(htmlDraftOff).toContain("flatpickr.min.css");
    expect(htmlDraftOff).toContain("flatpickr-weekSelect.js");
    expect(htmlDraftOff).toContain("nonce-fixednonce");
    expect(htmlDraftOff).toContain('body class="draft-mode-disabled"');
    expect(htmlDraftOff).toContain('class="draft-mode-warning"');

    panel._getDraftModeManagerFn = () => createDraftModeManager(true);
    const htmlDraftOn = panel._getHtml();
    expect(htmlDraftOn).not.toContain('body class="draft-mode-disabled"');
    expect(htmlDraftOn).toContain("draft-mode-warning hidden");
  });

  it("covers timesheet entries-to-rows conversion including branch cases", () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");
    const context = createContext();

    TimeSheetPanel.restore(
      mock.panel,
      extensionUri,
      context,
      () => undefined,
      () => undefined,
      () => createDraftModeManager(false)
    );
    const panel = TimeSheetPanel.currentPanel as unknown as TimesheetInternals;

    panel._projects = [
      {
        id: 100,
        name: "Child Project",
        identifier: "child-project",
        path: "Client A / Child Project",
        parentId: 10,
      },
      {
        id: 200,
        name: "Orphan Project",
        identifier: "orphan-project",
        path: "Orphan Project",
        parentId: null,
      },
    ];
    panel._parentProjects = [
      {
        id: 10,
        name: "Client A",
        identifier: "client-a",
        path: "Client A",
        parentId: null,
      },
    ];

    const week = buildWeekInfo(new Date(2026, 1, 2));
    const entries: TimeEntry[] = [
      {
        id: 11,
        issue_id: 900,
        activity_id: 1,
        hours: "2.5",
        comments: "Planning",
        spent_on: week.dayDates[0],
        project: { id: 100, name: "Child Project" },
        issue: { id: 900, subject: "Plan sprint" },
        activity: { id: 1, name: "Development" },
      },
      {
        id: 12,
        issue_id: 901,
        activity_id: 2,
        hours: "1",
        comments: "Review",
        spent_on: week.dayDates[1],
        project: { id: 200, name: "Orphan Project" },
        issue: { id: 901, subject: "Review PR" },
        activity: { id: 2, name: "Review" },
      },
      {
        id: 13,
        issue_id: 902,
        activity_id: 3,
        hours: "3",
        comments: "Out of range",
        spent_on: "2026-01-01",
        project: { id: 200, name: "Orphan Project" },
        issue: { id: 902, subject: "Skip me" },
        activity: { id: 3, name: "Support" },
      },
    ];

    const rows = panel._entriesToRows(entries, week);
    expect(rows).toHaveLength(2);

    expect(rows[0]).toEqual(
      expect.objectContaining({
        id: "existing-11",
        parentProjectId: 10,
        parentProjectName: "Client A",
        projectId: 100,
        issueId: 900,
        activityId: 1,
        weekTotal: 2.5,
        isNew: false,
      })
    );
    expect(rows[0].days[0]).toEqual(
      expect.objectContaining({
        hours: 2.5,
        originalHours: 2.5,
        entryId: 11,
      })
    );

    expect(rows[1]).toEqual(
      expect.objectContaining({
        id: "existing-12",
        parentProjectId: OTHERS_PARENT_ID,
        parentProjectName: "Others",
        projectId: 200,
        weekTotal: 1,
      })
    );
  });

  it("covers timesheet totals and field-value utility branches", () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");
    const context = createContext();

    TimeSheetPanel.restore(
      mock.panel,
      extensionUri,
      context,
      () => undefined,
      () => undefined,
      () => createDraftModeManager(false)
    );
    const panel = TimeSheetPanel.currentPanel as unknown as TimesheetInternals;

    const rowA = panel._createEmptyRow();
    rowA.parentProjectId = 1;
    rowA.projectId = 2;
    rowA.issueId = 3;
    rowA.activityId = 4;
    rowA.comments = "notes";
    rowA.days[0].hours = 1.5;
    rowA.days[1].hours = 2;
    rowA.weekTotal = 3.5;

    const rowB = panel._createEmptyRow();
    rowB.days[0].hours = 0.5;
    rowB.days[6].hours = 4;
    rowB.weekTotal = 4.5;

    panel._rows = [rowA, rowB];
    panel._schedule = {
      Mon: 8,
      Tue: 7,
      Wed: 6,
      Thu: 5,
      Fri: 4,
      Sat: 1,
      Sun: 0,
    };

    const totals = panel._calculateTotals();
    expect(totals.days).toEqual([2, 2, 0, 0, 0, 0, 4]);
    expect(totals.weekTotal).toBe(8);
    expect(totals.targetHours).toEqual([8, 7, 6, 5, 4, 1, 0]);
    expect(totals.weekTargetTotal).toBe(31);

    expect(panel._getFieldValue(rowA, "parentProject")).toBe(1);
    expect(panel._getFieldValue(rowA, "project")).toBe(2);
    expect(panel._getFieldValue(rowA, "issue")).toBe(3);
    expect(panel._getFieldValue(rowA, "activity")).toBe(4);
    expect(panel._getFieldValue(rowA, "comments")).toBe("notes");
    expect(panel._getFieldValue(rowA, "unknown" as "comments")).toBeNull();
  });
});
