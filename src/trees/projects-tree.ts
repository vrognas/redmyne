import * as vscode from "vscode";
import type { IRedmineServer } from "../redmine/redmine-server-interface";
import { RedmineProject } from "../redmine/redmine-project";
import { Issue } from "../redmine/models/issue";
import { IssueFilter, DEFAULT_ISSUE_FILTER, IssueSortField, SortConfig } from "../redmine/models/common";
import { createEnhancedIssueTreeItem, createProjectTooltip } from "../utilities/tree-item-factory";
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
import { debounce } from "../utilities/debounce";
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


const FILTER_KEY = "redmyne.issueFilter";
const SORT_KEY = "redmyne.issueSort";

export class ProjectsTree extends BaseTreeProvider<TreeItem> {
  server?: IRedmineServer;
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
  private projectsByParent = new Map<number, RedmineProject[]>(); // parent project ID → child projects
  private flexibilityCache = new Map<number, FlexibilityScore | null>();
  private globalState?: vscode.Memento;
  // Coalesce per-page refresh during streaming load so VS Code re-queries
  // tree nodes at most ~5×/sec instead of once per pagination batch.
  private debouncedRefresh = debounce(150, () => this.refresh());
  // Bumped by clearProjects() to invalidate any in-flight streaming load.
  // Each load captures the current value; stale callbacks check before
  // mutating state.
  private loadToken = 0;

  constructor(globalState?: vscode.Memento) {
    super();
    this.globalState = globalState;
    this.viewStyle = ProjectsViewStyle.TREE;

    // Restore saved filter/sort
    if (globalState) {
      const savedFilter = globalState.get<IssueFilter>(FILTER_KEY);
      if (savedFilter) {
        this.issueFilter = savedFilter;
      }
      const savedSort = globalState.get<SortConfig<IssueSortField>>(SORT_KEY);
      if (savedSort) {
        this.issueSort = savedSort;
      }
    }

    // Listen for config changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("redmyne.workingHours")) {
          clearFlexibilityCache();
          this.flexibilityCache.clear();
          this.refresh();
        }
      })
    );

    // Cancel any pending debounced refresh on dispose so a stale timer
    // doesn't fire refresh() against a disposed EventEmitter.
    this.disposables.push({ dispose: () => this.debouncedRefresh.cancel() });
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
      "redmyne.openActionsForIssue",
      showAssignee
    );

    // Make collapsible if issue has children
    const hasChildren = this.issuesByParent.has(issue.id);
    if (hasChildren) {
      treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    }

    return treeItem;
  }

  async resolveTreeItem(item: vscode.TreeItem, element: TreeItem): Promise<vscode.TreeItem> {
    if (isProjectNode(element) && this.server) {
      const config = vscode.workspace.getConfiguration("redmyne");
      const showMembers = config.get<boolean>("showProjectMembers", true);
      const excludeIds = config.get<number[]>("hideProjectMembersFor", []);
      const shouldFetch = showMembers && !excludeIds.includes(element.project.id);
      // Use cached members first (instant), fetch if not cached
      const cached = shouldFetch ? this.server.getCachedMemberships(element.project.id) : undefined;
      if (cached) {
        item.tooltip = createProjectTooltip(element.project, this.server, cached);
      } else if (shouldFetch) {
        try {
          const members = await this.server.getMemberships(element.project.id);
          item.tooltip = createProjectTooltip(element.project, this.server, members);
        } catch {
          item.tooltip = createProjectTooltip(element.project, this.server);
        }
      } else {
        item.tooltip = createProjectTooltip(element.project, this.server);
      }
    }
    return item;
  }

  /**
   * Create tree item for a project node
   */
  private createProjectTreeItem(node: ProjectNode): vscode.TreeItem {
    const { project, totalIssuesWithSubprojects } = node;

    const treeItem = new vscode.TreeItem(
      project.toQuickPickItem().label,
      vscode.TreeItemCollapsibleState.Collapsed
    );

    // Set id for tree item persistence across refreshes
    treeItem.id = `project-${project.id}`;

    // Count direct subprojects and direct issues
    const subprojectCount = (this.projects ?? []).filter(p => p.parent?.id === project.id).length;
    const directIssueCount = (this.issuesByProject.get(project.id) || []).length;
    const hasAnyIssues = totalIssuesWithSubprojects > 0;

    if (hasAnyIssues) {
      const parts: string[] = [];
      if (subprojectCount > 0) parts.push(`${subprojectCount} ${subprojectCount === 1 ? "project" : "projects"}`);
      if (directIssueCount > 0) parts.push(`${directIssueCount} ${directIssueCount === 1 ? "issue" : "issues"}`);
      treeItem.description = parts.length > 0 ? parts.join(" · ") : "";
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

    // Tooltip set lazily via resolveTreeItem (includes members)

    return treeItem;
  }

  async getChildren(projectOrIssue?: TreeItem): Promise<TreeItem[]> {
    if (!this.server) return [];

    if (projectOrIssue && isIssue(projectOrIssue)) {
      const children = this.issuesByParent.get(projectOrIssue.id) || [];
      return this.sortIssues(children);
    }

    if (projectOrIssue && isProjectNode(projectOrIssue)) {
      return this.expandProjectNode(projectOrIssue);
    }

    // Root level. Skeleton only when we genuinely have nothing to show; once
    // project nodes are populated (even partially during streaming), render
    // them instead so VS Code's re-query after debouncedRefresh paints
    // incremental progress.
    if (this.isLoadingProjects && this.projectNodes.length === 0) {
      return createSkeletonPlaceholders(5);
    }
    if (!this.projects) await this.loadRoot();
    return this.sortProjectNodes(this.projectNodes);
  }

  /**
   * Build the children of an expanded project node: subprojects (tree view)
   * plus either the project's assigned issues or — when not filtering by
   * assignee — all open issues fetched on demand. Per-project load is gated
   * by loadingIssuesForProject so concurrent expansions return a skeleton.
   */
  private async expandProjectNode(node: ProjectNode): Promise<TreeItem[]> {
    if (!this.server) return [];
    const { project, assignedIssues, hasAssignedIssues } = node;

    const subprojects = this.viewStyle === ProjectsViewStyle.TREE
      ? (this.projectsByParent.get(project.id) ?? [])
          .map((p) => this.createProjectNode(p))
      : [];

    if (hasAssignedIssues) {
      const rootIssues = this.filterRootIssues(assignedIssues);
      return [...subprojects, ...this.sortIssues(rootIssues)];
    }

    // No assigned issues — only show subprojects when filtered by "me"
    // (don't fetch all issues as that would ignore the filter).
    if (this.issueFilter.assignee === "me") return subprojects;

    if (this.loadingIssuesForProject.has(project.id)) {
      return createSkeletonPlaceholders(3);
    }

    this.loadingIssuesForProject.add(project.id);
    try {
      let issues: Issue[] = [];
      try {
        issues = (await this.server.getOpenIssuesForProject(project.id, false)).issues;
      } catch {
        // 403 = no access to project issues, show subprojects only
      }
      return [...subprojects, ...issues];
    } finally {
      this.loadingIssuesForProject.delete(project.id);
    }
  }

  /**
   * Fetch projects + assigned issues for the root level, streaming pages in
   * as they arrive. Idempotent against mid-load filter changes via loadToken:
   * clearProjects() bumps the token, and every state mutation here checks
   * before writing. Stale callbacks return without corrupting the cleared
   * state; the next getChildren starts a fresh load.
   */
  private async loadRoot(): Promise<void> {
    if (!this.server) return;
    this.isLoadingProjects = true;
    const myToken = this.loadToken;
    try {
      // Assign projects as soon as they arrive so streamed onProgress pages
      // can build project nodes — otherwise the first ~1s of streamed issues
      // would have no project structure to attach to.
      const projectsPromise = this.server.getProjects().then((projects) => {
        if (this.loadToken === myToken) {
          this.applyProjects(projects);
          this.debouncedRefresh();
        }
        return projects;
      });

      // Stream partial issue pages into the tree as they arrive. The first
      // page renders ~1s after refresh starts instead of waiting for the
      // full ~16s pagination set; debouncedRefresh coalesces re-renders.
      // Refresh is gated on projects already being applied — otherwise
      // rebuildProjectNodes is a no-op, projectNodes stays empty, and the
      // re-query just paints another skeleton. The next applyProjects (or
      // final applyIssues) will fire its own refresh.
      let onProgressFired = false;
      const onProgress = (issuesSoFar: Issue[]) => {
        if (this.loadToken !== myToken) return;
        onProgressFired = true;
        this.applyIssues(issuesSoFar);
        if (this.projects) this.debouncedRefresh();
      };

      const [projects, issuesResult] = await Promise.all([
        projectsPromise,
        this.server.getFilteredIssues(this.issueFilter, onProgress),
      ]);

      if (this.loadToken !== myToken) return;

      // Start dependency fetch in background (don't await yet)
      const depIds = extractSchedulingDependencyIds(issuesResult.issues);
      const depPromise = depIds.size > 0
        ? this.server.getIssuesByIds([...depIds])
        : Promise.resolve([]);

      // Skip the final apply when streaming already covered the full set —
      // saves a redundant flexibility-cache + groupBy rebuild on the
      // heaviest page. Mid-stream order is page-completion, not offset;
      // tree sorts internally and external consumers tolerate either.
      if (!onProgressFired) this.applyIssues(issuesResult.issues);

      // Await dependency fetch (likely already done while we grouped)
      const deps = await depPromise;
      if (this.loadToken !== myToken) return;
      this.dependencyIssues = deps;

      this.debouncedRefresh.cancel();
      this.refresh();
      this.preloadMemberships(projects);
    } finally {
      this.isLoadingProjects = false;
      // If our load was invalidated mid-flight, fire a refresh so VS Code
      // re-queries and the next getChildren can start a fresh load.
      if (this.loadToken !== myToken) this.refresh();
    }
  }

  /**
   * Apply project-derived state. Called once when getProjects() resolves.
   */
  private applyProjects(projects: RedmineProject[]): void {
    this.projects = projects;
    // Parent→children map for O(1) subproject lookups in
    // countIssuesWithSubprojects.
    this.projectsByParent = groupBy(
      projects.filter((p) => p.parent?.id),
      (p) => p.parent!.id
    );
    this.rebuildProjectNodes();
  }

  /**
   * Apply issue-derived state. Called once per streamed page and again with
   * the final issue set after pagination completes.
   */
  private applyIssues(issues: Issue[]): void {
    this.assignedIssues = issues;
    buildFlexibilityCache(issues, this.flexibilityCache, getWeeklySchedule());
    this.issuesByProject = groupBy(
      issues.filter((i) => i.project?.id),
      (issue) => issue.project!.id
    );
    this.issuesByParent = groupBy(
      issues.filter((i) => i.parent?.id),
      (issue) => issue.parent!.id
    );
    this.rebuildProjectNodes();
  }

  /**
   * Rebuild project nodes from current projects + issue groupings. No-op
   * until projects have been loaded.
   */
  private rebuildProjectNodes(): void {
    if (!this.projects) return;
    this.projectNodes = this.projects.map((p) => this.createProjectNode(p));
  }

  /**
   * Count issues recursively including subprojects.
   * Uses projectsByParent for O(N) total work across all projects (was
   * O(N²) when each call re-filtered this.projects).
   */
  private countIssuesWithSubprojects(projectId: number): number {
    const direct = this.issuesByProject.get(projectId)?.length || 0;
    const subprojects = this.projectsByParent.get(projectId) ?? [];
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
   * Preload memberships for all projects with issues (background, sequential to avoid API flood)
   */
  private static readonly MEMBERSHIP_BATCH_SIZE = 3;

  private async preloadMemberships(projects: RedmineProject[]): Promise<void> {
    if (!this.server) return;
    const config = vscode.workspace.getConfiguration("redmyne");
    const showMembers = config.get<boolean>("showProjectMembers", true);
    if (!showMembers) return;
    const excludeIds = config.get<number[]>("hideProjectMembersFor", []);

    const toPreload = projects.filter(p =>
      !excludeIds.includes(p.id) &&
      (this.issuesByProject.get(p.id)?.length ?? 0) > 0 &&
      !this.server!.getCachedMemberships(p.id)
    );

    for (let i = 0; i < toPreload.length; i += ProjectsTree.MEMBERSHIP_BATCH_SIZE) {
      const batch = toPreload.slice(i, i + ProjectsTree.MEMBERSHIP_BATCH_SIZE);
      await Promise.allSettled(batch.map(p => this.server!.getMemberships(p.id)));
    }
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
   * Sort project nodes alphabetically, optionally filtering empty projects
   */
  private sortProjectNodes(nodes: ProjectNode[]): ProjectNode[] {
    let filtered = nodes;

    // Apply tree view filtering if needed
    if (this.viewStyle === ProjectsViewStyle.TREE) {
      const projectIdSet = new Set((this.projects ?? []).map((project) => project.id));
      filtered = filtered.filter(
        (n) => !n.project.parent || !projectIdSet.has(n.project.parent.id)
      );
    }

    // Hide empty projects unless showEmptyProjects is true
    if (!this.issueFilter.showEmptyProjects) {
      filtered = filtered.filter((n) => n.totalIssuesWithSubprojects > 0);
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
   * Get project node by ID for reveal operations.
   * Returns the internal ProjectNode which is what the tree actually contains.
   */
  getProjectNodeById(projectId: number): TreeItem | undefined {
    return this.projectNodes.find((n) => n.project.id === projectId);
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
    // Invalidate any in-flight load so its callbacks won't write to the
    // state we're about to clear.
    this.loadToken++;
    this.debouncedRefresh.cancel();
    this.projects = null;
    this.projectNodes = [];
    this.assignedIssues = [];
    this.dependencyIssues = [];
    this.issuesByProject.clear();
    this.issuesByParent.clear();
    this.projectsByParent.clear();
    this.flexibilityCache.clear();
    // Also clear server's project cache so next fetch gets fresh data
    this.server?.clearProjectsCache();
  }

  setViewStyle(style: ProjectsViewStyle) {
    this.viewStyle = style;
    this.refresh();
  }

  setServer(server: IRedmineServer | undefined) {
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

