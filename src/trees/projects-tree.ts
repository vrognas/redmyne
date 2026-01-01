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
import { extractSchedulingDependencyIds } from "../utilities/dependency-extractor";
import { BaseTreeProvider } from "../shared/base-tree-provider";
import {
  LoadingPlaceholder,
  isLoadingPlaceholder,
  createSkeletonPlaceholders,
  createSkeletonTreeItem,
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


const FILTER_KEY = "redmine.issueFilter";
const SORT_KEY = "redmine.issueSort";

export class ProjectsTree extends BaseTreeProvider<TreeItem> {
  server?: RedmineServer;
  viewStyle: ProjectsViewStyle;
  projects: RedmineProject[] | null = null;
  private projectNodes: ProjectNode[] = [];
  private isLoadingProjects = false;
  private loadingIssuesForProject = new Set<number>();
  private assignedIssues: Issue[] = [];
  private dependencyIssues: Issue[] = []; // External scheduling dependencies
  private issueFilter: IssueFilter = { ...DEFAULT_ISSUE_FILTER };
  private issueSort: SortConfig<IssueSortField> | null = null; // null = use risk sorting
  private issuesByProject = new Map<number, Issue[]>();
  private issuesByParent = new Map<number, Issue[]>(); // parent issue ID → child issues
  private flexibilityCache = new Map<number, FlexibilityScore | null>();
  private globalState?: vscode.Memento;

  constructor(globalState?: vscode.Memento) {
    super();
    this.globalState = globalState;
    this.viewStyle = ProjectsViewStyle.TREE;

    // Restore saved filter/sort
    if (globalState) {
      const savedFilter = globalState.get<IssueFilter>(FILTER_KEY);
      if (savedFilter) {
        this.issueFilter = { ...DEFAULT_ISSUE_FILTER, ...savedFilter };
      }
      const savedSort = globalState.get<SortConfig<IssueSortField>>(SORT_KEY);
      if (savedSort) {
        this.issueSort = savedSort;
      }
    }

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
      return createSkeletonTreeItem(item);
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

    // Set id for tree item persistence across refreshes
    treeItem.id = `project-${project.id}`;

    // Check if has issues directly or in subprojects
    const hasAnyIssues = totalIssuesWithSubprojects > 0;
    const subprojectIssues = totalIssuesWithSubprojects - assignedIssues.length;

    if (hasAssignedIssues) {
      // Project with direct issues
      const count = assignedIssues.length;
      const subNote =
        subprojectIssues > 0 ? ` +${subprojectIssues} in subprojects` : "";
      treeItem.description = `(${count}${subNote})`;
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

      // No assigned issues - only show subprojects when filtered by "me"
      // (don't fetch all issues as that would ignore the filter)
      if (this.issueFilter.assignee === "me") {
        return subprojects;
      }

      // Fetch all open issues for project (only when not filtering by assignee)
      if (this.loadingIssuesForProject.has(project.id)) {
        return createSkeletonPlaceholders(3);
      }

      this.loadingIssuesForProject.add(project.id);
      try {
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
      return createSkeletonPlaceholders(5);
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

        // Fetch external scheduling dependencies (blockers not assigned to me)
        const depIds = extractSchedulingDependencyIds(this.assignedIssues);
        if (depIds.size > 0) {
          this.dependencyIssues = await this.server.getIssuesByIds([...depIds]);
        } else {
          this.dependencyIssues = [];
        }

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
   * Get external scheduling dependencies (blockers assigned to others)
   */
  getDependencyIssues(): Issue[] {
    return this.dependencyIssues;
  }

  /**
   * Get cached projects for external use (Gantt)
   */
  getProjects(): RedmineProject[] {
    return this.projects ?? [];
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
    this.dependencyIssues = [];
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
    this.globalState?.update(FILTER_KEY, this.issueFilter);
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
    this.globalState?.update(SORT_KEY, this.issueSort);
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

  /**
   * Get parent element for tree reveal functionality
   */
  getParent(element: TreeItem): TreeItem | null {
    if (isLoadingPlaceholder(element)) {
      return null;
    }

    if (isIssue(element)) {
      // If issue has a parent issue in our set, return it
      if (element.parent?.id) {
        const parentIssue = this.assignedIssues.find(i => i.id === element.parent!.id);
        if (parentIssue) {
          return parentIssue;
        }
      }
      // Otherwise, parent is the project node
      if (element.project?.id) {
        return this.projectNodes.find(n => n.project.id === element.project!.id) ?? null;
      }
      return null;
    }

    if (isProjectNode(element)) {
      // If project has a parent project, find its node
      if (element.project.parent?.id) {
        return this.projectNodes.find(n => n.project.id === element.project.parent!.id) ?? null;
      }
      // Root-level project has no parent
      return null;
    }

    return null;
  }
}
