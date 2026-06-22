import { describe, it, expect } from "vitest";
import {
  generateToolbar,
  generateProjectOptions,
  generateAssigneeOptions,
  type GanttToolbarContext,
} from "../src/webviews/gantt/gantt-toolbar-generator";

const baseContext: GanttToolbarContext = {
  viewFocus: "project",
  selectedProjectId: null,
  selectedAssignee: null,
  currentUserName: "Viktor Rognås",
  uniqueAssignees: ["Viktor Rognås", "Alice Smith"],
  projects: [],
  lookbackDays: 730,
  zoomLevel: "month",
  currentFilter: { assignee: "me", status: "open" },
  taskTypeValues: [],
  selectedTaskType: "any",
  showDependencies: true,
  showBadges: true,
  showCapacityRibbon: true,
  showIntensity: false,
  sortBy: null,
  sortOrder: "asc",
  todayInRange: true,
  draftModeEnabled: false,
  draftQueueCount: 0,
  showEmptyProjects: true,
};

describe("gantt-toolbar-generator", () => {
  describe("generateToolbar", () => {
    it("renders draft mode toggle", () => {
      const html = generateToolbar(baseContext);
      expect(html).toContain('id="draftModeToggle"');
      expect(html).toContain("Enable Draft Mode");
    });

    it("renders draft mode active state", () => {
      const ctx = { ...baseContext, draftModeEnabled: true, draftQueueCount: 3 };
      const html = generateToolbar(ctx);
      expect(html).toContain("Disable Draft Mode");
      expect(html).toContain('class="draft-count-badge"');
      expect(html).toContain(">3</span>");
    });

    it("renders zoom selector with selected value", () => {
      const ctx = { ...baseContext, zoomLevel: "week" as const };
      const html = generateToolbar(ctx);
      expect(html).toContain('id="zoomSelect"');
      expect(html).toContain('value="week" selected');
    });

    it("renders task-type filter only when values exist, marking selection", () => {
      expect(generateToolbar(baseContext)).not.toContain('id="filterTaskType"');
      const ctx = {
        ...baseContext,
        taskTypeValues: ["Analysis", "Data Management"],
        selectedTaskType: "Data Management",
      };
      const html = generateToolbar(ctx);
      expect(html).toContain('id="filterTaskType"');
      expect(html).toContain('value="Data Management" selected');
      expect(html).toContain(">Analysis</option>");
    });

    it("renders view focus selector", () => {
      const html = generateToolbar(baseContext);
      expect(html).toContain('id="viewFocusSelect"');
      expect(html).toContain("By Project");
      expect(html).toContain("By Person");
    });

    it("renders project selector in project view", () => {
      const html = generateToolbar(baseContext);
      expect(html).toContain('id="projectSelector"');
      expect(html).not.toContain('id="focusSelector"');
    });

    it("renders person selector in person view", () => {
      const ctx = { ...baseContext, viewFocus: "person" as const };
      const html = generateToolbar(ctx);
      expect(html).toContain('id="focusSelector"');
      expect(html).not.toContain('id="projectSelector"');
    });

    it("renders assignee filter only in project view", () => {
      const projectHtml = generateToolbar(baseContext);
      expect(projectHtml).toContain('id="filterAssignee"');

      const personHtml = generateToolbar({ ...baseContext, viewFocus: "person" });
      expect(personHtml).not.toContain('id="filterAssignee"');
    });

    it("renders today button disabled when out of range", () => {
      const ctx = { ...baseContext, todayInRange: false };
      const html = generateToolbar(ctx);
      expect(html).toContain('id="todayBtn"');
      expect(html).toContain("disabled");
    });

    it("renders overflow menu with toggle items", () => {
      const html = generateToolbar(baseContext);
      expect(html).toContain('id="menuDeps"');
      expect(html).toContain('id="menuBadges"');
      expect(html).toContain('id="menuCapacity"');
      expect(html).toContain('id="menuIntensity"');
    });

    it("renders the empty-projects checkbox, disabled in person view", () => {
      const projectHtml = generateToolbar(baseContext); // project view
      expect(projectHtml).toContain('id="emptyProjectsToggle"');
      expect(projectHtml).not.toMatch(/id="emptyProjectsToggle"[^>]*disabled/);

      // No empty projects exist in By-Person view, so the toggle is disabled.
      const personHtml = generateToolbar({ ...baseContext, viewFocus: "person" });
      expect(personHtml).toMatch(/id="emptyProjectsToggle"[^>]*disabled/);
    });
  });

  describe("generateProjectOptions", () => {
    it("renders flat project list", () => {
      const projects = [
        { id: 1, name: "Alpha", parent: undefined },
        { id: 2, name: "Beta", parent: undefined },
      ];
      const html = generateProjectOptions(projects, null);
      expect(html).toContain('value="1"');
      expect(html).toContain("Alpha");
      expect(html).toContain('value="2"');
      expect(html).toContain("Beta");
    });

    it("renders hierarchical project list with indentation", () => {
      const projects = [
        { id: 1, name: "Parent", parent: undefined },
        { id: 2, name: "Child", parent: { id: 1, name: "Parent" } },
      ];
      const html = generateProjectOptions(projects, null);
      // Child should be indented with non-breaking spaces
      expect(html).toContain("\u00A0\u00A0Child");
    });

    it("marks selected project", () => {
      const projects = [{ id: 1, name: "Alpha", parent: undefined }];
      const html = generateProjectOptions(projects, 1);
      expect(html).toContain('value="1" selected');
    });

    it("renders orphaned project whose parent is absent at top level", () => {
      // Parent id 99 is not in the projects array (filtered/paginated out)
      const projects = [
        { id: 2, name: "Orphan", parent: { id: 99, name: "Missing" } },
      ];
      const html = generateProjectOptions(projects, 2);
      // Must still render, marked selected, at depth 0 (no indentation)
      expect(html).toContain('value="2" selected');
      expect(html).toContain(">Orphan</option>");
    });
  });

  describe("generateAssigneeOptions", () => {
    it("renders assignee list with current user marked", () => {
      const html = generateAssigneeOptions(
        ["Viktor Rognås", "Alice Smith"],
        "Viktor Rognås",
        "Viktor Rognås"
      );
      expect(html).toContain("Viktor Rognås (me)");
      expect(html).toContain("Alice Smith");
      expect(html).not.toContain("Alice Smith (me)");
    });

    it("marks selected assignee", () => {
      const html = generateAssigneeOptions(
        ["Viktor Rognås", "Alice Smith"],
        "Alice Smith",
        "Viktor Rognås"
      );
      expect(html).toContain('value="Alice Smith" selected');
    });
  });
});
