/**
 * TimeSheet Webview Panel
 * Week-by-week time entry editing grid
 */

import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { TimeEntry } from "../redmine/models/time-entry";
import { DraftQueue } from "../draft-mode/draft-queue";
import { DraftModeManager } from "../draft-mode/draft-mode-manager";
import { generateTempId } from "../draft-mode/draft-operation";
import { WeeklySchedule, DEFAULT_WEEKLY_SCHEDULE } from "../utilities/flexibility-calculator";
import { parseLocalDate, getLocalToday } from "../utilities/date-utils";
import { pickIssue } from "../utilities/issue-picker";
import { showStatusBarMessage } from "../utilities/status-bar";
import {
  TimeSheetRow,
  DayCell,
  WeekInfo,
  DailyTotals,
  ProjectOption,
  IssueOption,
  ActivityOption,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  buildWeekInfo,
} from "./timesheet-webview-messages";
import { startOfISOWeek } from "date-fns";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export class TimeSheetPanel {
  public static currentPanel: TimeSheetPanel | undefined;
  private static _globalState: vscode.Memento | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _server: RedmineServer | undefined;
  private _draftQueue: DraftQueue | undefined;
  private _draftModeManager: DraftModeManager | undefined;

  private _rows: TimeSheetRow[] = [];
  private _currentWeek: WeekInfo;
  private _projects: ProjectOption[] = [];
  private _issuesByProject: Map<number | null, IssueOption[]> = new Map();
  private _activitiesByProject: Map<number, ActivityOption[]> = new Map();
  private _disposables: vscode.Disposable[] = [];
  private _schedule: WeeklySchedule = DEFAULT_WEEKLY_SCHEDULE;

  public static initialize(globalState: vscode.Memento): void {
    TimeSheetPanel._globalState = globalState;
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    server: RedmineServer | undefined,
    draftQueue: DraftQueue | undefined,
    draftModeManager: DraftModeManager | undefined
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
      server,
      draftQueue,
      draftModeManager
    );
    return TimeSheetPanel.currentPanel;
  }

  public static restore(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    server: RedmineServer | undefined
  ): TimeSheetPanel {
    TimeSheetPanel.currentPanel = new TimeSheetPanel(panel, extensionUri, server);
    return TimeSheetPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    server: RedmineServer | undefined,
    draftQueue?: DraftQueue,
    draftModeManager?: DraftModeManager
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._server = server;
    this._draftQueue = draftQueue;
    this._draftModeManager = draftModeManager;

    // Initialize to current week
    const today = getLocalToday();
    const monday = startOfISOWeek(today);
    this._currentWeek = buildWeekInfo(monday);

    // Load schedule from config
    const scheduleConfig = vscode.workspace.getConfiguration("redmyne.workingHours");
    this._schedule = scheduleConfig.get<WeeklySchedule>("weeklySchedule", DEFAULT_WEEKLY_SCHEDULE);

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

      case "requestIssues":
        await this._loadIssuesForProject(message.projectId, message.query);
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

      // Calculate totals
      const totals = this._calculateTotals();

      // Send to webview
      this._postMessage({
        type: "render",
        rows: this._rows,
        week: this._currentWeek,
        totals,
        projects: this._projects,
        isDraftMode: this._draftModeManager?.isEnabled ?? false,
      });
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
      this._projects = projects.map((p) => ({
        id: p.id,
        name: p.name,
        path: p.name, // Could build full path with parent
      }));
    } catch {
      // Silent fail - projects will be empty
    }
  }

  private _entriesToRows(entries: TimeEntry[], week: WeekInfo): TimeSheetRow[] {
    // Group entries by issue+activity (each unique combo is a row)
    const rowMap = new Map<string, TimeSheetRow>();

    for (const entry of entries) {
      const key = `${entry.issue?.id ?? "none"}-${entry.activity?.id ?? 0}`;

      // Find day index (0=Mon, 6=Sun)
      const entryDate = entry.spent_on;
      const dayIndex = week.dayDates.indexOf(entryDate);
      if (dayIndex === -1) continue;

      let row = rowMap.get(key);
      if (!row) {
        row = this._createEmptyRow();
        row.id = `existing-${entry.id}`;
        row.projectId = entry.project?.id ?? null;
        row.projectName = entry.project?.name ?? null;
        row.issueId = entry.issue?.id ?? null;
        row.issueSubject = entry.issue?.name ?? null;
        row.activityId = entry.activity?.id ?? null;
        row.activityName = entry.activity?.name ?? null;
        row.isNew = false;
        rowMap.set(key, row);
      }

      // Add hours to the day cell
      row.days[dayIndex] = {
        hours: (row.days[dayIndex]?.hours ?? 0) + entry.hours,
        entryId: entry.id,
        isDirty: false,
      };
    }

    // Calculate week totals
    const rows = Array.from(rowMap.values());
    for (const row of rows) {
      row.weekTotal = Object.values(row.days).reduce((sum, cell) => sum + cell.hours, 0);
    }

    return rows;
  }

  private _createEmptyRow(): TimeSheetRow {
    const days: Record<number, DayCell> = {};
    for (let i = 0; i < 7; i++) {
      days[i] = { hours: 0, entryId: null, isDirty: false };
    }
    return {
      id: generateTempId("timeentry"),
      projectId: null,
      projectName: null,
      issueId: null,
      issueSubject: null,
      activityId: null,
      activityName: null,
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
      isDraftMode: this._draftModeManager?.isEnabled ?? false,
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
          this._draftQueue.enqueue({
            id: crypto.randomUUID(),
            type: "deleteTimeEntry",
            timestamp: Date.now(),
            resourceId: cell.entryId,
            description: `Delete time entry #${cell.entryId}`,
            http: {
              method: "DELETE",
              path: `/time_entries/${cell.entryId}.json`,
            },
            resourceKey: `timeentry:${cell.entryId}`,
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
      isDraftMode: this._draftModeManager?.isEnabled ?? false,
    });
  }

  private _duplicateRow(rowId: string): void {
    const row = this._rows.find((r) => r.id === rowId);
    if (!row) return;

    const newRow = this._createEmptyRow();
    newRow.projectId = row.projectId;
    newRow.projectName = row.projectName;
    newRow.issueId = row.issueId;
    newRow.issueSubject = row.issueSubject;
    newRow.activityId = row.activityId;
    newRow.activityName = row.activityName;
    // Copy hours but mark as dirty (new entries)
    for (let i = 0; i < 7; i++) {
      newRow.days[i] = {
        hours: row.days[i]?.hours ?? 0,
        entryId: null,
        isDirty: true,
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
      isDraftMode: this._draftModeManager?.isEnabled ?? false,
    });
  }

  private _updateCell(rowId: string, dayIndex: number, hours: number): void {
    const row = this._rows.find((r) => r.id === rowId);
    if (!row) return;

    row.days[dayIndex] = {
      hours,
      entryId: row.days[dayIndex]?.entryId ?? null,
      isDirty: true,
    };
    row.weekTotal = Object.values(row.days).reduce((sum, cell) => sum + cell.hours, 0);

    const totals = this._calculateTotals();
    this._postMessage({ type: "updateRow", row, totals });
  }

  private async _updateRowField(
    rowId: string,
    field: "project" | "issue" | "activity",
    value: number | null
  ): Promise<void> {
    const row = this._rows.find((r) => r.id === rowId);
    if (!row) return;

    if (field === "project") {
      row.projectId = value;
      row.projectName = this._projects.find((p) => p.id === value)?.name ?? null;
      // Reset issue and activity when project changes
      row.issueId = null;
      row.issueSubject = null;
      row.activityId = null;
      row.activityName = null;
      // Mark all cells as dirty
      for (const cell of Object.values(row.days)) {
        cell.isDirty = true;
      }
      // Load activities for new project
      if (value) {
        await this._loadActivitiesForProject(value);
      }
    } else if (field === "issue") {
      row.issueId = value;
      const issues = this._issuesByProject.get(row.projectId) ?? [];
      row.issueSubject = issues.find((i) => i.id === value)?.subject ?? null;
      for (const cell of Object.values(row.days)) {
        cell.isDirty = true;
      }
    } else if (field === "activity") {
      row.activityId = value;
      const activities = this._activitiesByProject.get(row.projectId ?? 0) ?? [];
      row.activityName = activities.find((a) => a.id === value)?.name ?? null;
      for (const cell of Object.values(row.days)) {
        cell.isDirty = true;
      }
    }

    const totals = this._calculateTotals();
    this._postMessage({ type: "updateRow", row, totals });
  }

  private async _loadIssuesForProject(
    projectId: number | null,
    _query?: string
  ): Promise<void> {
    if (!this._server) return;

    try {
      let issues: IssueOption[];
      if (projectId) {
        const result = await this._server.getOpenIssuesForProject(projectId, true, 50, false);
        issues = result.issues.map((i) => ({
          id: i.id,
          subject: i.subject,
          projectId: i.project?.id ?? projectId,
        }));
      } else {
        const result = await this._server.getIssuesAssignedToMe();
        issues = result.issues.map((i) => ({
          id: i.id,
          subject: i.subject,
          projectId: i.project?.id ?? 0,
        }));
      }
      this._issuesByProject.set(projectId, issues);
      this._postMessage({ type: "updateIssues", issues, forProjectId: projectId });
    } catch {
      // Silent fail
    }
  }

  private async _loadActivitiesForProject(projectId: number): Promise<void> {
    if (!this._server) return;

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

    // Mark cells as dirty
    for (const cell of Object.values(row.days)) {
      cell.isDirty = true;
    }

    // Load activities for the issue's project
    if (row.projectId) {
      await this._loadActivitiesForProject(row.projectId);
    }

    const totals = this._calculateTotals();
    this._postMessage({ type: "updateRow", row, totals });
  }

  private async _saveAll(): Promise<void> {
    if (!this._server || !this._draftQueue || !this._draftModeManager?.isEnabled) {
      this._postMessage({ type: "showError", message: "Draft mode not enabled" });
      return;
    }

    this._postMessage({ type: "setLoading", loading: true });

    try {
      // Collect all dirty cells and enqueue operations
      for (const row of this._rows) {
        if (!row.issueId || !row.activityId) continue;

        for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
          const cell = row.days[dayIndex];
          if (!cell.isDirty) continue;

          const date = this._currentWeek.dayDates[dayIndex];

          if (cell.entryId) {
            // Update existing entry
            if (cell.hours > 0) {
              this._draftQueue.enqueue({
                id: crypto.randomUUID(),
                type: "updateTimeEntry",
                timestamp: Date.now(),
                resourceId: cell.entryId,
                issueId: row.issueId,
                description: `Update time entry #${cell.entryId} to ${cell.hours}h`,
                http: {
                  method: "PUT",
                  path: `/time_entries/${cell.entryId}.json`,
                  data: {
                    time_entry: {
                      hours: cell.hours,
                      activity_id: row.activityId,
                    },
                  },
                },
                resourceKey: `timeentry:${cell.entryId}`,
              });
            } else {
              // Delete if hours = 0
              this._draftQueue.enqueue({
                id: crypto.randomUUID(),
                type: "deleteTimeEntry",
                timestamp: Date.now(),
                resourceId: cell.entryId,
                description: `Delete time entry #${cell.entryId}`,
                http: {
                  method: "DELETE",
                  path: `/time_entries/${cell.entryId}.json`,
                },
                resourceKey: `timeentry:${cell.entryId}`,
              });
            }
          } else if (cell.hours > 0) {
            // Create new entry
            const tempId = generateTempId("timeentry");
            this._draftQueue.enqueue({
              id: crypto.randomUUID(),
              type: "createTimeEntry",
              timestamp: Date.now(),
              issueId: row.issueId,
              tempId,
              description: `Log ${cell.hours}h to #${row.issueId} on ${date}`,
              http: {
                method: "POST",
                path: "/time_entries.json",
                data: {
                  time_entry: {
                    issue_id: row.issueId,
                    hours: cell.hours,
                    activity_id: row.activityId,
                    spent_on: date,
                  },
                },
              },
              resourceKey: `timeentry:${tempId}`,
            });
          }

          // Mark cell as clean
          cell.isDirty = false;
        }
      }

      showStatusBarMessage("$(check) Changes queued in draft mode", 2000);

      // Re-render to show clean state
      const totals = this._calculateTotals();
      this._postMessage({
        type: "render",
        rows: this._rows,
        week: this._currentWeek,
        totals,
        projects: this._projects,
        isDraftMode: true,
      });
    } catch (error) {
      this._postMessage({ type: "showError", message: `Failed to save: ${error}` });
    } finally {
      this._postMessage({ type: "setLoading", loading: false });
    }
  }

  private _getHtml(): string {
    const webview = this._panel.webview;
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "timesheet.css")
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "timesheet.js")
    );
    const nonce = this._getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link href="${cssUri}" rel="stylesheet">
  <title>Time Sheet</title>
</head>
<body>
  <div class="timesheet-container">
    <header class="timesheet-header">
      <h1>Time Sheet</h1>
      <div class="week-nav">
        <button id="prevWeek" class="nav-btn" title="Previous week">‹</button>
        <span id="weekLabel">Loading...</span>
        <button id="nextWeek" class="nav-btn" title="Next week">›</button>
        <button id="todayBtn" class="nav-btn today-btn" title="Go to current week">Today</button>
      </div>
    </header>

    <div class="timesheet-grid-container">
      <table class="timesheet-grid" id="grid">
        <thead>
          <tr>
            <th class="col-task">Task</th>
            <th class="col-activity">Activity</th>
            ${WEEKDAYS.map((d, i) => `<th class="col-day" data-day="${i}">${d}</th>`).join("")}
            <th class="col-total">Total</th>
            <th class="col-actions">Actions</th>
          </tr>
        </thead>
        <tbody id="gridBody">
          <tr class="loading-row">
            <td colspan="11">Loading...</td>
          </tr>
        </tbody>
        <tfoot>
          <tr id="totalsRow">
            <td class="col-task"></td>
            <td class="col-activity">Daily Total</td>
            ${WEEKDAYS.map((_, i) => `<td class="col-day total-cell" data-day="${i}">0</td>`).join("")}
            <td class="col-total total-cell" id="weekTotal">0</td>
            <td class="col-actions">
              <button id="addRowBtn" class="action-btn add-btn" title="Add row">+</button>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>

    <footer class="timesheet-footer">
      <button id="saveBtn" class="save-btn">Save to Draft</button>
    </footer>
  </div>

  <div id="loadingOverlay" class="loading-overlay hidden">
    <div class="spinner"></div>
  </div>

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
