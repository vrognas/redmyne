import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { RedmineProject } from "../redmine/redmine-project";
import { Issue } from "../redmine/models/issue";
import {
  createIssueTreeItem,
  createEnhancedIssueTreeItem,
} from "../utilities/tree-item-factory";
import {
  calculateFlexibility,
  clearFlexibilityCache,
  FlexibilityScore,
  WeeklySchedule,
} from "../utilities/flexibility-calculator";

export enum ProjectsViewStyle {
  LIST = 0,
  TREE = 1,
}

interface LoadingPlaceholder {
  isLoadingPlaceholder: true;
  message?: string;
}

/**
 * Enhanced project node with assigned issues metadata
 */
interface ProjectNode {
  project: RedmineProject;
  assignedIssues: Issue[];
  hasAssignedIssues: boolean;
}

type TreeItem = ProjectNode | Issue | LoadingPlaceholder;

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

/**
 * Check if issue is blocked by another issue
 */
function isBlocked(issue: Issue): boolean {
  return issue.relations?.some((r) => r.relation_type === "blocked") ?? false;
}

/**
 * Type guard for ProjectNode
 */
function isProjectNode(item: TreeItem): item is ProjectNode {
  return "project" in item && item.project instanceof RedmineProject;
}

/**
 * Type guard for LoadingPlaceholder
 */
function isLoadingPlaceholder(item: TreeItem): item is LoadingPlaceholder {
  return "isLoadingPlaceholder" in item && item.isLoadingPlaceholder === true;
}

export class ProjectsTree implements vscode.TreeDataProvider<TreeItem> {
  server?: RedmineServer;
  viewStyle: ProjectsViewStyle;
  projects: RedmineProject[] | null = null;
  private projectNodes: ProjectNode[] = [];
  private isLoadingProjects = false;
  private loadingIssuesForProject = new Set<number>();
  private assignedIssues: Issue[] = [];
  private issuesByProject = new Map<number, Issue[]>();
  private flexibilityCache = new Map<number, FlexibilityScore | null>();
  private configListener: vscode.Disposable | undefined;

  constructor() {
    this.viewStyle = ProjectsViewStyle.LIST;

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
      const loadingItem = new vscode.TreeItem(
        item.message || "Loading...",
        vscode.TreeItemCollapsibleState.None
      );
      loadingItem.iconPath = new vscode.ThemeIcon("loading~spin");
      return loadingItem;
    }

    if (isProjectNode(item)) {
      return this.createProjectTreeItem(item);
    }

    // Issue item - use enhanced if flexibility available
    const issue = item as Issue;
    const flexibility = this.flexibilityCache.get(issue.id) ?? null;

    if (flexibility) {
      return createEnhancedIssueTreeItem(
        issue,
        flexibility,
        this.server,
        "redmine.openActionsForIssue"
      );
    }

    return createIssueTreeItem(issue, this.server, "redmine.openActionsForIssue");
  }

  /**
   * Create tree item for a project node
   */
  private createProjectTreeItem(node: ProjectNode): vscode.TreeItem {
    const { project, assignedIssues, hasAssignedIssues } = node;

    const treeItem = new vscode.TreeItem(
      project.toQuickPickItem().label,
      vscode.TreeItemCollapsibleState.Collapsed
    );

    if (hasAssignedIssues) {
      // Project with assigned issues - show count and enhanced styling
      treeItem.description = `(${assignedIssues.length} assigned)`;
      treeItem.iconPath = new vscode.ThemeIcon(
        "folder-opened",
        new vscode.ThemeColor("list.highlightForeground")
      );
      treeItem.contextValue = "project-with-issues";
    } else {
      // Project without assigned issues - dim it
      treeItem.iconPath = new vscode.ThemeIcon(
        "folder",
        new vscode.ThemeColor("list.deemphasizedForeground")
      );
      treeItem.contextValue = "project-empty";
    }

    return treeItem;
  }

  async getChildren(projectOrIssue?: TreeItem): Promise<TreeItem[]> {
    if (!this.server) {
      return [];
    }

    // Handle project expansion
    if (projectOrIssue && isProjectNode(projectOrIssue)) {
      const { project, assignedIssues, hasAssignedIssues } = projectOrIssue;

      if (hasAssignedIssues) {
        // Return only assigned issues (sorted by risk)
        return this.sortIssuesByRisk(assignedIssues);
      }

      // No assigned issues - fall back to fetching all open issues
      if (this.loadingIssuesForProject.has(project.id)) {
        return [{ isLoadingPlaceholder: true, message: "Loading issues..." }];
      }

      this.loadingIssuesForProject.add(project.id);
      try {
        if (this.viewStyle === ProjectsViewStyle.TREE) {
          const subprojects = (this.projects ?? [])
            .filter((p) => p.parent && p.parent.id === project.id)
            .map((p) => this.createProjectNode(p));
          const issues = (
            await this.server.getOpenIssuesForProject(project.id, false)
          ).issues;
          return [...subprojects, ...issues];
        }

        return (await this.server.getOpenIssuesForProject(project.id)).issues;
      } finally {
        this.loadingIssuesForProject.delete(project.id);
      }
    }

    // Root level - fetch projects and assigned issues
    if (this.isLoadingProjects) {
      return [{ isLoadingPlaceholder: true, message: "Loading projects..." }];
    }

    if (!this.projects || this.projects.length === 0) {
      this.isLoadingProjects = true;
      try {
        // Fetch projects and assigned issues in parallel
        const [projects, assignedResult] = await Promise.all([
          this.server.getProjects(),
          this.server.getIssuesAssignedToMe(),
        ]);

        this.projects = projects;
        this.assignedIssues = assignedResult.issues;

        // Calculate flexibility for assigned issues
        const schedule = this.getScheduleConfig();
        this.flexibilityCache.clear();
        for (const issue of this.assignedIssues) {
          const flexibility = calculateFlexibility(issue, schedule);
          this.flexibilityCache.set(issue.id, flexibility);
        }

        // Group issues by project
        this.issuesByProject.clear();
        for (const issue of this.assignedIssues) {
          const projectId = issue.project?.id;
          if (projectId) {
            if (!this.issuesByProject.has(projectId)) {
              this.issuesByProject.set(projectId, []);
            }
            this.issuesByProject.get(projectId)!.push(issue);
          }
        }

        // Build project nodes
        this.projectNodes = this.projects.map((p) => this.createProjectNode(p));
      } finally {
        this.isLoadingProjects = false;
      }
    }

    // Sort and return project nodes
    return this.sortProjectNodes(this.projectNodes);
  }

  /**
   * Create a project node with assigned issues info
   */
  private createProjectNode(project: RedmineProject): ProjectNode {
    const assignedIssues = this.issuesByProject.get(project.id) || [];
    return {
      project,
      assignedIssues,
      hasAssignedIssues: assignedIssues.length > 0,
    };
  }

  /**
   * Sort project nodes: with assigned issues first (by issue count), then without
   */
  private sortProjectNodes(nodes: ProjectNode[]): ProjectNode[] {
    // Apply tree view filtering if needed
    let filtered = nodes;
    if (this.viewStyle === ProjectsViewStyle.TREE) {
      filtered = nodes.filter((n) => !n.project.parent);
    }

    return filtered.sort((a, b) => {
      // Projects with assigned issues come first
      if (a.hasAssignedIssues && !b.hasAssignedIssues) return -1;
      if (!a.hasAssignedIssues && b.hasAssignedIssues) return 1;

      // Among projects with issues, sort by issue count (descending)
      if (a.hasAssignedIssues && b.hasAssignedIssues) {
        return b.assignedIssues.length - a.assignedIssues.length;
      }

      // Among projects without issues, sort alphabetically
      return a.project.toQuickPickItem().label.localeCompare(
        b.project.toQuickPickItem().label
      );
    });
  }

  /**
   * Sort issues by risk priority (blocked issues sink to bottom)
   */
  private sortIssuesByRisk(issues: Issue[]): Issue[] {
    return [...issues].sort((a, b) => {
      // Blocked issues sink to bottom
      const blockedA = isBlocked(a);
      const blockedB = isBlocked(b);
      if (blockedA && !blockedB) return 1;
      if (!blockedA && blockedB) return -1;

      const flexA = this.flexibilityCache.get(a.id);
      const flexB = this.flexibilityCache.get(b.id);

      if (!flexA && !flexB) return 0;
      if (!flexA) return 1;
      if (!flexB) return -1;

      const priorityDiff =
        STATUS_PRIORITY[flexA.status] - STATUS_PRIORITY[flexB.status];
      if (priorityDiff !== 0) return priorityDiff;

      return flexA.remaining - flexB.remaining;
    });
  }

  private getScheduleConfig(): WeeklySchedule {
    const config = vscode.workspace.getConfiguration("redmine.workingHours");
    return config.get<WeeklySchedule>("weeklySchedule", DEFAULT_SCHEDULE);
  }

  /**
   * Get cached assigned issues for external use (Gantt, status bar)
   */
  getAssignedIssues(): Issue[] {
    return this.assignedIssues;
  }

  /**
   * Get flexibility cache for Gantt display
   */
  getFlexibilityCache(): Map<number, FlexibilityScore | null> {
    return this.flexibilityCache;
  }

  /**
   * Fetch issues if not cached, for status bar initial load.
   */
  async fetchIssuesIfNeeded(): Promise<Issue[]> {
    if (this.assignedIssues.length > 0) {
      return this.assignedIssues;
    }
    if (!this.server) {
      return [];
    }
    // Trigger getChildren to fetch data
    await this.getChildren();
    return this.assignedIssues;
  }

  clearProjects() {
    this.projects = [];
    this.projectNodes = [];
    this.assignedIssues = [];
    this.issuesByProject.clear();
    this.flexibilityCache.clear();
  }

  setViewStyle(style: ProjectsViewStyle) {
    this.viewStyle = style;
    this.onDidChangeTreeData$.fire();
  }

  setServer(server: RedmineServer | undefined) {
    this.server = server;
    this.clearProjects();
  }
}
