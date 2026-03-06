import { describe, expect, it } from "vitest";
import {
  buildHierarchy,
  buildProjectHierarchy,
  buildResourceHierarchy,
  flattenHierarchyAll,
  type HierarchyNode,
} from "../../../src/utilities/hierarchy-builder";
import { RedmineProject } from "../../../src/redmine/redmine-project";
import type { Issue } from "../../../src/redmine/models/issue";
import type { FlexibilityScore } from "../../../src/utilities/flexibility-calculator";

function issue(overrides: Partial<Issue> & { id: number; subject?: string }): Issue {
  return {
    id: overrides.id,
    subject: overrides.subject ?? `Issue ${overrides.id}`,
    project: overrides.project ?? { id: 1, name: "Project A" },
    tracker: { id: 1, name: "Task" },
    status: overrides.status ?? { id: 1, name: "Open", is_closed: false },
    priority: { id: 2, name: "Normal" },
    author: { id: 10, name: "Author" },
    assigned_to: overrides.assigned_to ?? { id: 99, name: "Me" },
    description: "",
    done_ratio: 0,
    is_private: false,
    created_on: "2025-01-01T00:00:00Z",
    updated_on: "2025-01-01T00:00:00Z",
    closed_on: null,
    start_date: overrides.start_date ?? null,
    due_date: overrides.due_date ?? null,
    estimated_hours: overrides.estimated_hours ?? 0,
    spent_hours: overrides.spent_hours ?? 0,
    parent: overrides.parent,
    relations: overrides.relations,
  };
}

function project(
  id: number,
  name: string,
  parent?: { id: number; name: string }
): RedmineProject {
  return new RedmineProject({
    id,
    name,
    description: `${name} description`,
    identifier: `${name.toLowerCase()}-${id}`,
    parent,
    custom_fields: [{ id: 1, name: "Team", value: "Core" }],
  });
}

const emptyCache = new Map<number, FlexibilityScore | null>();

describe("hierarchy-builder extra coverage", () => {
  it("builds missing-parent containers when flat hierarchy is enabled", async () => {
    const orphanA = issue({
      id: 201,
      parent: { id: 999 },
      spent_hours: 2,
      estimated_hours: 5,
      project: { id: 5, name: "Infra" },
    });
    const orphanB = issue({
      id: 202,
      parent: { id: 999 },
      spent_hours: 3,
      estimated_hours: 8,
      project: { id: 5, name: "Infra" },
    });
    const root = issue({ id: 100, project: { id: 5, name: "Infra" } });

    const result = await buildHierarchy([orphanA, orphanB, root], emptyCache, {
      groupByProject: false,
      includeMissingParentContainers: true,
      fetchMissingParents: async () => [issue({ id: 999, subject: "Missing Parent", project: { id: 5, name: "Infra" } })],
    });

    const container = result.find((node) => node.type === "container");
    expect(container).toBeDefined();
    expect(container?.label).toBe("Missing Parent");
    expect(container?.childCount).toBe(2);
    expect(container?.aggregatedHours).toEqual({ spent: 5, estimated: 13 });
    expect(container?.children.map((c) => c.id).sort((a, b) => a - b)).toEqual([201, 202]);
  });

  it("falls back to orphan root entries when parent fetch fails", async () => {
    const orphan = issue({
      id: 301,
      parent: { id: 777 },
      project: { id: 9, name: "Ops" },
    });

    const result = await buildHierarchy([orphan], emptyCache, {
      groupByProject: false,
      includeMissingParentContainers: true,
      fetchMissingParents: async () => {
        throw new Error("network");
      },
    });

    expect(result.some((node) => node.type === "container")).toBe(false);
    expect(result.some((node) => node.id === 301 && node.parentKey === null)).toBe(true);
  });

  it("builds explicit project hierarchy with metadata + nested projects", () => {
    const rootProject = project(1, "Alpha");
    const childProject = project(2, "Beta", { id: 1, name: "Alpha" });
    const issues = [
      issue({
        id: 1,
        project: { id: 1, name: "Alpha" },
        start_date: "2025-01-01",
        due_date: "2025-01-10",
      }),
      issue({
        id: 2,
        project: { id: 2, name: "Beta" },
        start_date: "2025-01-03",
        due_date: "2025-01-09",
      }),
    ];

    const tree = buildProjectHierarchy(issues, emptyCache, [childProject, rootProject], false, new Set([2]));
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe(1);
    expect(tree[0].description).toBe("Alpha description");
    expect(tree[0].identifier).toBe("alpha-1");
    expect(tree[0].customFields).toEqual([{ id: 1, name: "Team", value: "Core" }]);
    expect(tree[0].health).toBeDefined();
    expect(tree[0].children.some((c) => c.type === "project" && c.id === 2)).toBe(true);
  });

  it("uses fallback project grouping and preserves incoming order when requested", () => {
    const issues = [
      issue({ id: 50, project: { id: 12, name: "Zulu" } }),
      issue({ id: 10, project: { id: 12, name: "Zulu" } }),
      issue({ id: 20, project: { id: 9, name: "Alpha" } }),
    ];

    const tree = buildProjectHierarchy(issues, emptyCache, [], true);
    expect(tree.map((node) => node.label)).toEqual(["Alpha", "Zulu"]);

    const zulu = tree.find((node) => node.label === "Zulu");
    expect(zulu?.children.map((child) => child.id)).toEqual([50, 10]);
  });

  it("builds resource hierarchy with assignee and selected projects", () => {
    const projects = [project(10, "A-Team"), project(20, "B-Team")];
    const issues = [
      issue({ id: 401, project: { id: 10, name: "A-Team" }, assigned_to: { id: 1, name: "Me" } }),
      issue({
        id: 402,
        project: { id: 10, name: "A-Team" },
        assigned_to: { id: 1, name: "Me" },
        parent: { id: 401 },
      }),
      issue({ id: 403, project: { id: 20, name: "B-Team" }, assigned_to: { id: 2, name: "Other" } }),
    ];

    const tree = buildResourceHierarchy(issues, emptyCache, "Me", projects, true);
    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBe("A-Team");
    expect(tree[0].children[0].id).toBe(401);
    expect(tree[0].children[0].children[0].id).toBe(402);
    expect(tree[0].description).toBe("A-Team description");
    expect(tree[0].identifier).toBe("a-team-10");
  });

  it("returns empty resource hierarchy when assignee or projects filter removes all", () => {
    const issues = [issue({ id: 501, assigned_to: { id: 1, name: "Me" }, project: { id: 99, name: "Hidden" } })];
    const projects = [project(10, "Visible")];

    expect(buildResourceHierarchy(issues, emptyCache, "Nobody", projects)).toEqual([]);
    expect(buildResourceHierarchy(issues, emptyCache, "Me", projects)).toEqual([]);
  });

  it("returns flattenHierarchyAll visibility and expansion flags", () => {
    const nodes: HierarchyNode[] = [
      {
        type: "project",
        id: 1,
        label: "P",
        depth: 0,
        collapseKey: "project-1",
        parentKey: null,
        children: [
          {
            type: "issue",
            id: 2,
            label: "I",
            depth: 1,
            collapseKey: "issue-2",
            parentKey: "project-1",
            children: [
              {
                type: "issue",
                id: 3,
                label: "J",
                depth: 2,
                collapseKey: "issue-3",
                parentKey: "issue-2",
                children: [],
              },
            ],
          },
        ],
      },
    ];

    const flat = flattenHierarchyAll(nodes, new Set(["project-1"]));
    expect(flat).toHaveLength(3);
    expect(flat[0].isVisible).toBe(true);
    expect(flat[0].isExpanded).toBe(true);
    expect(flat[1].isVisible).toBe(true);
    expect(flat[1].isExpanded).toBe(false);
    expect(flat[2].isVisible).toBe(false);
  });
});
