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
  type: "loading" | "group" | "entry";
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

  constructor() {}

  setServer(server: RedmineServer | undefined): void {
    this.server = server;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(element?: TimeEntryNode): Promise<TimeEntryNode[]> {
    // No server configured - return empty
    if (!this.server) {
      return [];
    }

    // Loading state for root level
    if (!element && this.isLoading) {
      return [
        {
          label: "Loading time entries...",
          iconPath: new vscode.ThemeIcon("loading~spin"),
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          type: "loading",
        },
      ];
    }

    // Root level - date groups
    if (!element) {
      this.isLoading = true;

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

        return [
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
            type: "group",
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
      } finally {
        this.isLoading = false;
      }
    }

    // Child level - time entries (use cached)
    if (element.type === "group" && element._cachedEntries) {
      return element._cachedEntries.map((entry) => {
        const issueId = entry.issue?.id || entry.issue_id;
        const issueSubject = entry.issue?.subject || "Unknown Issue";
        const tooltip = new vscode.MarkdownString(
          `**Issue:** #${issueId} ${issueSubject}\n\n` +
            `**Hours:** ${entry.hours}h\n\n` +
            `**Activity:** ${entry.activity?.name || "Unknown"}\n\n` +
            `**Date:** ${entry.spent_on}\n\n` +
            `**Comments:** ${entry.comments || "(none)"}\n\n` +
            `---\n\n` +
            `[Open Issue in Browser](command:redmine.openTimeEntryInBrowser?${issueId})`
        );
        tooltip.isTrusted = true;
        tooltip.supportHtml = false;

        return {
          label: `#${issueId} ${issueSubject}`,
          description: `${entry.hours}h ${entry.activity?.name || ""}`,
          tooltip,
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          type: "entry",
          contextValue: "time-entry",
          _entry: entry,
        };
      });
    }

    return [];
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
