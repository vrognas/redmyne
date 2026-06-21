import { beforeEach, describe, it, expect, vi } from "vitest";
import { ProjectsTree, ProjectsViewStyle } from "../../../src/trees/projects-tree";
import { Issue } from "../../../src/redmine/models/issue";
import { RedmineProject } from "../../../src/redmine/redmine-project";

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 7392,
    subject: "Test Issue 1234",
    tracker: { id: 1, name: "Tasks" },
    status: { id: 1, name: "Not Yet Started" },
    author: { id: 1, name: "Author" },
    project: { id: 1, name: "Test Project" },
    priority: { id: 1, name: "Normal" },
    description: "",
    created_on: "2024-01-01",
    updated_on: "2024-01-01",
    ...overrides,
  };
}

describe("ProjectsTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("issue formatting", () => {
    it("should format issue label with ID prefix", () => {
      const tree = new ProjectsTree();
      const issue = createIssue({ author: { id: 1, name: "Viktor Rognås" } });

      const treeItem = tree.getTreeItem(issue);

      expect(treeItem.label).toBe("#7392 Test Issue 1234");
    });

    it("should format issue description as hours", () => {
      const tree = new ProjectsTree();
      const issue = createIssue({ author: { id: 1, name: "Viktor Rognås" } });

      const treeItem = tree.getTreeItem(issue);

      // Shows hours (0:00/0:00 when no hours set)
      expect(treeItem.description).toBe("0:00/0:00");
    });

    it("should use same format as MyIssuesTree", () => {
      const tree = new ProjectsTree();
      const issue = createIssue({
        id: 123,
        subject: "Shared Format Test",
        tracker: { id: 1, name: "Bug" },
        status: { id: 2, name: "In Progress" },
        project: { id: 1, name: "Project" },
      });

      const treeItem = tree.getTreeItem(issue);

      // Consistent format: #id Subject, hours in description
      expect(treeItem.label).toBe("#123 Shared Format Test");
      expect(treeItem.description).toBe("0:00/0:00");
    });
  });

  describe("view description reflects active filters", () => {
    it("shows the active task-type filter and clears it on 'any'", () => {
      const tree = new ProjectsTree();
      const view: { description?: string } = {};
      tree.setTreeView(view as never);

      tree.setTaskTypeFilter("Data Management");
      expect(view.description).toContain("Data Management");

      tree.setTaskTypeFilter("any");
      expect(view.description).toBeUndefined();
    });
  });

  describe("project formatting", () => {
    it("should format project with collapsible state", () => {
      const tree = new ProjectsTree();
      const project = new RedmineProject({
        id: 1,
        name: "Test Project",
        identifier: "test-proj",
        description: "A test project",
      });

      // ProjectsTree now wraps projects in ProjectNode
      const projectNode = {
        project,
        assignedIssues: [],
        hasAssignedIssues: false,
      };

      const treeItem = tree.getTreeItem(projectNode);

      expect(treeItem.label).toBe("Test Project");
      expect(treeItem.collapsibleState).toBe(1); // Collapsed
    });

    it("should show issue count for projects with assigned issues", () => {
      const tree = new ProjectsTree();
      const project = new RedmineProject({
        id: 1,
        name: "Test Project",
        identifier: "test-proj",
        description: "A test project",
      });

      const issue = createIssue({
        id: 123,
        subject: "Test Issue",
        tracker: { id: 1, name: "Bug" },
        status: { id: 1, name: "Open" },
        project: { id: 1, name: "Test Project" },
      });

      const projectNode = {
        project,
        assignedIssues: [issue],
        hasAssignedIssues: true,
        totalIssuesWithSubprojects: 1,
      };

      // Populate issuesByProject so createProjectTreeItem can count direct issues
      (tree as any).issuesByProject = new Map([[1, [issue]]]);
      (tree as any).projects = [project];

      const treeItem = tree.getTreeItem(projectNode);

      expect(treeItem.description).toBe("1 issue");
    });
  });

  describe("sortProjectNodes filtering", () => {
    it("shows empty projects by default, hides them only when showEmptyProjects is explicitly false", () => {
      const tree = new ProjectsTree();
      tree.viewStyle = ProjectsViewStyle.LIST;

      const emptyProject = new RedmineProject({
        id: 1,
        name: "Empty Project",
        identifier: "empty-proj",
      });
      const projectWithIssues = new RedmineProject({
        id: 2,
        name: "Active Project",
        identifier: "active-proj",
      });

      // Access private method via casting for testing
      const nodes = [
        { project: emptyProject, assignedIssues: [], hasAssignedIssues: false, totalIssuesWithSubprojects: 0 },
        { project: projectWithIssues, assignedIssues: [{} as Issue], hasAssignedIssues: true, totalIssuesWithSubprojects: 1 },
      ];
      const sortNodes = () =>
        (tree as unknown as { sortProjectNodes: (n: typeof nodes) => typeof nodes }).sortProjectNodes(nodes);

      // Default (assignee/status filter, flag not set): empty project still shown.
      tree.setFilter({ assignee: "me", status: "open" });
      expect(sortNodes()).toHaveLength(2);

      // Explicit false: empty project hidden.
      tree.setFilter({ assignee: "me", status: "open", showEmptyProjects: false });
      const hidden = sortNodes();
      expect(hidden).toHaveLength(1);
      expect(hidden[0].project.name).toBe("Active Project");
    });

    it("should show all projects when showEmptyProjects is true", () => {
      const tree = new ProjectsTree();
      tree.viewStyle = ProjectsViewStyle.LIST;

      const emptyProject = new RedmineProject({
        id: 1,
        name: "Empty Project",
        identifier: "empty-proj",
      });
      const projectWithIssues = new RedmineProject({
        id: 2,
        name: "Active Project",
        identifier: "active-proj",
      });

      const nodes = [
        { project: emptyProject, assignedIssues: [], hasAssignedIssues: false, totalIssuesWithSubprojects: 0 },
        { project: projectWithIssues, assignedIssues: [{} as Issue], hasAssignedIssues: true, totalIssuesWithSubprojects: 1 },
      ];

      // Set filter with showEmptyProjects: true
      tree.setFilter({ assignee: "any", status: "any", showEmptyProjects: true });

      const sorted = (tree as unknown as { sortProjectNodes: (nodes: typeof nodes) => typeof nodes }).sortProjectNodes(nodes);

      expect(sorted).toHaveLength(2);
    });

    it("shows a parent with issues only in subprojects even when showEmptyProjects is false", () => {
      const tree = new ProjectsTree();
      tree.viewStyle = ProjectsViewStyle.LIST;

      // Parent has no direct issues but subprojects have issues
      const parentProject = new RedmineProject({
        id: 1,
        name: "Parent Project",
        identifier: "parent-proj",
      });

      const nodes = [
        { project: parentProject, assignedIssues: [], hasAssignedIssues: false, totalIssuesWithSubprojects: 3 },
      ];

      tree.setFilter({ assignee: "me", status: "open", showEmptyProjects: false });

      const sorted = (tree as unknown as { sortProjectNodes: (nodes: typeof nodes) => typeof nodes }).sortProjectNodes(nodes);

      // Should still show because totalIssuesWithSubprojects > 0
      expect(sorted).toHaveLength(1);
    });
  });

  describe("filter presets", () => {
    it("should set My Issues filter (assignee: me, status: any)", () => {
      const tree = new ProjectsTree();
      tree.setFilter({ assignee: "me", status: "any" });

      const filter = tree.getFilter();
      expect(filter.assignee).toBe("me");
      expect(filter.status).toBe("any");
      // Preserved from DEFAULT_ISSUE_FILTER (show by default), not dropped.
      expect(filter.showEmptyProjects).toBe(true);
    });

    it("should set No Filter (assignee: any, status: any, showEmptyProjects: true)", () => {
      const tree = new ProjectsTree();
      tree.setFilter({ assignee: "any", status: "any", showEmptyProjects: true });

      const filter = tree.getFilter();
      expect(filter.assignee).toBe("any");
      expect(filter.status).toBe("any");
      expect(filter.showEmptyProjects).toBe(true);
    });

    it("preserves showEmptyProjects across later filter changes (explicit false stays false)", () => {
      const tree = new ProjectsTree();
      tree.setFilter({ assignee: "any", status: "any", showEmptyProjects: false });
      expect(tree.getFilter().showEmptyProjects).toBe(false);

      // Changing assignee/status without the flag must not silently reset it.
      tree.setFilter({ assignee: "me", status: "open" });
      expect(tree.getFilter().showEmptyProjects).toBe(false);
    });
  });

  describe("async data flows", () => {
    it("returns empty children when server is not configured", async () => {
      const tree = new ProjectsTree();
      await expect(tree.getChildren()).resolves.toEqual([]);
    });

    it("loads projects/issues and fetches dependency issues", async () => {
      const rootProject = new RedmineProject({ id: 1, name: "Root", identifier: "root" });
      const childProject = new RedmineProject({ id: 2, name: "Child", identifier: "child", parent: { id: 1, name: "Root" } });
      const issue = createIssue({
        id: 41,
        project: { id: 2, name: "Child" },
        relations: [{ id: 1, issue_id: 41, issue_to_id: 900, relation_type: "blocks" }],
      });

      const server = {
        getProjects: vi.fn().mockResolvedValue([rootProject, childProject]),
        getFilteredIssues: vi.fn().mockResolvedValue({ issues: [issue] }),
        getIssuesByIds: vi.fn().mockResolvedValue([createIssue({ id: 900, subject: "Dependency" })]),
        clearProjectsCache: vi.fn(),
        getMemberships: vi.fn().mockResolvedValue([]),
        getCachedMemberships: vi.fn().mockReturnValue(undefined),
      };

      const tree = new ProjectsTree();
      tree.setServer(server as never);
      tree.setFilter({ assignee: "any", status: "open", showEmptyProjects: true });

      const topLevel = await tree.getChildren();
      expect(server.getProjects).toHaveBeenCalledTimes(1);
      expect(server.getFilteredIssues).toHaveBeenCalled();
      expect(server.getIssuesByIds).toHaveBeenCalledWith([900]);
      expect(topLevel.length).toBeGreaterThan(0);
      expect(tree.getDependencyIssues()).toHaveLength(1);
    });

    it("returns existing project nodes (not skeletons) when re-entered mid-stream", async () => {
      const tree = new ProjectsTree();
      const proj = new RedmineProject({ id: 1, name: "P", identifier: "p" });
      const node = {
        project: proj,
        assignedIssues: [],
        hasAssignedIssues: false,
        totalIssuesWithSubprojects: 0,
      };
      // setServer clears tree state, so configure server first then seed
      // internals to simulate "mid-stream: loading flag set, nodes populated".
      tree.setServer({ clearProjectsCache: vi.fn() } as never);
      const internals = tree as unknown as {
        isLoadingProjects: boolean;
        projects: RedmineProject[];
        projectNodes: typeof node[];
      };
      internals.isLoadingProjects = true;
      internals.projects = [proj];
      internals.projectNodes = [node];

      const result = await tree.getChildren();

      // Should return the 1 populated node, not the 5 skeleton placeholders.
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(node);
    });

    it("ignores stale onProgress and result after clearProjects() bumps loadToken", async () => {
      const project = new RedmineProject({ id: 1, name: "P", identifier: "p" });
      const staleIssue = createIssue({ id: 99, project: { id: 1, name: "P" } });

      let onProgressRef: ((issues: Issue[]) => void) | undefined;
      let resolveFetch: ((value: { issues: Issue[] }) => void) | undefined;

      const server = {
        getProjects: vi.fn().mockResolvedValue([project]),
        getFilteredIssues: vi.fn().mockImplementation(
          async (_filter: unknown, onProgress?: (issues: Issue[]) => void) => {
            onProgressRef = onProgress;
            return new Promise<{ issues: Issue[] }>((resolve) => {
              resolveFetch = resolve;
            });
          }
        ),
        getIssuesByIds: vi.fn().mockResolvedValue([]),
        clearProjectsCache: vi.fn(),
        getMemberships: vi.fn().mockResolvedValue([]),
        getCachedMemberships: vi.fn().mockReturnValue(undefined),
      };

      const tree = new ProjectsTree();
      tree.setServer(server as never);
      tree.setFilter({ assignee: "any", status: "any", showEmptyProjects: true });

      const loadPromise = tree.getChildren();
      // Let getChildren capture token and register onProgress.
      await Promise.resolve();
      await Promise.resolve();

      // Simulate filter change mid-load: bumps token, clears state.
      tree.clearProjects();

      // Stale onProgress fires post-clear — must be ignored.
      onProgressRef?.([staleIssue]);
      expect(tree.getAssignedIssues()).toEqual([]);

      // Complete the stale fetch; post-await stale guard must also bail.
      resolveFetch?.({ issues: [staleIssue] });
      await loadPromise;

      expect(tree.getAssignedIssues()).toEqual([]);
      expect(tree.getDependencyIssues()).toEqual([]);
    });

    it("skips redundant final applyIssues when streaming covered the full set", async () => {
      const project = new RedmineProject({ id: 1, name: "P", identifier: "p" });
      const i1 = createIssue({ id: 1, project: { id: 1, name: "P" } });
      const i2 = createIssue({ id: 2, project: { id: 1, name: "P" } });

      const tree = new ProjectsTree();
      const applySpy = vi.spyOn(
        tree as unknown as { applyIssues: (issues: Issue[]) => void },
        "applyIssues"
      );

      const server = {
        getProjects: vi.fn().mockResolvedValue([project]),
        getFilteredIssues: vi.fn().mockImplementation(
          async (_filter: unknown, onProgress?: (issues: Issue[]) => void) => {
            onProgress?.([i1]);
            onProgress?.([i1, i2]);
            return { issues: [i1, i2] };
          }
        ),
        getIssuesByIds: vi.fn().mockResolvedValue([]),
        clearProjectsCache: vi.fn(),
        getMemberships: vi.fn().mockResolvedValue([]),
        getCachedMemberships: vi.fn().mockReturnValue(undefined),
      };

      tree.setServer(server as never);
      tree.setFilter({ assignee: "any", status: "any", showEmptyProjects: true });
      await tree.getChildren();

      // Two onProgress applies, no redundant final apply.
      expect(applySpy).toHaveBeenCalledTimes(2);
      expect(tree.getAssignedIssues()).toHaveLength(2);
    });

    it("still applies issues once on cache-hit path where onProgress never fires", async () => {
      const project = new RedmineProject({ id: 1, name: "P", identifier: "p" });
      const issue = createIssue({ id: 1, project: { id: 1, name: "P" } });

      const tree = new ProjectsTree();
      const applySpy = vi.spyOn(
        tree as unknown as { applyIssues: (issues: Issue[]) => void },
        "applyIssues"
      );

      const server = {
        getProjects: vi.fn().mockResolvedValue([project]),
        // No onProgress invocation — simulates cached/single-page result.
        getFilteredIssues: vi.fn().mockResolvedValue({ issues: [issue] }),
        getIssuesByIds: vi.fn().mockResolvedValue([]),
        clearProjectsCache: vi.fn(),
        getMemberships: vi.fn().mockResolvedValue([]),
        getCachedMemberships: vi.fn().mockReturnValue(undefined),
      };

      tree.setServer(server as never);
      tree.setFilter({ assignee: "any", status: "any", showEmptyProjects: true });
      await tree.getChildren();

      expect(applySpy).toHaveBeenCalledTimes(1);
      expect(tree.getAssignedIssues()).toEqual([issue]);
    });

    it("updates assignedIssues incrementally as onProgress fires during load", async () => {
      const project = new RedmineProject({ id: 1, name: "Test", identifier: "test" });
      const i1 = createIssue({ id: 1, project: { id: 1, name: "Test" } });
      const i2 = createIssue({ id: 2, project: { id: 1, name: "Test" } });

      const tree = new ProjectsTree();
      const snapshots: number[] = [];
      const server = {
        getProjects: vi.fn().mockResolvedValue([project]),
        getFilteredIssues: vi.fn().mockImplementation(
          async (
            _filter: unknown,
            onProgress?: (issues: Issue[]) => void
          ) => {
            onProgress?.([i1]);
            snapshots.push(tree.getAssignedIssues().length);
            onProgress?.([i1, i2]);
            snapshots.push(tree.getAssignedIssues().length);
            return { issues: [i1, i2] };
          }
        ),
        getIssuesByIds: vi.fn().mockResolvedValue([]),
        clearProjectsCache: vi.fn(),
        getMemberships: vi.fn().mockResolvedValue([]),
        getCachedMemberships: vi.fn().mockReturnValue(undefined),
      };

      tree.setServer(server as never);
      tree.setFilter({ assignee: "any", status: "any", showEmptyProjects: true });

      await tree.getChildren();

      expect(snapshots).toEqual([1, 2]);
      expect(tree.getAssignedIssues()).toHaveLength(2);
      expect(server.getFilteredIssues).toHaveBeenCalledWith(
        expect.objectContaining({ assignee: "any", status: "any" }),
        expect.any(Function)
      );
    });

    it("expands project with no assigned issues using filter/server branches", async () => {
      const project = new RedmineProject({ id: 10, name: "Solo", identifier: "solo" });
      const server = {
        getProjects: vi.fn().mockResolvedValue([project]),
        getFilteredIssues: vi.fn().mockResolvedValue({ issues: [] }),
        getIssuesByIds: vi.fn().mockResolvedValue([]),
        getOpenIssuesForProject: vi.fn().mockRejectedValue(new Error("403")),
        clearProjectsCache: vi.fn(),
        getMemberships: vi.fn().mockResolvedValue([]),
        getCachedMemberships: vi.fn().mockReturnValue(undefined),
      };

      const tree = new ProjectsTree();
      tree.setServer(server as never);
      tree.setFilter({ assignee: "me", status: "open", showEmptyProjects: true });
      const nodes = await tree.getChildren();
      expect(nodes).toHaveLength(1);

      const projectNode = nodes[0];
      const meExpansion = await tree.getChildren(projectNode);
      expect(meExpansion).toEqual([]);

      tree.setFilter({ assignee: "any", status: "open", showEmptyProjects: true });
      const nodesAny = await tree.getChildren();
      const anyExpansion = await tree.getChildren(nodesAny[0]);
      expect(server.getOpenIssuesForProject).toHaveBeenCalledWith(10, false);
      expect(anyExpansion).toEqual([]);
    });

    it("resolves parent relationships for issues and projects", () => {
      const tree = new ProjectsTree();
      const parentProject = new RedmineProject({ id: 1, name: "Parent", identifier: "parent" });
      const childProject = new RedmineProject({ id: 2, name: "Child", identifier: "child", parent: { id: 1, name: "Parent" } });

      const parentIssue = createIssue({ id: 100, project: { id: 2, name: "Child" } });
      const childIssue = createIssue({ id: 101, project: { id: 2, name: "Child" }, parent: { id: 100 } });

      (tree as unknown as { assignedIssues: Issue[] }).assignedIssues = [parentIssue, childIssue];
      (tree as unknown as { projectNodes: Array<{ project: RedmineProject }> }).projectNodes = [
        { project: parentProject, assignedIssues: [], hasAssignedIssues: false, totalIssuesWithSubprojects: 0 },
        { project: childProject, assignedIssues: [parentIssue, childIssue], hasAssignedIssues: true, totalIssuesWithSubprojects: 2 },
      ];

      expect(tree.getParent(childIssue)).toEqual(parentIssue);
      const childProjectNode = (tree as unknown as { projectNodes: Array<{ project: RedmineProject }> }).projectNodes[1];
      expect(tree.getParent(childProjectNode as never)).toEqual(
        (tree as unknown as { projectNodes: Array<{ project: RedmineProject }> }).projectNodes[0]
      );
    });

    it("toggles sort direction and clears caches", () => {
      const server = { clearProjectsCache: vi.fn() };
      const tree = new ProjectsTree();
      tree.setServer(server as never);

      tree.setSort("id");
      expect(tree.getSort()).toEqual({ field: "id", direction: "asc" });
      tree.setSort("id");
      expect(tree.getSort()).toEqual({ field: "id", direction: "desc" });
      expect(tree.isFiltered()).toBe(true);

      tree.setFilter({ assignee: "me", status: "open" });
      expect(tree.isFiltered()).toBe(false);
      tree.setFilter({ assignee: "any", status: "any", showEmptyProjects: true });
      expect(tree.isFiltered()).toBe(true);
      tree.clearProjects();
      expect(server.clearProjectsCache).toHaveBeenCalled();
      expect(tree.getProjects()).toEqual([]);
    });
  });
});
