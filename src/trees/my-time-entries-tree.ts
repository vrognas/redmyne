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

        // Get working hours config
        const config = vscode.workspace.getConfiguration("redmine.workingHours");
        const hoursPerDay = config.get<number>("hoursPerDay", 8);
        const workingDays = config.get<string[]>("workingDays", [
          "Mon",
          "Tue",
          "Wed",
          "Thu",
          "Fri",
        ]);

        // Calculate available hours for each period
        const todayAvailable = isWorkingDay(new Date(), workingDays)
          ? hoursPerDay
          : 0;
        const weekAvailable = countWorkingDays(
          new Date(weekStart),
          new Date(today),
          workingDays
        ) * hoursPerDay;
        const monthAvailable = countWorkingDays(
          new Date(monthStart),
          new Date(today),
          workingDays
        ) * hoursPerDay;

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
        const tooltip = new vscode.MarkdownString(
          `**Time Entry #${entry.id}**\n\n` +
            `**Issue**\n\n` +
            `#${entry.issue?.id || entry.issue_id} ${entry.issue?.subject || "Untitled"}\n\n` +
            `**Hours**\n\n` +
            `${entry.hours}h\n\n` +
            `**Activity**\n\n` +
            `${entry.activity?.name || "Unknown"}\n\n` +
            `**Date**\n\n` +
            `${entry.spent_on}\n\n` +
            `**Comments**\n\n` +
            `${entry.comments || "None"}\n\n` +
            `---\n\n` +
            `[Open Issue in Browser](${this.server?.options.address}/issues/${entry.issue?.id || entry.issue_id})`
        );
        // Enable command URIs for external links
        tooltip.isTrusted = true;

        return {
          label: `#${entry.issue?.id || entry.issue_id} ${entry.issue?.subject || "Untitled"}`,
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

function isWorkingDay(date: Date, workingDays: string[]): boolean {
  const dayName = date.toLocaleDateString("en-US", { weekday: "short" });
  return workingDays.includes(dayName);
}

function countWorkingDays(
  start: Date,
  end: Date,
  workingDays: string[]
): number {
  let count = 0;
  const current = new Date(start);

  while (current <= end) {
    if (isWorkingDay(current, workingDays)) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }

  return count;
}
