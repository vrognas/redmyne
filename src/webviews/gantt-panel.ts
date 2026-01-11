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
import { buildProjectHierarchy, buildResourceHierarchy, flattenHierarchyAll, FlatNodeWithVisibility, HierarchyNode } from "../utilities/hierarchy-builder";
import { ProjectHealth } from "../utilities/project-health";
import { DependencyGraph, buildDependencyGraph, countDownstream, getDownstream, getBlockers } from "../utilities/dependency-graph";
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
import { IssueFilter, DEFAULT_ISSUE_FILTER, GanttViewMode } from "../redmine/models/common";
import { parseLocalDate, getLocalToday, formatLocalDate } from "../utilities/date-utils";

/** Get today's date as YYYY-MM-DD string */
const getTodayStr = (): string => formatLocalDate(getLocalToday());

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
  /** Redmine status name (e.g., "New", "In Progress", "Closed") */
  statusName: string;
  /** Flexibility slack in days (positive = buffer, 0/negative = critical) */
  flexibilitySlack: number | null;
  isClosed: boolean;
  project: string;
  projectId: number;
  parentId: number | null;
  estimated_hours: number | null;
  spent_hours: number | null;
  done_ratio: number;
  relations: GanttRelation[];
  assignee: string | null;
  assigneeId: number | null;
  /** True for external dependencies (blockers not assigned to me) */
  isExternal?: boolean;
  /** Count of issues that depend on this (transitively) */
  downstreamCount: number;
  /** Open issues blocked by this one (direct) */
  blocks: Array<{ id: number; subject: string; assignee: string | null }>;
  /** Open issues blocking this one */
  blockedBy: Array<{ id: number; subject: string; assignee: string | null }>;
  /** True if this issue is tagged as an ad-hoc budget pool */
  isAdHoc?: boolean;
  /** Priority name from Redmine */
  priorityName: string;
  /** Priority ID for filtering/sorting */
  priorityId: number;
}

interface GanttRow {
  type: "project" | "issue" | "time-group";
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
  /** Project name for My Work view (shown as badge) */
  projectName?: string;
  /** Time group category for My Work view */
  timeGroup?: "overdue" | "this-week" | "later" | "no-date";
  /** Icon for time-group headers */
  icon?: string;
  /** Child count for group headers */
  childCount?: number;
  /** Project health metrics (for project rows) */
  health?: ProjectHealth;
  /** Project description (for project rows) */
  description?: string;
  /** Project identifier (for project rows) */
  identifier?: string;
}


/**
 * Convert Issue to GanttIssue for SVG rendering
 */
function toGanttIssue(
  issue: Issue,
  flexibilityCache: Map<number, FlexibilityScore | null>,
  closedStatusIds: Set<number>,
  depGraph: DependencyGraph | null,
  issueMap: Map<number, Issue> | null,
  isExternal = false
): GanttIssue {
  // Check if closed via status ID, or fallback to status name containing "closed"
  const isClosedById = closedStatusIds.has(issue.status?.id ?? 0);
  const isClosedByName = issue.status?.name?.toLowerCase().includes("closed") ?? false;
  const flexibility = flexibilityCache.get(issue.id);

  // Calculate downstream impact and blockers if graph available
  const downstreamCount = depGraph ? countDownstream(issue.id, depGraph) : 0;
  const blockedIssues = depGraph && issueMap
    ? getDownstream(issue.id, depGraph, issueMap).map(b => ({
        id: b.id,
        subject: b.subject,
        assignee: b.assignee,
      }))
    : [];
  const blockers = depGraph && issueMap
    ? getBlockers(issue.id, depGraph, issueMap).map(b => ({
        id: b.id,
        subject: b.subject,
        assignee: b.assignee,
      }))
    : [];

  return {
    id: issue.id,
    subject: issue.subject,
    start_date: issue.start_date || null,
    due_date: issue.due_date || null,
    status: flexibility?.status ?? null,
    statusName: issue.status?.name ?? "Unknown",
    // Calculate days of slack: daysRemaining - (hoursRemaining / 8)
    // This gives actual buffer in working days, not percentage
    flexibilitySlack: flexibility
      ? Math.round(flexibility.daysRemaining - flexibility.hoursRemaining / 8)
      : null,
    isClosed: isClosedById || isClosedByName,
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
    assigneeId: issue.assigned_to?.id ?? null,
    isExternal,
    downstreamCount,
    blocks: blockedIssues,
    blockedBy: blockers,
    isAdHoc: adHocTracker.isAdHoc(issue.id),
    priorityName: issue.priority?.name ?? "Unknown",
    priorityId: issue.priority?.id ?? 0,
  };
}

/**
 * Convert FlatNodeWithVisibility to GanttRow for SVG rendering
 */
function nodeToGanttRow(
  node: FlatNodeWithVisibility,
  flexibilityCache: Map<number, FlexibilityScore | null>,
  closedStatusIds: Set<number>,
  depGraph: DependencyGraph | null,
  issueMap: Map<number, Issue> | null
): GanttRow {
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
      health: node.health,
      description: node.description,
      identifier: node.identifier,
    };
  }

  if (node.type === "time-group") {
    return {
      type: "time-group",
      id: node.id,
      label: node.label,
      depth: node.depth,
      collapseKey: node.collapseKey,
      parentKey: node.parentKey,
      hasChildren: node.children.length > 0,
      childDateRanges: node.childDateRanges,
      isVisible: node.isVisible,
      isExpanded: node.isExpanded,
      timeGroup: node.timeGroup,
      icon: node.icon,
      childCount: node.childCount,
    };
  }

  // Container nodes (orphan issue placeholders) render like projects
  if (node.type === "container") {
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
    issue: toGanttIssue(issue, flexibilityCache, closedStatusIds, depGraph, issueMap, node.isExternal),
    isParent: node.children.length > 0,
    collapseKey: node.collapseKey,
    parentKey: node.parentKey,
    hasChildren: node.children.length > 0,
    isVisible: node.isVisible,
    isExpanded: node.isExpanded,
    projectName: node.projectName,
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
    .replace(/'/g, "&#39;")
    .replace(/\\/g, "&#92;")
    .replace(/`/g, "&#96;")
    .replace(/\$/g, "&#36;");
}

/** Escape string for use in HTML attribute (also escapes newlines) */
function escapeAttr(str: string): string {
  return escapeHtml(str).replace(/\n/g, "&#10;");
}

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
const VIEW_MODE_KEY = "redmine.gantt.viewMode";
const VIEW_FOCUS_KEY = "redmine.gantt.viewFocus";
const SELECTED_PROJECT_KEY = "redmine.gantt.selectedProject";
const SELECTED_ASSIGNEE_KEY = "redmine.gantt.selectedAssignee";
const FILTER_ASSIGNEE_KEY = "redmine.gantt.filterAssignee";
const FILTER_STATUS_KEY = "redmine.gantt.filterStatus";
const FILTER_HEALTH_KEY = "redmine.gantt.filterHealth";
const LOOKBACK_YEARS_KEY = "redmine.gantt.lookbackYears";

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
  private _dependencyIssues: Issue[] = []; // External scheduling dependencies
  private _issueById: Map<number, Issue> = new Map(); // O(1) lookup cache
  private _projects: RedmineProject[] = [];
  private _versions: Version[] = []; // Milestones across all projects
  private _flexibilityCache: Map<number, FlexibilityScore | null> = new Map();
  private _server: RedmineServer | undefined;
  private _zoomLevel: ZoomLevel = "month";
  private _schedule: WeeklySchedule = DEFAULT_WEEKLY_SCHEDULE;
  private _showWorkloadHeatmap: boolean = false;
  private _showDependencies: boolean = true;
  private _showIntensity: boolean = false;
  private _scrollPosition: { left: number; top: number } = { left: 0, top: 0 };
  private _extendedRelationTypes: boolean = false;
  private _visibleRelationTypes: Set<string> = new Set(["blocks", "precedes"]);
  private _closedStatusIds: Set<number> = new Set();
  private _debouncedCollapseUpdate: DebouncedFunction<() => void>;
  private _cachedHierarchy?: HierarchyNode[];
  private _collapseState = new CollapseStateManager(); // Gantt-specific collapse state (independent from tree view)
  private _renderKey = 0; // Incremented on each render to force SVG re-creation
  private _isRefreshing = false; // Show loading overlay during data refresh
  private _contributionsLoading = false; // Prevent duplicate contribution fetches
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

  private constructor(panel: vscode.WebviewPanel, server?: RedmineServer) {
    this._panel = panel;
    this._server = server;
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
    const rowCount = 10;
    const idColumnWidth = 50;
    const startDateColumnWidth = 58;
    const statusColumnWidth = 50; // Colored dot + header text
    const dueDateColumnWidth = 58;
    const assigneeColumnWidth = 40;

    // Generate skeleton rows
    const skeletonRows = Array.from({ length: rowCount }, (_, i) => {
      const y = i * (barHeight + barGap);
      const isProject = i % 3 === 0;
      const indent = isProject ? 0 : 16;
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
        <circle cx="${assigneeColumnWidth / 2}" cy="${r.y + barHeight / 2}" r="12" fill="var(--vscode-panel-border)"/>
      </g>
    `).join("");

    const zebraStripes = skeletonRows
      .filter((_, i) => i % 2 === 1)
      .map(r => `<rect x="0" y="${r.y}" width="100%" height="${barHeight + barGap}" fill="var(--vscode-list-hoverBackground)" opacity="0.15"/>`)
      .join("");

    const bodyHeight = rowCount * (barHeight + barGap);

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
      padding: 8px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: 13px;
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .gantt-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      flex-shrink: 0;
    }
    .gantt-title {
      font-size: 14px;
      font-weight: 500;
      color: var(--vscode-foreground);
    }
    .gantt-actions {
      display: flex;
      gap: 4px;
      align-items: center;
    }
    .toolbar-separator {
      width: 1px;
      height: 20px;
      background: var(--vscode-panel-border);
      margin: 0 8px;
      flex-shrink: 0;
    }
    .toggle-btn {
      padding: 4px;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
    }
    .toggle-btn:disabled { opacity: 0.5; cursor: default; }
    .toolbar-select {
      padding: 2px 6px;
      border: 1px solid var(--vscode-dropdown-border);
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border-radius: 2px;
      font-size: 13px;
    }
    .toolbar-select:disabled { opacity: 0.5; }
    .gantt-container {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 2px;
      flex-grow: 1;
      min-height: 0;
    }
    .gantt-header-row {
      display: flex;
      flex-shrink: 0;
      height: ${headerHeight}px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .gantt-left-header {
      flex-shrink: 0;
      width: ${labelWidth}px;
      display: flex;
      align-items: center;
      padding: 4px 8px;
      gap: 4px;
      box-sizing: border-box;
    }
    .gantt-resize-handle-header {
      width: 10px;
      background: var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .gantt-col-id, .gantt-col-start, .gantt-col-status, .gantt-col-due, .gantt-col-assignee {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border-right: 1px solid var(--vscode-panel-border);
      box-sizing: border-box;
      overflow: hidden;
    }
    .gantt-col-id { width: ${idColumnWidth}px; }
    .gantt-col-start { width: ${startDateColumnWidth}px; }
    .gantt-col-status { width: ${statusColumnWidth}px; }
    .gantt-col-due { width: ${dueDateColumnWidth}px; }
    .gantt-col-assignee { width: ${assigneeColumnWidth}px; }
    .gantt-col-header {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .gantt-left-header .gantt-col-header,
    .gantt-col-start .gantt-col-header,
    .gantt-col-due .gantt-col-header { justify-content: flex-start; padding-left: 4px; }
    .gantt-timeline-header {
      flex-grow: 1;
      display: flex;
      align-items: center;
    }
    .loading-text {
      font-size: 11px;
      opacity: 0.7;
      animation: pulse 1.5s ease-in-out infinite;
    }
    .gantt-body-scroll {
      display: flex;
      flex-grow: 1;
      overflow: hidden;
    }
    .gantt-body-scroll .gantt-col-id,
    .gantt-body-scroll .gantt-col-start,
    .gantt-body-scroll .gantt-col-status,
    .gantt-body-scroll .gantt-col-due,
    .gantt-body-scroll .gantt-col-assignee {
      align-items: flex-start;
    }
    .gantt-checkboxes {
      display: none; /* Removed: now viewing one project/person at a time */
    }
    .gantt-labels {
      flex-shrink: 0;
      width: ${labelWidth}px;
      background: var(--vscode-editor-background);
      box-sizing: border-box;
      overflow: hidden;
    }
    .gantt-resize-handle {
      width: 10px;
      background: var(--vscode-panel-border);
      flex-shrink: 0;
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
    .delay-0 { animation-delay: 0s; }
    .delay-1 { animation-delay: 0.1s; }
    .delay-2 { animation-delay: 0.2s; }
    .delay-3 { animation-delay: 0.3s; }
    .delay-4 { animation-delay: 0.4s; }
    .delay-5 { animation-delay: 0.5s; }
    .delay-6 { animation-delay: 0.6s; }
    .delay-7 { animation-delay: 0.7s; }
    .minimap-container {
      height: 44px;
      flex-shrink: 0;
      background: var(--vscode-minimap-background, var(--vscode-editor-background));
      border-top: 1px solid var(--vscode-panel-border);
    }
  </style>
</head>
<body>
  <div class="gantt-header">
    <div class="gantt-title"></div>
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
    <div class="gantt-header-row">
      <div class="gantt-col-status"><div class="gantt-col-header">Status</div></div>
      <div class="gantt-col-id"><div class="gantt-col-header">#ID</div></div>
      <div class="gantt-left-header"><div class="gantt-col-header">Task</div></div>
      <div class="gantt-resize-handle-header"></div>
      <div class="gantt-col-start"><div class="gantt-col-header">Start</div></div>
      <div class="gantt-col-due"><div class="gantt-col-header">Due</div></div>
      <div class="gantt-col-assignee"><div class="gantt-col-header">Who</div></div>
      <div class="gantt-timeline-header">
        <span class="loading-text">Loading issues...</span>
      </div>
    </div>
    <div class="gantt-body-scroll">
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
      <div class="gantt-labels">
        <svg width="${labelWidth}" height="${bodyHeight}">
          ${zebraStripes}
          ${labelsSvg}
        </svg>
      </div>
      <div class="gantt-resize-handle"></div>
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
      <div class="gantt-timeline">
        <svg width="100%" height="${bodyHeight}">
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
    filter?: IssueFilter,
    dependencyIssues?: Issue[],
    server?: RedmineServer
  ): Promise<void> {
    // Update server if provided (for restored panels)
    if (server) {
      this._server = server;
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

    // Load contributions if any ad-hoc issues exist
    this._loadContributions();

    // Load versions (milestones) - skip in person mode (not relevant)
    if (this._viewFocus !== "person") {
      this._loadVersions();
    }
  }

  /**
   * Load time entries and calculate contributions for ad-hoc budget issues.
   * Rebuilds flexibility cache with effective spent hours.
   */
  private async _loadContributions(): Promise<void> {
    if (!this._server || this._issues.length === 0) return;
    if (this._contributionsLoading) return; // Prevent duplicate fetches
    this._contributionsLoading = true;

    // Get unique project IDs from displayed issues
    const projectIds = new Set<number>();
    for (const issue of this._issues) {
      if (issue.project?.id) {
        projectIds.add(issue.project.id);
      }
    }

    if (projectIds.size === 0) {
      this._contributionsLoading = false;
      return;
    }

    // Get all ad-hoc issue IDs - we need to fetch time entries from ALL of them
    // to calculate contributions TO displayed issues (even if ad-hoc source isn't displayed)
    const adHocIssueIds = new Set(adHocTracker.getAll());
    if (adHocIssueIds.size === 0) {
      this._contributionsLoading = false;
      return;
    }

    try {
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

      // Calculate contributions
      const contributions = calculateContributions(allTimeEntries);

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

      // Re-render with updated flexibility data
      this._cachedHierarchy = undefined;
      this._updateContent();
    } catch {
      // Silently fail - contributions are optional enhancement
    } finally {
      this._contributionsLoading = false;
    }
  }

  /**
   * Load versions (milestones) for all displayed projects.
   * Fetches in parallel and stores for rendering as milestone markers.
   */
  private async _loadVersions(): Promise<void> {
    if (!this._server || this._projects.length === 0) return;

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

      this._versions = allVersions;

      // Re-render with milestones
      this._updateContent();
    } catch {
      // Silently fail - versions are optional
    }
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
   * Switch to project view and select a specific project
   */
  public showProject(projectId: number): void {
    // Switch to "project" view focus
    this._viewFocus = "project";
    GanttPanel._globalState?.update(VIEW_FOCUS_KEY, this._viewFocus);

    // Select the project
    this._selectedProjectId = projectId;
    this._cachedHierarchy = undefined;
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
    viewMode?: GanttViewMode; // For setViewMode
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
    health?: string; // For setHealthFilter
    sortBy?: "id" | "assignee" | "start" | "due" | "status" | null; // For setSort (null = no sort)
    sortOrder?: "asc" | "desc"; // For setSort
    focus?: "project" | "person"; // For setViewFocus
    assignee?: string | null; // For setSelectedAssignee
    message?: string; // For showStatus
    years?: string; // For setLookback
  }): void {
    switch (message.command) {
      case "openIssue":
        if (message.issueId && this._server) {
          // Open issue actions (refresh is handled by individual actions if needed)
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
      case "setLookback":
        this._lookbackYears = !message.years || message.years === "" ? null : parseInt(message.years, 10) as 2 | 5 | 10;
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
        this._cachedHierarchy = undefined;
        GanttPanel._globalState?.update(VIEW_FOCUS_KEY, this._viewFocus);
        this._updateContent();
        break;
      case "setSelectedProject":
        this._selectedProjectId = message.projectId ?? null;
        this._cachedHierarchy = undefined;
        this._expandAllOnNextRender = true;
        GanttPanel._globalState?.update(SELECTED_PROJECT_KEY, this._selectedProjectId);
        this._updateContent();
        break;
      case "setSelectedAssignee":
        this._selectedAssignee = message.assignee ?? null;
        this._cachedHierarchy = undefined;
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
      case "toggleCapacityRibbon":
        this._showCapacityRibbon = !this._showCapacityRibbon;
        this._panel.webview.postMessage({
          command: "setCapacityRibbonState",
          enabled: this._showCapacityRibbon,
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
      case "openProjectInBrowser":
        if (message.projectId) {
          const project = this._projects.find(p => p.id === message.projectId);
          if (project) {
            vscode.commands.executeCommand("redmine.openProjectInBrowser", { project: { identifier: project.identifier } });
          }
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
          vscode.commands.executeCommand("redmine.setInternalEstimate", { id: message.issueId });
        }
        break;
      case "toggleAutoUpdate":
        if (message.issueId) {
          vscode.commands.executeCommand("redmine.toggleAutoUpdateDoneRatio", { id: message.issueId });
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
          vscode.commands.executeCommand("redmine.refreshIssues");
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
            vscode.commands.executeCommand("redmine.refreshIssues");
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
          // Apply filter locally and re-render
          this._cachedHierarchy = undefined;
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

    // Read gantt config settings
    const ganttConfig = vscode.workspace.getConfiguration("redmine.gantt");
    this._extendedRelationTypes = ganttConfig.get<boolean>("extendedRelationTypes", false);
    const visibleTypes = ganttConfig.get<string[]>("visibleRelationTypes", ["blocks", "precedes"]);
    this._visibleRelationTypes = new Set(visibleTypes);

    // Today for calculations (start of today in local timezone)
    const today = getLocalToday();

    // Extract unique assignees from ALL issues (sorted alphabetically)
    // Also capture current user's ID and name from issues if not yet set
    const assigneeSet = new Set<string>();
    for (const issue of this._issues) {
      if (issue.assigned_to?.name) {
        assigneeSet.add(issue.assigned_to.name);
        // Capture current user's ID and name from issues
        if (issue.assigned_to.id === this._currentUserId && !this._currentUserName) {
          this._currentUserName = issue.assigned_to.name;
        }
      }
    }
    // Sort assignees: current user first, then alphabetical
    this._uniqueAssignees = [...assigneeSet].sort((a, b) => {
      if (a === this._currentUserName) return -1;
      if (b === this._currentUserName) return 1;
      return a.localeCompare(b);
    });

    // Apply view focus filtering: either by project OR by person
    let filteredIssues: typeof this._issues;
    if (this._viewFocus === "person") {
      // Person view: filter by assignee (default to current user or first available)
      const effectiveAssignee = this._selectedAssignee
        ?? this._currentUserName
        ?? this._uniqueAssignees[0]
        ?? null;
      if (effectiveAssignee && effectiveAssignee !== this._selectedAssignee) {
        this._selectedAssignee = effectiveAssignee;
      }
      filteredIssues = effectiveAssignee
        ? this._issues.filter(i => i.assigned_to?.name === effectiveAssignee)
        : this._issues;
    } else {
      // Project view: filter by project and all subprojects
      const effectiveProjectId = this._selectedProjectId ?? this._projects[0]?.id ?? null;
      if (effectiveProjectId && effectiveProjectId !== this._selectedProjectId) {
        this._selectedProjectId = effectiveProjectId;
      }
      // Build set of project IDs including all descendants (with cycle protection)
      const projectIdsToInclude = new Set<number>();
      if (effectiveProjectId !== null) {
        const addDescendants = (pid: number) => {
          if (projectIdsToInclude.has(pid)) return; // Cycle protection
          projectIdsToInclude.add(pid);
          for (const p of this._projects) {
            if (p.parent?.id === pid) {
              addDescendants(p.id);
            }
          }
        };
        addDescendants(effectiveProjectId);
      }
      filteredIssues = projectIdsToInclude.size > 0
        ? this._issues.filter(i => i.project?.id !== undefined && projectIdsToInclude.has(i.project.id))
        : this._issues;
      // Apply "My issues" filter locally (filter by current user ID)
      if (this._currentFilter.assignee === "me" && this._currentUserId !== null) {
        filteredIssues = filteredIssues.filter(i => i.assigned_to?.id === this._currentUserId);
      }
    }

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
        this._cachedHierarchy = buildResourceHierarchy(sortedIssues, this._flexibilityCache, this._selectedAssignee ?? "");
      } else {
        // Project view: selected project and all subprojects
        // _selectedProjectId was already updated to effective value in filtering logic above
        const projectsForHierarchy = this._projects.filter(p => {
          // Include selected project and all its descendants
          let current: typeof p | undefined = p;
          while (current) {
            if (current.id === this._selectedProjectId) return true;
            current = this._projects.find(pp => pp.id === current?.parent?.id);
          }
          return false;
        });
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
    const flatNodes = flattenHierarchyAll(this._cachedHierarchy, this._collapseState.getExpandedKeys());
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
      return this._getEmptyHtml();
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
    if (this._viewFocus === "person") {
      // Get today's date for past/future split in capacity calculation
      const todayStr = getTodayStr();
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
      // Build both maps from breakdown
      for (const day of scheduledDays) {
        const dayEntries: { issueId: number; hours: number; project: string }[] = [];
        for (const entry of day.breakdown) {
          // issueScheduleMap for intensity bars
          if (!issueScheduleMap.has(entry.issueId)) {
            issueScheduleMap.set(entry.issueId, new Map());
          }
          issueScheduleMap.get(entry.issueId)!.set(day.date, entry.hours);
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
    const barHeight = 30;
    const barGap = 10;
    const headerHeight = 40;
    const indentSize = 16;

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
    const visibleRows = rows.filter(r => {
      // In by-project view, direct children of skipped project are always visible
      const isTopProjectChild = skipTopProjectRow && topProjectKey && r.parentKey === topProjectKey;
      if (!r.isVisible && !isTopProjectChild) return false;
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
        return {
          ...r,
          depth: Math.max(0, r.depth - 1),
          parentKey: r.parentKey === topProjectKey ? "" : r.parentKey,
        };
      }
      return r;
    });
    const visibleRowCount = visibleRows.length;

    // Pre-calculate Y positions with graduated spacing for visual hierarchy
    // Gestalt proximity: group boundary = extra gap, within group = standard/tight
    // - Group boundary (project after content): 18px (separates project groups)
    // - Peers (project after project, issue after issue): 10px (standard)
    // - Sub-issues (depth 2+): 6px (tight clustering with parent)
    const rowYPositions: number[] = [];
    const rowHeights: number[] = [];
    let cumulativeY = 0;

    // Helper to get gap before a row based on visual grouping hierarchy
    // Creates "families": project → issues, parent issue → children
    const getGapBefore = (row: typeof visibleRows[0], idx: number): number => {
      if (idx === 0) return 0;
      const prevRow = visibleRows[idx - 1];

      // Group boundary: project/time-group after content
      const isGroupHeader = row.type === "project" || row.type === "time-group";
      const prevIsContent = prevRow.type === "issue";
      if (isGroupHeader && prevIsContent) {
        return 16; // Separator between project groups
      }

      // Content starting after project header - attach closely
      if (row.type === "issue" && (prevRow.type === "project" || prevRow.type === "time-group")) {
        return 4;
      }

      // Child issues (depth 2+): very tight clustering
      if (row.depth >= 2) {
        return 2; // Tight - children feel "attached" to parent
      }

      // Family boundary is now handled via row height (gap added AFTER last child)
      // NOT before next sibling - this makes the gap "belong" to the closing group

      // Peer issues at depth 1
      return 8;
    };

    for (let i = 0; i < visibleRowCount; i++) {
      const row = visibleRows[i];
      const gapBefore = getGapBefore(row, i);
      const nextRow = i < visibleRowCount - 1 ? visibleRows[i + 1] : null;

      // Add gap BEFORE this row (creates whitespace separator)
      cumulativeY += gapBefore;

      rowYPositions.push(cumulativeY);

      // Row height = barHeight + optional family-closing padding
      // If this is a child (depth 2+) followed by a sibling (depth at min issue level),
      // add extra padding AFTER this row to visually close the family group
      const isLastChildInFamily = row.depth >= 2 && nextRow &&
        nextRow.type === "issue" && nextRow.depth < row.depth;
      const familyClosePadding = isLastChildInFamily ? 8 : 0;
      rowHeights.push(barHeight + familyClosePadding);

      // Move past this row's content + any family-close padding
      cumulativeY += barHeight + familyClosePadding;
    }
    // Ensure minimum height to fill viewport (roughly 100vh - 200px for header/toolbar)
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

    // Pre-compute indent guides: for each row, which ancestor lines should continue
    // A line continues at depth D if there are more siblings (same parent) below
    const indentGuides: Map<number, Set<string>> = new Map(); // rowIdx -> set of parentKeys with continuing lines
    for (let i = 0; i < visibleRows.length; i++) {
      const activeParents = new Set<string>();
      const row = visibleRows[i];
      // Walk up the parent chain and check if each ancestor has more children below
      let checkKey = row.parentKey;
      while (checkKey) {
        // Find if there's any row below with this same parentKey
        const hasMoreSiblings = visibleRows.slice(i + 1).some(r => r.parentKey === checkKey);
        if (hasMoreSiblings) {
          activeParents.add(checkKey);
        }
        // Move up to grandparent
        const parentRow = visibleRows.find(r => r.collapseKey === checkKey);
        checkKey = parentRow?.parentKey || "";
      }
      indentGuides.set(i, activeParents);
    }

    // Compute continuous vertical indent guide lines (rendered as single layer)
    // For each parent row, draw ONE continuous line covering ALL descendants (not just direct children)
    const continuousIndentLines: string[] = [];

    for (let i = 0; i < visibleRows.length; i++) {
      const row = visibleRows[i];

      // Only process parent rows (rows that have children)
      if (!row.hasChildren) continue;

      const parentDepth = row.depth;
      const parentIndex = i;

      // First descendant is the next row
      const firstDescendantIndex = parentIndex + 1;
      if (firstDescendantIndex >= visibleRows.length) continue;

      // Verify first descendant is at greater depth
      if (visibleRows[firstDescendantIndex].depth <= parentDepth) continue;

      // Find last descendant: scan forward until we hit a row at <= parent depth
      // In a flattened tree, all descendants are consecutive until we reach a sibling/ancestor
      let lastDescendantIndex = firstDescendantIndex;
      for (let j = firstDescendantIndex + 1; j < visibleRows.length; j++) {
        if (visibleRows[j].depth <= parentDepth) break;
        lastDescendantIndex = j;
      }

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

    const labels = visibleRows
      .map((row, idx) => {
        const y = rowYPositions[idx];
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

          // Tooltip: project ID + description + health stats
          const baseTooltip = health
            ? this.formatHealthTooltip(health, row.description)
            : row.description || "";
          const tooltip = `#${row.id} ${row.label}\n${baseTooltip}`.trim();

          // De-emphasized project headers: regular weight, muted color
          // Projects are containers, not content - issues should be primary focus
          return `
            <g class="project-label gantt-row cursor-pointer" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-project-id="${row.id}" data-expanded="${row.isExpanded}" data-has-children="${row.hasChildren}" data-original-y="${y}" data-vscode-context='${escapeAttr(JSON.stringify({ webviewSection: "projectLabel", projectId: row.id, projectIdentifier: row.identifier || "", preventDefaultContextMenuItems: true }))}' transform="translate(0, ${y})" tabindex="0" role="button" aria-label="Toggle project ${escapeHtml(row.label)}">
              <title>${escapeAttr(tooltip)}</title>
              ${chevron}
              <text x="${labelX}" y="${barHeight / 2 + 5}" fill="var(--vscode-descriptionForeground)" font-size="13">
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
            <g class="time-group-label gantt-row ${timeGroupClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-time-group="${row.timeGroup}" data-expanded="${row.isExpanded}" data-has-children="${row.hasChildren}" data-original-y="${y}" transform="translate(0, ${y})" tabindex="0" role="button" aria-label="Toggle ${escapeHtml(row.label)}">
              ${chevron}
              <text x="${10 + indent + textOffset}" y="${barHeight / 2 + 5}" fill="var(--vscode-foreground)" font-size="13" font-weight="bold">
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
        const leftFlexSlack = issue.flexibilitySlack;
        const leftFlexText = leftFlexSlack === null ? null
          : leftFlexSlack > 0 ? `Flexibility: +${leftFlexSlack}d buffer`
          : leftFlexSlack === 0 ? `Flexibility: ⚠ Critical path (no buffer)`
          : `Flexibility: ⚠ ${leftFlexSlack}d behind`;

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
          <g class="issue-label gantt-row cursor-pointer" data-issue-id="${issue.id}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-expanded="${row.isExpanded}" data-has-children="${row.hasChildren}" data-original-y="${y}" data-vscode-context='{"webviewSection":"issueBar","issueId":${issue.id},"projectId":${issue.projectId},"hasParent":${issue.parentId !== null},"preventDefaultContextMenuItems":true}' transform="translate(0, ${y})" tabindex="0" role="button" aria-label="Open issue #${issue.id}">
            <title>${escapeAttr(tooltip)}</title>
            ${chevron}
            <text x="${10 + indent + textOffset}" y="${barHeight / 2 + 5}" fill="${issue.isExternal ? "var(--vscode-descriptionForeground)" : "var(--vscode-foreground)"}" font-size="13" opacity="${taskOpacity}">
              ${externalBadge}${projectBadge}${escapedSubject}
            </text>
          </g>
        `;
      })
      .join("");

    // ID column cells
    const idCells = visibleRows
      .map((row, idx) => {
        const y = rowYPositions[idx];
        if (row.type !== "issue") return `<g class="gantt-row" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${y}" transform="translate(0, ${y})"></g>`;
        const issue = row.issue!;
        return `<g class="gantt-row cursor-pointer" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${y}" transform="translate(0, ${y})" data-vscode-context='{"webviewSection":"issueIdColumn","issueId":${issue.id},"preventDefaultContextMenuItems":true}'>
          <text class="gantt-col-cell" x="${idColumnWidth / 2}" y="${barHeight / 2 + 4}" text-anchor="middle">#${issue.id}</text>
        </g>`;
      })
      .join("");

    // Start date column cells
    const startDateCells = visibleRows
      .map((row, idx) => {
        const y = rowYPositions[idx];
        if (row.type !== "issue") return `<g class="gantt-row" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${y}" transform="translate(0, ${y})"></g>`;
        const issue = row.issue!;
        if (!issue.start_date) return `<g class="gantt-row" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${y}" transform="translate(0, ${y})"><text class="gantt-col-cell" x="4" y="${barHeight / 2 + 4}" text-anchor="start">—</text></g>`;
        const startDate = parseLocalDate(issue.start_date);
        const displayDate = startDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        return `<g class="gantt-row" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${y}" transform="translate(0, ${y})">
          <title>${escapeAttr(issue.start_date)}</title>
          <text class="gantt-col-cell" x="4" y="${barHeight / 2 + 4}" text-anchor="start">${displayDate}</text>
        </g>`;
      })
      .join("");

    // Status column cells - colored dots
    const statusCells = visibleRows
      .map((row, idx) => {
        const y = rowYPositions[idx];
        if (row.type !== "issue") return `<g class="gantt-row" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${y}" transform="translate(0, ${y})"></g>`;
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
        return `<g class="gantt-row" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${y}" transform="translate(0, ${y})">
          <title>${escapeAttr(statusName)}</title>
          <circle cx="${cx}" cy="${cy}" r="5" fill="${dotColor}"/>
        </g>`;
      })
      .join("");

    // Due date column cells
    const dueCells = visibleRows
      .map((row, idx) => {
        const y = rowYPositions[idx];
        if (row.type !== "issue") return `<g class="gantt-row" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${y}" transform="translate(0, ${y})"></g>`;
        const issue = row.issue!;
        if (!issue.due_date) return `<g class="gantt-row" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${y}" transform="translate(0, ${y})"><text class="gantt-col-cell" x="4" y="${barHeight / 2 + 4}" text-anchor="start">—</text></g>`;
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
        return `<g class="gantt-row" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${y}" transform="translate(0, ${y})">
          <title>${escapeAttr(dueTooltip)}</title>
          <text class="gantt-col-cell ${dueClass}" x="4" y="${barHeight / 2 + 4}" text-anchor="start">${displayDate}</text>
        </g>`;
      })
      .join("");

    // Assignee column cells - circular avatar badges with initials
    const assigneeCells = visibleRows
      .map((row, idx) => {
        const y = rowYPositions[idx];
        if (row.type !== "issue") return `<g class="gantt-row" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${y}" transform="translate(0, ${y})"></g>`;
        const issue = row.issue!;
        if (!issue.assignee) return `<g class="gantt-row" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${y}" transform="translate(0, ${y})"><text class="gantt-col-cell" x="${assigneeColumnWidth / 2}" y="${barHeight / 2 + 4}" text-anchor="middle">—</text></g>`;
        const initials = getInitials(issue.assignee);
        const bgColor = getAvatarColor(issue.assignee);
        const isCurrentUser = issue.assigneeId === this._currentUserId;
        const radius = 12;
        const cx = assigneeColumnWidth / 2;
        const cy = barHeight / 2;
        return `<g class="gantt-row assignee-badge${isCurrentUser ? " current-user" : ""}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${y}" transform="translate(0, ${y})">
          <title>${escapeAttr(issue.assignee)}</title>
          <circle cx="${cx}" cy="${cy}" r="${radius}" fill="${bgColor}"/>
          <text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="white" font-size="10" font-weight="600">${escapeHtml(initials)}</text>
        </g>`;
      })
      .join("");

    // Right bars (scrollable timeline) - only visible rows for performance
    // Generate bars for all visible rows
    const bars = visibleRows
      .map((row, idx) => {
        const y = rowYPositions[idx];

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

          return `<g class="aggregate-bars gantt-row" data-project-id="${row.id}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${y}" data-vscode-context='${escapeAttr(JSON.stringify({ webviewSection: "projectLabel", projectId: row.id, projectIdentifier: row.identifier || "", preventDefaultContextMenuItems: true }))}' transform="translate(0, ${y})">${aggregateBars}</g>`;
        }

        // Time group headers: render aggregate bars for child issues
        if (row.type === "time-group") {
          if (!row.childDateRanges || row.childDateRanges.length === 0) {
            return "";
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

              return `<rect class="aggregate-bar" x="${startX}" y="4" width="${width}" height="${barHeight - 8}"
                            fill="${timeGroupColor}" opacity="0.4" rx="2" ry="2"/>`;
            })
            .join("");

          return `<g class="aggregate-bars time-group-bars gantt-row" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-time-group="${row.timeGroup}" data-original-y="${y}" transform="translate(0, ${y})">${aggregateBars}</g>`;
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
        const flexSlack = issue.flexibilitySlack;
        const flexText = flexSlack === null ? null
          : flexSlack > 0 ? `Flexibility: +${flexSlack}d buffer`
          : flexSlack === 0 ? `Flexibility: ⚠ Critical path (no buffer)`
          : `Flexibility: ⚠ ${flexSlack}d behind`;
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
        // Only show intensity in person view (not project view)
        const showIntensityHere = this._showIntensity && this._viewFocus === "person" && !isParent;
        const intensities = showIntensityHere
          ? (issueScheduleMap.size > 0
              ? getScheduledIntensity(issue, this._schedule, issueScheduleMap)
              : calculateDailyIntensity(issue, this._schedule))
          : [];
        const hasIntensity = showIntensityHere && intensities.length > 0 && issue.estimated_hours !== null;

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
              // Opacity: base 0.5 + normalized intensity * 0.4 (range 0.5 to 0.9)
              // Higher base ensures bar color stays saturated for text readability
              // Multiply by fillOpacity to respect status-based muting (60-30-10 rule)
              const normalizedForOpacity = Math.min(d.intensity, maxIntensityForOpacity) / maxIntensityForOpacity;
              const opacity = (0.5 + normalizedForOpacity * 0.4) * fillOpacity;
              // clip-path handles corner rounding, no rx/ry needed on segments
              return `<rect x="${segX}" y="0" width="${segmentWidth + 0.5}" height="${barHeight}"
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
            <g class="issue-bar parent-bar gantt-row" data-issue-id="${issue.id}"
               data-project-id="${issue.projectId}"
               data-subject="${escapedSubject}"
               data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}"
               data-original-y="${y}"
               data-start-date="${issue.start_date || ""}"
               data-due-date="${issue.due_date || ""}"
               data-start-x="${startX}" data-end-x="${endX}"
               data-vscode-context='{"webviewSection":"issueBar","issueId":${issue.id},"projectId":${issue.projectId},"hasParent":${issue.parentId !== null},"preventDefaultContextMenuItems":true}'
               transform="translate(0, ${y})"
               tabindex="0" role="button" aria-label="#${issue.id} ${escapedSubject} (parent, ${doneRatio}% done)">
              <title>${escapeAttr(barTooltip + "\n\n(Parent issue - " + doneRatio + "% aggregated progress)")}</title>
              <!-- Invisible hit area for easier hovering -->
              <rect class="parent-hit-area" x="${startX}" y="0" width="${endX - startX}" height="${barHeight}"
                    fill="transparent" pointer-events="all"/>
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
                    <rect class="status-badge-bg" x="${onLeft ? labelX - badgeW : labelX}" y="${barHeight / 2 - 8}" width="${badgeW}" height="16" rx="2"
                          fill="var(--vscode-badge-background)" opacity="0.9"/>
                    <rect x="${onLeft ? labelX - badgeW : labelX}" y="${barHeight / 2 - 8}" width="${badgeW}" height="16" fill="transparent"/>
                    <text class="status-badge" x="${badgeCenterX}" y="${barHeight / 2 + 4}"
                          text-anchor="middle" fill="var(--vscode-badge-foreground)" font-size="10">${doneRatio}%</text>
                  </g>
                </g>`;
              })()}
            </g>
          `;
        }

        // Critical path: zero or negative flexibility
        const isCritical = flexSlack !== null && flexSlack <= 0 && !issue.isClosed;
        return `
          <g class="issue-bar gantt-row${isPast ? " bar-past" : ""}${isOverdue ? " bar-overdue" : ""}${hasOnlyStart ? " bar-open-ended" : ""}${issue.isExternal ? " bar-external" : ""}${issue.isAdHoc ? " bar-adhoc" : ""}${isCritical ? " bar-critical" : ""}" data-issue-id="${issue.id}"
             data-project-id="${issue.projectId}"
             data-subject="${escapedSubject}"
             data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}"
             data-original-y="${y}"
             data-start-date="${issue.start_date || ""}"
             data-due-date="${issue.due_date || ""}"
             data-start-x="${startX}" data-end-x="${endX}"
             data-vscode-context='{"webviewSection":"issueBar","issueId":${issue.id},"projectId":${issue.projectId},"hasParent":${issue.parentId !== null},"preventDefaultContextMenuItems":true}'
             transform="translate(0, ${y})"
             tabindex="0" role="button" aria-label="#${issue.id} ${escapedSubject}${isOverdue ? " (overdue)" : ""}">
            <title>${escapeAttr(barTooltip)}</title>
            <!-- Clip path for bar shape -->
            <defs>
              <clipPath id="bar-clip-${issue.id}">
                <rect x="${startX}" y="0" width="${width}" height="${barHeight}" rx="8" ry="8"/>
              </clipPath>
            </defs>
            <g clip-path="url(#bar-clip-${issue.id})">
              ${hasIntensity ? `
                <!-- Intensity segments -->
                <g class="bar-intensity">${intensitySegments}</g>
                <!-- Intensity line chart -->
                ${intensityLine}
              ` : `
                <!-- Fallback: solid bar when no intensity data (0-based Y) -->
                <rect class="bar-main" x="${startX}" y="0" width="${width}" height="${barHeight}"
                      fill="${color}" opacity="${(0.85 * fillOpacity).toFixed(2)}" filter="url(#barShadow)"/>
              `}
              ${hasPastPortion ? `
                <!-- Past portion overlay with diagonal stripes -->
                <rect class="past-overlay" x="${startX}" y="0" width="${pastWidth}" height="${barHeight}"
                      fill="url(#past-stripes)"/>
              ` : ""}
              ${visualDoneRatio > 0 && visualDoneRatio < 100 ? `
                <!-- Progress: dim unfilled portion + divider line -->
                <rect class="progress-unfilled" x="${startX + doneWidth}" y="0" width="${width - doneWidth}" height="${barHeight}"
                      fill="black" opacity="0.3"/>
                <line class="progress-divider" x1="${startX + doneWidth}" y1="2" x2="${startX + doneWidth}" y2="${barHeight - 2}"
                      stroke="white" stroke-width="2" opacity="0.6"/>
              ` : ""}
            </g>
            <!-- Border/outline - pointer-events:all so clicks work even with fill:none -->
            <rect class="bar-outline cursor-move" x="${startX}" y="0" width="${width}" height="${barHeight}"
                  fill="none" stroke="var(--vscode-panel-border)" stroke-width="1" rx="8" ry="8" pointer-events="all"/>
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
              return `<text class="bar-subject" x="${startX + padding}" y="${barHeight / 2 + 4}"
                    fill="${textColor}" font-size="10" font-weight="500"
                    pointer-events="none">${escapeHtml(displaySubject)}</text>`;
            })()}
            <rect class="drag-handle drag-left cursor-ew-resize" x="${startX}" y="0" width="${handleWidth}" height="${barHeight}"
                  fill="transparent"/>
            <rect class="drag-handle drag-right cursor-ew-resize" x="${startX + width - handleWidth}" y="0" width="${handleWidth}" height="${barHeight}"
                  fill="transparent"/>
            <!-- Link handle for creating relations (larger hit area for Fitts's Law) -->
            <g class="link-handle cursor-crosshair" data-cx="${endX + 8}" data-cy="${y + barHeight / 2}">
              <title>Drag to link</title>
              <circle cx="${endX + 8}" cy="${barHeight / 2}" r="14" fill="transparent" pointer-events="all"/>
              <circle class="link-handle-visual" cx="${endX + 8}" cy="${barHeight / 2}" r="5"
                      fill="var(--vscode-button-background)" stroke="var(--vscode-button-foreground)"
                      stroke-width="1" pointer-events="none"/>
            </g>
            <!-- Labels outside bar: adaptive positioning (left if near edge, else right) -->
            <!-- Badges: progress, flex, blocks, blocker, assignee -->
            ${(() => {
              // Progress badge width (varies by digit count)
              const progressBadgeW = visualDoneRatio === 100 ? 32 : visualDoneRatio >= 10 ? 28 : 22;
              // Flexibility badge: "+5d", "0d", "-3d" (width ~28)
              const showFlex = flexSlack !== null && !issue.isClosed;
              const flexBadgeW = showFlex ? 28 : 0;
              const flexLabel = showFlex ? (flexSlack > 0 ? `+${flexSlack}d` : `${flexSlack}d`) : "";
              const flexColor = showFlex
                ? (flexSlack > 2 ? "var(--vscode-charts-green)"
                  : flexSlack > 0 ? "var(--vscode-charts-yellow)"
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
                    <rect class="status-badge-bg" x="${onLeft ? labelX - checkBadgeW : labelX}" y="${barHeight / 2 - 8}" width="${checkBadgeW}" height="16" rx="2"
                          fill="var(--vscode-charts-green)" opacity="0.15"/>
                    <rect x="${onLeft ? labelX - checkBadgeW : labelX}" y="${barHeight / 2 - 8}" width="${checkBadgeW}" height="16" fill="transparent"/>
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
                  <rect class="status-badge-bg" x="${onLeft ? labelX - progressBadgeW : labelX}" y="${barHeight / 2 - 8}" width="${progressBadgeW}" height="16" rx="2"
                        fill="var(--vscode-badge-background)" opacity="0.9"/>
                  <rect x="${onLeft ? labelX - progressBadgeW : labelX}" y="${barHeight / 2 - 8}" width="${progressBadgeW}" height="16" fill="transparent"/>
                  <text class="status-badge" x="${progressCenterX}" y="${barHeight / 2 + 4}"
                        text-anchor="middle" fill="var(--vscode-badge-foreground)" font-size="10">${isFallbackProgress ? "~" : ""}${visualDoneRatio}%</text>
                </g>
                ${showFlex ? `<g class="flex-badge-group">
                  <title>${escapeAttr(flexTooltip)}</title>
                  <rect class="flex-badge-bg" x="${onLeft ? flexBadgeX - flexBadgeW : flexBadgeX}" y="${barHeight / 2 - 8}" width="${flexBadgeW}" height="16" rx="2"
                        fill="${flexColor}" opacity="0.15"/>
                  <rect x="${onLeft ? flexBadgeX - flexBadgeW : flexBadgeX}" y="${barHeight / 2 - 8}" width="${flexBadgeW}" height="16" fill="transparent"/>
                  <text class="flex-badge" x="${flexBadgeCenterX}" y="${barHeight / 2 + 4}"
                        text-anchor="middle" fill="${flexColor}" font-size="10" font-weight="500">${flexLabel}</text>
                </g>` : ""}
                ${showBlocks ? `<g class="blocks-badge-group" style="cursor: pointer;">
                  <title>${escapeAttr(blocksTooltip)}</title>
                  <rect class="blocks-badge-bg" x="${onLeft ? impactBadgeX - impactBadgeW : impactBadgeX}" y="${barHeight / 2 - 8}" width="${impactBadgeW}" height="16" rx="2"
                        fill="${impactColor}" opacity="0.15"/>
                  <rect x="${onLeft ? impactBadgeX - impactBadgeW : impactBadgeX}" y="${barHeight / 2 - 8}" width="${impactBadgeW}" height="16" fill="transparent"/>
                  <text class="blocks-badge" x="${impactBadgeCenterX}" y="${barHeight / 2 + 4}"
                        text-anchor="middle" fill="${impactColor}" font-size="10" font-weight="500">${impactLabel}</text>
                </g>` : ""}
                ${showBlocker ? `<g class="blocker-badge" data-blocker-id="${firstBlockerId}" style="cursor: pointer;">
                  <title>${escapeAttr(blockerTooltip)}</title>
                  <rect x="${onLeft ? blockerBadgeX - blockerBadgeW : blockerBadgeX}" y="${barHeight / 2 - 8}" width="${blockerBadgeW}" height="16" rx="2"
                        fill="var(--vscode-charts-red)" opacity="0.15"/>
                  <rect x="${onLeft ? blockerBadgeX - blockerBadgeW : blockerBadgeX}" y="${barHeight / 2 - 8}" width="${blockerBadgeW}" height="16" fill="transparent"/>
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

          const arrowTooltip = `#${issue.id} ${style.label} #${rel.targetId}\n${style.tip}\n(right-click to delete)`;
          return `
            <g class="dependency-arrow rel-${rel.type} cursor-pointer" data-relation-id="${rel.id}" data-from="${issue.id}" data-to="${rel.targetId}">
              <title>${escapeAttr(arrowTooltip)}</title>
              <!-- Wide invisible hit area for easier clicking -->
              <path class="arrow-hit-area" d="${path}" stroke="transparent" stroke-width="16" fill="none"/>
              <path class="arrow-line" d="${path}" stroke-width="2" fill="none" ${dashAttr}/>
              <path class="arrow-head" d="${arrowHead}"/>
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
    const minimapBarsJson = JSON.stringify(minimapBars);

    // Always calculate aggregate workload (needed for heatmap toggle without re-render)
    const workloadMap = calculateAggregateWorkload(this._issues, this._schedule, minDate, maxDate);

    // Calculate capacity ribbon data (Person view only), aggregated by zoom level
    // Use priority-based scheduling (frontloading) instead of uniform distribution
    const capacityZoomLevel = this._zoomLevel as CapacityZoomLevel;
    const capacityData: PeriodCapacity[] = this._viewFocus === "person"
      ? calculateScheduledCapacityByZoom(
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
        )
      : [];

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

    // Today marker for capacity ribbon
    const capacityTodayX = ((today.getTime() - minDate.getTime()) / (maxDate.getTime() - minDate.getTime())) * timelineWidth;
    const capacityTodayMarker = this._viewFocus === "person" && capacityTodayX >= 0 && capacityTodayX <= timelineWidth
      ? `<line x1="${capacityTodayX}" y1="0" x2="${capacityTodayX}" y2="${ribbonHeight}" class="capacity-today-marker"/>`
      : "";

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
    const todayInRange = todayX >= 0 && todayX <= timelineWidth;

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
    :root { --today-color: var(--vscode-charts-red); }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    body {
      margin: 0;
      padding: 8px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: 13px;
      overflow: hidden;
      height: 100vh;
      box-sizing: border-box;
      animation: fadeIn 0.15s ease-out;
      display: flex;
      flex-direction: column;
    }
    .gantt-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      flex-shrink: 0;
    }
    .gantt-title {
      font-size: 14px;
      font-weight: 500;
      color: var(--vscode-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 400px;
    }
    .gantt-title .client-name {
      color: var(--vscode-descriptionForeground);
    }
    .gantt-actions {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
    }
    .gantt-actions button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 8px;
      border-radius: 2px;
      cursor: pointer;
      font-size: 13px;
    }
    .gantt-actions button:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .gantt-actions button:focus-visible {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .gantt-actions button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .gantt-actions button.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    /* Toggle buttons (distinct from action buttons) */
    .gantt-actions button[aria-pressed] {
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
    }
    .gantt-actions button[aria-pressed]:hover:not(:disabled) {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }
    .gantt-actions button[aria-pressed="true"],
    .gantt-actions button[aria-pressed].active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }
    .toolbar-select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      padding: 3px 6px;
      font-size: 12px;
      font-family: var(--vscode-font-family);
      border-radius: 2px;
      cursor: pointer;
      max-width: 180px;
    }
    .toolbar-select:hover { border-color: var(--vscode-focusBorder); }
    .toolbar-select:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .capacity-ribbon-row {
      display: flex;
      position: sticky;
      top: ${headerHeight}px;
      z-index: 2;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      width: max-content;
      min-width: 100%;
    }
    .capacity-ribbon-row.hidden { display: none; }
    .capacity-ribbon-label {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      padding-right: 8px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
      white-space: nowrap;
      box-sizing: border-box;
    }
    .capacity-legend {
      display: flex;
      gap: 6px;
    }
    .capacity-label { font-size: 9px; }
    .capacity-label.available { color: var(--vscode-charts-green); }
    .capacity-label.busy { color: var(--vscode-charts-yellow); }
    .capacity-label.overbooked { color: var(--vscode-charts-red); }
    .capacity-ribbon-timeline {
      flex: 1;
      overflow: hidden;
    }
    .capacity-today-marker {
      stroke: var(--today-color);
      stroke-width: 2;
      stroke-dasharray: 4 2;
    }
    .capacity-week-marker {
      stroke: var(--vscode-panel-border);
      stroke-width: 1;
      opacity: 0.5;
    }
    .capacity-day-bar {
      cursor: pointer;
    }
    .capacity-day-bar:hover {
      opacity: 1 !important;
      stroke: var(--vscode-focusBorder);
      stroke-width: 1;
    }
    .overload-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      margin-left: 4px;
      font-size: 10px;
      font-weight: bold;
      border-radius: 4px;
      background: var(--vscode-charts-red);
      color: var(--vscode-editor-background);
      cursor: pointer;
    }
    .overload-badge:hover {
      background: var(--vscode-errorForeground);
    }
    .overload-badge.hidden { display: none; }
    /* Toggle buttons - native toolbar style (higher specificity to override .gantt-actions button) */
    .gantt-actions .toggle-btn {
      padding: 4px;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
    }
    .gantt-actions .toggle-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .gantt-actions .toggle-btn:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .gantt-actions .toggle-btn:disabled { opacity: 0.5; cursor: default; }
    .gantt-actions .toggle-btn.active {
      background: var(--vscode-toolbar-activeBackground);
      color: var(--vscode-textLink-foreground);
    }
    .gantt-actions .toggle-btn svg { width: 14px; height: 14px; fill: currentColor; }
    /* Dropdown menus (help, overflow) */
    .toolbar-dropdown { position: relative; }
    .toolbar-dropdown-menu {
      display: none;
      position: absolute;
      right: 0;
      top: 100%;
      z-index: 1000;
      min-width: 140px;
      padding-top: 4px;
    }
    .toolbar-dropdown-menu-inner {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 4px;
      padding: 4px 0;
      box-shadow: 0 2px 8px var(--vscode-widget-shadow);
    }
    .toolbar-dropdown:hover .toolbar-dropdown-menu { display: block; }
    .toolbar-dropdown-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px;
      cursor: pointer;
      font-size: 12px;
      color: var(--vscode-foreground);
      white-space: nowrap;
    }
    .toolbar-dropdown-item:hover { background: var(--vscode-list-hoverBackground); }
    .toolbar-dropdown-item.active { background: var(--vscode-list-activeSelectionBackground); }
    .toolbar-dropdown-item:disabled, .toolbar-dropdown-item[disabled] {
      opacity: 0.5;
      cursor: default;
    }
    .toolbar-dropdown-item:disabled:hover, .toolbar-dropdown-item[disabled]:hover {
      background: transparent;
    }
    .toolbar-dropdown-divider {
      height: 1px;
      background: var(--vscode-panel-border);
      margin: 4px 0;
    }
    .toolbar-dropdown-item .icon { width: 16px; text-align: center; }
    .toolbar-dropdown-item .shortcut {
      margin-left: auto;
      opacity: 0.6;
      font-size: 11px;
    }
    /* Help tooltip (special styling) */
    .help-dropdown { position: relative; }
    .help-tooltip {
      display: none;
      position: absolute;
      right: 0;
      top: 100%;
      margin-top: 4px;
      background: var(--vscode-editorHoverWidget-background);
      color: var(--vscode-editorHoverWidget-foreground);
      border-radius: 3px;
      padding: 8px 12px;
      box-shadow: 0 0 8px 2px var(--vscode-widget-shadow);
      z-index: 1000;
      white-space: nowrap;
    }
    .help-dropdown:hover .help-tooltip { display: block; }
    .help-section { display: flex; flex-direction: column; gap: 3px; font-size: 11px; }
    .help-section + .help-section { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border); }
    .help-title { font-weight: 600; margin-bottom: 2px; color: var(--vscode-foreground); }
    .help-item { opacity: 0.9; display: flex; align-items: center; gap: 6px; }
    .help-item kbd {
      background: var(--vscode-keybindingLabel-background);
      color: var(--vscode-keybindingLabel-foreground);
      border: 1px solid var(--vscode-keybindingLabel-border);
      border-radius: 3px;
      padding: 1px 4px;
      font-family: var(--vscode-editor-font-family);
      font-size: 10px;
      min-width: 18px;
      text-align: center;
    }
    .gantt-container {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 2px;
      flex-grow: 1;
      min-height: 0;
      position: relative;
      --sticky-left-width: ${stickyLeftWidth}px;
    }
    /* Single scroll container - push horizontal scrollbar outside visible area */
    .gantt-scroll-wrapper {
      flex-grow: 1;
      overflow: hidden; /* Clips the pushed-out horizontal scrollbar */
      min-height: 0;
      position: relative;
      margin-bottom: 30px; /* Reserve space for minimap */
    }
    .gantt-scroll {
      height: calc(100% + 17px); /* Push horizontal scrollbar below wrapper (17px = typical scrollbar height) */
      overflow: scroll;
    }
    .gantt-scroll::-webkit-scrollbar { width: 8px; }
    .gantt-scroll::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 4px; }
    .gantt-scroll::-webkit-scrollbar-corner { background: transparent; }
    .gantt-header-row {
      display: flex;
      position: sticky;
      top: 0;
      z-index: 3;
      height: ${headerHeight}px;
      box-sizing: border-box;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      width: max-content;
      min-width: 100%;
    }
    .gantt-header-row > * { background: var(--vscode-editor-background); }
    .gantt-body {
      display: flex;
      width: max-content;
      min-width: 100%;
      min-height: calc(100vh - 200px); /* Fill available space when collapsed */
    }
    .gantt-sticky-left {
      display: flex;
      flex-shrink: 0;
      position: sticky;
      left: 0;
      z-index: 1;
      background: var(--vscode-editor-background);
    }
    .gantt-corner {
      z-index: 4; /* Above both sticky header and sticky left */
    }
    .gantt-left-header {
      flex-shrink: 0;
      width: ${labelWidth}px;
      min-width: 120px;
      max-width: 600px;
      display: flex;
      gap: 4px;
      padding: 4px 8px;
      box-sizing: border-box;
      align-items: center;
    }
    .gantt-left-header button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
    .gantt-left-header button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .gantt-resize-handle-header {
      width: 10px;
      background: var(--vscode-panel-border);
      cursor: col-resize;
      flex-shrink: 0;
      position: relative;
    }
    .gantt-resize-handle-header::before {
      content: '';
      position: absolute;
      left: -4px;
      right: -4px;
      top: 0;
      bottom: 0;
    }
    .gantt-timeline-header { flex-shrink: 0; background: var(--vscode-editor-background); }
    .gantt-labels svg { display: block; min-width: 100%; }
    .gantt-labels {
      flex-shrink: 0;
      width: ${labelWidth}px;
      min-width: 120px;
      max-width: 600px;
      overflow: hidden;
      box-sizing: border-box;
    }
    .gantt-col-id, .gantt-col-start, .gantt-col-status, .gantt-col-due, .gantt-col-assignee {
      flex-shrink: 0;
      overflow: hidden;
      border-right: 1px solid var(--vscode-panel-border);
      box-sizing: border-box;
    }
    .gantt-col-id svg, .gantt-col-start svg, .gantt-col-status svg, .gantt-col-due svg, .gantt-col-assignee svg {
      display: block;
      width: 100%;
    }
    .gantt-col-id { width: ${idColumnWidth}px; }
    .gantt-col-start { width: ${startDateColumnWidth}px; }
    .gantt-col-status { width: ${statusColumnWidth}px; }
    .gantt-col-due { width: ${dueDateColumnWidth}px; }
    .gantt-col-assignee { width: ${assigneeColumnWidth}px; }
    .gantt-col-header {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      font-size: 12px;
      font-weight: 500;
      color: var(--vscode-descriptionForeground);
      padding: 0 4px;
      box-sizing: border-box;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .gantt-col-header.sortable { cursor: pointer; }
    .gantt-col-header.sortable:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
    .gantt-col-header.sorted { color: var(--vscode-foreground); font-weight: 600; }
    .gantt-left-header .gantt-col-header,
    .gantt-col-start .gantt-col-header,
    .gantt-col-due .gantt-col-header { justify-content: flex-start; }
    .gantt-col-cell {
      font-size: 13px;
      fill: var(--vscode-descriptionForeground);
    }
    .assignee-badge circle { cursor: default; }
    .assignee-badge.current-user circle { stroke: var(--vscode-focusBorder); stroke-width: 2; }
    .gantt-col-cell.status-closed { fill: var(--vscode-charts-green); }
    .gantt-col-cell.status-inprogress { fill: var(--vscode-charts-blue); }
    .gantt-col-cell.status-new { fill: var(--vscode-descriptionForeground); }
    .gantt-col-cell.due-overdue { fill: var(--vscode-charts-red); font-weight: 600; }
    .gantt-col-cell.due-soon { fill: var(--vscode-charts-orange); }
    .gantt-resize-handle {
      width: 10px;
      background: var(--vscode-panel-border);
      cursor: col-resize;
      flex-shrink: 0;
      position: relative;
    }
    .gantt-resize-handle::before {
      content: '';
      position: absolute;
      left: -4px;
      right: -4px;
      top: 0;
      bottom: 0;
    }
    .gantt-resize-handle:hover, .gantt-resize-handle.dragging,
    .gantt-resize-handle-header:hover, .gantt-resize-handle-header.dragging { background: var(--vscode-focusBorder); }
    .gantt-timeline { flex-shrink: 0; }
    svg { display: block; }
    .issue-bar:hover .bar-outline { stroke: var(--vscode-focusBorder); stroke-width: 2; }
    .issue-label:hover { opacity: 1; }
    .issue-bar.bar-past { filter: saturate(0.4) opacity(0.7); }
    .issue-bar.bar-past:hover { filter: saturate(0.6) opacity(0.85); }
    .issue-bar.bar-open-ended .bar-outline { stroke-dasharray: 6, 3; stroke-dashoffset: -6; }
    .issue-bar.bar-open-ended .bar-main { mask-image: linear-gradient(90deg, black 80%, transparent 100%); -webkit-mask-image: linear-gradient(90deg, black 80%, transparent 100%); }
    .issue-bar.bar-overdue .bar-outline { stroke: var(--vscode-charts-red) !important; stroke-width: 2; }
    .issue-bar.bar-overdue:hover .bar-outline { stroke-width: 3; }
    /* Critical path bars (zero/negative flexibility - pulsing border) */
    .issue-bar.bar-critical:not(.bar-overdue) .bar-outline { stroke: var(--vscode-charts-orange) !important; stroke-width: 2; animation: critical-pulse 2s ease-in-out infinite; }
    @keyframes critical-pulse { 0%, 100% { stroke-width: 2; } 50% { stroke-width: 3; } }
    /* External dependency bars (dimmed, dashed, no drag handles) */
    .issue-bar.bar-external { opacity: 0.5; pointer-events: none; }
    .issue-bar.bar-external .bar-outline { stroke-dasharray: 4, 2; stroke: var(--vscode-descriptionForeground); }
    .issue-bar.bar-external .bar-main { opacity: 0.4; }
    .issue-bar.bar-external .drag-handle,
    .issue-bar.bar-external .link-handle { display: none; }
    /* Ad-hoc budget pool bars (purple dotted outline) */
    .issue-bar.bar-adhoc .bar-outline { stroke: var(--vscode-charts-purple) !important; stroke-width: 2; stroke-dasharray: 3, 2; }
    .issue-bar.bar-adhoc .bar-main { opacity: 0.6; }
    .issue-bar.selected .bar-outline { stroke: var(--vscode-focusBorder) !important; stroke-width: 2; }
    .issue-bar.selected .bar-main { opacity: 1; }
    .multi-select-mode .issue-bar { cursor: pointer; }
    .selection-count { margin-left: 8px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .issue-bar.parent-bar { opacity: 0.7; }
    .issue-bar.parent-bar:hover { opacity: 1; }
    .past-overlay { pointer-events: none; }
    .progress-unfilled, .progress-divider { pointer-events: none; }
    .bar-labels { pointer-events: none; }
    .bar-labels .blocks-badge-group,
    .bar-labels .blocker-badge,
    .bar-labels .flex-badge-group,
    .bar-labels .progress-badge-group,
    .bar-labels .status-badge-group,
    .bar-labels .bar-assignee-group { pointer-events: all; }
    .status-badge-bg { pointer-events: none; }
    .status-badge { pointer-events: none; font-weight: 500; }
    .bar-assignee { pointer-events: none; opacity: 0.85; }
    .bar-assignee.current-user { fill: var(--vscode-charts-blue) !important; font-weight: 600; opacity: 1; }
    .issue-bar .drag-handle:hover { fill: var(--vscode-focusBorder); opacity: 0.5; }
    .issue-bar:hover .drag-handle { fill: var(--vscode-list-hoverBackground); opacity: 0.3; }
    .issue-bar:hover .link-handle-visual { opacity: 0.7; }
    .issue-bar .link-handle:hover .link-handle-visual { opacity: 1; transform-origin: center; }
    .issue-bar.dragging .bar-main, .issue-bar.dragging .bar-intensity { opacity: 0.5; }
    .issue-bar.linking-source .bar-outline { stroke-width: 3; stroke: var(--vscode-focusBorder); }
    .issue-bar.linking-source .link-handle-visual { opacity: 1; }
    .issue-bar.link-target .bar-outline { stroke-width: 2; stroke: var(--vscode-charts-green); }
    @keyframes highlight-pulse { 0%, 100% { filter: drop-shadow(0 0 6px var(--vscode-focusBorder)); } 50% { filter: drop-shadow(0 0 12px var(--vscode-focusBorder)); } }
    .issue-bar.highlighted .bar-outline { stroke: var(--vscode-focusBorder); stroke-width: 3; }
    .issue-label.highlighted { animation: highlight-pulse 0.5s ease-in-out 4; }
    .issue-bar.highlighted { animation: highlight-pulse 0.5s ease-in-out 4; }
    .temp-link-arrow { pointer-events: none; }
    .dependency-arrow .arrow-line { transition: stroke-width 0.15s, filter 0.15s; }
    .dependency-arrow .arrow-head { transition: filter 0.15s; }
    .dependency-arrow:hover .arrow-line { stroke-width: 3 !important; }
    .dependency-arrow.selected .arrow-line { stroke-width: 4 !important; }
    .arrow-selection-mode .issue-bar { opacity: 0.3; }
    .arrow-selection-mode .issue-bar.arrow-connected { opacity: 1; }
    .arrow-selection-mode .issue-bar.arrow-connected .bar-outline { stroke: var(--vscode-focusBorder); stroke-width: 2; }
    .arrow-selection-mode .issue-label,
    .arrow-selection-mode .project-label,
    .arrow-selection-mode .time-group-label { opacity: 0.15; }
    .arrow-selection-mode .issue-label.arrow-connected,
    .arrow-selection-mode .project-label.arrow-connected,
    .arrow-selection-mode .time-group-label.arrow-connected { opacity: 1; }
    .arrow-selection-mode .dependency-arrow { opacity: 0.2; }
    .arrow-selection-mode .dependency-arrow.selected { opacity: 1; }
    .arrow-selection-mode .dependency-arrow.selected .arrow-line { stroke-width: 3; }
    /* Hover highlighting - fade labels only for dependency arrow hovers */
    .hover-focus.dependency-hover .issue-label,
    .hover-focus.dependency-hover .project-label,
    .hover-focus.dependency-hover .time-group-label { opacity: 0.15; transition: opacity 0.15s ease-out; }
    .hover-focus.dependency-hover .issue-label.hover-highlighted,
    .hover-focus.dependency-hover .project-label.hover-highlighted,
    .hover-focus.dependency-hover .time-group-label.hover-highlighted { opacity: 1 !important; }
    /* Highlight hovered bar */
    .hover-focus .issue-bar.hover-highlighted .bar-outline { stroke: var(--vscode-focusBorder); stroke-width: 2; }
    /* Dependency hover - glow on hovered arrow */
    .hover-focus.dependency-hover .dependency-arrow.hover-source .arrow-line { stroke-width: 3; }
    /* Relation type colors in legend */
    .relation-legend { display: flex; gap: 12px; font-size: 11px; margin-left: 12px; align-items: center; }
    .relation-legend-item { display: flex; align-items: center; gap: 4px; opacity: 0.8; }
    .relation-legend-item:hover { opacity: 1; }
    .relation-legend-line { width: 20px; height: 2px; }
    .relation-picker { position: fixed; background: var(--vscode-menu-background); border: 1px solid var(--vscode-menu-border); border-radius: 2px; padding: 4px 0; z-index: 1000; box-shadow: 0 2px 8px var(--vscode-widget-shadow); }
    .relation-picker button { display: block; width: 100%; padding: 4px 12px; border: none; background: transparent; color: var(--vscode-menu-foreground); text-align: left; cursor: pointer; font-size: 13px; }
    .relation-picker button:hover, .relation-picker button:focus { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
    /* Focus indicators for accessibility */
    button:focus { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .issue-bar:focus { outline: none; } /* Use stroke instead of outline for SVG */
    .issue-bar:focus .bar-outline, .issue-bar:focus-within .bar-outline, .issue-bar.focused .bar-outline { stroke-width: 3; stroke: var(--vscode-focusBorder); }
    .issue-label:hover, .project-label:hover, .time-group-label:hover {
      background: var(--vscode-list-hoverBackground);
      border-radius: 4px;
    }
    .issue-label:hover text, .project-label:hover text, .time-group-label:hover text {
      fill: var(--vscode-list-hoverForeground) !important;
    }
    .issue-label:focus, .project-label:focus, .time-group-label:focus {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 1px;
      background: var(--vscode-list-activeSelectionBackground);
      border-radius: 4px;
    }
    .issue-label.active, .project-label.active, .time-group-label.active {
      background: var(--vscode-list-inactiveSelectionBackground);
      border-radius: 4px;
    }
    .issue-label.active:hover, .project-label.active:hover, .time-group-label.active:hover {
      background: var(--vscode-list-inactiveSelectionBackground);
    }
    /* Collapse toggle chevron - VS Code style */
    .collapse-toggle {
      cursor: pointer;
      opacity: 0.7;
      transition: transform 0.1s ease-out;
    }
    .collapse-toggle:hover { opacity: 1; }
    .collapse-toggle.expanded { transform: rotate(90deg); }
    .chevron-hit-area { cursor: pointer; }
    /* Client-side collapse: hide descendants of collapsed rows */
    .gantt-row-hidden,
    g.gantt-row-hidden,
    svg .gantt-row-hidden,
    .issue-label.gantt-row-hidden,
    .project-label.gantt-row-hidden,
    .time-group-label.gantt-row-hidden,
    .issue-bar.gantt-row-hidden,
    .aggregate-bars.gantt-row-hidden,
    .indent-guide-line.gantt-row-hidden,
    .dependency-arrow.gantt-row-hidden {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
    }
    /* Screen reader only class */
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }
    /* Quick search overlay */
    .quick-search {
      position: fixed;
      top: 80px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 1000;
    }
    .quick-search input {
      width: 300px;
      padding: 8px 12px;
      font-size: 14px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      outline: none;
      box-shadow: 0 4px 12px var(--vscode-widget-shadow);
    }
    .quick-search input:focus {
      border-color: var(--vscode-focusBorder);
    }
    .issue-label.search-match {
      background: var(--vscode-editor-findMatchHighlightBackground);
      border-radius: 2px;
    }
    /* Keyboard help overlay */
    .keyboard-help {
      position: fixed;
      inset: 0;
      background: var(--vscode-editor-background);
      opacity: 0.85;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .keyboard-help-content {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 20px 24px;
      max-width: 600px;
      box-shadow: 0 8px 32px var(--vscode-widget-shadow);
    }
    .keyboard-help h3 {
      margin: 0 0 16px;
      font-size: 16px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .shortcut-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
    }
    .shortcut-section h4 {
      margin: 0 0 8px;
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
    }
    .shortcut-section > div {
      font-size: 12px;
      color: var(--vscode-foreground);
      margin-bottom: 4px;
    }
    .keyboard-help kbd {
      display: inline-block;
      padding: 2px 6px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      background: var(--vscode-keybindingLabel-background);
      color: var(--vscode-keybindingLabel-foreground);
      border: 1px solid var(--vscode-keybindingLabel-border, var(--vscode-panel-border));
      border-radius: 3px;
      margin-right: 2px;
    }
    .keyboard-help-close {
      margin: 16px 0 0;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
    .weekend-bg { fill: var(--vscode-editor-inactiveSelectionBackground); opacity: 0.3; }
    .zebra-stripe { fill: var(--vscode-foreground); pointer-events: none; }
    .day-grid { stroke: var(--vscode-editorRuler-foreground); stroke-width: 1; opacity: 0.25; }
    .date-marker { stroke: var(--vscode-editorRuler-foreground); stroke-dasharray: 2,2; }
    .today-marker { stroke: var(--today-color); stroke-width: 2; stroke-dasharray: 4 2; }
    .today-header-bg { fill: var(--today-color); fill-opacity: 0.2; }
    .today-day-label { fill: var(--today-color) !important; font-weight: bold; }
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
    /* Relation legend line colors - 3 semantic categories */
    .rel-line-blocks { background: var(--vscode-charts-red); }
    .rel-line-scheduling { background: var(--vscode-charts-blue); }
    .rel-line-informational { background: var(--vscode-charts-lines); border-style: dashed; }
    /* SVG arrow colors - 3 semantic groups: blocking (red), scheduling (blue), informational (gray) */
    /* Blocking - hard constraint, target blocked until source closes */
    .rel-blocks .arrow-line { stroke: var(--vscode-charts-red); }
    .rel-blocks .arrow-head { fill: var(--vscode-charts-red); }
    /* Scheduling - all scheduling relation types use blue */
    .rel-precedes .arrow-line,
    .rel-finish_to_start .arrow-line,
    .rel-start_to_start .arrow-line,
    .rel-finish_to_finish .arrow-line,
    .rel-start_to_finish .arrow-line { stroke: var(--vscode-charts-blue); }
    .rel-precedes .arrow-head,
    .rel-finish_to_start .arrow-head,
    .rel-start_to_start .arrow-head,
    .rel-finish_to_finish .arrow-head,
    .rel-start_to_finish .arrow-head { fill: var(--vscode-charts-blue); }
    /* Informational - simple links, no hard constraints */
    .rel-relates .arrow-line,
    .rel-duplicates .arrow-line,
    .rel-copied_to .arrow-line { stroke: var(--vscode-charts-lines); }
    .rel-relates .arrow-head,
    .rel-duplicates .arrow-head,
    .rel-copied_to .arrow-head { fill: var(--vscode-charts-lines); }
    .color-swatch { display: inline-block; width: 12px; height: 3px; margin-right: 8px; vertical-align: middle; }

    /* Minimap - fixed at bottom of gantt-container, aligned with timeline */
    .minimap-container {
      position: absolute;
      bottom: 0;
      left: var(--sticky-left-width);
      right: 8px; /* Leave space for vertical scrollbar */
      height: 30px;
      background: var(--vscode-editor-background);
      border-top: 1px solid var(--vscode-panel-border);
      z-index: 6;
    }
    .minimap-container svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    .minimap-bar { opacity: 0.85; }
    .minimap-bar.bar-past { opacity: 0.4; }
    .minimap-viewport {
      fill: var(--vscode-scrollbarSlider-background, rgba(100, 100, 100, 0.4));
    }
    .minimap-viewport:hover { fill: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, 0.5)); }
    .minimap-viewport:active { fill: var(--vscode-scrollbarSlider-activeBackground, rgba(100, 100, 100, 0.6)); }
    .minimap-today { stroke: var(--today-color); stroke-width: 3; }
    /* Milestone markers */
    .milestone-marker {
      pointer-events: all;
      cursor: pointer;
    }
    .milestone-marker:hover .milestone-line {
      opacity: 1;
      stroke-width: 2;
    }
    .milestone-marker:hover .milestone-diamond {
      stroke-width: 3;
    }
    .milestone-label {
      pointer-events: none;
      font-family: var(--vscode-font-family);
    }
    /* Focus mode: highlight dependency chain */
    .focus-mode .issue-bar { opacity: 0.25; }
    .focus-mode .issue-label { opacity: 0.25; }
    .focus-mode .dependency-arrow { opacity: 0.15; }
    .focus-mode .issue-bar.focus-highlighted { opacity: 1; }
    .focus-mode .issue-label.focus-highlighted { opacity: 1; }
    .focus-mode .dependency-arrow.focus-highlighted { opacity: 1; stroke-width: 2.5; }
    .focus-mode .issue-bar.focus-highlighted .bar-outline { stroke: var(--vscode-focusBorder); stroke-width: 2; }
    /* Blocker badge styling */
    .blocker-badge { pointer-events: all; }
    .blocker-badge:hover rect { opacity: 0.35 !important; }
    /* Blocks badge styling */
    .blocks-badge-group { cursor: pointer; }
    .blocks-badge-group:hover .blocks-badge-bg { opacity: 0.35 !important; }
  </style>
</head>
<body>
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
    <div class="gantt-container">
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
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const timelineWidth = ${timelineWidth};
    const minDateMs = ${minDate.getTime()};
    const maxDateMs = ${maxDate.getTime()};
    const totalDays = ${totalDays};
    const dayWidth = timelineWidth / totalDays;
    const extendedRelationTypes = ${this._extendedRelationTypes};
    const redmineBaseUrl = ${JSON.stringify(vscode.workspace.getConfiguration("redmine").get<string>("url") || "")};

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

    // Helper: close element on outside click (used by pickers/menus)
    function closeOnOutsideClick(element) {
      setTimeout(() => {
        document.addEventListener('click', function closeHandler(e) {
          if (!element.contains(e.target)) {
            element.remove();
            document.removeEventListener('click', closeHandler);
          }
        });
      }, 0);
    }

    // Snap x position to nearest day boundary
    function snapToDay(x) {
      return Math.round(x / dayWidth) * dayWidth;
    }

    // Get DOM elements
    const ganttScroll = document.getElementById('ganttScroll');
    const ganttLeftHeader = document.getElementById('ganttLeftHeader');
    const labelsColumn = document.getElementById('ganttLabels');
    const timelineColumn = document.getElementById('ganttTimeline');
    const menuUndo = document.getElementById('menuUndo');
    const menuRedo = document.getElementById('menuRedo');
    const minimapSvg = document.getElementById('minimapSvg');
    const minimapViewport = document.getElementById('minimapViewport');
    const minimapContainer = document.getElementById('minimapContainer');

    // Position minimap to align with timeline (skip sticky-left columns)
    function updateMinimapPosition() {
      const stickyLeft = document.querySelector('.gantt-body .gantt-sticky-left');
      const ganttContainer = document.querySelector('.gantt-container');
      if (stickyLeft && ganttContainer) {
        ganttContainer.style.setProperty('--sticky-left-width', stickyLeft.offsetWidth + 'px');
      }
    }
    // Defer to next frame to ensure layout is complete (fixes minimap alignment on project switch)
    requestAnimationFrame(updateMinimapPosition);

    // Minimap setup
    const minimapBarsData = ${minimapBarsJson};
    const minimapHeight = ${minimapHeight};
    const minimapBarHeight = ${minimapBarHeight};
    const minimapTodayX = ${Math.round(todayX)};

    // Render minimap bars (deferred to avoid blocking initial paint)
    if (minimapSvg) {
      requestAnimationFrame(() => {
        const barSpacing = minimapHeight / (minimapBarsData.length + 1);
        minimapBarsData.forEach((bar, i) => {
          const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          rect.setAttribute('class', bar.classes);
          rect.setAttribute('x', (bar.startPct * timelineWidth).toString());
          rect.setAttribute('y', (barSpacing * (i + 0.5)).toString());
          rect.setAttribute('width', Math.max(2, (bar.endPct - bar.startPct) * timelineWidth).toString());
          rect.setAttribute('height', minimapBarHeight.toString());
          rect.setAttribute('rx', '1');
          rect.setAttribute('fill', bar.color);
          minimapSvg.insertBefore(rect, minimapViewport);
        });
        // Today marker line
        if (minimapTodayX > 0 && minimapTodayX < timelineWidth) {
          const todayLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          todayLine.setAttribute('class', 'minimap-today');
          todayLine.setAttribute('x1', minimapTodayX.toString());
          todayLine.setAttribute('y1', '0');
          todayLine.setAttribute('x2', minimapTodayX.toString());
          todayLine.setAttribute('y2', minimapHeight.toString());
          minimapSvg.insertBefore(todayLine, minimapViewport);
        }
      });
    }

    // Update minimap viewport on scroll
    // Use ganttScroll for single-container scroll
    function updateMinimapViewport() {
      if (!ganttScroll || !minimapViewport) return;
      const scrollableRange = Math.max(1, ganttScroll.scrollWidth - ganttScroll.clientWidth);
      const scrollRatio = Math.min(1, ganttScroll.scrollLeft / scrollableRange);
      const viewportRatio = Math.min(1, ganttScroll.clientWidth / ganttScroll.scrollWidth);
      const viewportWidth = Math.max(20, viewportRatio * timelineWidth);
      const viewportX = scrollRatio * (timelineWidth - viewportWidth);
      minimapViewport.setAttribute('x', viewportX.toString());
      minimapViewport.setAttribute('width', viewportWidth.toString());
    }

    // Handle minimap click/drag to scroll
    let minimapDragging = false;
    let minimapDragOffset = 0; // Offset within viewport where drag started

    function scrollFromMinimap(e, useOffset = false) {
      if (!ganttScroll || !minimapSvg || !minimapViewport) return;
      const rect = minimapSvg.getBoundingClientRect();
      const viewportWidth = parseFloat(minimapViewport.getAttribute('width') || '0');
      const viewportWidthPx = (viewportWidth / timelineWidth) * rect.width;

      // Calculate target position, accounting for drag offset if dragging viewport
      let targetX = e.clientX - rect.left;
      if (useOffset) {
        targetX -= minimapDragOffset;
      } else {
        // Center viewport on click position
        targetX -= viewportWidthPx / 2;
      }

      // Use ganttScroll for single-container scroll
      const clickRatio = Math.max(0, Math.min(1, targetX / (rect.width - viewportWidthPx)));
      const scrollableRange = Math.max(0, ganttScroll.scrollWidth - ganttScroll.clientWidth);
      ganttScroll.scrollLeft = clickRatio * scrollableRange;
    }

    if (minimapSvg && minimapViewport) {
      // Clicking on viewport - drag from current position
      minimapViewport.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        minimapDragging = true;
        const rect = minimapSvg.getBoundingClientRect();
        const viewportX = parseFloat(minimapViewport.getAttribute('x') || '0');
        const viewportXPx = (viewportX / timelineWidth) * rect.width;
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
      if (!ganttScroll) return null;
      // Account for sticky left column (same as scrollToCenterDate)
      const stickyLeft = document.querySelector('.gantt-body .gantt-sticky-left');
      const stickyWidth = stickyLeft?.offsetWidth ?? 0;
      const visibleTimelineWidth = ganttScroll.clientWidth - stickyWidth;
      const centerX = ganttScroll.scrollLeft + visibleTimelineWidth / 2;
      const ratio = centerX / timelineWidth;
      return minDateMs + ratio * (maxDateMs - minDateMs);
    }

    // Scroll to center a specific date
    function scrollToCenterDate(dateMs) {
      if (!ganttScroll) return;
      const ratio = (dateMs - minDateMs) / (maxDateMs - minDateMs);
      const centerX = ratio * timelineWidth;
      const stickyLeft = document.querySelector('.gantt-body .gantt-sticky-left');
      const stickyWidth = stickyLeft?.offsetWidth ?? 0;
      const visibleTimelineWidth = ganttScroll.clientWidth - stickyWidth;
      ganttScroll.scrollLeft = Math.max(0, centerX - visibleTimelineWidth / 2);
    }

    function saveState() {
      // Always save centerDateMs for date-based scroll restoration
      // This ensures correct position when date range changes (e.g., visibility toggle)
      vscode.setState({
        undoStack,
        redoStack,
        labelWidth: labelsColumn?.offsetWidth || ${labelWidth},
        scrollLeft: null, // Deprecated: use centerDateMs instead
        scrollTop: ganttScroll?.scrollTop ?? null,
        centerDateMs: getCenterDateMs()
      });
    }

    // Alias for backward compatibility (zoom changes now use same logic)
    const saveStateForZoom = saveState;

    function updateUndoRedoButtons() {
      if (menuUndo) menuUndo.toggleAttribute('disabled', undoStack.length === 0);
      if (menuRedo) menuRedo.toggleAttribute('disabled', redoStack.length === 0);
      saveState();
    }

    // Apply saved label width
    if (previousState.labelWidth && ganttLeftHeader && labelsColumn) {
      ganttLeftHeader.style.width = previousState.labelWidth + 'px';
      labelsColumn.style.width = previousState.labelWidth + 'px';
      // Also update capacity ribbon label to stay aligned
      const capacityLabel = document.querySelector('.capacity-ribbon-label');
      if (capacityLabel) {
        capacityLabel.style.width = (previousState.labelWidth + ${resizeHandleWidth + extraColumnsWidth}) + 'px';
      }
    }

    // Single scroll container - no sync needed, just update minimap and save state
    // Flag to prevent saving state during scroll restoration (would overwrite with wrong position)
    let restoringScroll = true;
    let deferredScrollUpdate = null;
    if (ganttScroll) {
      ganttScroll.addEventListener('scroll', () => {
        cancelAnimationFrame(deferredScrollUpdate);
        deferredScrollUpdate = requestAnimationFrame(() => {
          updateMinimapViewport();
          if (!restoringScroll) saveState();
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
        const menuHeatmap = document.getElementById('menuHeatmap');

        if (message.enabled) {
          if (heatmapLayer) heatmapLayer.classList.remove('hidden');
          if (weekendLayer) weekendLayer.classList.add('hidden');
          if (menuHeatmap) menuHeatmap.classList.add('active');
        } else {
          if (heatmapLayer) heatmapLayer.classList.add('hidden');
          if (weekendLayer) weekendLayer.classList.remove('hidden');
          if (menuHeatmap) menuHeatmap.classList.remove('active');
        }
      } else if (message.command === 'setDependenciesState') {
        const dependencyLayer = document.querySelector('.dependency-layer');
        const menuDeps = document.getElementById('menuDeps');

        if (message.enabled) {
          if (dependencyLayer) dependencyLayer.classList.remove('hidden');
          if (menuDeps) menuDeps.classList.add('active');
        } else {
          if (dependencyLayer) dependencyLayer.classList.add('hidden');
          if (menuDeps) menuDeps.classList.remove('active');
        }
      } else if (message.command === 'setCapacityRibbonState') {
        const capacityRibbon = document.querySelector('.capacity-ribbon');
        const menuCapacity = document.getElementById('menuCapacity');

        if (message.enabled) {
          if (capacityRibbon) capacityRibbon.classList.remove('hidden');
          if (menuCapacity) menuCapacity.classList.add('active');
        } else {
          if (capacityRibbon) capacityRibbon.classList.add('hidden');
          if (menuCapacity) menuCapacity.classList.remove('active');
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
        const scrollContainer = document.getElementById('ganttScroll');
        const headerRow = document.querySelector('.gantt-header-row');
        const headerHeight = headerRow?.getBoundingClientRect().height || 60;

        if (!scrollContainer) return;

        // Calculate target scroll positions
        let targetScrollTop = scrollContainer.scrollTop;
        let targetScrollLeft = scrollContainer.scrollLeft;

        if (label) {
          // Calculate vertical scroll position within container (not scrollIntoView which affects document)
          const labelRow = label.closest('.gantt-row');
          if (labelRow) {
            const rowTop = labelRow.offsetTop;
            const rowHeight = labelRow.getBoundingClientRect().height;
            const viewportHeight = scrollContainer.clientHeight - headerHeight;
            // Center the row vertically in the visible area below header
            targetScrollTop = Math.max(0, rowTop - headerHeight - (viewportHeight - rowHeight) / 2);
          }
          label.focus();
          label.classList.add('highlighted');
          setTimeout(() => label.classList.remove('highlighted'), 2000);
        }

        if (bar) {
          // Calculate horizontal scroll to show the bar
          const startX = parseFloat(bar.getAttribute('data-start-x') || '0');
          const endX = parseFloat(bar.getAttribute('data-end-x') || '0');
          const barWidth = endX - startX;
          const viewportWidth = scrollContainer.clientWidth;
          const stickyLeftWidth = document.querySelector('.gantt-sticky-left')?.getBoundingClientRect().width || 0;
          const availableWidth = viewportWidth - stickyLeftWidth;

          if (barWidth <= availableWidth - 100) {
            // Bar fits: center it in the available viewport
            targetScrollLeft = startX - (availableWidth - barWidth) / 2;
          } else {
            // Bar too wide: show start with some padding
            targetScrollLeft = startX - 50;
          }
          targetScrollLeft = Math.max(0, targetScrollLeft);

          bar.classList.add('highlighted');
          setTimeout(() => bar.classList.remove('highlighted'), 2000);
        }

        // Single combined scroll call
        scrollContainer.scrollTo({ left: targetScrollLeft, top: targetScrollTop, behavior: 'smooth' });
      }
    });

    // Lookback period select handler
    document.getElementById('lookbackSelect')?.addEventListener('change', (e) => {
      vscode.postMessage({ command: 'setLookback', years: e.target.value });
    });

    // Zoom select handler
    document.getElementById('zoomSelect')?.addEventListener('change', (e) => {
      saveStateForZoom();
      vscode.postMessage({ command: 'setZoom', zoomLevel: e.target.value });
    });

    // View focus select handler
    document.getElementById('viewFocusSelect')?.addEventListener('change', (e) => {
      vscode.postMessage({ command: 'setViewFocus', focus: e.target.value });
    });

    // Project selector handler (native select)
    const projectSelector = document.getElementById('projectSelector');
    projectSelector?.addEventListener('change', (e) => {
      const value = e.target.value;
      const projectId = value ? parseInt(value, 10) : null;
      vscode.postMessage({ command: 'setSelectedProject', projectId });
    });

    // Person selector handler (focusSelector in person focus mode)
    const focusSelector = document.getElementById('focusSelector');
    focusSelector?.addEventListener('change', (e) => {
      const value = e.target.value;
      vscode.postMessage({
        command: 'setSelectedAssignee',
        assignee: value || null
      });
    });

    // Filter dropdown handlers
    document.getElementById('filterAssignee')?.addEventListener('change', (e) => {
      const value = e.target.value;
      vscode.postMessage({ command: 'setFilter', filter: { assignee: value } });
    });
    document.getElementById('filterStatus')?.addEventListener('change', (e) => {
      const value = e.target.value;
      vscode.postMessage({ command: 'setFilter', filter: { status: value } });
    });
    // Health filter menu item (cycles through options)
    document.getElementById('menuFilterHealth')?.addEventListener('click', () => {
      const options = ['all', 'critical', 'warning', 'healthy'];
      const currentHealth = '${this._healthFilter}';
      const currentIdx = options.indexOf(currentHealth);
      const nextIdx = (currentIdx + 1) % options.length;
      vscode.postMessage({ command: 'setHealthFilter', health: options[nextIdx] });
    });

    // Sortable column header handlers (cycle: asc → desc → none)
    document.querySelectorAll('.gantt-col-header.sortable').forEach(header => {
      header.addEventListener('click', () => {
        const sortField = header.dataset.sort;
        const currentSort = '${this._sortBy}';
        const currentOrder = '${this._sortOrder}';
        if (sortField === currentSort) {
          // Same field: asc → desc → none
          if (currentOrder === 'asc') {
            vscode.postMessage({ command: 'setSort', sortOrder: 'desc' });
          } else {
            // desc → none (clear sort)
            vscode.postMessage({ command: 'setSort', sortBy: null });
          }
        } else {
          // Different field: start with ascending
          vscode.postMessage({ command: 'setSort', sortBy: sortField, sortOrder: 'asc' });
        }
      });
    });

    // Heatmap toggle handler (menu item)
    document.getElementById('menuHeatmap')?.addEventListener('click', () => {
      if (document.getElementById('menuHeatmap')?.hasAttribute('disabled')) return;
      saveState();
      vscode.postMessage({ command: 'toggleWorkloadHeatmap' });
    });

    // Capacity ribbon toggle handler (menu item)
    document.getElementById('menuCapacity')?.addEventListener('click', () => {
      if (document.getElementById('menuCapacity')?.hasAttribute('disabled')) return;
      saveState();
      vscode.postMessage({ command: 'toggleCapacityRibbon' });
    });

    // Intensity toggle handler (menu item)
    document.getElementById('menuIntensity')?.addEventListener('click', () => {
      if (document.getElementById('menuIntensity')?.hasAttribute('disabled')) return;
      saveState();
      vscode.postMessage({ command: 'toggleIntensity' });
    });

    // Overload badge click - jump to first overloaded day
    document.getElementById('overloadBadge')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const badge = e.currentTarget;
      const firstOverloadMs = parseInt(badge.dataset.firstOverloadMs || '0', 10);
      if (firstOverloadMs > 0) {
        scrollToCenterDate(firstOverloadMs);
        saveState();
      }
    });

    // Capacity ribbon click - scroll to clicked date
    document.querySelectorAll('.capacity-day-bar-group').forEach(group => {
      group.addEventListener('click', (e) => {
        const dateMs = parseInt(e.currentTarget.dataset.dateMs || '0', 10);
        if (dateMs > 0) {
          scrollToCenterDate(dateMs);
          saveState();
        }
      });
    });

    // Dependencies toggle handler (menu item)
    document.getElementById('menuDeps')?.addEventListener('click', () => {
      saveState();
      vscode.postMessage({ command: 'toggleDependencies' });
    });

    const ganttContainer = document.querySelector('.gantt-container');

    // Build blocking graph from dependency arrows (used by focus mode)
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

    // Focus mode: click on issue to highlight its dependency chain
    let focusedIssueId = null;

    function getAllConnected(issueId, graph, reverseGraph) {
      const connected = new Set([issueId]);
      const queue = [issueId];
      // Traverse downstream (issues blocked by this one)
      while (queue.length > 0) {
        const current = queue.shift();
        const downstream = graph.get(current) || [];
        for (const dep of downstream) {
          if (!connected.has(dep)) {
            connected.add(dep);
            queue.push(dep);
          }
        }
      }
      // Traverse upstream (issues that block this one)
      const upQueue = [issueId];
      while (upQueue.length > 0) {
        const current = upQueue.shift();
        const upstream = reverseGraph.get(current) || [];
        for (const dep of upstream) {
          if (!connected.has(dep)) {
            connected.add(dep);
            upQueue.push(dep);
          }
        }
      }
      return connected;
    }

    function focusOnDependencyChain(issueId) {
      // Clear previous focus
      clearFocus();
      if (!issueId) return;

      focusedIssueId = issueId;
      const { graph, reverseGraph } = buildBlockingGraph();
      const connected = getAllConnected(issueId, graph, reverseGraph);

      // Add focus mode class to container
      ganttContainer.classList.add('focus-mode');

      // Highlight connected issues
      document.querySelectorAll('.issue-bar').forEach(bar => {
        if (connected.has(bar.dataset.issueId)) {
          bar.classList.add('focus-highlighted');
        }
      });
      document.querySelectorAll('.issue-label').forEach(label => {
        if (connected.has(label.dataset.issueId)) {
          label.classList.add('focus-highlighted');
        }
      });
      // Highlight arrows between connected issues
      document.querySelectorAll('.dependency-arrow').forEach(arrow => {
        if (connected.has(arrow.dataset.from) && connected.has(arrow.dataset.to)) {
          arrow.classList.add('focus-highlighted');
        }
      });

      announce(\`Focus: \${connected.size} issue\${connected.size !== 1 ? 's' : ''} in dependency chain\`);
    }

    function clearFocus() {
      focusedIssueId = null;
      ganttContainer.classList.remove('focus-mode');
      document.querySelectorAll('.focus-highlighted').forEach(el => el.classList.remove('focus-highlighted'));
    }

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
        e.stopImmediatePropagation();
        clearSelection();
        announce('Selection cleared');
      }
    });

    // Refresh button handler
    document.getElementById('refreshBtn')?.addEventListener('click', () => {
      document.getElementById('loadingOverlay')?.classList.add('visible');
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
      closeOnOutsideClick(picker);
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

      // Dependency arrow click to select/highlight
      let selectedArrow = null;
      timelineSvg.addEventListener('click', (e) => {
        const arrow = e.target.closest('.dependency-arrow');

        // Clear previous selection
        if (selectedArrow) {
          selectedArrow.classList.remove('selected');
          document.body.classList.remove('arrow-selection-mode');
          document.querySelectorAll('.arrow-connected').forEach(el => el.classList.remove('arrow-connected'));
          selectedArrow = null;
        }

        if (!arrow) return;

        // Select clicked arrow
        e.stopPropagation();
        selectedArrow = arrow;
        arrow.classList.add('selected');
        document.body.classList.add('arrow-selection-mode');

        // Highlight connected bars and labels
        const fromId = arrow.dataset.from;
        const toId = arrow.dataset.to;
        document.querySelectorAll(\`.issue-bar[data-issue-id="\${fromId}"], .issue-bar[data-issue-id="\${toId}"]\`)
          .forEach(bar => bar.classList.add('arrow-connected'));
        document.querySelectorAll(\`.issue-label[data-issue-id="\${fromId}"], .issue-label[data-issue-id="\${toId}"]\`)
          .forEach(label => label.classList.add('arrow-connected'));

        announce(\`Selected relation from #\${fromId} to #\${toId}\`);
      });

      // Helper to clear all arrow selections (single or multi-select)
      function clearArrowSelection() {
        document.querySelectorAll('.dependency-arrow.selected').forEach(a => a.classList.remove('selected'));
        document.body.classList.remove('arrow-selection-mode');
        document.querySelectorAll('.arrow-connected').forEach(el => el.classList.remove('arrow-connected'));
        selectedArrow = null;
      }

      // Click elsewhere to deselect arrows (cleanup previous handlers)
      if (window._ganttArrowClickHandler) {
        document.removeEventListener('click', window._ganttArrowClickHandler);
      }
      window._ganttArrowClickHandler = (e) => {
        const hasSelection = selectedArrow || document.querySelector('.dependency-arrow.selected');
        if (hasSelection && !e.target.closest('.dependency-arrow') && !e.target.closest('.blocks-badge-group') && !e.target.closest('.blocker-badge')) {
          clearArrowSelection();
        }
      };
      document.addEventListener('click', window._ganttArrowClickHandler);

      // Escape to deselect arrows (cleanup previous handler)
      if (window._ganttArrowKeyHandler) {
        document.removeEventListener('keydown', window._ganttArrowKeyHandler);
      }
      window._ganttArrowKeyHandler = (e) => {
        const hasSelection = selectedArrow || document.querySelector('.dependency-arrow.selected');
        if (e.key === 'Escape' && hasSelection) {
          e.stopImmediatePropagation();
          clearArrowSelection();
        }
      };
      document.addEventListener('keydown', window._ganttArrowKeyHandler);
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
        { label: 'Toggle Ad-hoc Budget', command: 'toggleAdHoc' },
        { label: 'Toggle Precedence', command: 'togglePrecedence' },
        { label: 'Set Internal Estimate', command: 'setInternalEstimate' },
        { label: 'Copy Link', command: 'copyLink', local: true },
        { label: 'Copy URL', command: 'copyUrl' },
      ];

      options.forEach(opt => {
        const btn = document.createElement('button');
        btn.textContent = opt.label;
        btn.addEventListener('click', async () => {
          if (opt.command === 'copyLink') {
            // Copy with HTML format for Teams/rich text support
            const bar = document.querySelector('.issue-bar[data-issue-id="' + issueId + '"]');
            const subject = bar?.dataset?.subject || 'Issue #' + issueId;
            const url = redmineBaseUrl + '/issues/' + issueId;
            const html = '<a href="' + url + '">#' + issueId + ' ' + subject + '</a>';
            const plain = url;
            try {
              await navigator.clipboard.write([
                new ClipboardItem({
                  'text/plain': new Blob([plain], { type: 'text/plain' }),
                  'text/html': new Blob([html], { type: 'text/html' })
                })
              ]);
              vscode.postMessage({ command: 'showStatus', message: 'Copied #' + issueId + ' link' });
            } catch (e) {
              // Fallback to plain text
              await navigator.clipboard.writeText(plain);
              vscode.postMessage({ command: 'showStatus', message: 'Copied #' + issueId + ' URL' });
            }
          } else if (opt.local) {
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
      closeOnOutsideClick(picker);
    }

    // Issue bar/label and project label context menus are handled by VS Code native webview context menu
    // via data-vscode-context attribute (see webview/context in package.json)

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
        { value: 'blocks', label: '🚫 Blocks', cssClass: 'rel-line-blocks',
          tooltip: 'Target cannot be closed until this issue is closed' },
        { value: 'precedes', label: '➡️ Precedes', cssClass: 'rel-line-scheduling',
          tooltip: 'This issue must complete before target can start' },
        { value: 'relates', label: '🔗 Relates to', cssClass: 'rel-line-informational',
          tooltip: 'Simple link between issues (no constraints)' },
        { value: 'duplicates', label: '📋 Duplicates', cssClass: 'rel-line-informational',
          tooltip: 'Closing target will automatically close this issue' },
        { value: 'copied_to', label: '📄 Copied to', cssClass: 'rel-line-informational',
          tooltip: 'This issue was copied to create the target issue' }
      ];
      const extendedTypes = [
        { value: 'finish_to_start', label: '⏩ Finish→Start', cssClass: 'rel-line-scheduling',
          tooltip: 'Target starts after this issue finishes (FS)' },
        { value: 'start_to_start', label: '▶️ Start→Start', cssClass: 'rel-line-scheduling',
          tooltip: 'Target starts when this issue starts (SS)' },
        { value: 'finish_to_finish', label: '⏹️ Finish→Finish', cssClass: 'rel-line-scheduling',
          tooltip: 'Target finishes when this issue finishes (FF)' },
        { value: 'start_to_finish', label: '⏪ Start→Finish', cssClass: 'rel-line-scheduling',
          tooltip: 'Target finishes when this issue starts (SF)' }
      ];
      const types = extendedRelationTypes ? [...baseTypes, ...extendedTypes] : baseTypes;

      types.forEach(t => {
        const btn = document.createElement('button');
        const swatch = document.createElement('span');
        swatch.className = 'color-swatch ' + t.cssClass;
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
      closeOnOutsideClick(picker);
    }

    // Announce to screen readers
    function announce(message) {
      const liveRegion = document.getElementById('liveRegion');
      if (liveRegion) {
        liveRegion.textContent = message;
      }
    }

    // Handle click on bar - scroll to issue start date and highlight
    // Double-click enters focus mode (highlights dependency chain)
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
        // Clear focus mode on single click
        if (focusedIssueId) {
          clearFocus();
        }
        scrollToAndHighlight(bar.dataset.issueId);
      });
      bar.addEventListener('dblclick', (e) => {
        if (dragState || linkingState) return;
        e.preventDefault();
        focusOnDependencyChain(bar.dataset.issueId);
      });
    });

    // Helper to highlight multiple arrows and their connected issues
    function highlightArrows(arrows, issueId) {
      // Clear any previous arrow selection
      document.querySelectorAll('.dependency-arrow.selected').forEach(a => a.classList.remove('selected'));
      document.querySelectorAll('.arrow-connected').forEach(el => el.classList.remove('arrow-connected'));

      if (arrows.length === 0) return;

      // Add selection mode and select all matching arrows
      document.body.classList.add('arrow-selection-mode');
      const connectedIds = new Set();
      arrows.forEach(arrow => {
        arrow.classList.add('selected');
        connectedIds.add(arrow.dataset.from);
        connectedIds.add(arrow.dataset.to);
      });

      // Highlight connected bars and labels
      connectedIds.forEach(id => {
        document.querySelectorAll(\`.issue-bar[data-issue-id="\${id}"], .issue-label[data-issue-id="\${id}"]\`)
          .forEach(el => el.classList.add('arrow-connected'));
      });

      announce(\`Highlighted \${arrows.length} dependency arrow(s) for #\${issueId}\`);
    }

    // Blocks badge click - highlight arrows FROM this issue (issues it blocks)
    document.querySelectorAll('.blocks-badge-group').forEach(badge => {
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        const issueBar = badge.closest('.issue-bar');
        if (!issueBar) return;
        const issueId = issueBar.dataset.issueId;
        const arrows = Array.from(document.querySelectorAll(\`.dependency-arrow[data-from="\${issueId}"]\`));
        highlightArrows(arrows, issueId);
      });
    });

    // Blocker badge click - highlight arrows TO this issue and navigate to first blocker
    document.querySelectorAll('.blocker-badge').forEach(badge => {
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        const issueBar = badge.closest('.issue-bar');
        if (!issueBar) return;
        const issueId = issueBar.dataset.issueId;
        const arrows = Array.from(document.querySelectorAll(\`.dependency-arrow[data-to="\${issueId}"]\`));
        highlightArrows(arrows, issueId);

        // Also navigate to first blocker if available
        const blockerId = badge.dataset.blockerId;
        if (blockerId) {
          scrollToAndHighlight(blockerId);
        }
      });
    });

    // Keyboard navigation for issue bars
    const issueBars = Array.from(document.querySelectorAll('.issue-bar'));
    const PAGE_JUMP = 10;
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
        } else if (e.key === 'Home') {
          e.preventDefault();
          issueBars[0].focus();
          announce(\`First issue: \${issueBars[0].getAttribute('aria-label')}\`);
        } else if (e.key === 'End') {
          e.preventDefault();
          issueBars[issueBars.length - 1].focus();
          announce(\`Last issue: \${issueBars[issueBars.length - 1].getAttribute('aria-label')}\`);
        } else if (e.key === 'PageDown') {
          e.preventDefault();
          const nextIdx = Math.min(index + PAGE_JUMP, issueBars.length - 1);
          issueBars[nextIdx].focus();
          announce(\`Issue \${issueBars[nextIdx].getAttribute('aria-label')}\`);
        } else if (e.key === 'PageUp') {
          e.preventDefault();
          const prevIdx = Math.max(index - PAGE_JUMP, 0);
          issueBars[prevIdx].focus();
          announce(\`Issue \${issueBars[prevIdx].getAttribute('aria-label')}\`);
        } else if (e.key === 'Tab' && e.shiftKey) {
          // Jump back to corresponding label
          const issueId = bar.dataset.issueId;
          const label = document.querySelector(\`.issue-label[data-issue-id="\${issueId}"]\`);
          if (label) {
            e.preventDefault();
            label.focus();
            announce(\`Label for issue #\${issueId}\`);
          }
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
        const cx = parseFloat(handle.dataset.cx);
        const cy = parseFloat(handle.dataset.cy);

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

    // Escape to cancel linking mode, close pickers, and clear focus
    addDocListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const picker = document.querySelector('.relation-picker');
        if (picker) {
          e.stopImmediatePropagation();
          picker.remove();
          return;
        }
        if (linkingState) {
          e.stopImmediatePropagation();
          cancelLinking();
          return;
        }
        if (focusedIssueId) {
          e.stopImmediatePropagation();
          clearFocus();
          announce('Focus cleared');
        }
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
          toggleCollapseClientSide(collapseKey);
        }
      });
    });

    // Expand/collapse all menu items
    document.getElementById('menuExpand')?.addEventListener('click', () => {
      // Use pre-computed list of ALL expandable keys (not just visible DOM elements)
      const ganttScroll = document.getElementById('ganttScroll');
      const allKeys = ganttScroll?.dataset.allExpandableKeys;
      const keys = allKeys ? JSON.parse(allKeys) : [];
      vscode.postMessage({ command: 'expandAll', keys });
    });
    document.getElementById('menuCollapse')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'collapseAll' });
    });

    // Labels click and keyboard navigation
    const allLabels = Array.from(document.querySelectorAll('.project-label, .issue-label, .time-group-label'));
    let activeLabel = null;
    const savedSelectedKey = ${JSON.stringify(this._selectedCollapseKey)};

    // Check if label is visible (not hidden by collapse)
    function isLabelVisible(label) {
      return !label.classList.contains('gantt-row-hidden') && label.getAttribute('visibility') !== 'hidden';
    }

    // Find next visible label from index (direction: 1=down, -1=up)
    function findVisibleLabel(fromIndex, direction) {
      let i = fromIndex + direction;
      while (i >= 0 && i < allLabels.length) {
        if (isLabelVisible(allLabels[i])) return { label: allLabels[i], index: i };
        i += direction;
      }
      return null;
    }

    // Scroll label into view (vertical only, for keyboard navigation)
    function scrollLabelIntoView(label) {
      const scrollContainer = document.getElementById('ganttScroll');
      const headerRow = document.querySelector('.gantt-header-row');
      if (!scrollContainer || !label) return;

      const headerHeight = headerRow?.getBoundingClientRect().height || 60;
      const labelRow = label.closest('.gantt-row');
      if (!labelRow) return;

      const rowTop = labelRow.getBoundingClientRect().top;
      const rowHeight = labelRow.getBoundingClientRect().height;
      const containerRect = scrollContainer.getBoundingClientRect();
      const visibleTop = containerRect.top + headerHeight;
      const visibleBottom = containerRect.bottom;

      // Only scroll if label is outside visible area
      if (rowTop < visibleTop) {
        // Label is above visible area - scroll up
        scrollContainer.scrollBy({ top: rowTop - visibleTop - 4, behavior: 'smooth' });
      } else if (rowTop + rowHeight > visibleBottom) {
        // Label is below visible area - scroll down
        scrollContainer.scrollBy({ top: (rowTop + rowHeight) - visibleBottom + 4, behavior: 'smooth' });
      }
    }

    function setActiveLabel(label, skipNotify = false, scrollIntoView = false, skipFocus = false) {
      if (activeLabel) activeLabel.classList.remove('active');
      activeLabel = label;
      if (label) {
        label.classList.add('active');
        if (!skipFocus) label.focus();
        if (scrollIntoView) scrollLabelIntoView(label);
        // Persist selection to extension for re-render preservation
        if (!skipNotify) {
          vscode.postMessage({ command: 'setSelectedKey', collapseKey: label.dataset.collapseKey });
        }
      }
    }

    // Restore focus to active label when webview regains focus
    window.addEventListener('focus', () => {
      if (activeLabel && isLabelVisible(activeLabel)) {
        activeLabel.focus();
      }
    });

    // Row index for O(1) lookups during collapse
    const rowIndex = new Map(); // collapseKey → { originalY, elements: [] }
    const ancestorCache = new Map(); // collapseKey → [parentKey, grandparentKey, ...]

    function buildRowIndex() {
      rowIndex.clear();
      document.querySelectorAll('[data-collapse-key][data-original-y]').forEach(el => {
        const key = el.dataset.collapseKey;
        const originalY = parseFloat(el.dataset.originalY);
        if (!rowIndex.has(key)) {
          rowIndex.set(key, { originalY, elements: [] });
        }
        rowIndex.get(key).elements.push(el);
      });
    }

    function buildAncestorCache() {
      ancestorCache.clear();
      document.querySelectorAll('[data-collapse-key][data-parent-key]').forEach(el => {
        const key = el.dataset.collapseKey;
        if (ancestorCache.has(key)) return; // Already built for this key
        const ancestors = [];
        let parentKey = el.dataset.parentKey;
        while (parentKey) {
          ancestors.push(parentKey);
          const parentEl = document.querySelector('[data-collapse-key="' + parentKey + '"]');
          parentKey = parentEl?.dataset.parentKey || null;
        }
        ancestorCache.set(key, ancestors);
      });
    }

    // Build indexes on load
    buildRowIndex();
    buildAncestorCache();

    // Helper to toggle SVG element visibility
    function setSvgVisibility(el, hidden) {
      if (hidden) {
        el.setAttribute('visibility', 'hidden');
        el.classList.add('gantt-row-hidden');
      } else {
        el.removeAttribute('visibility');
        el.classList.remove('gantt-row-hidden');
      }
    }

    // Find all descendants of a collapse key
    function findDescendants(parentKey) {
      const result = [];
      ancestorCache.forEach((ancestors, key) => {
        if (ancestors.includes(parentKey)) result.push(key);
      });
      return result;
    }

    // Client-side collapse toggle for instant response (no re-render)
    // Uses delta-based shifting: only descendants are hidden, rows below shift by delta
    function toggleCollapseClientSide(collapseKey, action) {
      const ROW_HEIGHT = ${barHeight};

      // Find the parent label element (must be a label with hasChildren)
      const parentLabel = document.querySelector('[data-collapse-key="' + collapseKey + '"].project-label, [data-collapse-key="' + collapseKey + '"].time-group-label, [data-collapse-key="' + collapseKey + '"].issue-label');
      if (!parentLabel || parentLabel.dataset.hasChildren !== 'true') return;

      const wasExpanded = parentLabel.dataset.expanded === 'true';
      const shouldExpand = action === 'expand' ? true : action === 'collapse' ? false : !wasExpanded;
      if (shouldExpand === wasExpanded) return;

      // Update chevron state
      parentLabel.dataset.expanded = shouldExpand ? 'true' : 'false';
      const chevron = parentLabel.querySelector('.collapse-toggle');
      if (chevron) chevron.classList.toggle('expanded', shouldExpand);

      // Find all descendants to hide/show
      const descendants = findDescendants(collapseKey);
      if (descendants.length === 0) return;

      const descendantSet = new Set(descendants);
      const parentEntry = rowIndex.get(collapseKey);
      const parentY = parentEntry?.originalY ?? 0;

      // Calculate delta from stripe contributions (each row owns gap BEFORE it)
      // Only count each row once (stripes are duplicated across columns)
      const countedKeys = new Set();
      let actualDelta = 0;
      document.querySelectorAll('.zebra-stripe').forEach(stripe => {
        const contributions = JSON.parse(stripe.dataset.rowContributions || '{}');
        for (const [key, contribution] of Object.entries(contributions)) {
          if (descendantSet.has(key) && !countedKeys.has(key)) {
            actualDelta += parseFloat(contribution);
            countedKeys.add(key);
          }
        }
      });

      const delta = shouldExpand ? actualDelta : -actualDelta;

      // Toggle visibility of descendants
      descendants.forEach(key => {
        const entry = rowIndex.get(key);
        if (entry) {
          entry.elements.forEach(el => {
            setSvgVisibility(el, !shouldExpand);
          });
        }
      });

      // Shift rows BELOW the parent (not descendants, not above)
      rowIndex.forEach(({ originalY, elements }, key) => {
        // Only shift rows that are below the parent and not descendants
        if (originalY > parentY && !descendants.includes(key)) {
          elements.forEach(el => {
            const transform = el.getAttribute('transform') || '';
            // Extract current X (for timeline bars)
            const xMatch = transform.match(/translate\\(([-\\d.]+)/);
            const x = xMatch ? xMatch[1] : '0';
            // Extract current Y
            const yMatch = transform.match(/translate\\([^,]+,\\s*([-\\d.]+)/);
            const currentY = yMatch ? parseFloat(yMatch[1]) : originalY;
            const newY = currentY + delta;
            el.setAttribute('transform', 'translate(' + x + ', ' + newY + ')');
          });
        }
      });

      // Update SVG heights
      const labelColumn = document.querySelector('.gantt-labels svg');
      if (labelColumn) {
        const currentHeight = parseFloat(labelColumn.getAttribute('height') || '0');
        const newHeight = currentHeight + delta;
        labelColumn.setAttribute('height', String(newHeight));
        // Don't set viewBox on labels SVG - it causes scaling issues on column resize
      }

      // Update other column heights
      const columnSelectors = [
        '.gantt-col-status svg',
        '.gantt-col-id svg',
        '.gantt-col-start svg',
        '.gantt-col-due svg',
        '.gantt-col-assignee svg'
      ];
      columnSelectors.forEach(selector => {
        const colSvg = document.querySelector(selector);
        if (!colSvg) return;
        const currentHeight = parseFloat(colSvg.getAttribute('height') || '0');
        const newHeight = currentHeight + delta;
        colSvg.setAttribute('height', String(newHeight));
      });

      // Update timeline height
      const timelineSvg = document.querySelector('.gantt-timeline svg');
      if (timelineSvg) {
        const currentHeight = parseFloat(timelineSvg.getAttribute('height') || '0');
        const newHeight = currentHeight + delta;
        timelineSvg.setAttribute('height', newHeight);
      }

      // Build set of collapsed parents for visibility checks
      const collapsedKeys = new Set();
      document.querySelectorAll('.project-label[data-has-children="true"], .time-group-label[data-has-children="true"], .issue-label[data-has-children="true"]').forEach(lbl => {
        if (lbl.dataset.expanded === 'false') {
          collapsedKeys.add(lbl.dataset.collapseKey);
        }
      });

      // Handle zebra stripes: hide stripes covering descendants, shift stripes below
      document.querySelectorAll('.zebra-stripe').forEach(stripe => {
        const originalY = parseFloat(stripe.dataset.originalY || '0');
        const contributions = JSON.parse(stripe.dataset.rowContributions || '{}');
        const contributingKeys = Object.keys(contributions);

        // Check what this stripe covers
        const coversOnlyDescendants = contributingKeys.length > 0 &&
          contributingKeys.every(key => descendantSet.has(key));
        const coversAnyDescendant = contributingKeys.some(key => descendantSet.has(key));
        const isBelowParent = originalY > parentY;

        if (coversOnlyDescendants) {
          // Stripe only covers descendants being toggled - hide/show it
          setSvgVisibility(stripe, shouldExpand);
        } else if (coversAnyDescendant) {
          // Stripe covers parent + descendants (mixed) - shrink/expand height
          if (!shouldExpand) {
            // COLLAPSING: shrink to only non-descendant rows
            let newHeight = 0;
            for (const [key, contribution] of Object.entries(contributions)) {
              if (!descendantSet.has(key)) {
                newHeight += parseFloat(contribution);
              }
            }
            stripe.setAttribute('height', String(newHeight));
          } else {
            // EXPANDING: restore original height
            stripe.setAttribute('height', stripe.dataset.originalHeight || '0');
          }
        } else if (isBelowParent) {
          // Stripe is below collapsed area - shift it
          const currentY = parseFloat(stripe.getAttribute('y') || String(originalY));
          stripe.setAttribute('y', String(currentY + delta));
        }
      });

      // Re-alternate visible stripes by Y position
      // Group stripes by Y to handle multiple columns having stripes at same Y
      const visibleStripes = Array.from(document.querySelectorAll('.zebra-stripe'))
        .filter(s => s.getAttribute('visibility') !== 'hidden');

      const stripesByY = new Map();
      visibleStripes.forEach(stripe => {
        const y = parseFloat(stripe.getAttribute('y') || '0');
        if (!stripesByY.has(y)) stripesByY.set(y, []);
        stripesByY.get(y).push(stripe);
      });

      // Sort unique Y positions and assign same opacity to all stripes at each Y
      const sortedYs = Array.from(stripesByY.keys()).sort((a, b) => a - b);
      sortedYs.forEach((y, idx) => {
        const opacity = idx % 2 === 0 ? '0.03' : '0.06';
        stripesByY.get(y).forEach(stripe => stripe.setAttribute('opacity', opacity));
      });

      // Handle indent guide lines
      document.querySelectorAll('.indent-guide-line').forEach(line => {
        const forParent = line.dataset.forParent;
        const ancestors = ancestorCache.get(forParent) || [];
        const shouldHide = collapsedKeys.has(forParent) || ancestors.some(a => collapsedKeys.has(a));
        setSvgVisibility(line, shouldHide);

        // Shift indent guides for parents below the collapsed row
        if (!shouldHide) {
          const parentOfGuide = rowIndex.get(forParent);
          if (parentOfGuide && parentOfGuide.originalY > parentY) {
            // This guide's parent is below collapsed row - shift it
            const y1 = parseFloat(line.getAttribute('y1') || '0');
            const y2 = parseFloat(line.getAttribute('y2') || '0');
            line.setAttribute('y1', y1 + delta);
            line.setAttribute('y2', y2 + delta);
          }
        }
      });

      // Toggle dependency arrows
      document.querySelectorAll('.dependency-arrow').forEach(arrow => {
        const fromId = arrow.dataset.from;
        const toId = arrow.dataset.to;
        const fromBar = document.querySelector('.issue-bar[data-issue-id="' + fromId + '"]');
        const toBar = document.querySelector('.issue-bar[data-issue-id="' + toId + '"]');
        const fromHidden = fromBar?.classList.contains('gantt-row-hidden');
        const toHidden = toBar?.classList.contains('gantt-row-hidden');
        setSvgVisibility(arrow, fromHidden || toHidden);
      });

      // Sync state to extension for persistence (no re-render)
      vscode.postMessage({ command: 'collapseStateSync', collapseKey, isExpanded: shouldExpand });
    }

    // Restore selection from previous render
    if (savedSelectedKey) {
      const savedLabel = allLabels.find(el => el.dataset.collapseKey === savedSelectedKey);
      if (savedLabel) {
        setActiveLabel(savedLabel, true);
      }
    }

    allLabels.forEach((el, index) => {
      el.addEventListener('click', (e) => {
        // Chevron has its own handler with stopPropagation - won't reach here
        if (e.target.classList?.contains('collapse-toggle') || e.target.classList?.contains('chevron-hit-area')) return;

        // Open quick-pick for issues (skip focus to avoid stealing from dialog)
        const issueId = el.dataset.issueId;
        if (issueId) {
          setActiveLabel(el, false, false, true); // skipFocus=true
          vscode.postMessage({ command: 'openIssue', issueId: parseInt(issueId, 10) });
        } else {
          setActiveLabel(el);
        }
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
          case 'ArrowUp': {
            e.preventDefault();
            const prev = findVisibleLabel(index, -1);
            if (prev) setActiveLabel(prev.label, false, true);
            break;
          }
          case 'ArrowDown': {
            e.preventDefault();
            const next = findVisibleLabel(index, 1);
            if (next) setActiveLabel(next.label, false, true);
            break;
          }
          case 'ArrowLeft':
            e.preventDefault();
            // VS Code behavior: if expanded, collapse; if collapsed, go to parent
            if (el.dataset.hasChildren === 'true' && el.dataset.expanded === 'true') {
              toggleCollapseClientSide(collapseKey, 'collapse');
            } else if (el.dataset.parentKey) {
              // Navigate to parent
              const parent = allLabels.find(l => l.dataset.collapseKey === el.dataset.parentKey);
              if (parent) setActiveLabel(parent, false, true);
            }
            break;
          case 'ArrowRight':
            e.preventDefault();
            // VS Code behavior: if collapsed, expand; if expanded, go to first child
            if (el.dataset.hasChildren === 'true' && el.dataset.expanded === 'false') {
              toggleCollapseClientSide(collapseKey, 'expand');
            } else if (el.dataset.hasChildren === 'true' && el.dataset.expanded === 'true') {
              // Navigate to first visible child
              const firstChild = allLabels.find(l => l.dataset.parentKey === collapseKey && isLabelVisible(l));
              if (firstChild) setActiveLabel(firstChild, false, true);
            }
            break;
          case 'Home': {
            e.preventDefault();
            const first = findVisibleLabel(-1, 1);
            if (first) setActiveLabel(first.label, false, true);
            break;
          }
          case 'End': {
            e.preventDefault();
            const last = findVisibleLabel(allLabels.length, -1);
            if (last) setActiveLabel(last.label, false, true);
            break;
          }
          case 'PageDown': {
            e.preventDefault();
            // Skip ~10 visible labels
            let target = index, count = 0;
            while (count < 10 && target < allLabels.length - 1) {
              const next = findVisibleLabel(target, 1);
              if (!next) break;
              target = next.index;
              count++;
            }
            if (count > 0) setActiveLabel(allLabels[target], false, true);
            break;
          }
          case 'PageUp': {
            e.preventDefault();
            // Skip ~10 visible labels
            let target = index, count = 0;
            while (count < 10 && target > 0) {
              const prev = findVisibleLabel(target, -1);
              if (!prev) break;
              target = prev.index;
              count++;
            }
            if (count > 0) setActiveLabel(allLabels[target], false, true);
            break;
          }
          case 'Tab':
            // Jump to corresponding bar in timeline
            if (!e.shiftKey && !isNaN(issueId)) {
              const bar = document.querySelector(\`.issue-bar[data-issue-id="\${issueId}"]\`);
              if (bar) {
                e.preventDefault();
                bar.focus();
                announce(\`Timeline bar for issue #\${issueId}\`);
              }
            }
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
          // Use SVG rect directly - getBoundingClientRect accounts for scroll
          const svg = document.querySelector('#ganttTimeline svg');
          const rect = svg.getBoundingClientRect();
          const endX = evt.clientX - rect.left;
          const endY = evt.clientY - rect.top;

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

    // Undo menu item
    menuUndo?.addEventListener('click', () => {
      if (menuUndo.hasAttribute('disabled')) return;
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

    // Redo menu item
    menuRedo?.addEventListener('click', () => {
      if (menuRedo.hasAttribute('disabled')) return;
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
      // Skip if user is typing in an input/select
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

      if (modKey && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        menuUndo?.click();
      } else if (modKey && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        menuRedo?.click();
      } else if (modKey && e.key === 'y') {
        e.preventDefault();
        menuRedo?.click();
      }
      // Zoom shortcuts (1-5)
      else if (e.key >= '1' && e.key <= '5') {
        const zoomSelect = document.getElementById('zoomSelect');
        const levels = ['day', 'week', 'month', 'quarter', 'year'];
        zoomSelect.value = levels[parseInt(e.key) - 1];
        zoomSelect.dispatchEvent(new Event('change'));
      }
      // Toggle shortcuts (trigger menu items)
      else if (e.key.toLowerCase() === 'h') { document.getElementById('menuHeatmap')?.click(); }
      else if (e.key.toLowerCase() === 'y') { document.getElementById('menuCapacity')?.click(); }
      else if (e.key.toLowerCase() === 'i') { document.getElementById('menuIntensity')?.click(); }
      else if (e.key.toLowerCase() === 'd') { document.getElementById('menuDeps')?.click(); }
      else if (e.key.toLowerCase() === 'v') {
        // Toggle view focus between Project and Person
        const viewSelect = document.getElementById('viewFocusSelect');
        viewSelect.value = viewSelect.value === 'project' ? 'person' : 'project';
        viewSelect.dispatchEvent(new Event('change'));
      }
      // Action shortcuts
      else if (e.key.toLowerCase() === 'r') { document.getElementById('refreshBtn')?.click(); }
      else if (e.key.toLowerCase() === 't') { scrollToToday(); }
      else if (e.key.toLowerCase() === 'e') { document.getElementById('menuExpand')?.click(); }
      else if (e.key.toLowerCase() === 'c' && !modKey) { document.getElementById('menuCollapse')?.click(); }
      // Health filter shortcut (F cycles through health filters, skip if Ctrl/Cmd held)
      else if (e.key.toLowerCase() === 'f' && !modKey) {
        e.preventDefault();
        document.getElementById('menuFilterHealth')?.click();
      }
      // Jump to next blocked issue (B)
      else if (e.key.toLowerCase() === 'b') {
        e.preventDefault();
        const blockedBars = Array.from(document.querySelectorAll('.issue-bar[data-issue-id]'))
          .filter(bar => bar.querySelector('.blocker-badge'));
        if (blockedBars.length === 0) {
          announce('No blocked issues');
          return;
        }
        const focusedBar = document.activeElement?.closest('.issue-bar');
        const currentIdx = focusedBar ? blockedBars.indexOf(focusedBar) : -1;
        const nextIdx = (currentIdx + 1) % blockedBars.length;
        const nextBar = blockedBars[nextIdx];
        scrollToAndHighlight(nextBar.dataset.issueId);
        nextBar.focus();
        announce('Blocked issue ' + (nextIdx + 1) + ' of ' + blockedBars.length);
      }
      // Arrow key date nudging for focused issue bars
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const focusedBar = document.activeElement?.closest('.issue-bar:not(.parent-bar)');
        if (!focusedBar) return;
        e.preventDefault();
        const issueId = parseInt(focusedBar.dataset.issueId);
        const startDate = focusedBar.dataset.startDate;
        const dueDate = focusedBar.dataset.dueDate;
        if (!startDate && !dueDate) return;

        const delta = e.key === 'ArrowRight' ? 1 : -1;
        const addDays = (dateStr, days) => {
          const d = new Date(dateStr + 'T00:00:00');
          d.setDate(d.getDate() + days);
          return d.toISOString().slice(0, 10);
        };

        let newStart = null, newDue = null;
        if (e.shiftKey && dueDate) {
          // Shift+Arrow: resize end date only
          newDue = addDays(dueDate, delta);
        } else if (e.altKey && startDate) {
          // Alt+Arrow: resize start date only
          newStart = addDays(startDate, delta);
        } else {
          // Plain Arrow: move entire bar
          if (startDate) newStart = addDays(startDate, delta);
          if (dueDate) newDue = addDays(dueDate, delta);
        }

        if (newStart || newDue) {
          saveState();
          undoStack.push({
            issueId,
            oldStartDate: newStart ? startDate : null,
            oldDueDate: newDue ? dueDate : null,
            newStartDate: newStart,
            newDueDate: newDue
          });
          redoStack.length = 0;
          updateUndoRedoButtons();
          vscode.postMessage({ command: 'updateDates', issueId, startDate: newStart, dueDate: newDue });
        }
      }
      // Quick search (/)
      else if (e.key === '/' && !modKey) {
        e.preventDefault();
        showQuickSearch();
      }
      // Keyboard shortcuts help (?)
      else if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        toggleKeyboardHelp();
      }
    });

    // Quick search overlay
    let quickSearchEl = null;
    function showQuickSearch() {
      if (quickSearchEl) { quickSearchEl.remove(); }
      quickSearchEl = document.createElement('div');
      quickSearchEl.className = 'quick-search';
      quickSearchEl.innerHTML = \`
        <input type="text" placeholder="Search issues..." autofocus />
      \`;
      document.body.appendChild(quickSearchEl);
      const input = quickSearchEl.querySelector('input');
      input.focus();

      const labels = Array.from(document.querySelectorAll('.issue-label'));
      input.addEventListener('input', () => {
        const query = input.value.toLowerCase();
        labels.forEach(label => {
          const text = label.getAttribute('aria-label')?.toLowerCase() || '';
          const match = query && text.includes(query);
          label.classList.toggle('search-match', match);
        });
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closeQuickSearch();
        } else if (e.key === 'Enter') {
          const match = document.querySelector('.issue-label.search-match');
          if (match) {
            closeQuickSearch();
            match.focus();
            scrollToAndHighlight(match.dataset.issueId);
          }
        }
      });

      input.addEventListener('blur', () => setTimeout(closeQuickSearch, 150));
    }

    function closeQuickSearch() {
      if (quickSearchEl) {
        quickSearchEl.remove();
        quickSearchEl = null;
        document.querySelectorAll('.search-match').forEach(el => el.classList.remove('search-match'));
      }
    }

    // Keyboard help overlay
    let keyboardHelpEl = null;
    function toggleKeyboardHelp() {
      if (keyboardHelpEl) {
        keyboardHelpEl.remove();
        keyboardHelpEl = null;
        return;
      }
      keyboardHelpEl = document.createElement('div');
      keyboardHelpEl.className = 'keyboard-help';
      keyboardHelpEl.innerHTML = \`
        <div class="keyboard-help-content">
          <h3>Keyboard Shortcuts</h3>
          <div class="shortcut-grid">
            <div class="shortcut-section">
              <h4>Navigation</h4>
              <div><kbd>↑</kbd><kbd>↓</kbd> Move between issues</div>
              <div><kbd>Home</kbd><kbd>End</kbd> First/last issue</div>
              <div><kbd>PgUp</kbd><kbd>PgDn</kbd> Jump 10 rows</div>
              <div><kbd>Tab</kbd> Label → Bar</div>
              <div><kbd>Shift+Tab</kbd> Bar → Label</div>
            </div>
            <div class="shortcut-section">
              <h4>Date Editing</h4>
              <div><kbd>←</kbd><kbd>→</kbd> Move bar ±1 day</div>
              <div><kbd>Shift+←/→</kbd> Resize end</div>
              <div><kbd>Alt+←/→</kbd> Resize start</div>
              <div><kbd>Ctrl+Z</kbd> Undo</div>
              <div><kbd>Ctrl+Y</kbd> Redo</div>
            </div>
            <div class="shortcut-section">
              <h4>View</h4>
              <div><kbd>1-5</kbd> Zoom levels</div>
              <div><kbd>H</kbd> Heatmap</div>
              <div><kbd>D</kbd> Dependencies</div>
              <div><kbd>C</kbd> Critical path</div>
              <div><kbd>T</kbd> Today</div>
            </div>
            <div class="shortcut-section">
              <h4>Health & Other</h4>
              <div><kbd>F</kbd> Cycle health filter</div>
              <div><kbd>B</kbd> Next blocked issue</div>
              <div><kbd>/</kbd> Quick search</div>
              <div><kbd>S</kbd> Cycle sort</div>
              <div><kbd>R</kbd> Refresh</div>
              <div><kbd>Esc</kbd> Clear/cancel</div>
            </div>
          </div>
          <p class="keyboard-help-close">Press <kbd>?</kbd> or <kbd>Esc</kbd> to close</p>
        </div>
      \`;
      document.body.appendChild(keyboardHelpEl);
      keyboardHelpEl.addEventListener('click', (e) => {
        if (e.target === keyboardHelpEl) toggleKeyboardHelp();
      });
    }

    // Close help on Escape
    addDocListener('keydown', (e) => {
      if (e.key === 'Escape' && keyboardHelpEl) {
        e.stopImmediatePropagation();
        toggleKeyboardHelp();
      }
    });

    // Scroll to today marker (centered in visible timeline area)
    const todayX = ${Math.round(todayX)};
    const todayInRange = ${todayInRange};
    function scrollToToday() {
      if (!todayInRange) {
        vscode.postMessage({ command: 'todayOutOfRange' });
        return;
      }
      if (ganttScroll) {
        const stickyLeft = document.querySelector('.gantt-body .gantt-sticky-left');
        const stickyWidth = stickyLeft?.offsetWidth ?? 0;
        const visibleTimelineWidth = ganttScroll.clientWidth - stickyWidth;
        ganttScroll.scrollLeft = Math.max(0, todayX - visibleTimelineWidth / 2);
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
      if (bar && ganttScroll) {
        const barRect = bar.getBoundingClientRect();
        const scrollRect = ganttScroll.getBoundingClientRect();
        const scrollLeft = ganttScroll.scrollLeft + barRect.left - scrollRect.left - 100;
        ganttScroll.scrollTo({ left: Math.max(0, scrollLeft), behavior: 'smooth' });
        bar.classList.add('highlighted');
        setTimeout(() => bar.classList.remove('highlighted'), 1500);
      }
    }

    // Restore scroll position or scroll to today on initial load
    // Defer to next frame to avoid blocking initial paint and batch layout reads
    requestAnimationFrame(() => {
      if (savedCenterDateMs !== null && ganttScroll) {
        // Date-based restore: works correctly when date range changes
        // Clamp to current date range if saved date is outside
        const clampedDateMs = Math.max(minDateMs, Math.min(maxDateMs, savedCenterDateMs));
        // Always scroll to clamped date (nearest edge if out of range)
        scrollToCenterDate(clampedDateMs);
        if (savedScrollTop !== null) {
          ganttScroll.scrollTop = savedScrollTop;
        }
        savedCenterDateMs = null;
        savedScrollTop = null;
      } else if (savedScrollLeft !== null && ganttScroll) {
        // Legacy pixel position (deprecated, kept for backward compat)
        ganttScroll.scrollLeft = savedScrollLeft;
        if (savedScrollTop !== null) {
          ganttScroll.scrollTop = savedScrollTop;
        }
        savedScrollLeft = null;
        savedScrollTop = null;
      } else {
        scrollToToday();
      }
      // Initialize minimap viewport (batched with scroll restoration)
      updateMinimapViewport();
      // Allow scroll state saving after restoration completes
      restoringScroll = false;
    });

    // Today button handler
    document.getElementById('todayBtn')?.addEventListener('click', scrollToToday);

    // Column resize handling
    const resizeHandle = document.getElementById('resizeHandle');
    const resizeHandleHeader = document.getElementById('resizeHandleHeader');
    let isResizing = false;
    let resizeStartX = 0;
    let resizeStartWidth = 0;
    let activeResizeHandle = null;

    function startResize(e, handle) {
      isResizing = true;
      activeResizeHandle = handle;
      resizeStartX = e.clientX;
      resizeStartWidth = labelsColumn.offsetWidth;
      handle.classList.add('dragging');
      document.body.classList.add('cursor-col-resize', 'user-select-none');
      e.preventDefault();
    }

    resizeHandle?.addEventListener('mousedown', (e) => startResize(e, resizeHandle));
    resizeHandleHeader?.addEventListener('mousedown', (e) => startResize(e, resizeHandleHeader));

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
        const newWidth = Math.min(600, Math.max(120, resizeStartWidth + delta));
        // Resize both header and body labels columns + inner SVG
        if (ganttLeftHeader) ganttLeftHeader.style.width = newWidth + 'px';
        if (labelsColumn) {
          labelsColumn.style.width = newWidth + 'px';
          const labelsSvg = labelsColumn.querySelector('svg');
          if (labelsSvg) labelsSvg.setAttribute('width', String(newWidth));
        }
        // Update capacity ribbon label width (label + resize handle + extra columns)
        const capacityLabel = document.querySelector('.capacity-ribbon-label');
        if (capacityLabel) {
          capacityLabel.style.width = (newWidth + ${resizeHandleWidth + extraColumnsWidth}) + 'px';
        }
        updateMinimapPosition();
      });
    });

    addDocListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        activeResizeHandle?.classList.remove('dragging');
        activeResizeHandle = null;
        document.body.classList.remove('cursor-col-resize', 'user-select-none');
        saveState(); // Persist new column width
      }
    });

    // Auto-hide loading overlay after content renders
    requestAnimationFrame(() => {
      document.getElementById('loadingOverlay')?.classList.remove('visible');
    });
  </script>
</body>
</html>`;
  }

  private _getEmptyHtml(): string {
    const nonce = getNonce();
    const message = "No issues with dates to display. Add start_date or due_date to your issues.";
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
        return "⚠️ Overbooked: Not enough time to complete before due date";
      case "at-risk":
        return "⏰ At Risk: Tight schedule with little buffer";
      case "on-track":
        return "✅ On Track: Sufficient time remaining";
      case "completed":
        return "🎉 Completed: Issue is done";
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

  /**
   * Format health data as tooltip text
   */
  private formatHealthTooltip(health: ProjectHealth, description?: string): string {
    const lines: string[] = [];

    // Description first - this is the primary value
    if (description && description.trim()) {
      lines.push(description.trim());
      lines.push("");
    }

    // Health summary
    lines.push(`${health.progress}% · ${health.counts.closed}/${health.counts.closed + health.counts.open} done`);

    // Attention items (compact)
    const alerts: string[] = [];
    if (health.counts.overdue > 0) alerts.push(`🔴 ${health.counts.overdue} overdue`);
    if (health.counts.blocked > 0) alerts.push(`⚠ ${health.counts.blocked} blocked`);
    if (health.counts.atRisk > 0) alerts.push(`⏰ ${health.counts.atRisk} at risk`);
    if (alerts.length > 0) {
      lines.push(alerts.join(" · "));
    }

    // Hours (if tracked)
    if (health.hours.estimated > 0) {
      lines.push(`${health.hours.spent}h / ${health.hours.estimated}h`);
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
