/**
 * TimeSheet Webview Panel
 * Week-by-week time entry editing grid
 */

import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { TimeEntry } from "../redmine/models/time-entry";
import { Issue } from "../redmine/models/issue";
import { DraftQueue } from "../draft-mode/draft-queue";
import { DraftModeManager } from "../draft-mode/draft-mode-manager";
import { generateTempId, generateDraftId } from "../draft-mode/draft-operation";
import { WeeklySchedule, DEFAULT_WEEKLY_SCHEDULE } from "../utilities/flexibility-calculator";
import { parseLocalDate, getLocalToday } from "../utilities/date-utils";
import { pickIssue } from "../utilities/issue-picker";
import { showStatusBarMessage } from "../utilities/status-bar";
import {
  setClipboard,
  getClipboard,
  ClipboardEntry,
} from "../utilities/time-entry-clipboard";
import {
  TimeSheetRow,
  DayCell,
  WeekInfo,
  DailyTotals,
  ProjectOption,
  IssueOption,
  ActivityOption,
  IssueDetails,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  buildWeekInfo,
  OTHERS_PARENT_ID,
  SortColumn,
  SortDirection,
  GroupBy,
  RowCascadeData,
} from "./timesheet-webview-messages";
import { startOfISOWeek } from "date-fns";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Source identifier for DraftQueue changes from this panel */
const TIMESHEET_SOURCE = "timesheet-panel";

/** Safely extract hours from draft operation http data */
function extractHoursFromDraftOp(data: Record<string, unknown> | undefined): number {
  if (!data || typeof data !== "object") return 0;
  const timeEntry = data.time_entry;
  if (!timeEntry || typeof timeEntry !== "object") return 0;
  const hours = (timeEntry as Record<string, unknown>).hours;
  return typeof hours === "number" ? hours : 0;
}

export class TimeSheetPanel {
  public static currentPanel: TimeSheetPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _context: vscode.ExtensionContext;
  private _getServerFn: (() => RedmineServer | undefined) | undefined;
  private _getDraftQueueFn: (() => DraftQueue | undefined) | undefined;
  private _getDraftModeManagerFn: (() => DraftModeManager | undefined) | undefined;
  private _getCachedIssues: (() => Issue[]) | undefined;

  /** Get current server (called fresh each time to handle late connection) */
  private get _server(): RedmineServer | undefined {
    return this._getServerFn?.();
  }

  /** Get current draft queue */
  private get _draftQueue(): DraftQueue | undefined {
    return this._getDraftQueueFn?.();
  }

  /** Get current draft mode manager */
  private get _draftModeManager(): DraftModeManager | undefined {
    return this._getDraftModeManagerFn?.();
  }

  private _rows: TimeSheetRow[] = [];
  private _currentWeek: WeekInfo;
  private _projects: ProjectOption[] = []; // All projects flat
  private _parentProjects: ProjectOption[] = []; // Parents + "Others"
  private _childrenByParent: Map<number, ProjectOption[]> = new Map(); // parentId -> children
  private _issuesByProject: Map<number, IssueOption[]> = new Map();
  private _activitiesByProject: Map<number, ActivityOption[]> = new Map();
  private _issueDetailsCache: Map<number, IssueDetails> = new Map();
  private _disposables: vscode.Disposable[] = [];
  private _schedule: WeeklySchedule = DEFAULT_WEEKLY_SCHEDULE;
  private _sortColumn: SortColumn = null;
  private _sortDirection: SortDirection = "asc";
  private _groupBy: GroupBy = "none";
  private _collapsedGroups: Set<string> = new Set();
  private _aggregateRows: boolean = false;

  public static createOrShow(
    extensionUri: vscode.Uri,
    context: vscode.ExtensionContext,
    getServer: () => RedmineServer | undefined,
    getDraftQueue: () => DraftQueue | undefined,
    getDraftModeManager: () => DraftModeManager | undefined,
    getCachedIssues?: () => Issue[]
  ): TimeSheetPanel {
    const column = vscode.window.activeTextEditor?.viewColumn;
    const draftModeManager = getDraftModeManager();

    // If panel exists, reveal it
    if (TimeSheetPanel.currentPanel) {
      TimeSheetPanel.currentPanel._panel.reveal(column);
      TimeSheetPanel.currentPanel._getServerFn = getServer;
      TimeSheetPanel.currentPanel._getDraftQueueFn = getDraftQueue;
      TimeSheetPanel.currentPanel._getDraftModeManagerFn = getDraftModeManager;
      TimeSheetPanel.currentPanel._getCachedIssues = getCachedIssues;
      // Notify webview of current draft mode state
      TimeSheetPanel.currentPanel._postMessage({
        type: "draftModeChanged",
        isDraftMode: draftModeManager?.isEnabled ?? false,
      });
      return TimeSheetPanel.currentPanel;
    }

    // Create new panel
    const panel = vscode.window.createWebviewPanel(
      "redmyneTimeSheet",
      "Time Sheet",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );

    TimeSheetPanel.currentPanel = new TimeSheetPanel(
      panel,
      extensionUri,
      context,
      getServer,
      getDraftQueue,
      getDraftModeManager,
      getCachedIssues
    );
    return TimeSheetPanel.currentPanel;
  }

  /** Refresh the timesheet panel if it's open */
  public static refresh(): void {
    if (TimeSheetPanel.currentPanel) {
      void TimeSheetPanel.currentPanel._loadWeek(TimeSheetPanel.currentPanel._currentWeek);
    }
  }

  public static restore(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    context: vscode.ExtensionContext,
    getServer: () => RedmineServer | undefined,
    getDraftQueue: () => DraftQueue | undefined,
    getDraftModeManager: () => DraftModeManager | undefined,
    getCachedIssues?: () => Issue[]
  ): TimeSheetPanel {
    TimeSheetPanel.currentPanel = new TimeSheetPanel(
      panel,
      extensionUri,
      context,
      getServer,
      getDraftQueue,
      getDraftModeManager,
      getCachedIssues
    );
    return TimeSheetPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    context: vscode.ExtensionContext,
    getServer: () => RedmineServer | undefined,
    getDraftQueue: () => DraftQueue | undefined,
    getDraftModeManager: () => DraftModeManager | undefined,
    getCachedIssues?: () => Issue[]
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._context = context;
    this._getServerFn = getServer;
    this._getDraftQueueFn = getDraftQueue;
    this._getDraftModeManagerFn = getDraftModeManager;
    this._getCachedIssues = getCachedIssues;

    // Initialize to current week
    const today = getLocalToday();
    const monday = startOfISOWeek(today);
    this._currentWeek = buildWeekInfo(monday);

    // Load schedule from config
    const scheduleConfig = vscode.workspace.getConfiguration("redmyne.workingHours");
    this._schedule = scheduleConfig.get<WeeklySchedule>("weeklySchedule", DEFAULT_WEEKLY_SCHEDULE);

    // Load persisted sort state
    this._sortColumn = this._context.globalState.get<SortColumn>("redmyne.timesheet.sortColumn", null);
    this._sortDirection = this._context.globalState.get<SortDirection>("redmyne.timesheet.sortDirection", "asc");

    // Load persisted grouping state
    this._groupBy = this._context.globalState.get<GroupBy>("redmyne.timesheet.groupBy", "none");
    const collapsed = this._context.globalState.get<string[]>("redmyne.timesheet.collapsedGroups", []);
    this._collapsedGroups = new Set(collapsed);
    this._aggregateRows = this._context.globalState.get<boolean>("redmyne.timesheet.aggregateRows", false);

    // Set HTML content
    this._panel.webview.html = this._getHtml();

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => this._handleMessage(message),
      null,
      this._disposables
    );

    // Handle panel dispose
    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);

    // Handle panel visibility changes
    this._panel.onDidChangeViewState(
      () => {
        if (this._panel.visible) {
          // Refresh when panel becomes visible
          this._loadWeek(this._currentWeek);
        } else {
          // Save new rows when panel loses visibility
          this._saveIncompleteRows();
        }
      },
      null,
      this._disposables
    );

    // Listen for draft mode changes
    if (this._draftModeManager) {
      this._disposables.push(
        this._draftModeManager.onDidChangeEnabled(() => {
          this._postMessage({
            type: "draftModeChanged",
            isDraftMode: this._draftModeManager?.isEnabled ?? false,
          });
        })
      );
    }

    // Listen for draft queue changes from external sources (Draft Review apply/discard)
    // Only reload if the change wasn't triggered by this panel
    if (this._draftQueue) {
      this._disposables.push(
        this._draftQueue.onDidChange((source) => {
          // Skip reload if the change came from this panel
          if (source === TIMESHEET_SOURCE) return;
          if (this._panel.visible) {
            void this._loadWeek(this._currentWeek);
          }
        })
      );
    }
  }

  private _dispose(): void {
    TimeSheetPanel.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }

  private async _handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case "webviewReady":
        await this._loadWeek(this._currentWeek);
        break;

      case "navigateWeek":
        await this._navigateWeek(message.direction, message.targetDate);
        break;

      case "addRow":
        this._addRow();
        break;

      case "deleteRow":
        await this._deleteRow(message.rowId);
        break;

      case "restoreRow":
        this._restoreRow(message.row);
        break;

      case "duplicateRow":
        this._duplicateRow(message.rowId);
        break;

      case "updateCell":
        await this._updateCell(message.rowId, message.dayIndex, message.hours);
        break;

      case "updateRowField":
        await this._updateRowField(message.rowId, message.field, message.value);
        break;

      case "requestChildProjects":
        this._sendChildProjects(message.parentId);
        break;

      case "requestIssues":
        await this._loadIssuesForProject(message.projectId);
        break;

      case "requestActivities":
        await this._loadActivitiesForProject(message.projectId);
        break;

      case "saveAll":
        await this._saveAll();
        break;

      case "pickIssue":
        await this._pickIssueForRow(message.rowId);
        break;

      case "sortChanged":
        this._sortColumn = message.sortColumn;
        this._sortDirection = message.sortDirection;
        // Persist to globalState
        void this._context.globalState.update("redmyne.timesheet.sortColumn", this._sortColumn);
        void this._context.globalState.update("redmyne.timesheet.sortDirection", this._sortDirection);
        break;

      case "setGroupBy":
        this._groupBy = message.groupBy;
        void this._context.globalState.update("redmyne.timesheet.groupBy", this._groupBy);
        break;

      case "setAggregateRows":
        this._aggregateRows = message.aggregateRows;
        void this._context.globalState.update("redmyne.timesheet.aggregateRows", this._aggregateRows);
        break;

      case "toggleGroup":
        if (this._collapsedGroups.has(message.groupKey)) {
          this._collapsedGroups.delete(message.groupKey);
        } else {
          this._collapsedGroups.add(message.groupKey);
        }
        void this._context.globalState.update(
          "redmyne.timesheet.collapsedGroups",
          [...this._collapsedGroups]
        );
        break;

      case "copyWeek":
        this._copyWeek();
        break;

      case "pasteWeek":
        await this._pasteWeek();
        break;

      case "enableDraftMode":
        await this._enableDraftMode();
        break;

      case "requestIssueDetails":
        await this._loadIssueDetails(message.issueId);
        break;

      case "updateAggregatedCell":
        await this._updateAggregatedCell(
          message.aggRowId,
          message.dayIndex,
          message.newHours,
          message.sourceEntries,
          message.confirmed
        );
        break;

      case "updateAggregatedField":
        await this._updateAggregatedField(
          message.aggRowId,
          message.field,
          message.value,
          message.sourceRowIds,
          message.confirmed
        );
        break;

      case "restoreAggregatedEntries":
        await this._restoreAggregatedEntries(
          message.entries,
          message.aggRowId,
          message.dayIndex
        );
        break;

      case "updateExpandedEntry":
        await this._updateExpandedEntry(
          message.rowId,
          message.entryId,
          message.dayIndex,
          message.newHours
        );
        break;

      case "deleteExpandedEntry":
        await this._deleteExpandedEntry(
          message.rowId,
          message.entryId,
          message.aggRowId,
          message.dayIndex
        );
        break;

      case "mergeEntries":
        await this._mergeEntries(
          message.aggRowId,
          message.dayIndex,
          message.sourceEntries
        );
        break;

      case "undoPaste":
        await this._undoPaste(message.draftIds);
        break;
    }
  }

  private _postMessage(message: ExtensionToWebviewMessage): void {
    this._panel.webview.postMessage(message);
  }

  /** Post a full render message with current state */
  private _postRenderMessage(): void {
    const totals = this._calculateTotals();
    this._postMessage({
      type: "render",
      rows: this._rows,
      week: this._currentWeek,
      totals,
      projects: this._projects,
      parentProjects: this._parentProjects,
      isDraftMode: this._draftModeManager?.isEnabled ?? false,
      sortColumn: this._sortColumn,
      sortDirection: this._sortDirection,
      groupBy: this._groupBy,
      collapsedGroups: [...this._collapsedGroups],
      aggregateRows: this._aggregateRows,
      childProjectsByParent: Object.fromEntries(this._childrenByParent),
      issuesByProject: Object.fromEntries(this._issuesByProject),
      activitiesByProject: Object.fromEntries(this._activitiesByProject),
    });
  }

  private async _loadWeek(week: WeekInfo): Promise<void> {
    if (!this._server) {
      this._postMessage({ type: "showError", message: "No server configured" });
      return;
    }

    this._postMessage({ type: "setLoading", loading: true });

    try {
      // Fetch time entries for the week (current user only)
      const result = await this._server.getTimeEntries({
        from: week.startDate,
        to: week.endDate,
        allUsers: false,
      });
      const entries = result.time_entries;

      // Load projects
      await this._loadProjects();

      // Convert entries to rows (each entry = separate row)
      this._rows = this._entriesToRows(entries, week);

      // Restore incomplete rows for this week
      this._restoreIncompleteRows(week.startDate);

      // Apply pending draft changes to rows (restore unsaved edits)
      this._applyPendingDraftChanges();

      // Auto-add empty row if no entries exist
      if (this._rows.length === 0) {
        this._rows.push(this._createEmptyRow());
      }

      // Collect unique parent and project IDs from rows
      const parentIds = new Set(
        this._rows.map((r) => r.parentProjectId).filter((id): id is number => id !== null)
      );
      const projectIds = new Set(
        this._rows.map((r) => r.projectId).filter((id): id is number => id !== null)
      );

      // Load activities and issues for all projects in parallel
      await Promise.all([...projectIds].map((pid) => this._loadProjectData(pid)));

      // Update issueSubject for all rows from cached issues
      for (const row of this._rows) {
        if (row.issueId && row.projectId) {
          const issues = this._issuesByProject.get(row.projectId);
          const issue = issues?.find((i) => i.id === row.issueId);
          if (issue) {
            row.issueSubject = issue.subject;
          }
        }
      }

      // Calculate totals
      const totals = this._calculateTotals();

      // Send to webview with cascade data (stateless pattern)
      this._postRenderMessage();

      // Pre-send child projects for all parents in existing rows
      for (const parentId of parentIds) {
        this._sendChildProjects(parentId);
      }

      // Load issue details for tooltips (fire and forget)
      this._loadAllIssueDetails();
    } catch (error) {
      this._postMessage({ type: "showError", message: `Failed to load: ${error}` });
    } finally {
      this._postMessage({ type: "setLoading", loading: false });
    }
  }

  private async _loadProjects(): Promise<void> {
    if (!this._server) return;

    try {
      const projects = await this._server.getProjects();

      // Build flat list with parentId
      this._projects = projects.map((p) => ({
        id: p.id,
        name: p.name,
        identifier: p.identifier,
        path: p.name,
        parentId: p.parent?.id ?? null,
      }));

      // Build hierarchy: separate parents and children
      const parentsWithChildren = new Set<number>();
      const orphans: ProjectOption[] = [];
      this._childrenByParent.clear();

      for (const p of this._projects) {
        if (p.parentId !== null) {
          // This is a child - add to its parent's children list
          parentsWithChildren.add(p.parentId);
          const children = this._childrenByParent.get(p.parentId) ?? [];
          children.push(p);
          this._childrenByParent.set(p.parentId, children);
        }
      }

      // Identify parents (projects that have children) and orphans (no parent, no children)
      const parents: ProjectOption[] = [];
      for (const p of this._projects) {
        if (parentsWithChildren.has(p.id)) {
          // This project has children - it's a parent
          parents.push(p);
        } else if (p.parentId === null) {
          // No parent and no children - orphan (goes to "Others")
          orphans.push(p);
        }
      }

      // Build parent projects list (for Client dropdown)
      this._parentProjects = [...parents];

      // Add synthetic "Others" if there are orphan projects
      if (orphans.length > 0) {
        const othersParent: ProjectOption = {
          id: OTHERS_PARENT_ID,
          name: "Others",
          identifier: "",
          path: "Others",
          parentId: null,
        };
        this._parentProjects.push(othersParent);
        this._childrenByParent.set(OTHERS_PARENT_ID, orphans);
      }

      // Sort parents alphabetically
      this._parentProjects.sort((a, b) => a.name.localeCompare(b.name));
    } catch (_err) {
      // Silent fail - projects stay empty, UI shows placeholders
    }
  }

  private _sendChildProjects(parentId: number): void {
    const children = this._childrenByParent.get(parentId) ?? [];
    this._postMessage({
      type: "updateChildProjects",
      projects: children,
      forParentId: parentId,
    });
  }

  private _entriesToRows(entries: TimeEntry[], week: WeekInfo): TimeSheetRow[] {
    // One row per time entry (no grouping)
    const rows: TimeSheetRow[] = [];

    for (const entry of entries) {
      // Find day index (0=Mon, 6=Sun)
      const entryDate = entry.spent_on ?? "";
      const dayIndex = week.dayDates.indexOf(entryDate);
      if (dayIndex === -1) continue;

      const row = this._createEmptyRow();
      row.id = `existing-${entry.id}`;
      row.projectId = entry.project?.id ?? null;
      row.projectName = entry.project?.name ?? null;

      // Derive parentProjectId from project's parent
      const projectOpt = this._projects.find((p) => p.id === row.projectId);
      if (projectOpt?.parentId !== null && projectOpt?.parentId !== undefined) {
        // Has a parent - use it
        row.parentProjectId = projectOpt.parentId;
        row.parentProjectName = this._parentProjects.find((p) => p.id === projectOpt.parentId)?.name ?? null;
      } else if (row.projectId !== null) {
        // Orphan project or parent project - put in "Others"
        row.parentProjectId = OTHERS_PARENT_ID;
        row.parentProjectName = "Others";
      }

      row.issueId = entry.issue?.id ?? null;
      row.issueSubject = entry.issue?.subject ?? null;
      row.activityId = entry.activity?.id ?? null;
      row.activityName = entry.activity?.name ?? null;
      row.comments = entry.comments ?? null;
      row.originalComments = entry.comments ?? null;
      row.isNew = false;

      // Set hours for this entry's day
      const entryHours = typeof entry.hours === "string" ? parseFloat(entry.hours) : entry.hours;
      row.days[dayIndex] = {
        hours: entryHours,
        originalHours: entryHours,
        entryId: entry.id ?? null,
        isDirty: false,
      };

      // Calculate week total (just this entry's hours)
      row.weekTotal = entryHours;

      rows.push(row);
    }

    return rows;
  }

  private _createEmptyRow(): TimeSheetRow {
    const days: Record<number, DayCell> = {};
    for (let i = 0; i < 7; i++) {
      days[i] = { hours: 0, originalHours: 0, entryId: null, isDirty: false };
    }
    return {
      id: generateTempId("timeentry"),
      parentProjectId: null,
      parentProjectName: null,
      projectId: null,
      projectName: null,
      issueId: null,
      issueSubject: null,
      activityId: null,
      activityName: null,
      comments: null,
      originalComments: null,
      days,
      isNew: true,
      weekTotal: 0,
    };
  }

  /** Storage key for incomplete rows, per week */
  private _getIncompleteRowsKey(weekStart: string): string {
    return `redmyne.timesheet.incompleteRows.${weekStart}`;
  }

  /** Save new rows (not yet saved to Redmine) to globalState */
  private _saveIncompleteRows(): void {
    // Save all new rows - they'll be lost when switching views otherwise
    const newRows = this._rows.filter((r) => r.isNew);
    if (newRows.length > 0) {
      void this._context.globalState.update(
        this._getIncompleteRowsKey(this._currentWeek.startDate),
        newRows
      );
    } else {
      // Clear if no new rows
      void this._context.globalState.update(
        this._getIncompleteRowsKey(this._currentWeek.startDate),
        undefined
      );
    }
  }

  /** Restore incomplete rows for a week from globalState */
  private _restoreIncompleteRows(weekStart: string): void {
    const saved = this._context.globalState.get<TimeSheetRow[]>(
      this._getIncompleteRowsKey(weekStart)
    );
    if (saved && saved.length > 0) {
      // Get current draft operations to check which rows still have pending drafts
      const draftOps = this._draftQueue?.getAll() || [];
      const draftTempIdPrefixes = new Set(
        draftOps.map(op => op.tempId?.split(":")[0]).filter(Boolean)
      );

      // Add incomplete rows that aren't already in _rows AND have pending drafts (or no hours yet)
      for (const row of saved) {
        if (!this._rows.find((r) => r.id === row.id)) {
          // Only restore if: row has no hours yet, OR row has pending draft operations
          const hasHours = row.weekTotal > 0;
          const hasDraftOps = draftTempIdPrefixes.has(row.id);
          if (!hasHours || hasDraftOps) {
            this._rows.push(row);
          }
        }
      }

      // Clean up storage - remove rows that were not restored
      const restoredIds = new Set(this._rows.filter(r => r.isNew).map(r => r.id));
      const stillValid = saved.filter(r => restoredIds.has(r.id));
      if (stillValid.length !== saved.length) {
        if (stillValid.length > 0) {
          void this._context.globalState.update(this._getIncompleteRowsKey(weekStart), stillValid);
        } else {
          void this._context.globalState.update(this._getIncompleteRowsKey(weekStart), undefined);
        }
      }
    }
  }

  /** Apply pending draft changes to loaded rows (restore unsaved edits) */
  private _applyPendingDraftChanges(): void {
    const draftOps = this._draftQueue?.getAll() || [];
    console.log("[Timesheet] _applyPendingDraftChanges: draftOps count:", draftOps.length);
    const timeEntryOps = draftOps.filter(
      (op) => op.type === "createTimeEntry" || op.type === "updateTimeEntry" || op.type === "deleteTimeEntry"
    );
    console.log("[Timesheet] _applyPendingDraftChanges: timeEntryOps:", timeEntryOps);
    console.log("[Timesheet] _applyPendingDraftChanges: current rows:", this._rows.map(r => ({ id: r.id, isNew: r.isNew })));
    if (timeEntryOps.length === 0) return;

    for (const op of timeEntryOps) {
      console.log("[Timesheet] Processing op:", op.type, "resourceId:", op.resourceId, "tempId:", op.tempId);
      if (op.type === "updateTimeEntry" && op.resourceId) {
        // Find row with this entryId
        let found = false;
        for (const row of this._rows) {
          for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
            const cell = row.days[dayIndex];
            if (cell?.entryId === op.resourceId) {
              const hours = extractHoursFromDraftOp(op.http.data);
              console.log("[Timesheet] updateTimeEntry: Found entryId", op.resourceId, "applying hours:", hours);
              row.days[dayIndex] = { ...cell, hours, isDirty: true };
              row.weekTotal = Object.values(row.days).reduce((sum, c) => sum + c.hours, 0);
              found = true;
              break;
            }
          }
          if (found) break;
        }
        if (!found) {
          console.log("[Timesheet] updateTimeEntry: Could not find entryId", op.resourceId, "in rows");
        }
      } else if (op.type === "deleteTimeEntry" && op.resourceId) {
        // Find row with this entryId and set hours to 0
        for (const row of this._rows) {
          for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
            const cell = row.days[dayIndex];
            if (cell?.entryId === op.resourceId) {
              row.days[dayIndex] = { ...cell, hours: 0, isDirty: true };
              row.weekTotal = Object.values(row.days).reduce((sum, c) => sum + c.hours, 0);
              break;
            }
          }
        }
      } else if (op.type === "createTimeEntry" && op.tempId) {
        // Parse tempId - three formats:
        // 1. Aggregated: "agg-{issueId}::{activityId}::{comments}:{dayIndex}"
        // 2. Paste: "draft-timeentry-xxx" (data in http body)
        // 3. Normal: "rowId:dayIndex"
        console.log("[Timesheet] createTimeEntry tempId:", op.tempId);

        if (op.tempId.startsWith("agg-")) {
          // Aggregated row format uses :: as delimiter for issueId/activityId/comments
          // Format: agg-{issueId}::{activityId}::{comments}:{dayIndex}
          const aggMatch = op.tempId.match(/^agg-(.+?)::(.+?)::(.*)$/);
          if (!aggMatch) continue;
          const [, issueIdStr, activityIdStr, rest] = aggMatch;
          // rest = "comments:dayIndex" - dayIndex is last segment after :
          const lastColonIdx = rest.lastIndexOf(":");
          const dayIndex = lastColonIdx >= 0 ? parseInt(rest.slice(lastColonIdx + 1), 10) : NaN;
          const issueId = issueIdStr === "null" ? null : parseInt(issueIdStr, 10);
          const activityId = activityIdStr === "null" ? null : parseInt(activityIdStr, 10);
          console.log("[Timesheet] Aggregated: issueId:", issueId, "activityId:", activityId, "dayIndex:", dayIndex);

          // Find source row with matching issueId and activityId
          const row = this._rows.find((r) => r.issueId === issueId && r.activityId === activityId);
          console.log("[Timesheet] Found source row:", row ? "yes" : "no", row?.id);
          if (row && !isNaN(dayIndex) && dayIndex >= 0 && dayIndex < 7) {
            const hours = extractHoursFromDraftOp(op.http.data);
            console.log("[Timesheet] Applying hours:", hours, "to dayIndex:", dayIndex);
            const cell = row.days[dayIndex] || { hours: 0, originalHours: 0, entryId: null, isDirty: false };
            row.days[dayIndex] = { ...cell, hours, isDirty: true };
            row.weekTotal = Object.values(row.days).reduce((sum, c) => sum + c.hours, 0);
          }
        } else if (op.tempId.startsWith("draft-timeentry-")) {
          // Paste format: extract data from http body, find/create row
          const timeEntry = op.http?.data?.time_entry;
          if (!timeEntry) continue;

          const issueId = timeEntry.issue_id;
          const activityId = timeEntry.activity_id;
          const projectId = timeEntry.project_id;
          const hours = timeEntry.hours || 0;
          const spentOn = timeEntry.spent_on;
          const comments = timeEntry.comments || "";

          // Calculate dayIndex from spent_on
          const dayIndex = this._currentWeek.dayDates.indexOf(spentOn);
          if (dayIndex < 0) continue; // Not in current week

          console.log("[Timesheet] Paste: issueId:", issueId, "activityId:", activityId, "projectId:", projectId, "dayIndex:", dayIndex, "hours:", hours);

          // Find existing row with same issue/activity/comments, or create new one
          let row = this._rows.find(
            (r) => r.issueId === issueId && r.activityId === activityId && (r.comments || "") === comments
          );

          if (!row) {
            // Create new row for this draft entry
            row = this._createEmptyRow();
            row.issueId = issueId;
            row.activityId = activityId;
            row.projectId = projectId ?? null;
            row.comments = comments;
            row.isNew = true;
            this._rows.push(row);
            console.log("[Timesheet] Created new row for paste:", row.id);

            // Try to look up project info from cached data
            if (projectId) {
              const project = this._projects.find((p) => p.id === projectId);
              if (project) {
                row.projectName = project.name;
                row.parentProjectId = project.parentId ?? null;
                const parent = this._parentProjects.find((p) => p.id === project.parentId);
                row.parentProjectName = parent?.name ?? null;
              }
            }
          }

          // Apply hours to this day
          const cell = row.days[dayIndex] || { hours: 0, originalHours: 0, entryId: null, isDirty: false };
          row.days[dayIndex] = { ...cell, hours: cell.hours + hours, isDirty: true };
          row.weekTotal = Object.values(row.days).reduce((sum, c) => sum + c.hours, 0);
        } else {
          // Normal row format: "rowId:dayIndex"
          const lastColonIdx = op.tempId.lastIndexOf(":");
          if (lastColonIdx < 0) continue;
          const rowId = op.tempId.slice(0, lastColonIdx);
          const dayIndex = parseInt(op.tempId.slice(lastColonIdx + 1), 10);
          console.log("[Timesheet] Normal: rowId:", rowId, "dayIndex:", dayIndex);
          const row = this._rows.find((r) => r.id === rowId);
          console.log("[Timesheet] Found row:", row ? "yes" : "no", row?.id);
          if (row && !isNaN(dayIndex) && dayIndex >= 0 && dayIndex < 7) {
            const hours = extractHoursFromDraftOp(op.http.data);
            console.log("[Timesheet] Applying hours:", hours, "to dayIndex:", dayIndex);
            const cell = row.days[dayIndex] || { hours: 0, originalHours: 0, entryId: null, isDirty: false };
            row.days[dayIndex] = { ...cell, hours, isDirty: true };
            row.weekTotal = Object.values(row.days).reduce((sum, c) => sum + c.hours, 0);
          }
        }
      }
    }
  }

  /** Clear completed row from incomplete rows storage */
  private _clearCompletedRow(rowId: string): void {
    const saved = this._context.globalState.get<TimeSheetRow[]>(
      this._getIncompleteRowsKey(this._currentWeek.startDate)
    );
    if (saved) {
      const updated = saved.filter((r) => r.id !== rowId);
      if (updated.length > 0) {
        void this._context.globalState.update(
          this._getIncompleteRowsKey(this._currentWeek.startDate),
          updated
        );
      } else {
        void this._context.globalState.update(
          this._getIncompleteRowsKey(this._currentWeek.startDate),
          undefined
        );
      }
    }
  }

  /** Get cascade data for a specific row (for efficient updateRow messages) */
  private _getRowCascadeData(row: TimeSheetRow): RowCascadeData {
    return {
      childProjects: row.parentProjectId ? this._childrenByParent.get(row.parentProjectId) : undefined,
      issues: row.projectId ? this._issuesByProject.get(row.projectId) : undefined,
      activities: row.projectId ? this._activitiesByProject.get(row.projectId) : undefined,
    };
  }

  private _calculateTotals(): DailyTotals {
    const days: number[] = [0, 0, 0, 0, 0, 0, 0];
    let weekTotal = 0;

    for (const row of this._rows) {
      for (let i = 0; i < 7; i++) {
        days[i] += row.days[i]?.hours ?? 0;
      }
      weekTotal += row.weekTotal;
    }

    // Target hours from schedule (Mon=0 maps to schedule.Mon, etc.)
    const scheduleKeys: (keyof WeeklySchedule)[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const targetHours = scheduleKeys.map((key) => this._schedule[key]);
    const weekTargetTotal = targetHours.reduce((a, b) => a + b, 0);

    return { days, weekTotal, targetHours, weekTargetTotal };
  }

  private async _navigateWeek(
    direction: "prev" | "next" | "today" | "date",
    targetDate?: string
  ): Promise<void> {
    let monday: Date;

    if (direction === "today") {
      monday = startOfISOWeek(getLocalToday());
    } else if (direction === "date" && targetDate) {
      monday = startOfISOWeek(parseLocalDate(targetDate));
    } else {
      const current = parseLocalDate(this._currentWeek.startDate);
      if (direction === "prev") {
        current.setDate(current.getDate() - 7);
      } else {
        current.setDate(current.getDate() + 7);
      }
      monday = current;
    }

    this._currentWeek = buildWeekInfo(monday);
    await this._loadWeek(this._currentWeek);
  }

  private _addRow(): void {
    const newRow = this._createEmptyRow();
    this._rows.push(newRow);
    // Save immediately so row persists across view changes
    this._saveIncompleteRows();
    this._postRenderMessage();
  }

  private async _deleteRow(rowId: string): Promise<void> {
    // Check if this is an aggregated row (id starts with "agg-")
    const isAggregated = rowId.startsWith("agg-");

    if (isAggregated) {
      // For aggregated rows, delete all source rows
      await this._deleteAggregatedRow(rowId);
      return;
    }

    const rowIndex = this._rows.findIndex((r) => r.id === rowId);
    if (rowIndex === -1) return;

    const row = this._rows[rowIndex];

    // If not new, mark entries for deletion via draft queue
    if (!row.isNew && this._draftQueue && this._draftModeManager?.isEnabled) {
      for (const cell of Object.values(row.days)) {
        if (cell.entryId) {
          await this._draftQueue.add({
            id: generateDraftId(),
            type: "deleteTimeEntry",
            timestamp: Date.now(),
            resourceId: cell.entryId,
            description: `Delete time entry #${cell.entryId}`,
            http: {
              method: "DELETE",
              path: `/time_entries/${cell.entryId}.json`,
            },
            resourceKey: `ts:timeentry:${cell.entryId}`,
          }, TIMESHEET_SOURCE);
        }
      }
    }

    // Store deleted row for undo before removing
    const deletedRow = { ...row };

    this._rows.splice(rowIndex, 1);

    // Clear from incomplete rows storage if it was stored there
    if (row.isNew) {
      this._clearCompletedRow(rowId);
      // Also remove any queued draft operations for this row
      if (this._draftQueue) {
        // tempId format is "rowId:dayIndex", so use rowId as prefix
        void this._draftQueue.removeByTempIdPrefix(`${rowId}:`, TIMESHEET_SOURCE);
      }
    }

    this._postRenderMessage();
    // Send rowDeleted for undo/redo support
    this._postMessage({
      type: "rowDeleted",
      deletedRow,
    });
  }

  /**
   * Delete an aggregated row - queues deletion for all source entries
   */
  private async _deleteAggregatedRow(aggRowId: string): Promise<void> {
    if (!this._draftQueue || !this._draftModeManager?.isEnabled) return;

    // Parse key from aggRowId: agg-{issueId}:{activityId}:{comments}
    const keyMatch = aggRowId.match(/^agg-(.+?)::(.+?)::(.*)$/);
    if (!keyMatch) return;

    const issueId = keyMatch[1] === "null" ? null : parseInt(keyMatch[1], 10);
    const activityId = keyMatch[2] === "null" ? null : parseInt(keyMatch[2], 10);
    const comments = keyMatch[3] || null;

    // Find all source rows that match this aggregation key
    const sourceRows = this._rows.filter(r =>
      r.issueId === issueId &&
      r.activityId === activityId &&
      (r.comments ?? "") === (comments ?? "")
    );

    // Queue deletions for all entries in source rows
    for (const row of sourceRows) {
      for (const cell of Object.values(row.days)) {
        if (cell.entryId) {
          await this._draftQueue.add({
            id: generateDraftId(),
            type: "deleteTimeEntry",
            timestamp: Date.now(),
            resourceId: cell.entryId,
            description: `Delete time entry #${cell.entryId}`,
            http: {
              method: "DELETE",
              path: `/time_entries/${cell.entryId}.json`,
            },
            resourceKey: `ts:timeentry:${cell.entryId}`,
          }, TIMESHEET_SOURCE);
        }
      }
    }

    // Reload to reflect changes
    await this._loadWeek(this._currentWeek);
  }

  private _restoreRow(row: TimeSheetRow): void {
    // Remove queued delete operations for this row's entries
    if (!row.isNew && this._draftQueue) {
      for (const cell of Object.values(row.days)) {
        if (cell.entryId) {
          void this._draftQueue.removeByKey(`ts:timeentry:${cell.entryId}`, TIMESHEET_SOURCE);
        }
      }
    }

    // Re-add the row to the list
    this._rows.push(row);
    this._postRenderMessage();
  }

  private _duplicateRow(rowId: string): void {
    // Check if this is an aggregated row
    const isAggregated = rowId.startsWith("agg-");

    let row: TimeSheetRow | undefined;
    let totalHoursPerDay: number[] = [0, 0, 0, 0, 0, 0, 0];

    if (isAggregated) {
      // Parse key from aggRowId: agg-{issueId}:{activityId}:{comments}
      const keyMatch = rowId.match(/^agg-(.+?)::(.+?)::(.*)$/);
      if (!keyMatch) return;

      const issueId = keyMatch[1] === "null" ? null : parseInt(keyMatch[1], 10);
      const activityId = keyMatch[2] === "null" ? null : parseInt(keyMatch[2], 10);
      const comments = keyMatch[3] || null;

      // Find all source rows that match this aggregation key
      const sourceRows = this._rows.filter(r =>
        r.issueId === issueId &&
        r.activityId === activityId &&
        (r.comments ?? "") === (comments ?? "")
      );

      if (sourceRows.length === 0) return;

      // Use first source row for metadata, aggregate hours
      row = sourceRows[0];
      for (const srcRow of sourceRows) {
        for (let i = 0; i < 7; i++) {
          totalHoursPerDay[i] += srcRow.days[i]?.hours ?? 0;
        }
      }
    } else {
      row = this._rows.find((r) => r.id === rowId);
      if (!row) return;
      for (let i = 0; i < 7; i++) {
        totalHoursPerDay[i] = row.days[i]?.hours ?? 0;
      }
    }

    const newRow = this._createEmptyRow();
    newRow.parentProjectId = row.parentProjectId;
    newRow.parentProjectName = row.parentProjectName;
    newRow.projectId = row.projectId;
    newRow.projectName = row.projectName;
    newRow.issueId = row.issueId;
    newRow.issueSubject = row.issueSubject;
    newRow.activityId = row.activityId;
    newRow.activityName = row.activityName;
    newRow.comments = row.comments;
    // Copy hours but mark as dirty (new entries)
    for (let i = 0; i < 7; i++) {
      const hours = totalHoursPerDay[i];
      newRow.days[i] = {
        hours,
        originalHours: 0, // New row has no server entry
        entryId: null,
        isDirty: hours !== 0,
      };
    }
    newRow.weekTotal = totalHoursPerDay.reduce((sum, h) => sum + h, 0);

    this._rows.push(newRow);
    this._postRenderMessage();
    // Send rowDuplicated for undo/redo support
    this._postMessage({
      type: "rowDuplicated",
      sourceRowId: rowId,
      newRowId: newRow.id,
    });
  }

  private async _updateCell(rowId: string, dayIndex: number, hours: number): Promise<void> {
    const row = this._rows.find((r) => r.id === rowId);
    if (!row) return;

    const existingCell = row.days[dayIndex];
    const originalHours = existingCell?.originalHours ?? 0;
    const entryId = existingCell?.entryId ?? null;
    const isDirty = hours !== originalHours;

    row.days[dayIndex] = {
      hours,
      originalHours,
      entryId,
      isDirty,
    };
    row.weekTotal = Object.values(row.days).reduce((sum, cell) => sum + cell.hours, 0);

    // Queue operation to draft queue if draft mode enabled
    await this._queueCellOperation(row, dayIndex, hours, entryId, isDirty);

    // Save new rows to persistent storage
    if (row.isNew) {
      this._saveIncompleteRows();
    }

    const totals = this._calculateTotals();
    this._postMessage({
      type: "updateRow",
      row,
      totals,
      rowCascadeData: this._getRowCascadeData(row),
    });
  }

  /** Queue a cell change to the draft queue */
  private async _queueCellOperation(
    row: TimeSheetRow,
    dayIndex: number,
    hours: number,
    entryId: number | null,
    isDirty: boolean
  ): Promise<void> {
    console.log("[Timesheet] _queueCellOperation called:", {
      rowId: row.id,
      dayIndex,
      hours,
      entryId,
      isDirty,
      issueId: row.issueId,
      activityId: row.activityId,
      draftQueue: !!this._draftQueue,
      draftModeEnabled: this._draftModeManager?.isEnabled,
    });
    if (!this._draftQueue || !this._draftModeManager?.isEnabled) {
      console.log("[Timesheet] Skipping: draftQueue or draftMode not available");
      return;
    }
    if (!row.issueId || !row.activityId) {
      console.log("[Timesheet] Skipping: missing issueId or activityId");
      return;
    }

    const date = this._currentWeek.dayDates[dayIndex];
    // Use canonical resourceKey: entryId for existing, or issueId:activityId:date for new
    // This ensures consistency between aggregate mode and normal mode
    const resourceKey = entryId
      ? `ts:timeentry:${entryId}`
      : `ts:timeentry:new:${row.issueId}:${row.activityId}:${date}`;

    // If not dirty (restored to original), remove any pending operation
    if (!isDirty) {
      await this._draftQueue.removeByKey(resourceKey, TIMESHEET_SOURCE);
      return;
    }

    if (entryId) {
      // Existing entry
      if (hours > 0) {
        // Update
        await this._draftQueue.add({
          id: generateDraftId(),
          type: "updateTimeEntry",
          timestamp: Date.now(),
          resourceId: entryId,
          issueId: row.issueId,
          description: `Update #${row.issueId} on ${date}: ${hours}h`,
          http: {
            method: "PUT",
            path: `/time_entries/${entryId}.json`,
            data: {
              time_entry: {
                hours,
                activity_id: row.activityId,
                comments: row.comments ?? "",
              },
            },
          },
          resourceKey,
        }, TIMESHEET_SOURCE);
      } else {
        // Delete (hours = 0)
        await this._draftQueue.add({
          id: generateDraftId(),
          type: "deleteTimeEntry",
          timestamp: Date.now(),
          resourceId: entryId,
          description: `Delete time entry on ${date}`,
          http: {
            method: "DELETE",
            path: `/time_entries/${entryId}.json`,
          },
          resourceKey,
        }, TIMESHEET_SOURCE);
      }
    } else if (hours > 0) {
      // New entry (no entryId, hours > 0)
      const operation = {
        id: generateDraftId(),
        type: "createTimeEntry" as const,
        timestamp: Date.now(),
        issueId: row.issueId,
        tempId: `${row.id}:${dayIndex}`,
        description: `Log ${hours}h to #${row.issueId} on ${date}`,
        http: {
          method: "POST" as const,
          path: "/time_entries.json",
          data: {
            time_entry: {
              issue_id: row.issueId,
              hours,
              activity_id: row.activityId,
              spent_on: date,
              comments: row.comments ?? "",
            },
          },
        },
        resourceKey,
      };
      console.log("[Timesheet] Adding createTimeEntry operation:", operation);
      await this._draftQueue.add(operation, TIMESHEET_SOURCE);
    } else {
      // No entryId and hours = 0 → remove pending create if exists
      await this._draftQueue.removeByKey(resourceKey, TIMESHEET_SOURCE);
    }
  }

  private async _updateRowField(
    rowId: string,
    field: "parentProject" | "project" | "issue" | "activity" | "comments",
    value: number | string | null
  ): Promise<void> {
    const row = this._rows.find((r) => r.id === rowId);
    if (!row) return;

    if (field === "parentProject") {
      const numValue = value as number | null;
      row.parentProjectId = numValue;
      row.parentProjectName = this._parentProjects.find((p) => p.id === numValue)?.name ?? null;
      // Reset project/issue/activity when parent changes
      row.projectId = null;
      row.projectName = null;
      row.issueId = null;
      row.issueSubject = null;
      row.activityId = null;
      row.activityName = null;
      // Mark all cells as dirty
      for (const cell of Object.values(row.days)) {
        cell.isDirty = true;
      }
      // Send child projects for this parent
      if (numValue !== null) {
        this._sendChildProjects(numValue);
      }
    } else if (field === "project") {
      const numValue = value as number | null;
      row.projectId = numValue;
      row.projectName = this._projects.find((p) => p.id === numValue)?.name ?? null;
      // Reset issue and activity when project changes
      row.issueId = null;
      row.issueSubject = null;
      row.activityId = null;
      row.activityName = null;
      // Mark all cells as dirty
      for (const cell of Object.values(row.days)) {
        cell.isDirty = true;
      }
      // Load activities and issues for new project in parallel
      if (numValue) {
        void this._loadProjectData(numValue);
      }
    } else if (field === "issue") {
      const numValue = value as number | null;
      row.issueId = numValue;
      const issues = this._issuesByProject.get(row.projectId ?? 0) ?? [];
      row.issueSubject = issues.find((i) => i.id === numValue)?.subject ?? null;
      for (const cell of Object.values(row.days)) {
        cell.isDirty = true;
      }
    } else if (field === "activity") {
      row.activityId = value as number | null;
      const activities = this._activitiesByProject.get(row.projectId ?? 0) ?? [];
      row.activityName = activities.find((a) => a.id === value)?.name ?? null;
      for (const cell of Object.values(row.days)) {
        cell.isDirty = true;
      }
    } else if (field === "comments") {
      const newComment = value as string | null;
      const isRevertingToOriginal = (newComment ?? "") === (row.originalComments ?? "");
      console.log("[Timesheet] _updateRowField comments:", { newComment, originalComments: row.originalComments, isRevertingToOriginal });
      row.comments = newComment;

      if (isRevertingToOriginal) {
        // Reverting to original - check each cell and remove drafts if fully reverted
        for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
          const cell = row.days[dayIndex];
          if (cell && cell.entryId && cell.hours === cell.originalHours) {
            // Cell is back to original state - mark clean and remove draft
            cell.isDirty = false;
            const resourceKey = `ts:timeentry:${cell.entryId}`;
            console.log("[Timesheet] Reverting to original, removing draft:", resourceKey);
            await this._draftQueue?.removeByKey(resourceKey, TIMESHEET_SOURCE);
          } else if (cell) {
            // Hours changed or no entryId - still dirty
            cell.isDirty = true;
          }
        }
      } else {
        // New comment value - mark all cells dirty
        for (const cell of Object.values(row.days)) {
          cell.isDirty = true;
        }
      }
    }

    // Queue all dirty cells if row is now complete (has issue + activity)
    console.log("[Timesheet] _updateRowField: checking if row is complete", {
      rowId: row.id,
      issueId: row.issueId,
      activityId: row.activityId,
      weekTotal: row.weekTotal,
      isNew: row.isNew,
    });
    if (row.issueId && row.activityId) {
      console.log("[Timesheet] Row is complete, queueing dirty cells");
      for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        const cell = row.days[dayIndex];
        if (cell && cell.isDirty && cell.hours > 0) {
          console.log("[Timesheet] Queueing cell:", { dayIndex, hours: cell.hours, isDirty: cell.isDirty });
          await this._queueCellOperation(row, dayIndex, cell.hours, cell.entryId, true);
        }
      }
      // Row is now complete - clear from incomplete storage (will be saved via draft queue)
      if (row.isNew) {
        this._clearCompletedRow(row.id);
      }
    } else if (row.isNew) {
      // Row is still incomplete - save to storage
      this._saveIncompleteRows();
    }

    const totals = this._calculateTotals();
    this._postMessage({
      type: "updateRow",
      row,
      totals,
      rowCascadeData: this._getRowCascadeData(row),
    });
  }

  private async _loadIssuesForProject(projectId: number, forceRefresh = false): Promise<void> {
    if (!this._server) return;

    // Return cached data immediately if available
    if (!forceRefresh && this._issuesByProject.has(projectId)) {
      const cached = this._issuesByProject.get(projectId)!;
      this._postMessage({ type: "updateIssues", issues: cached, forProjectId: projectId });
      return;
    }

    // Try to use cached issues from sidebar (already loaded)
    if (!forceRefresh && this._getCachedIssues) {
      const cachedIssues = this._getCachedIssues();
      const matchingIssues = cachedIssues.filter((i) => i.project?.id === projectId);
      if (matchingIssues.length > 0) {
        const issues: IssueOption[] = matchingIssues.map((i) => ({
          id: i.id,
          subject: i.subject,
          projectId: i.project?.id ?? projectId,
        }));
        this._issuesByProject.set(projectId, issues);
        this._postMessage({ type: "updateIssues", issues, forProjectId: projectId });
        return;
      }
    }

    try {
      // Pass false for includeSubprojects - user selected specific child project
      const result = await this._server.getOpenIssuesForProject(projectId, false, 50, false);
      const issues: IssueOption[] = result.issues.map((i) => ({
        id: i.id,
        subject: i.subject,
        projectId: i.project?.id ?? projectId,
      }));
      this._issuesByProject.set(projectId, issues);
      this._postMessage({ type: "updateIssues", issues, forProjectId: projectId });
    } catch (_err) {
      // Silent fail - issues dropdown stays empty, user can retry or use issue picker
    }
  }

  private async _loadActivitiesForProject(projectId: number, forceRefresh = false): Promise<void> {
    if (!this._server) return;

    // Return cached data immediately if available
    if (!forceRefresh && this._activitiesByProject.has(projectId)) {
      const cached = this._activitiesByProject.get(projectId)!;
      this._postMessage({ type: "updateActivities", activities: cached, forProjectId: projectId });
      return;
    }

    try {
      const activities = await this._server.getProjectTimeEntryActivities(projectId);
      const activityOptions: ActivityOption[] = activities.map((a) => ({
        id: a.id,
        name: a.name,
        isDefault: a.is_default ?? false,
      }));
      this._activitiesByProject.set(projectId, activityOptions);
      this._postMessage({ type: "updateActivities", activities: activityOptions, forProjectId: projectId });
    } catch (_err) {
      // Silent fail - activities dropdown stays empty, user can retry by re-selecting project
    }
  }

  /** Load issues and activities for a project in parallel */
  private async _loadProjectData(projectId: number): Promise<void> {
    await Promise.all([
      this._loadIssuesForProject(projectId),
      this._loadActivitiesForProject(projectId),
    ]);
  }

  /** Fetch and send issue details for tooltip display */
  private async _loadIssueDetails(issueId: number): Promise<void> {
    if (!this._server) return;

    // Return cached if available
    if (this._issueDetailsCache.has(issueId)) {
      const cached = this._issueDetailsCache.get(issueId)!;
      this._postMessage({ type: "updateIssueDetails", issueId, details: cached });
      return;
    }

    try {
      const { issue } = await this._server.getIssueById(issueId);
      const details: IssueDetails = {
        id: issue.id,
        subject: issue.subject,
        status: issue.status?.name ?? "Unknown",
        priority: issue.priority?.name ?? "Unknown",
        tracker: issue.tracker?.name ?? "Unknown",
        assignedTo: issue.assigned_to?.name ?? null,
        doneRatio: issue.done_ratio ?? 0,
        estimatedHours: issue.estimated_hours ?? null,
        spentHours: issue.spent_hours ?? null,
        startDate: issue.start_date ?? null,
        dueDate: issue.due_date ?? null,
        customFields: (issue.custom_fields ?? []).map((cf) => ({
          name: cf.name,
          value: Array.isArray(cf.value) ? cf.value.join(", ") : String(cf.value ?? ""),
        })).filter((cf) => cf.value !== ""),
      };
      this._issueDetailsCache.set(issueId, details);
      this._postMessage({ type: "updateIssueDetails", issueId, details });
    } catch (_err) {
      // Silent fail - tooltip won't show, core functionality unaffected
    }
  }

  /** Load issue details for all rows with issues */
  private async _loadAllIssueDetails(): Promise<void> {
    const issueIds = new Set<number>();
    for (const row of this._rows) {
      if (row.issueId !== null) {
        issueIds.add(row.issueId);
      }
    }
    // Load in parallel with proper error handling (errors logged, don't crash)
    await Promise.allSettled([...issueIds].map((id) => this._loadIssueDetails(id)));
  }

  private async _pickIssueForRow(rowId: string): Promise<void> {
    if (!this._server) return;

    const row = this._rows.find((r) => r.id === rowId);
    if (!row) return;

    // Use the searchable issue picker
    const issue = await pickIssue(this._server, "Select Issue for Time Entry");
    if (!issue) return;

    // Update row with selected issue
    row.issueId = issue.id;
    row.issueSubject = issue.subject;
    row.projectId = issue.project?.id ?? null;
    row.projectName = issue.project?.name ?? null;

    // Derive parentProjectId from project's parent
    const projectOpt = this._projects.find((p) => p.id === row.projectId);
    if (projectOpt?.parentId !== null && projectOpt?.parentId !== undefined) {
      // Has a parent - use it
      row.parentProjectId = projectOpt.parentId;
      row.parentProjectName = this._parentProjects.find((p) => p.id === projectOpt.parentId)?.name ?? null;
    } else if (row.projectId !== null) {
      // Orphan project - put in "Others"
      row.parentProjectId = OTHERS_PARENT_ID;
      row.parentProjectName = "Others";
    }

    // Mark cells as dirty
    for (const cell of Object.values(row.days)) {
      cell.isDirty = true;
    }

    // Load children for parent (so dropdown syncs)
    if (row.parentProjectId !== null) {
      this._sendChildProjects(row.parentProjectId);
    }

    // Load issues and activities for the issue's project in parallel
    if (row.projectId) {
      await this._loadProjectData(row.projectId);
    }

    const totals = this._calculateTotals();
    this._postMessage({
      type: "updateRow",
      row,
      totals,
      rowCascadeData: this._getRowCascadeData(row),
    });
  }

  private async _saveAll(): Promise<void> {
    if (!this._server || !this._draftQueue || !this._draftModeManager?.isEnabled) {
      this._postMessage({ type: "showError", message: "Draft mode not enabled" });
      return;
    }

    // Get only timesheet operations (ts: prefix)
    const operations = this._draftQueue.getByKeyPrefix("ts:");
    if (operations.length === 0) {
      showStatusBarMessage("$(info) No changes to save", 2000);
      return;
    }

    this._postMessage({ type: "setLoading", loading: true });

    try {
      let successCount = 0;
      let errorCount = 0;

      // Apply operations directly using the server
      for (const op of operations) {
        try {
          const { method, path, data } = op.http;
          if (method === "POST" && data) {
            await this._server.post(path, data);
          } else if (method === "PUT" && data) {
            await this._server.put(path, data);
          } else if (method === "DELETE") {
            await this._server.delete(path);
          }
          // Remove from queue after successful apply
          await this._draftQueue.remove(op.id, TIMESHEET_SOURCE);
          successCount++;
        } catch (error) {
          errorCount++;
          const msg = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`Failed: ${op.description} - ${msg}`);
        }
      }

      if (errorCount === 0) {
        showStatusBarMessage(`$(check) Saved ${successCount} entries`, 2000);
      } else {
        showStatusBarMessage(`$(warning) ${successCount} saved, ${errorCount} failed`, 3000);
      }

      // Reload week to get fresh data from server
      await this._loadWeek(this._currentWeek);

      // Sync sidebar time entries tree
      vscode.commands.executeCommand("redmyne.refreshTimeEntries");
    } catch (error) {
      this._postMessage({ type: "showError", message: `Failed to save: ${error}` });
    } finally {
      this._postMessage({ type: "setLoading", loading: false });
    }
  }

  private _copyWeek(): void {
    // Build weekMap: day offset (0=Mon) -> entries for that day
    const weekMap = new Map<number, ClipboardEntry[]>();
    const allEntries: ClipboardEntry[] = [];

    for (const row of this._rows) {
      // Skip rows without required fields
      if (!row.issueId || !row.activityId) continue;

      for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        const cell = row.days[dayIndex];
        if (!cell || cell.hours <= 0) continue;

        const entry: ClipboardEntry = {
          issue_id: row.issueId,
          activity_id: row.activityId,
          hours: String(cell.hours),
          comments: row.comments || "",
          project_id: row.projectId ?? undefined,
        };

        allEntries.push(entry);

        if (!weekMap.has(dayIndex)) {
          weekMap.set(dayIndex, []);
        }
        weekMap.get(dayIndex)!.push(entry);
      }
    }

    if (allEntries.length === 0) {
      showStatusBarMessage("$(warning) No entries to copy", 2000);
      return;
    }

    setClipboard({
      kind: "week",
      entries: allEntries,
      weekMap,
      sourceWeekStart: this._currentWeek.startDate,
    });

    showStatusBarMessage(`$(copy) Copied ${allEntries.length} entries`, 2000);
  }

  private async _pasteWeek(): Promise<void> {
    const clipboard = getClipboard();
    if (!clipboard || clipboard.kind !== "week" || !clipboard.weekMap) {
      showStatusBarMessage("$(warning) No week data to paste", 2000);
      return;
    }

    if (!this._draftQueue || !this._draftModeManager?.isEnabled) {
      showStatusBarMessage("$(warning) Draft mode required", 2000);
      return;
    }

    this._postMessage({ type: "setLoading", loading: true });

    try {
      let created = 0;
      const pastedDraftIds: string[] = [];

      // Paste entries for each day in the weekMap
      for (const [dayOffset, entries] of clipboard.weekMap) {
        const targetDate = this._currentWeek.dayDates[dayOffset];
        if (!targetDate) continue;

        for (const entry of entries) {
          const tempId = generateTempId("timeentry");
          const draftId = generateDraftId();
          // Use canonical resourceKey for new entries
          const resourceKey = `ts:timeentry:new:${entry.issue_id}:${entry.activity_id}:${targetDate}`;
          await this._draftQueue.add({
            id: draftId,
            type: "createTimeEntry",
            timestamp: Date.now(),
            issueId: entry.issue_id,
            tempId,
            description: `Log ${entry.hours}h to #${entry.issue_id} on ${targetDate}`,
            http: {
              method: "POST",
              path: "/time_entries.json",
              data: {
                time_entry: {
                  issue_id: entry.issue_id,
                  hours: parseFloat(entry.hours),
                  activity_id: entry.activity_id,
                  spent_on: targetDate,
                  comments: entry.comments,
                  project_id: entry.project_id,
                },
              },
            },
            resourceKey,
          }, TIMESHEET_SOURCE);
          pastedDraftIds.push(draftId);
          created++;
        }
      }

      showStatusBarMessage(`$(check) Pasted ${created} entries to draft`, 2000);

      // Reload week to show new entries
      await this._loadWeek(this._currentWeek);

      // Send undo data to webview
      if (pastedDraftIds.length > 0) {
        this._postMessage({
          type: "pasteComplete",
          draftIds: pastedDraftIds,
          count: created,
        });
      }
    } catch (error) {
      this._postMessage({ type: "showError", message: `Failed to paste: ${error}` });
    } finally {
      this._postMessage({ type: "setLoading", loading: false });
    }
  }

  private async _undoPaste(draftIds: string[]): Promise<void> {
    if (!this._draftQueue) return;

    // Remove each draft op by ID
    for (const draftId of draftIds) {
      await this._draftQueue.remove(draftId, TIMESHEET_SOURCE);
    }

    // Reload to reflect changes
    await this._loadWeek(this._currentWeek);
  }

  private async _enableDraftMode(): Promise<void> {
    // Execute the toggle draft mode command
    await vscode.commands.executeCommand("redmyne.toggleDraftMode");
  }

  /**
   * Handle editing an aggregated cell
   * Creates/updates/deletes entries based on source entries
   */
  private async _updateAggregatedCell(
    aggRowId: string,
    dayIndex: number,
    newHours: number,
    sourceEntries: Array<{ rowId: string; entryId: number | null; hours: number; originalHours: number; issueId: number; activityId: number; comments: string | null; spentOn: string; isDraft?: boolean }>,
    confirmed: boolean
  ): Promise<void> {
    if (!this._draftQueue || !this._draftModeManager?.isEnabled) return;

    const sourceCount = sourceEntries.length;

    // Multiple entries + not confirmed → request confirm via toast
    if (sourceCount > 1 && !confirmed) {
      const oldHours = sourceEntries.reduce((sum, e) => sum + e.hours, 0);
      this._postMessage({
        type: "requestAggregatedCellConfirm",
        aggRowId,
        dayIndex,
        newHours,
        oldHours,
        sourceEntryCount: sourceCount,
        sourceEntries,
      });
      return;
    }

    const date = this._currentWeek.dayDates[dayIndex];

    // Parse issueId, activityId, comments from aggRowId
    // Format: agg-{issueId}:{activityId}:{comments}
    const keyMatch = aggRowId.match(/^agg-(.+?)::(.+?)::(.*)$/);
    if (!keyMatch) return;

    const issueId = keyMatch[1] === "null" ? null : parseInt(keyMatch[1], 10);
    const activityId = keyMatch[2] === "null" ? null : parseInt(keyMatch[2], 10);
    const comments = keyMatch[3] || null;

    if (!issueId || !activityId) return;

    // Canonical resourceKey for new entries in this cell
    const newEntryResourceKey = `ts:timeentry:new:${issueId}:${activityId}:${date}`;

    if (sourceCount === 0 && newHours === 0) {
      // Empty cell set to 0 → remove any pending CREATE (e.g., undo of create)
      console.log("[Timesheet] _updateAggregatedCell: removing pending create for", newEntryResourceKey);
      await this._draftQueue.removeByKey(newEntryResourceKey, TIMESHEET_SOURCE);
      // Update local state
      this._updateAggregatedCellLocal(sourceEntries, dayIndex, newHours, issueId, activityId, comments);
      return;
    }

    if (sourceCount === 0 && newHours > 0) {
      // Empty cell → create new entry
      // Use canonical resourceKey based on issueId:activityId:date (not rowId)
      const resourceKey = newEntryResourceKey;
      await this._draftQueue.add({
        id: generateDraftId(),
        type: "createTimeEntry",
        timestamp: Date.now(),
        issueId,
        tempId: `${aggRowId}:${dayIndex}`,
        description: `Log ${newHours}h to #${issueId} on ${date}`,
        http: {
          method: "POST",
          path: "/time_entries.json",
          data: {
            time_entry: {
              issue_id: issueId,
              hours: newHours,
              activity_id: activityId,
              spent_on: date,
              comments: comments ?? "",
            },
          },
        },
        resourceKey,
      }, TIMESHEET_SOURCE);
    } else if (sourceCount === 1) {
      const entry = sourceEntries[0];
      if (entry.isDraft || entry.entryId === null) {
        // Draft entry (not saved to server yet)
        // Use canonical resourceKey based on issueId:activityId:date (not rowId)
        const resourceKey = `ts:timeentry:new:${entry.issueId}:${entry.activityId}:${date}`;
        if (newHours > 0) {
          // Update draft → replace pending CREATE with new hours
          await this._draftQueue.add({
            id: generateDraftId(),
            type: "createTimeEntry",
            timestamp: Date.now(),
            issueId: entry.issueId,
            tempId: `${entry.rowId}:${dayIndex}`,
            description: `Log ${newHours}h to #${entry.issueId} on ${date}`,
            http: {
              method: "POST",
              path: "/time_entries.json",
              data: {
                time_entry: {
                  issue_id: entry.issueId,
                  hours: newHours,
                  activity_id: entry.activityId,
                  spent_on: date,
                  comments: entry.comments ?? "",
                },
              },
            },
            resourceKey,
          }, TIMESHEET_SOURCE);
        } else {
          // Delete draft → remove pending CREATE
          await this._draftQueue.removeByKey(resourceKey, TIMESHEET_SOURCE);
        }
      } else if (newHours === entry.originalHours) {
        // Single saved entry + same as original → remove any pending operation (reverted to original)
        await this._draftQueue.removeByKey(`ts:timeentry:${entry.entryId}`, TIMESHEET_SOURCE);
      } else if (newHours > 0) {
        // Single saved entry → update
        await this._draftQueue.add({
          id: generateDraftId(),
          type: "updateTimeEntry",
          timestamp: Date.now(),
          resourceId: entry.entryId!,
          issueId: entry.issueId,
          description: `Update #${entry.issueId} on ${date}: ${newHours}h`,
          http: {
            method: "PUT",
            path: `/time_entries/${entry.entryId}.json`,
            data: {
              time_entry: {
                hours: newHours,
                activity_id: entry.activityId,
                comments: entry.comments ?? "",
              },
            },
          },
          resourceKey: `ts:timeentry:${entry.entryId}`,
        }, TIMESHEET_SOURCE);
      } else {
        // Single saved entry + 0h → delete
        await this._draftQueue.add({
          id: generateDraftId(),
          type: "deleteTimeEntry",
          timestamp: Date.now(),
          resourceId: entry.entryId!,
          description: `Delete time entry on ${date}`,
          http: {
            method: "DELETE",
            path: `/time_entries/${entry.entryId}.json`,
          },
          resourceKey: `ts:timeentry:${entry.entryId}`,
        }, TIMESHEET_SOURCE);
      }
    } else {
      // Multiple entries → delete/remove all, create one (if hours > 0)
      for (const entry of sourceEntries) {
        if (entry.isDraft || entry.entryId === null) {
          // Draft entry → remove pending CREATE using canonical resourceKey
          const resourceKey = `ts:timeentry:new:${entry.issueId}:${entry.activityId}:${date}`;
          await this._draftQueue.removeByKey(resourceKey, TIMESHEET_SOURCE);
        } else {
          // Saved entry → queue DELETE
          await this._draftQueue.add({
            id: generateDraftId(),
            type: "deleteTimeEntry",
            timestamp: Date.now(),
            resourceId: entry.entryId,
            description: `Delete time entry #${entry.entryId}`,
            http: {
              method: "DELETE",
              path: `/time_entries/${entry.entryId}.json`,
            },
            resourceKey: `ts:timeentry:${entry.entryId}`,
          }, TIMESHEET_SOURCE);
        }
      }

      if (newHours > 0) {
        // Use canonical resourceKey for new entries
        const resourceKey = `ts:timeentry:new:${issueId}:${activityId}:${date}`;
        await this._draftQueue.add({
          id: generateDraftId(),
          type: "createTimeEntry",
          timestamp: Date.now(),
          issueId,
          tempId: `${aggRowId}:${dayIndex}:new`,
          description: `Log ${newHours}h to #${issueId} on ${date}`,
          http: {
            method: "POST",
            path: "/time_entries.json",
            data: {
              time_entry: {
                issue_id: issueId,
                hours: newHours,
                activity_id: activityId,
                spent_on: date,
                comments: comments ?? "",
              },
            },
          },
          resourceKey,
        }, TIMESHEET_SOURCE);
      }
    }

    // Update local state instead of reloading (draft entries aren't on server yet)
    this._updateAggregatedCellLocal(sourceEntries, dayIndex, newHours, issueId, activityId, comments);
  }

  /** Update local row state for aggregated cell edit */
  private _updateAggregatedCellLocal(
    sourceEntries: Array<{ rowId: string; entryId: number | null; hours: number; originalHours?: number }>,
    dayIndex: number,
    newHours: number,
    issueId: number,
    activityId: number,
    comments: string | null
  ): void {
    // Find project info from existing rows with same issueId
    const existingRow = this._rows.find(r => r.issueId === issueId);
    const projectId = existingRow?.projectId ?? null;
    const projectName = existingRow?.projectName ?? null;
    const parentProjectId = existingRow?.parentProjectId ?? null;
    const parentProjectName = existingRow?.parentProjectName ?? null;
    const issueSubject = existingRow?.issueSubject ?? null;
    const activityName = existingRow?.activityName ?? null;

    if (sourceEntries.length === 0 && newHours === 0) {
      // Undo of create: find and remove/zero-out any new row for this issue/activity/day
      const newRowIndex = this._rows.findIndex(r =>
        r.isNew &&
        r.issueId === issueId &&
        r.activityId === activityId &&
        r.days[dayIndex]?.entryId === null &&
        r.days[dayIndex]?.hours > 0
      );
      if (newRowIndex !== -1) {
        const row = this._rows[newRowIndex];
        // Set hours to 0 for this day
        row.days[dayIndex] = { hours: 0, originalHours: 0, entryId: null, isDirty: false };
        row.weekTotal = Object.values(row.days).reduce((sum, cell) => sum + cell.hours, 0);
        // Remove row if it has no hours at all
        if (row.weekTotal === 0) {
          this._rows.splice(newRowIndex, 1);
          this._clearCompletedRow(row.id);
        }
      }
    } else if (sourceEntries.length === 0 && newHours > 0) {
      // Create new row for this entry
      const newRow = this._createEmptyRow();
      newRow.issueId = issueId;
      newRow.activityId = activityId;
      newRow.comments = comments ?? "";
      newRow.projectId = projectId;
      newRow.projectName = projectName;
      newRow.parentProjectId = parentProjectId;
      newRow.parentProjectName = parentProjectName;
      newRow.issueSubject = issueSubject;
      newRow.activityName = activityName;
      newRow.days[dayIndex] = { hours: newHours, originalHours: 0, entryId: null, isDirty: true };
      newRow.weekTotal = newHours;
      this._rows.push(newRow);
      this._saveIncompleteRows();
    } else if (sourceEntries.length === 1) {
      // Update or delete the single source row
      const entry = sourceEntries[0];
      const row = this._rows.find(r => r.id === entry.rowId);
      if (row) {
        row.days[dayIndex] = {
          hours: newHours,
          originalHours: row.days[dayIndex]?.originalHours ?? entry.hours,
          entryId: entry.entryId,
          isDirty: newHours !== (row.days[dayIndex]?.originalHours ?? entry.hours),
        };
        row.weekTotal = Object.values(row.days).reduce((sum, cell) => sum + cell.hours, 0);
      }
    } else {
      // Multiple entries → mark all as deleted (hours=0), create new if needed
      for (const entry of sourceEntries) {
        const row = this._rows.find(r => r.id === entry.rowId);
        if (row) {
          row.days[dayIndex] = {
            hours: 0,
            originalHours: row.days[dayIndex]?.originalHours ?? entry.hours,
            entryId: entry.entryId,
            isDirty: true,
          };
          row.weekTotal = Object.values(row.days).reduce((sum, cell) => sum + cell.hours, 0);
        }
      }
      // Create new entry if hours > 0
      if (newHours > 0) {
        const newRow = this._createEmptyRow();
        newRow.issueId = issueId;
        newRow.activityId = activityId;
        newRow.comments = comments ?? "";
        newRow.projectId = projectId;
        newRow.projectName = projectName;
        newRow.parentProjectId = parentProjectId;
        newRow.parentProjectName = parentProjectName;
        newRow.issueSubject = issueSubject;
        newRow.activityName = activityName;
        newRow.days[dayIndex] = { hours: newHours, originalHours: 0, entryId: null, isDirty: true };
        newRow.weekTotal = newHours;
        this._rows.push(newRow);
        this._saveIncompleteRows();
      }
    }

    // Re-render with updated state
    this._postRenderMessage();
  }

  /**
   * Handle updating a field on all source entries of an aggregated row
   */
  private async _updateAggregatedField(
    aggRowId: string,
    field: "parentProject" | "project" | "issue" | "activity" | "comments",
    value: number | string | null,
    sourceRowIds: string[],
    confirmed: boolean
  ): Promise<void> {
    console.log("[Timesheet] _updateAggregatedField:", { aggRowId, field, value, sourceRowIds, confirmed });
    if (!this._draftQueue || !this._draftModeManager?.isEnabled) {
      console.log("[Timesheet] _updateAggregatedField: draft mode not enabled, skipping");
      return;
    }

    // Find all source rows
    const sourceRows = this._rows.filter(r => sourceRowIds.includes(r.id));
    console.log("[Timesheet] _updateAggregatedField: found sourceRows:", sourceRows.length);
    if (sourceRows.length === 0) return;

    // Get old value from first source row for undo
    const oldValue = this._getFieldValue(sourceRows[0], field);
    console.log("[Timesheet] _updateAggregatedField: oldValue=", oldValue, "newValue=", value);

    // If multiple source rows and not confirmed, request confirm via toast
    if (sourceRows.length > 1 && !confirmed) {
      console.log("[Timesheet] _updateAggregatedField: requesting confirmation for", sourceRows.length, "entries");
      this._postMessage({
        type: "requestAggregatedFieldConfirm",
        aggRowId,
        field,
        value,
        oldValue,
        sourceRowIds,
        sourceEntryCount: sourceRows.length,
      });
      return;
    }

    // Apply field update to all source rows
    console.log("[Timesheet] _updateAggregatedField: applying field update to", sourceRows.length, "rows");
    for (const row of sourceRows) {
      await this._updateRowField(row.id, field, value);
    }

    // Show toast
    this._postMessage({
      type: "showToast",
      message: `Updated ${sourceRows.length} entries`,
      duration: 3000,
    });
  }

  /**
   * Get field value from row
   */
  private _getFieldValue(row: TimeSheetRow, field: "parentProject" | "project" | "issue" | "activity" | "comments"): number | string | null {
    switch (field) {
      case "parentProject": return row.parentProjectId;
      case "project": return row.projectId;
      case "issue": return row.issueId;
      case "activity": return row.activityId;
      case "comments": return row.comments;
      default: return null;
    }
  }

  /**
   * Restore original entries (undo for aggregated cell edit)
   */
  private async _restoreAggregatedEntries(
    entries: Array<{ rowId: string; entryId: number; hours: number; issueId: number; activityId: number; comments: string | null; spentOn: string }>,
    aggRowId: string,
    dayIndex: number
  ): Promise<void> {
    if (!this._draftQueue || !this._draftModeManager?.isEnabled) return;

    // First, remove any pending operations for this cell
    const tempKey = `${aggRowId}:${dayIndex}`;
    await this._draftQueue.removeByKey(`ts:timeentry:${tempKey}`, TIMESHEET_SOURCE);
    await this._draftQueue.removeByKey(`ts:timeentry:${tempKey}:new`, TIMESHEET_SOURCE);

    // Remove delete operations for original entries
    for (const entry of entries) {
      await this._draftQueue.removeByKey(`ts:timeentry:${entry.entryId}`, TIMESHEET_SOURCE);
    }

    // Reload to show original state
    await this._loadWeek(this._currentWeek);

    // Show toast
    this._postMessage({
      type: "showToast",
      message: "Restored original entries",
      duration: 3000,
    });
  }

  /**
   * Update individual entry from expanded cell dropdown
   */
  private async _updateExpandedEntry(
    rowId: string,
    entryId: number,
    dayIndex: number,
    newHours: number
  ): Promise<void> {
    if (!this._draftQueue || !this._draftModeManager?.isEnabled) return;

    // Find the original row
    const row = this._rows.find(r => r.id === rowId);
    if (!row) return;

    if (newHours > 0) {
      // Update entry
      await this._draftQueue.add({
        id: generateDraftId(),
        type: "updateTimeEntry",
        timestamp: Date.now(),
        resourceId: entryId,
        description: `Update time entry ${entryId} to ${newHours}h`,
        resourceKey: `ts:timeentry:${entryId}`,
        http: {
          method: "PUT",
          path: `/time_entries/${entryId}.json`,
          data: { time_entry: { hours: newHours } },
        },
      }, TIMESHEET_SOURCE);
    } else {
      // Delete entry (hours = 0)
      await this._draftQueue.add({
        id: generateDraftId(),
        type: "deleteTimeEntry",
        timestamp: Date.now(),
        resourceId: entryId,
        description: `Delete time entry ${entryId}`,
        resourceKey: `ts:timeentry:${entryId}`,
        http: {
          method: "DELETE",
          path: `/time_entries/${entryId}.json`,
        },
      }, TIMESHEET_SOURCE);
    }

    // Reload to reflect changes
    await this._loadWeek(this._currentWeek);
  }

  /**
   * Delete individual entry from expanded cell dropdown
   */
  private async _deleteExpandedEntry(
    rowId: string,
    entryId: number,
    aggRowId: string,
    dayIndex: number
  ): Promise<void> {
    if (!this._draftQueue || !this._draftModeManager?.isEnabled) return;

    // Queue delete operation
    await this._draftQueue.add({
      id: generateDraftId(),
      type: "deleteTimeEntry",
      timestamp: Date.now(),
      resourceId: entryId,
      description: `Delete time entry ${entryId}`,
      resourceKey: `ts:timeentry:${entryId}`,
      http: {
        method: "DELETE",
        path: `/time_entries/${entryId}.json`,
      },
    }, TIMESHEET_SOURCE);

    // Reload to reflect changes
    await this._loadWeek(this._currentWeek);
  }

  /**
   * Merge multiple entries into one (sum hours, keep first entry, delete rest)
   */
  private async _mergeEntries(
    aggRowId: string,
    dayIndex: number,
    sourceEntries: Array<{
      entryId: number;
      hours: number;
      rowId: string;
      issueId: number;
      activityId: number;
      comments: string;
      spentOn: string;
    }>
  ): Promise<void> {
    if (!this._draftQueue || !this._draftModeManager?.isEnabled) {
      this._postMessage({ type: "showError", message: "Draft mode required for merge" });
      return;
    }

    if (sourceEntries.length < 2) return;

    // Sort by entryId to keep oldest (lowest ID) as target
    const sorted = [...sourceEntries].sort((a, b) => a.entryId - b.entryId);
    const targetEntry = sorted[0];
    const entriesToDelete = sorted.slice(1);

    // Sum all hours
    const totalHours = sourceEntries.reduce((sum, e) => sum + e.hours, 0);

    // Queue update for target entry with total hours
    await this._draftQueue.add({
      id: generateDraftId(),
      type: "updateTimeEntry",
      timestamp: Date.now(),
      resourceId: targetEntry.entryId,
      description: `Merge ${sourceEntries.length} entries → ${totalHours}h`,
      resourceKey: `ts:timeentry:${targetEntry.entryId}`,
      http: {
        method: "PUT",
        path: `/time_entries/${targetEntry.entryId}.json`,
        data: { time_entry: { hours: totalHours } },
      },
    }, TIMESHEET_SOURCE);

    // Queue delete for all other entries
    for (const entry of entriesToDelete) {
      await this._draftQueue.add({
        id: generateDraftId(),
        type: "deleteTimeEntry",
        timestamp: Date.now(),
        resourceId: entry.entryId,
        description: `Delete merged entry ${entry.entryId}`,
        resourceKey: `ts:timeentry:${entry.entryId}`,
        http: {
          method: "DELETE",
          path: `/time_entries/${entry.entryId}.json`,
        },
      }, TIMESHEET_SOURCE);
    }

    // Show toast
    showStatusBarMessage(`$(git-merge) Merged ${sourceEntries.length} entries (${totalHours}h)`, 3000);

    // Reload to reflect changes
    await this._loadWeek(this._currentWeek);
  }

  private _getHtml(): string {
    const webview = this._panel.webview;
    const commonCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "webview-common.css")
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "timesheet.css")
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "timesheet.js")
    );
    const flatpickrCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "flatpickr.min.css")
    );
    const flatpickrJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "flatpickr.min.js")
    );
    const weekSelectJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "flatpickr-weekSelect.js")
    );
    const nonce = this._getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link href="${flatpickrCssUri}" rel="stylesheet">
  <link href="${commonCssUri}" rel="stylesheet">
  <link href="${cssUri}" rel="stylesheet">
  <title>Time Sheet</title>
</head>
<body class="${this._draftModeManager?.isEnabled ? "" : "draft-mode-disabled"}">
  <div class="timesheet-container">
    <header class="timesheet-header">
      <select id="groupBySelect" class="native-select" data-tooltip="Group rows">
        <option value="none">No grouping</option>
        <option value="client">By client</option>
        <option value="project">By project</option>
        <option value="issue">By task</option>
        <option value="activity">By activity</option>
      </select>
      <label class="toolbar-checkbox" data-tooltip="View identical rows as one merged row">
        <input type="checkbox" id="aggregateToggle">
        <span>View as merged</span>
      </label>
      <div class="toolbar-spacer"></div>
      <button id="undoBtn" class="toolbar-btn" data-tooltip="Undo (Ctrl+Z)" disabled>↶</button>
      <button id="redoBtn" class="toolbar-btn" data-tooltip="Redo (Ctrl+Y)" disabled>↷</button>
      <div class="toolbar-separator"></div>
      <button id="copyWeekBtn" class="toolbar-btn text-btn" data-tooltip="Copy week">Copy</button>
      <button id="pasteWeekBtn" class="toolbar-btn text-btn" data-tooltip="Paste week">Paste</button>
      <div class="toolbar-separator"></div>
      <button id="prevWeek" class="toolbar-btn" data-tooltip="Previous week">‹</button>
      <span id="weekLabel" class="week-label-picker" data-tooltip="Click to pick week">Loading...</span>
      <input type="text" id="weekPickerInput" class="week-picker-input" readonly>
      <button id="nextWeek" class="toolbar-btn" data-tooltip="Next week">›</button>
      <button id="todayBtn" class="toolbar-btn text-btn" data-tooltip="Current week">T</button>
    </header>

    <div id="draftModeWarning" class="draft-mode-warning${this._draftModeManager?.isEnabled ? " hidden" : ""}">
      <span class="warning-icon">⚠️</span>
      <span class="warning-text">Draft Mode is disabled. Enable Draft Mode to edit time entries.</span>
      <button id="enableDraftModeBtn" class="enable-draft-btn">Enable Draft Mode</button>
    </div>

    <div class="timesheet-grid-container">
      <table class="timesheet-grid" id="grid">
        <thead>
          <tr>
            <th class="col-parent sortable" data-sort="client">Client</th>
            <th class="col-project sortable" data-sort="project">Project</th>
            <th class="col-task sortable" data-sort="task">Task</th>
            <th class="col-activity sortable" data-sort="activity">Activity</th>
            <th class="col-comments sortable" data-sort="comments">Comment</th>
            ${WEEKDAYS.map((d, i) => `<th class="col-day" data-day="${i}">${d}</th>`).join("")}
            <th class="col-total sortable" data-sort="total">Total</th>
            <th class="col-actions">Actions</th>
          </tr>
        </thead>
        <tbody id="gridBody">
          <tr class="loading-row">
            <td colspan="14">Loading...</td>
          </tr>
        </tbody>
        <tfoot>
          <tr id="totalsRow">
            <td class="col-parent"></td>
            <td class="col-project"></td>
            <td class="col-task"></td>
            <td class="col-activity"></td>
            <td class="col-comments"></td>
            ${WEEKDAYS.map((_, i) => `<td class="col-day total-cell" data-day="${i}"><div class="total-content"><span class="total-value">0</span><div class="progress-bar"><div class="progress-fill"></div></div></div></td>`).join("")}
            <td class="col-total total-cell" id="weekTotal">0</td>
            <td class="col-actions"></td>
          </tr>
        </tfoot>
      </table>
      <div id="addRowContainer" class="add-row-container">
        <button id="addEntryBtn" class="add-entry-btn">+ Add Time Entry...</button>
        <button id="saveBtn" class="save-btn">Save to Redmine Server</button>
      </div>
    </div>
  </div>

  <div id="loadingOverlay" class="loading-overlay hidden">
    <div class="spinner"></div>
  </div>

  <div id="issueTooltip" class="issue-tooltip" role="tooltip" aria-hidden="true">
    <div class="issue-tooltip-content"></div>
  </div>

  <div id="genericTooltip" class="generic-tooltip" role="tooltip" aria-hidden="true"></div>

  <script nonce="${nonce}" src="${flatpickrJsUri}"></script>
  <script nonce="${nonce}" src="${weekSelectJsUri}"></script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  private _getNonce(): string {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
