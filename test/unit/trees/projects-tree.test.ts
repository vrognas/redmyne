import { describe, it, expect } from "vitest";
import { ProjectsTree } from "../../../src/trees/projects-tree";
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
        description: "Test description",
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
        description: "Test description",
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
        description: "Test",
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
        description: "Test",
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
});
