import { describe, it, expect } from "vitest";
import { ProjectsTree, ProjectsViewStyle } from "../../../src/trees/projects-tree";
import { Issue } from "../../../src/redmine/models/issue";
import { RedmineProject } from "../../../src/redmine/redmine-project";

describe("ProjectsTree", () => {
  describe("issue formatting", () => {
    it("should format issue label with ID prefix", () => {
      const tree = new ProjectsTree();
      const issue: Issue = {
        id: 7392,
        subject: "Test Issue 1234",
        tracker: { id: 1, name: "Tasks" },
        status: { id: 1, name: "Not Yet Started" },
        author: { id: 1, name: "Viktor Rognås" },
        project: { id: 1, name: "Test Project" },
        priority: { id: 1, name: "Normal" },
        description: "",
        created_on: "2024-01-01",
        updated_on: "2024-01-01",
      };

      const treeItem = tree.getTreeItem(issue);

      expect(treeItem.label).toBe("#7392 Test Issue 1234");
    });

    it("should format issue description as hours", () => {
      const tree = new ProjectsTree();
      const issue: Issue = {
        id: 7392,
        subject: "Test Issue 1234",
        tracker: { id: 1, name: "Tasks" },
        status: { id: 1, name: "Not Yet Started" },
        author: { id: 1, name: "Viktor Rognås" },
        project: { id: 1, name: "Test Project" },
        priority: { id: 1, name: "Normal" },
        description: "",
        created_on: "2024-01-01",
        updated_on: "2024-01-01",
      };

      const treeItem = tree.getTreeItem(issue);

      // Shows hours (0:00/0:00 when no hours set)
      expect(treeItem.description).toBe("0:00/0:00");
    });

    it("should use same format as MyIssuesTree", () => {
      const tree = new ProjectsTree();
      const issue: Issue = {
        id: 123,
        subject: "Shared Format Test",
        tracker: { id: 1, name: "Bug" },
        status: { id: 2, name: "In Progress" },
        author: { id: 1, name: "Author" },
        project: { id: 1, name: "Project" },
        priority: { id: 1, name: "Normal" },
        description: "",
        created_on: "2024-01-01",
        updated_on: "2024-01-01",
      };

      const treeItem = tree.getTreeItem(issue);

      // Consistent format: #id Subject, hours in description
      expect(treeItem.label).toBe("#123 Shared Format Test");
      expect(treeItem.description).toBe("0:00/0:00");
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

      const issue: Issue = {
        id: 123,
        subject: "Test Issue",
        tracker: { id: 1, name: "Bug" },
        status: { id: 1, name: "Open" },
        author: { id: 1, name: "Author" },
        project: { id: 1, name: "Test Project" },
        priority: { id: 1, name: "Normal" },
        description: "",
        created_on: "2024-01-01",
        updated_on: "2024-01-01",
      };

      const projectNode = {
        project,
        assignedIssues: [issue],
        hasAssignedIssues: true,
      };

      const treeItem = tree.getTreeItem(projectNode);

      expect(treeItem.description).toBe("(1)");
    });
  });

  describe("sortProjectNodes filtering", () => {
    it("should hide empty projects when showEmptyProjects is false (default)", () => {
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

      // Set filter without showEmptyProjects (default: false)
      tree.setFilter({ assignee: "me", status: "open" });

      // Use the internal method via type casting
      const sorted = (tree as unknown as { sortProjectNodes: (nodes: typeof nodes) => typeof nodes }).sortProjectNodes(nodes);

      expect(sorted).toHaveLength(1);
      expect(sorted[0].project.name).toBe("Active Project");
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

    it("should show parent project with issues only in subprojects when showEmptyProjects is false", () => {
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

      tree.setFilter({ assignee: "me", status: "open" });

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
      expect(filter.showEmptyProjects).toBeUndefined();
    });

    it("should set No Filter (assignee: any, status: any, showEmptyProjects: true)", () => {
      const tree = new ProjectsTree();
      tree.setFilter({ assignee: "any", status: "any", showEmptyProjects: true });

      const filter = tree.getFilter();
      expect(filter.assignee).toBe("any");
      expect(filter.status).toBe("any");
      expect(filter.showEmptyProjects).toBe(true);
    });
  });
});
