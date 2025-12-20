import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { TimeEntry } from "../redmine/models/time-entry";

export interface TimeEntryNode {
  label: string;
  description?: string;
  tooltip?: vscode.MarkdownString;
  iconPath?: vscode.ThemeIcon;
  collapsibleState: vscode.TreeItemCollapsibleState;
  contextValue?: string;
  type: "loading" | "group" | "week-group" | "day-group" | "entry";
  _cachedEntries?: TimeEntry[];
  _entry?: TimeEntry;
}

export class MyTimeEntriesTreeDataProvider
  implements vscode.TreeDataProvider<TimeEntryNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    TimeEntryNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private isLoading = false;
  private server?: RedmineServer;
  private issueCache = new Map<number, { id: number; subject: string }>();
  private cachedGroups?: TimeEntryNode[];

  constructor() {}

  setServer(server: RedmineServer | undefined): void {
    this.server = server;
    // Clear cache when server changes
    this.issueCache.clear();
    this.cachedGroups = undefined;
  }

  refresh(): void {
    // Clear cache on refresh to get fresh data
    this.issueCache.clear();
    this.cachedGroups = undefined;
    this._onDidChangeTreeData.fire(undefined);
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

      // Fetch entries in parallel (3 requests)
      const [todayResult, weekResult, monthResult] = await Promise.all([
        this.server.getTimeEntries({ from: today, to: today }),
        this.server.getTimeEntries({ from: weekStart, to: today }),
        this.server.getTimeEntries({ from: monthStart, to: today }),
      ]);

      const todayTotal = calculateTotal(todayResult.time_entries);
      const weekTotal = calculateTotal(weekResult.time_entries);
      const monthTotal = calculateTotal(monthResult.time_entries);

      // Get working hours config (supports both old and new format)
      const config = vscode.workspace.getConfiguration("redmine.workingHours");
      const schedule = getWeeklySchedule(config);

      // Calculate available hours for each period
      const todayAvailable = getHoursForDate(new Date(), schedule);
      const weekAvailable = calculateAvailableHours(
        new Date(weekStart),
        new Date(today),
        schedule
      );
      const monthAvailable = calculateAvailableHours(
        new Date(monthStart),
        new Date(today),
        schedule
      );

      this.cachedGroups = [
        {
          label: "Today",
          description: formatHoursWithComparison(todayTotal, todayAvailable),
          collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
          type: "group",
          _cachedEntries: todayResult.time_entries,
        },
        {
          label: "This Week",
          description: formatHoursWithComparison(weekTotal, weekAvailable),
          collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
          type: "week-group",
          _cachedEntries: weekResult.time_entries,
        },
        {
          label: "This Month",
          description: formatHoursWithComparison(monthTotal, monthAvailable),
          collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
          type: "group",
          _cachedEntries: monthResult.time_entries,
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
      return this.groupEntriesByDay(element._cachedEntries);
    }

    // Day group or regular group - return time entries
    if (
      (element.type === "group" || element.type === "day-group") &&
      element._cachedEntries
    ) {
      return this.mapEntriesToNodes(element._cachedEntries);
    }

    return [];
  }

  private groupEntriesByDay(entries: TimeEntry[]): TimeEntryNode[] {
    // Group entries by spent_on date
    const byDate = new Map<string, TimeEntry[]>();
    for (const entry of entries) {
      const date = entry.spent_on || "unknown";
      if (!byDate.has(date)) {
        byDate.set(date, []);
      }
      byDate.get(date)!.push(entry);
    }

    // Sort dates (earliest first for chronological order)
    const sortedDates = Array.from(byDate.keys()).sort();

    // Get working hours config
    const config = vscode.workspace.getConfiguration("redmine.workingHours");
    const schedule = getWeeklySchedule(config);

    // Create day group nodes
    return sortedDates.map((dateStr) => {
      const dateEntries = byDate.get(dateStr)!;
      const total = calculateTotal(dateEntries);
      const date = new Date(dateStr + "T12:00:00"); // Add time to avoid timezone issues
      const dayName = date.toLocaleDateString("en-US", { weekday: "short" });
      const dayNum = date.getDate();
      const available = getHoursForDate(date, schedule);

      return {
        label: `${dayName} ${dayNum}`,
        description: formatHoursWithComparison(total, available),
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        type: "day-group" as const,
        _cachedEntries: dateEntries,
      };
    });
  }

  private async mapEntriesToNodes(entries: TimeEntry[]): Promise<TimeEntryNode[]> {
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
            this.issueCache.set(id, { id: issue.id, subject: issue.subject });
          } catch {
            // If fetch fails, cache as "Unknown Issue" to avoid retry
            this.issueCache.set(id, { id, subject: "Unknown Issue" });
          }
        })
      );
    }

    // Map entries using cached issue subjects
    return entries.map((entry) => {
      const issueId = entry.issue?.id || entry.issue_id;
      const cached = this.issueCache.get(issueId);
      const issueSubject = cached?.subject || "Unknown Issue";

      // Encode command arguments as JSON array for VS Code command URI
      const commandArgs = encodeURIComponent(JSON.stringify([issueId]));
      const tooltip = new vscode.MarkdownString(
        `**Issue:** #${issueId} ${issueSubject}\n\n` +
          `**Hours:** ${entry.hours}h\n\n` +
          `**Activity:** ${entry.activity?.name || "Unknown"}\n\n` +
          `**Date:** ${entry.spent_on}\n\n` +
          `**Comments:** ${entry.comments || "(none)"}\n\n` +
          `---\n\n` +
          `[Open Issue in Browser](command:redmine.openTimeEntryInBrowser?${commandArgs})`
      );
      tooltip.isTrusted = true;
      tooltip.supportHtml = false;

      return {
        label: `#${issueId} ${issueSubject}`,
        description: `${entry.hours}h ${entry.activity?.name || ""}`,
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
    treeItem.description = node.description;
    treeItem.tooltip = node.tooltip;
    treeItem.iconPath = node.iconPath;
    treeItem.contextValue = node.contextValue;
    return treeItem;
  }
}

// Helper functions

function getWeekStart(): string {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Monday
  const weekStart = new Date(now.setDate(diff));
  return weekStart.toISOString().split("T")[0];
}

function getMonthStart(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .split("T")[0];
}

function calculateTotal(entries: TimeEntry[]): number {
  return entries.reduce((sum, entry) => sum + parseFloat(entry.hours), 0);
}

function formatHours(hours: number): string {
  return `${hours.toFixed(1).replace(/\.0$/, "")}h`;
}

function formatHoursWithComparison(
  logged: number,
  available: number
): string {
  if (available === 0) {
    return formatHours(logged);
  }

  const percentage = Math.round((logged / available) * 100);
  return `${formatHours(logged)}/${formatHours(available)} (${percentage}%)`;
}

type WeeklySchedule = Record<string, number>;

/**
 * Get weekly schedule from config, supporting both old and new format
 */
function getWeeklySchedule(
  config: vscode.WorkspaceConfiguration
): WeeklySchedule {
  // Try new format first
  const schedule = config.get<WeeklySchedule>("weeklySchedule");
  if (schedule) {
    return schedule;
  }

  // Fallback to old format (backward compatibility)
  const hoursPerDay = config.get<number>("hoursPerDay", 8);
  const workingDays = config.get<string[]>("workingDays", [
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
  ]);

  // Convert old format to new format
  const defaultSchedule: WeeklySchedule = {
    Mon: 0,
    Tue: 0,
    Wed: 0,
    Thu: 0,
    Fri: 0,
    Sat: 0,
    Sun: 0,
  };

  workingDays.forEach((day) => {
    defaultSchedule[day] = hoursPerDay;
  });

  return defaultSchedule;
}

/**
 * Get working hours for a specific date
 */
function getHoursForDate(date: Date, schedule: WeeklySchedule): number {
  const dayName = date.toLocaleDateString("en-US", { weekday: "short" });
  return schedule[dayName] || 0;
}

/**
 * Calculate total available hours between two dates
 */
function calculateAvailableHours(
  start: Date,
  end: Date,
  schedule: WeeklySchedule
): number {
  let total = 0;
  const current = new Date(start);

  while (current <= end) {
    total += getHoursForDate(current, schedule);
    current.setDate(current.getDate() + 1);
  }

  return total;
}
