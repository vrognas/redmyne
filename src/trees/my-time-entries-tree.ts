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

        return [
          {
            label: "Today",
            description: formatHours(todayTotal),
            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
            type: "group",
            _cachedEntries: todayResult.time_entries,
          },
          {
            label: "This Week",
            description: formatHours(weekTotal),
            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
            type: "group",
            _cachedEntries: weekResult.time_entries,
          },
          {
            label: "This Month",
            description: formatHours(monthTotal),
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
      return element._cachedEntries.map((entry) => ({
        label: entry.issue?.subject || `Issue #${entry.issue_id}`,
        description: `${entry.hours}h ${entry.activity?.name || ""}`,
        tooltip: new vscode.MarkdownString(
          `**Time Entry #${entry.id}**\n\n` +
            `**Issue:** #${entry.issue_id} ${entry.issue?.subject || ""}\n` +
            `**Hours:** ${entry.hours}h\n` +
            `**Activity:** ${entry.activity?.name || "Unknown"}\n` +
            `**Date:** ${entry.spent_on}\n` +
            `**Comments:** ${entry.comments || "None"}\n\n` +
            `[View Issue in Redmine](${this.server?.options.address}/issues/${entry.issue_id})`
        ),
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        type: "entry",
        contextValue: "time-entry",
        _entry: entry,
      }));
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
