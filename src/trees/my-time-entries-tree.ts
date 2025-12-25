import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { TimeEntry } from "../redmine/models/time-entry";
import { formatHoursAsHHMM } from "../utilities/time-input";
import { BaseTreeProvider } from "../shared/base-tree-provider";
import {
  MonthlyScheduleOverrides,
  countAvailableHoursMonthly,
  getHoursForDateMonthly,
} from "../utilities/monthly-schedule";
import { clearFlexibilityCache, getWeeklySchedule } from "../utilities/flexibility-calculator";
import {
  getWeekStart,
  getMonthStart,
  getLastMonthRange,
  getDateRange,
  getISOWeekNumber,
  getISOWeekYear,
  getWeekDateRange,
} from "../utilities/date-utils";

export interface TimeEntryNode {
  id?: string; // Stable ID for preserving expansion state
  label: string;
  description?: string;
  tooltip?: string | vscode.MarkdownString;
  iconPath?: vscode.ThemeIcon;
  collapsibleState: vscode.TreeItemCollapsibleState;
  contextValue?: string;
  type: "loading" | "group" | "week-group" | "day-group" | "month-group" | "week-subgroup" | "entry";
  _cachedEntries?: TimeEntry[];
  _entry?: TimeEntry;
  _dateRange?: { start: string; end: string }; // For filling empty working days
  _date?: string; // ISO date for day-group nodes (YYYY-MM-DD)
}

export class MyTimeEntriesTreeDataProvider extends BaseTreeProvider<TimeEntryNode> {
  private isLoading = false;
  private server?: RedmineServer;
  private issueCache = new Map<number, { id: number; subject: string; projectId?: number; project: string; client?: string }>();
  private cachedGroups?: TimeEntryNode[];
  private expandedIds = new Set<string>();
  private monthlySchedules: MonthlyScheduleOverrides = {};

  constructor() {
    super();
    // Refresh when working hours config changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("redmine.workingHours")) {
          clearFlexibilityCache();
          this.cachedGroups = undefined;
          this._onDidChangeTreeData.fire(undefined);
        }
      })
    );
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
    this.cachedGroups = undefined;
  }

  override refresh(): void {
    // Clear issue cache but keep tree data visible during refresh
    this.issueCache.clear();
    // Fetch new data in background, keeping old data visible
    if (!this.isLoading && this.server) {
      this.isLoading = true;
      this.loadTimeEntries();
    }
  }

  private async loadTimeEntries(): Promise<void> {
    if (!this.server) {
      this.isLoading = false;
      return;
    }

    try {
      const today = new Date().toISOString().split("T")[0];
      const weekStart = getWeekStart();
      const monthStart = getMonthStart();
      const lastMonth = getLastMonthRange();

      // Fetch entries in parallel (4 requests)
      const [todayResult, weekResult, monthResult, lastMonthResult] = await Promise.all([
        this.server.getTimeEntries({ from: today, to: today }),
        this.server.getTimeEntries({ from: weekStart, to: today }),
        this.server.getTimeEntries({ from: monthStart, to: today }),
        this.server.getTimeEntries({ from: lastMonth.start, to: lastMonth.end }),
      ]);

      const todayTotal = calculateTotal(todayResult.time_entries);
      const weekTotal = calculateTotal(weekResult.time_entries);
      const monthTotal = calculateTotal(monthResult.time_entries);
      const lastMonthTotal = calculateTotal(lastMonthResult.time_entries);

      const defaultSchedule = getWeeklySchedule();

      // Calculate available hours for each period (using monthly overrides)
      const todayAvailable = getHoursForDateMonthly(
        new Date(),
        this.monthlySchedules,
        defaultSchedule
      );
      const weekAvailable = countAvailableHoursMonthly(
        new Date(weekStart),
        new Date(today),
        this.monthlySchedules,
        defaultSchedule
      );
      const monthAvailable = countAvailableHoursMonthly(
        new Date(monthStart),
        new Date(today),
        this.monthlySchedules,
        defaultSchedule
      );
      const lastMonthAvailable = countAvailableHoursMonthly(
        new Date(lastMonth.start + "T12:00:00"),
        new Date(lastMonth.end + "T12:00:00"),
        this.monthlySchedules,
        defaultSchedule
      );

      // Format labels with current date context
      const now = new Date();
      const dayName = now.toLocaleDateString("en-US", { weekday: "short" });
      const dayNum = now.getDate();
      const weekNum = getISOWeekNumber(now);
      const monthName = now.toLocaleDateString("en-US", { month: "short" });

      this.cachedGroups = [
        {
          id: "group-today",
          label: `Today (${dayName} ${dayNum})`,
          description: formatHoursWithComparison(todayTotal, todayAvailable),
          collapsibleState: this.getCollapsibleState("group-today", true),
          type: "group",
          contextValue: "day-group",
          _cachedEntries: todayResult.time_entries,
          _date: today,
        },
        {
          id: "group-week",
          label: `This Week (${weekNum})`,
          description: formatHoursWithComparison(weekTotal, weekAvailable),
          tooltip: "Shows working days from Monday up to today",
          collapsibleState: this.getCollapsibleState("group-week", true),
          type: "week-group",
          _cachedEntries: weekResult.time_entries,
          _dateRange: { start: weekStart, end: today },
        },
        {
          id: "group-month",
          label: `This Month (${monthName})`,
          description: formatHoursWithComparison(monthTotal, monthAvailable),
          tooltip: "Shows working days from 1st up to today",
          collapsibleState: this.getCollapsibleState("group-month", true),
          type: "month-group",
          _cachedEntries: monthResult.time_entries,
        },
        {
          id: "group-last-month",
          label: `Last Month (${lastMonth.name})`,
          description: formatHoursWithComparison(lastMonthTotal, lastMonthAvailable),
          tooltip: `${lastMonth.start} to ${lastMonth.end}`,
          collapsibleState: this.getCollapsibleState("group-last-month", true),
          type: "month-group",
          _cachedEntries: lastMonthResult.time_entries,
        },
      ];
    } catch {
      // On error, show empty state
      this.cachedGroups = [];
    } finally {
      this.isLoading = false;
      // Trigger re-render with actual data
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  async getChildren(element?: TimeEntryNode): Promise<TimeEntryNode[]> {
    // No server configured - return empty
    if (!this.server) {
      return [];
    }

    // Root level - date groups
    if (!element) {
      // Return cached if available
      if (this.cachedGroups) {
        return this.cachedGroups;
      }

      // Return loading state and fetch in background
      if (!this.isLoading) {
        this.isLoading = true;
        this.loadTimeEntries();
      }

      return [
        {
          label: "Loading time entries...",
          iconPath: new vscode.ThemeIcon("loading~spin"),
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          type: "loading",
        },
      ];
    }

    // Week group - return day groups
    if (element.type === "week-group" && element._cachedEntries) {
      return this.groupEntriesByDay(element._cachedEntries, element._dateRange, "week");
    }

    // Month group - return week subgroups
    if (element.type === "month-group" && element._cachedEntries) {
      return this.groupEntriesByWeek(element._cachedEntries);
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

  private groupEntriesByWeek(entries: TimeEntry[]): TimeEntryNode[] {
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
    const today = new Date().toISOString().split("T")[0];

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

      const nodeId = `week-${year}-${weekNum}`;
      return {
        id: nodeId,
        label: `Week ${weekNum}`,
        description: formatHoursWithComparison(total, available),
        collapsibleState: this.getCollapsibleState(nodeId, true),
        type: "week-subgroup" as const,
        _cachedEntries: weekEntries,
        _dateRange: { start: weekRange.start, end: cappedEnd },
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

    // Batch fetch missing issues
    if (missingIssueIds.length > 0 && this.server) {
      await Promise.allSettled(
        missingIssueIds.map(async (id) => {
          try {
            const { issue } = await this.server!.getIssueById(id);
            const projectId = issue.project?.id;
            this.issueCache.set(id, {
              id: issue.id,
              subject: issue.subject,
              projectId,
              project: issue.project?.name || "",
            });
          } catch {
            // If fetch fails, cache as "Unknown Issue" to avoid retry
            this.issueCache.set(id, { id, subject: "Unknown Issue", project: "" });
          }
        })
      );
    }

    // Map entries using cached issue subjects
    return entries.map((entry) => {
      const issueId = entry.issue?.id || entry.issue_id;
      const cached = this.issueCache.get(issueId);
      const issueSubject = cached?.subject || "Unknown Issue";
      const projectName = cached?.project || "";
      const clientName = cached?.projectId ? projectClientMap.get(cached.projectId) || "" : "";

      // Encode command arguments as JSON array for VS Code command URI
      const commandArgs = encodeURIComponent(JSON.stringify([issueId]));
      const tooltip = new vscode.MarkdownString(
        `**Issue:** #${issueId} ${issueSubject}\n\n` +
          (clientName ? `**Client:** ${clientName}\n\n` : "") +
          (projectName ? `**Project:** ${projectName}\n\n` : "") +
          `**Hours:** ${formatHoursAsHHMM(parseFloat(entry.hours))}\n\n` +
          `**Activity:** ${entry.activity?.name || "Unknown"}\n\n` +
          `**Date:** ${entry.spent_on}\n\n` +
          `**Comments:** ${entry.comments || "(none)"}\n\n` +
          `---\n\n` +
          `[Open Issue in Browser](command:redmine.openTimeEntryInBrowser?${commandArgs})`
      );
      tooltip.isTrusted = true;
      tooltip.supportHtml = false;

      // Format: "#1234 comment" with "HH:MM [activity] issue_subject" as description
      const hours = formatHoursAsHHMM(parseFloat(entry.hours));
      const activity = entry.activity?.name ? `[${entry.activity.name}]` : "";
      const comment = entry.comments ? ` ${entry.comments}` : "";
      const descParts = [hours, activity, issueSubject].filter(Boolean);

      return {
        id: `${idPrefix}-entry-${entry.id}`,
        label: `#${issueId}${comment}`,
        description: descParts.join(" "),
        tooltip,
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        type: "entry" as const,
        contextValue: "time-entry",
        _entry: entry,
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
    return treeItem;
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
