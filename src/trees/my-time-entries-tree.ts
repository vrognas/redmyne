import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { TimeEntry } from "../redmine/models/time-entry";
import { formatHoursAsHHMM } from "../utilities/time-input";
import { BaseTreeProvider } from "../shared/base-tree-provider";
import { adHocTracker } from "../utilities/adhoc-tracker";
import { parseTargetIssueId } from "../utilities/contribution-calculator";
import {
  MonthlyScheduleOverrides,
  countAvailableHoursMonthly,
  getHoursForDateMonthly,
} from "../utilities/monthly-schedule";
import { clearFlexibilityCache, getWeeklySchedule } from "../utilities/flexibility-calculator";
import {
  getWeekStart,
  getDateRange,
  getISOWeekNumber,
  getISOWeekYear,
  getWeekDateRange,
  formatLocalDate,
} from "../utilities/date-utils";
import { SortConfig, TimeEntrySortField } from "../redmine/models/common";
import type { DraftQueue } from "../draft-mode/draft-queue";
import type { DraftOperation } from "../draft-mode/draft-operation";

export interface TimeEntryNode {
  id?: string; // Stable ID for preserving expansion state
  label: string;
  description?: string;
  tooltip?: string | vscode.MarkdownString;
  iconPath?: vscode.ThemeIcon;
  collapsibleState: vscode.TreeItemCollapsibleState;
  contextValue?: string;
  type: "loading" | "group" | "week-group" | "day-group" | "month-group" | "week-subgroup" | "entry" | "load-earlier";
  _cachedEntries?: TimeEntry[];
  _entry?: TimeEntry;
  _dateRange?: { start: string; end: string }; // For filling empty working days
  _date?: string; // ISO date for day-group nodes (YYYY-MM-DD)
  _weekStart?: string; // ISO date for week start (YYYY-MM-DD) for copy/paste
  _monthYear?: { year: number; month: number }; // For lazy-loaded month nodes
  _isDraft?: boolean; // True for draft time entries
}

/** Generate stable negative ID from UUID string */
function uuidToNegativeId(uuid: string): number {
  // Use first 12 hex chars of UUID as stable number (max ~281 trillion)
  const hex = uuid.replace(/-/g, "").slice(0, 12);
  return -parseInt(hex, 16);
}

/** Convert draft create operation to TimeEntry-like object for display */
function draftOperationToTimeEntry(op: DraftOperation): TimeEntry | null {
  if (op.type !== "createTimeEntry") return null;
  const data = op.http.data?.time_entry as Record<string, unknown> | undefined;
  if (!data) return null;

  return {
    id: op.resourceId ?? uuidToNegativeId(op.id), // Stable negative ID from UUID
    issue_id: data.issue_id as number,
    issue: { id: data.issue_id as number },
    activity_id: data.activity_id as number,
    activity: { id: data.activity_id as number, name: "" },
    hours: String(data.hours),
    comments: (data.comments as string) ?? "",
    spent_on: (data.spent_on as string) ?? formatLocalDate(new Date()),
  };
}

/**
 * Apply all draft operations to server entries:
 * - Create: add new draft entries
 * - Update: modify existing entries with draft values
 * - Delete: remove entries from display
 */
function applyDraftsToEntries(
  serverEntries: TimeEntry[],
  draftOps: DraftOperation[]
): TimeEntry[] {
  // Build maps for quick lookup
  const deleteIds = new Set<number>();
  const updateMap = new Map<number, DraftOperation>();
  const creates: TimeEntry[] = [];

  for (const op of draftOps) {
    if (op.type === "deleteTimeEntry" && op.resourceId) {
      deleteIds.add(op.resourceId);
    } else if (op.type === "updateTimeEntry" && op.resourceId) {
      updateMap.set(op.resourceId, op);
    } else if (op.type === "createTimeEntry") {
      const entry = draftOperationToTimeEntry(op);
      if (entry) creates.push(entry);
    }
  }

  // Process server entries: apply updates, filter deletes
  const result: TimeEntry[] = [];
  for (const entry of serverEntries) {
    if (deleteIds.has(entry.id)) continue; // Skip deleted entries

    const updateOp = updateMap.get(entry.id);
    if (updateOp) {
      // Apply draft updates to entry
      const data = updateOp.http.data?.time_entry as Record<string, unknown> | undefined;
      if (data) {
        result.push({
          ...entry,
          hours: data.hours !== undefined ? String(data.hours) : entry.hours,
          comments: data.comments !== undefined ? (data.comments as string) : entry.comments,
          activity_id: data.activity_id !== undefined ? (data.activity_id as number) : entry.activity_id,
          // Mark as modified (use negative ID offset for visual indicator)
          _isDraftModified: true,
        } as TimeEntry & { _isDraftModified?: boolean });
      } else {
        result.push(entry);
      }
    } else {
      result.push(entry);
    }
  }

  // Add draft creates (at beginning for visibility)
  return [...creates, ...result];
}

export class MyTimeEntriesTreeDataProvider extends BaseTreeProvider<TimeEntryNode> {
  private static readonly INITIAL_MONTHS = 3;
  private static readonly LOAD_BATCH_SIZE = 3;

  private isLoading = false;
  server?: RedmineServer;
  private issueCache = new Map<number, { id: number; subject: string; projectId?: number; project: string; client?: string }>();
  private expandedIds = new Set<string>();
  private monthlySchedules: MonthlyScheduleOverrides = {};
  private showAllUsers = false; // false = my entries only, true = all users
  private entrySort: SortConfig<TimeEntrySortField> | null = null;
  private draftQueue?: DraftQueue;
  private draftQueueDisposable?: { dispose: () => void };

  // Lazy loading state for month nodes
  private visibleMonths: { year: number; month: number }[] = [];
  private loadedMonthEntries = new Map<string, TimeEntry[]>(); // key: "YYYY-MM"
  private loadingMonths = new Set<string>(); // key: "YYYY-MM"
  private todayEntries?: TimeEntry[];
  private weekEntries?: TimeEntry[];

  constructor() {
    super();
    this.initializeVisibleMonths();
    // Refresh when working hours config changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("redmyne.workingHours")) {
          clearFlexibilityCache();
                    this._onDidChangeTreeData.fire(undefined);
        }
      })
    );
  }

  private initializeVisibleMonths(): void {
    const now = new Date();
    this.visibleMonths = [];
    for (let i = 0; i < MyTimeEntriesTreeDataProvider.INITIAL_MONTHS; i++) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      this.visibleMonths.push({ year: date.getFullYear(), month: date.getMonth() });
    }
  }

  /**
   * Set monthly schedule overrides for date-specific hour calculations
   */
  setMonthlySchedules(overrides: MonthlyScheduleOverrides): void {
    this.monthlySchedules = overrides;
  }

  /**
   * Connect tree view to track expansion state
   */
  setTreeView(treeView: vscode.TreeView<TimeEntryNode>): void {
    this.disposables.push(
      treeView.onDidExpandElement((e) => {
        if (e.element.id) this.expandedIds.add(e.element.id);
      }),
      treeView.onDidCollapseElement((e) => {
        if (e.element.id) this.expandedIds.delete(e.element.id);
      })
    );
  }

  /**
   * Get collapsible state preserving expansion from previous render
   */
  private getCollapsibleState(id: string, hasChildren: boolean): vscode.TreeItemCollapsibleState {
    if (!hasChildren) return vscode.TreeItemCollapsibleState.None;
    return this.expandedIds.has(id)
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
  }

  setServer(server: RedmineServer | undefined): void {
    this.server = server;
    // Clear cache when server changes
    this.issueCache.clear();
        this.loadedMonthEntries.clear();
    this.loadingMonths.clear();
    this.todayEntries = undefined;
    this.weekEntries = undefined;
    this.initializeVisibleMonths();
  }

  /**
   * Set draft queue to show draft time entries
   */
  setDraftQueue(queue: DraftQueue | undefined): void {
    // Dispose previous subscription
    this.draftQueueDisposable?.dispose();
    this.draftQueue = queue;

    if (queue) {
      // Refresh tree when draft queue changes
      this.draftQueueDisposable = queue.onDidChange(() => {
        this._onDidChangeTreeData.fire(undefined);
      });
    }
  }

  override refresh(): void {
    // Clear all caches
    this.issueCache.clear();
        this.loadedMonthEntries.clear();
    this.loadingMonths.clear();
    this.todayEntries = undefined;
    this.weekEntries = undefined;
    // Fetch new data in background
    if (!this.isLoading && this.server) {
      this.isLoading = true;
      this.loadTodayAndThisWeek();
    }
  }

  private async loadTodayAndThisWeek(): Promise<void> {
    if (!this.server) {
      this.isLoading = false;
      return;
    }

    try {
      const today = formatLocalDate(new Date());
      const weekStart = getWeekStart();

      // Only fetch this week's entries (includes today)
      const result = await this.server.getTimeEntries({
        from: weekStart,
        to: today,
        allUsers: this.showAllUsers,
      });

      const allEntries = result.time_entries;
      this.todayEntries = allEntries.filter((e) => e.spent_on === today);
      this.weekEntries = allEntries;
    } catch {
      this.todayEntries = [];
      this.weekEntries = [];
    } finally {
      this.isLoading = false;
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  private getMonthKey(year: number, month: number): string {
    return `${year}-${String(month + 1).padStart(2, "0")}`;
  }

  private getMonthDateRange(monthYear: { year: number; month: number }): { start: string; end: string } {
    const start = new Date(monthYear.year, monthYear.month, 1);
    const end = new Date(monthYear.year, monthYear.month + 1, 0); // Last day of month
    const today = new Date();
    // Cap end at today if current/future month
    if (end > today) {
      return { start: formatLocalDate(start), end: formatLocalDate(today) };
    }
    return { start: formatLocalDate(start), end: formatLocalDate(end) };
  }

  private createMonthNode(year: number, month: number): TimeEntryNode {
    const monthKey = this.getMonthKey(year, month);
    const nodeId = `month-${monthKey}`;
    const date = new Date(year, month, 1);
    const monthName = date.toLocaleDateString("en-US", { month: "long" });
    const shortMonthName = date.toLocaleDateString("en-US", { month: "short" });

    // Determine label: "This Month (Jan)", "Last Month (Dec)", or "November 2025"
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const lastMonthDate = new Date(currentYear, currentMonth - 1, 1);
    const lastMonthYear = lastMonthDate.getFullYear();
    const lastMonth = lastMonthDate.getMonth();

    let label: string;
    if (year === currentYear && month === currentMonth) {
      label = `This Month (${shortMonthName})`;
    } else if (year === lastMonthYear && month === lastMonth) {
      label = `Last Month (${shortMonthName})`;
    } else {
      label = `${monthName} ${year}`;
    }

    const isLoaded = this.loadedMonthEntries.has(monthKey);
    const entries = this.loadedMonthEntries.get(monthKey) || [];
    const total = calculateTotal(entries);

    let description = "";
    if (isLoaded) {
      const defaultSchedule = getWeeklySchedule();
      const { start, end } = this.getMonthDateRange({ year, month });
      const available = countAvailableHoursMonthly(
        new Date(start + "T12:00:00"),
        new Date(end + "T12:00:00"),
        this.monthlySchedules,
        defaultSchedule
      );
      description = formatHoursWithComparison(total, available);
    }

    return {
      id: nodeId,
      label,
      description,
      collapsibleState: this.getCollapsibleState(nodeId, true),
      type: "month-group",
      _monthYear: { year, month },
    };
  }

  private async loadMonthEntries(monthYear: { year: number; month: number }): Promise<TimeEntry[]> {
    if (!this.server) return [];

    const monthKey = this.getMonthKey(monthYear.year, monthYear.month);

    // Return cached if already loaded
    if (this.loadedMonthEntries.has(monthKey)) {
      return this.loadedMonthEntries.get(monthKey)!;
    }

    // Return empty if already loading (avoid duplicate calls)
    if (this.loadingMonths.has(monthKey)) {
      return [];
    }

    this.loadingMonths.add(monthKey);
    try {
      const { start, end } = this.getMonthDateRange(monthYear);
      const result = await this.server.getTimeEntries({
        from: start,
        to: end,
        allUsers: this.showAllUsers,
      });
      this.loadedMonthEntries.set(monthKey, result.time_entries);
      return result.time_entries;
    } catch {
      this.loadedMonthEntries.set(monthKey, []);
      return [];
    } finally {
      this.loadingMonths.delete(monthKey);
    }
  }

  loadEarlierMonths(): void {
    const lastVisible = this.visibleMonths[this.visibleMonths.length - 1];
    for (let i = 1; i <= MyTimeEntriesTreeDataProvider.LOAD_BATCH_SIZE; i++) {
      const date = new Date(lastVisible.year, lastVisible.month - i, 1);
      this.visibleMonths.push({ year: date.getFullYear(), month: date.getMonth() });
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(element?: TimeEntryNode): Promise<TimeEntryNode[]> {
    // No server configured - return empty
    if (!this.server) {
      return [];
    }

    // Root level - Today, This Week, month nodes, Load Earlier
    if (!element) {
      // If today/week not loaded yet, trigger load
      if (this.todayEntries === undefined && !this.isLoading) {
        this.isLoading = true;
        this.loadTodayAndThisWeek();
        return [{
          label: "Loading...",
          iconPath: new vscode.ThemeIcon("loading~spin"),
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          type: "loading",
        }];
      }

      // Still loading
      if (this.isLoading) {
        return [{
          label: "Loading...",
          iconPath: new vscode.ThemeIcon("loading~spin"),
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          type: "loading",
        }];
      }

      const today = formatLocalDate(new Date());
      const weekStart = getWeekStart();
      // Calculate week end (Sunday) for draft filtering
      const weekStartDate = new Date(weekStart);
      const weekEndDate = new Date(weekStartDate);
      weekEndDate.setDate(weekEndDate.getDate() + 6);
      const weekEnd = formatLocalDate(weekEndDate);
      const now = new Date();
      const dayName = now.toLocaleDateString("en-US", { weekday: "short" });
      const dayNum = now.getDate();
      const weekNum = getISOWeekNumber(now);
      const defaultSchedule = getWeeklySchedule();

      // Apply all draft operations (create/update/delete) to server entries
      const draftOps = this.draftQueue?.getAll() || [];
      const todayWithDrafts = applyDraftsToEntries(
        (this.todayEntries || []).filter(e => e.spent_on === today),
        draftOps.filter(op => {
          const data = op.http.data?.time_entry as Record<string, unknown> | undefined;
          return data?.spent_on === today || (op.resourceId && (this.todayEntries || []).some(e => e.id === op.resourceId));
        })
      );
      const weekWithDrafts = applyDraftsToEntries(
        this.weekEntries || [],
        draftOps.filter(op => {
          const data = op.http.data?.time_entry as Record<string, unknown> | undefined;
          const spentOn = data?.spent_on as string | undefined;
          // Include drafts for any day in the week (Mon-Sun), not just up to today
          if (spentOn && spentOn >= weekStart && spentOn <= weekEnd) return true;
          // Include ops targeting existing week entries
          return op.resourceId && (this.weekEntries || []).some(e => e.id === op.resourceId);
        })
      );

      const todayTotal = calculateTotal(todayWithDrafts);
      const weekTotal = calculateTotal(weekWithDrafts);
      const todayAvailable = getHoursForDateMonthly(new Date(), this.monthlySchedules, defaultSchedule);
      const weekAvailable = countAvailableHoursMonthly(
        new Date(weekStart),
        new Date(today),
        this.monthlySchedules,
        defaultSchedule
      );

      const nodes: TimeEntryNode[] = [
        {
          id: "group-today",
          label: `Today (${dayName} ${dayNum})`,
          description: formatHoursWithComparison(todayTotal, todayAvailable),
          collapsibleState: this.getCollapsibleState("group-today", true),
          type: "group",
          contextValue: "day-group",
          _cachedEntries: todayWithDrafts,
          _date: today,
        },
        {
          id: "group-week",
          label: `This Week (${weekNum})`,
          description: formatHoursWithComparison(weekTotal, weekAvailable),
          tooltip: "Shows working days from Monday up to today",
          collapsibleState: this.getCollapsibleState("group-week", true),
          type: "week-group",
          contextValue: "week-group",
          _cachedEntries: weekWithDrafts,
          _dateRange: { start: weekStart, end: today },
          _weekStart: weekStart,
        },
      ];

      // Add visible month nodes
      for (const { year, month } of this.visibleMonths) {
        nodes.push(this.createMonthNode(year, month));
      }

      // Add "Load Earlier..." node
      nodes.push({
        id: "load-earlier",
        label: "Load another 3 months",
        iconPath: new vscode.ThemeIcon("history"),
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        type: "load-earlier",
        contextValue: "load-earlier",
      });

      return nodes;
    }

    // Week group - return day groups
    if (element.type === "week-group" && element._cachedEntries) {
      return this.groupEntriesByDay(element._cachedEntries, element._dateRange, "week");
    }

    // Month group - lazy load entries
    if (element.type === "month-group" && element._monthYear) {
      const monthKey = this.getMonthKey(element._monthYear.year, element._monthYear.month);

      // Check if currently loading
      if (this.loadingMonths.has(monthKey)) {
        return [{
          label: "Loading...",
          iconPath: new vscode.ThemeIcon("loading~spin"),
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          type: "loading",
        }];
      }

      // Load entries if not cached
      if (!this.loadedMonthEntries.has(monthKey)) {
        // Start loading and show loading state
        this.loadMonthEntries(element._monthYear).then(() => {
          // Refresh this node and its parent to update description
          this._onDidChangeTreeData.fire(element);
          this._onDidChangeTreeData.fire(undefined);
        });
        return [{
          label: "Loading...",
          iconPath: new vscode.ThemeIcon("loading~spin"),
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          type: "loading",
        }];
      }

      const serverEntries = this.loadedMonthEntries.get(monthKey) || [];

      // Apply all draft operations (create/update/delete) for this month
      const { start, end } = this.getMonthDateRange(element._monthYear);
      const draftOps = (this.draftQueue?.getAll() || []).filter(op => {
        const data = op.http.data?.time_entry as Record<string, unknown> | undefined;
        const spentOn = data?.spent_on as string | undefined;
        if (spentOn && spentOn >= start && spentOn <= end) return true;
        // Include ops targeting existing month entries
        return op.resourceId && serverEntries.some(e => e.id === op.resourceId);
      });
      const entries = applyDraftsToEntries(serverEntries, draftOps);

      const weekGroups = this.groupEntriesByWeek(entries, element.id || "month");
      if (weekGroups.length === 0) {
        return [{
          label: "No time entries",
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          type: "loading",
          iconPath: new vscode.ThemeIcon("info"),
        }];
      }
      return weekGroups;
    }

    // Week subgroup - return day groups
    if (element.type === "week-subgroup" && element._cachedEntries) {
      const prefix = element.id || "subweek";
      return this.groupEntriesByDay(element._cachedEntries, element._dateRange, prefix);
    }

    // Day group or regular group - return time entries
    if (
      (element.type === "group" || element.type === "day-group") &&
      element._cachedEntries
    ) {
      const prefix = element.id || "entry";
      return this.mapEntriesToNodes(element._cachedEntries, prefix);
    }

    return [];
  }

  private groupEntriesByDay(
    entries: TimeEntry[],
    dateRange?: { start: string; end: string },
    idPrefix = "day"
  ): TimeEntryNode[] {
    // Group entries by spent_on date
    const byDate = new Map<string, TimeEntry[]>();
    for (const entry of entries) {
      const date = entry.spent_on || "unknown";
      if (!byDate.has(date)) {
        byDate.set(date, []);
      }
      byDate.get(date)!.push(entry);
    }

    const defaultSchedule = getWeeklySchedule();

    // Build list of all dates to show
    let allDates: string[];
    if (dateRange) {
      // Generate all dates in range, filter to working days or days with entries
      allDates = getDateRange(dateRange.start, dateRange.end).filter(
        (dateStr) => {
          const date = new Date(dateStr + "T12:00:00");
          const hours = getHoursForDateMonthly(date, this.monthlySchedules, defaultSchedule);
          return hours > 0 || byDate.has(dateStr);
        }
      );
    } else {
      // No range, show only dates with entries
      allDates = Array.from(byDate.keys()).sort();
    }

    // Create day group nodes
    return allDates.map((dateStr) => {
      const dateEntries = byDate.get(dateStr) || [];
      const total = calculateTotal(dateEntries);
      const date = new Date(dateStr + "T12:00:00"); // Add time to avoid timezone issues
      const dayName = date.toLocaleDateString("en-US", { weekday: "short" });
      const dayNum = date.getDate();
      const available = getHoursForDateMonthly(date, this.monthlySchedules, defaultSchedule);

      const nodeId = `${idPrefix}-day-${dateStr}`;
      return {
        id: nodeId,
        label: `${dayName} ${dayNum}`,
        description: formatHoursWithComparison(total, available),
        collapsibleState: this.getCollapsibleState(nodeId, dateEntries.length > 0),
        type: "day-group" as const,
        contextValue: "day-group",
        _cachedEntries: dateEntries,
        _date: dateStr,
      };
    });
  }

  private groupEntriesByWeek(entries: TimeEntry[], idPrefix = "week"): TimeEntryNode[] {
    // Group entries by ISO week number and year
    const byWeek = new Map<string, { weekNum: number; year: number; entries: TimeEntry[] }>();
    for (const entry of entries) {
      const date = new Date((entry.spent_on || "unknown") + "T12:00:00");
      const weekNum = getISOWeekNumber(date);
      const year = getISOWeekYear(date);
      const key = `${year}-W${weekNum}`;
      if (!byWeek.has(key)) {
        byWeek.set(key, { weekNum, year, entries: [] });
      }
      byWeek.get(key)!.entries.push(entry);
    }

    // Sort weeks descending (most recent first)
    const sortedKeys = Array.from(byWeek.keys()).sort((a, b) => b.localeCompare(a));

    const defaultSchedule = getWeeklySchedule();

    // Get today's date for capping week range
    const today = formatLocalDate(new Date());

    // Get current year for comparison
    const currentYear = new Date().getFullYear();

    // Create week subgroup nodes
    return sortedKeys.map((key) => {
      const { weekNum, year, entries: weekEntries } = byWeek.get(key)!;
      const total = calculateTotal(weekEntries);

      // Calculate week date range (Mon-Sun), capped at today
      const weekRange = getWeekDateRange(weekNum, year);
      const cappedEnd = weekRange.end > today ? today : weekRange.end;

      // Calculate available hours for the week range
      const available = countAvailableHoursMonthly(
        new Date(weekRange.start + "T12:00:00"),
        new Date(cappedEnd + "T12:00:00"),
        this.monthlySchedules,
        defaultSchedule
      );

      const nodeId = `${idPrefix}-week-${year}-${weekNum}`;
      // Show year suffix for cross-year weeks (Week 1 or 52/53 that span year boundaries)
      const weekSpansYears = weekRange.start.slice(0, 4) !== weekRange.end.slice(0, 4);
      const yearSuffix = weekSpansYears || year !== currentYear ? ` '${year % 100}` : "";
      return {
        id: nodeId,
        label: `Week ${weekNum}${yearSuffix}`,
        description: formatHoursWithComparison(total, available),
        tooltip: `${weekRange.start} to ${cappedEnd}`,
        collapsibleState: this.getCollapsibleState(nodeId, true),
        type: "week-subgroup" as const,
        contextValue: "week-group",
        _cachedEntries: weekEntries,
        _dateRange: { start: weekRange.start, end: cappedEnd },
        _weekStart: weekRange.start,
      };
    });
  }

  private async mapEntriesToNodes(entries: TimeEntry[], idPrefix = "entry"): Promise<TimeEntryNode[]> {
    // Build project→client lookup from server's cached projects
    const projectClientMap = new Map<number, string>();
    if (this.server) {
      try {
        const projects = await this.server.getProjects(); // Uses server's cache
        for (const project of projects) {
          if (project.parent?.name) {
            projectClientMap.set(project.id, project.parent.name);
          }
        }
      } catch {
        // Ignore - client info is optional
      }
    }

    // Collect unique issue IDs that need fetching
    const uniqueIssueIds = Array.from(
      new Set(entries.map((entry) => entry.issue?.id || entry.issue_id))
    );

    // Filter out already-cached issues
    const missingIssueIds = uniqueIssueIds.filter(
      (id) => !this.issueCache.has(id)
    );

    // Batch fetch missing issues in single API call
    if (missingIssueIds.length > 0 && this.server) {
      try {
        const issues = await this.server.getIssuesByIds(missingIssueIds, false);
        const foundIds = new Set<number>();
        for (const issue of issues) {
          foundIds.add(issue.id);
          this.issueCache.set(issue.id, {
            id: issue.id,
            subject: issue.subject,
            projectId: issue.project?.id,
            project: issue.project?.name || "",
          });
        }
        // Mark unfound issues as "Unknown" to avoid retry
        for (const id of missingIssueIds) {
          if (!foundIds.has(id)) {
            this.issueCache.set(id, { id, subject: "Unknown Issue", project: "" });
          }
        }
      } catch {
        // On error, mark all as unknown
        for (const id of missingIssueIds) {
          this.issueCache.set(id, { id, subject: "Unknown Issue", project: "" });
        }
      }
    }

    // Sort entries if sort config is set
    const sortedEntries = this.sortEntries(entries);

    // Map entries using cached issue subjects
    return sortedEntries.map((entry) => {
      const issueId = entry.issue?.id || entry.issue_id;
      const cached = this.issueCache.get(issueId);
      const issueSubject = cached?.subject || "Unknown Issue";
      const projectName = cached?.project || "";
      const clientName = cached?.projectId ? projectClientMap.get(cached.projectId) || "" : "";

      // Check if this is a draft entry (negative ID) or draft-modified
      const isDraft = (entry.id ?? 0) < 0;
      const isDraftModified = (entry as TimeEntry & { _isDraftModified?: boolean })._isDraftModified === true;

      // Encode command arguments as JSON array for VS Code command URI
      const commandArgs = encodeURIComponent(JSON.stringify([issueId]));
      const userLine = this.showAllUsers && entry.user?.name ? `**User:** ${entry.user.name}\n\n` : "";
      const draftLine = isDraft ? `**⚠️ DRAFT** - Not yet saved to server\n\n` :
        isDraftModified ? `**✏️ MODIFIED** - Changes pending save\n\n` : "";
      const tooltip = new vscode.MarkdownString(
        draftLine +
        `**Issue:** #${issueId} ${issueSubject}\n\n` +
          userLine +
          (clientName ? `**Client:** ${clientName}\n\n` : "") +
          (projectName ? `**Project:** ${projectName}\n\n` : "") +
          `**Hours:** ${formatHoursAsHHMM(parseFloat(entry.hours))}\n\n` +
          `**Activity:** ${entry.activity?.name || "Unknown"}\n\n` +
          `**Date:** ${entry.spent_on}\n\n` +
          `**Comments:** ${entry.comments || "(none)"}\n\n` +
          (isDraft ? "" : `---\n\n[Open Issue in Browser](command:redmyne.openTimeEntryInBrowser?${commandArgs})`)
      );
      tooltip.isTrusted = true;
      tooltip.supportHtml = false;

      // Format: "#1234 comment" with "HH:MM [activity] issue_subject [user]" as description
      const hours = formatHoursAsHHMM(parseFloat(entry.hours));
      const activity = entry.activity?.name ? `[${entry.activity.name}]` : "";
      const comment = entry.comments ? ` ${entry.comments}` : "";
      const userName = this.showAllUsers && entry.user?.name ? `• ${entry.user.name}` : "";
      const draftSuffix = isDraft ? "(draft)" : isDraftModified ? "(modified)" : "";
      const descParts = [hours, activity, issueSubject, userName, draftSuffix].filter(Boolean);

      // Determine contextValue for ad-hoc contributions
      let contextValue = isDraft ? "time-entry-draft" : isDraftModified ? "time-entry-modified" : "time-entry";
      if (!isDraft && !isDraftModified && adHocTracker.isAdHoc(issueId)) {
        const targetId = parseTargetIssueId(entry.comments);
        contextValue = targetId ? "time-entry-adhoc-linked" : "time-entry-adhoc";
      }

      // Draft/modified entries get a distinct icon with theme-aware color
      const iconPath = isDraft
        ? new vscode.ThemeIcon("edit", new vscode.ThemeColor("editorWarning.foreground"))
        : isDraftModified
          ? new vscode.ThemeIcon("diff-modified", new vscode.ThemeColor("editorWarning.foreground"))
          : undefined;

      return {
        id: `${idPrefix}-entry-${entry.id}`,
        label: `#${issueId}${comment}`,
        description: descParts.join(" "),
        tooltip,
        iconPath,
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        type: "entry" as const,
        contextValue,
        _entry: entry,
        _isDraft: isDraft || isDraftModified,
      };
    });
  }

  getTreeItem(node: TimeEntryNode): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(node.label, node.collapsibleState);
    treeItem.id = node.id; // Stable ID preserves expansion state
    treeItem.description = node.description;
    treeItem.tooltip = node.tooltip;
    treeItem.iconPath = node.iconPath;
    treeItem.contextValue = node.contextValue;
    if (node.type === "load-earlier") {
      treeItem.command = {
        command: "redmyne.loadEarlierTimeEntries",
        title: "Load Earlier Time Entries",
      };
    }
    return treeItem;
  }

  /**
   * Set filter and refresh
   */
  setShowAllUsers(showAll: boolean): void {
    if (this.showAllUsers === showAll) return;
    this.showAllUsers = showAll;
        this.issueCache.clear();
    this.refresh();
  }

  /**
   * Get current filter state
   */
  getShowAllUsers(): boolean {
    return this.showAllUsers;
  }

  /**
   * Sort time entries using current sort config
   */
  private sortEntries(entries: TimeEntry[]): TimeEntry[] {
    if (!this.entrySort) return entries;
    const dir = this.entrySort.direction === "asc" ? 1 : -1;
    return [...entries].sort((a, b) => {
      switch (this.entrySort!.field) {
        case "id":
          return ((a.issue?.id || a.issue_id) - (b.issue?.id || b.issue_id)) * dir;
        case "subject": {
          const subjectA = this.issueCache.get(a.issue?.id || a.issue_id)?.subject || "";
          const subjectB = this.issueCache.get(b.issue?.id || b.issue_id)?.subject || "";
          return subjectA.localeCompare(subjectB) * dir;
        }
        case "comment":
          return (a.comments || "").localeCompare(b.comments || "") * dir;
        case "user": {
          const userA = a.user?.name || "";
          const userB = b.user?.name || "";
          return userA.localeCompare(userB) * dir;
        }
        default:
          return 0;
      }
    });
  }

  /**
   * Set sort field (toggles direction if same field)
   */
  setSort(field: TimeEntrySortField): void {
    if (this.entrySort?.field === field) {
      this.entrySort.direction = this.entrySort.direction === "asc" ? "desc" : "asc";
    } else {
      this.entrySort = { field, direction: "asc" };
    }
    this.refresh();
  }

  /**
   * Get current sort config
   */
  getSort(): SortConfig<TimeEntrySortField> | null {
    return this.entrySort;
  }
}

// Helper functions

function calculateTotal(entries: TimeEntry[]): number {
  return entries.reduce((sum, entry) => sum + parseFloat(entry.hours), 0);
}


function formatHoursWithComparison(
  logged: number,
  available: number
): string {
  if (available === 0) {
    return formatHoursAsHHMM(logged);
  }

  const percentage = Math.round((logged / available) * 100);
  return `${formatHoursAsHHMM(logged)}/${formatHoursAsHHMM(available)} (${percentage}%)`;
}
