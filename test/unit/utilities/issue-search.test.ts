import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "../../../src/redmine/models/issue";
import type { IRedmineServer } from "../../../src/redmine/redmine-server-interface";
import { RedmineProject } from "../../../src/redmine/redmine-project";

function createProject(
  id: number,
  name: string,
  parent?: { id: number; name: string }
): RedmineProject {
  return new RedmineProject({
    id,
    name,
    description: "",
    identifier: `p-${id}`,
    parent,
  });
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  const base: Issue = {
    id: 1,
    project: { id: 10, name: "Project A" },
    tracker: { id: 1, name: "Task" },
    status: { id: 1, name: "Open", is_closed: false },
    priority: { id: 1, name: "Normal" },
    author: { id: 1, name: "Author" },
    assigned_to: { id: 2, name: "Me" },
    subject: "Issue subject",
    description: "",
    start_date: null,
    due_date: null,
    done_ratio: 0,
    is_private: false,
    estimated_hours: null,
    created_on: "2026-01-01T00:00:00Z",
    updated_on: "2026-01-01T00:00:00Z",
    closed_on: null,
  };

  return {
    ...base,
    ...overrides,
    project: { ...base.project, ...(overrides.project ?? {}) },
    tracker: { ...base.tracker, ...(overrides.tracker ?? {}) },
    status: { ...base.status, ...(overrides.status ?? {}) },
    priority: { ...base.priority, ...(overrides.priority ?? {}) },
    author: { ...base.author, ...(overrides.author ?? {}) },
    assigned_to: { ...base.assigned_to, ...(overrides.assigned_to ?? {}) },
  };
}

describe("issue-search", () => {
  // Fresh module per test so the module-level search/Fuse caches don't leak.
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("buildProjectPathMap builds root + nested separators", async () => {
    const { buildProjectPathMap } = await import("../../../src/utilities/issue-search");
    const projects = [
      createProject(1, "Client"),
      createProject(2, "Program", { id: 1, name: "Client" }),
      createProject(3, "Feature", { id: 2, name: "Program" }),
    ];

    const map = buildProjectPathMap(projects);

    expect(map.get(1)).toBe("Client");
    expect(map.get(2)).toBe("Client: Program");
    expect(map.get(3)).toBe("Client: Program / Feature");
  });

  it("buildProjectPathMap reuses cached parent path for sibling branches", async () => {
    const { buildProjectPathMap } = await import("../../../src/utilities/issue-search");
    const projects = [
      createProject(1, "Client"),
      createProject(2, "Platform", { id: 1, name: "Client" }),
      createProject(3, "Billing", { id: 1, name: "Client" }),
    ];

    const map = buildProjectPathMap(projects);

    expect(map.get(2)).toBe("Client: Platform");
    expect(map.get(3)).toBe("Client: Billing");
  });

  it("parseSearchOperators + fuzzyFilterIssues handle operators and token modes", async () => {
    const { parseSearchOperators, fuzzyFilterIssues } = await import(
      "../../../src/utilities/issue-search"
    );
    const issueA = createIssue({
      id: 1,
      subject: "Auth bug fix",
      project: { id: 10, name: "Platform" },
      status: { id: 1, name: "Open", is_closed: false },
    });
    const issueB = createIssue({
      id: 2,
      subject: "Auth legacy cleanup",
      project: { id: 10, name: "Platform" },
      status: { id: 5, name: "Closed", is_closed: true },
    });
    const issueC = createIssue({
      id: 3,
      subject: "Billing integration",
      project: { id: 20, name: "Billing" },
      status: { id: 1, name: "Open", is_closed: false },
    });
    const projectPathMap = new Map<number, string>([
      [10, "ClientA: Platform"],
      [20, "ClientB: Billing"],
    ]);

    expect(parseSearchOperators('project:"ClientA" status:open auth bug')).toEqual({
      textQuery: "auth bug",
      projectFilter: "clienta",
      statusFilter: "open",
    });

    const operatorOnly = fuzzyFilterIssues(
      [issueA, issueB, issueC],
      "project:clienta status:open",
      projectPathMap,
      new Set<number>([1]),
      new Set<number>([1])
    );
    expect(operatorOnly.map((i: Issue) => i.id)).toEqual([1]);

    const multiToken = fuzzyFilterIssues(
      [issueA, issueB, issueC],
      "auth bug",
      projectPathMap,
      new Set<number>([1]),
      new Set<number>([1])
    );
    expect(multiToken.map((i: Issue) => i.id)).toContain(1);
    expect(multiToken.map((i: Issue) => i.id)).not.toContain(3);
  });

  it("searchIssuesWithFuzzy returns exact-match errors and project-sourced results", async () => {
    const { searchIssuesWithFuzzy } = await import("../../../src/utilities/issue-search");
    const localIssue = createIssue({
      id: 101,
      subject: "Auth bug local",
      project: { id: 22, name: "Platform" },
      status: { id: 1, name: "Open", is_closed: false },
    });
    const serverIssue = createIssue({
      id: 102,
      subject: "Auth bug server",
      project: { id: 22, name: "Platform" },
      status: { id: 1, name: "Open", is_closed: false },
    });
    const projectIssue = createIssue({
      id: 103,
      subject: "Auth bug from project query",
      project: { id: 22, name: "Platform" },
      status: { id: 1, name: "Open", is_closed: false },
    });

    const server = {
      options: { address: "https://redmine.local" },
      getIssueById: vi
        .fn()
        .mockRejectedValueOnce(new Error("403 forbidden"))
        .mockRejectedValueOnce(new Error("404 missing")),
      searchIssues: vi.fn(async (query: string) => {
        if (query.toLowerCase().includes("auth") || query.toLowerCase().includes("bug")) {
          return [serverIssue];
        }
        return [];
      }),
      getOpenIssuesForProject: vi.fn().mockResolvedValue({ issues: [projectIssue] }),
    } as unknown as IRedmineServer;

    const noAccess = await searchIssuesWithFuzzy(
      server,
      "#77",
      [],
      new Map<number, string>(),
      new Set<number>()
    );
    expect(noAccess.exactMatchError).toBe("no access");

    const notFound = await searchIssuesWithFuzzy(
      server,
      "#88",
      [],
      new Map<number, string>(),
      new Set<number>()
    );
    expect(notFound.exactMatchError).toBe("not found");

    const mixed = await searchIssuesWithFuzzy(
      server,
      "clienta auth bug",
      [localIssue],
      new Map<number, string>([[22, "ClientA: Platform"]]),
      new Set<number>([101])
    );
    expect(server.searchIssues).toHaveBeenCalledWith("clienta auth bug", 25);
    expect(server.getOpenIssuesForProject).toHaveBeenCalledWith(22, true, 30, false);
    expect(mixed.results.map((i: Issue) => i.id)).toEqual(expect.arrayContaining([101, 102, 103]));
  });

  it("searchIssuesWithFuzzy keeps exact numeric match and ignores non-Error fetch failures", async () => {
    const { searchIssuesWithFuzzy } = await import("../../../src/utilities/issue-search");
    const exactIssue = createIssue({
      id: 321,
      subject: "Exact numeric",
      project: { id: 71, name: "Core" },
    });
    const server = {
      options: { address: "https://redmine.local" },
      getIssueById: vi
        .fn()
        .mockResolvedValueOnce({ issue: exactIssue })
        .mockRejectedValueOnce("string failure"),
      searchIssues: vi.fn().mockResolvedValue([]),
      getOpenIssuesForProject: vi.fn().mockResolvedValue({ issues: [] }),
    } as unknown as IRedmineServer;

    const exact = await searchIssuesWithFuzzy(
      server,
      "321",
      [],
      new Map<number, string>(),
      new Set<number>()
    );
    expect(exact.exactMatch?.id).toBe(321);
    expect(exact.exactMatchError).toBeNull();

    const unknownFailure = await searchIssuesWithFuzzy(
      server,
      "322",
      [],
      new Map<number, string>(),
      new Set<number>()
    );
    expect(unknownFailure.exactMatchError).toBeNull();
  });
});
