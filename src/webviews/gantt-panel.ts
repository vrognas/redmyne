import * as vscode from "vscode";
import { Issue } from "../redmine/models/issue";
import { RedmineServer } from "../redmine/redmine-server";
import { FlexibilityScore, WeeklySchedule } from "../utilities/flexibility-calculator";
import { showStatusBarMessage } from "../utilities/status-bar";

type ZoomLevel = "day" | "week" | "month" | "quarter" | "year";

// Default schedule if none provided
const DEFAULT_SCHEDULE: WeeklySchedule = {
  Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8, Sat: 0, Sun: 0,
};

// Pixels per day for each zoom level
const ZOOM_PIXELS_PER_DAY: Record<ZoomLevel, number> = {
  day: 40,
  week: 15,
  month: 5,
  quarter: 2,
  year: 0.8,
};

// All Redmine relation types
type RelationType = "relates" | "duplicates" | "blocks" | "precedes" | "follows" | "copied_to";

interface GanttRelation {
  id: number;
  targetId: number;
  type: RelationType;
}

interface GanttIssue {
  id: number;
  subject: string;
  start_date: string | null;
  due_date: string | null;
  status: FlexibilityScore["status"] | null;
  project: string;
  projectId: number;
  parentId: number | null;
  estimated_hours: number | null;
  spent_hours: number | null;
  done_ratio: number;
  relations: GanttRelation[];
}

interface GanttRow {
  type: "project" | "issue";
  id: number;
  label: string;
  depth: number;
  issue?: GanttIssue;
  /** True if this issue has subtasks (dates/hours are derived) */
  isParent?: boolean;
}

/**
 * Build hierarchical rows from flat issues list
 * Groups by project, then organizes parent/child issues
 */
function buildHierarchicalRows(issues: GanttIssue[]): GanttRow[] {
  const rows: GanttRow[] = [];

  // Group issues by project
  const byProject = new Map<number, { name: string; issues: GanttIssue[] }>();
  for (const issue of issues) {
    if (!byProject.has(issue.projectId)) {
      byProject.set(issue.projectId, { name: issue.project, issues: [] });
    }
    byProject.get(issue.projectId)!.issues.push(issue);
  }

  // Sort projects by issue count (descending)
  const sortedProjects = [...byProject.entries()].sort(
    (a, b) => b[1].issues.length - a[1].issues.length
  );

  for (const [projectId, { name, issues: projectIssues }] of sortedProjects) {
    // Add project header
    rows.push({
      type: "project",
      id: projectId,
      label: name,
      depth: 0,
    });

    // Build issue tree within project
    const issueMap = new Map(projectIssues.map((i) => [i.id, i]));
    const children = new Map<number | null, GanttIssue[]>();

    // Group by parent
    for (const issue of projectIssues) {
      const parentId = issue.parentId;
      // Only use parentId if parent is in this project's issues
      const effectiveParent = parentId && issueMap.has(parentId) ? parentId : null;
      if (!children.has(effectiveParent)) {
        children.set(effectiveParent, []);
      }
      children.get(effectiveParent)!.push(issue);
    }

    // Recursively add issues
    function addIssues(parentId: number | null, depth: number) {
      const childIssues = children.get(parentId) || [];
      for (const issue of childIssues) {
        // Check if this issue has children (is a parent)
        const hasChildren = children.has(issue.id) && children.get(issue.id)!.length > 0;
        rows.push({
          type: "issue",
          id: issue.id,
          label: issue.subject,
          depth,
          issue,
          isParent: hasChildren,
        });
        addIssues(issue.id, depth + 1);
      }
    }

    addIssues(null, 1);
  }

  return rows;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/**
 * Escape HTML/SVG special characters to prevent XSS
 * User data (issue subjects, project names) must be escaped before SVG insertion
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateWithWeekday(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return `${dateStr} (${WEEKDAYS[d.getUTCDay()]})`;
}

/**
 * Get ISO week number for a date (uses UTC to avoid timezone issues)
 */
function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/**
 * Format decimal hours as HH:MM (rounded up to nearest minute)
 */
function formatHoursAsTime(hours: number | null): string {
  if (hours === null) return "—";
  const totalMinutes = Math.ceil(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${m.toString().padStart(2, "0")}`;
}

/**
 * Get day name key for WeeklySchedule lookup
 */
function getDayKey(date: Date): keyof WeeklySchedule {
  const keys: (keyof WeeklySchedule)[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return keys[date.getUTCDay()];
}

/**
 * Calculate daily intensity for an issue
 * Returns array of {dayOffset, intensity} where intensity is 0-1 (can exceed 1 if overbooked)
 * Single-issue ratio: distributes estimated_hours evenly across available days
 */
function calculateDailyIntensity(
  issue: GanttIssue,
  schedule: WeeklySchedule
): { dayOffset: number; intensity: number }[] {
  const result: { dayOffset: number; intensity: number }[] = [];

  if (!issue.start_date || !issue.due_date) {
    return result;
  }

  const start = new Date(issue.start_date);
  const end = new Date(issue.due_date);
  const estimatedHours = issue.estimated_hours ?? 0;

  // Calculate total available hours in range
  let totalAvailable = 0;
  const current = new Date(start);
  while (current <= end) {
    totalAvailable += schedule[getDayKey(current)];
    current.setUTCDate(current.getUTCDate() + 1);
  }

  if (totalAvailable === 0 || estimatedHours === 0) {
    // No available hours or no estimate - return 0 intensity for all days
    const dayCount = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    for (let i = 0; i < dayCount; i++) {
      result.push({ dayOffset: i, intensity: 0 });
    }
    return result;
  }

  // Distribute hours evenly: each day gets proportional share of estimated work
  const hoursPerAvailableHour = estimatedHours / totalAvailable;

  current.setTime(start.getTime());
  let dayOffset = 0;
  while (current <= end) {
    const dayHours = schedule[getDayKey(current)];
    // Intensity = (allocated hours for this day) / (available hours for this day)
    // For uniform distribution: allocated = dayHours * (estimated / totalAvailable)
    const intensity = dayHours > 0 ? hoursPerAvailableHour : 0;
    result.push({ dayOffset, intensity: Math.min(intensity, 1.5) }); // Cap at 1.5 for display
    current.setUTCDate(current.getUTCDate() + 1);
    dayOffset++;
  }

  return result;
}

/**
 * Calculate aggregate daily workload across all issues
 * Returns map of date string (YYYY-MM-DD) to total intensity (hours used / hours available)
 */
function calculateAggregateWorkload(
  issues: GanttIssue[],
  schedule: WeeklySchedule,
  minDate: Date,
  maxDate: Date
): Map<string, number> {
  const workloadMap = new Map<string, number>();

  // Initialize all days with 0
  const current = new Date(minDate);
  while (current <= maxDate) {
    workloadMap.set(current.toISOString().slice(0, 10), 0);
    current.setUTCDate(current.getUTCDate() + 1);
  }

  // For each issue, distribute its estimated hours across its date range
  for (const issue of issues) {
    if (!issue.start_date || !issue.due_date || !issue.estimated_hours) {
      continue;
    }

    const start = new Date(issue.start_date);
    const end = new Date(issue.due_date);
    const estimatedHours = issue.estimated_hours;

    // Calculate total available hours in the issue's range
    let totalAvailable = 0;
    const temp = new Date(start);
    while (temp <= end) {
      totalAvailable += schedule[getDayKey(temp)];
      temp.setUTCDate(temp.getUTCDate() + 1);
    }

    if (totalAvailable === 0) continue;

    // Distribute hours proportionally across each day
    temp.setTime(start.getTime());
    while (temp <= end) {
      const dateKey = temp.toISOString().slice(0, 10);
      const dayHours = schedule[getDayKey(temp)];
      if (dayHours > 0) {
        // Intensity = (allocated hours) / (available hours)
        // Allocated = estimatedHours * (dayHours / totalAvailable)
        const allocated = estimatedHours * (dayHours / totalAvailable);
        const intensity = allocated / dayHours;
        const current = workloadMap.get(dateKey) ?? 0;
        workloadMap.set(dateKey, current + intensity);
      }
      temp.setUTCDate(temp.getUTCDate() + 1);
    }
  }

  return workloadMap;
}

/**
 * Get heatmap color based on utilization level
 * Green < 80%, Yellow 80-100%, Orange 100-120%, Red > 120%
 */
function getHeatmapColor(utilization: number): string {
  if (utilization <= 0) return "transparent";
  if (utilization <= 0.8) return "var(--vscode-charts-green)";
  if (utilization <= 1.0) return "var(--vscode-charts-yellow)";
  if (utilization <= 1.2) return "var(--vscode-charts-orange)";
  return "var(--vscode-charts-red)";
}

/**
 * Gantt timeline webview panel
 * Shows issues as horizontal bars on a timeline
 */
export class GanttPanel {
  public static currentPanel: GanttPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _issues: GanttIssue[] = [];
  private _server: RedmineServer | undefined;
  private _zoomLevel: ZoomLevel = "day";
  private _schedule: WeeklySchedule = DEFAULT_SCHEDULE;
  private _showWorkloadHeatmap: boolean = false;
  private _scrollPosition: { left: number; top: number } = { left: 0, top: 0 };

  private constructor(panel: vscode.WebviewPanel, server?: RedmineServer) {
    this._panel = panel;
    this._server = server;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (message) => this._handleMessage(message),
      null,
      this._disposables
    );
  }

  public static createOrShow(server?: RedmineServer): GanttPanel {
    const column = vscode.ViewColumn.One;

    if (GanttPanel.currentPanel) {
      GanttPanel.currentPanel._panel.reveal(column);
      // Update server reference
      if (server) {
        GanttPanel.currentPanel._server = server;
      }
      return GanttPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "redmineGantt",
      "Redmine Gantt",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    GanttPanel.currentPanel = new GanttPanel(panel, server);
    // Show loading skeleton immediately
    GanttPanel.currentPanel._showLoadingSkeleton();
    return GanttPanel.currentPanel;
  }

  private _showLoadingSkeleton(): void {
    this._panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>Redmine Gantt</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
    }
    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 200px;
      gap: 16px;
    }
    .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--vscode-panel-border);
      border-top-color: var(--vscode-focusBorder);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .skeleton-bar {
      height: 30px;
      background: var(--vscode-panel-border);
      border-radius: 4px;
      opacity: 0.5;
      animation: pulse 1.5s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.3; }
      50% { opacity: 0.6; }
    }
    .skeleton-container {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <h2>Timeline</h2>
  <div class="loading">
    <div class="spinner"></div>
    <span>Loading issues...</span>
  </div>
  <div class="skeleton-container">
    <div class="skeleton-bar" style="width: 60%;"></div>
    <div class="skeleton-bar" style="width: 80%;"></div>
    <div class="skeleton-bar" style="width: 45%;"></div>
    <div class="skeleton-bar" style="width: 70%;"></div>
  </div>
</body>
</html>`;
  }

  public updateIssues(
    issues: Issue[],
    flexibilityCache: Map<number, FlexibilityScore | null>,
    schedule?: WeeklySchedule
  ): void {
    // Update schedule if provided
    if (schedule) {
      this._schedule = schedule;
    }

    // Filter issues with dates and map to Gantt format
    this._issues = issues
      .filter((i) => i.start_date || i.due_date)
      .map((i) => ({
        id: i.id,
        subject: i.subject,
        start_date: i.start_date || null,
        due_date: i.due_date || null,
        status: flexibilityCache.get(i.id)?.status ?? null,
        project: i.project?.name ?? "Unknown",
        projectId: i.project?.id ?? 0,
        parentId: i.parent?.id ?? null,
        estimated_hours: i.estimated_hours ?? null,
        spent_hours: i.spent_hours ?? null,
        done_ratio: i.done_ratio ?? 0,
        relations: (i.relations || [])
          // Filter out reverse relation types (Redmine returns both directions)
          // Keep only "forward" types to avoid duplicate arrows
          // Skip: blocked (reverse of blocks), duplicated (reverse of duplicates),
          //       copied_from (reverse of copied_to), follows (reverse of precedes)
          .filter((r) => !["blocked", "duplicated", "copied_from", "follows"].includes(r.relation_type))
          // Skip self-referencing relations (bug protection)
          .filter((r) => r.issue_to_id !== i.id && r.issue_id !== r.issue_to_id)
          .map((r) => ({
            id: r.id,
            targetId: r.issue_to_id,
            type: r.relation_type as RelationType,
          })),
      }));

    this._updateContent();
  }

  private _updateContent(): void {
    this._panel.webview.html = this._getHtmlContent();
  }

  private _handleMessage(message: {
    command: string;
    issueId?: number;
    startDate?: string | null;
    dueDate?: string | null;
    zoomLevel?: ZoomLevel;
    relationId?: number;
    targetIssueId?: number;
    relationType?: RelationType;
  }): void {
    switch (message.command) {
      case "openIssue":
        if (message.issueId && this._server) {
          vscode.commands.executeCommand(
            "redmine.openActionsForIssue",
            false,
            { server: this._server },
            String(message.issueId)
          );
        }
        break;
      case "updateDates":
        if (message.issueId && this._server) {
          this._updateIssueDates(
            message.issueId,
            message.startDate ?? null,
            message.dueDate ?? null
          );
        }
        break;
      case "setZoom":
        if (message.zoomLevel) {
          this._zoomLevel = message.zoomLevel;
          this._updateContent();
        }
        break;
      case "deleteRelation":
        if (message.relationId && this._server) {
          this._deleteRelation(message.relationId);
        }
        break;
      case "createRelation":
        if (message.issueId && message.targetIssueId && message.relationType && this._server) {
          this._createRelation(message.issueId, message.targetIssueId, message.relationType);
        }
        break;
      case "toggleWorkloadHeatmap":
        this._showWorkloadHeatmap = !this._showWorkloadHeatmap;
        // Send message to webview to toggle visibility without full re-render
        this._panel.webview.postMessage({
          command: "setHeatmapState",
          enabled: this._showWorkloadHeatmap,
        });
        break;
      case "refresh":
        // Refresh data without resetting view state
        vscode.commands.executeCommand("redmine.refreshGanttData");
        break;
      case "scrollPosition":
        // Store scroll position for restoration after update
        if (message.left !== undefined && message.top !== undefined) {
          this._scrollPosition = { left: message.left, top: message.top };
        }
        break;
      case "undoRelation":
        if (this._server) {
          this._handleUndoRelation(message);
        }
        break;
      case "redoRelation":
        if (this._server) {
          this._handleRedoRelation(message);
        }
        break;
    }
  }

  private async _updateIssueDates(
    issueId: number,
    startDate: string | null,
    dueDate: string | null
  ): Promise<void> {
    if (!this._server) return;

    try {
      await this._server.updateIssueDates(issueId, startDate, dueDate);
      // Update local data
      const issue = this._issues.find((i) => i.id === issueId);
      if (issue) {
        if (startDate !== null) issue.start_date = startDate;
        if (dueDate !== null) issue.due_date = dueDate;
      }
      // Re-render to reflect changes (needed for undo/redo)
      this._updateContent();
      showStatusBarMessage(`$(check) #${issueId} dates saved`, 2000);
    } catch (error) {
      // On error, re-render to reset UI to correct state
      this._updateContent();
      vscode.window.showErrorMessage(
        `Failed to update dates: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async _deleteRelation(relationId: number): Promise<void> {
    if (!this._server) return;

    try {
      // Find relation info before deleting (for undo)
      let relationInfo: {
        issueId: number;
        targetIssueId: number;
        relationType: string;
      } | null = null;
      for (const issue of this._issues) {
        const rel = issue.relations.find((r) => r.id === relationId);
        if (rel) {
          relationInfo = {
            issueId: rel.issue_id,
            targetIssueId: rel.issue_to_id,
            relationType: rel.relation_type,
          };
          break;
        }
      }

      await this._server.deleteRelation(relationId);

      // Send undo action to webview (before local state update)
      if (relationInfo) {
        this._panel.webview.postMessage({
          command: "pushUndoAction",
          action: {
            type: "relation",
            operation: "delete",
            relationId,
            issueId: relationInfo.issueId,
            targetIssueId: relationInfo.targetIssueId,
            relationType: relationInfo.relationType,
          },
        });
      }

      // Remove from local data and re-render
      for (const issue of this._issues) {
        issue.relations = issue.relations.filter((r) => r.id !== relationId);
      }
      this._updateContent();
      showStatusBarMessage("$(check) Relation deleted", 2000);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to delete relation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async _createRelation(
    issueId: number,
    targetIssueId: number,
    relationType: RelationType
  ): Promise<void> {
    if (!this._server) return;

    const labels: Record<RelationType, string> = {
      relates: "Related to",
      duplicates: "Duplicates",
      blocks: "Blocks",
      precedes: "Precedes",
      follows: "Follows",
      copied_to: "Copied to",
    };

    try {
      // Capture dates before creation (Redmine may adjust dates for precedes/blocks)
      const sourceIssue = this._issues.find((i) => i.id === issueId);
      const targetIssue = this._issues.find((i) => i.id === targetIssueId);
      const datesBefore = {
        source: { start: sourceIssue?.start_date, due: sourceIssue?.due_date },
        target: { start: targetIssue?.start_date, due: targetIssue?.due_date },
      };

      // Create relation and get the ID
      const response = await this._server.createRelation(issueId, targetIssueId, relationType);
      const relationId = response.relation.id;

      showStatusBarMessage(`$(check) ${labels[relationType]} relation created`, 2000);

      // Send undo action to webview before refreshing
      this._panel.webview.postMessage({
        command: "pushUndoAction",
        action: {
          type: "relation",
          operation: "create",
          relationId,
          issueId,
          targetIssueId,
          relationType,
          datesBefore,
        },
      });

      // Refresh data without resetting view
      vscode.commands.executeCommand("redmine.refreshGanttData");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Map Redmine validation errors to user-friendly messages
      const friendlyMessages: Record<string, string> = {
        "doesn't belong to the same project": "Issues must be in the same project",
        "cannot be linked to one of its subtasks": "Cannot link parent to its subtask",
        "cannot be linked to one of its ancestors": "Cannot link to ancestor issue",
        "already exists": "This relation already exists",
        "is invalid": "Invalid relation type",
      };
      let friendly = msg;
      for (const [pattern, replacement] of Object.entries(friendlyMessages)) {
        if (msg.toLowerCase().includes(pattern.toLowerCase())) {
          friendly = replacement;
          break;
        }
      }
      vscode.window.showErrorMessage(`Cannot create relation: ${friendly}`);
    }
  }

  private async _handleUndoRelation(message: {
    operation: string;
    relationId?: number;
    issueId?: number;
    targetIssueId?: number;
    relationType?: string;
  }): Promise<void> {
    if (!this._server) return;

    try {
      if (message.operation === "delete" && message.relationId) {
        // Undo create = delete the relation
        await this._server.deleteRelation(message.relationId);
        showStatusBarMessage("$(check) Relation undone", 2000);
      } else if (message.operation === "create" && message.issueId && message.targetIssueId && message.relationType) {
        // Undo delete = recreate the relation
        const response = await this._server.createRelation(
          message.issueId,
          message.targetIssueId,
          message.relationType as RelationType
        );
        // Send new relationId to update redo stack
        this._panel.webview.postMessage({
          command: "updateRelationId",
          stack: "redo",
          newRelationId: response.relation.id,
        });
        showStatusBarMessage("$(check) Relation restored", 2000);
      }
      // Refresh to show updated state
      vscode.commands.executeCommand("redmine.refreshGanttData");
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to undo relation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async _handleRedoRelation(message: {
    operation: string;
    relationId?: number;
    issueId?: number;
    targetIssueId?: number;
    relationType?: string;
  }): Promise<void> {
    if (!this._server) return;

    try {
      if (message.operation === "create" && message.issueId && message.targetIssueId && message.relationType) {
        // Redo create = recreate the relation
        const response = await this._server.createRelation(
          message.issueId,
          message.targetIssueId,
          message.relationType as RelationType
        );
        // Send new relationId to update undo stack
        this._panel.webview.postMessage({
          command: "updateRelationId",
          stack: "undo",
          newRelationId: response.relation.id,
        });
        showStatusBarMessage("$(check) Relation recreated", 2000);
      } else if (message.operation === "delete" && message.relationId) {
        // Redo delete = delete the relation again
        await this._server.deleteRelation(message.relationId);
        showStatusBarMessage("$(check) Relation deleted", 2000);
      }
      // Refresh to show updated state
      vscode.commands.executeCommand("redmine.refreshGanttData");
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to redo relation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public dispose(): void {
    GanttPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  private _getHtmlContent(): string {
    const nonce = getNonce();

    // Calculate date range
    const dates = this._issues.flatMap((i) =>
      [i.start_date, i.due_date].filter(Boolean)
    ) as string[];

    if (dates.length === 0) {
      return this._getEmptyHtml();
    }

    const minDate = new Date(
      Math.min(...dates.map((d) => new Date(d).getTime()))
    );
    const maxDate = new Date(
      Math.max(...dates.map((d) => new Date(d).getTime()))
    );

    // Add padding days (use UTC to avoid timezone issues)
    minDate.setUTCDate(minDate.getUTCDate() - 7);
    maxDate.setUTCDate(maxDate.getUTCDate() + 7);

    // Today for past-bar detection (start of today UTC)
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const totalDays = Math.ceil(
      (maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    const pixelsPerDay = ZOOM_PIXELS_PER_DAY[this._zoomLevel];
    const timelineWidth = Math.max(600, totalDays * pixelsPerDay);
    const labelWidth = 250;
    const barHeight = 30;
    const barGap = 10;
    const headerHeight = 40;
    const indentSize = 16;

    // Build hierarchical rows
    const rows = buildHierarchicalRows(this._issues);
    const contentHeight = rows.length * (barHeight + barGap);

    // Left labels (fixed column) - Y starts at 0 in body SVG (header is separate)
    const labels = rows
      .map((row, index) => {
        const y = index * (barHeight + barGap);
        const indent = row.depth * indentSize;

        if (row.type === "project") {
          // Project header row
          return `
            <g class="project-label">
              <text x="${5 + indent}" y="${y + barHeight / 2 + 5}" fill="var(--vscode-foreground)" font-size="12" font-weight="bold">
                ${escapeHtml(row.label)}
              </text>
            </g>
          `;
        }

        // Issue row
        const issue = row.issue!;
        const escapedSubject = escapeHtml(issue.subject);
        const escapedProject = escapeHtml(issue.project);
        const tooltip = [
          `#${issue.id} ${escapedSubject}`,
          `Project: ${escapedProject}`,
          `Start: ${formatDateWithWeekday(issue.start_date)}`,
          `Due: ${formatDateWithWeekday(issue.due_date)}`,
          `Estimated: ${formatHoursAsTime(issue.estimated_hours)}`,
          `Spent: ${formatHoursAsTime(issue.spent_hours)}`,
        ].join("\n");

        return `
          <g class="issue-label" data-issue-id="${issue.id}" tabindex="0" role="button" aria-label="Open issue #${issue.id}" style="cursor: pointer;">
            <text x="${5 + indent}" y="${y + barHeight / 2 + 5}" fill="var(--vscode-foreground)" font-size="12">
              #${issue.id} ${escapedSubject}
            </text>
            <title>${tooltip}</title>
          </g>
        `;
      })
      .join("");

    // Right bars (scrollable timeline) - only for issue rows
    const bars = rows
      .map((row, index) => {
        // Skip project headers - no bar
        if (row.type === "project") {
          return "";
        }

        const issue = row.issue!;
        const isParent = row.isParent ?? false;
        const start = issue.start_date
          ? new Date(issue.start_date)
          : new Date(issue.due_date!);
        const end = issue.due_date
          ? new Date(issue.due_date)
          : new Date(issue.start_date!);

        // Add 1 day to end to get END of due_date (not start/midnight)
        const endPlusOne = new Date(end);
        endPlusOne.setUTCDate(endPlusOne.getUTCDate() + 1);

        const startX =
          ((start.getTime() - minDate.getTime()) /
            (maxDate.getTime() - minDate.getTime())) *
          timelineWidth;
        const endX =
          ((endPlusOne.getTime() - minDate.getTime()) /
            (maxDate.getTime() - minDate.getTime())) *
          timelineWidth;

        const width = Math.max(10, endX - startX);
        const y = index * (barHeight + barGap); // Y starts at 0 in body SVG
        const color = isParent ? "var(--vscode-descriptionForeground)" : this._getStatusColor(issue.status);
        const isPast = end < today;

        // Calculate past portion (from start to today)
        const todayX =
          ((today.getTime() - minDate.getTime()) /
            (maxDate.getTime() - minDate.getTime())) *
          timelineWidth;
        // Past portion: from bar start to min(todayX, barEnd) - skip for parent issues
        const pastEndX = Math.min(todayX, endX);
        const pastWidth = Math.max(0, pastEndX - startX);
        const hasPastPortion = !isParent && start < today && pastWidth > 0;

        const escapedSubject = escapeHtml(issue.subject);
        const escapedProject = escapeHtml(issue.project);
        const doneRatio = issue.done_ratio;
        const tooltip = [
          `#${issue.id} ${escapedSubject}`,
          `Project: ${escapedProject}`,
          `Start: ${formatDateWithWeekday(issue.start_date)}`,
          `Due: ${formatDateWithWeekday(issue.due_date)}`,
          `Progress: ${doneRatio}%`,
          `Estimated: ${formatHoursAsTime(issue.estimated_hours)}`,
          `Spent: ${formatHoursAsTime(issue.spent_hours)}`,
        ].join("\n");

        // Calculate done portion width for progress visualization
        const doneWidth = (doneRatio / 100) * width;

        const handleWidth = 8;

        // Calculate daily intensity for this issue (skip for parent issues - work is in subtasks)
        const intensities = isParent ? [] : calculateDailyIntensity(issue, this._schedule);
        const hasIntensity = !isParent && intensities.length > 0 && issue.estimated_hours !== null;

        // Generate intensity segments and line chart
        let intensitySegments = "";
        let intensityLine = "";

        if (hasIntensity && intensities.length > 0) {
          const dayCount = intensities.length;
          const segmentWidth = width / dayCount;

          // Generate day segments with varying opacity
          // Scale intensity to 0-1 range where 1.5 (max stored) = full opacity
          const maxIntensityForOpacity = 1.5;
          intensitySegments = intensities
            .map((d, i) => {
              const segX = startX + i * segmentWidth;
              // Opacity: base 0.2 + normalized intensity * 0.6 (range 0.2 to 0.8)
              const normalizedForOpacity = Math.min(d.intensity, maxIntensityForOpacity) / maxIntensityForOpacity;
              const opacity = 0.2 + normalizedForOpacity * 0.6;
              const isFirst = i === 0;
              const isLast = i === dayCount - 1;
              // Use clip-path for proper corner rounding on first/last
              return `<rect x="${segX}" y="${y}" width="${segmentWidth + 0.5}" height="${barHeight}"
                            fill="${color}" opacity="${opacity.toFixed(2)}"
                            ${isFirst ? 'rx="4" ry="4"' : isLast ? 'rx="4" ry="4"' : ""}/>`;
            })
            .join("");

          // Generate step function path (horizontal line per day, step at boundaries)
          // Scale intensity to 0-1 range where 1.5 (max stored) = full height
          const maxIntensity = 1.5;
          const stepPoints: string[] = [];
          intensities.forEach((d, i) => {
            const dayStartX = startX + i * segmentWidth;
            const dayEndX = startX + (i + 1) * segmentWidth;
            // Line Y: bottom of bar minus normalized intensity * bar height
            const normalizedIntensity = Math.min(d.intensity, maxIntensity) / maxIntensity;
            const py = y + barHeight - normalizedIntensity * (barHeight - 4);
            if (i === 0) {
              // Move to start of first day
              stepPoints.push(`M ${dayStartX.toFixed(1)},${py.toFixed(1)}`);
            }
            // Horizontal line across the day
            stepPoints.push(`H ${dayEndX.toFixed(1)}`);
            // Step to next day's height (if not last day)
            if (i < intensities.length - 1) {
              const nextNormalized = Math.min(intensities[i + 1].intensity, maxIntensity) / maxIntensity;
              const nextPy = y + barHeight - nextNormalized * (barHeight - 4);
              stepPoints.push(`V ${nextPy.toFixed(1)}`);
            }
          });

          intensityLine = `<path d="${stepPoints.join(" ")}"
                                 fill="none" stroke="var(--vscode-editor-foreground)"
                                 stroke-width="1.5" opacity="0.7"/>`;
        }

        // Parent issues: summary bar (no fill, no drag, no link handle)
        if (isParent) {
          // Parent done_ratio is weighted average of subtasks
          const parentDoneWidth = (doneRatio / 100) * (endX - startX - 8);
          return `
            <g class="issue-bar parent-bar" data-issue-id="${issue.id}"
               data-start-date="${issue.start_date || ""}"
               data-due-date="${issue.due_date || ""}"
               data-start-x="${startX}" data-end-x="${endX}"
               tabindex="0" role="button" aria-label="#${issue.id} ${escapedSubject} (parent, ${doneRatio}% done)">
              <!-- Summary bar: bracket-style with downward arrows at ends -->
              <path class="bar-outline" d="M ${startX + 4} ${y + barHeight * 0.3}
                    L ${startX + 4} ${y + barHeight * 0.7}
                    L ${startX} ${y + barHeight}
                    M ${startX + 4} ${y + barHeight * 0.5}
                    H ${endX - 4}
                    M ${endX - 4} ${y + barHeight * 0.3}
                    L ${endX - 4} ${y + barHeight * 0.7}
                    L ${endX} ${y + barHeight}"
                    fill="none" stroke="${color}" stroke-width="2" opacity="0.8" style="cursor: pointer;"/>
              ${doneRatio > 0 ? `
                <!-- Progress line showing done_ratio on parent -->
                <line class="parent-progress" x1="${startX + 4}" y1="${y + barHeight * 0.5}"
                      x2="${startX + 4 + parentDoneWidth}" y2="${y + barHeight * 0.5}"
                      stroke="var(--vscode-charts-green)" stroke-width="3" opacity="0.8"/>
              ` : ""}
              <title>${tooltip} (parent - ${doneRatio}% done)</title>
            </g>
          `;
        }

        return `
          <g class="issue-bar${isPast ? " bar-past" : ""}" data-issue-id="${issue.id}"
             data-start-date="${issue.start_date || ""}"
             data-due-date="${issue.due_date || ""}"
             data-start-x="${startX}" data-end-x="${endX}"
             tabindex="0" role="button" aria-label="#${issue.id} ${escapedSubject}">
            ${hasIntensity ? `
              <!-- Intensity segments -->
              <g class="bar-intensity">${intensitySegments}</g>
              <!-- Intensity line chart -->
              ${intensityLine}
            ` : `
              <!-- Fallback: solid bar when no intensity data -->
              <rect class="bar-main" x="${startX}" y="${y}" width="${width}" height="${barHeight}"
                    fill="${color}" rx="4" ry="4" opacity="0.3"/>
            `}
            ${hasPastPortion ? `
              <!-- Past portion overlay with diagonal stripes -->
              <rect class="past-overlay" x="${startX}" y="${y}" width="${pastWidth}" height="${barHeight}"
                    fill="url(#past-stripes)" rx="4" ry="4"/>
            ` : ""}
            ${doneRatio > 0 && doneRatio < 100 ? `
              <!-- Progress fill showing done_ratio -->
              <rect class="progress-fill" x="${startX}" y="${y}" width="${doneWidth}" height="${barHeight}"
                    fill="${color}" rx="4" ry="4" opacity="0.5"/>
            ` : ""}
            <!-- Border/outline -->
            <rect class="bar-outline" x="${startX}" y="${y}" width="${width}" height="${barHeight}"
                  fill="none" stroke="${color}" stroke-width="1" rx="4" ry="4" opacity="0.8" style="cursor: pointer;"/>
            <rect class="drag-handle drag-left" x="${startX}" y="${y}" width="${handleWidth}" height="${barHeight}"
                  fill="transparent" style="cursor: ew-resize;"/>
            <rect class="drag-handle drag-right" x="${startX + width - handleWidth}" y="${y}" width="${handleWidth}" height="${barHeight}"
                  fill="transparent" style="cursor: ew-resize;"/>
            <!-- Link handle for creating relations -->
            <circle class="link-handle" cx="${endX + 8}" cy="${y + barHeight / 2}" r="5"
                    fill="var(--vscode-button-background)" stroke="var(--vscode-button-foreground)"
                    stroke-width="1" opacity="0" style="cursor: crosshair;"/>
            <title>${tooltip}</title>
          </g>
        `;
      })
      .join("");

    // Dependency arrows - draw from end of source to start of target
    const issuePositions = new Map<number, { startX: number; endX: number; y: number }>();
    rows.forEach((row, index) => {
      if (row.type === "issue" && row.issue) {
        const issue = row.issue;
        const start = issue.start_date
          ? new Date(issue.start_date)
          : new Date(issue.due_date!);
        const end = issue.due_date
          ? new Date(issue.due_date)
          : new Date(issue.start_date!);
        // Add 1 day to end to match bar width calculation
        const endPlusOne = new Date(end);
        endPlusOne.setUTCDate(endPlusOne.getUTCDate() + 1);
        const startX =
          ((start.getTime() - minDate.getTime()) /
            (maxDate.getTime() - minDate.getTime())) *
          timelineWidth;
        const endX =
          ((endPlusOne.getTime() - minDate.getTime()) /
            (maxDate.getTime() - minDate.getTime())) *
          timelineWidth;
        const y = index * (barHeight + barGap) + barHeight / 2; // Y starts at 0 in body SVG
        issuePositions.set(issue.id, { startX, endX, y });
      }
    });

    // Relation type styling - only forward types (reverse types are filtered out)
    // blocks/precedes/relates/duplicates/copied_to are shown
    // blocked/follows/duplicated/copied_from are auto-generated reverses, filtered
    const relationStyles: Record<string, { color: string; dash: string; label: string; tip: string }> = {
      blocks: { color: "#e74c3c", dash: "", label: "blocks",
        tip: "Target cannot be closed until source is closed" },
      precedes: { color: "#9b59b6", dash: "", label: "precedes",
        tip: "Source must complete before target can start" },
      relates: { color: "#7f8c8d", dash: "4,3", label: "relates to",
        tip: "Simple link (no constraints)" },
      duplicates: { color: "#e67e22", dash: "2,2", label: "duplicates",
        tip: "Closing target auto-closes source" },
      copied_to: { color: "#1abc9c", dash: "6,2", label: "copied to",
        tip: "Source was copied to create target" },
    };

    const dependencyArrows = this._issues
      .flatMap((issue) =>
        issue.relations.map((rel) => {
          const source = issuePositions.get(issue.id);
          const target = issuePositions.get(rel.targetId);
          if (!source || !target) return "";

          const style = relationStyles[rel.type] || relationStyles.relates;
          const arrowSize = 6;
          const sameRow = Math.abs(source.y - target.y) < 5;

          // Temporal relations (blocks, precedes): end → start
          // Non-temporal relations (relates, duplicates, copied_to): center → center
          const isTemporal = rel.type === "blocks" || rel.type === "precedes";

          let x1: number, y1: number, x2: number, y2: number;

          if (isTemporal) {
            // End of source → start of target
            x1 = source.endX + 2;
            y1 = source.y;
            x2 = target.startX - 2;
            y2 = target.y;
          } else {
            // Center of source → center of target
            x1 = (source.startX + source.endX) / 2;
            y1 = source.y;
            x2 = (target.startX + target.endX) / 2;
            y2 = target.y;
          }

          // Is target to the right (natural flow) or left/overlapping (route around)?
          const goingRight = x2 > x1;
          const horizontalDist = Math.abs(x2 - x1);
          const nearlyVertical = horizontalDist < 30; // bars are vertically aligned

          let path: string;

          if (sameRow && goingRight) {
            // Same row, target to right: straight horizontal line
            path = `M ${x1} ${y1} H ${x2 - arrowSize}`;
          } else if (!sameRow && nearlyVertical) {
            // Nearly vertical: S-curve that jogs out and back
            // Go right, down to midpoint, left to align, down to target
            const jogX = 20; // small horizontal offset
            const midY = (y1 + y2) / 2;
            path = `M ${x1} ${y1} H ${x1 + jogX} V ${midY} H ${x2 - jogX} V ${y2} H ${x2 - arrowSize}`;
          } else if (goingRight) {
            // Different row, target to right: 3-segment elbow
            const midX = (x1 + x2) / 2;
            path = `M ${x1} ${y1} H ${midX} V ${y2} H ${x2 - arrowSize}`;
          } else if (sameRow) {
            // Same row, target to left: must route above or below
            const gap = 12;
            const routeY = y1 - barHeight; // go above
            path = `M ${x1} ${y1} V ${routeY} H ${x2 - gap} V ${y2} H ${x2 - arrowSize}`;
          } else {
            // Different row, target to left: route BETWEEN the bars (through the gap)
            const gap = 12;
            const midY = (y1 + y2) / 2; // midpoint falls in gap between rows
            path = `M ${x1} ${y1} V ${midY} H ${x2 - gap} V ${y2} H ${x2 - arrowSize}`;
          }

          // Arrowhead points toward target
          const arrowHead = `M ${x2} ${y2} l -${arrowSize} -${arrowSize * 0.6} l 0 ${arrowSize * 1.2} Z`;

          const dashAttr = style.dash ? `stroke-dasharray="${style.dash}"` : "";

          return `
            <g class="dependency-arrow rel-${rel.type}" data-relation-id="${rel.id}" data-from="${issue.id}" data-to="${rel.targetId}" style="cursor: pointer;">
              <!-- Wide invisible hit area for easier clicking -->
              <path class="arrow-hit-area" d="${path}" stroke="transparent" stroke-width="16" fill="none"/>
              <path class="arrow-line" d="${path}" stroke="${style.color}" stroke-width="2" fill="none" ${dashAttr}/>
              <path class="arrow-head" d="${arrowHead}" fill="${style.color}"/>
              <title>#${issue.id} ${style.label} #${rel.targetId}
${style.tip}
(right-click to delete)</title>
            </g>
          `;
        })
      )
      .filter(Boolean)
      .join("");

    // Always calculate aggregate workload (needed for heatmap toggle without re-render)
    const workloadMap = calculateAggregateWorkload(this._issues, this._schedule, minDate, maxDate);

    // Date markers split into fixed header and scrollable body
    const dateMarkers = this._generateDateMarkers(
      minDate,
      maxDate,
      timelineWidth,
      0,
      this._zoomLevel,
      workloadMap,
      this._showWorkloadHeatmap
    );

    // Calculate today's position for auto-scroll (reuse today from above)
    const todayX =
      ((today.getTime() - minDate.getTime()) /
        (maxDate.getTime() - minDate.getTime())) *
      timelineWidth;

    const bodyHeight = contentHeight;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Redmine Gantt</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      overflow: hidden;
      height: 100vh;
      box-sizing: border-box;
    }
    .gantt-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .gantt-header h2 { margin: 0; }
    .gantt-actions {
      display: flex;
      gap: 4px;
    }
    .gantt-actions button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }
    .gantt-actions button:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .gantt-actions button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .gantt-actions button.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .zoom-toggle {
      display: flex;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      overflow: hidden;
      margin-right: 8px;
    }
    .zoom-toggle button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-right: 1px solid var(--vscode-panel-border);
      padding: 4px 10px;
      cursor: pointer;
      font-size: 12px;
    }
    .zoom-toggle button:last-child {
      border-right: none;
    }
    .zoom-toggle button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .zoom-toggle button.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .heatmap-legend {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-left: 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .heatmap-legend-item {
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .heatmap-legend-color {
      width: 12px;
      height: 12px;
      border-radius: 2px;
      opacity: 0.7;
    }
    .gantt-container {
      display: flex;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      height: calc(100vh - 100px);
    }
    .gantt-left {
      flex-shrink: 0;
      width: ${labelWidth}px;
      min-width: 150px;
      max-width: 500px;
      display: flex;
      flex-direction: column;
    }
    .gantt-left-header {
      height: ${headerHeight}px;
      flex-shrink: 0;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .gantt-labels {
      flex-grow: 1;
      background: var(--vscode-editor-background);
      z-index: 1;
      overflow-y: auto;
      overflow-x: hidden;
    }
    .gantt-labels svg {
      width: 100%;
    }
    .gantt-labels::-webkit-scrollbar {
      width: 0;
    }
    .gantt-resize-handle {
      width: 6px;
      background: var(--vscode-panel-border);
      cursor: col-resize;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    .gantt-resize-handle:hover, .gantt-resize-handle.dragging {
      background: var(--vscode-focusBorder);
    }
    .gantt-right {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .gantt-timeline-header {
      height: ${headerHeight}px;
      flex-shrink: 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .gantt-timeline-header::-webkit-scrollbar {
      display: none;
    }
    .gantt-timeline {
      flex-grow: 1;
      overflow-x: auto;
      overflow-y: auto;
    }
    .gantt-timeline::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    .gantt-timeline::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 4px;
    }
    svg { display: block; }
    .issue-bar:hover .bar-main, .issue-bar:hover .bar-outline, .issue-label:hover { opacity: 1; }
    .issue-bar:hover .bar-intensity rect { filter: brightness(1.1); }
    .issue-bar.bar-past { filter: saturate(0.4) opacity(0.7); }
    .issue-bar.bar-past:hover { filter: saturate(0.6) opacity(0.85); }
    .issue-bar.parent-bar { opacity: 0.7; }
    .issue-bar.parent-bar:hover { opacity: 1; }
    .past-overlay { pointer-events: none; }
    .progress-fill { pointer-events: none; }
    .issue-bar .drag-handle:hover { fill: var(--vscode-list-hoverBackground); }
    .issue-bar:hover .link-handle { opacity: 0.7; }
    .issue-bar .link-handle:hover { opacity: 1; transform-origin: center; }
    .issue-bar.dragging .bar-main, .issue-bar.dragging .bar-intensity { opacity: 0.5; }
    .issue-bar.linking-source .bar-outline { stroke-width: 3; stroke: var(--vscode-focusBorder); }
    .issue-bar.linking-source .link-handle { opacity: 1; }
    .issue-bar.link-target .bar-outline { stroke-width: 2; stroke: var(--vscode-charts-green); }
    .temp-link-arrow { pointer-events: none; }
    .dependency-arrow .arrow-line { transition: stroke-width 0.15s, filter 0.15s; }
    .dependency-arrow .arrow-head { transition: filter 0.15s; }
    .dependency-arrow:hover .arrow-line { stroke-width: 3 !important; filter: brightness(1.2); }
    .dependency-arrow:hover .arrow-head { filter: brightness(1.2); }
    /* Relation type colors in legend */
    .relation-legend { display: flex; gap: 12px; font-size: 11px; margin-left: 12px; align-items: center; }
    .relation-legend-item { display: flex; align-items: center; gap: 4px; opacity: 0.8; }
    .relation-legend-item:hover { opacity: 1; }
    .relation-legend-line { width: 20px; height: 2px; }
    .relation-picker { position: fixed; background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 4px 0; z-index: 1000; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
    .relation-picker button { display: block; width: 100%; padding: 6px 12px; border: none; background: transparent; color: var(--vscode-dropdown-foreground); text-align: left; cursor: pointer; font-size: 12px; }
    .relation-picker button:hover, .relation-picker button:focus { background: var(--vscode-list-hoverBackground); }
    /* Focus indicators for accessibility */
    button:focus { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .issue-bar:focus-within .bar-outline, .issue-bar.focused .bar-outline { stroke-width: 3; stroke: var(--vscode-focusBorder); }
    .issue-label:focus { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
    /* Screen reader only class */
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }
    .weekend-bg { fill: var(--vscode-editor-inactiveSelectionBackground); opacity: 0.3; }
    .day-grid { stroke: var(--vscode-editorRuler-foreground); stroke-width: 0.5; opacity: 0.3; }
    .date-marker { stroke: var(--vscode-editorRuler-foreground); stroke-dasharray: 2,2; }
    .today-marker { stroke: var(--vscode-charts-red); stroke-width: 2; }
  </style>
</head>
<body>
  <div id="liveRegion" role="status" aria-live="polite" aria-atomic="true" class="sr-only"></div>
  <div class="gantt-header">
    <h2>Timeline</h2>
    <div class="gantt-actions">
      <div class="zoom-toggle" role="group" aria-label="Zoom level">
        <button id="zoomDay" class="${this._zoomLevel === "day" ? "active" : ""}" title="Day view">Day</button>
        <button id="zoomWeek" class="${this._zoomLevel === "week" ? "active" : ""}" title="Week view">Week</button>
        <button id="zoomMonth" class="${this._zoomLevel === "month" ? "active" : ""}" title="Month view">Month</button>
        <button id="zoomQuarter" class="${this._zoomLevel === "quarter" ? "active" : ""}" title="Quarter view">Quarter</button>
        <button id="zoomYear" class="${this._zoomLevel === "year" ? "active" : ""}" title="Year view">Year</button>
      </div>
      <button id="heatmapBtn" class="${this._showWorkloadHeatmap ? "active" : ""}" title="Toggle workload heatmap" aria-pressed="${this._showWorkloadHeatmap}">Heatmap</button>
      <div class="heatmap-legend" style="${this._showWorkloadHeatmap ? "" : "display: none;"}">
        <span class="heatmap-legend-item"><span class="heatmap-legend-color" style="background: var(--vscode-charts-green);"></span>&lt;80%</span>
        <span class="heatmap-legend-item"><span class="heatmap-legend-color" style="background: var(--vscode-charts-yellow);"></span>80-100%</span>
        <span class="heatmap-legend-item"><span class="heatmap-legend-color" style="background: var(--vscode-charts-orange);"></span>100-120%</span>
        <span class="heatmap-legend-item"><span class="heatmap-legend-color" style="background: var(--vscode-charts-red);"></span>&gt;120%</span>
      </div>
      <div class="relation-legend" title="Relation types (drag from link handle to create)">
        <span class="relation-legend-item"><span class="relation-legend-line" style="background: #e74c3c;"></span>blocks</span>
        <span class="relation-legend-item"><span class="relation-legend-line" style="background: #9b59b6;"></span>precedes</span>
        <span class="relation-legend-item"><span class="relation-legend-line" style="background: #7f8c8d; border-style: dashed;"></span>relates</span>
        <span class="relation-legend-item"><span class="relation-legend-line" style="background: #e67e22; border-style: dotted;"></span>duplicates</span>
        <span class="relation-legend-item"><span class="relation-legend-line" style="background: #1abc9c; border-style: dashed;"></span>copied</span>
      </div>
      <button id="refreshBtn" title="Refresh issues">↻ Refresh</button>
      <button id="todayBtn" title="Jump to Today">Today</button>
      <button id="undoBtn" disabled title="Undo (Ctrl+Z)">↩ Undo</button>
      <button id="redoBtn" disabled title="Redo (Ctrl+Shift+Z)">↪ Redo</button>
    </div>
  </div>
  <div class="gantt-container">
    <div class="gantt-left" id="ganttLeft">
      <div class="gantt-left-header"></div>
      <div class="gantt-labels" id="ganttLabels">
        <svg width="${labelWidth}" height="${bodyHeight}">
          ${labels}
        </svg>
      </div>
    </div>
    <div class="gantt-resize-handle" id="resizeHandle"></div>
    <div class="gantt-right">
      <div class="gantt-timeline-header" id="ganttTimelineHeader">
        <svg width="${timelineWidth}" height="${headerHeight}">
          ${dateMarkers.header}
        </svg>
      </div>
      <div class="gantt-timeline" id="ganttTimeline">
        <svg width="${timelineWidth}" height="${bodyHeight}">
          <defs>
            <pattern id="past-stripes" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--vscode-charts-red)" stroke-width="2" stroke-opacity="0.4"/>
            </pattern>
          </defs>
          ${dateMarkers.body}
          ${bars}
          ${dependencyArrows}
        </svg>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const timelineWidth = ${timelineWidth};
    const minDateMs = ${minDate.getTime()};
    const maxDateMs = ${maxDate.getTime()};
    const totalDays = ${totalDays};
    const dayWidth = timelineWidth / totalDays;

    // Cleanup previous event listeners (prevents accumulation on re-render)
    if (window._ganttCleanup) {
      window._ganttCleanup();
    }
    const docListeners = [];
    const winListeners = [];
    function addDocListener(type, handler, options) {
      document.addEventListener(type, handler, options);
      docListeners.push({ type, handler, options });
    }
    function addWinListener(type, handler, options) {
      window.addEventListener(type, handler, options);
      winListeners.push({ type, handler, options });
    }
    window._ganttCleanup = () => {
      docListeners.forEach(l => document.removeEventListener(l.type, l.handler, l.options));
      winListeners.forEach(l => window.removeEventListener(l.type, l.handler, l.options));
    };

    // Snap x position to nearest day boundary
    function snapToDay(x) {
      return Math.round(x / dayWidth) * dayWidth;
    }

    // Get DOM elements
    const ganttLeft = document.getElementById('ganttLeft');
    const labelsColumn = document.getElementById('ganttLabels');
    const timelineColumn = document.getElementById('ganttTimeline');
    const timelineHeader = document.getElementById('ganttTimelineHeader');
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');

    // Restore state from previous session (use extension-stored position as fallback)
    const extScrollLeft = ${this._scrollPosition.left};
    const extScrollTop = ${this._scrollPosition.top};
    const previousState = vscode.getState() || { undoStack: [], redoStack: [], labelWidth: ${labelWidth}, scrollLeft: null, scrollTop: null, centerDateMs: null };
    const undoStack = previousState.undoStack || [];
    const redoStack = previousState.redoStack || [];
    // Use webview state if available, otherwise use extension-stored position
    let savedScrollLeft = previousState.scrollLeft ?? (extScrollLeft > 0 ? extScrollLeft : null);
    let savedScrollTop = previousState.scrollTop ?? (extScrollTop > 0 ? extScrollTop : null);
    let savedCenterDateMs = previousState.centerDateMs;

    // Convert scroll position to center date (milliseconds)
    function getCenterDateMs() {
      if (!timelineColumn) return null;
      const centerX = timelineColumn.scrollLeft + timelineColumn.clientWidth / 2;
      const ratio = centerX / timelineWidth;
      return minDateMs + ratio * (maxDateMs - minDateMs);
    }

    // Scroll to center a specific date
    function scrollToCenterDate(dateMs) {
      if (!timelineColumn) return;
      const ratio = (dateMs - minDateMs) / (maxDateMs - minDateMs);
      const centerX = ratio * timelineWidth;
      timelineColumn.scrollLeft = Math.max(0, centerX - timelineColumn.clientWidth / 2);
    }

    function saveState() {
      vscode.setState({
        undoStack,
        redoStack,
        labelWidth: ganttLeft?.offsetWidth || ${labelWidth},
        scrollLeft: timelineColumn?.scrollLeft ?? null,
        scrollTop: timelineColumn?.scrollTop ?? null,
        centerDateMs: null
      });
    }

    // Save state with center date for zoom changes (preserves view center across zoom levels)
    function saveStateForZoom() {
      vscode.setState({
        undoStack,
        redoStack,
        labelWidth: ganttLeft?.offsetWidth || ${labelWidth},
        scrollLeft: null,
        scrollTop: timelineColumn?.scrollTop ?? null,
        centerDateMs: getCenterDateMs()
      });
    }

    function updateUndoRedoButtons() {
      undoBtn.disabled = undoStack.length === 0;
      redoBtn.disabled = redoStack.length === 0;
      saveState();
    }

    // Apply saved label width
    if (previousState.labelWidth && ganttLeft) {
      ganttLeft.style.width = previousState.labelWidth + 'px';
    }

    // Synchronize scrolling:
    // - Vertical: labels <-> timeline body
    // - Horizontal: timeline header <-> timeline body
    let scrollSyncing = false;
    let scrollReportTimeout = null;
    if (labelsColumn && timelineColumn && timelineHeader) {
      timelineColumn.addEventListener('scroll', () => {
        if (scrollSyncing) return;
        scrollSyncing = true;
        // Sync vertical with labels
        labelsColumn.scrollTop = timelineColumn.scrollTop;
        // Sync horizontal with header
        timelineHeader.scrollLeft = timelineColumn.scrollLeft;
        // Report scroll position to extension (debounced)
        clearTimeout(scrollReportTimeout);
        scrollReportTimeout = setTimeout(() => {
          vscode.postMessage({
            command: 'scrollPosition',
            left: timelineColumn.scrollLeft,
            top: timelineColumn.scrollTop
          });
        }, 100);
        // Delay reset to prevent cascade from synced scroll events
        requestAnimationFrame(() => { scrollSyncing = false; });
      });
      labelsColumn.addEventListener('scroll', () => {
        if (scrollSyncing) return;
        scrollSyncing = true;
        timelineColumn.scrollTop = labelsColumn.scrollTop;
        requestAnimationFrame(() => { scrollSyncing = false; });
      });
    }

    // Initial button state
    updateUndoRedoButtons();

    // Handle messages from extension (for state updates without full re-render)
    addWinListener('message', event => {
      const message = event.data;
      if (message.command === 'setHeatmapState') {
        const heatmapLayer = document.querySelector('.heatmap-layer');
        const weekendLayer = document.querySelector('.weekend-layer');
        const heatmapBtn = document.getElementById('heatmapBtn');
        const heatmapLegend = document.querySelector('.heatmap-legend');

        if (message.enabled) {
          if (heatmapLayer) heatmapLayer.style.display = '';
          if (weekendLayer) weekendLayer.style.display = 'none';
          if (heatmapBtn) heatmapBtn.classList.add('active');
          if (heatmapLegend) heatmapLegend.style.display = '';
        } else {
          if (heatmapLayer) heatmapLayer.style.display = 'none';
          if (weekendLayer) weekendLayer.style.display = '';
          if (heatmapBtn) heatmapBtn.classList.remove('active');
          if (heatmapLegend) heatmapLegend.style.display = 'none';
        }
      } else if (message.command === 'pushUndoAction') {
        // Push relation action to undo stack
        undoStack.push(message.action);
        redoStack.length = 0;
        updateUndoRedoButtons();
        saveState();
      } else if (message.command === 'updateRelationId') {
        // Update relationId in most recent relation action (after undo/redo recreates relation)
        const stack = message.stack === 'undo' ? undoStack : redoStack;
        if (stack.length > 0) {
          const lastAction = stack[stack.length - 1];
          if (lastAction.type === 'relation') {
            lastAction.relationId = message.newRelationId;
            saveState();
          }
        }
      }
    });

    // Zoom toggle handlers - use saveStateForZoom to preserve center date
    document.getElementById('zoomDay').addEventListener('click', () => {
      saveStateForZoom();
      vscode.postMessage({ command: 'setZoom', zoomLevel: 'day' });
    });
    document.getElementById('zoomWeek').addEventListener('click', () => {
      saveStateForZoom();
      vscode.postMessage({ command: 'setZoom', zoomLevel: 'week' });
    });
    document.getElementById('zoomMonth').addEventListener('click', () => {
      saveStateForZoom();
      vscode.postMessage({ command: 'setZoom', zoomLevel: 'month' });
    });
    document.getElementById('zoomQuarter').addEventListener('click', () => {
      saveStateForZoom();
      vscode.postMessage({ command: 'setZoom', zoomLevel: 'quarter' });
    });
    document.getElementById('zoomYear').addEventListener('click', () => {
      saveStateForZoom();
      vscode.postMessage({ command: 'setZoom', zoomLevel: 'year' });
    });

    // Heatmap toggle handler
    document.getElementById('heatmapBtn').addEventListener('click', () => {
      saveState();
      vscode.postMessage({ command: 'toggleWorkloadHeatmap' });
    });

    // Refresh button handler
    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });

    // Show delete confirmation picker
    function showDeletePicker(x, y, relationId, fromId, toId) {
      document.querySelector('.relation-picker')?.remove();

      const picker = document.createElement('div');
      picker.className = 'relation-picker';

      // Clamp position to viewport bounds
      const pickerWidth = 150;
      const pickerHeight = 100;
      const clampedX = Math.min(x, window.innerWidth - pickerWidth - 10);
      const clampedY = Math.min(y, window.innerHeight - pickerHeight - 10);
      picker.style.left = Math.max(10, clampedX) + 'px';
      picker.style.top = Math.max(10, clampedY) + 'px';

      const label = document.createElement('div');
      label.style.padding = '6px 12px';
      label.style.fontSize = '11px';
      label.style.opacity = '0.7';
      label.textContent = \`#\${fromId} → #\${toId}\`;
      picker.appendChild(label);

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '🗑️ Delete relation';
      deleteBtn.addEventListener('click', () => {
        saveState();
        vscode.postMessage({ command: 'deleteRelation', relationId });
        picker.remove();
      });
      picker.appendChild(deleteBtn);

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => picker.remove());
      picker.appendChild(cancelBtn);

      document.body.appendChild(picker);

      setTimeout(() => {
        document.addEventListener('click', function closeHandler(e) {
          if (!picker.contains(e.target)) {
            picker.remove();
            document.removeEventListener('click', closeHandler);
          }
        });
      }, 0);
    }

    // Right-click on dependency arrow to delete
    document.querySelectorAll('.dependency-arrow').forEach(arrow => {
      arrow.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const relationId = parseInt(arrow.dataset.relationId);
        const fromId = arrow.dataset.from;
        const toId = arrow.dataset.to;
        showDeletePicker(e.clientX, e.clientY, relationId, fromId, toId);
      });
    });

    // Convert x position to date string (YYYY-MM-DD)
    function xToDate(x) {
      const ms = minDateMs + (x / timelineWidth) * (maxDateMs - minDateMs);
      const d = new Date(ms);
      return d.toISOString().slice(0, 10);
    }

    // Drag state
    let dragState = null;

    // Handle drag start on handles
    document.querySelectorAll('.drag-handle').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        const bar = handle.closest('.issue-bar');
        const isLeft = handle.classList.contains('drag-left');
        const issueId = parseInt(bar.dataset.issueId);
        const startX = parseFloat(bar.dataset.startX);
        const endX = parseFloat(bar.dataset.endX);
        const oldStartDate = bar.dataset.startDate || null;
        const oldDueDate = bar.dataset.dueDate || null;
        // Use bar-outline (always exists) instead of bar-main (may not exist for intensity bars)
        const barOutline = bar.querySelector('.bar-outline');
        const barMain = bar.querySelector('.bar-main'); // May be null for intensity bars
        const leftHandle = bar.querySelector('.drag-left');
        const rightHandle = bar.querySelector('.drag-right');

        bar.classList.add('dragging');
        dragState = {
          issueId,
          isLeft,
          initialMouseX: e.clientX,
          startX,
          endX,
          oldStartDate,
          oldDueDate,
          barOutline,
          barMain,
          leftHandle,
          rightHandle,
          bar
        };
      });
    });

    // Linking drag state
    let linkingState = null;
    let tempArrow = null;
    let currentTarget = null;

    function cancelLinking() {
      if (!linkingState) return;
      linkingState.fromBar.classList.remove('linking-source');
      document.querySelectorAll('.link-target').forEach(el => el.classList.remove('link-target'));
      if (tempArrow) { tempArrow.remove(); tempArrow = null; }
      linkingState = null;
      currentTarget = null;
      document.body.style.cursor = '';
    }

    function showRelationPicker(x, y, fromId, toId) {
      // Remove existing picker
      document.querySelector('.relation-picker')?.remove();

      const picker = document.createElement('div');
      picker.className = 'relation-picker';

      // Clamp position to viewport bounds (picker is ~180px wide, ~200px tall)
      const pickerWidth = 180;
      const pickerHeight = 200;
      const clampedX = Math.min(x, window.innerWidth - pickerWidth - 10);
      const clampedY = Math.min(y, window.innerHeight - pickerHeight - 10);
      picker.style.left = Math.max(10, clampedX) + 'px';
      picker.style.top = Math.max(10, clampedY) + 'px';

      const types = [
        { value: 'blocks', label: '🚫 Blocks', color: '#e74c3c',
          tooltip: 'Target cannot be closed until this issue is closed' },
        { value: 'precedes', label: '➡️ Precedes', color: '#9b59b6',
          tooltip: 'This issue must complete before target can start' },
        { value: 'relates', label: '🔗 Relates to', color: '#7f8c8d',
          tooltip: 'Simple link between issues (no constraints)' },
        { value: 'duplicates', label: '📋 Duplicates', color: '#e67e22',
          tooltip: 'Closing target will automatically close this issue' },
        { value: 'copied_to', label: '📄 Copied to', color: '#1abc9c',
          tooltip: 'This issue was copied to create the target issue' }
      ];

      types.forEach(t => {
        const btn = document.createElement('button');
        btn.innerHTML = '<span style="display:inline-block;width:12px;height:3px;background:' + t.color + ';margin-right:8px;vertical-align:middle;"></span>' + t.label;
        btn.title = t.tooltip;
        btn.addEventListener('click', () => {
          saveState();
          vscode.postMessage({
            command: 'createRelation',
            issueId: fromId,
            targetIssueId: toId,
            relationType: t.value
          });
          picker.remove();
        });
        picker.appendChild(btn);
      });

      document.body.appendChild(picker);

      // Close on outside click
      setTimeout(() => {
        document.addEventListener('click', function closeHandler(e) {
          if (!picker.contains(e.target)) {
            picker.remove();
            document.removeEventListener('click', closeHandler);
          }
        });
      }, 0);
    }

    // Announce to screen readers
    function announce(message) {
      const liveRegion = document.getElementById('liveRegion');
      if (liveRegion) {
        liveRegion.textContent = message;
      }
    }

    // Handle click on bar (open issue) - attach to entire issue-bar group
    document.querySelectorAll('.issue-bar').forEach(bar => {
      bar.addEventListener('click', (e) => {
        // Ignore if clicking on drag handles or link handle
        const target = e.target;
        if (target.classList.contains('drag-handle') ||
            target.classList.contains('drag-left') ||
            target.classList.contains('drag-right') ||
            target.classList.contains('link-handle')) {
          return;
        }
        if (dragState || linkingState) return;
        const issueId = parseInt(bar.dataset.issueId);
        vscode.postMessage({ command: 'openIssue', issueId });
      });
    });

    // Keyboard navigation for issue bars
    const issueBars = Array.from(document.querySelectorAll('.issue-bar'));
    issueBars.forEach((bar, index) => {
      bar.addEventListener('keydown', (e) => {
        const issueId = parseInt(bar.dataset.issueId);
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          vscode.postMessage({ command: 'openIssue', issueId });
        } else if (e.key === 'ArrowDown' && index < issueBars.length - 1) {
          e.preventDefault();
          issueBars[index + 1].focus();
          announce(\`Issue \${issueBars[index + 1].getAttribute('aria-label')}\`);
        } else if (e.key === 'ArrowUp' && index > 0) {
          e.preventDefault();
          issueBars[index - 1].focus();
          announce(\`Issue \${issueBars[index - 1].getAttribute('aria-label')}\`);
        }
      });
    });

    // Handle link handle mousedown to start linking
    document.querySelectorAll('.link-handle').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const bar = handle.closest('.issue-bar');
        const issueId = parseInt(bar.dataset.issueId);
        const cx = parseFloat(handle.getAttribute('cx'));
        const cy = parseFloat(handle.getAttribute('cy'));

        bar.classList.add('linking-source');
        document.body.style.cursor = 'crosshair';

        // Create temp arrow in SVG with arrowhead marker
        const svg = document.querySelector('#ganttTimeline svg');

        // Add arrowhead marker if not exists
        if (!document.getElementById('temp-arrow-head')) {
          const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
          defs.innerHTML = \`
            <marker id="temp-arrow-head" markerWidth="10" markerHeight="7"
                    refX="9" refY="3.5" orient="auto" markerUnits="strokeWidth">
              <polygon points="0 0, 10 3.5, 0 7" fill="var(--vscode-focusBorder)"/>
            </marker>\`;
          svg.insertBefore(defs, svg.firstChild);
        }

        tempArrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        tempArrow.classList.add('temp-link-arrow');
        tempArrow.setAttribute('stroke', 'var(--vscode-focusBorder)');
        tempArrow.setAttribute('stroke-width', '2');
        tempArrow.setAttribute('fill', 'none');
        tempArrow.setAttribute('marker-end', 'url(#temp-arrow-head)');
        svg.appendChild(tempArrow);

        linkingState = { fromId: issueId, fromBar: bar, startX: cx, startY: cy };
      });
    });

    // Escape to cancel linking mode and close pickers
    addDocListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (linkingState) {
          cancelLinking();
        }
        // Close any open picker
        document.querySelector('.relation-picker')?.remove();
      }
    });

    // Labels click and keyboard
    document.querySelectorAll('.issue-label').forEach(el => {
      el.addEventListener('click', () => {
        const issueId = parseInt(el.dataset.issueId);
        vscode.postMessage({ command: 'openIssue', issueId });
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const issueId = parseInt(el.dataset.issueId);
          vscode.postMessage({ command: 'openIssue', issueId });
        }
      });
    });

    // Handle drag move (resizing and linking)
    addDocListener('mousemove', (e) => {
      // Handle resize drag
      if (dragState) {
        const delta = e.clientX - dragState.initialMouseX;
        let newStartX = dragState.startX;
        let newEndX = dragState.endX;

        if (dragState.isLeft) {
          newStartX = snapToDay(Math.max(0, Math.min(dragState.startX + delta, dragState.endX - dayWidth)));
        } else {
          newEndX = snapToDay(Math.max(dragState.startX + dayWidth, Math.min(dragState.endX + delta, timelineWidth)));
        }

        const width = newEndX - newStartX;
        dragState.barOutline.setAttribute('x', newStartX);
        dragState.barOutline.setAttribute('width', width);
        if (dragState.barMain) {
          dragState.barMain.setAttribute('x', newStartX);
          dragState.barMain.setAttribute('width', width);
        }
        dragState.leftHandle.setAttribute('x', newStartX);
        dragState.rightHandle.setAttribute('x', newEndX - 8);
        dragState.newStartX = newStartX;
        dragState.newEndX = newEndX;
      }

      // Handle linking drag
      if (linkingState && tempArrow) {
        // Use container rect + scroll to get SVG coordinates
        const rect = timelineColumn.getBoundingClientRect();
        const scrollLeft = timelineColumn.scrollLeft;
        const scrollTop = timelineColumn.scrollTop;
        const endX = e.clientX - rect.left + scrollLeft;
        const endY = e.clientY - rect.top + scrollTop;

        // Draw dashed line from start to cursor
        const path = \`M \${linkingState.startX} \${linkingState.startY} L \${endX} \${endY}\`;
        tempArrow.setAttribute('d', path);

        // Find target bar under cursor
        const targetBar = document.elementFromPoint(e.clientX, e.clientY)?.closest('.issue-bar');
        if (currentTarget && currentTarget !== targetBar) {
          currentTarget.classList.remove('link-target');
        }
        if (targetBar && targetBar !== linkingState.fromBar) {
          targetBar.classList.add('link-target');
          currentTarget = targetBar;
        } else {
          currentTarget = null;
        }
      }
    });

    // Handle drag end (resizing and linking)
    addDocListener('mouseup', (e) => {
      // Handle resize drag end
      if (dragState) {
        const { issueId, isLeft, newStartX, newEndX, bar, startX, endX, oldStartDate, oldDueDate } = dragState;
        bar.classList.remove('dragging');

        if (newStartX !== undefined || newEndX !== undefined) {
          const calcStartDate = isLeft && newStartX !== startX ? xToDate(newStartX) : null;
          const calcDueDate = !isLeft && newEndX !== endX ? xToDate(newEndX) : null;
          const newStartDate = calcStartDate && calcStartDate !== oldStartDate ? calcStartDate : null;
          const newDueDate = calcDueDate && calcDueDate !== oldDueDate ? calcDueDate : null;

          if (newStartDate || newDueDate) {
            undoStack.push({
              issueId,
              oldStartDate: newStartDate ? oldStartDate : null,
              oldDueDate: newDueDate ? oldDueDate : null,
              newStartDate,
              newDueDate
            });
            redoStack.length = 0;
            updateUndoRedoButtons();
            vscode.postMessage({ command: 'updateDates', issueId, startDate: newStartDate, dueDate: newDueDate });
          }
        }
        dragState = null;
      }

      // Handle linking drag end
      if (linkingState) {
        const fromId = linkingState.fromId;
        if (currentTarget) {
          const toId = parseInt(currentTarget.dataset.issueId);
          // Prevent self-referential relations
          if (fromId !== toId) {
            showRelationPicker(e.clientX, e.clientY, fromId, toId);
          }
        }
        cancelLinking();
      }
    });

    // Undo button
    undoBtn.addEventListener('click', () => {
      if (undoStack.length === 0) return;
      const action = undoStack.pop();
      redoStack.push(action);
      updateUndoRedoButtons();
      saveState();

      if (action.type === 'relation') {
        // Undo relation action
        if (action.operation === 'create') {
          // Undo create = delete the relation
          vscode.postMessage({
            command: 'undoRelation',
            operation: 'delete',
            relationId: action.relationId,
            datesBefore: action.datesBefore
          });
        } else {
          // Undo delete = recreate the relation
          vscode.postMessage({
            command: 'undoRelation',
            operation: 'create',
            issueId: action.issueId,
            targetIssueId: action.targetIssueId,
            relationType: action.relationType
          });
        }
      } else {
        // Date change action
        vscode.postMessage({
          command: 'updateDates',
          issueId: action.issueId,
          startDate: action.oldStartDate,
          dueDate: action.oldDueDate
        });
      }
    });

    // Redo button
    redoBtn.addEventListener('click', () => {
      if (redoStack.length === 0) return;
      const action = redoStack.pop();
      undoStack.push(action);
      updateUndoRedoButtons();
      saveState();

      if (action.type === 'relation') {
        // Redo relation action
        if (action.operation === 'create') {
          // Redo create = recreate the relation
          vscode.postMessage({
            command: 'redoRelation',
            operation: 'create',
            issueId: action.issueId,
            targetIssueId: action.targetIssueId,
            relationType: action.relationType
          });
        } else {
          // Redo delete = delete the relation again
          vscode.postMessage({
            command: 'redoRelation',
            operation: 'delete',
            relationId: action.relationId
          });
        }
      } else {
        // Date change action
        vscode.postMessage({
          command: 'updateDates',
          issueId: action.issueId,
          startDate: action.newStartDate,
          dueDate: action.newDueDate
        });
      }
    });

    // Keyboard shortcuts
    addDocListener('keydown', (e) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modKey = isMac ? e.metaKey : e.ctrlKey;

      if (modKey && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undoBtn.click();
      } else if (modKey && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        redoBtn.click();
      } else if (modKey && e.key === 'y') {
        e.preventDefault();
        redoBtn.click();
      }
    });

    // Scroll to today marker (centered)
    const todayX = ${Math.round(todayX)};
    function scrollToToday() {
      if (timelineColumn && todayX > 0) {
        const containerWidth = timelineColumn.clientWidth;
        timelineColumn.scrollLeft = Math.max(0, todayX - containerWidth / 2);
      }
    }

    // Restore scroll position or scroll to today on initial load
    if (savedCenterDateMs !== null && timelineColumn) {
      // Zoom change: restore by centering on saved date
      scrollToCenterDate(savedCenterDateMs);
      if (savedScrollTop !== null) {
        timelineColumn.scrollTop = savedScrollTop;
        labelsColumn.scrollTop = savedScrollTop;
      }
      savedCenterDateMs = null;
      savedScrollTop = null;
    } else if (savedScrollLeft !== null && timelineColumn) {
      // Other operations: restore pixel position
      timelineColumn.scrollLeft = savedScrollLeft;
      if (savedScrollTop !== null) {
        timelineColumn.scrollTop = savedScrollTop;
        labelsColumn.scrollTop = savedScrollTop;
      }
      savedScrollLeft = null;
      savedScrollTop = null;
    } else {
      scrollToToday();
    }

    // Today button handler
    document.getElementById('todayBtn').addEventListener('click', scrollToToday);

    // Column resize handling
    const resizeHandle = document.getElementById('resizeHandle');
    let isResizing = false;
    let resizeStartX = 0;
    let resizeStartWidth = 0;

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      resizeStartX = e.clientX;
      resizeStartWidth = ganttLeft.offsetWidth;
      resizeHandle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    addDocListener('mousemove', (e) => {
      if (!isResizing) return;
      const delta = e.clientX - resizeStartX;
      const newWidth = Math.min(500, Math.max(150, resizeStartWidth + delta));
      ganttLeft.style.width = newWidth + 'px';
    });

    addDocListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        resizeHandle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        saveState(); // Persist new column width
      }
    });
  </script>
</body>
</html>`;
  }

  private _getEmptyHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>Redmine Gantt</title>
  <style>
    body {
      padding: 20px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
    }
  </style>
</head>
<body>
  <h2>Timeline</h2>
  <p>No issues with dates to display. Add start_date or due_date to your issues.</p>
</body>
</html>`;
  }

  private _getStatusColor(
    status: FlexibilityScore["status"] | null
  ): string {
    switch (status) {
      case "overbooked":
        return "var(--vscode-charts-red)";
      case "at-risk":
        return "var(--vscode-charts-orange)";
      case "on-track":
        return "var(--vscode-charts-green)";
      case "completed":
        return "var(--vscode-charts-blue)";
      default:
        return "var(--vscode-charts-foreground)";
    }
  }

  /**
   * Generate date markers split into header (fixed) and body (scrollable) parts
   * Adapts to zoom level for appropriate granularity
   */
  private _generateDateMarkers(
    minDate: Date,
    maxDate: Date,
    svgWidth: number,
    leftMargin: number,
    zoomLevel: ZoomLevel = "day",
    workloadMap: Map<string, number>,
    showHeatmap: boolean
  ): { header: string; body: string } {
    const headerContent: string[] = [];
    const heatmapBackgrounds: string[] = [];
    const weekendBackgrounds: string[] = [];
    const bodyGridLines: string[] = [];
    const bodyMarkers: string[] = [];
    const current = new Date(minDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dayWidth =
      (svgWidth - leftMargin) /
      ((maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24));

    // Track last shown markers to avoid duplicates
    let lastMonth = -1;
    let lastQuarter = -1;
    let lastYear = -1;

    while (current <= maxDate) {
      const x =
        leftMargin +
        ((current.getTime() - minDate.getTime()) /
          (maxDate.getTime() - minDate.getTime())) *
          (svgWidth - leftMargin);

      const dayOfWeek = current.getUTCDay();
      const dayOfMonth = current.getUTCDate();
      const month = current.getUTCMonth();
      const year = current.getUTCFullYear();
      const quarter = Math.floor(month / 3) + 1;

      // Always generate heatmap backgrounds (toggle via CSS)
      const dateKey = current.toISOString().slice(0, 10);
      const utilization = workloadMap.get(dateKey) ?? 0;
      const color = getHeatmapColor(utilization);
      if (color !== "transparent") {
        heatmapBackgrounds.push(`
          <rect x="${x}" y="0" width="${dayWidth}" height="100%" fill="${color}" opacity="0.15"/>
        `);
      }

      // Always generate weekend backgrounds for day/week zoom (toggle via CSS)
      if ((zoomLevel === "day" || zoomLevel === "week") && (dayOfWeek === 0 || dayOfWeek === 6)) {
        weekendBackgrounds.push(`
          <rect x="${x}" y="0" width="${dayWidth}" height="100%" class="weekend-bg"/>
        `);
      }

      // Year markers (for quarter/year zoom)
      if ((zoomLevel === "quarter" || zoomLevel === "year") && month === 0 && dayOfMonth === 1 && lastYear !== year) {
        lastYear = year;
        headerContent.push(`
          <line x1="${x}" y1="0" x2="${x}" y2="40" class="date-marker"/>
          <text x="${x + 4}" y="14" fill="var(--vscode-foreground)" font-size="12" font-weight="bold">${year}</text>
        `);
        bodyGridLines.push(`
          <line x1="${x}" y1="0" x2="${x}" y2="100%" class="day-grid"/>
        `);
      }

      // Quarter markers (for quarter zoom)
      if (zoomLevel === "quarter" && dayOfMonth === 1 && (month % 3 === 0) && lastQuarter !== quarter) {
        lastQuarter = quarter;
        const quarterLabel = `Q${quarter}`;
        headerContent.push(`
          <text x="${x + 4}" y="30" fill="var(--vscode-descriptionForeground)" font-size="10">${quarterLabel}</text>
        `);
        if (month !== 0) { // Don't double line on Jan 1
          bodyGridLines.push(`
            <line x1="${x}" y1="0" x2="${x}" y2="100%" class="day-grid" style="opacity: 0.2"/>
          `);
        }
      }

      // Month markers (for month/quarter/year zoom)
      if ((zoomLevel === "month" || zoomLevel === "quarter" || zoomLevel === "year") && dayOfMonth === 1 && lastMonth !== month) {
        lastMonth = month;
        const monthLabel = current.toLocaleString("en", { month: "short" });
        if (zoomLevel === "month") {
          headerContent.push(`
            <line x1="${x}" y1="0" x2="${x}" y2="40" class="date-marker"/>
            <text x="${x + 4}" y="14" fill="var(--vscode-foreground)" font-size="11" font-weight="bold">${monthLabel} ${year}</text>
          `);
          bodyGridLines.push(`
            <line x1="${x}" y1="0" x2="${x}" y2="100%" class="day-grid"/>
          `);
        } else if (zoomLevel === "year") {
          headerContent.push(`
            <text x="${x + 2}" y="30" fill="var(--vscode-descriptionForeground)" font-size="9">${monthLabel}</text>
          `);
        }
      }

      // Week markers (for day/week/month zoom)
      if ((zoomLevel === "day" || zoomLevel === "week" || zoomLevel === "month") && dayOfWeek === 1) {
        const weekNum = getWeekNumber(current);
        const weekEnd = new Date(current);
        weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
        const startDay = dayOfMonth;
        const startMonth = current.toLocaleString("en", { month: "short", timeZone: "UTC" });
        const endDay = weekEnd.getUTCDate();
        const endMonth = weekEnd.toLocaleString("en", { month: "short", timeZone: "UTC" });
        const dateRange = startMonth === endMonth
          ? `${startDay}-${endDay} ${endMonth}`
          : `${startDay} ${startMonth} - ${endDay} ${endMonth}`;

        if (zoomLevel === "day") {
          // Day zoom: full week info on top line
          headerContent.push(`
            <line x1="${x}" y1="0" x2="${x}" y2="40" class="date-marker"/>
            <text x="${x + 4}" y="14" fill="var(--vscode-foreground)" font-size="11" font-weight="bold">W${weekNum} (${dateRange}) ${year}</text>
          `);
        } else if (zoomLevel === "week") {
          // Week zoom: W48, 2025 on top, 24-30 Nov on bottom (centered within week)
          const weekWidth = dayWidth * 7;
          headerContent.push(`
            <line x1="${x}" y1="0" x2="${x}" y2="40" class="date-marker"/>
            <text x="${x + weekWidth / 2}" y="14" fill="var(--vscode-foreground)" font-size="11" font-weight="bold" text-anchor="middle">W${weekNum}, ${year}</text>
            <text x="${x + weekWidth / 2}" y="30" fill="var(--vscode-descriptionForeground)" font-size="10" text-anchor="middle">${dateRange}</text>
          `);
        } else {
          // Month zoom - just show week number
          headerContent.push(`
            <text x="${x + 2}" y="30" fill="var(--vscode-descriptionForeground)" font-size="9">W${weekNum}</text>
          `);
        }
        if (zoomLevel !== "day") {
          // Day zoom has its own grid lines for each day
          bodyGridLines.push(`
            <line x1="${x}" y1="0" x2="${x}" y2="100%" class="day-grid"/>
          `);
        }
      }

      // Day markers (for day zoom - show ALL days)
      if (zoomLevel === "day") {
        const dayLabel = `${dayOfMonth} ${WEEKDAYS_SHORT[dayOfWeek]}`;
        headerContent.push(`
          <text x="${x + dayWidth / 2}" y="30" fill="var(--vscode-descriptionForeground)" font-size="10" text-anchor="middle">${dayLabel}</text>
        `);
        bodyGridLines.push(`
          <line x1="${x}" y1="0" x2="${x}" y2="100%" class="day-grid"/>
        `);
      }

      // Today marker (all zoom levels)
      if (current.toDateString() === today.toDateString()) {
        bodyMarkers.push(`
          <line x1="${x}" y1="0" x2="${x}" y2="100%" class="today-marker"/>
        `);
        headerContent.push(`
          <line x1="${x}" y1="0" x2="${x}" y2="40" class="today-marker"/>
        `);
      }

      current.setUTCDate(current.getUTCDate() + 1);
    }

    // Wrap backgrounds in groups for CSS-based visibility toggle
    const heatmapGroup = `<g class="heatmap-layer" style="${showHeatmap ? "" : "display: none;"}">${heatmapBackgrounds.join("")}</g>`;
    const weekendGroup = `<g class="weekend-layer" style="${showHeatmap ? "display: none;" : ""}">${weekendBackgrounds.join("")}</g>`;

    return {
      header: headerContent.join(""),
      body: heatmapGroup + weekendGroup + bodyGridLines.join("") + bodyMarkers.join(""),
    };
  }
}

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
