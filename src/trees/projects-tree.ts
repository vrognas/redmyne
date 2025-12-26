import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { RedmineProject } from "../redmine/redmine-project";
import { Issue } from "../redmine/models/issue";
import { IssueFilter, DEFAULT_ISSUE_FILTER, IssueSortField, SortConfig } from "../redmine/models/common";
import { createEnhancedIssueTreeItem } from "../utilities/tree-item-factory";
import { sortIssuesByRisk, sortIssuesByField } from "../utilities/issue-sorting";
import {
  clearFlexibilityCache,
  FlexibilityScore,
  buildFlexibilityCache,
  getWeeklySchedule,
} from "../utilities/flexibility-calculator";
import { groupBy } from "../utilities/collection-utils";
import { BaseTreeProvider } from "../shared/base-tree-provider";
import {
  LoadingPlaceholder,
  isLoadingPlaceholder,
  createLoadingTreeItem,
} from "../shared/loading-placeholder";

export enum ProjectsViewStyle {
  LIST = 0,
  TREE = 1,
}

/**
 * Enhanced project node with assigned issues metadata
 */
interface ProjectNode {
  project: RedmineProject;
  assignedIssues: Issue[];
  hasAssignedIssues: boolean;
  /** Total issues including subprojects (for parent highlighting) */
  totalIssuesWithSubprojects: number;
}

type TreeItem = ProjectNode | Issue | LoadingPlaceholder;




/**
 * Type guard for ProjectNode
 */
function isProjectNode(item: TreeItem): item is ProjectNode {
  return "project" in item && item.project instanceof RedmineProject;
}

/**
 * Type guard for Issue
 */
function isIssue(item: TreeItem): item is Issue {
  return "subject" in item && "tracker" in item;
}


export class ProjectsTree extends BaseTreeProvider<TreeItem> {
  server?: RedmineServer;
  viewStyle: ProjectsViewStyle;
  projects: RedmineProject[] | null = null;
  private projectNodes: ProjectNode[] = [];
  private isLoadingProjects = false;
  private loadingIssuesForProject = new Set<number>();
  private assignedIssues: Issue[] = [];
  private issueFilter: IssueFilter = { ...DEFAULT_ISSUE_FILTER };
  private issueSort: SortConfig<IssueSortField> | null = null; // null = use risk sorting
  private issuesByProject = new Map<number, Issue[]>();
  private issuesByParent = new Map<number, Issue[]>(); // parent issue ID → child issues
  private flexibilityCache = new Map<number, FlexibilityScore | null>();

  constructor() {
    super();
    this.viewStyle = ProjectsViewStyle.TREE;

    // Listen for config changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("redmine.workingHours")) {
          clearFlexibilityCache();
          this.flexibilityCache.clear();
          this.refresh();
        }
      })
    );
  }

  getTreeItem(item: TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    if (isLoadingPlaceholder(item)) {
      return createLoadingTreeItem(item.message);
    }

    if (isProjectNode(item)) {
      return this.createProjectTreeItem(item);
    }

    // Issue item - always use enhanced styling
    const issue = item as Issue;
    const flexibility = this.flexibilityCache.get(issue.id) ?? null;
    const showAssignee = this.issueFilter.assignee !== "me";

    const treeItem = createEnhancedIssueTreeItem(
      issue,
      flexibility,
      this.server,
      "redmine.openActionsForIssue",
      showAssignee
    );

    // Make collapsible if issue has children
    const hasChildren = this.issuesByParent.has(issue.id);
    if (hasChildren) {
      treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    }

    return treeItem;
  }

  /**
   * Create tree item for a project node
   */
  private createProjectTreeItem(node: ProjectNode): vscode.TreeItem {
    const {
      project,
      assignedIssues,
      hasAssignedIssues,
      totalIssuesWithSubprojects,
    } = node;

    const treeItem = new vscode.TreeItem(
      project.toQuickPickItem().label,
      vscode.TreeItemCollapsibleState.Collapsed
    );

    // Check if has issues directly or in subprojects
    const hasAnyIssues = totalIssuesWithSubprojects > 0;
    const subprojectIssues = totalIssuesWithSubprojects - assignedIssues.length;

    if (hasAssignedIssues) {
      // Project with direct assigned issues
      const subNote =
        subprojectIssues > 0 ? ` +${subprojectIssues} in subprojects` : "";
      treeItem.description = `(${assignedIssues.length} assigned${subNote})`;
      treeItem.iconPath = new vscode.ThemeIcon(
        "folder-opened",
        new vscode.ThemeColor("list.highlightForeground")
      );
      treeItem.contextValue = "project-with-issues";
    } else if (hasAnyIssues) {
      // Parent project with issues only in subprojects
      treeItem.description = `(${subprojectIssues} in subprojects)`;
      treeItem.iconPath = new vscode.ThemeIcon(
        "folder-opened",
        new vscode.ThemeColor("list.highlightForeground")
      );
      treeItem.contextValue = "project-with-issues";
    } else {
      // Project without any assigned issues
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

    // Handle issue expansion - return child issues
    if (projectOrIssue && isIssue(projectOrIssue)) {
      const children = this.issuesByParent.get(projectOrIssue.id) || [];
      return this.sortIssues(children);
    }

    // Handle project expansion
    if (projectOrIssue && isProjectNode(projectOrIssue)) {
      const { project, assignedIssues, hasAssignedIssues } = projectOrIssue;

      // Get subprojects if in tree view mode
      const subprojects = this.viewStyle === ProjectsViewStyle.TREE
        ? (this.projects ?? [])
            .filter((p) => p.parent && p.parent.id === project.id)
            .map((p) => this.createProjectNode(p))
        : [];

      if (hasAssignedIssues) {
        // Return subprojects + root-level issues
        const rootIssues = this.filterRootIssues(assignedIssues);
        return [...subprojects, ...this.sortIssues(rootIssues)];
      }

      // No assigned issues - fall back to fetching all open issues
      if (this.loadingIssuesForProject.has(project.id)) {
        return [{ isLoadingPlaceholder: true, message: "Loading issues..." }];
      }

      this.loadingIssuesForProject.add(project.id);
      try {
        // Fetch open issues for project
        let issues: Issue[] = [];
        try {
          issues = (
            await this.server.getOpenIssuesForProject(project.id, false)
          ).issues;
        } catch {
          // 403 = no access to project issues, show subprojects only
        }
        return [...subprojects, ...issues];
      } finally {
        this.loadingIssuesForProject.delete(project.id);
      }
    }

    // Root level - fetch projects and assigned issues
    if (this.isLoadingProjects) {
      return [{ isLoadingPlaceholder: true, message: "Loading projects..." }];
    }

    if (!this.projects) {
      this.isLoadingProjects = true;
      try {
        // Fetch projects and issues in parallel using current filter
        const [projects, issuesResult] = await Promise.all([
          this.server.getProjects(),
          this.server.getFilteredIssues(this.issueFilter),
        ]);

        this.projects = projects;
        this.assignedIssues = issuesResult.issues;

        // Calculate flexibility for assigned issues
        buildFlexibilityCache(this.assignedIssues, this.flexibilityCache, getWeeklySchedule());

        // Group issues by project
        this.issuesByProject = groupBy(
          this.assignedIssues.filter((i) => i.project?.id),
          (issue) => issue.project!.id
        );

        // Group issues by parent (for hierarchical display)
        this.issuesByParent = groupBy(
          this.assignedIssues.filter((i) => i.parent?.id),
          (issue) => issue.parent!.id
        );

        // Build project nodes
        this.projectNodes = this.projects.map((p) => this.createProjectNode(p));

        // Fire refresh in case VS Code received a loading placeholder during async load
        this.refresh();
      } finally {
        this.isLoadingProjects = false;
      }
    }

    // Sort and return project nodes
    return this.sortProjectNodes(this.projectNodes);
  }

  /**
   * Count issues recursively including subprojects
   */
  private countIssuesWithSubprojects(projectId: number): number {
    const direct = this.issuesByProject.get(projectId)?.length || 0;
    const subprojects = (this.projects || []).filter((p) => p.parent?.id === projectId);
    const subCount = subprojects.reduce(
      (sum, sub) => sum + this.countIssuesWithSubprojects(sub.id),
      0
    );
    return direct + subCount;
  }

  /**
   * Sort issues using current sort config or risk-based default
   */
  private sortIssues(issues: Issue[]): Issue[] {
    if (this.issueSort) {
      return sortIssuesByField(issues, this.issueSort);
    }
    return sortIssuesByRisk(issues, this.flexibilityCache);
  }

  /**
   * Filter to root-level issues (no parent or parent not in the assigned set)
   */
  private filterRootIssues(issues: Issue[]): Issue[] {
    const issueIds = new Set(issues.map((i) => i.id));
    return issues.filter((issue) => {
      // No parent = root
      if (!issue.parent?.id) return true;
      // Parent not in our set = treat as root (parent not visible)
      return !issueIds.has(issue.parent.id);
    });
  }

  /**
   * Create a project node with assigned issues info
   */
  private createProjectNode(project: RedmineProject): ProjectNode {
    const assignedIssues = this.issuesByProject.get(project.id) || [];
    const totalIssuesWithSubprojects = this.countIssuesWithSubprojects(
      project.id
    );
    return {
      project,
      assignedIssues,
      hasAssignedIssues: assignedIssues.length > 0,
      totalIssuesWithSubprojects,
    };
  }

  /**
   * Sort project nodes alphabetically
   */
  private sortProjectNodes(nodes: ProjectNode[]): ProjectNode[] {
    // Apply tree view filtering if needed
    let filtered = nodes;
    if (this.viewStyle === ProjectsViewStyle.TREE) {
      filtered = nodes.filter((n) => !n.project.parent);
    }

    return filtered.sort((a, b) =>
      a.project.toQuickPickItem().label.localeCompare(
        b.project.toQuickPickItem().label
      )
    );
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
    this.projects = null;
    this.projectNodes = [];
    this.assignedIssues = [];
    this.issuesByProject.clear();
    this.issuesByParent.clear();
    this.flexibilityCache.clear();
    // Also clear server's project cache so next fetch gets fresh data
    this.server?.clearProjectsCache();
  }

  setViewStyle(style: ProjectsViewStyle) {
    this.viewStyle = style;
    this.refresh();
  }

  setServer(server: RedmineServer | undefined) {
    this.server = server;
    this.clearProjects();
  }

  /**
   * Set issue filter and refresh
   */
  setFilter(filter: IssueFilter): void {
    this.issueFilter = { ...filter };
    this.clearProjects();
    this.refresh();
  }

  /**
   * Get current filter
   */
  getFilter(): IssueFilter {
    return { ...this.issueFilter };
  }

  /**
   * Set sort field (toggles direction if same field)
   */
  setSort(field: IssueSortField): void {
    if (this.issueSort?.field === field) {
      this.issueSort.direction = this.issueSort.direction === "asc" ? "desc" : "asc";
    } else {
      this.issueSort = { field, direction: "asc" };
    }
    this.refresh();
  }

  /**
   * Get current sort config
   */
  getSort(): SortConfig<IssueSortField> | null {
    return this.issueSort;
  }

  /**
   * Check if showing issues beyond "my open issues" (for UI icon state)
   */
  isFiltered(): boolean {
    return (
      this.issueFilter.assignee !== "me" || this.issueFilter.status !== "open"
    );
  }
}
