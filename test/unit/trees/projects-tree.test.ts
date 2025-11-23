import { describe, it, expect } from "vitest";
import { ProjectsTree } from "../../../src/trees/projects-tree";
import { Issue } from "../../../src/redmine/models/issue";
import { RedmineProject } from "../../../src/redmine/redmine-project";

describe("ProjectsTree", () => {
  describe("issue formatting", () => {
    it("should format issue label as subject only", () => {
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

      expect(treeItem.label).toBe("Test Issue 1234");
    });

    it("should format issue description as issue number", () => {
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

      expect(treeItem.description).toBe("#7392");
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

      expect(treeItem.label).toBe("Shared Format Test");
      expect(treeItem.description).toBe("#123");
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

      const treeItem = tree.getTreeItem(project);

      expect(treeItem.label).toBe("Test Project");
      expect(treeItem.collapsibleState).toBe(1); // Collapsed
    });
  });
});
