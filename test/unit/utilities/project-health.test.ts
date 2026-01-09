import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { calculateProjectHealth } from "../../../src/utilities/project-health";
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
    assigned_to: { id: 1, name: "Assignee" },
    description: "",
    done_ratio: overrides.done_ratio ?? 0,
    is_private: false,
    created_on: "2025-01-01T00:00:00Z",
    updated_on: "2025-01-01T00:00:00Z",
    closed_on: overrides.closed_on ?? null,
    start_date: overrides.start_date ?? "2025-01-01",
    due_date: "due_date" in overrides ? overrides.due_date : "2025-01-31",
    estimated_hours: overrides.estimated_hours ?? null,
    spent_hours: overrides.spent_hours ?? 0,
    parent: overrides.parent,
  };
}

describe("calculateProjectHealth", () => {
  // Mock date: Jan 15, 2025
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("health status", () => {
    it("returns grey when no issues", () => {
      const result = calculateProjectHealth([], new Set());
      expect(result.status).toBe("grey");
      expect(result.reasons).toContain("No issues");
    });

    it("returns green when no problems", () => {
      const issues = [
        createMockIssue({ id: 1, due_date: "2025-01-31", done_ratio: 50 }),
        createMockIssue({ id: 2, due_date: "2025-02-15", done_ratio: 30 }),
      ];
      const result = calculateProjectHealth(issues, new Set());
      expect(result.status).toBe("green");
      expect(result.reasons).toContain("On track");
    });

    it("returns red when any issue is overdue", () => {
      const issues = [
        createMockIssue({ id: 1, due_date: "2025-01-10" }), // overdue
        createMockIssue({ id: 2, due_date: "2025-01-31" }),
      ];
      const result = calculateProjectHealth(issues, new Set());
      expect(result.status).toBe("red");
      expect(result.reasons.some(r => r.includes("overdue"))).toBe(true);
    });

    it("returns red when blocked ratio exceeds 20%", () => {
      const issues = [
        createMockIssue({ id: 1 }),
        createMockIssue({ id: 2 }),
        createMockIssue({ id: 3 }),
        createMockIssue({ id: 4 }),
      ];
      // 2 out of 4 = 50% blocked > 20%
      const blockedIds = new Set([1, 2]);
      const result = calculateProjectHealth(issues, blockedIds);
      expect(result.status).toBe("red");
      expect(result.reasons.some(r => r.includes("blocked"))).toBe(true);
    });

    it("returns yellow when issues are at-risk", () => {
      const issues = [
        // Due in 3 days (within 5 day threshold), only 20% done (< 70%)
        createMockIssue({ id: 1, due_date: "2025-01-18", done_ratio: 20 }),
        createMockIssue({ id: 2, due_date: "2025-02-15", done_ratio: 50 }),
      ];
      const result = calculateProjectHealth(issues, new Set());
      expect(result.status).toBe("yellow");
      expect(result.reasons.some(r => r.includes("at risk"))).toBe(true);
    });

    it("returns yellow when blocked ratio is 10-20%", () => {
      const issues = Array.from({ length: 8 }, (_, i) =>
        createMockIssue({ id: i + 1 })
      );
      // 1 out of 8 = 12.5% blocked (> 10%, < 20%)
      const blockedIds = new Set([1]);
      const result = calculateProjectHealth(issues, blockedIds);
      expect(result.status).toBe("yellow");
    });

    it("ignores closed issues for overdue check", () => {
      const issues = [
        createMockIssue({
          id: 1,
          due_date: "2025-01-10", // would be overdue
          closed_on: "2025-01-09T00:00:00Z", // but closed
        }),
        createMockIssue({ id: 2, due_date: "2025-01-31" }),
      ];
      const result = calculateProjectHealth(issues, new Set());
      expect(result.status).toBe("green");
    });

    it("ignores closed issues for blocked ratio", () => {
      const issues = [
        createMockIssue({ id: 1, closed_on: "2025-01-10T00:00:00Z" }),
        createMockIssue({ id: 2 }),
      ];
      // Issue 1 is "blocked" but closed - shouldn't count
      const blockedIds = new Set([1]);
      const result = calculateProjectHealth(issues, blockedIds);
      expect(result.counts.blocked).toBe(0);
      expect(result.status).toBe("green");
    });
  });

  describe("progress calculation", () => {
    it("calculates weighted progress by estimated hours", () => {
      const issues = [
        createMockIssue({
          id: 1,
          estimated_hours: 10,
          done_ratio: 100,
          closed_on: "2025-01-10T00:00:00Z",
        }),
        createMockIssue({ id: 2, estimated_hours: 10, done_ratio: 0 }),
      ];
      // 10h at 100% + 10h at 0% = 1000 / 20 = 50%
      const result = calculateProjectHealth(issues, new Set());
      expect(result.progress).toBe(50);
    });

    it("uses default 4h weight for issues without estimates", () => {
      const issues = [
        createMockIssue({
          id: 1,
          estimated_hours: null,
          done_ratio: 100,
          closed_on: "2025-01-10T00:00:00Z",
        }),
        createMockIssue({ id: 2, estimated_hours: null, done_ratio: 0 }),
      ];
      // 4h at 100% + 4h at 0% = 400 / 8 = 50%
      const result = calculateProjectHealth(issues, new Set());
      expect(result.progress).toBe(50);
    });

    it("treats closed issues as 100% complete", () => {
      const issues = [
        createMockIssue({
          id: 1,
          estimated_hours: 10,
          done_ratio: 50, // says 50% but closed
          closed_on: "2025-01-10T00:00:00Z",
        }),
      ];
      const result = calculateProjectHealth(issues, new Set());
      expect(result.progress).toBe(100);
    });

    it("returns 0 progress for empty project", () => {
      const result = calculateProjectHealth([], new Set());
      expect(result.progress).toBe(0);
    });
  });

  describe("counts", () => {
    it("counts total, open, closed correctly", () => {
      const issues = [
        createMockIssue({ id: 1, closed_on: "2025-01-10T00:00:00Z" }),
        createMockIssue({ id: 2, closed_on: "2025-01-11T00:00:00Z" }),
        createMockIssue({ id: 3 }), // open
      ];
      const result = calculateProjectHealth(issues, new Set());
      expect(result.counts.total).toBe(3);
      expect(result.counts.closed).toBe(2);
      expect(result.counts.open).toBe(1);
    });

    it("detects in-progress issues by status name", () => {
      const issues = [
        createMockIssue({ id: 1, status: { id: 2, name: "In Progress" } }),
        createMockIssue({ id: 2, status: { id: 3, name: "Doing" } }),
        createMockIssue({ id: 3, status: { id: 1, name: "Open" } }),
      ];
      const result = calculateProjectHealth(issues, new Set());
      expect(result.counts.inProgress).toBe(2);
    });

    it("counts blocked issues (open only)", () => {
      const issues = [
        createMockIssue({ id: 1 }),
        createMockIssue({ id: 2 }),
        createMockIssue({ id: 3, closed_on: "2025-01-10T00:00:00Z" }),
      ];
      const blockedIds = new Set([1, 3]); // 3 is closed, shouldn't count
      const result = calculateProjectHealth(issues, blockedIds);
      expect(result.counts.blocked).toBe(1);
    });

    it("counts overdue issues", () => {
      const issues = [
        createMockIssue({ id: 1, due_date: "2025-01-10" }), // overdue
        createMockIssue({ id: 2, due_date: "2025-01-14" }), // overdue
        createMockIssue({ id: 3, due_date: "2025-01-20" }), // not overdue
        createMockIssue({ id: 4, due_date: null as any }), // no due date
      ];
      const result = calculateProjectHealth(issues, new Set());
      expect(result.counts.overdue).toBe(2);
    });

    it("counts at-risk issues correctly", () => {
      const issues = [
        // Due in 3 days, 20% done -> at risk
        createMockIssue({ id: 1, due_date: "2025-01-18", done_ratio: 20 }),
        // Due in 3 days, 80% done -> not at risk (good progress)
        createMockIssue({ id: 2, due_date: "2025-01-18", done_ratio: 80 }),
        // Due in 10 days, 20% done -> not at risk (enough time)
        createMockIssue({ id: 3, due_date: "2025-01-25", done_ratio: 20 }),
        // Overdue -> not counted as at-risk (it's worse)
        createMockIssue({ id: 4, due_date: "2025-01-10", done_ratio: 20 }),
      ];
      const result = calculateProjectHealth(issues, new Set());
      expect(result.counts.atRisk).toBe(1);
    });
  });

  describe("hours aggregation", () => {
    it("sums estimated and spent hours", () => {
      const issues = [
        createMockIssue({ id: 1, estimated_hours: 10, spent_hours: 5 }),
        createMockIssue({ id: 2, estimated_hours: 20, spent_hours: 15 }),
        createMockIssue({ id: 3, estimated_hours: null, spent_hours: 2 }),
      ];
      const result = calculateProjectHealth(issues, new Set());
      expect(result.hours.estimated).toBe(30);
      expect(result.hours.spent).toBe(22);
    });

    it("handles all null estimates", () => {
      const issues = [
        createMockIssue({ id: 1, estimated_hours: null, spent_hours: 5 }),
      ];
      const result = calculateProjectHealth(issues, new Set());
      expect(result.hours.estimated).toBe(0);
      expect(result.hours.spent).toBe(5);
    });
  });

  describe("reasons array", () => {
    it("shows 'On track' for green status", () => {
      const issues = [createMockIssue({ id: 1, due_date: "2025-01-31" })];
      const result = calculateProjectHealth(issues, new Set());
      expect(result.reasons).toEqual(["On track"]);
    });

    it("includes overdue count in reasons", () => {
      const issues = [
        createMockIssue({ id: 1, due_date: "2025-01-10" }),
        createMockIssue({ id: 2, due_date: "2025-01-12" }),
      ];
      const result = calculateProjectHealth(issues, new Set());
      expect(result.reasons).toContainEqual(expect.stringMatching(/2.*overdue/));
    });

    it("includes blocked percentage in reasons when high", () => {
      const issues = Array.from({ length: 4 }, (_, i) =>
        createMockIssue({ id: i + 1 })
      );
      const blockedIds = new Set([1, 2]); // 50%
      const result = calculateProjectHealth(issues, blockedIds);
      expect(result.reasons).toContainEqual(expect.stringMatching(/blocked.*50%/));
    });

    it("includes at-risk count in reasons", () => {
      const issues = [
        createMockIssue({ id: 1, due_date: "2025-01-18", done_ratio: 20 }),
        createMockIssue({ id: 2, due_date: "2025-01-19", done_ratio: 10 }),
      ];
      const result = calculateProjectHealth(issues, new Set());
      expect(result.reasons).toContainEqual(expect.stringMatching(/2.*at risk/));
    });
  });
});
