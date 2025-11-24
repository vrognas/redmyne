import * as vscode from "vscode";
import { Issue } from "../redmine/models/issue";
import { RedmineServer } from "../redmine/redmine-server";
import { createEnhancedIssueTreeItem } from "../utilities/tree-item-factory";
import {
  calculateFlexibility,
  clearFlexibilityCache,
  FlexibilityScore,
  WeeklySchedule,
} from "../utilities/flexibility-calculator";

interface LoadingPlaceholder {
  isLoadingPlaceholder: true;
}

type TreeItem = Issue | LoadingPlaceholder;

const DEFAULT_SCHEDULE: WeeklySchedule = {
  Mon: 8,
  Tue: 8,
  Wed: 8,
  Thu: 8,
  Fri: 8,
  Sat: 0,
  Sun: 0,
};

// Status priority for sorting (lower = higher priority)
const STATUS_PRIORITY: Record<FlexibilityScore["status"], number> = {
  overbooked: 0,
  "at-risk": 1,
  "on-track": 2,
  completed: 3,
};

export class MyIssuesTree implements vscode.TreeDataProvider<TreeItem> {
  server?: RedmineServer;
  private isLoading = false;
  private flexibilityCache = new Map<number, FlexibilityScore | null>();
  private cachedIssues: Issue[] = [];
  private configListener: vscode.Disposable | undefined;

  constructor() {
    // Listen for config changes
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("redmine.workingHours")) {
        clearFlexibilityCache();
        this.flexibilityCache.clear();
        this.onDidChangeTreeData$.fire();
      }
    });
  }

  dispose() {
    this.configListener?.dispose();
  }

  onDidChangeTreeData$ = new vscode.EventEmitter<void>();
  onDidChangeTreeData: vscode.Event<void> = this.onDidChangeTreeData$.event;

  getTreeItem(item: TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    if ("isLoadingPlaceholder" in item && item.isLoadingPlaceholder) {
      return new vscode.TreeItem(
        "Loading issues...",
        vscode.TreeItemCollapsibleState.None
      );
    }

    const issue = item as Issue;
    const flexibility = this.flexibilityCache.get(issue.id) ?? null;
    return createEnhancedIssueTreeItem(
      issue,
      flexibility,
      this.server,
      "redmine.openActionsForIssue"
    );
  }

  async getChildren(_element?: TreeItem): Promise<TreeItem[]> {
    if (!this.server) {
      return [];
    }

    if (this.isLoading) {
      return [{ isLoadingPlaceholder: true }];
    }

    this.isLoading = true;
    try {
      const result = await this.server.getIssuesAssignedToMe();
      const schedule = this.getScheduleConfig();

      // Pre-calculate flexibility for all issues (not in getTreeItem to avoid freeze)
      this.flexibilityCache.clear();
      for (const issue of result.issues) {
        const flexibility = calculateFlexibility(issue, schedule);
        this.flexibilityCache.set(issue.id, flexibility);
      }

      // Sort by risk priority (overbooked first, then at-risk, etc.)
      this.cachedIssues = result.issues.sort((a, b) => {
        const flexA = this.flexibilityCache.get(a.id);
        const flexB = this.flexibilityCache.get(b.id);

        // Issues without flexibility data go last
        if (!flexA && !flexB) return 0;
        if (!flexA) return 1;
        if (!flexB) return -1;

        const priorityDiff =
          STATUS_PRIORITY[flexA.status] - STATUS_PRIORITY[flexB.status];
        if (priorityDiff !== 0) return priorityDiff;

        // Within same status, sort by remaining flexibility (lower = more urgent)
        return flexA.remaining - flexB.remaining;
      });
      return this.cachedIssues;
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Get cached issues for workload calculation
   */
  getIssues(): Issue[] {
    return this.cachedIssues;
  }

  /**
   * Fetch issues if not cached, for status bar initial load
   */
  async fetchIssuesIfNeeded(): Promise<Issue[]> {
    if (this.cachedIssues.length > 0) {
      return this.cachedIssues;
    }
    if (!this.server) {
      return [];
    }
    await this.getChildren();
    return this.cachedIssues;
  }

  private getScheduleConfig(): WeeklySchedule {
    const config = vscode.workspace.getConfiguration("redmine.workingHours");
    return config.get<WeeklySchedule>("weeklySchedule", DEFAULT_SCHEDULE);
  }

  setServer(server: RedmineServer | undefined) {
    this.server = server;
    this.flexibilityCache.clear();
    this.cachedIssues = [];
  }
}
