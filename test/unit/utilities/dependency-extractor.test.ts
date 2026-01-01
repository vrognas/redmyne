import { describe, it, expect } from "vitest";
import {
  extractSchedulingDependencyIds,
  SCHEDULING_RELATION_TYPES,
} from "../../../src/utilities/dependency-extractor";
import type { Issue } from "../../../src/redmine/models/issue";

function createMockIssue(overrides: Partial<Issue> & { id: number }): Issue {
  return {
    id: overrides.id,
    subject: overrides.subject ?? `Issue ${overrides.id}`,
    project: { id: 1, name: "Project A" },
    tracker: { id: 1, name: "Task" },
    status: { id: 1, name: "In Progress" },
    priority: { id: 2, name: "Normal" },
    author: { id: 1, name: "Author" },
    assigned_to: { id: 1, name: "Me" },
    description: "",
    done_ratio: 0,
    is_private: false,
    created_on: "2025-01-01T00:00:00Z",
    updated_on: "2025-01-01T00:00:00Z",
    closed_on: null,
    start_date: "2025-01-15",
    due_date: "2025-01-30",
    estimated_hours: 8,
    relations: overrides.relations,
  };
}

describe("extractSchedulingDependencyIds", () => {
  it("extracts blocks/blocked/precedes/follows relation targets", () => {
    const issues = [
      createMockIssue({
        id: 1,
        relations: [
          { id: 100, issue_id: 1, issue_to_id: 10, relation_type: "blocks" },
          { id: 101, issue_id: 1, issue_to_id: 11, relation_type: "precedes" },
        ],
      }),
      createMockIssue({
        id: 2,
        relations: [
          { id: 102, issue_id: 2, issue_to_id: 12, relation_type: "blocked" },
          { id: 103, issue_id: 2, issue_to_id: 13, relation_type: "follows" },
        ],
      }),
    ];

    const result = extractSchedulingDependencyIds(issues);

    expect(result).toEqual(new Set([10, 11, 12, 13]));
  });

  it("ignores non-scheduling relations (relates, duplicates)", () => {
    const issues = [
      createMockIssue({
        id: 1,
        relations: [
          { id: 100, issue_id: 1, issue_to_id: 10, relation_type: "relates" },
          { id: 101, issue_id: 1, issue_to_id: 11, relation_type: "duplicates" },
          { id: 102, issue_id: 1, issue_to_id: 12, relation_type: "copied_to" },
        ],
      }),
    ];

    const result = extractSchedulingDependencyIds(issues);

    expect(result.size).toBe(0);
  });

  it("excludes IDs already in input set", () => {
    const issues = [
      createMockIssue({
        id: 1,
        relations: [
          { id: 100, issue_id: 1, issue_to_id: 2, relation_type: "blocks" }, // 2 is in set
          { id: 101, issue_id: 1, issue_to_id: 10, relation_type: "blocks" }, // 10 is external
        ],
      }),
      createMockIssue({ id: 2, relations: [] }),
    ];

    const result = extractSchedulingDependencyIds(issues);

    expect(result).toEqual(new Set([10])); // Only external
  });

  it("returns empty set for issues without relations", () => {
    const issues = [
      createMockIssue({ id: 1, relations: undefined }),
      createMockIssue({ id: 2, relations: [] }),
    ];

    const result = extractSchedulingDependencyIds(issues);

    expect(result.size).toBe(0);
  });

  it("deduplicates when multiple issues reference same target", () => {
    const issues = [
      createMockIssue({
        id: 1,
        relations: [
          { id: 100, issue_id: 1, issue_to_id: 10, relation_type: "blocks" },
        ],
      }),
      createMockIssue({
        id: 2,
        relations: [
          { id: 101, issue_id: 2, issue_to_id: 10, relation_type: "precedes" },
        ],
      }),
    ];

    const result = extractSchedulingDependencyIds(issues);

    expect(result).toEqual(new Set([10])); // Deduplicated
  });
});

describe("SCHEDULING_RELATION_TYPES", () => {
  it("includes all scheduling types", () => {
    expect(SCHEDULING_RELATION_TYPES).toContain("blocks");
    expect(SCHEDULING_RELATION_TYPES).toContain("blocked");
    expect(SCHEDULING_RELATION_TYPES).toContain("precedes");
    expect(SCHEDULING_RELATION_TYPES).toContain("follows");
  });
});
