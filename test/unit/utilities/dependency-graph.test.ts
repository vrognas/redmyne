import { describe, it, expect } from "vitest";
import {
  buildDependencyGraph,
  countDownstream,
  getBlockers,
} from "../../../src/utilities/dependency-graph";
import type { Issue } from "../../../src/redmine/models/issue";

function createMockIssue(overrides: Partial<Issue> & { id: number }): Issue {
  return {
    id: overrides.id,
    subject: overrides.subject ?? `Issue ${overrides.id}`,
    project: overrides.project ?? { id: 1, name: "Project A" },
    tracker: { id: 1, name: "Task" },
    status: overrides.status ?? { id: 1, name: "Open" },
    priority: { id: 2, name: "Normal" },
    author: { id: 1, name: "Author" },
    assigned_to: overrides.assigned_to,
    description: "",
    done_ratio: 0,
    is_private: false,
    created_on: "2025-01-01T00:00:00Z",
    updated_on: "2025-01-01T00:00:00Z",
    closed_on: overrides.closed_on ?? null,
    start_date: "2025-01-15",
    due_date: "2025-01-30",
    estimated_hours: null,
    spent_hours: 0,
    relations: overrides.relations ?? [],
  };
}

describe("buildDependencyGraph", () => {
  it("returns empty graph for no issues", () => {
    const graph = buildDependencyGraph([]);
    expect(graph.size).toBe(0);
  });

  it("creates entries for issues without relations", () => {
    const issues = [
      createMockIssue({ id: 1 }),
      createMockIssue({ id: 2 }),
    ];
    const graph = buildDependencyGraph(issues);
    expect(graph.get(1)).toEqual({ upstream: new Set(), downstream: new Set() });
    expect(graph.get(2)).toEqual({ upstream: new Set(), downstream: new Set() });
  });

  it("tracks blocks relation (A blocks B → B downstream of A)", () => {
    const issues = [
      createMockIssue({
        id: 1,
        relations: [{ id: 100, issue_id: 1, issue_to_id: 2, relation_type: "blocks" }],
      }),
      createMockIssue({ id: 2 }),
    ];
    const graph = buildDependencyGraph(issues);
    expect(graph.get(1)!.downstream.has(2)).toBe(true);
    expect(graph.get(2)!.upstream.has(1)).toBe(true);
  });

  it("tracks blocked relation (A blocked by B → A downstream of B)", () => {
    const issues = [
      createMockIssue({
        id: 1,
        relations: [{ id: 100, issue_id: 1, issue_to_id: 2, relation_type: "blocked" }],
      }),
      createMockIssue({ id: 2 }),
    ];
    const graph = buildDependencyGraph(issues);
    expect(graph.get(2)!.downstream.has(1)).toBe(true);
    expect(graph.get(1)!.upstream.has(2)).toBe(true);
  });

  it("tracks precedes relation (A precedes B → B downstream of A)", () => {
    const issues = [
      createMockIssue({
        id: 1,
        relations: [{ id: 100, issue_id: 1, issue_to_id: 2, relation_type: "precedes" }],
      }),
      createMockIssue({ id: 2 }),
    ];
    const graph = buildDependencyGraph(issues);
    expect(graph.get(1)!.downstream.has(2)).toBe(true);
    expect(graph.get(2)!.upstream.has(1)).toBe(true);
  });

  it("tracks follows relation (A follows B → A downstream of B)", () => {
    const issues = [
      createMockIssue({
        id: 1,
        relations: [{ id: 100, issue_id: 1, issue_to_id: 2, relation_type: "follows" }],
      }),
      createMockIssue({ id: 2 }),
    ];
    const graph = buildDependencyGraph(issues);
    expect(graph.get(2)!.downstream.has(1)).toBe(true);
    expect(graph.get(1)!.upstream.has(2)).toBe(true);
  });

  it("ignores non-dependency relations (relates, duplicates)", () => {
    const issues = [
      createMockIssue({
        id: 1,
        relations: [
          { id: 100, issue_id: 1, issue_to_id: 2, relation_type: "relates" },
          { id: 101, issue_id: 1, issue_to_id: 3, relation_type: "duplicates" },
        ],
      }),
      createMockIssue({ id: 2 }),
      createMockIssue({ id: 3 }),
    ];
    const graph = buildDependencyGraph(issues);
    expect(graph.get(1)!.downstream.size).toBe(0);
    expect(graph.get(1)!.upstream.size).toBe(0);
  });

  it("ignores relations where issue_id != current issue (prevents self-blocking)", () => {
    // Redmine returns relations from both perspectives
    // When fetching issue 1 blocked by 2, we get:
    //   {issue_id: 1, issue_to_id: 2, relation_type: "blocked"} - owned by 1
    //   {issue_id: 2, issue_to_id: 1, relation_type: "blocks"} - owned by 2
    // Without the fix, the second relation would create self-reference (1→1)
    const issues = [
      createMockIssue({
        id: 1,
        relations: [
          // Correct: issue 1 blocked by issue 2 (issue_id = 1)
          { id: 100, issue_id: 1, issue_to_id: 2, relation_type: "blocked" },
          // Inverse: same relation from 2's perspective (should be ignored)
          { id: 100, issue_id: 2, issue_to_id: 1, relation_type: "blocks" },
        ],
      }),
      createMockIssue({ id: 2 }),
    ];
    const graph = buildDependencyGraph(issues);

    // Issue 1 should NOT be in its own downstream (no self-blocking)
    expect(graph.get(1)!.downstream.has(1)).toBe(false);
    expect(graph.get(1)!.upstream.has(1)).toBe(false);

    // Correct dependency: 2 blocks 1
    expect(graph.get(2)!.downstream.has(1)).toBe(true);
    expect(graph.get(1)!.upstream.has(2)).toBe(true);
  });
});

describe("countDownstream", () => {
  it("returns 0 for issue with no downstream", () => {
    const issues = [createMockIssue({ id: 1 })];
    const graph = buildDependencyGraph(issues);
    expect(countDownstream(1, graph)).toBe(0);
  });

  it("counts direct downstream issues", () => {
    // 1 blocks 2, 1 blocks 3
    const issues = [
      createMockIssue({
        id: 1,
        relations: [
          { id: 100, issue_id: 1, issue_to_id: 2, relation_type: "blocks" },
          { id: 101, issue_id: 1, issue_to_id: 3, relation_type: "blocks" },
        ],
      }),
      createMockIssue({ id: 2 }),
      createMockIssue({ id: 3 }),
    ];
    const graph = buildDependencyGraph(issues);
    expect(countDownstream(1, graph)).toBe(2);
  });

  it("counts transitive downstream (chain)", () => {
    // 1 → 2 → 3 → 4
    const issues = [
      createMockIssue({
        id: 1,
        relations: [{ id: 100, issue_id: 1, issue_to_id: 2, relation_type: "blocks" }],
      }),
      createMockIssue({
        id: 2,
        relations: [{ id: 101, issue_id: 2, issue_to_id: 3, relation_type: "blocks" }],
      }),
      createMockIssue({
        id: 3,
        relations: [{ id: 102, issue_id: 3, issue_to_id: 4, relation_type: "blocks" }],
      }),
      createMockIssue({ id: 4 }),
    ];
    const graph = buildDependencyGraph(issues);
    expect(countDownstream(1, graph)).toBe(3); // 2, 3, 4
    expect(countDownstream(2, graph)).toBe(2); // 3, 4
    expect(countDownstream(3, graph)).toBe(1); // 4
    expect(countDownstream(4, graph)).toBe(0);
  });

  it("counts transitive downstream (diamond)", () => {
    //     1
    //    / \
    //   2   3
    //    \ /
    //     4
    const issues = [
      createMockIssue({
        id: 1,
        relations: [
          { id: 100, issue_id: 1, issue_to_id: 2, relation_type: "blocks" },
          { id: 101, issue_id: 1, issue_to_id: 3, relation_type: "blocks" },
        ],
      }),
      createMockIssue({
        id: 2,
        relations: [{ id: 102, issue_id: 2, issue_to_id: 4, relation_type: "blocks" }],
      }),
      createMockIssue({
        id: 3,
        relations: [{ id: 103, issue_id: 3, issue_to_id: 4, relation_type: "blocks" }],
      }),
      createMockIssue({ id: 4 }),
    ];
    const graph = buildDependencyGraph(issues);
    expect(countDownstream(1, graph)).toBe(3); // 2, 3, 4 (4 counted once)
    expect(countDownstream(2, graph)).toBe(1); // 4
    expect(countDownstream(3, graph)).toBe(1); // 4
  });

  it("returns 0 for unknown issue", () => {
    const graph = buildDependencyGraph([]);
    expect(countDownstream(999, graph)).toBe(0);
  });
});

describe("getBlockers", () => {
  it("returns empty array for issue with no blockers", () => {
    const issues = [createMockIssue({ id: 1 })];
    const graph = buildDependencyGraph(issues);
    const issueMap = new Map(issues.map(i => [i.id, i]));
    expect(getBlockers(1, graph, issueMap)).toEqual([]);
  });

  it("returns upstream issues as blockers", () => {
    // 2 blocks 1
    const issues = [
      createMockIssue({
        id: 1,
        relations: [{ id: 100, issue_id: 1, issue_to_id: 2, relation_type: "blocked" }],
      }),
      createMockIssue({
        id: 2,
        subject: "Blocker task",
        assigned_to: { id: 5, name: "John Doe" },
      }),
    ];
    const graph = buildDependencyGraph(issues);
    const issueMap = new Map(issues.map(i => [i.id, i]));
    const blockers = getBlockers(1, graph, issueMap);

    expect(blockers.length).toBe(1);
    expect(blockers[0].id).toBe(2);
    expect(blockers[0].subject).toBe("Blocker task");
    expect(blockers[0].assignee).toBe("John Doe");
  });

  it("excludes closed blockers", () => {
    const issues = [
      createMockIssue({
        id: 1,
        relations: [{ id: 100, issue_id: 1, issue_to_id: 2, relation_type: "blocked" }],
      }),
      createMockIssue({
        id: 2,
        closed_on: "2025-01-10T00:00:00Z", // closed
      }),
    ];
    const graph = buildDependencyGraph(issues);
    const issueMap = new Map(issues.map(i => [i.id, i]));
    expect(getBlockers(1, graph, issueMap)).toEqual([]);
  });

  it("returns multiple blockers with details", () => {
    const issues = [
      createMockIssue({
        id: 1,
        relations: [
          { id: 100, issue_id: 1, issue_to_id: 2, relation_type: "blocked" },
          { id: 101, issue_id: 1, issue_to_id: 3, relation_type: "blocked" },
        ],
      }),
      createMockIssue({
        id: 2,
        subject: "Task A",
        assigned_to: { id: 5, name: "Alice" },
      }),
      createMockIssue({
        id: 3,
        subject: "Task B",
        // no assignee
      }),
    ];
    const graph = buildDependencyGraph(issues);
    const issueMap = new Map(issues.map(i => [i.id, i]));
    const blockers = getBlockers(1, graph, issueMap);

    expect(blockers.length).toBe(2);
    expect(blockers.map(b => b.id).sort()).toEqual([2, 3]);
    expect(blockers.find(b => b.id === 2)?.assignee).toBe("Alice");
    expect(blockers.find(b => b.id === 3)?.assignee).toBeNull();
  });
});
