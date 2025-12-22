import * as vscode from "vscode";
import { Issue } from "../redmine/models/issue";
import { RedmineServer } from "../redmine/redmine-server";
import { createEnhancedIssueTreeItem, isBlocked } from "../utilities/tree-item-factory";
import {
  calculateFlexibility,
  clearFlexibilityCache,
  FlexibilityScore,
  WeeklySchedule,
  STATUS_PRIORITY,
  DEFAULT_WEEKLY_SCHEDULE,
} from "../utilities/flexibility-calculator";

interface LoadingPlaceholder {
  isLoadingPlaceholder: true;
}

/**
 * Container for unassigned parent issues (parent not in assigned list)
 */
export interface ParentContainer {
  id: number;
  subject: string;
  isContainer: true;
  childCount: number;
  aggregatedHours: { spent: number; estimated: number };
}

/**
 * Type guard for ParentContainer
 */
export function isParentContainer(
  item: TreeItem
): item is ParentContainer {
  return "isContainer" in item && item.isContainer === true;
}

/**
 * Type guard for LoadingPlaceholder
 */
function isLoadingPlaceholder(item: TreeItem): item is LoadingPlaceholder {
  return "isLoadingPlaceholder" in item && item.isLoadingPlaceholder === true;
}

type TreeItem = Issue | ParentContainer | LoadingPlaceholder;




export class MyIssuesTree implements vscode.TreeDataProvider<TreeItem> {
  server?: RedmineServer;
  private isLoading = false;
  private pendingFetch: Promise<Issue[]> | null = null;
  private flexibilityCache = new Map<number, FlexibilityScore | null>();
  private cachedIssues: Issue[] = [];
  private parentContainers = new Map<number, ParentContainer>();
  private childrenByParent = new Map<number, Issue[]>();
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
    if (isLoadingPlaceholder(item)) {
      return new vscode.TreeItem(
        "Loading issues...",
        vscode.TreeItemCollapsibleState.None
      );
    }

    if (isParentContainer(item)) {
      return this.createParentContainerTreeItem(item);
    }

    const issue = item as Issue;
    const flexibility = this.flexibilityCache.get(issue.id) ?? null;
    const hasChildren = this.childrenByParent.has(issue.id);

    const treeItem = createEnhancedIssueTreeItem(
      issue,
      flexibility,
      this.server,
      "redmine.openActionsForIssue"
    );

    // Make expandable if has children
    if (hasChildren) {
      treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    }

    return treeItem;
  }

  private createParentContainerTreeItem(
    container: ParentContainer
  ): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(
      container.subject,
      vscode.TreeItemCollapsibleState.Collapsed
    );

    treeItem.description = `#${container.id} (${container.childCount} sub-issues)`;
    treeItem.iconPath = new vscode.ThemeIcon(
      "folder",
      new vscode.ThemeColor("list.deemphasizedForeground")
    );
    treeItem.contextValue = "parent-container";

    // Tooltip with aggregated hours
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**#${container.id}: ${container.subject}**\n\n`);
    md.appendMarkdown(`**Sub-issues:** ${container.childCount}\n\n`);
    md.appendMarkdown(
      `**Hours:** ${container.aggregatedHours.spent}h / ${container.aggregatedHours.estimated}h`
    );
    treeItem.tooltip = md;

    return treeItem;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (!this.server) {
      return [];
    }

    // Return children for expanded parent
    if (element) {
      if (isLoadingPlaceholder(element)) {
        return [];
      }

      const parentId = isParentContainer(element)
        ? element.id
        : (element as Issue).id;

      return this.childrenByParent.get(parentId) || [];
    }

    // Top-level: fetch and build hierarchy
    if (this.isLoading) {
      return [{ isLoadingPlaceholder: true }];
    }

    this.isLoading = true;
    try {
      const result = await this.server.getIssuesAssignedToMe();
      const schedule = this.getScheduleConfig();

      // Clear caches
      this.flexibilityCache.clear();
      this.parentContainers.clear();
      this.childrenByParent.clear();

      // Calculate flexibility for all issues
      for (const issue of result.issues) {
        const flexibility = calculateFlexibility(issue, schedule);
        this.flexibilityCache.set(issue.id, flexibility);
      }

      // Build hierarchy
      const issueMap = new Map(result.issues.map((i) => [i.id, i]));
      const topLevel: TreeItem[] = [];
      const missingParentIds = new Set<number>();

      // Group children by parent
      for (const issue of result.issues) {
        if (issue.parent?.id) {
          const parentId = issue.parent.id;

          if (!this.childrenByParent.has(parentId)) {
            this.childrenByParent.set(parentId, []);
          }
          this.childrenByParent.get(parentId)!.push(issue);

          // Track parents not in assigned list
          if (!issueMap.has(parentId)) {
            missingParentIds.add(parentId);
          }
        }
      }

      // Fetch missing parents and create containers
      if (missingParentIds.size > 0) {
        try {
          const parentIssues = await this.server.getIssuesByIds(
            Array.from(missingParentIds)
          );

          for (const parent of parentIssues) {
            const children = this.childrenByParent.get(parent.id) || [];
            const container: ParentContainer = {
              id: parent.id,
              subject: parent.subject,
              isContainer: true,
              childCount: children.length,
              aggregatedHours: {
                spent: children.reduce((s, c) => s + (c.spent_hours ?? 0), 0),
                estimated: children.reduce((s, c) => s + (c.estimated_hours ?? 0), 0),
              },
            };
            this.parentContainers.set(parent.id, container);
          }
        } catch {
          // Parent fetch failed - show children at root level
        }
      }

      // Build top-level list
      for (const issue of result.issues) {
        if (!issue.parent?.id) {
          // Root issue (no parent)
          topLevel.push(issue);
        } else if (issueMap.has(issue.parent.id)) {
          // Parent in assigned list - will be shown as child, skip from top
          continue;
        } else if (this.parentContainers.has(issue.parent.id)) {
          // Parent container will be shown - skip child from top
          continue;
        } else {
          // Parent fetch failed - show orphan at root
          topLevel.push(issue);
        }
      }

      // Add parent containers to top level
      for (const container of this.parentContainers.values()) {
        topLevel.push(container);
      }

      // Add assigned parent issues (that have children) to top level
      for (const issue of result.issues) {
        if (this.childrenByParent.has(issue.id) && !issue.parent?.id) {
          // Already in topLevel as root issue - no action needed
        } else if (
          this.childrenByParent.has(issue.id) &&
          issue.parent?.id &&
          issueMap.has(issue.parent.id)
        ) {
          // Has children but also has parent in list - treat as nested
        }
      }

      // Sort top-level by risk priority (blocked issues sink to bottom)
      const sorted = (topLevel as TreeItem[]).sort((a, b) => {
        // Containers go last
        if (isParentContainer(a) && !isParentContainer(b)) return 1;
        if (!isParentContainer(a) && isParentContainer(b)) return -1;
        if (isParentContainer(a) && isParentContainer(b)) {
          return a.subject.localeCompare(b.subject);
        }

        const issueA = a as Issue;
        const issueB = b as Issue;

        // Blocked issues sink to bottom (can't work on them)
        const blockedA = isBlocked(issueA);
        const blockedB = isBlocked(issueB);
        if (blockedA && !blockedB) return 1;
        if (!blockedA && blockedB) return -1;

        const flexA = this.flexibilityCache.get(issueA.id);
        const flexB = this.flexibilityCache.get(issueB.id);

        if (!flexA && !flexB) return 0;
        if (!flexA) return 1;
        if (!flexB) return -1;

        const priorityDiff =
          STATUS_PRIORITY[flexA.status] - STATUS_PRIORITY[flexB.status];
        if (priorityDiff !== 0) return priorityDiff;

        return flexA.remaining - flexB.remaining;
      });

      this.cachedIssues = result.issues;
      return sorted;
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
   * Get flexibility cache for Gantt display
   */
  getFlexibilityCache(): Map<number, FlexibilityScore | null> {
    return this.flexibilityCache;
  }

  /**
   * Fetch issues if not cached, for status bar initial load.
   * Prevents concurrent fetches by returning pending promise.
   */
  async fetchIssuesIfNeeded(): Promise<Issue[]> {
    if (this.cachedIssues.length > 0) {
      return this.cachedIssues;
    }
    if (!this.server) {
      return [];
    }
    // Return existing fetch if in progress
    if (this.pendingFetch) {
      return this.pendingFetch;
    }
    // Start new fetch
    this.pendingFetch = this.getChildren().then(() => {
      this.pendingFetch = null;
      // Notify tree to refresh (in case it showed loading placeholder)
      this.onDidChangeTreeData$.fire();
      return this.cachedIssues;
    });
    return this.pendingFetch;
  }

  private getScheduleConfig(): WeeklySchedule {
    const config = vscode.workspace.getConfiguration("redmine.workingHours");
    return config.get<WeeklySchedule>("weeklySchedule", DEFAULT_WEEKLY_SCHEDULE);
  }

  setServer(server: RedmineServer | undefined) {
    this.server = server;
    this.flexibilityCache.clear();
    this.cachedIssues = [];
    this.parentContainers.clear();
    this.childrenByParent.clear();
  }
}
