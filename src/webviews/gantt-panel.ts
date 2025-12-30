import * as vscode from "vscode";
import * as crypto from "crypto";
import { Issue, IssueRelation } from "../redmine/models/issue";
import { RedmineServer } from "../redmine/redmine-server";
import { RedmineProject } from "../redmine/redmine-project";
import { FlexibilityScore, WeeklySchedule, DEFAULT_WEEKLY_SCHEDULE } from "../utilities/flexibility-calculator";
import { showStatusBarMessage } from "../utilities/status-bar";
import { errorToString } from "../utilities/error-feedback";
import { buildProjectHierarchy, flattenHierarchyAll, FlatNodeWithVisibility, HierarchyNode } from "../utilities/hierarchy-builder";
import { collapseState } from "../utilities/collapse-state";
import { debounce, DebouncedFunction } from "../utilities/debounce";
import { IssueFilter, DEFAULT_ISSUE_FILTER } from "../redmine/models/common";

const COLLAPSE_DEBOUNCE_MS = 50;

type ZoomLevel = "day" | "week" | "month" | "quarter" | "year";


// Pixels per day for each zoom level
const ZOOM_PIXELS_PER_DAY: Record<ZoomLevel, number> = {
  day: 40,
  week: 15,
  month: 5,
  quarter: 2,
  year: 0.8,
};

// Redmine relation types (creatable via API)
type CreatableRelationType = "relates" | "duplicates" | "blocks" | "precedes" | "follows" | "copied_to";
// All relation types (including inverse types returned by API)
type RelationType = CreatableRelationType | "blocked";

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
  isClosed: boolean;
  project: string;
  projectId: number;
  parentId: number | null;
  estimated_hours: number | null;
  spent_hours: number | null;
  done_ratio: number;
  relations: GanttRelation[];
  assignee: string | null;
}

interface GanttRow {
  type: "project" | "issue";
  id: number;
  label: string;
  depth: number;
  issue?: GanttIssue;
  /** True if this issue has subtasks (dates/hours are derived) */
  isParent?: boolean;
  /** Unique key for collapse tracking (project-{id} or issue-{id}) */
  collapseKey: string;
  /** Parent's collapse key (for filtering hidden rows) */
  parentKey: string | null;
  /** True if has children (can be collapsed) */
  hasChildren: boolean;
  /** Child issue date ranges for aggregate bar rendering (projects only) */
  childDateRanges?: Array<{ startDate: string | null; dueDate: string | null; issueId: number }>;
  /** Whether this row is visible (based on parent collapse state) - for client-side collapse */
  isVisible: boolean;
  /** Whether this row is expanded (if it has children) - for client-side collapse */
  isExpanded: boolean;
}


/**
 * Convert Issue to GanttIssue for SVG rendering
 */
function toGanttIssue(issue: Issue, flexibilityCache: Map<number, FlexibilityScore | null>, closedStatusIds: Set<number>): GanttIssue {
  return {
    id: issue.id,
    subject: issue.subject,
    start_date: issue.start_date || null,
    due_date: issue.due_date || null,
    status: flexibilityCache.get(issue.id)?.status ?? null,
    isClosed: closedStatusIds.has(issue.status?.id ?? 0),
    project: issue.project?.name ?? "Unknown",
    projectId: issue.project?.id ?? 0,
    parentId: issue.parent?.id ?? null,
    estimated_hours: issue.estimated_hours ?? null,
    spent_hours: issue.spent_hours ?? null,
    done_ratio: issue.done_ratio ?? 0,
    relations: (issue.relations || [])
      .filter((r) => {
        // Combined filter: exclude reverse relation types AND self-references
        const type = r.relation_type;
        return type !== "blocked" && type !== "duplicated" &&
               type !== "copied_from" && type !== "follows" &&
               r.issue_to_id !== issue.id && r.issue_id !== r.issue_to_id;
      })
      .map((r) => ({
        id: r.id,
        targetId: r.issue_to_id,
        type: r.relation_type as RelationType,
      })),
    assignee: issue.assigned_to?.name ?? null,
  };
}

/**
 * Convert FlatNodeWithVisibility to GanttRow for SVG rendering
 */
function nodeToGanttRow(node: FlatNodeWithVisibility, flexibilityCache: Map<number, FlexibilityScore | null>, closedStatusIds: Set<number>): GanttRow {
  if (node.type === "project") {
    return {
      type: "project",
      id: node.id,
      label: node.label,
      depth: node.depth,
      collapseKey: node.collapseKey,
      parentKey: node.parentKey,
      hasChildren: node.children.length > 0,
      childDateRanges: node.childDateRanges,
      isVisible: node.isVisible,
      isExpanded: node.isExpanded,
    };
  }

  const issue = node.issue!;
  return {
    type: "issue",
    id: node.id,
    label: node.label,
    depth: node.depth,
    issue: toGanttIssue(issue, flexibilityCache, closedStatusIds),
    isParent: node.children.length > 0,
    collapseKey: node.collapseKey,
    parentKey: node.parentKey,
    hasChildren: node.children.length > 0,
    isVisible: node.isVisible,
    isExpanded: node.isExpanded,
  };
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
  issues: { start_date?: string | null; due_date?: string | null; estimated_hours?: number | null }[],
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
const HIDDEN_PROJECTS_KEY = "redmine.gantt.hiddenProjects";

export class GanttPanel {
  public static currentPanel: GanttPanel | undefined;
  private static _globalState: vscode.Memento | undefined;

  /** Initialize GanttPanel with globalState for persistence */
  public static initialize(globalState: vscode.Memento): void {
    GanttPanel._globalState = globalState;
  }

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _issues: Issue[] = [];
  private _issueById: Map<number, Issue> = new Map(); // O(1) lookup cache
  private _projects: RedmineProject[] = [];
  private _flexibilityCache: Map<number, FlexibilityScore | null> = new Map();
  private _server: RedmineServer | undefined;
  private _zoomLevel: ZoomLevel = "day";
  private _schedule: WeeklySchedule = DEFAULT_WEEKLY_SCHEDULE;
  private _showWorkloadHeatmap: boolean = false;
  private _showDependencies: boolean = true;
  private _showIntensity: boolean = false;
  private _scrollPosition: { left: number; top: number } = { left: 0, top: 0 };
  private _extendedRelationTypes: boolean = false;
  private _closedStatusIds: Set<number> = new Set();
  private _hiddenProjects: Set<number> = new Set(); // Projects hidden from view (persisted)
  private _debouncedCollapseUpdate: DebouncedFunction<() => void>;
  private _cachedHierarchy?: HierarchyNode[];
  private _skipCollapseRerender = false; // Skip re-render when collapse is from client-side
  private _renderKey = 0; // Incremented on each render to force SVG re-creation
  private _isRefreshing = false; // Show loading overlay during data refresh
  private _currentFilter: IssueFilter = { ...DEFAULT_ISSUE_FILTER };
  private _filterChangeCallback?: (filter: IssueFilter) => void;

  private constructor(panel: vscode.WebviewPanel, server?: RedmineServer) {
    this._panel = panel;
    this._server = server;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (message) => this._handleMessage(message),
      null,
      this._disposables
    );

    // Restore hidden projects from globalState
    if (GanttPanel._globalState) {
      const saved = GanttPanel._globalState.get<number[]>(HIDDEN_PROJECTS_KEY, []);
      this._hiddenProjects = new Set(saved);
    }

    // Create debounced collapse update to prevent rapid re-renders
    this._debouncedCollapseUpdate = debounce(COLLAPSE_DEBOUNCE_MS, () => this._updateContent());

    // Listen for collapse state changes from other views (Issues pane)
    // Skip re-render if triggered by our own collapse (we update directly)
    this._disposables.push(
      collapseState.onDidChange(() => {
        if (this._skipCollapseRerender) {
          this._skipCollapseRerender = false;
          return;
        }
        // Debounced update for external changes (e.g., from Issues pane)
        this._debouncedCollapseUpdate();
      })
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

  /**
   * Restore panel from serialized state (after window reload)
   */
  public static restore(panel: vscode.WebviewPanel, server?: RedmineServer): GanttPanel {
    GanttPanel.currentPanel = new GanttPanel(panel, server);
    GanttPanel.currentPanel._showLoadingSkeleton();
    return GanttPanel.currentPanel;
  }

  private _showLoadingSkeleton(): void {
    const nonce = getNonce();
    const labelWidth = 250;
    const headerHeight = 40;
    const barHeight = 30;
    const barGap = 10;
    const rowCount = 8;

    // Generate skeleton rows
    const skeletonRows = Array.from({ length: rowCount }, (_, i) => {
      const y = i * (barHeight + barGap);
      const isProject = i % 3 === 0;
      const indent = isProject ? 0 : 16;
      // Vary bar positions and widths for visual interest
      const barStart = 50 + (i * 37) % 200;
      const barWidth = 80 + (i * 53) % 150;
      return {
        y,
        isProject,
        indent,
        barStart,
        barWidth,
        delay: i * 0.1
      };
    });

    const labelsSvg = skeletonRows.map((r, i) => `
      <g class="skeleton-label delay-${Math.min(i, 7)}">
        <rect x="${5 + r.indent}" y="${r.y + 8}" width="${r.isProject ? 120 : 160}" height="14" rx="3" fill="var(--vscode-panel-border)"/>
      </g>
    `).join("");

    const barsSvg = skeletonRows.map((r, i) => `
      <g class="skeleton-bar-group delay-${Math.min(i, 7)}">
        <rect x="${r.barStart}" y="${r.y + 4}" width="${r.barWidth}" height="${barHeight - 8}" rx="4"
              fill="var(--vscode-panel-border)" class="skeleton-timeline-bar"/>
      </g>
    `).join("");

    const zebraStripes = skeletonRows
      .filter((_, i) => i % 2 === 1)
      .map(r => `<rect x="0" y="${r.y}" width="100%" height="${barHeight + barGap}" fill="var(--vscode-list-hoverBackground)" opacity="0.3"/>`)
      .join("");

    this._panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
  <title>Redmine Gantt</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
    }
    .gantt-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .gantt-header h2 { margin: 0; font-size: 16px; }
    .gantt-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .gantt-actions button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 12px;
      opacity: 0.5;
      cursor: not-allowed;
    }
    .zoom-toggle {
      display: flex;
      gap: 2px;
      background: var(--vscode-input-background);
      padding: 2px;
      border-radius: 4px;
    }
    .gantt-container {
      display: flex;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      height: calc(100vh - 150px);
    }
    .gantt-left {
      width: ${labelWidth}px;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--vscode-panel-border);
    }
    .gantt-left-header {
      height: ${headerHeight}px;
      display: flex;
      align-items: center;
      padding: 4px 8px;
      gap: 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .gantt-left-header button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 10px;
      opacity: 0.5;
    }
    .gantt-labels {
      flex-grow: 1;
      overflow: hidden;
    }
    .gantt-right {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .gantt-timeline-header {
      height: ${headerHeight}px;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      align-items: center;
      padding: 0 16px;
    }
    .loading-text {
      font-size: 12px;
      opacity: 0.7;
      animation: pulse 1.5s ease-in-out infinite;
    }
    .gantt-timeline {
      flex-grow: 1;
      overflow: hidden;
    }
    svg { display: block; }
    @keyframes pulse {
      0%, 100% { opacity: 0.3; }
      50% { opacity: 0.7; }
    }
    .skeleton-label, .skeleton-bar-group {
      animation: pulse 1.5s ease-in-out infinite;
    }
    .skeleton-timeline-bar {
      animation: pulse 1.5s ease-in-out infinite;
    }
    /* Animation delay classes to avoid inline styles (CSP compliance) */
    .delay-0 { animation-delay: 0s; }
    .delay-1 { animation-delay: 0.1s; }
    .delay-2 { animation-delay: 0.2s; }
    .delay-3 { animation-delay: 0.3s; }
    .delay-4 { animation-delay: 0.4s; }
    .delay-5 { animation-delay: 0.5s; }
    .delay-6 { animation-delay: 0.6s; }
    .delay-7 { animation-delay: 0.7s; }
    .minimap-container {
      height: 50px;
      background: var(--vscode-sideBar-background);
      border-top: 1px solid var(--vscode-panel-border);
    }
  </style>
</head>
<body>
  <div class="gantt-header">
    <h2>Timeline</h2>
    <div class="gantt-actions">
      <div class="zoom-toggle">
        <button>Day</button>
        <button>Week</button>
        <button>Month</button>
        <button>Quarter</button>
        <button>Year</button>
      </div>
      <button>Heatmap</button>
      <button>Deps</button>
      <button>Intensity</button>
      <button>Critical</button>
      <button>Today</button>
    </div>
  </div>
  <div class="gantt-container">
    <div class="gantt-left">
      <div class="gantt-left-header">
        <button>▼</button>
        <button>▶</button>
      </div>
      <div class="gantt-labels">
        <svg width="${labelWidth}" height="${rowCount * (barHeight + barGap)}">
          ${zebraStripes}
          ${labelsSvg}
        </svg>
      </div>
    </div>
    <div class="gantt-right">
      <div class="gantt-timeline-header">
        <span class="loading-text">Loading issues...</span>
      </div>
      <div class="gantt-timeline">
        <svg width="100%" height="${rowCount * (barHeight + barGap)}">
          ${zebraStripes}
          ${barsSvg}
        </svg>
      </div>
    </div>
  </div>
  <div class="minimap-container"></div>
</body>
</html>`;
  }

  public async updateIssues(
    issues: Issue[],
    flexibilityCache: Map<number, FlexibilityScore | null>,
    projects: RedmineProject[],
    schedule?: WeeklySchedule,
    filter?: IssueFilter
  ): Promise<void> {
    // Update schedule if provided
    if (schedule) {
      this._schedule = schedule;
    }
    // Update filter if provided
    if (filter) {
      this._currentFilter = { ...filter };
    }

    // Store issues with dates, projects, and flexibilityCache for shared sorting
    this._issues = issues.filter((i) => i.start_date || i.due_date);
    // Build O(1) lookup map
    this._issueById = new Map(this._issues.map(i => [i.id, i]));
    this._projects = projects;
    this._flexibilityCache = flexibilityCache;

    // Invalidate hierarchy cache when data changes
    this._cachedHierarchy = undefined;

    // Fetch closed status IDs if not cached
    if (this._closedStatusIds.size === 0 && this._server) {
      try {
        const statuses = await this._server.getIssueStatuses();
        this._closedStatusIds = new Set(
          statuses.issue_statuses.filter(s => s.is_closed).map(s => s.id)
        );
      } catch {
        // Ignore errors, just won't show closed status
      }
    }

    this._updateContent();
  }

  /**
   * Update a single issue's done_ratio without full refresh
   */
  public updateIssueDoneRatio(issueId: number, doneRatio: number): void {
    const issue = this._issueById.get(issueId);
    if (issue) {
      issue.done_ratio = doneRatio;
      this._updateContent();
    }
  }

  /**
   * Add a relation to local issue data without full refresh
   */
  private _addRelationLocally(
    issueId: number,
    targetIssueId: number,
    relationType: string,
    relationId: number
  ): void {
    const issue = this._issueById.get(issueId);
    if (issue) {
      if (!issue.relations) {
        issue.relations = [];
      }
      issue.relations.push({
        id: relationId,
        issue_id: issueId,
        issue_to_id: targetIssueId,
        relation_type: relationType as IssueRelation["relation_type"],
      });
      this._updateContent();
    }
  }

  /**
   * Remove a relation from local issue data without full refresh
   */
  private _removeRelationLocally(relationId: number): void {
    for (const issue of this._issues) {
      if (issue.relations) {
        const idx = issue.relations.findIndex((r) => r.id === relationId);
        if (idx !== -1) {
          issue.relations.splice(idx, 1);
          this._updateContent();
          return;
        }
      }
    }
  }

  /**
   * Scroll to and highlight a specific issue in the Gantt chart
   */
  public scrollToIssue(issueId: number): void {
    this._panel.webview.postMessage({
      command: "scrollToIssue",
      issueId,
    });
  }

  /**
   * Set callback for when filter changes in Gantt UI
   */
  public setFilterChangeCallback(callback: (filter: IssueFilter) => void): void {
    this._filterChangeCallback = callback;
  }

  private _updateContent(): void {
    this._renderKey++; // Force SVG re-creation on each render
    this._panel.webview.html = this._getHtmlContent();
    this._isRefreshing = false; // Reset after render
  }

  private _handleMessage(message: {
    command: string;
    issueId?: number;
    issueIds?: number[]; // For bulk operations
    startDate?: string | null;
    dueDate?: string | null;
    zoomLevel?: ZoomLevel;
    relationId?: number;
    targetIssueId?: number;
    relationType?: CreatableRelationType;
    left?: number;
    top?: number;
    operation?: string;
    collapseKey?: string;
    action?: string;
    keys?: string[];
    projectId?: number;
    projectIds?: number[]; // For setAllProjectsVisibility
    visible?: boolean; // For setAllProjectsVisibility
    isExpanded?: boolean; // For collapseStateSync
    filter?: { assignee?: string; status?: string }; // For setFilter
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
      case "toggleDependencies":
        this._showDependencies = !this._showDependencies;
        this._panel.webview.postMessage({
          command: "setDependenciesState",
          enabled: this._showDependencies,
        });
        break;
      case "toggleIntensity":
        this._showIntensity = !this._showIntensity;
        // Intensity affects bar rendering, so we need to re-render
        this._updateContent();
        break;
      case "refresh":
        // Set refreshing flag so next render shows loading overlay
        this._isRefreshing = true;
        // Clear cache and refetch data (including new relations)
        vscode.commands.executeCommand("redmine.refreshIssues");
        break;
      case "toggleCollapse":
        if (message.collapseKey) {
          const key = message.collapseKey as string;
          // Skip the debounced update from onDidChange - we'll update directly
          this._skipCollapseRerender = true;
          // Use shared collapse state (syncs with Issues pane)
          // action: 'collapse' = only collapse, 'expand' = only expand, undefined = toggle
          if (message.action === "collapse") {
            collapseState.collapse(key);
          } else if (message.action === "expand") {
            collapseState.expand(key);
          } else {
            collapseState.toggle(key);
          }
          // Immediate update to ensure zebra stripes align with new visible rows
          this._updateContent();
        }
        break;
      case "expandAll":
        this._skipCollapseRerender = true;
        collapseState.expandAll(message.keys);
        this._updateContent();
        break;
      case "collapseAll":
        this._skipCollapseRerender = true;
        collapseState.collapseAll();
        this._updateContent();
        break;
      case "collapseStateSync":
        // Client-side collapse already done, just sync state for persistence
        // Set flag to skip re-render since client already updated UI
        if (message.collapseKey) {
          this._skipCollapseRerender = true;
          if (message.isExpanded) {
            collapseState.expand(message.collapseKey);
          } else {
            collapseState.collapse(message.collapseKey);
          }
        }
        break;
      case "toggleProjectVisibility":
        if (message.projectId !== undefined) {
          const projectId = message.projectId as number;
          const wasDirectlyHidden = this._hiddenProjects.has(projectId);

          // Build project hierarchy helpers
          const projectMap = new Map(this._projects.map(p => [p.id, p]));
          const childrenMap = new Map<number, number[]>();
          for (const p of this._projects) {
            if (p.parent?.id) {
              const siblings = childrenMap.get(p.parent.id) ?? [];
              siblings.push(p.id);
              childrenMap.set(p.parent.id, siblings);
            }
          }
          const getAncestors = (id: number): number[] => {
            const ancestors: number[] = [];
            let current = projectMap.get(id);
            while (current?.parent?.id) {
              ancestors.push(current.parent.id);
              current = projectMap.get(current.parent.id);
            }
            return ancestors;
          };
          const getDescendants = (id: number): number[] => {
            const descendants: number[] = [];
            const stack = childrenMap.get(id) ?? [];
            while (stack.length > 0) {
              const childId = stack.pop()!;
              descendants.push(childId);
              stack.push(...(childrenMap.get(childId) ?? []));
            }
            return descendants;
          };

          if (wasDirectlyHidden) {
            // Show project + all descendants
            this._hiddenProjects.delete(projectId);
            for (const descendantId of getDescendants(projectId)) {
              this._hiddenProjects.delete(descendantId);
            }
          } else {
            // Check if inherited hidden (ancestor is hidden)
            const ancestors = getAncestors(projectId);
            const hiddenAncestor = ancestors.find(id => this._hiddenProjects.has(id));
            if (hiddenAncestor !== undefined) {
              // Inherited hidden - show by unhiding ancestors + this project's descendants
              for (const ancestorId of ancestors) {
                this._hiddenProjects.delete(ancestorId);
              }
              for (const descendantId of getDescendants(projectId)) {
                this._hiddenProjects.delete(descendantId);
              }
            } else {
              // Not hidden at all - hide it (children auto-hidden via effectiveHiddenProjects)
              this._hiddenProjects.add(projectId);
            }
          }
          // Persist hidden projects to globalState
          GanttPanel._globalState?.update(HIDDEN_PROJECTS_KEY, [...this._hiddenProjects]);
          // Full re-render to update date range and minimap
          this._updateContent();
        }
        break;
      case "setAllProjectsVisibility":
        if (message.visible !== undefined && Array.isArray(message.projectIds)) {
          if (message.visible) {
            // Show all - remove from hidden set
            for (const id of message.projectIds) {
              this._hiddenProjects.delete(id);
            }
          } else {
            // Hide all - add to hidden set
            for (const id of message.projectIds) {
              this._hiddenProjects.add(id);
            }
          }
          GanttPanel._globalState?.update(HIDDEN_PROJECTS_KEY, [...this._hiddenProjects]);
          this._updateContent();
        }
        break;
      case "scrollPosition":
        // Store scroll position for restoration after update
        if (message.left !== undefined && message.top !== undefined) {
          this._scrollPosition = { left: message.left, top: message.top };
        }
        break;
      case "undoRelation":
        if (this._server && message.operation) {
          this._handleUndoRelation(message as { operation: string; relationId?: number; issueId?: number; targetIssueId?: number; relationType?: string });
        }
        break;
      case "redoRelation":
        if (this._server && message.operation) {
          this._handleRedoRelation(message as { operation: string; relationId?: number; issueId?: number; targetIssueId?: number; relationType?: string });
        }
        break;
      case "openInBrowser":
        if (message.issueId) {
          vscode.commands.executeCommand("redmine.openIssueInBrowser", { id: message.issueId });
        }
        break;
      case "showInIssues":
        if (message.issueId) {
          vscode.commands.executeCommand("redmine.revealIssueInTree", message.issueId);
        }
        break;
      case "logTime":
        if (message.issueId) {
          vscode.commands.executeCommand("redmine.quickLogTime", { id: message.issueId });
        }
        break;
      case "setDoneRatio":
        if (message.issueId) {
          vscode.commands.executeCommand("redmine.setDoneRatio", { id: message.issueId });
        }
        break;
      case "bulkSetDoneRatio":
        if (message.issueIds && message.issueIds.length > 0) {
          vscode.commands.executeCommand("redmine.bulkSetDoneRatio", message.issueIds);
        }
        break;
      case "copyUrl":
        if (message.issueId) {
          vscode.commands.executeCommand("redmine.copyIssueUrl", { id: message.issueId });
        }
        break;
      case "toggleAutoUpdate":
        if (message.issueId) {
          vscode.commands.executeCommand("redmine.toggleAutoUpdateDoneRatio", { id: message.issueId });
        }
        break;
      case "setFilter":
        if (message.filter) {
          const newFilter: IssueFilter = {
            assignee: (message.filter.assignee as "me" | "any") ?? this._currentFilter.assignee,
            status: (message.filter.status as "open" | "closed" | "any") ?? this._currentFilter.status,
          };
          this._currentFilter = newFilter;
          // Notify callback to sync with ProjectsTree (triggers data refresh)
          if (this._filterChangeCallback) {
            this._filterChangeCallback(newFilter);
          }
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
      const issue = this._issueById.get(issueId);
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
        `Failed to update dates: ${errorToString(error)}`
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
        const rel = issue.relations?.find((r) => r.id === relationId);
        if (rel) {
          relationInfo = {
            issueId: issue.id,
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
        if (issue.relations) {
          issue.relations = issue.relations.filter((r) => r.id !== relationId);
        }
      }
      this._updateContent();
      showStatusBarMessage("$(check) Relation deleted", 2000);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to delete relation: ${errorToString(error)}`
      );
    }
  }

  private async _createRelation(
    issueId: number,
    targetIssueId: number,
    relationType: CreatableRelationType
  ): Promise<void> {
    if (!this._server) return;

    const labels: Record<CreatableRelationType, string> = {
      relates: "Related to",
      duplicates: "Duplicates",
      blocks: "Blocks",
      precedes: "Precedes",
      follows: "Follows",
      copied_to: "Copied to",
    };

    try {
      // Capture dates before creation (Redmine may adjust dates for precedes/blocks)
      const sourceIssue = this._issueById.get(issueId);
      const targetIssue = this._issueById.get(targetIssueId);
      const datesBefore = {
        source: { start: sourceIssue?.start_date, due: sourceIssue?.due_date },
        target: { start: targetIssue?.start_date, due: targetIssue?.due_date },
      };

      // Create relation and get the ID
      const response = await this._server.createRelation(issueId, targetIssueId, relationType);
      const relationId = response.relation.id;

      showStatusBarMessage(`$(check) ${labels[relationType]} relation created`, 2000);

      // Send undo action to webview
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

      // Update local data and re-render (no full refresh)
      this._addRelationLocally(issueId, targetIssueId, relationType, relationId);
    } catch (error) {
      const msg = errorToString(error);
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
        this._removeRelationLocally(message.relationId);
        showStatusBarMessage("$(check) Relation undone", 2000);
      } else if (message.operation === "create" && message.issueId && message.targetIssueId && message.relationType) {
        // Undo delete = recreate the relation
        const response = await this._server.createRelation(
          message.issueId,
          message.targetIssueId,
          message.relationType as CreatableRelationType
        );
        // Send new relationId to update redo stack
        this._panel.webview.postMessage({
          command: "updateRelationId",
          stack: "redo",
          newRelationId: response.relation.id,
        });
        this._addRelationLocally(message.issueId, message.targetIssueId, message.relationType, response.relation.id);
        showStatusBarMessage("$(check) Relation restored", 2000);
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to undo relation: ${errorToString(error)}`
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
          message.relationType as CreatableRelationType
        );
        // Send new relationId to update undo stack
        this._panel.webview.postMessage({
          command: "updateRelationId",
          stack: "undo",
          newRelationId: response.relation.id,
        });
        this._addRelationLocally(message.issueId, message.targetIssueId, message.relationType, response.relation.id);
        showStatusBarMessage("$(check) Relation recreated", 2000);
      } else if (message.operation === "delete" && message.relationId) {
        // Redo delete = delete the relation again
        await this._server.deleteRelation(message.relationId);
        this._removeRelationLocally(message.relationId);
        showStatusBarMessage("$(check) Relation deleted", 2000);
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to redo relation: ${errorToString(error)}`
      );
    }
  }

  public dispose(): void {
    GanttPanel.currentPanel = undefined;
    this._debouncedCollapseUpdate.cancel();
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  private _getHtmlContent(): string {
    const nonce = getNonce();

    // Today for calculations (start of today UTC)
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // Build hierarchical rows FIRST - needed to know which projects have rows
    // Cache hierarchy to avoid rebuilding on collapse/expand
    if (!this._cachedHierarchy) {
      this._cachedHierarchy = buildProjectHierarchy(this._issues, this._flexibilityCache, this._projects);
    }
    // Get ALL nodes with visibility flags for client-side collapse management
    const flatNodes = flattenHierarchyAll(this._cachedHierarchy, collapseState.getExpandedKeys());
    const allRows = flatNodes.map((node) => nodeToGanttRow(node, this._flexibilityCache, this._closedStatusIds));

    // Extract project IDs that have rows (only these should affect date range)
    const projectIdsWithRows = new Set<number>();
    for (const row of allRows) {
      if (row.type === "project") {
        projectIdsWithRows.add(row.id);
      }
    }

    // Build effective hidden projects set (includes children of hidden projects)
    const effectiveHiddenProjects = new Set(this._hiddenProjects);
    if (this._projects.length > 0) {
      // Build parent→children map
      const childrenMap = new Map<number, number[]>();
      for (const p of this._projects) {
        if (p.parent?.id) {
          const siblings = childrenMap.get(p.parent.id) ?? [];
          siblings.push(p.id);
          childrenMap.set(p.parent.id, siblings);
        }
      }
      // Recursively add children of hidden projects
      const addChildren = (projectId: number) => {
        for (const childId of childrenMap.get(projectId) ?? []) {
          if (!effectiveHiddenProjects.has(childId)) {
            effectiveHiddenProjects.add(childId);
            addChildren(childId);
          }
        }
      };
      for (const hiddenId of this._hiddenProjects) {
        addChildren(hiddenId);
      }
    }

    // Filter issues: must have a row AND not be hidden
    // This fixes the bug where issues from projects without rows affected date range
    const visibleIssues = this._issues.filter(
      (i) => projectIdsWithRows.has(i.project.id) && !effectiveHiddenProjects.has(i.project.id)
    );

    // Focus on active work: exclude completed issues with past dates
    const activeIssues = visibleIssues.filter((i) =>
      i.done_ratio !== 100 ||
      (i.due_date && new Date(i.due_date) >= today)
    );

    // Use active issues for range, fall back to all visible if none active
    const rangeIssues = activeIssues.length > 0 ? activeIssues : visibleIssues;

    // Prioritize issues with BOTH dates for range calculation (avoid point-bar issues extending timeline)
    const issuesWithBothDates = rangeIssues.filter((i) => i.start_date && i.due_date);
    const rangeBasis = issuesWithBothDates.length > 0 ? issuesWithBothDates : rangeIssues;
    const dates = rangeBasis.flatMap((i) =>
      [i.start_date, i.due_date].filter(Boolean)
    ) as string[];

    // If no issues at all (not just hidden), show empty state
    if (this._issues.length === 0) {
      return this._getEmptyHtml(false);
    }

    // When no visible dates (all hidden), use today +/- 30 days as default range
    // This keeps checkboxes visible so user can re-enable projects
    let minDate: Date;
    let maxDate: Date;

    if (dates.length === 0) {
      // No visible issues - use default range centered on today
      minDate = new Date(today);
      minDate.setDate(minDate.getDate() - 7);
      maxDate = new Date(today);
      maxDate.setDate(maxDate.getDate() + 30);
    } else {
      minDate = new Date(Math.min(...dates.map((d) => new Date(d).getTime())));
      maxDate = new Date(Math.max(...dates.map((d) => new Date(d).getTime())));
    }

    // String format for open-ended bars (issues with start but no due date)
    const maxDateStr = maxDate.toISOString().slice(0, 10);

    const totalDays = Math.max(1, Math.ceil(
      (maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24)
    ));

    const pixelsPerDay = ZOOM_PIXELS_PER_DAY[this._zoomLevel];
    const timelineWidth = Math.max(600, totalDays * pixelsPerDay);
    const labelWidth = 250;
    const barHeight = 30;
    const barGap = 10;
    const headerHeight = 40;
    const indentSize = 16;

    // Hidden projects: use effectiveHiddenProjects (consistent with date range calculation)
    // Build lookup for faster ancestor checks
    const rowByCollapseKey = new Map(allRows.map(r => [r.collapseKey, r]));
    const hiddenTreeCache = new Map<string, boolean>();

    const isInHiddenTreeCached = (row: GanttRow): boolean => {
      const cached = hiddenTreeCache.get(row.collapseKey);
      if (cached !== undefined) return cached;

      let result = false;
      if (row.type === "project" && effectiveHiddenProjects.has(row.id)) {
        result = true;
      } else if (row.issue?.projectId && effectiveHiddenProjects.has(row.issue.projectId)) {
        result = true;
      } else if (row.parentKey) {
        const parentRow = rowByCollapseKey.get(row.parentKey);
        if (parentRow) {
          result = isInHiddenTreeCached(parentRow);
        }
      }
      hiddenTreeCache.set(row.collapseKey, result);
      return result;
    };

    // Keep original hierarchy order (no sorting for hidden projects)
    // Visibility is handled via CSS classes for client-side toggling
    const rows = allRows;

    // Filter visible rows ONCE upfront (avoid multiple .filter() calls)
    const visibleRows = rows.filter(r => r.isVisible);
    const visibleRowCount = visibleRows.length;
    const contentHeight = visibleRowCount * (barHeight + barGap);

    // Pre-calculate visible indices for each row
    const rowVisibleIndices = new Map<string, number>();
    visibleRows.forEach((row, idx) => rowVisibleIndices.set(row.collapseKey, idx));
    const chevronWidth = 14;

    // Generate zebra stripe backgrounds for visible rows only
    const zebraStripes = visibleRows
      .map((row, idx) => {
        if (idx % 2 === 0) return ""; // Only odd rows get background
        const y = idx * (barHeight + barGap);
        return `<rect class="zebra-stripe" data-stripe-for="${row.collapseKey}" x="0" y="${y}" width="100%" height="${barHeight + barGap}" />`;
      })
      .join("");

    // Checkbox column - shows checkboxes for ALL visible projects
    // Checked = bars visible, Unchecked = project moved to bottom, bars hidden
    // Checkboxes align 1:1 with project rows in the labels column
    const checkboxColumnWidth = 32;
    const checkboxSize = 14;

    // Only visible projects get checkboxes (aligned with their label row)
    const projectRows = visibleRows.filter(r => r.type === "project");

    // Calculate "select all" state: all checked, none checked, or indeterminate
    const checkedCount = projectRows.filter(r => !effectiveHiddenProjects.has(r.id)).length;
    const allChecked = projectRows.length > 0 && checkedCount === projectRows.length;
    const noneChecked = checkedCount === 0;
    const selectAllState = allChecked ? "checked" : noneChecked ? "unchecked" : "indeterminate";

    // Zebra stripes for checkbox column - use same pattern as labels/timeline for alignment
    const checkboxZebraStripes = zebraStripes;
    const checkboxes = projectRows
      .map((row) => {
        // Get Y from visible row index - guaranteed to exist since we filtered visibleRows
        const visibleIdx = rowVisibleIndices.get(row.collapseKey)!;
        const y = visibleIdx * (barHeight + barGap);
        const checkboxX = (checkboxColumnWidth - checkboxSize) / 2;
        const checkboxY = y + (barHeight - checkboxSize) / 2;
        // Use effective visibility (includes parent hidden state) for checkbox visual
        const isEffectivelyVisible = !effectiveHiddenProjects.has(row.id);
        // Check if hidden because parent is hidden (for dimmed styling)
        const isInheritedHidden = !this._hiddenProjects.has(row.id) && effectiveHiddenProjects.has(row.id);
        return `
          <g class="project-checkbox cursor-pointer${isInheritedHidden ? " inherited-hidden" : ""}" data-project-id="${row.id}" role="checkbox" aria-checked="${isEffectivelyVisible}" aria-label="Show/hide ${escapeHtml(row.label)}">
            <rect x="${checkboxX}" y="${checkboxY}" width="${checkboxSize}" height="${checkboxSize}"
                  fill="${isEffectivelyVisible ? "var(--vscode-checkbox-background)" : "transparent"}"
                  stroke="var(--vscode-checkbox-border)" stroke-width="1" rx="2"/>
            ${isEffectivelyVisible ? `<text x="${checkboxX + checkboxSize / 2}" y="${checkboxY + checkboxSize - 3}" text-anchor="middle" fill="var(--vscode-checkbox-foreground)" font-size="11" font-weight="bold">✓</text>` : ""}
            <title>${escapeHtml(row.label)}</title>
          </g>
        `;
      })
      .join("");

    // Left labels (fixed column) - visible rows only for performance

    const labels = visibleRows
      .map((row, idx) => {
        const y = idx * (barHeight + barGap);
        const indent = row.depth * indentSize;
        const chevron = row.hasChildren
          ? `<text class="collapse-toggle user-select-none" x="${3 + indent}" y="${barHeight / 2 + 4}" fill="var(--vscode-foreground)" font-size="10">${row.isExpanded ? "▼" : "▶"}</text>`
          : "";
        const textOffset = row.hasChildren ? chevronWidth : 0;

        if (row.type === "project") {
          // Project header row (checkbox is in separate column)
          return `
            <g class="project-label gantt-row" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-project-id="${row.id}" data-expanded="${row.isExpanded}" data-has-children="${row.hasChildren}" transform="translate(0, ${y})" tabindex="0" role="button" aria-label="Toggle project ${escapeHtml(row.label)}">
              ${chevron}
              <text x="${5 + indent + textOffset}" y="${barHeight / 2 + 5}" fill="var(--vscode-foreground)" font-size="12" font-weight="bold">
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
          <g class="issue-label gantt-row cursor-pointer" data-issue-id="${issue.id}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-expanded="${row.isExpanded}" data-has-children="${row.hasChildren}" transform="translate(0, ${y})" tabindex="0" role="button" aria-label="Open issue #${issue.id}">
            ${chevron}
            <text x="${5 + indent + textOffset}" y="${barHeight / 2 + 5}" fill="var(--vscode-foreground)" font-size="12">
              #${issue.id} ${escapedSubject}
            </text>
            <title>${tooltip}</title>
          </g>
        `;
      })
      .join("");

    // Right bars (scrollable timeline) - only visible rows for performance
    // Hidden project bars get CSS class for client-side visibility toggling
    const bars = visibleRows
      .map((row, idx) => {
        const y = idx * (barHeight + barGap);
        const isHidden = isInHiddenTreeCached(row);
        const hiddenClass = isHidden ? " bar-hidden" : "";

        // Project headers: always render aggregate bars (with visibility class)
        if (row.type === "project") {
          if (!row.childDateRanges || row.childDateRanges.length === 0) {
            return "";
          }

          // Render aggregate bars for each child issue date range
          const aggregateBars = row.childDateRanges
            .filter(range => range.startDate || range.dueDate)
            .map(range => {
              const startDate = range.startDate ?? range.dueDate!;
              const dueDate = range.dueDate ?? range.startDate!;
              const start = new Date(startDate);
              const end = new Date(dueDate);
              const endPlusOne = new Date(end);
              endPlusOne.setUTCDate(endPlusOne.getUTCDate() + 1);

              const startX = ((start.getTime() - minDate.getTime()) / (maxDate.getTime() - minDate.getTime())) * timelineWidth;
              const endX = ((endPlusOne.getTime() - minDate.getTime()) / (maxDate.getTime() - minDate.getTime())) * timelineWidth;
              const width = Math.max(4, endX - startX);

              return `<rect class="aggregate-bar" x="${startX}" y="4" width="${width}" height="${barHeight - 8}"
                            fill="var(--vscode-descriptionForeground)" opacity="0.5" rx="2" ry="2"/>`;
            })
            .join("");

          return `<g class="aggregate-bars gantt-row${hiddenClass}" data-project-id="${row.id}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" transform="translate(0, ${y})">${aggregateBars}</g>`;
        }

        const issue = row.issue!;
        // Guard: skip if neither date exists (shouldn't happen due to filter)
        if (!issue.start_date && !issue.due_date) {
          return "";
        }
        const isParent = row.isParent ?? false;
        // Open-ended bars: start_date but no due_date stretches to window end
        const hasOnlyStart = issue.start_date && !issue.due_date;
        const startDate = issue.start_date ?? issue.due_date!;
        // For open-ended bars (no due_date), use maxDate - 1 day as end
        const dueDate = issue.due_date ?? (hasOnlyStart ? maxDateStr : issue.start_date!);
        const start = new Date(startDate);
        const end = new Date(dueDate);

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
        // Note: y is now used for transform, internal positions are 0-based
        const color = isParent ? "var(--vscode-descriptionForeground)" : this._getStatusColor(issue.status);
        const isPast = end < today;
        const isOverdue = !isParent && !issue.isClosed && issue.done_ratio < 100 && end < today;

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
        // Visual progress: fallback to spent/estimated when done_ratio is 0
        let visualDoneRatio = doneRatio;
        let isFallbackProgress = false;
        if (doneRatio === 0 && issue.spent_hours && issue.spent_hours > 0 && issue.estimated_hours && issue.estimated_hours > 0) {
          visualDoneRatio = Math.min(100, Math.round((issue.spent_hours / issue.estimated_hours) * 100));
          isFallbackProgress = true;
        }
        const tooltip = [
          `#${issue.id} ${escapedSubject}`,
          `Project: ${escapedProject}`,
          `Start: ${formatDateWithWeekday(issue.start_date)}`,
          `Due: ${hasOnlyStart ? "(no due date)" : formatDateWithWeekday(issue.due_date)}`,
          `Progress: ${doneRatio}%${isFallbackProgress ? ` (showing ${visualDoneRatio}% from time)` : ""}`,
          `Estimated: ${formatHoursAsTime(issue.estimated_hours)}`,
          `Spent: ${formatHoursAsTime(issue.spent_hours)}`,
        ].join("\n");

        // Calculate done portion width for progress visualization
        const doneWidth = (visualDoneRatio / 100) * width;

        const handleWidth = 8;

        // Calculate daily intensity for this issue (skip for parent issues - work is in subtasks)
        // Only compute if intensity display is enabled globally
        const intensities = this._showIntensity && !isParent ? calculateDailyIntensity(issue, this._schedule) : [];
        const hasIntensity = this._showIntensity && !isParent && intensities.length > 0 && issue.estimated_hours !== null;

        // Generate intensity segments and line chart
        let intensitySegments = "";
        let intensityLine = "";

        if (hasIntensity && intensities.length > 0) {
          const dayCount = intensities.length;
          const segmentWidth = width / dayCount;

          // Generate day segments with varying opacity (0-based Y, transform handles positioning)
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
              return `<rect x="${segX}" y="0" width="${segmentWidth + 0.5}" height="${barHeight}"
                            fill="${color}" opacity="${opacity.toFixed(2)}"
                            ${isFirst ? 'rx="8" ry="8"' : isLast ? 'rx="8" ry="8"' : ""}/>`;
            })
            .join("");

          // Generate step function path (horizontal line per day, step at boundaries)
          // Scale intensity to 0-1 range where 1.5 (max stored) = full height
          const maxIntensity = 1.5;
          const stepPoints: string[] = [];
          intensities.forEach((d, i) => {
            const dayStartX = startX + i * segmentWidth;
            const dayEndX = startX + (i + 1) * segmentWidth;
            // Line Y: bottom of bar minus normalized intensity * bar height (0-based)
            const normalizedIntensity = Math.min(d.intensity, maxIntensity) / maxIntensity;
            const py = barHeight - normalizedIntensity * (barHeight - 4);
            if (i === 0) {
              // Move to start of first day
              stepPoints.push(`M ${dayStartX.toFixed(1)},${py.toFixed(1)}`);
            }
            // Horizontal line across the day
            stepPoints.push(`H ${dayEndX.toFixed(1)}`);
            // Step to next day's height (if not last day)
            if (i < intensities.length - 1) {
              const nextNormalized = Math.min(intensities[i + 1].intensity, maxIntensity) / maxIntensity;
              const nextPy = barHeight - nextNormalized * (barHeight - 4);
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
            <g class="issue-bar parent-bar gantt-row${hiddenClass}" data-issue-id="${issue.id}"
               data-project-id="${issue.projectId}"
               data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}"
               data-start-date="${issue.start_date || ""}"
               data-due-date="${issue.due_date || ""}"
               data-start-x="${startX}" data-end-x="${endX}"
               transform="translate(0, ${y})"
               tabindex="0" role="button" aria-label="#${issue.id} ${escapedSubject} (parent, ${doneRatio}% done)">
              <!-- Summary bar: bracket-style with downward arrows at ends (0-based Y) -->
              <path class="bar-outline" d="M ${startX + 4} ${barHeight * 0.3}
                    L ${startX + 4} ${barHeight * 0.7}
                    L ${startX} ${barHeight}
                    M ${startX + 4} ${barHeight * 0.5}
                    H ${endX - 4}
                    M ${endX - 4} ${barHeight * 0.3}
                    L ${endX - 4} ${barHeight * 0.7}
                    L ${endX} ${barHeight}"
                    fill="none" stroke="${color}" stroke-width="2" opacity="0.8" class="cursor-pointer"/>
              ${doneRatio > 0 ? `
                <!-- Progress line showing done_ratio on parent -->
                <line class="parent-progress" x1="${startX + 4}" y1="${barHeight * 0.5}"
                      x2="${startX + 4 + parentDoneWidth}" y2="${barHeight * 0.5}"
                      stroke="var(--vscode-charts-green)" stroke-width="3" opacity="0.8"/>
              ` : ""}
              <title>${tooltip} (parent - ${doneRatio}% done)</title>
            </g>
          `;
        }

        return `
          <g class="issue-bar gantt-row${hiddenClass}${isPast ? " bar-past" : ""}${isOverdue ? " bar-overdue" : ""}${hasOnlyStart ? " bar-open-ended" : ""}" data-issue-id="${issue.id}"
             data-project-id="${issue.projectId}"
             data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}"
             data-start-date="${issue.start_date || ""}"
             data-due-date="${issue.due_date || ""}"
             data-start-x="${startX}" data-end-x="${endX}"
             transform="translate(0, ${y})"
             tabindex="0" role="button" aria-label="#${issue.id} ${escapedSubject}${isOverdue ? " (overdue)" : ""}">
            ${hasIntensity ? `
              <!-- Intensity segments -->
              <g class="bar-intensity">${intensitySegments}</g>
              <!-- Intensity line chart -->
              ${intensityLine}
            ` : `
              <!-- Fallback: solid bar when no intensity data (0-based Y) -->
              <rect class="bar-main" x="${startX}" y="0" width="${width}" height="${barHeight}"
                    fill="${color}" rx="8" ry="8" opacity="0.85" filter="url(#barShadow)"/>
            `}
            ${hasPastPortion ? `
              <!-- Past portion overlay with diagonal stripes -->
              <rect class="past-overlay" x="${startX}" y="0" width="${pastWidth}" height="${barHeight}"
                    fill="url(#past-stripes)" rx="8" ry="8"/>
            ` : ""}
            ${visualDoneRatio > 0 && visualDoneRatio < 100 ? `
              <!-- Progress fill showing done_ratio -->
              <rect class="progress-fill" x="${startX}" y="0" width="${doneWidth}" height="${barHeight}"
                    fill="${color}" rx="8" ry="8" opacity="0.95" filter="url(#barShadow)"/>
            ` : ""}
            <!-- Border/outline -->
            <rect class="bar-outline cursor-move" x="${startX}" y="0" width="${width}" height="${barHeight}"
                  fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="1" rx="8" ry="8"/>
            ${issue.isClosed ? `
              <!-- Closed checkmark -->
              <text class="completed-check" x="${endX - 10}" y="${barHeight / 2 + 5}"
                    text-anchor="end" fill="var(--vscode-charts-green)" font-size="14" font-weight="bold">✓</text>
            ` : `
              <!-- Done ratio (~ prefix indicates fallback from spent/estimated hours) -->
              <text class="done-ratio" x="${endX - 10}" y="${barHeight / 2 + 4}"
                    text-anchor="end" fill="var(--vscode-foreground)" font-size="11" opacity="0.8">${isFallbackProgress ? "~" : ""}${visualDoneRatio}%</text>
            `}
            <rect class="drag-handle drag-left cursor-ew-resize" x="${startX}" y="0" width="${handleWidth}" height="${barHeight}"
                  fill="transparent"/>
            <rect class="drag-handle drag-right cursor-ew-resize" x="${startX + width - handleWidth}" y="0" width="${handleWidth}" height="${barHeight}"
                  fill="transparent"/>
            <!-- Link handle for creating relations -->
            <circle class="link-handle cursor-crosshair" cx="${endX + 8}" cy="${barHeight / 2}" r="5"
                    fill="var(--vscode-button-background)" stroke="var(--vscode-button-foreground)"
                    stroke-width="1" opacity="0"/>
            ${issue.assignee ? `
              <!-- Assignee -->
              <text class="bar-assignee" x="${endX + 20}" y="${barHeight / 2 + 4}"
                    fill="var(--vscode-descriptionForeground)" font-size="11">${escapeHtml(issue.assignee)}</text>
            ` : ""}
            <title>${tooltip}</title>
          </g>
        `;
      })
      .join("");

    // Dependency arrows - draw from end of source to start of target
    const issuePositions = new Map<number, { startX: number; endX: number; y: number }>();
    visibleRows.forEach((row, idx) => {
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
        const y = idx * (barHeight + barGap) + barHeight / 2;
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
      // Extended scheduling types (requires Gantt plugin)
      finish_to_start: { color: "#3498db", dash: "", label: "FS",
        tip: "Finish-to-Start: Target starts after source finishes" },
      start_to_start: { color: "#2ecc71", dash: "4,2", label: "SS",
        tip: "Start-to-Start: Target starts when source starts" },
      finish_to_finish: { color: "#f39c12", dash: "4,2", label: "FF",
        tip: "Finish-to-Finish: Target finishes when source finishes" },
      start_to_finish: { color: "#9b59b6", dash: "2,4", label: "SF",
        tip: "Start-to-Finish: Target finishes when source starts" },
    };

    // Use rows (which have GanttIssue) for dependency arrows - only for visible projects
    const dependencyArrows = rows
      .filter((row): row is GanttRow & { issue: GanttIssue } => row.type === "issue" && !!row.issue && !isInHiddenTreeCached(row))
      .flatMap((row) =>
        row.issue.relations.map((rel) => {
          const issue = row.issue;
          const source = issuePositions.get(issue.id);
          const target = issuePositions.get(rel.targetId);
          // Skip if source/target missing OR target is in hidden project
          const targetRow = rowByCollapseKey.get(`issue-${rel.targetId}`);
          if (!source || !target || (targetRow && isInHiddenTreeCached(targetRow))) return "";

          const style = relationStyles[rel.type] || relationStyles.relates;
          const arrowSize = 6;
          const sameRow = Math.abs(source.y - target.y) < 5;

          // Temporal relations: end → start (or based on type for extended)
          // Non-temporal relations (relates, duplicates, copied_to): center → center
          const isScheduling = ["blocks", "precedes", "finish_to_start", "start_to_start", "finish_to_finish", "start_to_finish"].includes(rel.type);

          let x1: number, y1: number, x2: number, y2: number;

          if (isScheduling) {
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
            <g class="dependency-arrow rel-${rel.type} cursor-pointer" data-relation-id="${rel.id}" data-from="${issue.id}" data-to="${rel.targetId}">
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

    // Generate minimap bars (simplified representation) - only for visible projects
    const minimapBarHeight = 3;
    const minimapHeight = 50;
    const minimapBars = rows
      .filter(r => r.type === "issue" && r.issue && (r.issue.start_date || r.issue.due_date) && !isInHiddenTreeCached(r))
      .map((row) => {
        const issue = row.issue!;
        // Open-ended bars: start_date but no due_date stretches to window end
        const hasOnlyStart = issue.start_date && !issue.due_date;
        const startDate = issue.start_date ?? issue.due_date!;
        const dueDate = issue.due_date ?? (hasOnlyStart ? maxDateStr : issue.start_date!);
        const start = new Date(startDate);
        const end = new Date(dueDate);
        const endPlusOne = new Date(end);
        endPlusOne.setUTCDate(endPlusOne.getUTCDate() + 1);
        const startPct = (start.getTime() - minDate.getTime()) / (maxDate.getTime() - minDate.getTime());
        const endPct = (endPlusOne.getTime() - minDate.getTime()) / (maxDate.getTime() - minDate.getTime());
        const isPast = !hasOnlyStart && end < today;
        const isOverdue = !hasOnlyStart && !issue.isClosed && issue.done_ratio < 100 && end < today;
        const classes = ["minimap-bar", isPast ? "bar-past" : "", isOverdue ? "bar-overdue" : ""].filter(Boolean).join(" ");
        // Use same status color as main view
        const color = this._getStatusColor(issue.status);
        return { startPct, endPct, classes, color };
      });
    const minimapBarsJson = JSON.stringify(minimapBars);

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

    // Body height matches visible content (no hidden project checkboxes at bottom)
    const bodyHeight = contentHeight;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Redmine Gantt</title>
  <style>
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    body {
      margin: 0;
      padding: 16px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      overflow: hidden;
      height: 100vh;
      box-sizing: border-box;
      animation: fadeIn 0.15s ease-out;
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
    .filter-toggle {
      display: flex;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      overflow: hidden;
      margin-left: 4px;
    }
    .filter-toggle select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: none;
      border-right: 1px solid var(--vscode-panel-border);
      padding: 4px 8px;
      cursor: pointer;
      font-size: 12px;
      outline: none;
    }
    .filter-toggle select:last-child {
      border-right: none;
    }
    .filter-toggle select:hover {
      background: var(--vscode-dropdown-listBackground);
    }
    .filter-toggle select:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .filter-toggle label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      padding: 2px 6px;
      display: flex;
      align-items: center;
      background: var(--vscode-input-background);
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
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      height: calc(100vh - 100px);
    }
    .gantt-header-row {
      display: flex;
      flex-shrink: 0;
      height: ${headerHeight}px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .gantt-checkbox-header {
      flex-shrink: 0;
      width: ${checkboxColumnWidth}px;
      border-right: 1px solid var(--vscode-panel-border);
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .select-all-checkbox {
      cursor: pointer;
    }
    .select-all-checkbox:hover rect {
      stroke: var(--vscode-focusBorder);
    }
    .gantt-left-header {
      flex-shrink: 0;
      width: ${labelWidth}px;
      min-width: 150px;
      max-width: 500px;
      display: flex;
      gap: 4px;
      padding: 4px 8px;
      box-sizing: border-box;
      align-items: center;
    }
    .gantt-left-header button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 10px; }
    .gantt-left-header button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .gantt-resize-handle-header {
      width: 6px;
      background: var(--vscode-panel-border);
      cursor: col-resize;
      flex-shrink: 0;
    }
    .gantt-timeline-header {
      flex-grow: 1;
      overflow: hidden;
    }
    .gantt-timeline-header::-webkit-scrollbar { display: none; }
    .gantt-body-wrapper {
      display: flex;
      flex-direction: column;
      flex-grow: 1;
      overflow: hidden;
    }
    .gantt-body-scroll {
      display: flex;
      flex-grow: 1;
      overflow-y: auto;
      overflow-x: hidden;
    }
    .gantt-body-scroll::-webkit-scrollbar {
      width: 8px;
    }
    .gantt-body-scroll::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 4px;
    }
    .gantt-checkboxes {
      flex-shrink: 0;
      width: ${checkboxColumnWidth}px;
      height: ${bodyHeight}px;
      background: var(--vscode-editor-background);
      border-right: 1px solid var(--vscode-panel-border);
    }
    .gantt-checkboxes svg { display: block; height: 100%; }
    .project-checkbox:hover rect {
      stroke: var(--vscode-focusBorder);
    }
    .gantt-labels {
      flex-shrink: 0;
      width: ${labelWidth}px;
      height: ${bodyHeight}px;
      min-width: 150px;
      max-width: 500px;
      background: var(--vscode-editor-background);
      overflow-x: auto;
      overflow-y: hidden;
    }
    .gantt-labels svg { min-width: 100%; height: 100%; }
    .gantt-resize-handle {
      width: 6px;
      height: ${bodyHeight}px;
      background: var(--vscode-panel-border);
      cursor: col-resize;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    .gantt-resize-handle:hover, .gantt-resize-handle.dragging {
      background: var(--vscode-focusBorder);
    }
    .gantt-timeline-wrapper {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .gantt-timeline {
      flex-grow: 1;
      height: ${bodyHeight}px;
      overflow-y: hidden;
      overflow-x: auto;
    }
    .gantt-timeline::-webkit-scrollbar {
      height: 0; /* Hidden - minimap provides horizontal nav */
    }
    .gantt-hscroll {
      display: none; /* Hidden - minimap provides navigation */
    }
    svg { display: block; }
    .issue-bar:hover .bar-main, .issue-bar:hover .bar-outline, .issue-label:hover { opacity: 1; }
    .issue-bar:hover .bar-intensity rect { filter: brightness(1.1); }
    .issue-bar.bar-past { filter: saturate(0.4) opacity(0.7); }
    .issue-bar.bar-past:hover { filter: saturate(0.6) opacity(0.85); }
    .issue-bar.bar-open-ended .bar-outline { stroke-dasharray: 6, 3; stroke-dashoffset: -6; }
    .issue-bar.bar-open-ended .bar-main { mask-image: linear-gradient(90deg, black 80%, transparent 100%); -webkit-mask-image: linear-gradient(90deg, black 80%, transparent 100%); }
    .issue-bar.bar-overdue .bar-outline { stroke: var(--vscode-charts-red) !important; stroke-width: 2; filter: drop-shadow(0 0 4px var(--vscode-charts-red)); }
    .issue-bar.bar-overdue:hover .bar-outline { stroke-width: 3; filter: drop-shadow(0 0 6px var(--vscode-charts-red)); }
    /* Hidden project bars (toggled via checkbox) */
    .bar-hidden { display: none; }
    .critical-path-mode .issue-bar { opacity: 0.3; }
    .critical-path-mode .issue-bar.critical-path { opacity: 1; }
    .critical-path-mode .issue-bar.critical-path .bar-outline { stroke: var(--vscode-charts-orange) !important; stroke-width: 3; filter: drop-shadow(0 0 6px var(--vscode-charts-orange)); }
    .critical-path-mode .dependency-arrow { opacity: 0.15; }
    .critical-path-mode .dependency-arrow.critical-path { opacity: 1; }
    .critical-path-mode .dependency-arrow.critical-path .arrow-line { stroke: var(--vscode-charts-orange) !important; stroke-width: 3; }
    .issue-bar.selected .bar-outline { stroke: var(--vscode-focusBorder) !important; stroke-width: 2; }
    .issue-bar.selected .bar-main { filter: brightness(1.1); }
    .multi-select-mode .issue-bar { cursor: pointer; }
    .selection-count { margin-left: 8px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .issue-bar.parent-bar { opacity: 0.7; }
    .issue-bar.parent-bar:hover { opacity: 1; }
    .past-overlay { pointer-events: none; }
    .progress-fill { pointer-events: none; }
    .completed-check { pointer-events: none; text-shadow: 0 1px 2px rgba(0,0,0,0.5); }
    .done-ratio { pointer-events: none; text-shadow: 0 1px 2px rgba(0,0,0,0.3); }
    .bar-assignee { pointer-events: none; opacity: 0.8; }
    .issue-bar .drag-handle:hover { fill: var(--vscode-list-hoverBackground); }
    .issue-bar:hover .link-handle { opacity: 0.7; }
    .issue-bar .link-handle:hover { opacity: 1; transform-origin: center; }
    .issue-bar.dragging .bar-main, .issue-bar.dragging .bar-intensity { opacity: 0.5; }
    .issue-bar.linking-source .bar-outline { stroke-width: 3; stroke: var(--vscode-focusBorder); }
    .issue-bar.linking-source .link-handle { opacity: 1; }
    .issue-bar.link-target .bar-outline { stroke-width: 2; stroke: var(--vscode-charts-green); }
    @keyframes highlight-pulse { 0%, 100% { filter: drop-shadow(0 0 6px var(--vscode-focusBorder)); } 50% { filter: drop-shadow(0 0 12px var(--vscode-focusBorder)); } }
    .issue-bar.highlighted .bar-outline { stroke: var(--vscode-focusBorder); stroke-width: 3; }
    .issue-label.highlighted { animation: highlight-pulse 0.5s ease-in-out 4; }
    .issue-bar.highlighted { animation: highlight-pulse 0.5s ease-in-out 4; }
    .temp-link-arrow { pointer-events: none; }
    .dependency-arrow .arrow-line { transition: stroke-width 0.15s, filter 0.15s; }
    .dependency-arrow .arrow-head { transition: filter 0.15s; }
    .dependency-arrow:hover .arrow-line { stroke-width: 3 !important; filter: brightness(1.2); }
    .dependency-arrow:hover .arrow-head { filter: brightness(1.2); }
    /* Hover highlighting - fade labels only for dependency arrow hovers */
    .hover-focus.dependency-hover .issue-label,
    .hover-focus.dependency-hover .project-label { opacity: 0.15; transition: opacity 0.15s ease-out; }
    .hover-focus.dependency-hover .issue-label.hover-highlighted,
    .hover-focus.dependency-hover .project-label.hover-highlighted { opacity: 1 !important; }
    /* Highlight hovered bar */
    .hover-focus .issue-bar.hover-highlighted .bar-outline { stroke: var(--vscode-focusBorder); stroke-width: 2; }
    /* Dependency hover - glow on hovered arrow */
    .hover-focus.dependency-hover .dependency-arrow.hover-source .arrow-line { stroke-width: 3; filter: brightness(1.3) drop-shadow(0 0 4px currentColor); }
    .hover-focus.dependency-hover .dependency-arrow.hover-source .arrow-head { filter: brightness(1.3) drop-shadow(0 0 4px currentColor); }
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
    .issue-label:focus, .project-label:focus {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 1px;
      background: var(--vscode-list-activeSelectionBackground);
      border-radius: 3px;
    }
    .issue-label.active, .project-label.active {
      background: var(--vscode-list-inactiveSelectionBackground);
      border-radius: 3px;
    }
    /* Collapse toggle chevron */
    .collapse-toggle { cursor: pointer; opacity: 0.7; }
    .collapse-toggle:hover { opacity: 1; }
    /* Project visibility checkbox */
    .project-checkbox:hover rect { stroke: var(--vscode-focusBorder); }
    .project-checkbox rect { transition: stroke 0.1s; }
    .project-checkbox.inherited-hidden { opacity: 0.5; }
    .project-checkbox.inherited-hidden rect { stroke-dasharray: 3, 2; }
    /* Screen reader only class */
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }
    .weekend-bg { fill: var(--vscode-editor-inactiveSelectionBackground); opacity: 0.3; }
    .zebra-stripe { fill: var(--vscode-list-hoverBackground); opacity: 0.3; pointer-events: none; }
    .day-grid { stroke: var(--vscode-editorRuler-foreground); stroke-width: 1; opacity: 0.25; }
    .date-marker { stroke: var(--vscode-editorRuler-foreground); stroke-dasharray: 2,2; }
    .today-marker { stroke: var(--vscode-charts-red); stroke-width: 2; }
    /* Base transitions for dependency focus fade-back */
    .issue-bar, .issue-label, .project-label, .aggregate-bars { transition: opacity 0.15s ease-out; }
    /* Respect reduced motion preference */
    @media (prefers-reduced-motion: reduce) {
      body { animation: none; }
      .spinner { animation: none; }
      .skeleton-bar { animation: none; opacity: 0.5; }
      .gantt-resize-handle { transition: none; }
      .dependency-arrow .arrow-line { transition: none; }
      .dependency-arrow .arrow-head { transition: none; }
      .issue-bar, .issue-label, .project-label, .aggregate-bars { transition: none; }
    }
    /* Utility classes for CSP compliance */
    .hidden { display: none; }
    /* Loading overlay */
    .loading-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--vscode-editor-background);
      opacity: 0.8;
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 9999;
    }
    .loading-overlay.visible { display: flex; }
    .loading-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--vscode-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .cursor-pointer { cursor: pointer; }
    .cursor-ew-resize { cursor: ew-resize; }
    .cursor-crosshair { cursor: crosshair; }
    .cursor-col-resize { cursor: col-resize; }
    .cursor-move { cursor: move; }
    .user-select-none { user-select: none; }
    .opacity-02 { opacity: 0.2; }
    .w-45 { width: 45%; }
    .w-60 { width: 60%; }
    .w-70 { width: 70%; }
    .w-80 { width: 80%; }
    .heatmap-color-green { background: var(--vscode-charts-green); }
    .heatmap-color-yellow { background: var(--vscode-charts-yellow); }
    .heatmap-color-orange { background: var(--vscode-charts-orange); }
    .heatmap-color-red { background: var(--vscode-charts-red); }
    .rel-line-blocks { background: #e74c3c; }
    .rel-line-precedes { background: #9b59b6; }
    .rel-line-relates { background: #7f8c8d; border-style: dashed; }
    .rel-line-duplicates { background: #e67e22; border-style: dotted; }
    .rel-line-copied { background: #1abc9c; border-style: dashed; }
    .color-swatch { display: inline-block; width: 12px; height: 3px; margin-right: 8px; vertical-align: middle; }

    /* Minimap */
    .minimap-container {
      position: relative;
      height: 50px;
      background: var(--vscode-sideBar-background);
      border-top: 1px solid var(--vscode-panel-border);
      overflow: hidden;
    }
    .minimap-container svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    .minimap-bar {
      opacity: 0.6;
    }
    .minimap-bar.bar-past {
      opacity: 0.3;
    }
    .minimap-viewport {
      fill: var(--vscode-editor-foreground);
      fill-opacity: 0.08;
      stroke: none;
      cursor: grab;
    }
    .minimap-viewport:active {
      cursor: grabbing;
      fill-opacity: 0.12;
    }
    .minimap-today {
      stroke: var(--vscode-charts-red);
      stroke-width: 1;
    }
  </style>
</head>
<body>
  <div id="loadingOverlay" class="loading-overlay${this._isRefreshing ? " visible" : ""}"><div class="loading-spinner"></div></div>
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
      <div class="filter-toggle" role="group" aria-label="Issue filter">
        <label>Assignee:</label>
        <select id="filterAssignee" title="Filter by assignee">
          <option value="me"${this._currentFilter.assignee === "me" ? " selected" : ""}>Me</option>
          <option value="any"${this._currentFilter.assignee === "any" ? " selected" : ""}>Anyone</option>
        </select>
        <label>Status:</label>
        <select id="filterStatus" title="Filter by status">
          <option value="open"${this._currentFilter.status === "open" ? " selected" : ""}>Open</option>
          <option value="closed"${this._currentFilter.status === "closed" ? " selected" : ""}>Closed</option>
          <option value="any"${this._currentFilter.status === "any" ? " selected" : ""}>Any</option>
        </select>
      </div>
      <button id="heatmapBtn" class="${this._showWorkloadHeatmap ? "active" : ""}" title="Toggle workload heatmap" aria-pressed="${this._showWorkloadHeatmap}">Heatmap</button>
      <button id="depsBtn" class="${this._showDependencies ? "active" : ""}" title="Toggle dependency arrows" aria-pressed="${this._showDependencies}">Deps</button>
      <button id="intensityBtn" class="${this._showIntensity ? "active" : ""}" title="Toggle daily intensity" aria-pressed="${this._showIntensity}">Intensity</button>
      <button id="criticalPathBtn" title="Highlight critical path (longest blocking chain)" aria-pressed="false">Critical</button>
      <div class="heatmap-legend${this._showWorkloadHeatmap ? "" : " hidden"}">
        <span class="heatmap-legend-item"><span class="heatmap-legend-color heatmap-color-green"></span>&lt;80%</span>
        <span class="heatmap-legend-item"><span class="heatmap-legend-color heatmap-color-yellow"></span>80-100%</span>
        <span class="heatmap-legend-item"><span class="heatmap-legend-color heatmap-color-orange"></span>100-120%</span>
        <span class="heatmap-legend-item"><span class="heatmap-legend-color heatmap-color-red"></span>&gt;120%</span>
      </div>
      <div class="relation-legend${this._showDependencies ? "" : " hidden"}" title="Relation types (drag from link handle to create)">
        <span class="relation-legend-item"><span class="relation-legend-line rel-line-blocks"></span>blocks</span>
        <span class="relation-legend-item"><span class="relation-legend-line rel-line-precedes"></span>precedes</span>
        <span class="relation-legend-item"><span class="relation-legend-line rel-line-relates"></span>relates</span>
        <span class="relation-legend-item"><span class="relation-legend-line rel-line-duplicates"></span>duplicates</span>
        <span class="relation-legend-item"><span class="relation-legend-line rel-line-copied"></span>copied</span>
      </div>
      <button id="refreshBtn" title="Refresh issues">↻ Refresh</button>
      <button id="todayBtn" title="Jump to Today">Today</button>
      <button id="undoBtn" disabled title="Undo (Ctrl+Z)">↩ Undo</button>
      <button id="redoBtn" disabled title="Redo (Ctrl+Shift+Z)">↪ Redo</button>
      <span id="selectionCount" class="selection-count hidden"></span>
    </div>
  </div>
  <div class="gantt-container">
    <div class="gantt-header-row">
      <div class="gantt-checkbox-header">
        <svg width="${checkboxColumnWidth}" height="${headerHeight}" class="select-all-checkbox" role="checkbox" aria-checked="${selectAllState === "checked"}" aria-label="Select/deselect all projects" tabindex="0">
          <rect x="${(checkboxColumnWidth - checkboxSize) / 2}" y="${(headerHeight - checkboxSize) / 2}" width="${checkboxSize}" height="${checkboxSize}"
                fill="${selectAllState === "checked" ? "var(--vscode-checkbox-background)" : "transparent"}"
                stroke="var(--vscode-checkbox-border)" stroke-width="1" rx="2"/>
          ${selectAllState === "checked" ? `<text x="${checkboxColumnWidth / 2}" y="${(headerHeight + checkboxSize) / 2 - 3}" text-anchor="middle" fill="var(--vscode-checkbox-foreground)" font-size="11" font-weight="bold">✓</text>` : ""}
          ${selectAllState === "indeterminate" ? `<rect x="${(checkboxColumnWidth - 8) / 2}" y="${(headerHeight - 2) / 2}" width="8" height="2" fill="var(--vscode-checkbox-foreground)"/>` : ""}
        </svg>
      </div>
      <div class="gantt-left-header" id="ganttLeftHeader">
        <button id="expandAllBtn" title="Expand all">▼</button>
        <button id="collapseAllBtn" title="Collapse all">▶</button>
      </div>
      <div class="gantt-resize-handle-header"></div>
      <div class="gantt-timeline-header" id="ganttTimelineHeader">
        <svg width="${timelineWidth}" height="${headerHeight}">
          ${dateMarkers.header}
        </svg>
      </div>
    </div>
    <div class="gantt-body-wrapper" id="ganttBodyWrapper">
      <div class="gantt-body-scroll" id="ganttBodyScroll" data-render-key="${this._renderKey}">
        <div class="gantt-checkboxes" id="ganttCheckboxes">
          <svg width="${checkboxColumnWidth}" height="${bodyHeight}" data-render-key="${this._renderKey}">
            ${checkboxZebraStripes}
            ${checkboxes}
          </svg>
        </div>
        <div class="gantt-labels" id="ganttLabels">
          <svg width="${labelWidth}" height="${bodyHeight}" data-render-key="${this._renderKey}">
            ${zebraStripes}
            ${labels}
          </svg>
        </div>
        <div class="gantt-resize-handle" id="resizeHandle"></div>
        <div class="gantt-timeline" id="ganttTimeline">
        <svg width="${timelineWidth + 50}" height="${bodyHeight}" data-render-key="${this._renderKey}">
          <defs>
            <pattern id="past-stripes" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--vscode-charts-red)" stroke-width="2" stroke-opacity="0.4"/>
            </pattern>
            <filter id="barShadow" x="-10%" y="-10%" width="120%" height="120%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.3"/>
            </filter>
          </defs>
          ${zebraStripes}
          ${dateMarkers.body}
          <!-- Arrows below bars so link-handles remain clickable -->
          <g class="dependency-layer${this._showDependencies ? "" : " hidden"}">${dependencyArrows}</g>
          ${bars}
        </svg>
        </div>
      </div>
      <div class="gantt-hscroll" id="ganttHScroll">
        <div class="gantt-hscroll-content" id="ganttHScrollContent"></div>
      </div>
    </div>
  </div>
  <div class="minimap-container" id="minimapContainer">
    <svg id="minimapSvg" viewBox="0 0 100 ${minimapHeight}" preserveAspectRatio="none">
      <!-- Bars will be rendered by JS -->
      <line class="minimap-today" x1="${(todayX / timelineWidth) * 100}" y1="0" x2="${(todayX / timelineWidth) * 100}" y2="${minimapHeight}"/>
      <rect class="minimap-viewport" id="minimapViewport" x="0" y="0" width="20" height="${minimapHeight}" rx="2"/>
    </svg>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const timelineWidth = ${timelineWidth};
    const minDateMs = ${minDate.getTime()};
    const maxDateMs = ${maxDate.getTime()};
    const totalDays = ${totalDays};
    const dayWidth = timelineWidth / totalDays;
    const extendedRelationTypes = ${this._extendedRelationTypes};

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
    const ganttLeftHeader = document.getElementById('ganttLeftHeader');
    const bodyScroll = document.getElementById('ganttBodyScroll');
    const labelsColumn = document.getElementById('ganttLabels');
    const timelineColumn = document.getElementById('ganttTimeline');
    const timelineHeader = document.getElementById('ganttTimelineHeader');
    const hScroll = document.getElementById('ganttHScroll');
    const hScrollContent = document.getElementById('ganttHScrollContent');
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');
    const minimapSvg = document.getElementById('minimapSvg');
    const minimapViewport = document.getElementById('minimapViewport');

    // Set hScroll content width via JS (CSP compliance - no inline styles)
    if (hScrollContent) {
      hScrollContent.style.width = (timelineWidth + 50) + 'px';
    }

    // Minimap setup
    const minimapBarsData = ${minimapBarsJson};
    const minimapHeight = ${minimapHeight};
    const minimapBarHeight = ${minimapBarHeight};

    // Render minimap bars (deferred to avoid blocking initial paint)
    if (minimapSvg) {
      requestAnimationFrame(() => {
        const barSpacing = minimapHeight / (minimapBarsData.length + 1);
        minimapBarsData.forEach((bar, i) => {
          const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          rect.setAttribute('class', bar.classes);
          rect.setAttribute('x', (bar.startPct * 100).toString());
          rect.setAttribute('y', (barSpacing * (i + 0.5)).toString());
          rect.setAttribute('width', Math.max(0.5, (bar.endPct - bar.startPct) * 100).toString());
          rect.setAttribute('height', minimapBarHeight.toString());
          rect.setAttribute('rx', '1');
          rect.setAttribute('fill', bar.color); // Use status color from main view
          minimapSvg.insertBefore(rect, minimapViewport);
        });
      });
    }

    // Update minimap viewport on scroll
    // Use timelineWidth (content width) not scrollWidth (includes padding)
    function updateMinimapViewport() {
      if (!timelineColumn || !minimapViewport) return;
      const contentWidth = timelineWidth; // Bars span from 0 to timelineWidth
      const scrollableRange = Math.max(1, contentWidth - timelineColumn.clientWidth);
      const scrollRatio = Math.min(1, timelineColumn.scrollLeft / scrollableRange);
      const viewportRatio = Math.min(1, timelineColumn.clientWidth / contentWidth);
      const viewportWidth = Math.max(2, viewportRatio * 100);
      const viewportX = scrollRatio * (100 - viewportWidth);
      minimapViewport.setAttribute('x', viewportX.toString());
      minimapViewport.setAttribute('width', viewportWidth.toString());
    }

    // Handle minimap click/drag to scroll
    let minimapDragging = false;
    let minimapDragOffset = 0; // Offset within viewport where drag started

    function scrollFromMinimap(e, useOffset = false) {
      if (!timelineColumn || !minimapSvg || !minimapViewport) return;
      const rect = minimapSvg.getBoundingClientRect();
      const viewportWidth = parseFloat(minimapViewport.getAttribute('width') || '0');
      const viewportWidthPx = (viewportWidth / 100) * rect.width;

      // Calculate target position, accounting for drag offset if dragging viewport
      let targetX = e.clientX - rect.left;
      if (useOffset) {
        targetX -= minimapDragOffset;
      } else {
        // Center viewport on click position
        targetX -= viewportWidthPx / 2;
      }

      // Use timelineWidth for content-based scroll calculation
      const clickRatio = Math.max(0, Math.min(1, targetX / (rect.width - viewportWidthPx)));
      const scrollableRange = Math.max(0, timelineWidth - timelineColumn.clientWidth);
      timelineColumn.scrollLeft = clickRatio * scrollableRange;
    }

    if (minimapSvg && minimapViewport) {
      // Clicking on viewport - drag from current position
      minimapViewport.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        minimapDragging = true;
        const rect = minimapSvg.getBoundingClientRect();
        const viewportX = parseFloat(minimapViewport.getAttribute('x') || '0');
        const viewportXPx = (viewportX / 100) * rect.width;
        minimapDragOffset = e.clientX - rect.left - viewportXPx;
      });

      // Clicking outside viewport - jump to position (center viewport on click)
      minimapSvg.addEventListener('mousedown', (e) => {
        if (e.target === minimapViewport) return;
        minimapDragging = true;
        // Set offset to viewport center so dragging maintains centering (like VS Code)
        const rect = minimapSvg.getBoundingClientRect();
        const viewportWidth = parseFloat(minimapViewport.getAttribute('width') || '0');
        minimapDragOffset = (viewportWidth / 100) * rect.width / 2;
        scrollFromMinimap(e, true);
      });

      addDocListener('mousemove', (e) => {
        if (minimapDragging) scrollFromMinimap(e, true);
      });
      addDocListener('mouseup', () => {
        minimapDragging = false;
      });
    }

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
      // Always save centerDateMs for date-based scroll restoration
      // This ensures correct position when date range changes (e.g., visibility toggle)
      vscode.setState({
        undoStack,
        redoStack,
        labelWidth: labelsColumn?.offsetWidth || ${labelWidth},
        scrollLeft: null, // Deprecated: use centerDateMs instead
        scrollTop: bodyScroll?.scrollTop ?? null,
        centerDateMs: getCenterDateMs()
      });
    }

    // Alias for backward compatibility (zoom changes now use same logic)
    const saveStateForZoom = saveState;

    function updateUndoRedoButtons() {
      undoBtn.disabled = undoStack.length === 0;
      redoBtn.disabled = redoStack.length === 0;
      saveState();
    }

    // Apply saved label width
    if (previousState.labelWidth && ganttLeftHeader && labelsColumn) {
      ganttLeftHeader.style.width = previousState.labelWidth + 'px';
      labelsColumn.style.width = previousState.labelWidth + 'px';
    }

    // Scrolling: bodyScroll handles vertical, hScroll handles horizontal
    let deferredScrollUpdate = null;
    if (bodyScroll && timelineColumn && timelineHeader && hScroll) {
      // Horizontal scroll from hScroll → sync to timeline and header
      hScroll.addEventListener('scroll', () => {
        timelineColumn.scrollLeft = hScroll.scrollLeft;
        timelineHeader.scrollLeft = hScroll.scrollLeft;
        // Defer non-critical updates
        cancelAnimationFrame(deferredScrollUpdate);
        deferredScrollUpdate = requestAnimationFrame(() => {
          updateMinimapViewport();
          saveState();
        });
      }, { passive: true });
      // Horizontal scroll from timeline (e.g. via keyboard, wheel) → sync to hScroll, header, minimap
      timelineColumn.addEventListener('scroll', () => {
        hScroll.scrollLeft = timelineColumn.scrollLeft;
        timelineHeader.scrollLeft = timelineColumn.scrollLeft;
        cancelAnimationFrame(deferredScrollUpdate);
        deferredScrollUpdate = requestAnimationFrame(() => {
          updateMinimapViewport();
          saveState();
        });
      }, { passive: true });
      // Vertical scroll: just update minimap and save state
      bodyScroll.addEventListener('scroll', () => {
        cancelAnimationFrame(deferredScrollUpdate);
        deferredScrollUpdate = requestAnimationFrame(() => {
          updateMinimapViewport();
          saveState();
        });
      }, { passive: true });
    }

    // Initial button state (defer to avoid forced reflow after style writes)
    requestAnimationFrame(() => updateUndoRedoButtons());

    // Handle messages from extension (for state updates without full re-render)
    addWinListener('message', event => {
      const message = event.data;
      if (message.command === 'setHeatmapState') {
        const heatmapLayer = document.querySelector('.heatmap-layer');
        const weekendLayer = document.querySelector('.weekend-layer');
        const heatmapBtn = document.getElementById('heatmapBtn');
        const heatmapLegend = document.querySelector('.heatmap-legend');

        if (message.enabled) {
          if (heatmapLayer) heatmapLayer.classList.remove('hidden');
          if (weekendLayer) weekendLayer.classList.add('hidden');
          if (heatmapBtn) heatmapBtn.classList.add('active');
          if (heatmapLegend) heatmapLegend.classList.remove('hidden');
        } else {
          if (heatmapLayer) heatmapLayer.classList.add('hidden');
          if (weekendLayer) weekendLayer.classList.remove('hidden');
          if (heatmapBtn) heatmapBtn.classList.remove('active');
          if (heatmapLegend) heatmapLegend.classList.add('hidden');
        }
      } else if (message.command === 'setDependenciesState') {
        const dependencyLayer = document.querySelector('.dependency-layer');
        const depsBtn = document.getElementById('depsBtn');
        const relationLegend = document.querySelector('.relation-legend');

        if (message.enabled) {
          if (dependencyLayer) dependencyLayer.classList.remove('hidden');
          if (depsBtn) depsBtn.classList.add('active');
          if (relationLegend) relationLegend.classList.remove('hidden');
        } else {
          if (dependencyLayer) dependencyLayer.classList.add('hidden');
          if (depsBtn) depsBtn.classList.remove('active');
          if (relationLegend) relationLegend.classList.add('hidden');
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
      } else if (message.command === 'scrollToIssue') {
        // Scroll to, focus, and highlight a specific issue
        const issueId = message.issueId;
        const label = document.querySelector('.issue-label[data-issue-id="' + issueId + '"]');
        const bar = document.querySelector('.issue-bar[data-issue-id="' + issueId + '"]');
        if (label) {
          label.scrollIntoView({ behavior: 'smooth', block: 'center' });
          label.focus();
          label.classList.add('highlighted');
          setTimeout(() => label.classList.remove('highlighted'), 2000);
        }
        if (bar) {
          // Scroll bar into view horizontally (focus on start of bar)
          const timeline = document.querySelector('.gantt-timeline');
          if (timeline) {
            const barRect = bar.getBoundingClientRect();
            const timelineRect = timeline.getBoundingClientRect();
            const scrollLeft = timeline.scrollLeft + barRect.left - timelineRect.left - 100;
            timeline.scrollTo({ left: Math.max(0, scrollLeft), behavior: 'smooth' });
          }
          bar.classList.add('highlighted');
          setTimeout(() => bar.classList.remove('highlighted'), 2000);
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

    // Filter dropdown handlers
    document.getElementById('filterAssignee').addEventListener('change', (e) => {
      const value = e.target.value;
      vscode.postMessage({ command: 'setFilter', filter: { assignee: value } });
    });
    document.getElementById('filterStatus').addEventListener('change', (e) => {
      const value = e.target.value;
      vscode.postMessage({ command: 'setFilter', filter: { status: value } });
    });

    // Heatmap toggle handler
    document.getElementById('heatmapBtn').addEventListener('click', () => {
      saveState();
      vscode.postMessage({ command: 'toggleWorkloadHeatmap' });
    });

    // Dependencies toggle handler
    document.getElementById('depsBtn').addEventListener('click', () => {
      saveState();
      vscode.postMessage({ command: 'toggleDependencies' });
    });

    // Intensity toggle handler
    document.getElementById('intensityBtn').addEventListener('click', () => {
      saveState();
      vscode.postMessage({ command: 'toggleIntensity' });
    });

    // Critical path toggle
    let criticalPathEnabled = false;
    const criticalPathBtn = document.getElementById('criticalPathBtn');
    const ganttContainer = document.querySelector('.gantt-container');

    // Build blocking graph from dependency arrows
    function buildBlockingGraph() {
      const graph = new Map(); // issueId -> [targetIds that this issue blocks/precedes]
      const reverseGraph = new Map(); // issueId -> [sourceIds that block/precede this issue]
      document.querySelectorAll('.dependency-arrow').forEach(arrow => {
        const relType = arrow.classList.contains('rel-blocks') || arrow.classList.contains('rel-precedes');
        if (!relType) return;
        const fromId = arrow.dataset.from;
        const toId = arrow.dataset.to;
        if (!graph.has(fromId)) graph.set(fromId, []);
        graph.get(fromId).push(toId);
        if (!reverseGraph.has(toId)) reverseGraph.set(toId, []);
        reverseGraph.get(toId).push(fromId);
      });
      return { graph, reverseGraph };
    }

    // Find longest path using DFS with memoization
    function findLongestPath(graph, reverseGraph) {
      const allNodes = new Set([...graph.keys(), ...reverseGraph.keys()]);
      const memo = new Map();

      function dfs(node, visited) {
        if (memo.has(node)) return memo.get(node);
        if (visited.has(node)) return { length: 0, path: [] }; // cycle detection

        visited.add(node);
        const neighbors = graph.get(node) || [];
        let longest = { length: 0, path: [] };

        for (const neighbor of neighbors) {
          const result = dfs(neighbor, new Set(visited));
          if (result.length + 1 > longest.length) {
            longest = { length: result.length + 1, path: [neighbor, ...result.path] };
          }
        }

        memo.set(node, longest);
        return longest;
      }

      // Find the longest path starting from any node
      let criticalPath = [];
      let maxLength = 0;
      for (const node of allNodes) {
        const result = dfs(node, new Set());
        if (result.length > maxLength) {
          maxLength = result.length;
          criticalPath = [node, ...result.path];
        }
      }
      return criticalPath;
    }

    function toggleCriticalPath() {
      criticalPathEnabled = !criticalPathEnabled;
      criticalPathBtn.classList.toggle('active', criticalPathEnabled);
      criticalPathBtn.setAttribute('aria-pressed', criticalPathEnabled);

      // Clear previous highlights
      document.querySelectorAll('.critical-path').forEach(el => el.classList.remove('critical-path'));
      ganttContainer.classList.toggle('critical-path-mode', criticalPathEnabled);

      if (criticalPathEnabled) {
        const { graph, reverseGraph } = buildBlockingGraph();
        const criticalPath = findLongestPath(graph, reverseGraph);

        // Highlight issues on critical path
        const criticalSet = new Set(criticalPath);
        document.querySelectorAll('.issue-bar').forEach(bar => {
          if (criticalSet.has(bar.dataset.issueId)) {
            bar.classList.add('critical-path');
          }
        });

        // Highlight arrows on critical path
        for (let i = 0; i < criticalPath.length - 1; i++) {
          const from = criticalPath[i];
          const to = criticalPath[i + 1];
          const arrow = document.querySelector(\`.dependency-arrow[data-from="\${from}"][data-to="\${to}"]\`);
          if (arrow) arrow.classList.add('critical-path');
        }

        announce(\`Critical path: \${criticalPath.length} issues in longest blocking chain\`);
      }
    }

    criticalPathBtn.addEventListener('click', toggleCriticalPath);

    // Multi-select state
    const selectedIssues = new Set();
    let lastClickedIssueId = null;
    const selectionCountEl = document.getElementById('selectionCount');
    const allIssueBars = Array.from(document.querySelectorAll('.issue-bar'));

    function updateSelectionUI() {
      // Update visual selection on bars
      allIssueBars.forEach(bar => {
        bar.classList.toggle('selected', selectedIssues.has(bar.dataset.issueId));
      });
      // Update selection count
      if (selectedIssues.size > 0) {
        selectionCountEl.textContent = \`\${selectedIssues.size} selected\`;
        selectionCountEl.classList.remove('hidden');
        ganttContainer.classList.add('multi-select-mode');
      } else {
        selectionCountEl.classList.add('hidden');
        ganttContainer.classList.remove('multi-select-mode');
      }
    }

    function clearSelection() {
      selectedIssues.clear();
      lastClickedIssueId = null;
      updateSelectionUI();
    }

    function toggleSelection(issueId) {
      if (selectedIssues.has(issueId)) {
        selectedIssues.delete(issueId);
      } else {
        selectedIssues.add(issueId);
      }
      lastClickedIssueId = issueId;
      updateSelectionUI();
    }

    function selectRange(fromId, toId) {
      const fromIndex = allIssueBars.findIndex(b => b.dataset.issueId === fromId);
      const toIndex = allIssueBars.findIndex(b => b.dataset.issueId === toId);
      if (fromIndex === -1 || toIndex === -1) return;
      const start = Math.min(fromIndex, toIndex);
      const end = Math.max(fromIndex, toIndex);
      for (let i = start; i <= end; i++) {
        selectedIssues.add(allIssueBars[i].dataset.issueId);
      }
      updateSelectionUI();
    }

    function selectAll() {
      allIssueBars.forEach(bar => selectedIssues.add(bar.dataset.issueId));
      updateSelectionUI();
      announce(\`Selected all \${selectedIssues.size} issues\`);
    }

    // Handle Ctrl+click and Shift+click on bars for selection
    allIssueBars.forEach(bar => {
      bar.addEventListener('mousedown', (e) => {
        // Only handle Ctrl or Shift clicks for selection
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey) return;

        // Don't interfere with drag handles
        if (e.target.classList.contains('drag-handle') ||
            e.target.classList.contains('link-handle')) return;

        e.preventDefault();
        e.stopPropagation();

        const issueId = bar.dataset.issueId;
        if (e.shiftKey && lastClickedIssueId) {
          // Shift+click: range selection
          selectRange(lastClickedIssueId, issueId);
        } else {
          // Ctrl/Cmd+click: toggle selection
          toggleSelection(issueId);
        }
      });
    });

    // Ctrl+A to select all, Escape to clear
    addDocListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        selectAll();
      }
      if (e.key === 'Escape' && selectedIssues.size > 0) {
        clearSelection();
        announce('Selection cleared');
      }
    });

    // Refresh button handler
    document.getElementById('refreshBtn').addEventListener('click', () => {
      document.getElementById('loadingOverlay').classList.add('visible');
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

    // Build lookup maps for O(1) hover highlight (instead of repeated querySelectorAll)
    // Deferred to avoid blocking initial render
    const issueBarsByIssueId = new Map();
    const issueLabelsByIssueId = new Map();
    const arrowsByIssueId = new Map(); // arrows connected to an issue
    const projectLabelsByKey = new Map();
    const aggregateBarsByKey = new Map();
    let mapsReady = false;

    function buildLookupMaps() {
      document.querySelectorAll('.issue-bar').forEach(bar => {
        const id = bar.dataset.issueId;
        if (id) {
          if (!issueBarsByIssueId.has(id)) issueBarsByIssueId.set(id, []);
          issueBarsByIssueId.get(id).push(bar);
        }
      });
      document.querySelectorAll('.issue-label').forEach(label => {
        const id = label.dataset.issueId;
        if (id) {
          if (!issueLabelsByIssueId.has(id)) issueLabelsByIssueId.set(id, []);
          issueLabelsByIssueId.get(id).push(label);
        }
      });
      document.querySelectorAll('.dependency-arrow').forEach(arrow => {
        const fromId = arrow.dataset.from;
        const toId = arrow.dataset.to;
        if (fromId) {
          if (!arrowsByIssueId.has(fromId)) arrowsByIssueId.set(fromId, []);
          arrowsByIssueId.get(fromId).push(arrow);
        }
        if (toId) {
          if (!arrowsByIssueId.has(toId)) arrowsByIssueId.set(toId, []);
          arrowsByIssueId.get(toId).push(arrow);
        }
      });
      document.querySelectorAll('.project-label').forEach(label => {
        const key = label.dataset.collapseKey;
        if (key) {
          if (!projectLabelsByKey.has(key)) projectLabelsByKey.set(key, []);
          projectLabelsByKey.get(key).push(label);
        }
      });
      document.querySelectorAll('.aggregate-bars').forEach(bars => {
        const key = bars.dataset.collapseKey;
        if (key) {
          if (!aggregateBarsByKey.has(key)) aggregateBarsByKey.set(key, []);
          aggregateBarsByKey.get(key).push(bars);
        }
      });
      mapsReady = true;
    }

    // Defer map building to after initial render
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(() => buildLookupMaps(), { timeout: 100 });
    } else {
      setTimeout(buildLookupMaps, 0);
    }

    // Track currently highlighted elements for fast clear
    let highlightedElements = [];

    function clearHoverHighlight() {
      document.body.classList.remove('hover-focus', 'dependency-hover');
      highlightedElements.forEach(el => el.classList.remove('hover-highlighted', 'hover-source'));
      highlightedElements = [];
    }

    function highlightIssue(issueId) {
      document.body.classList.add('hover-focus');
      // Use cached lookups if ready, otherwise fall back to DOM query
      const bars = mapsReady ? (issueBarsByIssueId.get(issueId) || [])
        : document.querySelectorAll('.issue-bar[data-issue-id="' + issueId + '"]');
      const labels = mapsReady ? (issueLabelsByIssueId.get(issueId) || [])
        : document.querySelectorAll('.issue-label[data-issue-id="' + issueId + '"]');
      const arrows = mapsReady ? (arrowsByIssueId.get(issueId) || [])
        : document.querySelectorAll('.dependency-arrow[data-from="' + issueId + '"], .dependency-arrow[data-to="' + issueId + '"]');
      bars.forEach(el => { el.classList.add('hover-highlighted'); highlightedElements.push(el); });
      labels.forEach(el => { el.classList.add('hover-highlighted'); highlightedElements.push(el); });
      arrows.forEach(el => { el.classList.add('hover-highlighted'); highlightedElements.push(el); });
    }

    function highlightProject(collapseKey) {
      document.body.classList.add('hover-focus');
      const labels = mapsReady ? (projectLabelsByKey.get(collapseKey) || [])
        : document.querySelectorAll('.project-label[data-collapse-key="' + collapseKey + '"]');
      const bars = mapsReady ? (aggregateBarsByKey.get(collapseKey) || [])
        : document.querySelectorAll('.aggregate-bars[data-collapse-key="' + collapseKey + '"]');
      labels.forEach(el => { el.classList.add('hover-highlighted'); highlightedElements.push(el); });
      bars.forEach(el => { el.classList.add('hover-highlighted'); highlightedElements.push(el); });
    }

    // Use event delegation for hover events (single listener instead of N listeners)
    const timelineSvg = document.querySelector('.gantt-timeline svg');
    const labelsSvg = document.querySelector('.gantt-labels svg');

    if (timelineSvg) {
      timelineSvg.addEventListener('mouseenter', (e) => {
        const bar = e.target.closest('.issue-bar');
        const aggBar = e.target.closest('.aggregate-bars');
        const arrow = e.target.closest('.dependency-arrow');
        if (bar) {
          const issueId = bar.dataset.issueId;
          if (issueId) highlightIssue(issueId);
        } else if (aggBar) {
          const key = aggBar.dataset.collapseKey;
          if (key) highlightProject(key);
        } else if (arrow) {
          const fromId = arrow.dataset.from;
          const toId = arrow.dataset.to;
          document.body.classList.add('dependency-hover');
          arrow.classList.add('hover-source');
          highlightedElements.push(arrow);
          if (fromId) highlightIssue(fromId);
          if (toId) highlightIssue(toId);
        }
      }, true); // capture phase for delegation

      timelineSvg.addEventListener('mouseleave', (e) => {
        const bar = e.target.closest('.issue-bar');
        const aggBar = e.target.closest('.aggregate-bars');
        const arrow = e.target.closest('.dependency-arrow');
        if (bar || aggBar || arrow) {
          clearHoverHighlight();
        }
      }, true);
    }

    if (labelsSvg) {
      labelsSvg.addEventListener('mouseenter', (e) => {
        const label = e.target.closest('.issue-label');
        const projectLabel = e.target.closest('.project-label');
        if (label) {
          const issueId = label.dataset.issueId;
          if (issueId) highlightIssue(issueId);
        } else if (projectLabel) {
          const key = projectLabel.dataset.collapseKey;
          if (key) highlightProject(key);
        }
      }, true);

      labelsSvg.addEventListener('mouseleave', (e) => {
        const label = e.target.closest('.issue-label');
        const projectLabel = e.target.closest('.project-label');
        if (label || projectLabel) {
          clearHoverHighlight();
        }
      }, true);
    }

    // Dependency arrow right-click delete (delegated)
    if (timelineSvg) {
      timelineSvg.addEventListener('contextmenu', (e) => {
        const arrow = e.target.closest('.dependency-arrow');
        if (!arrow) return;
        e.preventDefault();
        const relationId = parseInt(arrow.dataset.relationId);
        const fromId = arrow.dataset.from;
        const toId = arrow.dataset.to;
        showDeletePicker(e.clientX, e.clientY, relationId, fromId, toId);
      });
    }

    // Show context menu for issue (similar to Issues pane context menu)
    function showIssueContextMenu(x, y, issueId) {
      document.querySelector('.relation-picker')?.remove();

      // Check if this is a bulk operation (multiple selected and clicked is part of selection)
      const isBulkMode = selectedIssues.size > 1 && selectedIssues.has(issueId);
      const targetIds = isBulkMode ? Array.from(selectedIssues).map(id => parseInt(id)) : [parseInt(issueId)];

      const picker = document.createElement('div');
      picker.className = 'relation-picker';

      const pickerWidth = 160;
      const pickerHeight = 180;
      const clampedX = Math.min(x, window.innerWidth - pickerWidth - 10);
      const clampedY = Math.min(y, window.innerHeight - pickerHeight - 10);
      picker.style.left = Math.max(10, clampedX) + 'px';
      picker.style.top = Math.max(10, clampedY) + 'px';

      const label = document.createElement('div');
      label.style.padding = '6px 12px';
      label.style.fontSize = '11px';
      label.style.opacity = '0.7';
      label.textContent = isBulkMode ? targetIds.length + ' issues selected' : '#' + issueId;
      picker.appendChild(label);

      const options = isBulkMode ? [
        { label: 'Set % Done...', command: 'bulkSetDoneRatio', bulk: true },
        { label: 'Clear Selection', command: 'clearSelection', local: true },
      ] : [
        { label: 'Update Issue...', command: 'openIssue' },
        { label: 'Open in Browser', command: 'openInBrowser' },
        { label: 'Show in Issues', command: 'showInIssues' },
        { label: 'Log Time', command: 'logTime' },
        { label: 'Set % Done', command: 'setDoneRatio' },
        { label: 'Toggle Auto-update %', command: 'toggleAutoUpdate' },
        { label: 'Copy URL', command: 'copyUrl' },
      ];

      options.forEach(opt => {
        const btn = document.createElement('button');
        btn.textContent = opt.label;
        btn.addEventListener('click', () => {
          if (opt.local) {
            clearSelection();
          } else if (opt.bulk) {
            vscode.postMessage({ command: opt.command, issueIds: targetIds });
          } else {
            vscode.postMessage({ command: opt.command, issueId: parseInt(issueId) });
          }
          picker.remove();
        });
        picker.appendChild(btn);
      });

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

    // Issue bar right-click context menu
    document.querySelectorAll('.issue-bar').forEach(bar => {
      bar.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const issueId = bar.dataset.issueId;
        if (issueId) showIssueContextMenu(e.clientX, e.clientY, issueId);
      });
    });

    // Issue label right-click context menu
    document.querySelectorAll('.issue-label').forEach(label => {
      label.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const issueId = label.dataset.issueId;
        if (issueId) showIssueContextMenu(e.clientX, e.clientY, issueId);
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
          isMove: false,
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

    // Handle drag start on bar body (move entire bar or bulk move)
    document.querySelectorAll('.bar-outline').forEach(outline => {
      outline.addEventListener('mousedown', (e) => {
        // Skip if clicking on drag handles (they're on top)
        if (e.target.classList.contains('drag-handle')) return;
        // Skip if Ctrl/Shift held (selection mode)
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.stopPropagation();
        const bar = outline.closest('.issue-bar');
        if (!bar) return;
        const issueId = bar.dataset.issueId;

        // Check if this bar is part of a selection for bulk drag
        const isBulkDrag = selectedIssues.size > 1 && selectedIssues.has(issueId);
        const barsToMove = isBulkDrag
          ? allIssueBars.filter(b => selectedIssues.has(b.dataset.issueId))
          : [bar];

        // Collect data for all bars to move
        const bulkBars = barsToMove.map(b => ({
          issueId: b.dataset.issueId,
          startX: parseFloat(b.dataset.startX),
          endX: parseFloat(b.dataset.endX),
          oldStartDate: b.dataset.startDate || null,
          oldDueDate: b.dataset.dueDate || null,
          barOutline: b.querySelector('.bar-outline'),
          barMain: b.querySelector('.bar-main'),
          leftHandle: b.querySelector('.drag-left'),
          rightHandle: b.querySelector('.drag-right'),
          bar: b
        }));

        bulkBars.forEach(b => b.bar.classList.add('dragging'));

        dragState = {
          issueId: parseInt(issueId),
          isLeft: false,
          isMove: true,
          isBulkDrag,
          bulkBars,
          initialMouseX: e.clientX,
          startX: parseFloat(bar.dataset.startX),
          endX: parseFloat(bar.dataset.endX),
          oldStartDate: bar.dataset.startDate || null,
          oldDueDate: bar.dataset.dueDate || null,
          barOutline: outline,
          barMain: bar.querySelector('.bar-main'),
          leftHandle: bar.querySelector('.drag-left'),
          rightHandle: bar.querySelector('.drag-right'),
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
      document.body.classList.remove('cursor-crosshair');
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

      const baseTypes = [
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
      const extendedTypes = [
        { value: 'finish_to_start', label: '⏩ Finish→Start', color: '#3498db',
          tooltip: 'Target starts after this issue finishes (FS)' },
        { value: 'start_to_start', label: '▶️ Start→Start', color: '#2ecc71',
          tooltip: 'Target starts when this issue starts (SS)' },
        { value: 'finish_to_finish', label: '⏹️ Finish→Finish', color: '#f39c12',
          tooltip: 'Target finishes when this issue finishes (FF)' },
        { value: 'start_to_finish', label: '⏪ Start→Finish', color: '#9b59b6',
          tooltip: 'Target finishes when this issue starts (SF)' }
      ];
      const types = extendedRelationTypes ? [...baseTypes, ...extendedTypes] : baseTypes;

      types.forEach(t => {
        const btn = document.createElement('button');
        const swatch = document.createElement('span');
        swatch.className = 'color-swatch';
        swatch.style.backgroundColor = t.color;
        btn.appendChild(swatch);
        btn.appendChild(document.createTextNode(t.label));
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

    // Handle click on bar - scroll to issue start date and highlight
    document.querySelectorAll('.issue-bar').forEach(bar => {
      bar.addEventListener('click', (e) => {
        // Ignore if clicking on drag handles, link handle, or bar-outline (for move drag)
        const target = e.target;
        if (target.classList.contains('drag-handle') ||
            target.classList.contains('drag-left') ||
            target.classList.contains('drag-right') ||
            target.classList.contains('link-handle') ||
            target.classList.contains('bar-outline')) {
          return;
        }
        if (dragState || linkingState) return;
        scrollToAndHighlight(bar.dataset.issueId);
      });
    });

    // Keyboard navigation for issue bars
    const issueBars = Array.from(document.querySelectorAll('.issue-bar'));
    issueBars.forEach((bar, index) => {
      bar.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          scrollToAndHighlight(bar.dataset.issueId);
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
        document.body.classList.add('cursor-crosshair');

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

    // Collapse toggle click (before issue-label handler to stop propagation)
    document.querySelectorAll('.collapse-toggle').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        // Get collapse key from parent label element
        const label = el.closest('[data-collapse-key]');
        const collapseKey = label?.dataset.collapseKey;
        if (collapseKey) {
          vscode.postMessage({ command: 'toggleCollapse', collapseKey });
        }
      });
    });

    // Expand/collapse all buttons
    document.getElementById('expandAllBtn')?.addEventListener('click', () => {
      const keys = [...document.querySelectorAll('[data-collapse-key]')]
        .map(el => el.dataset.collapseKey)
        .filter((k, i, arr) => k && arr.indexOf(k) === i);
      vscode.postMessage({ command: 'expandAll', keys });
    });
    document.getElementById('collapseAllBtn')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'collapseAll' });
    });

    // Project visibility checkbox click
    document.querySelectorAll('.project-checkbox').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const projectId = parseInt(el.dataset.projectId);
        if (!isNaN(projectId)) {
          vscode.postMessage({ command: 'toggleProjectVisibility', projectId });
        }
      });
    });

    // Select all checkbox click
    const selectAllCheckbox = document.querySelector('.select-all-checkbox');
    if (selectAllCheckbox) {
      selectAllCheckbox.addEventListener('click', () => {
        const allProjectIds = Array.from(document.querySelectorAll('.project-checkbox'))
          .map(el => parseInt(el.dataset.projectId))
          .filter(id => !isNaN(id));
        const isCurrentlyAllChecked = selectAllCheckbox.getAttribute('aria-checked') === 'true';
        // If all checked, uncheck all; otherwise check all
        vscode.postMessage({
          command: 'setAllProjectsVisibility',
          projectIds: allProjectIds,
          visible: !isCurrentlyAllChecked
        });
      });
    }

    // Labels click and keyboard navigation
    const allLabels = Array.from(document.querySelectorAll('.project-label, .issue-label'));
    let activeLabel = null;

    function setActiveLabel(label) {
      if (activeLabel) activeLabel.classList.remove('active');
      activeLabel = label;
      if (label) {
        label.classList.add('active');
        label.focus();
      }
    }

    allLabels.forEach((el, index) => {
      el.addEventListener('click', (e) => {
        // Don't scroll if clicking on chevron
        if (e.target.classList?.contains('collapse-toggle')) return;
        setActiveLabel(el);
        const issueId = el.dataset.issueId;
        if (issueId) {
          scrollToAndHighlight(issueId);
        }
      });

      el.addEventListener('focus', () => {
        // Ensure focused element is visible
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });

      el.addEventListener('keydown', (e) => {
        const collapseKey = el.dataset.collapseKey;
        const issueId = el.dataset.issueId ? parseInt(el.dataset.issueId, 10) : NaN;

        switch (e.key) {
          case 'Enter':
          case ' ':
            e.preventDefault();
            if (!isNaN(issueId)) {
              vscode.postMessage({ command: 'openIssue', issueId });
            }
            break;
          case 'ArrowUp':
            e.preventDefault();
            if (index > 0) {
              setActiveLabel(allLabels[index - 1]);
            }
            break;
          case 'ArrowDown':
            e.preventDefault();
            if (index < allLabels.length - 1) {
              setActiveLabel(allLabels[index + 1]);
            }
            break;
          case 'ArrowLeft':
            e.preventDefault();
            // Collapse current row if it has children
            if (collapseKey) {
              vscode.postMessage({ command: 'toggleCollapse', collapseKey, action: 'collapse' });
            }
            break;
          case 'ArrowRight':
            e.preventDefault();
            // Expand current row if it has children
            if (collapseKey) {
              vscode.postMessage({ command: 'toggleCollapse', collapseKey, action: 'expand' });
            }
            break;
          case 'Home':
            e.preventDefault();
            setActiveLabel(allLabels[0]);
            break;
          case 'End':
            e.preventDefault();
            setActiveLabel(allLabels[allLabels.length - 1]);
            break;
        }
      });
    });

    // Handle drag move (resizing, moving, and linking)
    // Use requestAnimationFrame to throttle updates for smooth 60fps
    let dragRafPending = false;
    let lastMouseEvent = null;

    addDocListener('mousemove', (e) => {
      // Early exit if no drag in progress
      if (!dragState && !linkingState) return;

      // Store latest event and schedule RAF if not pending
      lastMouseEvent = e;
      if (dragRafPending) return;
      dragRafPending = true;

      requestAnimationFrame(() => {
        dragRafPending = false;
        const evt = lastMouseEvent;
        if (!evt) return;

        // Handle resize/move drag
        if (dragState) {
          const delta = evt.clientX - dragState.initialMouseX;

        if (dragState.isMove && dragState.isBulkDrag && dragState.bulkBars) {
          // Bulk move: update all selected bars
          const snappedDelta = snapToDay(delta) - snapToDay(0); // Snap the delta itself
          dragState.bulkBars.forEach(b => {
            const barWidth = b.endX - b.startX;
            const newStartX = Math.max(0, Math.min(b.startX + snappedDelta, timelineWidth - barWidth));
            const newEndX = newStartX + barWidth;
            const width = newEndX - newStartX;
            b.barOutline.setAttribute('x', newStartX);
            b.barOutline.setAttribute('width', width);
            if (b.barMain) {
              b.barMain.setAttribute('x', newStartX);
              b.barMain.setAttribute('width', width);
            }
            b.leftHandle.setAttribute('x', newStartX);
            b.rightHandle.setAttribute('x', newEndX - 8);
            b.newStartX = newStartX;
            b.newEndX = newEndX;
          });
          dragState.snappedDelta = snappedDelta;
        } else {
          // Single bar drag
          let newStartX = dragState.startX;
          let newEndX = dragState.endX;
          const barWidth = dragState.endX - dragState.startX;

          if (dragState.isMove) {
            // Move entire bar: shift both start and end by same delta
            newStartX = snapToDay(Math.max(0, Math.min(dragState.startX + delta, timelineWidth - barWidth)));
            newEndX = newStartX + barWidth;
          } else if (dragState.isLeft) {
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
      }

        // Handle linking drag
        if (linkingState && tempArrow) {
          // Use container rect + scroll to get SVG coordinates
          const rect = timelineColumn.getBoundingClientRect();
          const scrollLeft = timelineColumn.scrollLeft;
          const scrollTop = timelineColumn.scrollTop;
          const endX = evt.clientX - rect.left + scrollLeft;
          const endY = evt.clientY - rect.top + scrollTop;

          // Draw dashed line from start to cursor
          const path = \`M \${linkingState.startX} \${linkingState.startY} L \${endX} \${endY}\`;
          tempArrow.setAttribute('d', path);

          // Find target bar under cursor
          const targetBar = document.elementFromPoint(evt.clientX, evt.clientY)?.closest('.issue-bar');
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
      }); // end RAF
    }); // end mousemove

    // Handle drag end (resizing, moving, and linking)
    addDocListener('mouseup', (e) => {
      // Handle resize/move drag end
      if (dragState) {
        const { issueId, isLeft, isMove, isBulkDrag, bulkBars, newStartX, newEndX, bar, startX, endX, oldStartDate, oldDueDate } = dragState;

        // Handle bulk drag end
        if (isBulkDrag && bulkBars && isMove) {
          // Remove dragging class from all bars
          bulkBars.forEach(b => b.bar.classList.remove('dragging'));

          // Collect all date changes
          const changes = [];
          bulkBars.forEach(b => {
            if (b.newStartX !== undefined && b.newStartX !== b.startX) {
              const newStart = xToDate(b.newStartX);
              const newDue = xToDate(b.newEndX);
              if (newStart !== b.oldStartDate || newDue !== b.oldDueDate) {
                changes.push({
                  issueId: parseInt(b.issueId),
                  oldStartDate: b.oldStartDate,
                  oldDueDate: b.oldDueDate,
                  newStartDate: newStart,
                  newDueDate: newDue
                });
              }
            }
          });

          if (changes.length > 0) {
            // Push bulk change to undo stack
            undoStack.push({ type: 'bulk', changes });
            redoStack.length = 0;
            updateUndoRedoButtons();
            // Send update for each bar
            changes.forEach(c => {
              vscode.postMessage({ command: 'updateDates', issueId: c.issueId, startDate: c.newStartDate, dueDate: c.newDueDate });
            });
          }
          dragState = null;
          return;
        }

        // Single bar drag end
        bar.classList.remove('dragging');

        if (newStartX !== undefined || newEndX !== undefined) {
          let calcStartDate = null;
          let calcDueDate = null;

          if (isMove) {
            // Move: update both dates if position changed
            if (newStartX !== startX) {
              calcStartDate = xToDate(newStartX);
              calcDueDate = xToDate(newEndX);
            }
          } else if (isLeft) {
            calcStartDate = newStartX !== startX ? xToDate(newStartX) : null;
          } else {
            calcDueDate = newEndX !== endX ? xToDate(newEndX) : null;
          }

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
      } else if (action.type === 'bulk') {
        // Undo bulk date changes - revert all to old dates
        action.changes.forEach(c => {
          vscode.postMessage({
            command: 'updateDates',
            issueId: c.issueId,
            startDate: c.oldStartDate,
            dueDate: c.oldDueDate
          });
        });
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
      } else if (action.type === 'bulk') {
        // Redo bulk date changes - apply all new dates
        action.changes.forEach(c => {
          vscode.postMessage({
            command: 'updateDates',
            issueId: c.issueId,
            startDate: c.newStartDate,
            dueDate: c.newDueDate
          });
        });
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

    // Scroll to and highlight an issue (for click/keyboard navigation)
    function scrollToAndHighlight(issueId) {
      if (!issueId) return;
      const label = document.querySelector('.issue-label[data-issue-id="' + issueId + '"]');
      const bar = document.querySelector('.issue-bar[data-issue-id="' + issueId + '"]');
      if (label) {
        label.scrollIntoView({ behavior: 'smooth', block: 'center' });
        label.classList.add('highlighted');
        setTimeout(() => label.classList.remove('highlighted'), 1500);
      }
      if (bar && timelineColumn) {
        const barRect = bar.getBoundingClientRect();
        const timelineRect = timelineColumn.getBoundingClientRect();
        const scrollLeft = timelineColumn.scrollLeft + barRect.left - timelineRect.left - 100;
        timelineColumn.scrollTo({ left: Math.max(0, scrollLeft), behavior: 'smooth' });
        bar.classList.add('highlighted');
        setTimeout(() => bar.classList.remove('highlighted'), 1500);
      }
    }

    // Restore scroll position or scroll to today on initial load
    // Defer to next frame to avoid blocking initial paint and batch layout reads
    requestAnimationFrame(() => {
      if (savedCenterDateMs !== null && timelineColumn) {
        // Date-based restore: works correctly when date range changes
        // Clamp to current date range if saved date is outside
        const clampedDateMs = Math.max(minDateMs, Math.min(maxDateMs, savedCenterDateMs));
        // Always scroll to clamped date (nearest edge if out of range)
        scrollToCenterDate(clampedDateMs);
        if (hScroll) hScroll.scrollLeft = timelineColumn.scrollLeft;
        if (savedScrollTop !== null && bodyScroll) {
          bodyScroll.scrollTop = savedScrollTop;
        }
        savedCenterDateMs = null;
        savedScrollTop = null;
      } else if (savedScrollLeft !== null && timelineColumn) {
        // Legacy pixel position (deprecated, kept for backward compat)
        timelineColumn.scrollLeft = savedScrollLeft;
        if (hScroll) hScroll.scrollLeft = savedScrollLeft;
        if (savedScrollTop !== null && bodyScroll) {
          bodyScroll.scrollTop = savedScrollTop;
        }
        savedScrollLeft = null;
        savedScrollTop = null;
      } else {
        scrollToToday();
        if (hScroll) hScroll.scrollLeft = timelineColumn?.scrollLeft ?? 0;
      }
      // Initialize minimap viewport (batched with scroll restoration)
      updateMinimapViewport();
    });

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
      resizeStartWidth = labelsColumn.offsetWidth;
      resizeHandle.classList.add('dragging');
      document.body.classList.add('cursor-col-resize', 'user-select-none');
      e.preventDefault();
    });

    // RAF throttle for smooth column resize
    let resizeRafPending = false;
    let lastResizeEvent = null;
    addDocListener('mousemove', (e) => {
      if (!isResizing) return;
      lastResizeEvent = e;
      if (resizeRafPending) return;
      resizeRafPending = true;
      requestAnimationFrame(() => {
        resizeRafPending = false;
        if (!lastResizeEvent) return;
        const delta = lastResizeEvent.clientX - resizeStartX;
        const newWidth = Math.min(500, Math.max(150, resizeStartWidth + delta));
        // Resize both header and body labels columns
        if (ganttLeftHeader) ganttLeftHeader.style.width = newWidth + 'px';
        if (labelsColumn) labelsColumn.style.width = newWidth + 'px';
      });
    });

    addDocListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        resizeHandle.classList.remove('dragging');
        document.body.classList.remove('cursor-col-resize', 'user-select-none');
        saveState(); // Persist new column width
      }
    });

    // Auto-hide loading overlay after content renders
    requestAnimationFrame(() => {
      document.getElementById('loadingOverlay').classList.remove('visible');
    });
  </script>
</body>
</html>`;
  }

  private _getEmptyHtml(allProjectsHidden = false): string {
    const nonce = getNonce();
    const message = allProjectsHidden
      ? "All projects are hidden. Use the checkboxes to show projects."
      : "No issues with dates to display. Add start_date or due_date to your issues.";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
  <title>Redmine Gantt</title>
  <style nonce="${nonce}">
    body {
      padding: 20px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
    }
  </style>
</head>
<body>
  <h2>Timeline</h2>
  <p>${message}</p>
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

    // Cache month names to avoid expensive toLocaleString() calls in loop
    const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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
            <line x1="${x}" y1="0" x2="${x}" y2="100%" class="day-grid opacity-02"/>
          `);
        }
      }

      // Month markers (for month/quarter/year zoom)
      if ((zoomLevel === "month" || zoomLevel === "quarter" || zoomLevel === "year") && dayOfMonth === 1 && lastMonth !== month) {
        lastMonth = month;
        const monthLabel = MONTH_SHORT[month];
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
        const startMonth = MONTH_SHORT[current.getUTCMonth()];
        const endDay = weekEnd.getUTCDate();
        const endMonth = MONTH_SHORT[weekEnd.getUTCMonth()];
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
    const heatmapGroup = `<g class="heatmap-layer${showHeatmap ? "" : " hidden"}">${heatmapBackgrounds.join("")}</g>`;
    const weekendGroup = `<g class="weekend-layer${showHeatmap ? " hidden" : ""}">${weekendBackgrounds.join("")}</g>`;

    return {
      header: headerContent.join(""),
      body: heatmapGroup + weekendGroup + bodyGridLines.join("") + bodyMarkers.join(""),
    };
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}
