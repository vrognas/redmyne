import { describe, it, expect } from "vitest";
import { sortIssuesByRisk, sortIssuesByField } from "../../../src/utilities/issue-sorting";
import { Issue, IssueRelation } from "../../../src/redmine/models/issue";
import { FlexibilityScore } from "../../../src/utilities/flexibility-calculator";

function makeIssue(id: number, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    subject: `Issue ${id}`,
    project: { id: 1, name: "Test" },
    tracker: { id: 1, name: "Bug" },
    status: { id: 1, name: "Open", is_closed: false },
    priority: { id: 2, name: "Normal" },
    author: { id: 1, name: "Author" },
    assigned_to: { id: 1, name: "Assignee" },
    description: "",
    start_date: null,
    due_date: null,
    done_ratio: 0,
    is_private: false,
    estimated_hours: null,
    created_on: "2025-01-01",
    updated_on: "2025-01-01",
    closed_on: null,
    ...overrides,
  };
}

function makeFlex(status: FlexibilityScore["status"], remaining: number): FlexibilityScore {
  return { status, remaining, estimatedHours: 8, daysUntilDue: 5, hoursAvailable: 10 };
}

describe("sortIssuesByRisk", () => {
  it("blocked issues sink to bottom", () => {
    const blockedRelation: IssueRelation = {
      id: 1,
      issue_id: 999,
      issue_to_id: 1,
      relation_type: "blocked",
    };
    const issues = [
      makeIssue(999, { relations: [blockedRelation] }),
      makeIssue(1),
      makeIssue(2),
    ];
    const cache = new Map<number, FlexibilityScore | null>();

    const sorted = sortIssuesByRisk(issues, cache);
    expect(sorted[sorted.length - 1].id).toBe(999);
  });

  it("sorts by status priority (overbooked < at-risk < on-track < completed)", () => {
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4)];
    const cache = new Map<number, FlexibilityScore | null>([
      [1, makeFlex("completed", 0)],
      [2, makeFlex("overbooked", 5)],
      [3, makeFlex("on-track", 2)],
      [4, makeFlex("at-risk", 3)],
    ]);

    const sorted = sortIssuesByRisk(issues, cache);
    expect(sorted.map((i) => i.id)).toEqual([2, 4, 3, 1]);
  });

  it("same status: sorts by remaining hours ascending", () => {
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
    const cache = new Map<number, FlexibilityScore | null>([
      [1, makeFlex("at-risk", 10)],
      [2, makeFlex("at-risk", 5)],
      [3, makeFlex("at-risk", 15)],
    ]);

    const sorted = sortIssuesByRisk(issues, cache);
    expect(sorted.map((i) => i.id)).toEqual([2, 1, 3]);
  });

  it("handles missing flexibility data (sorts by ID descending)", () => {
    const issues = [makeIssue(1), makeIssue(3), makeIssue(2)];
    const cache = new Map<number, FlexibilityScore | null>();

    const sorted = sortIssuesByRisk(issues, cache);
    expect(sorted.map((i) => i.id)).toEqual([3, 2, 1]);
  });

  it("issues without flex data sort after those with data", () => {
    const issues = [makeIssue(1), makeIssue(2)];
    const cache = new Map<number, FlexibilityScore | null>([
      [1, null],
      [2, makeFlex("on-track", 5)],
    ]);

    const sorted = sortIssuesByRisk(issues, cache);
    expect(sorted[0].id).toBe(2);
    expect(sorted[1].id).toBe(1);
  });
});

describe("sortIssuesByField", () => {
  it("sorts by id asc/desc", () => {
    const issues = [makeIssue(3), makeIssue(1), makeIssue(2)];

    const asc = sortIssuesByField(issues, { field: "id", direction: "asc" });
    expect(asc.map((i) => i.id)).toEqual([1, 2, 3]);

    const desc = sortIssuesByField(issues, { field: "id", direction: "desc" });
    expect(desc.map((i) => i.id)).toEqual([3, 2, 1]);
  });

  it("sorts by subject alphabetically", () => {
    const issues = [
      makeIssue(1, { subject: "Charlie" }),
      makeIssue(2, { subject: "Alpha" }),
      makeIssue(3, { subject: "Bravo" }),
    ];

    const asc = sortIssuesByField(issues, { field: "subject", direction: "asc" });
    expect(asc.map((i) => i.subject)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("sorts by assignee (handles nulls)", () => {
    const issues = [
      makeIssue(1, { assigned_to: { id: 1, name: "Zoe" } }),
      makeIssue(2, { assigned_to: undefined as unknown as Issue["assigned_to"] }),
      makeIssue(3, { assigned_to: { id: 2, name: "Alice" } }),
    ];

    const asc = sortIssuesByField(issues, { field: "assignee", direction: "asc" });
    // Empty string sorts first
    expect(asc.map((i) => i.assigned_to?.name || "")).toEqual(["", "Alice", "Zoe"]);
  });
});
