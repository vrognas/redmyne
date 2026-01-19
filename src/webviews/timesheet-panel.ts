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
import { generateTempId } from "../draft-mode/draft-operation";
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
} from "./timesheet-webview-messages";
import { startOfISOWeek } from "date-fns";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export class TimeSheetPanel {
  public static currentPanel: TimeSheetPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _context: vscode.ExtensionContext;
  private _server: RedmineServer | undefined;
  private _draftQueue: DraftQueue | undefined;
  private _draftModeManager: DraftModeManager | undefined;
  private _getCachedIssues: (() => Issue[]) | undefined;

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
    server: RedmineServer | undefined,
    draftQueue: DraftQueue | undefined,
    draftModeManager: DraftModeManager | undefined,
    getCachedIssues?: () => Issue[]
  ): TimeSheetPanel {
    const column = vscode.window.activeTextEditor?.viewColumn;

    // Auto-enable draft mode
    if (draftModeManager && !draftModeManager.isEnabled) {
      draftModeManager.enable();
      showStatusBarMessage("$(pencil) Draft Mode enabled", 2000);
    }

    // If panel exists, reveal it
    if (TimeSheetPanel.currentPanel) {
      TimeSheetPanel.currentPanel._panel.reveal(column);
      TimeSheetPanel.currentPanel._server = server;
      TimeSheetPanel.currentPanel._draftQueue = draftQueue;
      TimeSheetPanel.currentPanel._draftModeManager = draftModeManager;
      TimeSheetPanel.currentPanel._getCachedIssues = getCachedIssues;
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
      server,
      draftQueue,
      draftModeManager,
      getCachedIssues
    );
    return TimeSheetPanel.currentPanel;
  }

  public static restore(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    context: vscode.ExtensionContext,
    server: RedmineServer | undefined
  ): TimeSheetPanel {
    TimeSheetPanel.currentPanel = new TimeSheetPanel(panel, extensionUri, context, server);
    return TimeSheetPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    context: vscode.ExtensionContext,
    server: RedmineServer | undefined,
    draftQueue?: DraftQueue,
    draftModeManager?: DraftModeManager,
    getCachedIssues?: () => Issue[]
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._context = context;
    this._server = server;
    this._draftQueue = draftQueue;
    this._draftModeManager = draftModeManager;
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

      case "duplicateRow":
        this._duplicateRow(message.rowId);
        break;

      case "updateCell":
        this._updateCell(message.rowId, message.dayIndex, message.hours);
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
    }
  }

  private _postMessage(message: ExtensionToWebviewMessage): void {
    this._panel.webview.postMessage(message);
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

      // Send to webview
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
      });

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
    } catch {
      // Silent fail - projects will be empty
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
      days,
      isNew: true,
      weekTotal: 0,
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
    });
  }

  private async _deleteRow(rowId: string): Promise<void> {
    const rowIndex = this._rows.findIndex((r) => r.id === rowId);
    if (rowIndex === -1) return;

    const row = this._rows[rowIndex];

    // If not new, mark entries for deletion via draft queue
    if (!row.isNew && this._draftQueue && this._draftModeManager?.isEnabled) {
      for (const cell of Object.values(row.days)) {
        if (cell.entryId) {
          this._draftQueue.add({
            id: crypto.randomUUID(),
            type: "deleteTimeEntry",
            timestamp: Date.now(),
            resourceId: cell.entryId,
            description: `Delete time entry #${cell.entryId}`,
            http: {
              method: "DELETE",
              path: `/time_entries/${cell.entryId}.json`,
            },
            resourceKey: `ts:timeentry:${cell.entryId}`,
          });
        }
      }
    }

    this._rows.splice(rowIndex, 1);
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
    });
  }

  private _duplicateRow(rowId: string): void {
    const row = this._rows.find((r) => r.id === rowId);
    if (!row) return;

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
      const hours = row.days[i]?.hours ?? 0;
      newRow.days[i] = {
        hours,
        originalHours: 0, // New row has no server entry
        entryId: null,
        isDirty: hours !== 0,
      };
    }
    newRow.weekTotal = row.weekTotal;

    this._rows.push(newRow);
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
    });
  }

  private _updateCell(rowId: string, dayIndex: number, hours: number): void {
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
    this._queueCellOperation(row, dayIndex, hours, entryId, isDirty);

    const totals = this._calculateTotals();
    this._postMessage({ type: "updateRow", row, totals });
  }

  /** Queue a cell change to the draft queue */
  private _queueCellOperation(
    row: TimeSheetRow,
    dayIndex: number,
    hours: number,
    entryId: number | null,
    isDirty: boolean
  ): void {
    if (!this._draftQueue || !this._draftModeManager?.isEnabled) return;
    if (!row.issueId || !row.activityId) return;

    const date = this._currentWeek.dayDates[dayIndex];
    // Use consistent resourceKey with ts: prefix for timesheet operations
    const resourceKey = entryId
      ? `ts:timeentry:${entryId}`
      : `ts:timeentry:${row.id}:${dayIndex}`;

    // If not dirty (restored to original), remove any pending operation
    if (!isDirty) {
      this._draftQueue.removeByKey(resourceKey);
      return;
    }

    if (entryId) {
      // Existing entry
      if (hours > 0) {
        // Update
        this._draftQueue.add({
          id: crypto.randomUUID(),
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
        });
      } else {
        // Delete (hours = 0)
        this._draftQueue.add({
          id: crypto.randomUUID(),
          type: "deleteTimeEntry",
          timestamp: Date.now(),
          resourceId: entryId,
          description: `Delete time entry on ${date}`,
          http: {
            method: "DELETE",
            path: `/time_entries/${entryId}.json`,
          },
          resourceKey,
        });
      }
    } else if (hours > 0) {
      // New entry (no entryId, hours > 0)
      this._draftQueue.add({
        id: crypto.randomUUID(),
        type: "createTimeEntry",
        timestamp: Date.now(),
        issueId: row.issueId,
        tempId: `${row.id}:${dayIndex}`,
        description: `Log ${hours}h to #${row.issueId} on ${date}`,
        http: {
          method: "POST",
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
      });
    }
    // If no entryId and hours = 0, nothing to queue (or remove pending create)
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
      row.comments = value as string | null;
      for (const cell of Object.values(row.days)) {
        cell.isDirty = true;
      }
    }

    const totals = this._calculateTotals();
    this._postMessage({ type: "updateRow", row, totals });
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
    } catch {
      // Silent fail
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
    } catch {
      // Silent fail
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
    } catch {
      // Silent fail - tooltip just won't show
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
    // Load in parallel but don't await all (fire and forget)
    for (const issueId of issueIds) {
      this._loadIssueDetails(issueId);
    }
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
    this._postMessage({ type: "updateRow", row, totals });
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
          await this._draftQueue.remove(op.id);
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

      // Paste entries for each day in the weekMap
      for (const [dayOffset, entries] of clipboard.weekMap) {
        const targetDate = this._currentWeek.dayDates[dayOffset];
        if (!targetDate) continue;

        for (const entry of entries) {
          const tempId = generateTempId("timeentry");
          this._draftQueue.add({
            id: crypto.randomUUID(),
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
                },
              },
            },
            resourceKey: `ts:timeentry:${tempId}`,
          });
          created++;
        }
      }

      showStatusBarMessage(`$(check) Pasted ${created} entries to draft`, 2000);

      // Reload week to show new entries
      await this._loadWeek(this._currentWeek);
    } catch (error) {
      this._postMessage({ type: "showError", message: `Failed to paste: ${error}` });
    } finally {
      this._postMessage({ type: "setLoading", loading: false });
    }
  }

  private async _enableDraftMode(): Promise<void> {
    // Execute the toggle draft mode command
    await vscode.commands.executeCommand("redmyne.toggleDraftMode");
  }

  private _getHtml(): string {
    const webview = this._panel.webview;
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
  <link href="${cssUri}" rel="stylesheet">
  <title>Time Sheet</title>
</head>
<body>
  <div class="timesheet-container">
    <header class="timesheet-header">
      <div class="header-left">
        <h1>Time Sheet</h1>
        <select id="groupBySelect" class="toolbar-select" data-tooltip="Group by">
          <option value="none">No grouping</option>
          <option value="client">By Client</option>
          <option value="project">By Project</option>
          <option value="issue">By Task</option>
          <option value="activity">By Activity</option>
        </select>
        <label class="toolbar-checkbox" data-tooltip="Merge identical rows (same task+activity+comment)">
          <input type="checkbox" id="aggregateToggle">
          <span>Aggregate</span>
        </label>
        <div class="toolbar-separator"></div>
        <button id="undoBtn" class="toolbar-btn" disabled data-tooltip="Undo (Ctrl+Z)">↩ Undo</button>
        <button id="redoBtn" class="toolbar-btn" disabled data-tooltip="Redo (Ctrl+Shift+Z)">↪ Redo</button>
        <div class="toolbar-separator"></div>
        <button id="copyWeekBtn" class="toolbar-btn" data-tooltip="Copy week (Ctrl+C)">📋 Copy</button>
        <button id="pasteWeekBtn" class="toolbar-btn" data-tooltip="Paste week (Ctrl+V)">📥 Paste</button>
      </div>
      <div class="week-nav">
        <button id="prevWeek" class="nav-btn" data-tooltip="Previous week">‹</button>
        <span id="weekLabel" class="week-label-picker" data-tooltip="Click to pick a week">Loading...</span>
        <input type="text" id="weekPickerInput" class="week-picker-input" readonly>
        <button id="nextWeek" class="nav-btn" data-tooltip="Next week">›</button>
        <button id="todayBtn" class="nav-btn today-btn" data-tooltip="Go to current week">Today</button>
      </div>
    </header>

    <div id="draftModeWarning" class="draft-mode-warning">
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
      </div>
    </div>

    <footer class="timesheet-footer">
      <div class="footer-spacer"></div>
      <button id="saveBtn" class="save-btn">Save to Redmine Server</button>
    </footer>
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
