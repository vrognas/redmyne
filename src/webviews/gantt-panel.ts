import * as vscode from "vscode";
import * as crypto from "crypto";
import { Issue, IssueRelation } from "../redmine/models/issue";
import { Version } from "../redmine/models/version";
import { RedmineServer } from "../redmine/redmine-server";
import { RedmineProject } from "../redmine/redmine-project";
import { FlexibilityScore, WeeklySchedule, DEFAULT_WEEKLY_SCHEDULE, calculateFlexibility, ContributionData } from "../utilities/flexibility-calculator";
import { calculateContributions, parseTargetIssueId } from "../utilities/contribution-calculator";
import { adHocTracker } from "../utilities/adhoc-tracker";
import { showStatusBarMessage } from "../utilities/status-bar";
import { errorToString } from "../utilities/error-feedback";
import { buildProjectHierarchy, buildResourceHierarchy, flattenHierarchyAll, HierarchyNode } from "../utilities/hierarchy-builder";
import { ProjectHealth } from "../utilities/project-health";
import { buildDependencyGraph, resetDownstreamCountCache } from "../utilities/dependency-graph";
import {
  calculateScheduledCapacity,
  calculateScheduledCapacityByZoom,
  type CapacityZoomLevel,
  type PeriodCapacity,
  type InternalEstimates,
  type ScheduledDailyCapacity,
  type ActualTimeEntries,
} from "../utilities/capacity-calculator";
import { getInternalEstimates, getInternalEstimate } from "../utilities/internal-estimates";
import { getPrecedenceIssues, hasPrecedence, togglePrecedence } from "../utilities/precedence-tracker";
import { autoUpdateTracker } from "../utilities/auto-update-tracker";
import { CollapseStateManager } from "../utilities/collapse-state";
import { debounce, DebouncedFunction } from "../utilities/debounce";
import { IssueFilter, DEFAULT_ISSUE_FILTER, GanttViewMode, CustomField } from "../redmine/models/common";
import { formatCustomFieldValue } from "../utilities/custom-field-formatter";
import { parseLocalDate, getLocalToday, formatLocalDate } from "../utilities/date-utils";
import { GanttWebviewMessage, parseLookbackYears } from "./gantt-webview-messages";
import { escapeAttr, escapeHtml } from "./gantt-html-escape";
import { CreatableRelationType, GanttIssue, GanttRow, nodeToGanttRow } from "./gantt-model";
import { deriveAssigneeState, filterIssuesForView } from "./gantt-view-filter";

// Performance instrumentation (gated behind redmyne.gantt.perfDebug config)
const perfTimers: Map<string, number> = new Map();
function isPerfDebugEnabled(): boolean {
  return vscode.workspace.getConfiguration("redmyne.gantt").get<boolean>("perfDebug", false);
}
function perfStart(name: string): void {
  if (isPerfDebugEnabled()) {
    perfTimers.set(name, performance.now());
  }
}
function perfEnd(name: string, extra?: string): void {
  if (isPerfDebugEnabled()) {
    const start = perfTimers.get(name);
    if (start !== undefined) {
      const duration = performance.now() - start;
      // eslint-disable-next-line no-console
      console.log(`[Gantt Perf] ${name}: ${duration.toFixed(2)}ms${extra ? ` (${extra})` : ""}`);
      perfTimers.delete(name);
    }
  }
}

/** Get today's date as YYYY-MM-DD string */
const getTodayStr = (): string => formatLocalDate(getLocalToday());

const COLLAPSE_DEBOUNCE_MS = 50;

type ZoomLevel = "day" | "week" | "month" | "quarter" | "year";

interface GanttMinimapBar {
  startPct: number;
  endPct: number;
  classes: string;
  color: string;
}

interface GanttRenderState {
  timelineWidth: number;
  minDateMs: number;
  maxDateMs: number;
  totalDays: number;
  redmineBaseUrl: string;
  minimapBarsData: GanttMinimapBar[];
  minimapHeight: number;
  minimapBarHeight: number;
  minimapTodayX: number;
  extScrollLeft: number;
  extScrollTop: number;
  labelWidth: number;
  leftExtrasWidth: number;
  healthFilter: "all" | "healthy" | "warning" | "critical";
  sortBy: "id" | "assignee" | "start" | "due" | "status" | null;
  sortOrder: "asc" | "desc";
  selectedCollapseKey: string | null;
  barHeight: number;
  todayX: number;
  todayInRange: boolean;
  headerHeight: number;
  idColumnWidth: number;
  startDateColumnWidth: number;
  statusColumnWidth: number;
  dueDateColumnWidth: number;
  assigneeColumnWidth: number;
  stickyLeftWidth: number;
  perfDebug: boolean;
}

interface GanttRenderPayload {
  html: string;
  state: GanttRenderState;
}


// Pixels per day for each zoom level
const ZOOM_PIXELS_PER_DAY: Record<ZoomLevel, number> = {
  day: 40,
  week: 15,
  month: 5,
  quarter: 2,
  year: 0.8,
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** Extract initials from full name (e.g., "Viktor Rognås" → "VR") */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

/** Generate consistent HSL color from string (for avatar badges) */
function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 45%)`;
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
 * Format name as "Firstname L." for compact display
 */
function formatShortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return name;
  const firstName = parts[0];
  const lastInitial = parts[parts.length - 1][0];
  return `${firstName} ${lastInitial}.`;
}

/**
 * Get day name key for WeeklySchedule lookup (uses local day)
 */
function getDayKey(date: Date): keyof WeeklySchedule {
  const keys: (keyof WeeklySchedule)[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return keys[date.getDay()]; // Use local day, not UTC
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

  const start = parseLocalDate(issue.start_date);
  const end = parseLocalDate(issue.due_date);
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
 * Get scheduled intensity for an issue from pre-computed schedule map
 * Uses priority-based scheduling data instead of uniform distribution
 */
function getScheduledIntensity(
  issue: GanttIssue,
  schedule: WeeklySchedule,
  issueScheduleMap: Map<number, Map<string, number>>
): { dayOffset: number; intensity: number }[] {
  const result: { dayOffset: number; intensity: number }[] = [];

  if (!issue.start_date || !issue.due_date) {
    return result;
  }

  const issueHoursMap = issueScheduleMap.get(issue.id);
  const start = parseLocalDate(issue.start_date);
  const end = parseLocalDate(issue.due_date);

  const current = new Date(start);
  let dayOffset = 0;
  while (current <= end) {
    // Use formatLocalDate to get consistent YYYY-MM-DD in local timezone
    // (matches the UTC dates used in calculateScheduledCapacity)
    const dateStr = formatLocalDate(current);
    const dayCapacity = schedule[getDayKey(current)];
    const scheduledHours = issueHoursMap?.get(dateStr) ?? 0;
    // Intensity = scheduled hours / available hours for this day
    const intensity = dayCapacity > 0 ? scheduledHours / dayCapacity : 0;
    result.push({ dayOffset, intensity: Math.min(intensity, 1.5) }); // Cap at 1.5 for display
    current.setDate(current.getDate() + 1);
    dayOffset++;
  }

  return result;
}

/**
 * Calculate aggregate daily workload across all issues
 * Returns map of date string (YYYY-MM-DD) to total intensity (hours used / hours available)
 */
function calculateAggregateWorkload(
  issues: { start_date?: string | null; due_date?: string | null; estimated_hours?: number | null; children?: unknown[] }[],
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

  // Filter to leaf issues only (no children) to avoid double-counting
  const leafIssues = issues.filter(i => !i.children || i.children.length === 0);

  // For each issue, distribute its estimated hours across its date range
  for (const issue of leafIssues) {
    if (!issue.start_date || !issue.due_date || !issue.estimated_hours) {
      continue;
    }

    const start = parseLocalDate(issue.start_date);
    const end = parseLocalDate(issue.due_date);
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
        const curr = workloadMap.get(dateKey) ?? 0;
        workloadMap.set(dateKey, curr + intensity);
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
const VIEW_MODE_KEY = "redmyne.gantt.viewMode";
const VIEW_FOCUS_KEY = "redmyne.gantt.viewFocus";
const SELECTED_PROJECT_KEY = "redmyne.gantt.selectedProject";
const SELECTED_ASSIGNEE_KEY = "redmyne.gantt.selectedAssignee";
const FILTER_ASSIGNEE_KEY = "redmyne.gantt.filterAssignee";
const FILTER_STATUS_KEY = "redmyne.gantt.filterStatus";
const FILTER_HEALTH_KEY = "redmyne.gantt.filterHealth";
const LOOKBACK_YEARS_KEY = "redmyne.gantt.lookbackYears";

export class GanttPanel {
  public static currentPanel: GanttPanel | undefined;
  private static _globalState: vscode.Memento | undefined;

  /** Initialize GanttPanel with globalState for persistence */
  public static initialize(globalState: vscode.Memento): void {
    GanttPanel._globalState = globalState;
  }

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _issues: Issue[] = [];
  private _dependencyIssues: Issue[] = []; // External scheduling dependencies
  private _issueById: Map<number, Issue> = new Map(); // O(1) lookup cache
  private _projects: RedmineProject[] = [];
  private _versions: Version[] = []; // Milestones across all projects
  private _flexibilityCache: Map<number, FlexibilityScore | null> = new Map();
  private _getServerFn: (() => RedmineServer | undefined) | undefined;

  /** Get current server (called fresh each time to handle late connection) */
  private get _server(): RedmineServer | undefined {
    return this._getServerFn?.();
  }
  private _zoomLevel: ZoomLevel = "month";
  private _schedule: WeeklySchedule = DEFAULT_WEEKLY_SCHEDULE;
  private _showWorkloadHeatmap: boolean = false;
  private _showDependencies: boolean = true;
  private _showIntensity: boolean = false;
  private _scrollPosition: { left: number; top: number } = { left: 0, top: 0 };
  private _visibleRelationTypes: Set<string> = new Set(["blocks", "precedes"]);
  private _closedStatusIds: Set<number> = new Set();
  private _debouncedCollapseUpdate: DebouncedFunction<() => void>;
  private _cachedHierarchy?: HierarchyNode[];
  private _collapseState = new CollapseStateManager(); // Gantt-specific collapse state (independent from tree view)
  private _renderKey = 0; // Incremented on each render to force SVG re-creation
  // Performance cache for expensive computations (invalidated on data/settings change)
  private _workloadCache?: { key: string; data: Map<string, number> };
  private _capacityCache?: { key: string; data: PeriodCapacity[] };
  private _dataRevision = 0; // Incremented on any data mutation to invalidate caches
  private _disposed = false; // Set on dispose to prevent late webview access
  private _isRefreshing = false; // Show loading overlay during data refresh
  private _baseHtmlSet = false;
  private _webviewReady = false;
  private _pendingRender?: GanttRenderPayload;
  private _contributionsLoading = false; // Prevent duplicate contribution fetches
  private _versionsLoading = false; // Prevent duplicate version fetches
  private _supplementalLoadId = 0; // Monotonic id to ignore stale async loads
  private _currentFilter: IssueFilter = { ...DEFAULT_ISSUE_FILTER };
  private _healthFilter: "all" | "healthy" | "warning" | "critical" = "all";
  private _filterChangeCallback?: (filter: IssueFilter) => void;
  private _viewMode: GanttViewMode = "projects";
  private _viewFocus: "project" | "person" = "project"; // Toggle: view by project or person
  private _selectedProjectId: number | null = null; // Selected project (null = first available)
  private _selectedAssignee: string | null = null; // Selected person (null = first available)
  private _uniqueAssignees: string[] = []; // Extracted from issues
  private _showCapacityRibbon = true; // Capacity ribbon visible by default in My Work
  // Sort settings (null = no sorting, use natural/hierarchy order)
  private _sortBy: "id" | "assignee" | "start" | "due" | "status" | null = null;
  private _sortOrder: "asc" | "desc" = "asc";
  // Lookback period for filtering old data (in years)
  private _lookbackYears: 2 | 5 | 10 | null = 2; // null = no limit
  // Actual time entries for past-day intensity (issueId -> date -> hours)
  private _actualTimeEntries: ActualTimeEntries = new Map();
  // Current user for special highlighting
  private _currentUserId: number | null = null;
  private _currentUserName: string | null = null;
  // Keyboard navigation state
  private _selectedCollapseKey: string | null = null;
  // Expand all on first render and when switching project/person
  private _expandAllOnNextRender = true;
  // Ad-hoc budget contribution tracking
  private _contributionData?: ContributionData;
  private _contributionSources?: Map<number, { fromIssueId: number; hours: number }[]>;
  private _donationTargets?: Map<number, { toIssueId: number; hours: number }[]>;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, getServer?: () => RedmineServer | undefined) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._getServerFn = getServer;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (message) => this._handleMessage(message),
      null,
      this._disposables
    );

    // Restore view mode from globalState
    if (GanttPanel._globalState) {
      this._viewMode = GanttPanel._globalState.get<GanttViewMode>(VIEW_MODE_KEY, "projects");
      this._viewFocus = GanttPanel._globalState.get<"project" | "person">(VIEW_FOCUS_KEY, "project");
      this._selectedProjectId = GanttPanel._globalState.get<number | null>(SELECTED_PROJECT_KEY, null);
      this._selectedAssignee = GanttPanel._globalState.get<string | null>(SELECTED_ASSIGNEE_KEY, null);
      // Restore filter state
      const savedAssignee = GanttPanel._globalState.get<"me" | "any">(FILTER_ASSIGNEE_KEY);
      const savedStatus = GanttPanel._globalState.get<"open" | "closed" | "any">(FILTER_STATUS_KEY);
      if (savedAssignee) this._currentFilter.assignee = savedAssignee;
      if (savedStatus) this._currentFilter.status = savedStatus;
      this._healthFilter = GanttPanel._globalState.get<"all" | "healthy" | "warning" | "critical">(FILTER_HEALTH_KEY, "all");
      this._lookbackYears = GanttPanel._globalState.get<2 | 5 | 10 | null>(LOOKBACK_YEARS_KEY, 2);
    }

    // Create debounced collapse update to prevent rapid re-renders
    this._debouncedCollapseUpdate = debounce(COLLAPSE_DEBOUNCE_MS, () => this._updateContent());
  }

  public static createOrShow(extensionUri: vscode.Uri, getServer?: () => RedmineServer | undefined): GanttPanel {
    const column = vscode.ViewColumn.One;

    if (GanttPanel.currentPanel) {
      GanttPanel.currentPanel._panel.reveal(column);
      // Update server getter reference
      if (getServer) {
        GanttPanel.currentPanel._getServerFn = getServer;
      }
      return GanttPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "redmyneGantt",
      "Redmyne Gantt",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );

    GanttPanel.currentPanel = new GanttPanel(panel, extensionUri, getServer);
    // Show loading skeleton immediately
    GanttPanel.currentPanel._showLoadingSkeleton();
    return GanttPanel.currentPanel;
  }

  /**
   * Restore panel from serialized state (after window reload)
   */
  public static restore(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, getServer?: () => RedmineServer | undefined): GanttPanel {
    GanttPanel.currentPanel = new GanttPanel(panel, extensionUri, getServer);
    GanttPanel.currentPanel._showLoadingSkeleton();
    return GanttPanel.currentPanel;
  }

  private _showLoadingSkeleton(): void {
    const labelWidth = 250;
    const headerHeight = 40;
    const barHeight = 22; // VS Code native tree row height
    const barGap = 0;
    const indentSize = 8;
    const rowCount = 10;
    const timelineWidth = 600;
    const idColumnWidth = 50;
    const startDateColumnWidth = 58;
    const statusColumnWidth = 50; // Colored dot + header text
    const dueDateColumnWidth = 58;
    const assigneeColumnWidth = 40;
    const resizeHandleWidth = 10;
    const extraColumnsWidth = idColumnWidth + startDateColumnWidth + statusColumnWidth + dueDateColumnWidth + assigneeColumnWidth;
    const stickyLeftWidth = labelWidth + resizeHandleWidth + extraColumnsWidth;

    // Generate skeleton rows
    const skeletonRows = Array.from({ length: rowCount }, (_, i) => {
      const y = i * (barHeight + barGap);
      const isProject = i % 3 === 0;
      const indent = isProject ? 0 : indentSize;
      // Vary bar positions and widths for visual interest
      const barStart = 50 + (i * 37) % 200;
      const barWidth = 80 + (i * 53) % 150;
      return { y, isProject, indent, barStart, barWidth };
    });

    const labelsSvg = skeletonRows.map((r, i) => `
      <g class="skeleton-label delay-${Math.min(i, 7)}">
        <rect x="${5 + r.indent}" y="${r.y + 8}" width="${r.isProject ? 100 : 140}" height="14" rx="2" fill="var(--vscode-panel-border)"/>
      </g>
    `).join("");

    const barsSvg = skeletonRows.map((r, i) => `
      <g class="skeleton-bar-group delay-${Math.min(i, 7)}">
        <rect x="${r.barStart}" y="${r.y + 4}" width="${r.barWidth}" height="${barHeight - 8}" rx="8"
              fill="var(--vscode-panel-border)" class="skeleton-timeline-bar"/>
      </g>
    `).join("");

    // ID column skeleton
    const idSvg = skeletonRows.map((r, i) => r.isProject ? "" : `
      <g class="skeleton-label delay-${Math.min(i, 7)}">
        <rect x="${(idColumnWidth - 35) / 2}" y="${r.y + 10}" width="35" height="10" rx="2" fill="var(--vscode-panel-border)"/>
      </g>
    `).join("");

    // Start date column skeleton
    const startSvg = skeletonRows.map((r, i) => r.isProject ? "" : `
      <g class="skeleton-label delay-${Math.min(i, 7)}">
        <rect x="${(startDateColumnWidth - 50) / 2}" y="${r.y + 10}" width="50" height="10" rx="2" fill="var(--vscode-panel-border)"/>
      </g>
    `).join("");

    // Status column skeleton (dot placeholder)
    const statusSvg = skeletonRows.map((r, i) => r.isProject ? "" : `
      <g class="skeleton-label delay-${Math.min(i, 7)}">
        <circle cx="${statusColumnWidth / 2}" cy="${r.y + barHeight / 2}" r="5" fill="var(--vscode-panel-border)"/>
      </g>
    `).join("");

    // Due date column skeleton
    const dueSvg = skeletonRows.map((r, i) => r.isProject ? "" : `
      <g class="skeleton-label delay-${Math.min(i, 7)}">
        <rect x="${(dueDateColumnWidth - 50) / 2}" y="${r.y + 10}" width="50" height="10" rx="2" fill="var(--vscode-panel-border)"/>
      </g>
    `).join("");

    // Assignee column skeleton (circle avatars)
    const assigneeSvg = skeletonRows.map((r, i) => r.isProject ? "" : `
      <g class="skeleton-label delay-${Math.min(i, 7)}">
        <circle cx="${assigneeColumnWidth / 2}" cy="${r.y + barHeight / 2}" r="9" fill="var(--vscode-panel-border)"/>
      </g>
    `).join("");

    // Zebra stripes for alternating row backgrounds
    const zebraStripes = skeletonRows
      .filter((_, i) => i % 2 === 1)
      .map(r => `<rect x="0" y="${r.y}" width="100%" height="${barHeight}" fill="var(--vscode-list-hoverBackground)" opacity="0.15"/>`)
      .join("");

    const bodyHeight = Math.max(rowCount * barHeight + barGap, 600);

    const html = `
  <div class="gantt-header">
    <div class="gantt-title"><span class="loading-text">Loading issues...</span></div>
    <div class="gantt-actions" role="toolbar" aria-label="Gantt chart controls">
      <!-- Zoom -->
      <select class="toolbar-select" disabled title="Zoom level"><option>Month</option></select>
      <!-- View -->
      <select class="toolbar-select" disabled title="View by"><option>By Project</option></select>
      <!-- Context selector -->
      <select class="toolbar-select" disabled title="Select project"><option>Loading...</option></select>
      <div class="toolbar-separator"></div>
      <!-- Filters -->
      <select class="toolbar-select" disabled title="Filter by assignee"><option>My issues</option></select>
      <select class="toolbar-select" disabled title="Filter by status"><option>Open</option></select>
      <!-- Primary actions -->
      <button class="toggle-btn text-btn" disabled title="Refresh">↻</button>
      <button class="toggle-btn text-btn" disabled title="Today">T</button>
      <!-- Overflow menu -->
      <button class="toggle-btn text-btn" disabled title="More options">⋮</button>
      <div class="toolbar-separator"></div>
      <button class="toggle-btn text-btn" disabled title="Help">?</button>
    </div>
  </div>
  <div class="gantt-container">
    <div class="gantt-scroll-wrapper">
      <div class="gantt-scroll" id="ganttScroll">
        <div class="gantt-header-row">
          <div class="gantt-sticky-left gantt-corner">
            <div class="gantt-col-status"><div class="gantt-col-header">Status</div></div>
            <div class="gantt-col-id"><div class="gantt-col-header">#ID</div></div>
            <div class="gantt-left-header" id="ganttLeftHeader"><div class="gantt-col-header">Task</div></div>
            <div class="gantt-resize-handle-header" id="resizeHandleHeader"></div>
            <div class="gantt-col-start"><div class="gantt-col-header">Start</div></div>
            <div class="gantt-col-due"><div class="gantt-col-header">Due</div></div>
            <div class="gantt-col-assignee"><div class="gantt-col-header">Who</div></div>
          </div>
          <div class="gantt-timeline-header">
            <svg width="${timelineWidth}" height="${headerHeight}"></svg>
          </div>
        </div>
        <div class="gantt-body">
          <div class="gantt-sticky-left">
            <div class="gantt-col-status">
              <svg width="${statusColumnWidth}" height="${bodyHeight}">
                ${zebraStripes}
                ${statusSvg}
              </svg>
            </div>
            <div class="gantt-col-id">
              <svg width="${idColumnWidth}" height="${bodyHeight}">
                ${zebraStripes}
                ${idSvg}
              </svg>
            </div>
            <div class="gantt-labels" id="ganttLabels">
              <svg width="${labelWidth * 2}" height="${bodyHeight}">
                ${zebraStripes}
                ${labelsSvg}
              </svg>
            </div>
            <div class="gantt-resize-handle" id="resizeHandle"></div>
            <div class="gantt-col-start">
              <svg width="${startDateColumnWidth}" height="${bodyHeight}">
                ${zebraStripes}
                ${startSvg}
              </svg>
            </div>
            <div class="gantt-col-due">
              <svg width="${dueDateColumnWidth}" height="${bodyHeight}">
                ${zebraStripes}
                ${dueSvg}
              </svg>
            </div>
            <div class="gantt-col-assignee">
              <svg width="${assigneeColumnWidth}" height="${bodyHeight}">
                ${zebraStripes}
                ${assigneeSvg}
              </svg>
            </div>
          </div>
          <div class="gantt-timeline" id="ganttTimeline">
            <svg width="${timelineWidth + 50}" height="${bodyHeight}">
              ${zebraStripes}
              ${barsSvg}
            </svg>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="minimap-container"></div>
`;

    const state = this._getFallbackState({
      labelWidth,
      headerHeight,
      barHeight,
      timelineWidth,
      idColumnWidth,
      startDateColumnWidth,
      statusColumnWidth,
      dueDateColumnWidth,
      assigneeColumnWidth,
      leftExtrasWidth: resizeHandleWidth + extraColumnsWidth,
      stickyLeftWidth,
    });

    this._queueRender({ html, state });
  }

  private _getBaseHtml(): string {
    const nonce = getNonce();
    const webview = this._panel.webview;
    const commonCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "webview-common.css"));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "gantt.css"));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "gantt.js"));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Redmyne Gantt</title>
  <link rel="stylesheet" href="${commonCssUri}">
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div id="ganttRoot"></div>
  <script nonce="${nonce}">
    window.__GANTT_INITIAL_PAYLOAD__ = null;
  </script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  private _ensureWebviewHtml(): void {
    if (this._baseHtmlSet) return;
    this._panel.webview.html = this._getBaseHtml();
    this._baseHtmlSet = true;
    this._webviewReady = false;
  }

  private _queueRender(payload: GanttRenderPayload): void {
    if (this._disposed) return; // Skip if panel was disposed
    this._ensureWebviewHtml();
    if (this._webviewReady) {
      this._pendingRender = undefined;
      void this._panel.webview.postMessage({ command: "render", payload });
    } else {
      this._pendingRender = payload;
    }
  }

  private _getFallbackState(overrides: Partial<GanttRenderState> = {}): GanttRenderState {
    const now = Date.now();
    const labelWidth = 250;
    const headerHeight = 40;
    const barHeight = 22;
    const idColumnWidth = 50;
    const startDateColumnWidth = 58;
    const statusColumnWidth = 50;
    const dueDateColumnWidth = 58;
    const assigneeColumnWidth = 40;
    const resizeHandleWidth = 10;
    const extraColumnsWidth = idColumnWidth + startDateColumnWidth + statusColumnWidth + dueDateColumnWidth + assigneeColumnWidth;
    const stickyLeftWidth = labelWidth + resizeHandleWidth + extraColumnsWidth;
    const ganttConfig = vscode.workspace.getConfiguration("redmyne.gantt");
    const perfDebug = ganttConfig.get<boolean>("perfDebug", false);
    const redmineBaseUrl = vscode.workspace.getConfiguration("redmyne").get<string>("serverUrl") || "";

    const baseState: GanttRenderState = {
      timelineWidth: 600,
      minDateMs: now,
      maxDateMs: now + 86400000,
      totalDays: 1,
      redmineBaseUrl,
      minimapBarsData: [],
      minimapHeight: 30,
      minimapBarHeight: 5,
      minimapTodayX: 0,
      extScrollLeft: this._scrollPosition.left,
      extScrollTop: this._scrollPosition.top,
      labelWidth,
      leftExtrasWidth: resizeHandleWidth + extraColumnsWidth,
      healthFilter: this._healthFilter,
      sortBy: this._sortBy,
      sortOrder: this._sortOrder,
      selectedCollapseKey: this._selectedCollapseKey,
      barHeight,
      todayX: 0,
      todayInRange: false,
      headerHeight,
      idColumnWidth,
      startDateColumnWidth,
      statusColumnWidth,
      dueDateColumnWidth,
      assigneeColumnWidth,
      stickyLeftWidth,
      perfDebug,
    };

    return { ...baseState, ...overrides };
  }

  public async updateIssues(
    issues: Issue[],
    flexibilityCache: Map<number, FlexibilityScore | null>,
    projects: RedmineProject[],
    schedule?: WeeklySchedule,
    filter?: IssueFilter,
    dependencyIssues?: Issue[],
    getServer?: () => RedmineServer | undefined
  ): Promise<void> {
    // Update server getter if provided (for restored panels)
    if (getServer) {
      this._getServerFn = getServer;
    }
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
    this._dependencyIssues = (dependencyIssues ?? []).filter((i) => i.start_date || i.due_date);
    // Build O(1) lookup map (includes dependencies for arrow rendering)
    const allIssues = [...this._issues, ...this._dependencyIssues];
    this._issueById = new Map(allIssues.map(i => [i.id, i]));
    this._projects = projects.filter(p => p !== null);
    this._flexibilityCache = flexibilityCache;

    // Invalidate caches when data changes
    this._bumpRevision();

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

    // Fetch current user ID for highlighting (name captured from issues later)
    if (this._currentUserId === null && this._server) {
      try {
        const user = await this._server.getCurrentUser();
        if (user) {
          this._currentUserId = user.id;
        }
      } catch {
        // Ignore errors
      }
    }

    // Fetch time entries for intensity calculation (person view uses actual hours for past days)
    if (this._viewFocus === "person" && this._server) {
      try {
        const today = getLocalToday();
        // Fetch last 90 days of time entries for current user
        const fromDate = new Date(today);
        fromDate.setDate(fromDate.getDate() - 90);
        const fromStr = formatLocalDate(fromDate);
        const toStr = formatLocalDate(today);

        const { time_entries } = await this._server.getTimeEntries({ from: fromStr, to: toStr });

        // Build actualTimeEntries map: issueId -> date -> hours
        // For ad-hoc issues with target references (#1234), add hours to TARGET issue
        this._actualTimeEntries = new Map();
        for (const entry of time_entries) {
          if (!entry.issue?.id || !entry.spent_on) continue;
          const sourceIssueId = entry.issue.id;
          const date = entry.spent_on;
          const hours = parseFloat(entry.hours as unknown as string) || 0;

          // Check if this is an ad-hoc issue contributing to another issue
          let targetIssueId = sourceIssueId;
          if (adHocTracker.isAdHoc(sourceIssueId)) {
            const parsed = parseTargetIssueId(entry.comments);
            if (parsed) {
              targetIssueId = parsed; // Map hours to target issue
            }
          }

          if (!this._actualTimeEntries.has(targetIssueId)) {
            this._actualTimeEntries.set(targetIssueId, new Map());
          }
          const issueMap = this._actualTimeEntries.get(targetIssueId)!;
          issueMap.set(date, (issueMap.get(date) ?? 0) + hours);
        }
      } catch {
        // Ignore errors, fall back to prediction-only
        this._actualTimeEntries = new Map();
      }
    }

    this._updateContent();
    void this._refreshSupplementalData();
  }

  /**
   * Load supplemental data (contributions + versions) and re-render once if needed.
   */
  private async _refreshSupplementalData(): Promise<void> {
    const loadId = ++this._supplementalLoadId;
    const shouldLoadVersions = this._viewFocus !== "person";
    const [contributionsChanged, versionsChanged] = await Promise.all([
      this._loadContributions(loadId),
      shouldLoadVersions ? this._loadVersions(loadId) : Promise.resolve(false),
    ]);

    if (this._supplementalLoadId !== loadId) return;
    if (contributionsChanged || versionsChanged) {
      this._updateContent();
    }
  }

  /**
   * Load time entries and calculate contributions for ad-hoc budget issues.
   * Rebuilds flexibility cache with effective spent hours.
   */
  private async _loadContributions(loadId: number): Promise<boolean> {
    if (!this._server || this._issues.length === 0) return false;
    if (this._contributionsLoading) return false; // Prevent duplicate fetches
    this._contributionsLoading = true;

    try {
      // Get unique project IDs from displayed issues
      const projectIds = new Set<number>();
      for (const issue of this._issues) {
        if (issue.project?.id) {
          projectIds.add(issue.project.id);
        }
      }

      if (projectIds.size === 0) {
        return false;
      }

      // Get all ad-hoc issue IDs - we need to fetch time entries from ALL of them
      // to calculate contributions TO displayed issues (even if ad-hoc source isn't displayed)
      const adHocIssueIds = new Set(adHocTracker.getAll());
      if (adHocIssueIds.size === 0) {
        return false;
      }

      // Fetch time entries for ALL ad-hoc issues (not just displayed)
      // This ensures contributions to displayed issues are calculated
      const allAdHocIds = Array.from(adHocIssueIds);

      // Calculate date range based on lookback period
      const today = new Date();
      const todayStr = today.toISOString().slice(0, 10);

      // Apply lookback limit (default 2 years, can be 5, 10, or null for unlimited)
      let fromDate: string;
      if (this._lookbackYears === null) {
        // Unlimited: use earliest non-ad-hoc issue start date
        const startDates = this._issues
          .filter(i => !adHocIssueIds.has(i.id))
          .map(i => i.start_date)
          .filter((d): d is string => !!d)
          .sort();
        fromDate = startDates[0] || todayStr;
      } else {
        // Limited: use lookback period from today
        const lookbackDate = new Date(today);
        lookbackDate.setFullYear(lookbackDate.getFullYear() - this._lookbackYears);
        fromDate = lookbackDate.toISOString().slice(0, 10);
      }

      // In by-person mode, filter by viewed user for efficiency
      // (cross-user contributions won't show, but avoids fetching thousands of entries)
      let userId: number | undefined;
      if (this._viewFocus === "person" && this._selectedAssignee) {
        const assigneeIssue = this._issues.find(
          i => i.assigned_to?.name === this._selectedAssignee
        );
        userId = assigneeIssue?.assigned_to?.id;
      }

      // Fetch time entries with date range and optional user filter
      const allTimeEntries = await this._server.getTimeEntriesForIssues(allAdHocIds, {
        from: fromDate,
        to: todayStr,
        userId,
      });

      const contributions = calculateContributions(allTimeEntries);
      if (loadId !== this._supplementalLoadId) return false;

      // Build contribution data for flexibility calculation
      const contributionData: ContributionData = {
        contributedTo: contributions.contributedTo,
        donatedFrom: contributions.donatedFrom,
        adHocIssues: adHocIssueIds,
      };

      // Store contribution data for tooltip display
      this._contributionData = contributionData;
      this._contributionSources = contributions.contributionSources;
      this._donationTargets = contributions.donationTargets;

      // Rebuild flexibility cache with contributions
      for (const issue of this._issues) {
        const spentHours = issue.spent_hours ?? 0;
        let effectiveSpent: number | undefined;

        if (adHocIssueIds.has(issue.id)) {
          // Ad-hoc issue: show negative (donated hours)
          const donated = contributions.donatedFrom.get(issue.id) ?? 0;
          effectiveSpent = -donated;
        } else {
          // Normal issue: add contributed hours
          const contributed = contributions.contributedTo.get(issue.id) ?? 0;
          if (contributed > 0) {
            effectiveSpent = spentHours + contributed;
          }
        }

        if (effectiveSpent !== undefined) {
          const newFlexibility = calculateFlexibility(
            {
              start_date: issue.start_date || "",
              due_date: issue.due_date || null,
              estimated_hours: issue.estimated_hours ?? null,
              spent_hours: issue.spent_hours,
              done_ratio: issue.done_ratio,
            },
            this._schedule,
            effectiveSpent
          );
          this._flexibilityCache.set(issue.id, newFlexibility);
        }
      }

      this._cachedHierarchy = undefined;
      return true;
    } catch {
      // Silently fail - contributions are optional enhancement
      return false;
    } finally {
      this._contributionsLoading = false;
    }
  }

  /**
   * Load versions (milestones) for all displayed projects.
   * Fetches in parallel and stores for rendering as milestone markers.
   */
  private async _loadVersions(loadId: number): Promise<boolean> {
    if (!this._server || this._projects.length === 0) return false;
    if (this._versionsLoading) return false;
    this._versionsLoading = true;

    try {
      // Get unique project IDs
      const projectIds = this._projects.map(p => p.id);

      // Fetch versions for all projects
      const versionMap = await this._server.getVersionsForProjects(projectIds);

      // Flatten and deduplicate by ID (shared versions may appear multiple times)
      const seen = new Set<number>();
      const allVersions: Version[] = [];
      for (const versions of versionMap.values()) {
        for (const v of versions) {
          if (!seen.has(v.id) && v.due_date && v.status !== "closed") {
            seen.add(v.id);
            allVersions.push(v);
          }
        }
      }

      // Sort by due date
      allVersions.sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""));

      if (loadId !== this._supplementalLoadId) return false;
      const hasChanges = !this._versions.every((version, idx) => {
        const next = allVersions[idx];
        return next && version.id === next.id && version.name === next.name && version.due_date === next.due_date;
      }) || this._versions.length !== allVersions.length;

      if (!hasChanges) return false;
      this._versions = allVersions;
      return true;
    } catch {
      // Silently fail - versions are optional
      return false;
    } finally {
      this._versionsLoading = false;
    }
  }

  /**
   * Update a single issue's done_ratio without full refresh
   */
  public updateIssueDoneRatio(issueId: number, doneRatio: number): void {
    const issue = this._issueById.get(issueId);
    if (issue) {
      issue.done_ratio = doneRatio;
      this._bumpRevision();
      this._updateContent();
    }
  }

  /**
   * Switch to project view and select a specific project
   */
  public showProject(projectId: number): void {
    // Switch to "project" view focus
    this._viewFocus = "project";
    GanttPanel._globalState?.update(VIEW_FOCUS_KEY, this._viewFocus);

    // Select the project
    this._selectedProjectId = projectId;
    this._bumpRevision();
    this._expandAllOnNextRender = true;
    GanttPanel._globalState?.update(SELECTED_PROJECT_KEY, this._selectedProjectId);

    this._updateContent();
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
      this._bumpRevision();
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
          this._bumpRevision();
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

  /** Bump revision counter and clear caches (call on any data mutation) */
  private _bumpRevision(): void {
    this._dataRevision++;
    this._workloadCache = undefined;
    this._capacityCache = undefined;
    this._cachedHierarchy = undefined;
  }

  private _updateContent(): void {
    perfStart("_updateContent");
    this._renderKey++; // Force SVG re-creation on each render
    this._queueRender(this._getRenderPayload());
    this._isRefreshing = false; // Reset after render
    perfEnd("_updateContent");
  }

  private _handleMessage(message: GanttWebviewMessage): void {
    switch (message.command) {
      case "webviewReady":
        this._webviewReady = true;
        if (this._pendingRender) {
          const payload = this._pendingRender;
          this._pendingRender = undefined;
          void this._panel.webview.postMessage({ command: "render", payload });
        }
        break;
      case "openIssue":
        if (message.issueId && this._server) {
          // Open issue actions (refresh is handled by individual actions if needed)
          vscode.commands.executeCommand(
            "redmyne.openActionsForIssue",
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
      case "setLookback":
        this._lookbackYears = parseLookbackYears(message.years, this._lookbackYears);
        GanttPanel._globalState?.update(LOOKBACK_YEARS_KEY, this._lookbackYears);
        // Clear contribution cache and re-fetch with new lookback
        this._contributionData = undefined;
        this._contributionsLoading = false;
        this._updateContent();
        break;
      case "setViewMode":
        if (message.viewMode && (message.viewMode === "projects" || message.viewMode === "mywork")) {
          this._viewMode = message.viewMode;
          this._cachedHierarchy = undefined; // Rebuild hierarchy with new mode
          GanttPanel._globalState?.update(VIEW_MODE_KEY, this._viewMode);
          this._updateContent();
        }
        break;
      case "setViewFocus":
        this._viewFocus = message.focus === "person" ? "person" : "project";
        this._bumpRevision();
        GanttPanel._globalState?.update(VIEW_FOCUS_KEY, this._viewFocus);
        this._updateContent();
        break;
      case "setSelectedProject":
        this._selectedProjectId = message.projectId ?? null;
        this._bumpRevision();
        this._expandAllOnNextRender = true;
        GanttPanel._globalState?.update(SELECTED_PROJECT_KEY, this._selectedProjectId);
        this._updateContent();
        break;
      case "setSelectedAssignee":
        this._selectedAssignee = message.assignee ?? null;
        this._bumpRevision();
        this._expandAllOnNextRender = true;
        GanttPanel._globalState?.update(SELECTED_ASSIGNEE_KEY, this._selectedAssignee);
        this._updateContent();
        break;
      case "deleteRelation":
        if (message.relationId && this._server) {
          this._deleteRelation(message.relationId);
        }
        break;
      case "createRelation":
        if (message.issueId && message.targetIssueId && message.relationType && this._server) {
          this._createRelation(message.issueId, message.targetIssueId, message.relationType as CreatableRelationType);
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
      case "toggleCapacityRibbon":
        this._showCapacityRibbon = !this._showCapacityRibbon;
        this._panel.webview.postMessage({
          command: "setCapacityRibbonState",
          enabled: this._showCapacityRibbon,
        });
        break;
      case "toggleIntensity":
        this._showIntensity = !this._showIntensity;
        // CSS-only toggle: send message to webview to flip classes (no re-render)
        this._panel.webview.postMessage({
          command: "setIntensityState",
          enabled: this._showIntensity,
        });
        break;
      case "refresh":
        // Set refreshing flag so next render shows loading overlay
        this._isRefreshing = true;
        resetDownstreamCountCache();
        // Clear cache and refetch data (including new relations)
        vscode.commands.executeCommand("redmyne.refreshIssues");
        break;
      case "toggleCollapse":
        if (message.collapseKey) {
          const key = message.collapseKey as string;
          // Skip the debounced update from onDidChange - we'll update directly
                    // Use shared collapse state (syncs with Issues pane)
          // action: 'collapse' = only collapse, 'expand' = only expand, undefined = toggle
          if (message.action === "collapse") {
            this._collapseState.collapse(key);
          } else if (message.action === "expand") {
            this._collapseState.expand(key);
          } else {
            this._collapseState.toggle(key);
          }
          // Immediate update to ensure zebra stripes align with new visible rows
          this._updateContent();
        }
        break;
      case "expandAll":
                this._collapseState.expandAll(message.keys);
        this._updateContent();
        break;
      case "collapseAll":
        this._collapseState.collapseAll();
        this._updateContent();
        break;
      case "collapseStateSync":
        // Client-side collapse already done, just sync state for persistence
        // Set flag to skip re-render since client already updated UI
        if (message.collapseKey) {
          if (message.isExpanded) {
            this._collapseState.expand(message.collapseKey);
          } else {
            this._collapseState.collapse(message.collapseKey);
          }
        }
        break;
      case "requestRerender":
        // Re-render requested (e.g., to fix zebra stripes after fallback toggle)
        this._updateContent();
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
          vscode.commands.executeCommand("redmyne.openIssueInBrowser", { id: message.issueId });
        }
        break;
      case "openProjectInBrowser":
        if (message.projectId) {
          const project = this._projects.find(p => p.id === message.projectId);
          if (project) {
            vscode.commands.executeCommand("redmyne.openProjectInBrowser", { project: { identifier: project.identifier } });
          }
        }
        break;
      case "showInIssues":
        if (message.issueId) {
          vscode.commands.executeCommand("redmyne.revealIssueInTree", message.issueId);
        }
        break;
      case "logTime":
        if (message.issueId) {
          vscode.commands.executeCommand("redmyne.quickLogTime", { id: message.issueId });
        }
        break;
      case "setDoneRatio":
        if (message.issueId) {
          vscode.commands.executeCommand("redmyne.setDoneRatio", { id: message.issueId });
        }
        break;
      case "bulkSetDoneRatio":
        if (message.issueIds && message.issueIds.length > 0) {
          vscode.commands.executeCommand("redmyne.bulkSetDoneRatio", message.issueIds);
        }
        break;
      case "copyUrl":
        if (message.issueId) {
          vscode.commands.executeCommand("redmyne.copyIssueUrl", { id: message.issueId });
        }
        break;
      case "showStatus":
        if (message.message) {
          showStatusBarMessage(`$(check) ${message.message}`, 2000);
        }
        break;
      case "todayOutOfRange":
        vscode.window.showInformationMessage("Today is outside the current timeline range", { modal: true });
        break;
      case "setInternalEstimate":
        if (message.issueId) {
          vscode.commands.executeCommand("redmyne.setInternalEstimate", { id: message.issueId });
        }
        break;
      case "toggleAutoUpdate":
        if (message.issueId) {
          vscode.commands.executeCommand("redmyne.toggleAutoUpdateDoneRatio", { id: message.issueId });
        }
        break;
      case "toggleAdHoc":
        if (message.issueId) {
          const isNowAdHoc = adHocTracker.toggle(message.issueId);
          showStatusBarMessage(
            isNowAdHoc ? `$(check) #${message.issueId} tagged as ad-hoc` : `$(check) #${message.issueId} ad-hoc tag removed`,
            2000
          );
          // Refresh Gantt to update contribution data
          this._isRefreshing = true;
          vscode.commands.executeCommand("redmyne.refreshIssues");
        }
        break;
      case "togglePrecedence":
        if (message.issueId && GanttPanel._globalState) {
          togglePrecedence(GanttPanel._globalState, message.issueId).then((isNowPrecedence) => {
            showStatusBarMessage(
              isNowPrecedence
                ? `$(check) #${message.issueId} tagged with precedence priority`
                : `$(check) #${message.issueId} precedence removed`,
              2000
            );
            // Refresh to update intensity calculations
            this._isRefreshing = true;
            vscode.commands.executeCommand("redmyne.refreshIssues");
          });
        }
        break;
      case "setFilter":
        if (message.filter) {
          const newFilter: IssueFilter = {
            assignee: (message.filter.assignee as "me" | "any") ?? this._currentFilter.assignee,
            status: (message.filter.status as "open" | "closed" | "any") ?? this._currentFilter.status,
          };
          this._currentFilter = newFilter;
          // Persist filter state
          GanttPanel._globalState?.update(FILTER_ASSIGNEE_KEY, newFilter.assignee);
          GanttPanel._globalState?.update(FILTER_STATUS_KEY, newFilter.status);
          // Apply filter locally and re-render (bump revision to invalidate capacity cache)
          this._bumpRevision();
          this._updateContent();
          // Notify callback to sync with ProjectsTree (triggers data refresh)
          if (this._filterChangeCallback) {
            this._filterChangeCallback(newFilter);
          }
        }
        break;
      case "setHealthFilter":
        if (message.health) {
          this._healthFilter = message.health as "all" | "healthy" | "warning" | "critical";
          GanttPanel._globalState?.update(FILTER_HEALTH_KEY, this._healthFilter);
          this._updateContent();
        }
        break;
      case "setSelectedKey":
        // Preserve keyboard selection across re-renders
        this._selectedCollapseKey = message.collapseKey ?? null;
        break;
      case "setSort":
        if (message.sortBy !== undefined) {
          this._sortBy = message.sortBy;
        }
        if (message.sortOrder) {
          this._sortOrder = message.sortOrder;
        }
        this._cachedHierarchy = undefined; // Clear cache to rebuild with new sort
        this._updateContent();
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
      this._bumpRevision();
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
      this._bumpRevision();
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
    this._disposed = true; // Prevent late webview access from async ops
    GanttPanel.currentPanel = undefined;
    this._debouncedCollapseUpdate.cancel();
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  private _getRenderPayload(): GanttRenderPayload {
    perfStart("_getRenderPayload");
    // Read gantt config settings
    const ganttConfig = vscode.workspace.getConfiguration("redmyne.gantt");
    const visibleTypes = ganttConfig.get<string[]>("visibleRelationTypes", ["blocks", "precedes"]);
    this._visibleRelationTypes = new Set(visibleTypes);

    // Today for calculations (start of today in local timezone)
    const today = getLocalToday();

    const assigneeState = deriveAssigneeState(this._issues, this._currentUserId, this._currentUserName);
    this._uniqueAssignees = assigneeState.uniqueAssignees;
    this._currentUserName = assigneeState.currentUserName;

    const viewFilter = filterIssuesForView({
      issues: this._issues,
      projects: this._projects,
      viewFocus: this._viewFocus,
      selectedAssignee: this._selectedAssignee,
      currentUserName: this._currentUserName,
      uniqueAssignees: this._uniqueAssignees,
      selectedProjectId: this._selectedProjectId,
      currentFilter: this._currentFilter,
      currentUserId: this._currentUserId,
    });
    this._selectedAssignee = viewFilter.selectedAssignee;
    this._selectedProjectId = viewFilter.selectedProjectId;
    const filteredIssues = viewFilter.filteredIssues;

    // Sort issues before building hierarchy (null = no sorting, keep natural order)
    const sortedIssues = this._sortBy === null ? [...filteredIssues] : [...filteredIssues].sort((a, b) => {
      let cmp = 0;
      switch (this._sortBy) {
        case "id":
          cmp = a.id - b.id;
          break;
        case "assignee":
          cmp = (a.assigned_to?.name ?? "").localeCompare(b.assigned_to?.name ?? "");
          break;
        case "start":
          cmp = (a.start_date ?? "9999").localeCompare(b.start_date ?? "9999");
          break;
        case "due":
          cmp = (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999");
          break;
        case "status":
          cmp = (a.status?.name ?? "").localeCompare(b.status?.name ?? "");
          break;
      }
      return this._sortOrder === "desc" ? -cmp : cmp;
    });

    // Build hierarchical rows FIRST - needed to know which projects have rows
    // Cache hierarchy to avoid rebuilding on collapse/expand
    if (!this._cachedHierarchy) {
      // Extract blocked issue IDs from relations (for health calculation)
      const blockedIds = this.extractBlockedIds(sortedIssues);

      if (this._viewFocus === "person") {
        // Person view: group by project, flat issues
        this._cachedHierarchy = buildResourceHierarchy(
          sortedIssues,
          this._flexibilityCache,
          this._selectedAssignee ?? "",
          this._projects,
          this._sortBy !== null // preserve order when user has applied a sort
        );
      } else {
        // Project view: selected project and all subprojects
        // _selectedProjectId was already updated to effective value in filtering logic above
        const projectMap = new Map(this._projects.map((project) => [project.id, project]));
        let projectsForHierarchy: RedmineProject[] = [];

        if (this._selectedProjectId === null) {
          const relevantProjectIds = new Set<number>();
          for (const issue of sortedIssues) {
            let currentId: number | undefined = issue.project?.id;
            while (currentId !== undefined) {
              if (relevantProjectIds.has(currentId)) break;
              relevantProjectIds.add(currentId);
              currentId = projectMap.get(currentId)?.parent?.id;
            }
          }
          projectsForHierarchy = this._projects.filter((project) => relevantProjectIds.has(project.id));
        } else {
          projectsForHierarchy = this._projects.filter((project) => {
            // Include selected project and all its descendants
            let current: RedmineProject | undefined = project;
            while (current) {
              if (current.id === this._selectedProjectId) return true;
              current = current.parent?.id ? projectMap.get(current.parent.id) : undefined;
            }
            return false;
          });
        }

        this._cachedHierarchy = buildProjectHierarchy(sortedIssues, this._flexibilityCache, projectsForHierarchy, true, blockedIds);
      }
    }
    // Auto-expand all when switching project/person (before flattening)
    if (this._expandAllOnNextRender) {
      this._expandAllOnNextRender = false;
      const collectKeys = (nodes: HierarchyNode[]): string[] => {
        const keys: string[] = [];
        for (const n of nodes) {
          if (n.children.length > 0) keys.push(n.collapseKey);
          keys.push(...collectKeys(n.children));
        }
        return keys;
      };
      const allKeys = collectKeys(this._cachedHierarchy);
      if (allKeys.length > 0) this._collapseState.expandAll(allKeys);
    }
    // Get ALL nodes with visibility flags for client-side collapse management
    const expandedKeys = this._collapseState.getExpandedKeys();
    const flatNodes = flattenHierarchyAll(this._cachedHierarchy, expandedKeys);
    // Build dependency graph for downstream impact calculation
    const depGraph = buildDependencyGraph(sortedIssues);
    const issueMap = new Map(sortedIssues.map(i => [i.id, i]));
    const allRows = flatNodes.map((node) => nodeToGanttRow(node, this._flexibilityCache, this._closedStatusIds, depGraph, issueMap));

    // Extract issue IDs that are actually displayed as rows
    const issueIdsInRows = new Set<number>();
    for (const row of allRows) {
      if (row.type === "issue") {
        issueIdsInRows.add(row.id);
      }
    }

    // Filter issues: must actually be displayed in the hierarchy
    // (not just in same project - important for by-person mode)
    const visibleIssues = this._issues.filter(
      (i) => issueIdsInRows.has(i.id)
    );

    // Focus on active work: exclude completed issues with past dates
    const activeIssues = visibleIssues.filter((i) =>
      i.done_ratio !== 100 ||
      (i.due_date && parseLocalDate(i.due_date) >= today)
    );

    // Use active issues for range, fall back to all visible if none active
    const rangeIssues = activeIssues.length > 0 ? activeIssues : visibleIssues;

    // Prioritize issues with BOTH dates for range calculation (avoid point-bar issues extending timeline)
    const issuesWithBothDates = rangeIssues.filter((i) => i.start_date && i.due_date);
    const rangeBasis = issuesWithBothDates.length > 0 ? issuesWithBothDates : rangeIssues;
    const dates = rangeBasis.flatMap((i) =>
      [i.start_date, i.due_date].filter(Boolean)
    ) as string[];

    // If no issues at all, show empty state
    if (this._issues.length === 0) {
      return this._getEmptyPayload();
    }

    // When no visible dates, use today +/- 30 days as default range
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
      // Add padding based on zoom level for breathing room
      const paddingDays = { day: 1, week: 7, month: 30, quarter: 90, year: 365 }[this._zoomLevel] || 7;
      minDate.setUTCDate(minDate.getUTCDate() - paddingDays);
      maxDate.setUTCDate(maxDate.getUTCDate() + paddingDays);
    }

    // String format for open-ended bars (issues with start but no due date)
    const maxDateStr = maxDate.toISOString().slice(0, 10);
    const minDateStr = minDate.toISOString().slice(0, 10);

    // Build scheduled capacity maps for intensity + capacity tooltip (person view only)
    // issueScheduleMap: issueId -> date -> hours (for bar intensity)
    // dayScheduleMap: date -> [{issueId, hours, project}] (for capacity tooltip)
    const internalEstimates: InternalEstimates = GanttPanel._globalState
      ? getInternalEstimates(GanttPanel._globalState)
      : new Map();
    const precedenceIssues: Set<number> = GanttPanel._globalState
      ? getPrecedenceIssues(GanttPanel._globalState)
      : new Set();
    const issueScheduleMap = new Map<number, Map<string, number>>();
    const dayScheduleMap = new Map<string, { issueId: number; hours: number; project: string }[]>();
    // Always build issueScheduleMap in person view for instant intensity toggle
    const shouldBuildIssueScheduleMap = this._viewFocus === "person";
    if (this._viewFocus === "person") {
      // Get today's date for past/future split in capacity calculation
      const todayStr = getTodayStr();
      perfStart("calculateScheduledCapacity");
      const scheduledDays: ScheduledDailyCapacity[] = calculateScheduledCapacity(
        filteredIssues,
        this._schedule,
        minDateStr,
        maxDateStr,
        depGraph,
        internalEstimates,
        this._currentUserId ?? undefined,
        issueMap,
        precedenceIssues,
        this._actualTimeEntries,
        todayStr
      );
      perfEnd("calculateScheduledCapacity");
      // Build both maps from breakdown
      for (const day of scheduledDays) {
        const dayEntries: { issueId: number; hours: number; project: string }[] = [];
        for (const entry of day.breakdown) {
          // issueScheduleMap for intensity bars
          if (shouldBuildIssueScheduleMap) {
            if (!issueScheduleMap.has(entry.issueId)) {
              issueScheduleMap.set(entry.issueId, new Map());
            }
            issueScheduleMap.get(entry.issueId)!.set(day.date, entry.hours);
          }
          // dayScheduleMap for capacity tooltip
          const issue = issueMap.get(entry.issueId);
          if (issue && entry.hours > 0) {
            const projectName = issue.project?.name ?? "Unknown";
            dayEntries.push({
              issueId: entry.issueId,
              hours: entry.hours,
              project: projectName.length > 20 ? projectName.substring(0, 19) + "…" : projectName
            });
          }
        }
        if (dayEntries.length > 0) {
          dayScheduleMap.set(day.date, dayEntries);
        }
      }
    }

    const totalDays = Math.max(1, Math.ceil(
      (maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24)
    ));

    const pixelsPerDay = ZOOM_PIXELS_PER_DAY[this._zoomLevel];
    const timelineWidth = Math.max(600, totalDays * pixelsPerDay);
    const labelWidth = 250;

    // Auto-fit column widths based on content
    const charWidth = 7; // ~7px per char at 11px font
    const colPadding = 10; // padding on both sides
    let maxIdLen = 3; // minimum "#ID"
    for (const row of allRows) {
      if (row.type === "issue" && row.issue) {
        maxIdLen = Math.max(maxIdLen, `#${row.issue.id}`.length);
      }
    }
    const idColumnWidth = Math.max(40, Math.ceil(maxIdLen * charWidth + colPadding));
    const startDateColumnWidth = 58; // Fixed: "MMM DD" format
    const statusColumnWidth = 50; // Colored dot + header text
    const dueDateColumnWidth = 58; // Fixed: "MMM DD" format
    const assigneeColumnWidth = 40; // Fixed for avatar circles
    const extraColumnsWidth = idColumnWidth + startDateColumnWidth + statusColumnWidth + dueDateColumnWidth + assigneeColumnWidth;
    const resizeHandleWidth = 10;
    const stickyLeftWidth = labelWidth + resizeHandleWidth + extraColumnsWidth;
    const barHeight = 22; // VS Code native tree row height
    const barPadding = 3; // Vertical padding for bar content
    const barY = barPadding;
    const barContentHeight = barHeight - barPadding * 2; // 16px
    const barGap = 10;
    const headerHeight = 40;
    const indentSize = 8; // VS Code native tree indent

    // All projects are visible - no hidden project filtering
    const rows = allRows;

    // Collect all expandable keys (rows with children) for "Expand All" functionality
    const allExpandableKeys = rows.filter(r => r.hasChildren).map(r => r.collapseKey);

    // Filter visible rows ONCE upfront (avoid multiple .filter() calls)
    // Also apply health filter if set (issues only - projects/time-groups always pass)
    // In per-project view, skip the top-level project row (show issues directly)
    const healthFilter = this._healthFilter;
    const skipTopProjectRow = this._viewFocus === "project";
    // Find the top-level project's collapseKey to clear parent references
    const topProjectKey = skipTopProjectRow ? rows.find(r => r.type === "project" && r.depth === 0)?.collapseKey : null;

    // Render ALL rows (including hidden) for instant client-side expand/collapse
    // Hidden rows exist in DOM with visibility:hidden, allowing instant toggle
    const filteredRows = rows.filter(r => {
      // Skip top-level project row in per-project view
      if (skipTopProjectRow && r.type === "project" && r.depth === 0) return false;
      if (healthFilter === "all") return true;
      // Non-issue rows (projects, time-groups) pass through
      if (r.type !== "issue" || !r.issue) return true;
      // Map filter values to FlexibilityScore status values
      const status = r.issue.status;
      switch (healthFilter) {
        case "critical": return status === "overbooked";
        case "warning": return status === "at-risk";
        case "healthy": return status === "on-track" || status === "completed";
        default: return true;
      }
    }).map(r => {
      // Adjust depth and parentKey when top project row is skipped
      if (skipTopProjectRow && topProjectKey) {
        const isTopProjectChild = r.parentKey === topProjectKey;
        return {
          ...r,
          depth: Math.max(0, r.depth - 1),
          parentKey: r.parentKey === topProjectKey ? "" : r.parentKey,
          // Top project children are always visible
          isVisible: isTopProjectChild ? true : r.isVisible,
        };
      }
      return r;
    });
    const filteredRowCount = filteredRows.length;

    // Calculate Y positions for ALL rows (fully expanded state)
    // Each row at index * barHeight
    const filteredRowYPositions: number[] = [];
    for (let i = 0; i < filteredRowCount; i++) {
      filteredRowYPositions.push(i * barHeight);
    }

    // Track visible rows for stripe calculations
    const visibleRows = filteredRows.filter(r => r.isVisible);
    const visibleRowCount = visibleRows.length;

    // Calculate Y positions for visible rows (for stripes and initial collapsed layout)
    const rowYPositions: number[] = [];
    const rowHeights: number[] = [];
    for (let i = 0; i < visibleRowCount; i++) {
      rowYPositions.push(i * barHeight);
      rowHeights.push(barHeight);
    }
    const cumulativeY = visibleRowCount * barHeight;

    // Map collapseKey to visible index (for stripe calculations)
    const visibleIndexMap = new Map<string, number>();
    visibleRows.forEach((row, idx) => visibleIndexMap.set(row.collapseKey, idx));

    // Calculate initial Y for each row (collapsed state)
    // Visible rows: sequential positions
    // Hidden rows: positioned right after their nearest visible ancestor
    const initialYPositions: number[] = [];
    let visibleIdx = 0;
    // Track last visible row's Y for positioning hidden children
    let lastVisibleY = 0;
    // Map parentKey to its visible Y position
    const parentYMap = new Map<string, number>();
    for (let i = 0; i < filteredRowCount; i++) {
      const row = filteredRows[i];
      if (row.isVisible) {
        const y = visibleIdx * barHeight;
        initialYPositions.push(y);
        lastVisibleY = y;
        parentYMap.set(row.collapseKey, y);
        visibleIdx++;
      } else {
        // Hidden rows: position at parent's Y (they're invisible, will be moved on expand)
        const parentY = row.parentKey ? (parentYMap.get(row.parentKey) ?? lastVisibleY) : lastVisibleY;
        initialYPositions.push(parentY);
        // Also register this row's Y in case it has hidden children
        parentYMap.set(row.collapseKey, parentY);
      }
    }

    // Ensure minimum height to fill viewport
    const minContentHeight = 600;
    const contentHeight = Math.max(cumulativeY > 0 ? cumulativeY + barGap : 0, minContentHeight);

    // Pre-calculate visible indices for each row
    const rowVisibleIndices = new Map<string, number>();
    visibleRows.forEach((row, idx) => rowVisibleIndices.set(row.collapseKey, idx));
    const chevronWidth = 10;

    // Generate FULL-HEIGHT group backgrounds (Gestalt "common region" / enclosure)
    // Adaptive grouping strategy:
    // - Multiple projects → group by project (each project + children = one group)
    // - Single project → group by top-level issue families (each depth-1 issue + children = one group)
    interface GroupRange { startIdx: number; endIdx: number; groupIdx: number; }
    const groupRanges: GroupRange[] = [];

    // Determine grouping strategy based on view mode:
    // - "person" mode (By Person): group by projects (multiple unrelated projects)
    // - "project" mode (By Project): group by issue families (focused on one hierarchy)
    const useProjectGrouping = this._viewFocus === "person";

    let currentGroupStart = 0;
    let currentGroupIdx = 0;

    if (useProjectGrouping) {
      // Multiple projects: group by project headers
      for (let i = 0; i < visibleRowCount; i++) {
        const row = visibleRows[i];
        if ((row.type === "project" || row.type === "time-group") && i > 0) {
          groupRanges.push({ startIdx: currentGroupStart, endIdx: i - 1, groupIdx: currentGroupIdx });
          currentGroupStart = i;
          currentGroupIdx++;
        }
      }
    } else {
      // Single project: group by top-level issue families
      // Find the minimum depth among issues (this is the "top level" for this view)
      const issueRows = visibleRows.filter(r => r.type === "issue");
      const minIssueDepth = issueRows.length > 0
        ? Math.min(...issueRows.map(r => r.depth))
        : 1;

      for (let i = 0; i < visibleRowCount; i++) {
        const row = visibleRows[i];
        // New family starts at each top-level issue (at minIssueDepth)
        if (row.type === "issue" && row.depth === minIssueDepth) {
          if (currentGroupStart < i) {
            groupRanges.push({ startIdx: currentGroupStart, endIdx: i - 1, groupIdx: currentGroupIdx });
            currentGroupIdx++;
          }
          currentGroupStart = i;
        }
      }
    }

    // Close final group
    if (visibleRowCount > 0 && currentGroupStart < visibleRowCount) {
      groupRanges.push({ startIdx: currentGroupStart, endIdx: visibleRowCount - 1, groupIdx: currentGroupIdx });
    }

    // Helper to calculate gap before a row (for stripe height calculations)
    const getGapBefore = (_row: typeof visibleRows[0], idx: number): number => {
      if (idx === 0) return rowYPositions[0]; // Gap from top of chart to first row
      // Gap = current row Y - (previous row Y + previous row height)
      return rowYPositions[idx] - (rowYPositions[idx - 1] + rowHeights[idx - 1]);
    };

    // All groups get visual enclosure, alternating between two subtle treatments
    // This creates consistent rhythm without leaving any group "bare"
    const zebraStripes = groupRanges
      .map(g => {
        // Include the gap BEFORE the first row in the zebra stripe
        // This makes the gap visually "belong" to this group
        const firstRow = visibleRows[g.startIdx];
        const gapBeforeFirst = getGapBefore(firstRow, g.startIdx);
        const startY = rowYPositions[g.startIdx] - gapBeforeFirst;
        const endY = rowYPositions[g.endIdx] + rowHeights[g.endIdx];
        const height = endY - startY;
        // Alternate: even groups (including first) = lower alpha, odd groups = higher alpha
        const opacity = g.groupIdx % 2 === 0 ? 0.03 : 0.06;

        // Build row contributions map: { collapseKey: heightContribution }
        // Each row owns gap BEFORE it + its height (not gap AFTER)
        // This ensures collapse correctly removes hidden rows' gaps
        const rowContributions: Record<string, number> = {};
        for (let i = g.startIdx; i <= g.endIdx; i++) {
          const row = visibleRows[i];
          // Gap owned: first row includes stripe-leading gap, others own their preceding gap
          const gapOwned = i === g.startIdx ? gapBeforeFirst : getGapBefore(row, i);
          rowContributions[row.collapseKey] = gapOwned + rowHeights[i];
        }

        return `<rect class="zebra-stripe" x="0" y="${startY}" width="100%" height="${height}" opacity="${opacity}" data-first-row-key="${firstRow.collapseKey}" data-original-y="${startY}" data-original-height="${height}" data-row-contributions='${JSON.stringify(rowContributions)}' />`;
      })
      .join("");

    // Left labels (fixed column) - visible rows only for performance

    // Compute continuous vertical indent guide lines (rendered as single layer)
    // For each parent row, draw ONE continuous line covering ALL descendants (not just direct children)
    const subtreeEndIndex = new Array<number>(visibleRows.length);
    const parentStack: number[] = [];
    for (let i = 0; i < visibleRows.length; i++) {
      const depth = visibleRows[i].depth;
      while (parentStack.length > 0 && depth <= visibleRows[parentStack[parentStack.length - 1]].depth) {
        const idx = parentStack.pop()!;
        subtreeEndIndex[idx] = i - 1;
      }
      parentStack.push(i);
    }
    while (parentStack.length > 0) {
      const idx = parentStack.pop()!;
      subtreeEndIndex[idx] = visibleRows.length - 1;
    }

    const continuousIndentLines: string[] = [];
    for (let i = 0; i < visibleRows.length; i++) {
      const row = visibleRows[i];

      // Only process parent rows (rows that have children)
      if (!row.hasChildren) continue;

      const parentDepth = row.depth;
      const firstDescendantIndex = i + 1;
      if (firstDescendantIndex >= visibleRows.length) continue;
      if (visibleRows[firstDescendantIndex].depth <= parentDepth) continue;
      const lastDescendantIndex = subtreeEndIndex[i];
      if (lastDescendantIndex <= i) continue;

      // Draw line at parent's depth position (guides appear inside children's indent area)
      const lineX = 8 + parentDepth * indentSize;
      const startY = rowYPositions[firstDescendantIndex];
      const endY = rowYPositions[lastDescendantIndex] + barHeight;

      continuousIndentLines.push(
        `<line class="indent-guide-line" data-for-parent="${row.collapseKey}" x1="${lineX}" y1="${startY}" x2="${lineX}" y2="${endY}" stroke="var(--vscode-tree-indentGuidesStroke)" stroke-width="1" opacity="0.4"/>`
      );
    }
    const indentGuidesLayer = continuousIndentLines.length > 0
      ? `<g class="indent-guides-layer">${continuousIndentLines.join("")}</g>`
      : "";

    const labels = filteredRows
      .map((row, idx) => {
        const y = initialYPositions[idx];
        const originalY = filteredRowYPositions[idx];
        const hiddenAttr = row.isVisible ? "" : ' visibility="hidden"';
        const hiddenClass = row.isVisible ? "" : " gantt-row-hidden";
        const indent = row.depth * indentSize;

        // VS Code-style chevron: right-pointing arrow that rotates 90deg when expanded
        // Includes larger invisible hit area for easier clicking
        const chevronX = 10 + indent;
        const chevronY = barHeight / 2;
        const hitAreaSize = 18;
        const chevron = row.hasChildren
          ? `<g class="collapse-toggle user-select-none${row.isExpanded ? " expanded" : ""}" transform-origin="${chevronX} ${chevronY}"><rect x="${chevronX - hitAreaSize / 2}" y="${chevronY - hitAreaSize / 2}" width="${hitAreaSize}" height="${hitAreaSize}" fill="transparent" class="chevron-hit-area"/><path d="M${chevronX - 3},${chevronY - 4} L${chevronX + 2},${chevronY} L${chevronX - 3},${chevronY + 4}" fill="none" stroke="var(--vscode-foreground)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></g>`
          : "";
        // Always reserve space for chevron to align text regardless of hasChildren
        const textOffset = chevronWidth;

        if (row.type === "project") {
          // Project header row with health indicators
          const health = row.health;
          const healthDot = health ? this.getHealthDot(health.status) : "";
          const labelX = 10 + indent + textOffset;

          // Build counts string: "12 open · 2 blocked · 1 overdue"
          let countsStr = "";
          if (health && health.counts.total > 0) {
            const parts: string[] = [`${health.counts.open} open`];
            if (health.counts.blocked > 0) parts.push(`${health.counts.blocked} blocked`);
            if (health.counts.overdue > 0) parts.push(`${health.counts.overdue} overdue`);
            countsStr = parts.join(" · ");
          }

          // Progress bar (thin inline)
          const progressBarWidth = 40;
          const progressBarHeight = 4;
          const progressBarX = labelX + escapeHtml(row.label).length * 7 + 24; // After label + health dot
          const progressBarY = barHeight / 2 - progressBarHeight / 2;
          const progressFillWidth = health ? (health.progress / 100) * progressBarWidth : 0;
          const progressBar = health && health.counts.total > 0 ? `
            <rect x="${progressBarX}" y="${progressBarY}" width="${progressBarWidth}" height="${progressBarHeight}" rx="2" fill="var(--vscode-progressBar-background)" opacity="0.3"/>
            <rect x="${progressBarX}" y="${progressBarY}" width="${progressFillWidth}" height="${progressBarHeight}" rx="2" fill="var(--vscode-progressBar-foreground)"/>
            <text x="${progressBarX + progressBarWidth + 4}" y="${barHeight / 2 + 4}" fill="var(--vscode-descriptionForeground)" font-size="10">${health.progress}%</text>
          ` : "";

          // Counts text position (after progress bar)
          const countsX = progressBarX + progressBarWidth + 30;
          const countsText = countsStr ? `<text x="${countsX}" y="${barHeight / 2 + 4}" fill="var(--vscode-descriptionForeground)" font-size="10">${countsStr}</text>` : "";

          // Tooltip: project details aligned with tree view
          const tooltip = this.buildProjectTooltip(row);

          // De-emphasized project headers: regular weight, muted color
          // Projects are containers, not content - issues should be primary focus
          return `
            <g class="project-label gantt-row cursor-pointer${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-project-id="${row.id}" data-expanded="${row.isExpanded}" data-has-children="${row.hasChildren}" data-original-y="${originalY}" data-tooltip="${escapeAttr(tooltip)}" data-vscode-context='${escapeAttr(JSON.stringify({ webviewSection: "projectLabel", projectId: row.id, projectIdentifier: row.identifier || "", preventDefaultContextMenuItems: true }))}' transform="translate(0, ${y})"${hiddenAttr} tabindex="0" role="button" aria-label="Toggle project ${escapeHtml(row.label)}">
              <rect class="row-hit-area" x="0" y="-1" width="100%" height="${barHeight + 2}" fill="transparent" pointer-events="all"/>
              ${chevron}
              <text x="${labelX}" y="${barHeight / 2 + 5}" fill="var(--vscode-descriptionForeground)" font-size="13" pointer-events="none">
                ${healthDot}${escapeHtml(row.label)}
              </text>
              ${progressBar}
              ${countsText}
            </g>
          `;
        }

        if (row.type === "time-group") {
          // Time group header row (Overdue, Due This Week, etc.)
          const timeGroupClass = `time-group-${row.timeGroup}`;
          const countBadge = row.childCount ? ` (${row.childCount})` : "";
          return `
            <g class="time-group-label gantt-row ${timeGroupClass}${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-time-group="${row.timeGroup}" data-expanded="${row.isExpanded}" data-has-children="${row.hasChildren}" data-original-y="${originalY}" data-tooltip="${escapeAttr(row.label)}" transform="translate(0, ${y})"${hiddenAttr} tabindex="0" role="button" aria-label="Toggle ${escapeHtml(row.label)}">
              <rect class="row-hit-area" x="0" y="-1" width="100%" height="${barHeight + 2}" fill="transparent" pointer-events="all"/>
              ${chevron}
              <text x="${10 + indent + textOffset}" y="${barHeight / 2 + 5}" fill="var(--vscode-foreground)" font-size="13" font-weight="bold" pointer-events="none">
                ${row.icon || ""} ${escapeHtml(row.label)}${countBadge}
              </text>
            </g>
          `;
        }

        // Issue row
        const issue = row.issue!;
        const escapedSubject = escapeHtml(issue.subject);
        const escapedProject = escapeHtml(issue.project);

        // Get status description and flexibility for consolidated tooltip
        // Closed issues always show as "completed" regardless of calculated flexibility
        const leftEffectiveStatus = issue.isClosed ? "completed" : issue.status;
        const leftStatusDesc = this._getStatusDescription(leftEffectiveStatus);
        const leftFlexPct = issue.flexibilityPercent;
        const leftFlexText = leftFlexPct === null ? null
          : leftFlexPct > 0 ? `Flexibility: +${leftFlexPct}%`
          : leftFlexPct === 0 ? `Flexibility: 0% (no buffer)`
          : `Flexibility: ${leftFlexPct}%`;

        // Build consolidated tooltip with all info
        const tooltipLines = [
          issue.isAdHoc ? "🎲 AD-HOC BUDGET POOL" : null,
          issue.isExternal ? "⚡ EXTERNAL DEPENDENCY" : null,
          leftStatusDesc,
          `#${issue.id} ${escapedSubject}`,
          `Project: ${escapedProject}`,
          issue.isExternal ? `Assigned to: ${issue.assignee ?? "Unassigned"}` : null,
          `Start: ${formatDateWithWeekday(issue.start_date)}`,
          `Due: ${formatDateWithWeekday(issue.due_date)}`,
          `Progress: ${issue.done_ratio ?? 0}%`,
          `Estimated: ${formatHoursAsTime(issue.estimated_hours)}`,
        ];

        // Check for contributions
        const isAdHoc = this._contributionData?.adHocIssues.has(issue.id);
        const donated = this._donationTargets?.get(issue.id);
        const received = this._contributionSources?.get(issue.id);

        if (isAdHoc && donated && donated.length > 0) {
          // Ad-hoc issue: show donations
          const donatedDetails = donated.map(d => `  → #${d.toIssueId}: ${formatHoursAsTime(d.hours)}`).join("\n");
          const totalDonated = donated.reduce((sum, d) => sum + d.hours, 0);
          tooltipLines.push(`Spent: ${formatHoursAsTime(issue.spent_hours)}`);
          tooltipLines.push(`Donated: ${formatHoursAsTime(totalDonated)}`);
          tooltipLines.push(donatedDetails);
        } else if (received && received.length > 0) {
          // Normal issue receiving contributions
          const receivedDetails = received.map(r => `  ← #${r.fromIssueId}: ${formatHoursAsTime(r.hours)}`).join("\n");
          const totalReceived = received.reduce((sum, r) => sum + r.hours, 0);
          const directSpent = issue.spent_hours ?? 0;
          tooltipLines.push(`Direct: ${formatHoursAsTime(directSpent)}`);
          tooltipLines.push(`Contributed: +${formatHoursAsTime(totalReceived)}`);
          tooltipLines.push(receivedDetails);
          tooltipLines.push(`Total: ${formatHoursAsTime(directSpent + totalReceived)}`);
        } else {
          tooltipLines.push(`Spent: ${formatHoursAsTime(issue.spent_hours)}`);
        }

        // Add flexibility
        if (leftFlexText) {
          tooltipLines.push(leftFlexText);
        }

        // Add blocks info
        if (issue.blocks.length > 0) {
          tooltipLines.push(`🚧 BLOCKS ${issue.blocks.length} TASK${issue.blocks.length > 1 ? "S" : ""}:`);
          for (const b of issue.blocks.slice(0, 3)) {
            const assigneeText = b.assignee ? ` (${b.assignee})` : "";
            tooltipLines.push(`  → #${b.id} ${b.subject.length > 25 ? b.subject.substring(0, 24) + "…" : b.subject}${assigneeText}`);
          }
          if (issue.blocks.length > 3) {
            tooltipLines.push(`  ... and ${issue.blocks.length - 3} more`);
          }
        }

        // Add blocked-by info
        if (issue.blockedBy.length > 0) {
          tooltipLines.push(`⛔ BLOCKED BY:`);
          for (const b of issue.blockedBy.slice(0, 3)) {
            const assigneeText = b.assignee ? ` (${b.assignee})` : "";
            tooltipLines.push(`  • #${b.id} ${b.subject.length > 25 ? b.subject.substring(0, 24) + "…" : b.subject}${assigneeText}`);
          }
          if (issue.blockedBy.length > 3) {
            tooltipLines.push(`  ... and ${issue.blockedBy.length - 3} more`);
          }
        }

        const tooltip = tooltipLines.filter(Boolean).join("\n");

        // In My Work view, show project badge and external indicator
        const projectBadge = this._viewFocus === "person" && row.projectName
          ? `<tspan fill="var(--vscode-descriptionForeground)" font-size="10">[${escapeHtml(row.projectName)}]</tspan> `
          : "";
        const externalBadge = issue.isExternal
          ? `<tspan fill="var(--vscode-charts-yellow)" font-size="10">(dep)</tspan> `
          : "";

        // Dim closed issues in task column
        const taskOpacity = issue.isClosed ? "0.5" : "1";

        return `
          <g class="issue-label gantt-row cursor-pointer${hiddenClass}" data-issue-id="${issue.id}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-expanded="${row.isExpanded}" data-has-children="${row.hasChildren}" data-original-y="${originalY}" data-tooltip="${escapeAttr(tooltip)}" data-vscode-context='{"webviewSection":"issueBar","issueId":${issue.id},"projectId":${issue.projectId},"hasParent":${issue.parentId !== null},"preventDefaultContextMenuItems":true}' transform="translate(0, ${y})"${hiddenAttr} tabindex="0" role="button" aria-label="Open issue #${issue.id}">
            <rect class="row-hit-area" x="0" y="-1" width="100%" height="${barHeight + 2}" fill="transparent" pointer-events="all"/>
            ${chevron}
            <text class="issue-text" x="${10 + indent + textOffset}" y="${barHeight / 2 + 5}" fill="${issue.isExternal ? "var(--vscode-descriptionForeground)" : "var(--vscode-foreground)"}" font-size="13" opacity="${taskOpacity}">
              ${externalBadge}${projectBadge}${escapedSubject}
            </text>
          </g>
        `;
      })
      .join("");

    // ID column cells
    const idCells = filteredRows
      .map((row, idx) => {
        const y = initialYPositions[idx];
        const originalY = filteredRowYPositions[idx];
        const hiddenAttr = row.isVisible ? "" : ' visibility="hidden"';
        const hiddenClass = row.isVisible ? "" : " gantt-row-hidden";
        if (row.type !== "issue") return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}></g>`;
        const issue = row.issue!;
        return `<g class="gantt-row cursor-pointer${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr} data-vscode-context='{"webviewSection":"issueIdColumn","issueId":${issue.id},"preventDefaultContextMenuItems":true}'>
          <text class="gantt-col-cell" x="${idColumnWidth / 2}" y="${barHeight / 2 + 4}" text-anchor="middle">#${issue.id}</text>
        </g>`;
      })
      .join("");

    // Start date column cells
    const startDateCells = filteredRows
      .map((row, idx) => {
        const y = initialYPositions[idx];
        const originalY = filteredRowYPositions[idx];
        const hiddenAttr = row.isVisible ? "" : ' visibility="hidden"';
        const hiddenClass = row.isVisible ? "" : " gantt-row-hidden";
        if (row.type !== "issue") return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}></g>`;
        const issue = row.issue!;
        if (!issue.start_date) return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}><text class="gantt-col-cell" x="4" y="${barHeight / 2 + 4}" text-anchor="start">—</text></g>`;
        const startDate = parseLocalDate(issue.start_date);
        const displayDate = startDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}>
          <title>${escapeAttr(issue.start_date)}</title>
          <text class="gantt-col-cell" x="4" y="${barHeight / 2 + 4}" text-anchor="start">${displayDate}</text>
        </g>`;
      })
      .join("");

    // Status column cells - colored dots
    const statusCells = filteredRows
      .map((row, idx) => {
        const y = initialYPositions[idx];
        const originalY = filteredRowYPositions[idx];
        const hiddenAttr = row.isVisible ? "" : ' visibility="hidden"';
        const hiddenClass = row.isVisible ? "" : " gantt-row-hidden";
        if (row.type !== "issue") return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}></g>`;
        const issue = row.issue!;
        const statusName = issue.statusName ?? "Unknown";
        // Determine dot color: green=closed (from server is_closed), blue=in progress, gray=not started
        let dotColor = "var(--vscode-descriptionForeground)"; // gray for new/not started
        if (issue.done_ratio === 100 || issue.isClosed) {
          dotColor = "var(--vscode-charts-green)";
        } else if (issue.done_ratio > 0) {
          dotColor = "var(--vscode-charts-blue)";
        }
        const cx = statusColumnWidth / 2;
        const cy = barHeight / 2;
        return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}>
          <title>${escapeAttr(statusName)}</title>
          <circle cx="${cx}" cy="${cy}" r="5" fill="${dotColor}"/>
        </g>`;
      })
      .join("");

    // Due date column cells
    const dueCells = filteredRows
      .map((row, idx) => {
        const y = initialYPositions[idx];
        const originalY = filteredRowYPositions[idx];
        const hiddenAttr = row.isVisible ? "" : ' visibility="hidden"';
        const hiddenClass = row.isVisible ? "" : " gantt-row-hidden";
        if (row.type !== "issue") return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}></g>`;
        const issue = row.issue!;
        if (!issue.due_date) return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}><text class="gantt-col-cell" x="4" y="${barHeight / 2 + 4}" text-anchor="start">—</text></g>`;
        // Format date as MMM DD (e.g., "Jan 15")
        const dueDate = parseLocalDate(issue.due_date);
        const today = getLocalToday();
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const displayDate = `${monthNames[dueDate.getMonth()]} ${dueDate.getDate()}`;
        // Determine if overdue or due soon (closed issues are never overdue)
        const daysUntilDue = Math.floor((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        let dueClass = "";
        let dueTooltip = issue.due_date;
        if (!issue.isClosed && issue.done_ratio < 100 && daysUntilDue < 0) {
          dueClass = "due-overdue";
          dueTooltip = `${issue.due_date} (Overdue by ${Math.abs(daysUntilDue)} day${Math.abs(daysUntilDue) === 1 ? "" : "s"})`;
        } else if (!issue.isClosed && issue.done_ratio < 100 && daysUntilDue <= 3) {
          dueClass = "due-soon";
          dueTooltip = daysUntilDue === 0 ? `${issue.due_date} (Due today)` : `${issue.due_date} (Due in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"})`;
        }
        return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}>
          <title>${escapeAttr(dueTooltip)}</title>
          <text class="gantt-col-cell ${dueClass}" x="4" y="${barHeight / 2 + 4}" text-anchor="start">${displayDate}</text>
        </g>`;
      })
      .join("");

    // Assignee column cells - circular avatar badges with initials
    const assigneeCells = filteredRows
      .map((row, idx) => {
        const y = initialYPositions[idx];
        const originalY = filteredRowYPositions[idx];
        const hiddenAttr = row.isVisible ? "" : ' visibility="hidden"';
        const hiddenClass = row.isVisible ? "" : " gantt-row-hidden";
        if (row.type !== "issue") return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}></g>`;
        const issue = row.issue!;
        if (!issue.assignee) return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}><text class="gantt-col-cell" x="${assigneeColumnWidth / 2}" y="${barHeight / 2 + 4}" text-anchor="middle">—</text></g>`;
        const initials = getInitials(issue.assignee);
        const bgColor = getAvatarColor(issue.assignee);
        const isCurrentUser = issue.assigneeId === this._currentUserId;
        const radius = 9; // Fits in 22px row height
        const cx = assigneeColumnWidth / 2;
        const cy = barHeight / 2;
        return `<g class="gantt-row assignee-badge${isCurrentUser ? " current-user" : ""}${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}>
          <title>${escapeAttr(issue.assignee)}</title>
          <circle cx="${cx}" cy="${cy}" r="${radius}" fill="${bgColor}"/>
          <text x="${cx}" y="${cy + 3}" text-anchor="middle" fill="white" font-size="9" font-weight="600">${escapeHtml(initials)}</text>
        </g>`;
      })
      .join("");

    // Right bars (scrollable timeline) - render all rows for instant toggle
    // Generate bars for all rows (hidden rows have visibility:hidden)
    const bars = filteredRows
      .map((row, idx) => {
        const y = initialYPositions[idx];
        const originalY = filteredRowYPositions[idx];
        const hiddenAttr = row.isVisible ? "" : ' visibility="hidden"';
        const hiddenClass = row.isVisible ? "" : " gantt-row-hidden";

        // Project headers: always render aggregate bars (with visibility class)
        if (row.type === "project") {
          if (!row.childDateRanges || row.childDateRanges.length === 0) {
            return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}></g>`;
          }

          const tooltip = this.buildProjectTooltip(row);
          const tooltipAttr = escapeAttr(tooltip);

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

              return `<rect class="aggregate-bar" x="${startX}" y="${barY}" width="${width}" height="${barContentHeight}"
                            fill="var(--vscode-descriptionForeground)" opacity="0.5" rx="2" ry="2"><title>${tooltipAttr}</title></rect>`;
            })
            .join("");

          return `<g class="aggregate-bars gantt-row${hiddenClass}" data-project-id="${row.id}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" data-tooltip="${escapeAttr(tooltip)}" data-vscode-context='${escapeAttr(JSON.stringify({ webviewSection: "projectLabel", projectId: row.id, projectIdentifier: row.identifier || "", preventDefaultContextMenuItems: true }))}' transform="translate(0, ${y})"${hiddenAttr}><title>${escapeAttr(tooltip)}</title>${aggregateBars}</g>`;
        }

        // Time group headers: render aggregate bars for child issues
        if (row.type === "time-group") {
          if (!row.childDateRanges || row.childDateRanges.length === 0) {
            return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}></g>`;
          }

          // Render aggregate bars for each child issue date range
          const timeGroupColor = row.timeGroup === "overdue" ? "var(--vscode-charts-red)"
            : row.timeGroup === "this-week" ? "var(--vscode-charts-yellow)"
            : row.timeGroup === "later" ? "var(--vscode-charts-green)"
            : "var(--vscode-descriptionForeground)";

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

              return `<rect class="aggregate-bar" x="${startX}" y="${barY}" width="${width}" height="${barContentHeight}"
                            fill="${timeGroupColor}" opacity="0.4" rx="2" ry="2"/>`;
            })
            .join("");

          return `<g class="aggregate-bars time-group-bars gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-time-group="${row.timeGroup}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}>${aggregateBars}</g>`;
        }

        // Skip non-issue types (container nodes, etc.)
        if (row.type !== "issue" || !row.issue) {
          return "";
        }

        const issue = row.issue;
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
        // Closed issues always show as "completed" regardless of calculated flexibility
        const effectiveStatus = issue.isClosed ? "completed" : issue.status;
        const color = isParent ? "var(--vscode-descriptionForeground)" : this._getStatusColor(effectiveStatus);
        const textColor = isParent ? "var(--vscode-editor-foreground)" : this._getStatusTextColor(effectiveStatus);
        const fillOpacity = isParent ? 0.5 : this._getStatusOpacity(effectiveStatus);
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
        // Include contributed hours from ad-hoc issues
        const contributedHours = this._contributionSources?.get(issue.id)?.reduce((sum, c) => sum + c.hours, 0) ?? 0;
        const effectiveSpentHours = (issue.spent_hours ?? 0) + contributedHours;
        let visualDoneRatio = doneRatio;
        let isFallbackProgress = false;
        if (doneRatio === 0 && effectiveSpentHours > 0 && issue.estimated_hours && issue.estimated_hours > 0) {
          visualDoneRatio = Math.min(100, Math.round((effectiveSpentHours / issue.estimated_hours) * 100));
          isFallbackProgress = true;
        }
        const statusDesc = this._getStatusDescription(effectiveStatus);

        // Build tooltip with contribution info
        const flexPct = issue.flexibilityPercent;
        const flexText = flexPct === null ? null
          : flexPct > 0 ? `Flexibility: +${flexPct}%`
          : flexPct === 0 ? `Flexibility: 0% (no buffer)`
          : `Flexibility: ${flexPct}%`;
        // Blocks info (issues waiting on this one)
        const blocksLines: string[] = [];
        if (issue.blocks.length > 0) {
          blocksLines.push(`🚧 BLOCKS ${issue.blocks.length} TASK${issue.blocks.length > 1 ? "S" : ""}:`);
          for (const b of issue.blocks.slice(0, 3)) {
            const assigneeText = b.assignee ? ` (${b.assignee})` : "";
            blocksLines.push(`  → #${b.id} ${b.subject.length > 25 ? b.subject.substring(0, 24) + "…" : b.subject}${assigneeText}`);
          }
          if (issue.blocks.length > 3) {
            blocksLines.push(`  ... and ${issue.blocks.length - 3} more`);
          }
        }
        // Blocker info
        const blockerLines: string[] = [];
        if (issue.blockedBy.length > 0) {
          blockerLines.push(`⛔ BLOCKED BY:`);
          for (const b of issue.blockedBy.slice(0, 3)) {
            const assigneeText = b.assignee ? ` (${b.assignee})` : "";
            blockerLines.push(`  • #${b.id} ${b.subject.length > 25 ? b.subject.substring(0, 24) + "…" : b.subject}${assigneeText}`);
          }
          if (issue.blockedBy.length > 3) {
            blockerLines.push(`  ... and ${issue.blockedBy.length - 3} more`);
          }
        }
        // === Context-sensitive tooltips ===
        // Check for internal estimate, manual %done, and precedence
        const issueInternalEstimate = GanttPanel._globalState
          ? getInternalEstimate(GanttPanel._globalState, issue.id)
          : null;
        const isManualDone = !autoUpdateTracker.isEnabled(issue.id);
        const issuePrecedence = GanttPanel._globalState
          ? hasPrecedence(GanttPanel._globalState, issue.id)
          : false;

        // Bar tooltip: basic info + progress
        const barTooltip = [
          issuePrecedence ? "⏫ PRECEDENCE PRIORITY" : null,
          issue.isAdHoc ? "🎲 AD-HOC BUDGET POOL" : null,
          issue.isExternal ? "⚡ EXTERNAL DEPENDENCY" : null,
          statusDesc,
          `#${issue.id} ${escapedSubject}`,
          `Project: ${escapedProject}`,
          issue.isExternal ? `Assigned to: ${issue.assignee ?? "Unassigned"}` : null,
          `Start: ${formatDateWithWeekday(issue.start_date)}`,
          `Due: ${hasOnlyStart ? "(no due date)" : formatDateWithWeekday(issue.due_date)}`,
          `───`,
          `Progress: ${doneRatio}%${isFallbackProgress ? ` (~${visualDoneRatio}% from time)` : ""}${isManualDone && doneRatio > 0 ? " (manual)" : ""}`,
          `Estimated: ${formatHoursAsTime(issue.estimated_hours)}`,
          issueInternalEstimate
            ? `Remaining: ${formatHoursAsTime(issueInternalEstimate.hoursRemaining)} (internal estimate)`
            : null,
          contributedHours > 0
            ? `Spent: ${formatHoursAsTime(issue.spent_hours)} + ${formatHoursAsTime(contributedHours)} contributed = ${formatHoursAsTime(effectiveSpentHours)}`
            : `Spent: ${formatHoursAsTime(issue.spent_hours)}`,
        ].filter(Boolean).join("\n");

        // Progress badge tooltip
        const progressTooltip = [
          `Progress: ${doneRatio}%${isFallbackProgress ? ` (~${visualDoneRatio}% from time)` : ""}${isManualDone && doneRatio > 0 ? " (manual)" : ""}`,
          `Estimated: ${formatHoursAsTime(issue.estimated_hours)}`,
          issueInternalEstimate ? `Remaining: ${formatHoursAsTime(issueInternalEstimate.hoursRemaining)} (internal)` : null,
          contributedHours > 0
            ? `Spent: ${formatHoursAsTime(issue.spent_hours)} + ${formatHoursAsTime(contributedHours)} contributed`
            : `Spent: ${formatHoursAsTime(issue.spent_hours)}`,
        ].filter(Boolean).join("\n");

        // Flexibility tooltip
        const flexTooltip = flexText || "";

        // Blocks tooltip: issues this one blocks
        const blocksTooltip = issue.blocks.length > 0
          ? `🚧 Blocks ${issue.blocks.length} issue(s):\n` + issue.blocks.slice(0, 5).map(b => {
              const assigneeText = b.assignee ? ` (${b.assignee})` : "";
              return `#${b.id} ${b.subject.length > 30 ? b.subject.substring(0, 29) + "…" : b.subject}${assigneeText}`;
            }).join("\n") + (issue.blocks.length > 5 ? `\n... and ${issue.blocks.length - 5} more` : "") + "\n\nClick to highlight dependencies"
          : "";

        // Blockers tooltip: issues blocking this one
        const blockerTooltip = issue.blockedBy.length > 0
          ? `⛔ Blocked by ${issue.blockedBy.length} issue(s):\n` + issue.blockedBy.slice(0, 5).map(b => {
              const assigneeText = b.assignee ? ` (${b.assignee})` : "";
              return `#${b.id} ${b.subject.length > 30 ? b.subject.substring(0, 29) + "…" : b.subject}${assigneeText}`;
            }).join("\n") + (issue.blockedBy.length > 5 ? `\n... and ${issue.blockedBy.length - 5} more` : "") + "\n\nClick to highlight and jump to blocker"
          : "";

        // Calculate done portion width for progress visualization
        const doneWidth = (visualDoneRatio / 100) * width;

        const handleWidth = 8;

        // Calculate daily intensity for this issue (skip for parent issues - work is in subtasks)
        // Always compute in person view for instant toggle (CSS controls visibility)
        const canShowIntensity = this._viewFocus === "person" && !isParent;
        const intensities = canShowIntensity
          ? (issueScheduleMap.size > 0
              ? getScheduledIntensity(issue, this._schedule, issueScheduleMap)
              : calculateDailyIntensity(issue, this._schedule))
          : [];
        const hasIntensityData = canShowIntensity && intensities.length > 0 && issue.estimated_hours !== null;

        // Generate intensity segments and line chart (always if data exists for instant toggle)
        let intensitySegments = "";
        let intensityLine = "";

        if (hasIntensityData && intensities.length > 0) {
          const dayCount = intensities.length;
          const segmentWidth = width / dayCount;

          // Generate day segments with varying opacity (0-based Y, transform handles positioning)
          // Scale intensity to 0-1 range where 1.5 (max stored) = full opacity
          const maxIntensityForOpacity = 1.5;
          intensitySegments = intensities
            .map((d, i) => {
              const segX = startX + i * segmentWidth;
              // Opacity: base 0.5 + normalized intensity * 0.4 (range 0.5 to 0.9)
              // Higher base ensures bar color stays saturated for text readability
              // Multiply by fillOpacity to respect status-based muting (60-30-10 rule)
              const normalizedForOpacity = Math.min(d.intensity, maxIntensityForOpacity) / maxIntensityForOpacity;
              const opacity = (0.5 + normalizedForOpacity * 0.4) * fillOpacity;
              // clip-path handles corner rounding, no rx/ry needed on segments
              return `<rect x="${segX}" y="${barY}" width="${segmentWidth + 0.5}" height="${barContentHeight}"
                            fill="${color}" opacity="${opacity.toFixed(2)}"/>`;
            })
            .join("");

          // Generate step function path (horizontal line per day, step at boundaries)
          // Scale intensity to 0-1 range where 1.5 (max stored) = full height
          const maxIntensity = 1.5;
          const stepPoints: string[] = [];
          intensities.forEach((d, i) => {
            const dayStartX = startX + i * segmentWidth;
            const dayEndX = startX + (i + 1) * segmentWidth;
            // Line Y: bottom of bar minus normalized intensity * bar content height
            const normalizedIntensity = Math.min(d.intensity, maxIntensity) / maxIntensity;
            const py = barY + barContentHeight - normalizedIntensity * (barContentHeight - 2);
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
               data-subject="${escapedSubject}"
               data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}"
               data-original-y="${originalY}"
               data-start-date="${issue.start_date || ""}"
               data-due-date="${issue.due_date || ""}"
               data-start-x="${startX}" data-end-x="${endX}" data-center-y="${y + barHeight / 2}"
               data-vscode-context='{"webviewSection":"issueBar","issueId":${issue.id},"projectId":${issue.projectId},"hasParent":${issue.parentId !== null},"preventDefaultContextMenuItems":true}'
               transform="translate(0, ${y})"${hiddenAttr}
               tabindex="0" role="button" aria-label="#${issue.id} ${escapedSubject} (parent, ${doneRatio}% done)">
              <title>${escapeAttr(barTooltip + "\n\n(Parent issue - " + doneRatio + "% aggregated progress)")}</title>
              <!-- Invisible hit area for easier hovering -->
              <rect class="parent-hit-area" x="${startX}" y="0" width="${endX - startX}" height="${barHeight}"
                    fill="transparent" pointer-events="all"/>
              <!-- Summary bar: bracket-style with downward arrows at ends -->
              <path class="bar-outline" d="M ${startX + 3} ${barY + barContentHeight * 0.2}
                    L ${startX + 3} ${barY + barContentHeight * 0.8}
                    L ${startX} ${barY + barContentHeight}
                    M ${startX + 3} ${barY + barContentHeight * 0.5}
                    H ${endX - 3}
                    M ${endX - 3} ${barY + barContentHeight * 0.2}
                    L ${endX - 3} ${barY + barContentHeight * 0.8}
                    L ${endX} ${barY + barContentHeight}"
                    fill="none" stroke="${color}" stroke-width="2" opacity="0.8" class="cursor-pointer"/>
              ${doneRatio > 0 ? `
                <!-- Progress line showing done_ratio on parent -->
                <line class="parent-progress" x1="${startX + 3}" y1="${barY + barContentHeight * 0.5}"
                      x2="${startX + 3 + parentDoneWidth}" y2="${barY + barContentHeight * 0.5}"
                      stroke="var(--vscode-charts-green)" stroke-width="2" opacity="0.8"/>
              ` : ""}
              <!-- Status badge for parent (adaptive positioning) -->
              ${(() => {
                const badgeW = doneRatio === 100 ? 32 : doneRatio >= 10 ? 28 : 22;
                const onLeft = endX + badgeW + 16 > timelineWidth;
                const labelX = onLeft ? startX - 8 : endX + 8;
                const badgeCenterX = onLeft ? labelX - badgeW / 2 : labelX + badgeW / 2;
                const parentProgressTip = `Aggregated progress: ${doneRatio}%\n(weighted average of subtasks)`;
                return `<g class="bar-labels${onLeft ? " labels-left" : ""}">
                  <g class="progress-badge-group">
                    <title>${escapeAttr(parentProgressTip)}</title>
                    <rect class="status-badge-bg" x="${onLeft ? labelX - badgeW : labelX}" y="${barY + barContentHeight / 2 - 6}" width="${badgeW}" height="12" rx="2"
                          fill="var(--vscode-badge-background)" opacity="0.9"/>
                    <rect x="${onLeft ? labelX - badgeW : labelX}" y="${barY + barContentHeight / 2 - 6}" width="${badgeW}" height="12" fill="transparent"/>
                    <text class="status-badge" x="${badgeCenterX}" y="${barHeight / 2 + 4}"
                          text-anchor="middle" fill="var(--vscode-badge-foreground)" font-size="10">${doneRatio}%</text>
                  </g>
                </g>`;
              })()}
            </g>
          `;
        }

        // Critical path: zero or negative flexibility
        const isCritical = flexPct !== null && flexPct <= 0 && !issue.isClosed;
        return `
          <g class="issue-bar gantt-row${hiddenClass}${isPast ? " bar-past" : ""}${isOverdue ? " bar-overdue" : ""}${hasOnlyStart ? " bar-open-ended" : ""}${issue.isExternal ? " bar-external" : ""}${issue.isAdHoc ? " bar-adhoc" : ""}${isCritical ? " bar-critical" : ""}" data-issue-id="${issue.id}"
             data-project-id="${issue.projectId}"
             data-subject="${escapedSubject}"
             data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}"
             data-original-y="${originalY}"
             data-start-date="${issue.start_date || ""}"
             data-due-date="${issue.due_date || ""}"
             data-start-x="${startX}" data-end-x="${endX}" data-center-y="${y + barHeight / 2}"
             data-vscode-context='{"webviewSection":"issueBar","issueId":${issue.id},"projectId":${issue.projectId},"hasParent":${issue.parentId !== null},"preventDefaultContextMenuItems":true}'
             transform="translate(0, ${y})"${hiddenAttr}
             tabindex="0" role="button" aria-label="#${issue.id} ${escapedSubject}${isOverdue ? " (overdue)" : ""}">
            <title>${escapeAttr(barTooltip)}</title>
            <!-- Clip path for bar shape -->
            <defs>
              <clipPath id="bar-clip-${issue.id}">
                <rect x="${startX}" y="${barY}" width="${width}" height="${barContentHeight}" rx="6" ry="6"/>
              </clipPath>
            </defs>
            <g clip-path="url(#bar-clip-${issue.id})">
              ${hasIntensityData ? `
                <!-- Intensity segments (visibility controlled via .intensity-enabled on container) -->
                <g class="bar-intensity">${intensitySegments}${intensityLine}</g>
                <!-- Solid bar shown when intensity is off (via CSS) -->
                <rect class="bar-main bar-solid-fallback" x="${startX}" y="${barY}" width="${width}" height="${barContentHeight}"
                      fill="${color}" opacity="${(0.85 * fillOpacity).toFixed(2)}" filter="url(#barShadow)"/>
              ` : `
                <!-- Solid bar when no intensity data available -->
                <rect class="bar-main" x="${startX}" y="${barY}" width="${width}" height="${barContentHeight}"
                      fill="${color}" opacity="${(0.85 * fillOpacity).toFixed(2)}" filter="url(#barShadow)"/>
              `}
              ${hasPastPortion ? `
                <!-- Past portion overlay with diagonal stripes -->
                <rect class="past-overlay" x="${startX}" y="${barY}" width="${pastWidth}" height="${barContentHeight}"
                      fill="url(#past-stripes)"/>
              ` : ""}
              ${visualDoneRatio > 0 && visualDoneRatio < 100 ? `
                <!-- Progress: dim unfilled portion + divider line -->
                <rect class="progress-unfilled" x="${startX + doneWidth}" y="${barY}" width="${width - doneWidth}" height="${barContentHeight}"
                      fill="black" opacity="0.3"/>
                <line class="progress-divider" x1="${startX + doneWidth}" y1="${barY + 1}" x2="${startX + doneWidth}" y2="${barY + barContentHeight - 1}"
                      stroke="white" stroke-width="2" opacity="0.6"/>
              ` : ""}
            </g>
            <!-- Border/outline - pointer-events:all so clicks work even with fill:none -->
            <rect class="bar-outline cursor-move" x="${startX}" y="${barY}" width="${width}" height="${barContentHeight}"
                  fill="none" stroke="var(--vscode-panel-border)" stroke-width="1" rx="6" ry="6" pointer-events="all"/>
            ${(() => {
              // Show subject text on bar if it fits (min 40px width, ~6px per char)
              const padding = 12;
              const availableWidth = width - padding * 2;
              if (availableWidth < 30) return "";
              const maxChars = Math.floor(availableWidth / 6);
              if (maxChars < 3) return "";
              const displaySubject = issue.subject.length > maxChars
                ? issue.subject.substring(0, maxChars - 1) + "…"
                : issue.subject;
              return `<text class="bar-subject" x="${startX + padding}" y="${barY + barContentHeight / 2 + 3}"
                    fill="${textColor}" font-size="9" font-weight="500"
                    pointer-events="none">${escapeHtml(displaySubject)}</text>`;
            })()}
            <rect class="drag-handle drag-left cursor-ew-resize" x="${startX}" y="0" width="${handleWidth}" height="${barHeight}"
                  fill="transparent"/>
            <rect class="drag-handle drag-right cursor-ew-resize" x="${startX + width - handleWidth}" y="0" width="${handleWidth}" height="${barHeight}"
                  fill="transparent"/>
            <!-- Link handle for creating relations (larger hit area for Fitts's Law) -->
            <g class="link-handle cursor-crosshair" data-cx="${endX + 8}" data-cy="${y + barY + barContentHeight / 2}">
              <title>Drag to link</title>
              <circle cx="${endX + 8}" cy="${barY + barContentHeight / 2}" r="12" fill="transparent" pointer-events="all"/>
              <circle class="link-handle-visual" cx="${endX + 8}" cy="${barY + barContentHeight / 2}" r="4"
                      fill="var(--vscode-button-background)" stroke="var(--vscode-button-foreground)"
                      stroke-width="1" pointer-events="none"/>
            </g>
            <!-- Labels outside bar: adaptive positioning (left if near edge, else right) -->
            <!-- Badges: progress, flex, blocks, blocker, assignee -->
            ${(() => {
              // Progress badge width (varies by digit count)
              const progressBadgeW = visualDoneRatio === 100 ? 32 : visualDoneRatio >= 10 ? 28 : 22;
              // Flexibility badge: "+100%", "0%", "-50%" (width varies by digit count)
              const showFlex = flexPct !== null && !issue.isClosed;
              const flexLabelText = showFlex ? (flexPct > 0 ? `+${flexPct}%` : `${flexPct}%`) : "";
              const flexBadgeW = showFlex ? (Math.abs(flexPct) >= 100 ? 38 : Math.abs(flexPct) >= 10 ? 32 : 26) : 0;
              const flexLabel = flexLabelText;
              const flexColor = showFlex
                ? (flexPct >= 50 ? "var(--vscode-charts-green)"
                  : flexPct > 0 ? "var(--vscode-charts-yellow)"
                  : "var(--vscode-charts-red)")
                : "";
              // Blocks badge: "🚧3" for tasks blocked by this (only show if >0)
              const blocksCount = issue.blocks.length;
              const showBlocks = blocksCount > 0 && !issue.isClosed;
              const impactBadgeW = showBlocks ? 26 : 0;
              const impactLabel = showBlocks ? `🚧${blocksCount}` : "";
              const impactColor = showBlocks
                ? (blocksCount >= 5 ? "var(--vscode-charts-red)"
                  : blocksCount >= 2 ? "var(--vscode-charts-orange)"
                  : "var(--vscode-descriptionForeground)")
                : "";
              // Blocker badge: "⛔1" for blocked issues (clickable)
              const blockerCount = issue.blockedBy.length;
              const showBlocker = blockerCount > 0 && !issue.isClosed;
              const blockerBadgeW = showBlocker ? 26 : 0;
              const blockerLabel = showBlocker ? `⛔${blockerCount}` : "";
              const firstBlockerId = showBlocker ? issue.blockedBy[0].id : null;
              const assigneeW = issue.assignee ? 90 : 0;
              // Total width: progress + flex + blocks + blocker + assignee + spacing
              const totalLabelW = progressBadgeW + flexBadgeW + impactBadgeW + blockerBadgeW + assigneeW + 24;
              const onLeft = endX + totalLabelW > timelineWidth;
              const labelX = onLeft ? startX - 8 : endX + 16;

              // For closed issues, show checkmark with simple tooltip
              if (issue.isClosed) {
                const checkBadgeW = 20;
                const checkCenterX = onLeft ? labelX - checkBadgeW / 2 : labelX + checkBadgeW / 2;
                const assigneeX = onLeft ? labelX - checkBadgeW - 4 : labelX + checkBadgeW + 4;
                return `<g class="bar-labels${onLeft ? " labels-left" : ""}">
                  <g class="progress-badge-group">
                    <title>Closed</title>
                    <rect class="status-badge-bg" x="${onLeft ? labelX - checkBadgeW : labelX}" y="${barY + barContentHeight / 2 - 6}" width="${checkBadgeW}" height="12" rx="2"
                          fill="var(--vscode-charts-green)" opacity="0.15"/>
                    <rect x="${onLeft ? labelX - checkBadgeW : labelX}" y="${barY + barContentHeight / 2 - 6}" width="${checkBadgeW}" height="12" fill="transparent"/>
                    <text class="status-badge" x="${checkCenterX}" y="${barHeight / 2 + 4}"
                          text-anchor="middle" fill="var(--vscode-charts-green)" font-size="12">✓</text>
                  </g>
                  ${issue.assignee ? `<g class="bar-assignee-group">
                    <title>${escapeAttr(issue.assignee)}</title>
                    <text class="bar-assignee${issue.assigneeId === this._currentUserId ? " current-user" : ""}" x="${assigneeX}" y="${barHeight / 2 + 4}"
                          text-anchor="${onLeft ? "end" : "start"}" fill="var(--vscode-descriptionForeground)" font-size="11">${escapeHtml(formatShortName(issue.assignee))}</text>
                  </g>` : ""}
                </g>`;
              }

              // Progress badge position: first badge
              const progressCenterX = onLeft ? labelX - progressBadgeW / 2 : labelX + progressBadgeW / 2;
              // Flex badge position: after progress badge
              const flexBadgeX = onLeft ? labelX - progressBadgeW - 4 : labelX + progressBadgeW + 4;
              const flexBadgeCenterX = onLeft ? flexBadgeX - flexBadgeW / 2 : flexBadgeX + flexBadgeW / 2;
              // Impact badge position: after flex badge (or progress if no flex)
              const afterProgressX = showFlex ? flexBadgeX : labelX;
              const afterProgressW = showFlex ? flexBadgeW : progressBadgeW;
              const impactBadgeX = onLeft ? afterProgressX - afterProgressW - 4 : afterProgressX + afterProgressW + 4;
              const impactBadgeCenterX = onLeft ? impactBadgeX - impactBadgeW / 2 : impactBadgeX + impactBadgeW / 2;
              // Blocker badge position: after impact badge (or previous)
              const afterImpactX = showBlocks ? impactBadgeX : afterProgressX;
              const afterImpactW = showBlocks ? impactBadgeW : afterProgressW;
              const blockerBadgeX = onLeft ? afterImpactX - afterImpactW - 4 : afterImpactX + afterImpactW + 4;
              const blockerBadgeCenterX = onLeft ? blockerBadgeX - blockerBadgeW / 2 : blockerBadgeX + blockerBadgeW / 2;
              // Assignee position: after last badge
              const afterBlockerX = showBlocker ? blockerBadgeX : afterImpactX;
              const afterBlockerW = showBlocker ? blockerBadgeW : afterImpactW;
              const assigneeX = onLeft ? afterBlockerX - afterBlockerW - 4 : afterBlockerX + afterBlockerW + 4;
              return `<g class="bar-labels${onLeft ? " labels-left" : ""}">
                <g class="progress-badge-group">
                  <title>${escapeAttr(progressTooltip)}</title>
                  <rect class="status-badge-bg" x="${onLeft ? labelX - progressBadgeW : labelX}" y="${barY + barContentHeight / 2 - 6}" width="${progressBadgeW}" height="12" rx="2"
                        fill="var(--vscode-badge-background)" opacity="0.9"/>
                  <rect x="${onLeft ? labelX - progressBadgeW : labelX}" y="${barY + barContentHeight / 2 - 6}" width="${progressBadgeW}" height="12" fill="transparent"/>
                  <text class="status-badge" x="${progressCenterX}" y="${barHeight / 2 + 4}"
                        text-anchor="middle" fill="var(--vscode-badge-foreground)" font-size="10">${isFallbackProgress ? "~" : ""}${visualDoneRatio}%</text>
                </g>
                ${showFlex ? `<g class="flex-badge-group">
                  <title>${escapeAttr(flexTooltip)}</title>
                  <rect class="flex-badge-bg" x="${onLeft ? flexBadgeX - flexBadgeW : flexBadgeX}" y="${barY + barContentHeight / 2 - 6}" width="${flexBadgeW}" height="12" rx="2"
                        fill="${flexColor}" opacity="0.15"/>
                  <rect x="${onLeft ? flexBadgeX - flexBadgeW : flexBadgeX}" y="${barY + barContentHeight / 2 - 6}" width="${flexBadgeW}" height="12" fill="transparent"/>
                  <text class="flex-badge" x="${flexBadgeCenterX}" y="${barHeight / 2 + 4}"
                        text-anchor="middle" fill="${flexColor}" font-size="10" font-weight="500">${flexLabel}</text>
                </g>` : ""}
                ${showBlocks ? `<g class="blocks-badge-group" style="cursor: pointer;">
                  <title>${escapeAttr(blocksTooltip)}</title>
                  <rect class="blocks-badge-bg" x="${onLeft ? impactBadgeX - impactBadgeW : impactBadgeX}" y="${barY + barContentHeight / 2 - 6}" width="${impactBadgeW}" height="12" rx="2"
                        fill="${impactColor}" opacity="0.15"/>
                  <rect x="${onLeft ? impactBadgeX - impactBadgeW : impactBadgeX}" y="${barY + barContentHeight / 2 - 6}" width="${impactBadgeW}" height="12" fill="transparent"/>
                  <text class="blocks-badge" x="${impactBadgeCenterX}" y="${barHeight / 2 + 4}"
                        text-anchor="middle" fill="${impactColor}" font-size="10" font-weight="500">${impactLabel}</text>
                </g>` : ""}
                ${showBlocker ? `<g class="blocker-badge" data-blocker-id="${firstBlockerId}" style="cursor: pointer;">
                  <title>${escapeAttr(blockerTooltip)}</title>
                  <rect x="${onLeft ? blockerBadgeX - blockerBadgeW : blockerBadgeX}" y="${barY + barContentHeight / 2 - 6}" width="${blockerBadgeW}" height="12" rx="2"
                        fill="var(--vscode-charts-red)" opacity="0.15"/>
                  <rect x="${onLeft ? blockerBadgeX - blockerBadgeW : blockerBadgeX}" y="${barY + barContentHeight / 2 - 6}" width="${blockerBadgeW}" height="12" fill="transparent"/>
                  <text x="${blockerBadgeCenterX}" y="${barHeight / 2 + 4}"
                        text-anchor="middle" fill="var(--vscode-charts-red)" font-size="10" font-weight="500">${blockerLabel}</text>
                </g>` : ""}
                ${issue.assignee ? `<g class="bar-assignee-group">
                  <title>${escapeAttr(issue.assignee)}</title>
                  <text class="bar-assignee${issue.assigneeId === this._currentUserId ? " current-user" : ""}" x="${assigneeX}" y="${barHeight / 2 + 4}"
                        text-anchor="${onLeft ? "end" : "start"}" fill="var(--vscode-descriptionForeground)" font-size="11">${escapeHtml(formatShortName(issue.assignee))}</text>
                </g>` : ""}
              </g>`;
            })()}
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
          ? parseLocalDate(issue.start_date)
          : parseLocalDate(issue.due_date!);
        const end = issue.due_date
          ? parseLocalDate(issue.due_date)
          : parseLocalDate(issue.start_date!);
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
        const y = rowYPositions[idx] + barHeight / 2;
        issuePositions.set(issue.id, { startX, endX, y });
      }
    });

    // Relation type styling - only forward types (reverse types are filtered out)
    // blocks/precedes/relates/duplicates/copied_to are shown
    // blocked/follows/duplicated/copied_from are auto-generated reverses, filtered
    // Colors use CSS classes for VS Code theming; dash patterns differentiate within color groups
    const relationStyles: Record<string, { dash: string; label: string; tip: string }> = {
      blocks: { dash: "", label: "blocks",
        tip: "Target cannot be closed until source is closed" },
      precedes: { dash: "", label: "precedes",
        tip: "Source must complete before target can start" },
      relates: { dash: "4,3", label: "relates to",
        tip: "Simple link (no constraints)" },
      duplicates: { dash: "2,2", label: "duplicates",
        tip: "Closing target auto-closes source" },
      copied_to: { dash: "6,2", label: "copied to",
        tip: "Source was copied to create target" },
      // Extended scheduling types (requires Gantt plugin)
      finish_to_start: { dash: "4,2", label: "FS",
        tip: "Finish-to-Start: Target starts after source finishes" },
      start_to_start: { dash: "4,2", label: "SS",
        tip: "Start-to-Start: Target starts when source starts" },
      finish_to_finish: { dash: "4,2", label: "FF",
        tip: "Finish-to-Finish: Target finishes when source finishes" },
      start_to_finish: { dash: "2,4", label: "SF",
        tip: "Start-to-Finish: Target finishes when source starts" },
    };

    // Use rows (which have GanttIssue) for dependency arrows - only for visible projects
    const visibleRelTypes = this._visibleRelationTypes;
    const dependencyArrows = rows
      .filter((row): row is GanttRow & { issue: GanttIssue } => row.type === "issue" && !!row.issue)
      .flatMap((row) =>
        row.issue.relations
          .filter((rel) => visibleRelTypes.has(rel.type))
          .map((rel) => {
          const issue = row.issue;
          const source = issuePositions.get(issue.id);
          const target = issuePositions.get(rel.targetId);
          if (!source || !target) return "";

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
          const r = 4; // corner radius for rounded turns

          if (sameRow && goingRight) {
            // Same row, target to right: straight horizontal line
            path = `M ${x1} ${y1} H ${x2 - arrowSize}`;
          } else if (!sameRow && nearlyVertical) {
            // Nearly vertical: S-curve jogs out and back with rounded corners
            const jogX = 20;
            const midY = (y1 + y2) / 2;
            const goingDown = y2 > y1;
            path = `M ${x1} ${y1} H ${x1 + jogX - r}` +
              ` q ${r} 0 ${r} ${goingDown ? r : -r}` +
              ` V ${midY + (goingDown ? -r : r)}` +
              ` q 0 ${goingDown ? r : -r} ${-r} ${goingDown ? r : -r}` +
              ` H ${x2 - jogX + r}` +
              ` q ${-r} 0 ${-r} ${goingDown ? r : -r}` +
              ` V ${y2 + (goingDown ? -r : r)}` +
              ` q 0 ${goingDown ? r : -r} ${r} ${goingDown ? r : -r}` +
              ` H ${x2 - arrowSize}`;
          } else if (goingRight) {
            // Different row, target to right: bend near source, then across
            const bendX = x1 + 8; // bend soon after leaving source
            const goingDown = y2 > y1;
            path = `M ${x1} ${y1} H ${bendX - r}` +
              ` q ${r} 0 ${r} ${goingDown ? r : -r}` +
              ` V ${y2 + (goingDown ? -r : r)}` +
              ` q 0 ${goingDown ? r : -r} ${r} ${goingDown ? r : -r}` +
              ` H ${x2 - arrowSize}`;
          } else if (sameRow) {
            // Same row, target to left: route above with rounded corners
            const gap = 12;
            const routeY = y1 - barHeight;
            path = `M ${x1} ${y1} V ${routeY + r}` +
              ` q 0 ${-r} ${-r} ${-r}` +
              ` H ${x2 - gap + r}` +
              ` q ${-r} 0 ${-r} ${r}` +
              ` V ${y2} H ${x2 - arrowSize}`;
          } else {
            // Different row, target to left: route through gap with rounded corners
            const gap = 12;
            const midY = (y1 + y2) / 2;
            const goingDown = y2 > y1;
            path = `M ${x1} ${y1} V ${midY + (goingDown ? -r : r)}` +
              ` q 0 ${goingDown ? r : -r} ${-r} ${goingDown ? r : -r}` +
              ` H ${x2 - gap + r}` +
              ` q ${-r} 0 ${-r} ${goingDown ? r : -r}` +
              ` V ${y2} H ${x2 - arrowSize}`;
          }

          // Chevron arrowhead (two angled lines, not filled)
          const arrowHead = `M ${x2 - arrowSize} ${y2 - arrowSize * 0.6} L ${x2} ${y2} L ${x2 - arrowSize} ${y2 + arrowSize * 0.6}`;

          const dashAttr = style.dash ? `stroke-dasharray="${style.dash}"` : "";

          const arrowTooltip = `#${issue.id} ${style.label} #${rel.targetId}\n${style.tip}\n(right-click to delete)`;
          return `
            <g class="dependency-arrow rel-${rel.type} cursor-pointer" data-relation-id="${rel.id}" data-from="${issue.id}" data-to="${rel.targetId}">
              <title>${escapeAttr(arrowTooltip)}</title>
              <!-- Wide invisible hit area for easier clicking -->
              <path class="arrow-hit-area" d="${path}" stroke="transparent" stroke-width="16" fill="none"/>
              <path class="arrow-line" d="${path}" stroke-width="2" fill="none" ${dashAttr}/>
              <path class="arrow-head" d="${arrowHead}" fill="none"/>
            </g>
          `;
        })
      )
      .filter(Boolean)
      .join("");

    // Generate milestone markers (diamond shapes with vertical dashed lines)
    const milestoneMarkers = this._versions
      .filter(v => v.due_date)
      .map(version => {
        const versionDate = parseLocalDate(version.due_date!);
        if (versionDate < minDate || versionDate > maxDate) return "";

        const x = ((versionDate.getTime() - minDate.getTime()) / (maxDate.getTime() - minDate.getTime())) * timelineWidth;
        const diamondSize = 6;
        const truncatedName = version.name.length > 15 ? version.name.substring(0, 14) + "…" : version.name;
        const tooltip = `${version.name}\nDue: ${version.due_date}\n${version.description || ""}`.trim();

        return `
          <g class="milestone-marker" data-version-id="${version.id}">
            <title>${escapeAttr(tooltip)}</title>
            <!-- Vertical dashed line spanning the entire height -->
            <line class="milestone-line" x1="${x}" y1="0" x2="${x}" y2="${contentHeight}"
                  stroke="var(--vscode-charts-purple)" stroke-width="1.5" stroke-dasharray="6,4" opacity="0.6"/>
            <!-- Diamond marker at top of body -->
            <polygon class="milestone-diamond" points="${x},${diamondSize} ${x + diamondSize},${diamondSize * 2} ${x},${diamondSize * 3} ${x - diamondSize},${diamondSize * 2}"
                     fill="var(--vscode-charts-purple)" stroke="var(--vscode-editorWidget-background)" stroke-width="1"/>
            <!-- Rotated label along the line -->
            <text class="milestone-label" x="${x + 4}" y="30" text-anchor="start"
                  fill="var(--vscode-charts-purple)" font-size="10" font-weight="500"
                  transform="rotate(90, ${x + 4}, 30)">${escapeHtml(truncatedName)}</text>
          </g>
        `;
      })
      .filter(Boolean)
      .join("");

    // Generate minimap bars (simplified representation)
    const minimapBarHeight = 5;
    const minimapHeight = 30;
    const minimapBars = rows
      .filter(r => r.type === "issue" && r.issue && (r.issue.start_date || r.issue.due_date))
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
        // Use same status color as main view (closed issues show as completed)
        const minimapEffectiveStatus = issue.isClosed ? "completed" : issue.status;
        const color = this._getStatusColor(minimapEffectiveStatus);
        return { startPct, endPct, classes, color };
      });
    // Calculate aggregate workload with caching (for heatmap)
    // Key includes revision counter + filter to invalidate on data/filter changes
    const filterKey = `${this._currentFilter.assignee}-${this._currentFilter.status}`;
    const workloadCacheKey = `${this._dataRevision}-${this._viewFocus}-${this._selectedAssignee}-${filterKey}-${minDateStr}-${maxDateStr}-${JSON.stringify(this._schedule)}`;
    let workloadMap: Map<string, number>;
    if (this._workloadCache?.key === workloadCacheKey) {
      workloadMap = this._workloadCache.data;
    } else {
      perfStart("calculateAggregateWorkload");
      workloadMap = calculateAggregateWorkload(this._issues, this._schedule, minDate, maxDate);
      perfEnd("calculateAggregateWorkload");
      this._workloadCache = { key: workloadCacheKey, data: workloadMap };
    }

    // Calculate capacity ribbon data (Person view only) with caching
    const capacityZoomLevel = this._zoomLevel as CapacityZoomLevel;
    let capacityData: PeriodCapacity[] = [];
    if (this._viewFocus === "person") {
      const capacityCacheKey = `${this._dataRevision}-${this._viewFocus}-${this._selectedAssignee}-${filterKey}-${minDateStr}-${maxDateStr}-${capacityZoomLevel}-${this._currentUserId}-${JSON.stringify(this._schedule)}`;
      if (this._capacityCache?.key === capacityCacheKey) {
        capacityData = this._capacityCache.data;
      } else {
        perfStart("calculateScheduledCapacityByZoom");
        capacityData = calculateScheduledCapacityByZoom(
          filteredIssues,
          this._schedule,
          minDateStr,
          maxDateStr,
          depGraph,
          internalEstimates,
          capacityZoomLevel,
          this._currentUserId ?? undefined,
          issueMap,
          precedenceIssues,
          this._actualTimeEntries,
          getTodayStr()
        );
        perfEnd("calculateScheduledCapacityByZoom");
        this._capacityCache = { key: capacityCacheKey, data: capacityData };
      }
    }

    // Build capacity ribbon bars (one rect per period showing load status)
    const ribbonHeight = 20;
    const capacityRibbonBars = capacityData.map((period) => {
      // Calculate bar position from period start date
      const startDateObj = new Date(period.startDate + "T00:00:00Z");
      const startX = ((startDateObj.getTime() - minDate.getTime()) / (maxDate.getTime() - minDate.getTime())) * timelineWidth;

      // Calculate bar width from period end date + 1 day (to include the end day)
      const endDateObj = new Date(period.endDate + "T00:00:00Z");
      endDateObj.setUTCDate(endDateObj.getUTCDate() + 1);
      const endX = ((endDateObj.getTime() - minDate.getTime()) / (maxDate.getTime() - minDate.getTime())) * timelineWidth;
      const barWidth = Math.max(2, endX - startX); // Min 2px for visibility

      const fillColor = period.status === "available"
        ? "var(--vscode-charts-green)"
        : period.status === "busy"
          ? "var(--vscode-charts-yellow)"
          : "var(--vscode-charts-red)";
      const opacity = Math.min(0.8, 0.3 + (period.percentage / 200)); // Scale opacity with load

      // Show date range in tooltip for non-day zoom levels
      const dateLabel = period.startDate === period.endDate
        ? period.startDate
        : `${period.startDate} to ${period.endDate}`;

      // Build breakdown for this period (aggregate across days in period)
      const periodBreakdown = new Map<number, { hours: number; project: string }>();
      // Use local dates to match dayScheduleMap keys (which use formatLocalDate)
      const periodStart = parseLocalDate(period.startDate);
      const periodEnd = parseLocalDate(period.endDate);
      for (let d = new Date(periodStart); d <= periodEnd; d.setDate(d.getDate() + 1)) {
        const dateStr = formatLocalDate(d);
        const dayEntries = dayScheduleMap.get(dateStr);
        if (dayEntries) {
          for (const entry of dayEntries) {
            const existing = periodBreakdown.get(entry.issueId);
            if (existing) {
              existing.hours += entry.hours;
            } else {
              periodBreakdown.set(entry.issueId, { hours: entry.hours, project: entry.project });
            }
          }
        }
      }
      // Format breakdown lines (sorted by hours desc, skip 0)
      const breakdownLines = Array.from(periodBreakdown.entries())
        .filter(([, v]) => v.hours > 0)
        .sort((a, b) => b[1].hours - a[1].hours)
        .slice(0, 8) // Limit to 8 issues
        .map(([id, v]) => `  #${id}: ${v.hours.toFixed(1)}h - ${v.project}`);
      const breakdownText = breakdownLines.length > 0
        ? `\n${breakdownLines.join("\n")}${periodBreakdown.size > 8 ? `\n  ... and ${periodBreakdown.size - 8} more` : ""}`
        : "";

      const tooltip = `${dateLabel}: ${period.loadHours.toFixed(1)}h / ${period.capacityHours}h (${period.percentage}%)${breakdownText}\n\nClick to scroll to this date`;

      return `<g class="capacity-day-bar-group" data-date="${period.startDate}" data-date-ms="${startDateObj.getTime()}">
        <title>${escapeAttr(tooltip)}</title>
        <rect class="capacity-day-bar" x="${startX}" y="0" width="${barWidth}" height="${ribbonHeight}" fill="${fillColor}" opacity="${opacity}"/>
      </g>`;
    }).join("");

    // Week boundaries for capacity ribbon (show Monday markers)
    const capacityWeekMarkers: string[] = [];
    if (this._viewFocus === "person") {
      const current = new Date(minDate);
      while (current <= maxDate) {
        if (current.getDay() === 1) { // Monday
          const weekX = ((current.getTime() - minDate.getTime()) / (maxDate.getTime() - minDate.getTime())) * timelineWidth;
          capacityWeekMarkers.push(`<line x1="${weekX}" y1="0" x2="${weekX}" y2="${ribbonHeight}" class="capacity-week-marker"/>`);
        }
        current.setDate(current.getDate() + 1);
      }
    }

    // Today marker for capacity ribbon (use UTC midnight to match minDate/maxDate reference frame)
    const todayUTC = new Date(formatLocalDate(today));
    const capacityTodayX = ((todayUTC.getTime() - minDate.getTime()) / (maxDate.getTime() - minDate.getTime())) * timelineWidth;
    const capacityTodayMarker = this._viewFocus === "person" && capacityTodayX >= 0 && capacityTodayX <= timelineWidth
      ? `<line x1="${capacityTodayX}" y1="0" x2="${capacityTodayX}" y2="${ribbonHeight}" class="capacity-today-marker"/>`
      : "";

    // Date markers split into fixed header and scrollable body
    perfStart("_generateDateMarkers");
    const dateMarkers = this._generateDateMarkers(
      minDate,
      maxDate,
      timelineWidth,
      0,
      this._zoomLevel,
      workloadMap,
      this._showWorkloadHeatmap
    );
    perfEnd("_generateDateMarkers");

    // Calculate today's position for auto-scroll (reuse today from above)
    const todayX =
      ((today.getTime() - minDate.getTime()) /
        (maxDate.getTime() - minDate.getTime())) *
      timelineWidth;
    const todayInRange = todayX >= 0 && todayX <= timelineWidth;

    // Body height matches visible content (no hidden project checkboxes at bottom)
    const bodyHeight = contentHeight;

    const html = `
<div id="loadingOverlay" class="loading-overlay${this._isRefreshing ? " visible" : ""}"><div class="loading-spinner"></div></div>
  <div id="liveRegion" role="status" aria-live="polite" aria-atomic="true" class="sr-only"></div>
    <div class="gantt-header">
    ${(() => {
      // Build title for per-project view: "Client: Project"
      if (this._viewFocus === "project" && this._selectedProjectId) {
        const project = this._projects.find(p => p.id === this._selectedProjectId);
        if (project) {
          const clientName = project.parent?.name;
          if (clientName) {
            return `<div class="gantt-title"><span class="client-name">${escapeHtml(clientName)}:</span> ${escapeHtml(project.name)}</div>`;
          }
          return `<div class="gantt-title">${escapeHtml(project.name)}</div>`;
        }
      }
      return '<div class="gantt-title"></div>';
    })()}
    <div class="gantt-actions" role="toolbar" aria-label="Gantt chart controls">
      <!-- Lookback period -->
      <select id="lookbackSelect" class="toolbar-select" title="Data lookback period">
        <option value="2"${this._lookbackYears === 2 ? " selected" : ""}>2 Years</option>
        <option value="5"${this._lookbackYears === 5 ? " selected" : ""}>5 Years</option>
        <option value="10"${this._lookbackYears === 10 ? " selected" : ""}>10 Years</option>
        <option value=""${this._lookbackYears === null ? " selected" : ""}>All Time</option>
      </select>
      <!-- Zoom -->
      <select id="zoomSelect" class="toolbar-select" title="Zoom level (1-5)">
        <option value="day"${this._zoomLevel === "day" ? " selected" : ""}>Day</option>
        <option value="week"${this._zoomLevel === "week" ? " selected" : ""}>Week</option>
        <option value="month"${this._zoomLevel === "month" ? " selected" : ""}>Month</option>
        <option value="quarter"${this._zoomLevel === "quarter" ? " selected" : ""}>Quarter</option>
        <option value="year"${this._zoomLevel === "year" ? " selected" : ""}>Year</option>
      </select>
      <!-- View -->
      <select id="viewFocusSelect" class="toolbar-select" title="View by (V)">
        <option value="project"${this._viewFocus === "project" ? " selected" : ""}>By Project</option>
        <option value="person"${this._viewFocus === "person" ? " selected" : ""}>By Person</option>
      </select>
      <!-- Context selector -->
      ${this._viewFocus === "project" ? `
      <select id="projectSelector" class="toolbar-select" title="Select project">
        <option value=""${this._selectedProjectId === null ? " selected" : ""}>All Projects</option>
        ${(() => {
          const childrenMap = new Map<number, typeof this._projects>();
          for (const p of this._projects) {
            if (p.parent?.id) {
              if (!childrenMap.has(p.parent.id)) childrenMap.set(p.parent.id, []);
              childrenMap.get(p.parent.id)!.push(p);
            }
          }
          const rootProjects = this._projects.filter(p => !p.parent).sort((a, b) => a.name.localeCompare(b.name));
          const renderProject = (p: typeof this._projects[0], depth = 0): string => {
            const children = (childrenMap.get(p.id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
            const isSelected = p.id === this._selectedProjectId;
            const indent = "\u00A0\u00A0".repeat(depth);
            const option = `<option value="${p.id}"${isSelected ? " selected" : ""}>${indent}${escapeHtml(p.name)}</option>`;
            return option + children.map(c => renderProject(c, depth + 1)).join("");
          };
          return rootProjects.map(p => renderProject(p)).join("");
        })()}
      </select>` : `
      <select id="focusSelector" class="toolbar-select" title="Select person">
        ${this._uniqueAssignees.map(name => {
          const isMe = name === this._currentUserName;
          return `<option value="${escapeHtml(name)}"${this._selectedAssignee === name ? " selected" : ""}>${escapeHtml(name)}${isMe ? " (me)" : ""}</option>`;
        }).join("")}
      </select>`}
      <div class="toolbar-separator"></div>
      <!-- Filters (assignee filter only in project view) -->
      ${this._viewFocus === "project" ? `
      <select id="filterAssignee" class="toolbar-select" title="Filter by assignee">
        <option value="me"${this._currentFilter.assignee === "me" ? " selected" : ""}>My issues</option>
        <option value="any"${this._currentFilter.assignee === "any" ? " selected" : ""}>All assignees</option>
      </select>` : ""}
      <select id="filterStatus" class="toolbar-select" title="Filter by status">
        <option value="open"${this._currentFilter.status === "open" ? " selected" : ""}>Open</option>
        <option value="closed"${this._currentFilter.status === "closed" ? " selected" : ""}>Closed</option>
        <option value="any"${this._currentFilter.status === "any" ? " selected" : ""}>Any status</option>
      </select>
      <!-- Primary actions -->
      <button id="refreshBtn" class="toggle-btn text-btn" title="Refresh (R)">↻</button>
      <button id="todayBtn" class="toggle-btn text-btn" title="${todayInRange ? "Today (T)" : "Today is outside timeline range"}"${todayInRange ? "" : " disabled"}>T</button>
      <!-- Overflow menu -->
      <div class="toolbar-dropdown">
        <button class="toggle-btn text-btn" title="More options">⋮</button>
        <div class="toolbar-dropdown-menu">
          <div class="toolbar-dropdown-menu-inner">
            <div class="toolbar-dropdown-item" id="menuFilterHealth">
              <span class="icon">🏥</span>
              <span>Health: ${this._healthFilter === "all" ? "All" : this._healthFilter}</span>
              <span class="shortcut">F</span>
            </div>
            <div class="toolbar-dropdown-divider"></div>
            <div class="toolbar-dropdown-item${this._showDependencies ? " active" : ""}" id="menuDeps">
              <span class="icon">⤤</span>
              <span>Relations</span>
              <span class="shortcut">D</span>
            </div>
            <div class="toolbar-dropdown-item${this._showWorkloadHeatmap && this._viewFocus === "person" ? " active" : ""}" id="menuHeatmap"${this._viewFocus !== "person" ? " disabled" : ""}>
              <span class="icon">▦</span>
              <span>Heatmap</span>
              <span class="shortcut">H</span>
            </div>
            <div class="toolbar-dropdown-item${this._showCapacityRibbon && this._viewFocus === "person" ? " active" : ""}" id="menuCapacity"${this._viewFocus !== "person" ? " disabled" : ""}>
              <span class="icon">▤</span>
              <span>Capacity</span>
              <span class="shortcut">Y</span>
            </div>
            <div class="toolbar-dropdown-item${this._showIntensity && this._viewFocus === "person" ? " active" : ""}" id="menuIntensity"${this._viewFocus !== "person" ? " disabled" : ""}>
              <span class="icon">▥</span>
              <span>Intensity</span>
              <span class="shortcut">I</span>
            </div>
            <div class="toolbar-dropdown-divider"></div>
            <div class="toolbar-dropdown-item" id="menuUndo" disabled>
              <span class="icon">↩</span>
              <span>Undo</span>
              <span class="shortcut">⌘Z</span>
            </div>
            <div class="toolbar-dropdown-item" id="menuRedo" disabled>
              <span class="icon">↪</span>
              <span>Redo</span>
              <span class="shortcut">⌘Y</span>
            </div>
            <div class="toolbar-dropdown-divider"></div>
            <div class="toolbar-dropdown-item" id="menuExpand">
              <span class="icon">+</span>
              <span>Expand all</span>
              <span class="shortcut">E</span>
            </div>
            <div class="toolbar-dropdown-item" id="menuCollapse">
              <span class="icon">−</span>
              <span>Collapse all</span>
              <span class="shortcut">C</span>
            </div>
          </div>
        </div>
      </div>
      <div class="toolbar-separator"></div>
      <div class="help-dropdown">
        <button class="toggle-btn text-btn">?</button>
        <div class="help-tooltip">
            <div class="help-section">
              <div class="help-title">Bar Badges</div>
              <span class="help-item"><span style="color:var(--vscode-charts-green)">+Nd</span> days of slack</span>
              <span class="help-item"><span style="color:var(--vscode-charts-red)">-Nd</span> days late</span>
              <span class="help-item">🚧N blocked by this</span>
              <span class="help-item"><span style="color:var(--vscode-charts-red)">⛔N</span> blockers</span>
              <span class="help-item"><span style="color:var(--vscode-charts-purple)">◆</span> milestone</span>
            </div>
            <div class="help-section">
              <div class="help-title">Relations</div>
              <span class="help-item"><span class="relation-legend-line rel-line-blocks"></span>blocking</span>
              <span class="help-item"><span class="relation-legend-line rel-line-scheduling"></span>scheduling</span>
              <span class="help-item"><span class="relation-legend-line rel-line-informational"></span>informational</span>
            </div>
            <div class="help-section">
              <div class="help-title">Shortcuts</div>
              <span class="help-item"><kbd>1-5</kbd> Zoom</span>
              <span class="help-item"><kbd>V</kbd> View</span>
              <span class="help-item"><kbd>F</kbd> Filter</span>
              <span class="help-item"><kbd>D</kbd> Relations</span>
              <span class="help-item"><kbd>H</kbd> Heatmap</span>
              <span class="help-item"><kbd>Y</kbd> Capacity</span>
              <span class="help-item"><kbd>R</kbd> Refresh</span>
              <span class="help-item"><kbd>T</kbd> Today</span>
              <span class="help-item"><kbd>E</kbd> Expand</span>
              <span class="help-item"><kbd>C</kbd> Collapse</span>
              <span class="help-item"><kbd>B</kbd> Blocked</span>
            </div>
        </div>
      </div>
      <span id="selectionCount" class="selection-count hidden"></span>
    </div>
  </div>
    <div class="gantt-container${this._showIntensity ? " intensity-enabled" : ""}">
    <!-- Wrapper clips horizontal scrollbar -->
    <div class="gantt-scroll-wrapper">
      <div class="gantt-scroll" id="ganttScroll" data-render-key="${this._renderKey}" data-all-expandable-keys='${JSON.stringify(allExpandableKeys)}'>
      <!-- Header row - sticky at top -->
      <div class="gantt-header-row">
        <div class="gantt-sticky-left gantt-corner">
          <div class="gantt-col-status"><div class="gantt-col-header sortable${this._sortBy === "status" ? " sorted" : ""}" data-sort="status">Status${this._sortBy === "status" ? (this._sortOrder === "asc" ? " ▲" : " ▼") : ""}</div></div>
          <div class="gantt-col-id"><div class="gantt-col-header sortable${this._sortBy === "id" ? " sorted" : ""}" data-sort="id">#ID${this._sortBy === "id" ? (this._sortOrder === "asc" ? " ▲" : " ▼") : ""}</div></div>
          <div class="gantt-left-header" id="ganttLeftHeader"><div class="gantt-col-header">Task</div></div>
          <div class="gantt-resize-handle-header" id="resizeHandleHeader"></div>
          <div class="gantt-col-start"><div class="gantt-col-header sortable${this._sortBy === "start" ? " sorted" : ""}" data-sort="start">Start${this._sortBy === "start" ? (this._sortOrder === "asc" ? " ▲" : " ▼") : ""}</div></div>
          <div class="gantt-col-due"><div class="gantt-col-header sortable${this._sortBy === "due" ? " sorted" : ""}" data-sort="due">Due${this._sortBy === "due" ? (this._sortOrder === "asc" ? " ▲" : " ▼") : ""}</div></div>
          <div class="gantt-col-assignee"><div class="gantt-col-header sortable${this._sortBy === "assignee" ? " sorted" : ""}" data-sort="assignee">Who${this._sortBy === "assignee" ? (this._sortOrder === "asc" ? " ▲" : " ▼") : ""}</div></div>
        </div>
        <div class="gantt-timeline-header" id="ganttTimelineHeader">
          <svg width="${timelineWidth}" height="${headerHeight}">
            ${dateMarkers.header}
          </svg>
        </div>
      </div>
      <!-- Capacity ribbon (Person view only) -->
      <div class="capacity-ribbon-row capacity-ribbon${this._viewFocus !== "person" || !this._showCapacityRibbon ? " hidden" : ""}">
        <div class="gantt-sticky-left gantt-corner">
          <div class="capacity-ribbon-label" style="width: ${stickyLeftWidth}px; height: ${ribbonHeight}px;">
            <span class="capacity-legend">
              <span class="capacity-label available">&lt;80%</span>
              <span class="capacity-label busy">80-100%</span>
              <span class="capacity-label overbooked">&gt;100%</span>
            </span>
            Capacity
          </div>
        </div>
        <div class="capacity-ribbon-timeline">
          <svg width="${timelineWidth}" height="${ribbonHeight}">
            ${capacityRibbonBars}
            ${capacityWeekMarkers.join("")}
            ${capacityTodayMarker}
          </svg>
        </div>
      </div>
      <!-- Body -->
      <div class="gantt-body">
        <div class="gantt-sticky-left">
          <div class="gantt-col-status">
            <svg width="${statusColumnWidth}" height="${bodyHeight}">
              ${zebraStripes}
              ${statusCells}
            </svg>
          </div>
          <div class="gantt-col-id">
            <svg width="${idColumnWidth}" height="${bodyHeight}">
              ${zebraStripes}
              ${idCells}
            </svg>
          </div>
          <div class="gantt-labels" id="ganttLabels">
            <svg width="${labelWidth * 2}" height="${bodyHeight}" data-render-key="${this._renderKey}">
              ${zebraStripes}
              ${indentGuidesLayer}
              ${labels}
            </svg>
          </div>
          <div class="gantt-resize-handle" id="resizeHandle"></div>
          <div class="gantt-col-start">
            <svg width="${startDateColumnWidth}" height="${bodyHeight}">
              ${zebraStripes}
              ${startDateCells}
            </svg>
          </div>
          <div class="gantt-col-due">
            <svg width="${dueDateColumnWidth}" height="${bodyHeight}">
              ${zebraStripes}
              ${dueCells}
            </svg>
          </div>
          <div class="gantt-col-assignee">
            <svg width="${assigneeColumnWidth}" height="${bodyHeight}">
              ${zebraStripes}
              ${assigneeCells}
            </svg>
          </div>
        </div>
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
            <g class="dependency-layer${this._showDependencies ? "" : " hidden"}">${dependencyArrows}</g>
            ${bars}
            <g class="milestone-layer">${milestoneMarkers}</g>
            ${dateMarkers.todayMarker}
          </svg>
        </div>
      </div>
    </div>
    </div>
    <!-- Minimap outside scroll, positioned absolutely at bottom of gantt-container -->
    <div class="minimap-container" id="minimapContainer">
      <svg id="minimapSvg" viewBox="0 0 ${timelineWidth} ${minimapHeight}" preserveAspectRatio="none">
        <rect class="minimap-viewport" id="minimapViewport" x="0" y="0" width="100" height="${minimapHeight}"/>
      </svg>
    </div>
  </div>
  <div id="dragDateTooltip" class="drag-date-tooltip" style="display: none;"></div>
  <div id="ganttTooltip" class="gantt-tooltip" role="tooltip" aria-hidden="true">
    <div class="gantt-tooltip-content"></div>
  </div>
  <div id="dragConfirmOverlay" class="drag-confirm-overlay">
    <div class="drag-confirm-modal">
      <h3>Confirm date change</h3>
      <p id="dragConfirmMessage"></p>
      <div class="drag-confirm-buttons">
        <button class="cancel-btn" id="dragConfirmCancel">Cancel</button>
        <button class="confirm-btn" id="dragConfirmOk">Save to Redmine</button>
      </div>
    </div>
  </div>
`;

    const redmineBaseUrl = vscode.workspace.getConfiguration("redmyne").get<string>("serverUrl") || "";
    const renderState: GanttRenderState = {
      timelineWidth,
      minDateMs: minDate.getTime(),
      maxDateMs: maxDate.getTime(),
      totalDays,
      redmineBaseUrl,
      minimapBarsData: minimapBars,
      minimapHeight,
      minimapBarHeight,
      minimapTodayX: Math.round(todayX),
      extScrollLeft: this._scrollPosition.left,
      extScrollTop: this._scrollPosition.top,
      labelWidth,
      leftExtrasWidth: resizeHandleWidth + extraColumnsWidth,
      healthFilter: this._healthFilter,
      sortBy: this._sortBy,
      sortOrder: this._sortOrder,
      selectedCollapseKey: this._selectedCollapseKey,
      barHeight,
      todayX: Math.round(todayX),
      todayInRange,
      headerHeight,
      idColumnWidth,
      startDateColumnWidth,
      statusColumnWidth,
      dueDateColumnWidth,
      assigneeColumnWidth,
      stickyLeftWidth,
      perfDebug: isPerfDebugEnabled(),
    };

    perfEnd("_getRenderPayload", `issues=${this._issues.length}, rows=${filteredRowCount}, days=${totalDays}`);
    return { html, state: renderState };
  }

  private _getEmptyPayload(): GanttRenderPayload {
    const message = "No issues with dates to display. Add start_date or due_date to your issues.";
    const html = `
  <div class="gantt-empty">
    <h2>Timeline</h2>
    <p>${message}</p>
  </div>
`;
    return { html, state: this._getFallbackState() };
  }

  /** Status colors using VS Code theme variables with opacity for 60-30-10 UX rule */
  private static readonly STATUS_COLORS: Record<string, { cssVar: string; darkText: boolean; opacity: number }> = {
    overbooked: { cssVar: "var(--vscode-charts-red)", darkText: false, opacity: 1 },      // Critical (accent)
    "at-risk": { cssVar: "var(--vscode-charts-yellow)", darkText: true, opacity: 1 },     // Warning (accent)
    "on-track": { cssVar: "var(--vscode-charts-blue)", darkText: false, opacity: 0.6 },   // Normal (secondary, muted)
    completed: { cssVar: "var(--vscode-charts-green)", darkText: false, opacity: 1 },     // Done (accent)
    default: { cssVar: "var(--vscode-descriptionForeground)", darkText: false, opacity: 0.5 },
  };

  private _getStatusColor(
    status: FlexibilityScore["status"] | null
  ): string {
    const entry = GanttPanel.STATUS_COLORS[status ?? "default"] ?? GanttPanel.STATUS_COLORS.default;
    return entry.cssVar;
  }

  /** Returns contrasting text color based on background - dark text for yellow, light for others */
  private _getStatusTextColor(
    status: FlexibilityScore["status"] | null
  ): string {
    const entry = GanttPanel.STATUS_COLORS[status ?? "default"] ?? GanttPanel.STATUS_COLORS.default;
    return entry.darkText ? "rgba(0,0,0,0.87)" : "rgba(255,255,255,0.95)";
  }

  /** Returns opacity for status bar fill (muted for normal, full for alerts) */
  private _getStatusOpacity(
    status: FlexibilityScore["status"] | null
  ): number {
    const entry = GanttPanel.STATUS_COLORS[status ?? "default"] ?? GanttPanel.STATUS_COLORS.default;
    return entry.opacity;
  }

  private _getStatusDescription(
    status: FlexibilityScore["status"] | null
  ): string {
    switch (status) {
      case "overbooked":
        return "Overbooked: Not enough time to complete before due date";
      case "at-risk":
        return "At Risk: Tight schedule with little buffer";
      case "on-track":
        return "On Track: Sufficient time remaining";
      case "completed":
        return "Completed: Issue is done";
      default:
        return "";
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
  ): { header: string; body: string; todayMarker: string } {
    const headerContent: string[] = [];
    const heatmapBackgrounds: string[] = [];
    const weekendBackgrounds: string[] = [];
    const bodyGridLines: string[] = [];
    const bodyMarkers: string[] = [];
    let todayMarkerSvg = "";
    let currentPeriodHighlight = "";
    const current = new Date(minDate);
    // Use local today for user's perspective (user expects today = their local date)
    const todayLocal = getTodayStr();

    // Calculate current period range for highlight based on zoom level
    const today = getLocalToday();
    const todayYear = today.getFullYear();
    const todayMonth = today.getMonth();
    const todayQuarter = Math.floor(todayMonth / 3);
    const todayDayOfWeek = today.getDay();

    // Get start of current period (for highlight)
    let periodStart: Date;
    let periodDays: number;
    switch (zoomLevel) {
      case "day":
        periodStart = today;
        periodDays = 1;
        break;
      case "week": {
        // Start of week (Monday)
        periodStart = new Date(today);
        const daysFromMonday = todayDayOfWeek === 0 ? 6 : todayDayOfWeek - 1;
        periodStart.setUTCDate(periodStart.getUTCDate() - daysFromMonday);
        periodDays = 7;
        break;
      }
      case "month":
        periodStart = new Date(Date.UTC(todayYear, todayMonth, 1));
        periodDays = new Date(Date.UTC(todayYear, todayMonth + 1, 0)).getUTCDate();
        break;
      case "quarter": {
        const quarterStartMonth = todayQuarter * 3;
        periodStart = new Date(Date.UTC(todayYear, quarterStartMonth, 1));
        const quarterEndMonth = quarterStartMonth + 3;
        const quarterEnd = new Date(Date.UTC(todayYear, quarterEndMonth, 0));
        periodDays = Math.round((quarterEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
        break;
      }
      case "year":
        periodStart = new Date(Date.UTC(todayYear, 0, 1));
        periodDays = (todayYear % 4 === 0 && (todayYear % 100 !== 0 || todayYear % 400 === 0)) ? 366 : 365;
        break;
    }
    const periodStartStr = formatLocalDate(periodStart);

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

      // Year markers (for year zoom only - quarter zoom includes year in Q label)
      if (zoomLevel === "year" && month === 0 && dayOfMonth === 1 && lastYear !== year) {
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
        const quarterLabel = `Q${quarter} ${year}`;
        headerContent.push(`
          <line x1="${x}" y1="0" x2="${x}" y2="40" class="date-marker"/>
          <text x="${x + 4}" y="14" fill="var(--vscode-foreground)" font-size="11" font-weight="bold">${quarterLabel}</text>
        `);
        bodyGridLines.push(`
          <line x1="${x}" y1="0" x2="${x}" y2="100%" class="day-grid"/>
        `);
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
          // Month zoom: use week gridlines only for even spacing (skip month gridlines in body)
        } else if (zoomLevel === "quarter") {
          // Show all month labels on second line (quarter label is on top line)
          headerContent.push(`
            <text x="${x + 2}" y="30" fill="var(--vscode-descriptionForeground)" font-size="9">${monthLabel}</text>
          `);
          // Quarter zoom: add month gridlines (lighter)
          if (month % 3 !== 0) { // Don't double line on Q boundaries
            bodyGridLines.push(`
              <line x1="${x}" y1="0" x2="${x}" y2="100%" class="day-grid opacity-02"/>
            `);
          }
        } else if (zoomLevel === "year") {
          headerContent.push(`
            <text x="${x + 2}" y="30" fill="var(--vscode-descriptionForeground)" font-size="9">${monthLabel}</text>
          `);
          // Year zoom: add month gridlines
          if (month !== 0) { // Don't double line on Jan 1
            bodyGridLines.push(`
              <line x1="${x}" y1="0" x2="${x}" y2="100%" class="day-grid opacity-02"/>
            `);
          }
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

      // Current period highlight (zoom-level dependent)
      const currentLocal = formatLocalDate(current);
      if (currentLocal === periodStartStr) {
        const highlightWidth = dayWidth * periodDays;
        // Header highlight for current period
        currentPeriodHighlight = `
          <rect x="${x}" y="0" width="${highlightWidth}" height="40" class="today-header-bg"/>
        `;
      }

      // Today marker line (all zoom levels) - always on current day, only in body (not header)
      if (currentLocal === todayLocal) {
        // Separate today-marker for highest z-index (rendered after all bars/milestones)
        todayMarkerSvg = `
          <line x1="${x}" y1="0" x2="${x}" y2="100%" class="today-marker"/>
        `;
      }

      current.setUTCDate(current.getUTCDate() + 1);
    }

    // Wrap backgrounds in groups for CSS-based visibility toggle
    const heatmapGroup = `<g class="heatmap-layer${showHeatmap ? "" : " hidden"}">${heatmapBackgrounds.join("")}</g>`;
    const weekendGroup = `<g class="weekend-layer${showHeatmap ? " hidden" : ""}">${weekendBackgrounds.join("")}</g>`;

    return {
      header: currentPeriodHighlight + headerContent.join(""),
      body: heatmapGroup + weekendGroup + bodyGridLines.join("") + bodyMarkers.join(""),
      todayMarker: todayMarkerSvg,
    };
  }

  /**
   * Get health status dot/emoji for display
   */
  private getHealthDot(status: "green" | "yellow" | "red" | "grey"): string {
    switch (status) {
      case "green": return "🟢 ";
      case "yellow": return "🟡 ";
      case "red": return "🔴 ";
      case "grey": return "⚪ ";
    }
  }

  private normalizeTooltipText(value: string): string {
    return value.replace(/\*\*/g, "").replace(/__/g, "").trim();
  }

  /**
   * Format project tooltip custom fields for display.
   */
  private getProjectCustomFieldLines(customFields?: CustomField[]): string[] {
    const lines: string[] = [];

    if (!customFields) {
      return lines;
    }

    for (const cf of customFields) {
      const label = this.normalizeTooltipText(cf.name ?? "");
      const val = this.normalizeTooltipText(formatCustomFieldValue(cf.value));
      if (label && val) {
        lines.push(`cf:${label}: ${val}`);
      }
    }

    return lines;
  }

  private buildProjectTooltip(row: GanttRow): string {
    const customFieldLines = this.getProjectCustomFieldLines(row.customFields);
    const baseDetails = this.formatProjectTooltip(row.description, customFieldLines);

    let tooltip = `#${row.id} ${row.label}\n\n`;

    if (baseDetails) {
      tooltip += `${baseDetails}\n\n`;
    }

    if (row.health) {
      if (customFieldLines.length > 0) {
        tooltip += "---\n\n";
      }
      tooltip += `${this.formatHealthTooltip(row.health)}\n\n`;
    }

    if (this._server && row.identifier) {
      tooltip += `Open in Browser: ${this._server.options.address}/projects/${row.identifier}`;
    }

    return tooltip.trim();
  }

  /**
   * Format health data as tooltip text
   */
  private formatHealthTooltip(health: ProjectHealth): string {
    const lines: string[] = [];

    lines.push(`${health.progress}% · ${health.counts.closed}/${health.counts.closed + health.counts.open} done`);

    const alerts: string[] = [];
    if (health.counts.overdue > 0) alerts.push(`🔴 ${health.counts.overdue} overdue`);
    if (health.counts.blocked > 0) alerts.push(`⚠ ${health.counts.blocked} blocked`);
    if (health.counts.atRisk > 0) alerts.push(`⏰ ${health.counts.atRisk} at risk`);
    if (alerts.length > 0) {
      lines.push(alerts.join(" · "));
    }

    if (health.hours.estimated > 0) {
      lines.push(`${health.hours.spent}h / ${health.hours.estimated}h`);
    }

    return lines.join("\n");
  }

  /**
   * Format project tooltip without health data (description + custom fields)
   */
  private formatProjectTooltip(description?: string, customFieldLines?: string[]): string {
    const lines: string[] = [];

    if (description?.trim()) {
      lines.push(this.normalizeTooltipText(description));
      lines.push("");
      lines.push("---");
      lines.push("");
    }

    if (customFieldLines) {
      for (const line of customFieldLines) {
        lines.push(line);
        lines.push("");
      }
    }

    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    return lines.join("\n");
  }

  /**
   * Extract IDs of issues that are blocked by unresolved dependencies
   * An issue is blocked if it has a "blocked" or "follows" relation
   * where the blocking issue is not yet closed
   */
  private extractBlockedIds(issues: Issue[]): Set<number> {
    const blockedIds = new Set<number>();
    const closedIds = new Set(
      issues.filter((i) => i.closed_on !== null).map((i) => i.id)
    );

    for (const issue of issues) {
      if (issue.closed_on !== null) continue; // Closed issues aren't blocked

      for (const rel of issue.relations ?? []) {
        // "blocked" means this issue is blocked by issue_to_id
        // "follows" means this issue must wait for issue_to_id
        if (rel.relation_type === "blocked" || rel.relation_type === "follows") {
          // Only blocked if the blocker is not closed
          if (!closedIds.has(rel.issue_to_id)) {
            blockedIds.add(issue.id);
            break; // One blocker is enough
          }
        }
      }
    }

    return blockedIds;
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}






