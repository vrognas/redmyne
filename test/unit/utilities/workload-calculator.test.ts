import { describe, it, expect } from "vitest";
import { calculateWorkload } from "../../../src/utilities/workload-calculator";
import { WeeklySchedule } from "../../../src/utilities/flexibility-calculator";
import { Issue } from "../../../src/redmine/models/issue";

// Helper to create test issues
function createIssue(overrides: Partial<Issue>): Issue {
  return {
    id: 1,
    project: { id: 1, name: "Test Project" },
    tracker: { id: 1, name: "Bug" },
    status: { id: 1, name: "Open" },
    priority: { id: 2, name: "Normal" },
    author: { id: 1, name: "Author" },
    assigned_to: { id: 1, name: "Assignee" },
    subject: "Test Issue",
    description: "",
    start_date: "2025-11-01",
    due_date: "2025-11-30",
    done_ratio: 0,
    is_private: false,
    estimated_hours: 10,
    spent_hours: 0,
    created_on: "2025-11-01T00:00:00Z",
    updated_on: "2025-11-01T00:00:00Z",
    closed_on: null,
    ...overrides,
  };
}

const DEFAULT_SCHEDULE: WeeklySchedule = {
  Mon: 8,
  Tue: 8,
  Wed: 8,
  Thu: 8,
  Fri: 8,
  Sat: 0,
  Sun: 0,
};

describe("workload-calculator", () => {
  describe("calculateWorkload", () => {
    it("calculates remaining work correctly", () => {
      const issues = [
        createIssue({ id: 1, estimated_hours: 10, spent_hours: 5 }), // 5h left
        createIssue({ id: 2, estimated_hours: 20, spent_hours: 8 }), // 12h left
        createIssue({ id: 3, estimated_hours: 15, spent_hours: 15 }), // 0h left
      ];

      const result = calculateWorkload(issues, DEFAULT_SCHEDULE);

      expect(result.totalEstimated).toBe(45);
      expect(result.totalSpent).toBe(28);
      expect(result.remaining).toBe(17); // 5 + 12 + 0
    });

    it("does not let an overspent issue cancel another issue's remaining", () => {
      const issues = [
        createIssue({ id: 1, estimated_hours: 10, spent_hours: 0 }), // 10h left
        createIssue({ id: 2, estimated_hours: 5, spent_hours: 20 }), // overspent → 0h, not -15h
      ];

      const result = calculateWorkload(issues, DEFAULT_SCHEDULE);

      // Overspent issue contributes 0, so total == issue 1's genuine remaining
      expect(result.remaining).toBe(10);
    });

    it("calculates buffer correctly", () => {
      // 3 days left in week (Wed, Thu, Fri), 8h/day = 24h available
      // 10h remaining work = +14h buffer
      const issues = [
        createIssue({ estimated_hours: 20, spent_hours: 10 }), // 10h left
      ];

      // Mock today as Wednesday 2025-11-26 (3 working days left: Wed, Thu, Fri)
      const result = calculateWorkload(
        issues,
        DEFAULT_SCHEDULE,
        new Date("2025-11-26") // Wednesday
      );

      // Wed (26th) + Thu (27th) + Fri (28th) = 24h available
      expect(result.availableThisWeek).toBe(24);
      expect(result.remaining).toBe(10);
      expect(result.buffer).toBe(14); // 24 - 10
    });

    it("returns top 3 urgent issues sorted by days remaining", () => {
      const issues = [
        createIssue({
          id: 1,
          subject: "Due far",
          due_date: "2025-12-15",
          estimated_hours: 10,
          spent_hours: 5,
        }),
        createIssue({
          id: 2,
          subject: "Due soon",
          due_date: "2025-11-27",
          estimated_hours: 8,
          spent_hours: 2,
        }),
        createIssue({
          id: 3,
          subject: "Due tomorrow",
          due_date: "2025-11-25",
          estimated_hours: 4,
          spent_hours: 1,
        }),
        createIssue({
          id: 4,
          subject: "Due middle",
          due_date: "2025-11-30",
          estimated_hours: 12,
          spent_hours: 4,
        }),
        createIssue({
          id: 5,
          subject: "No due date",
          due_date: null,
          estimated_hours: 5,
          spent_hours: 0,
        }),
      ];

      const result = calculateWorkload(
        issues,
        DEFAULT_SCHEDULE,
        new Date("2025-11-24") // Monday
      );

      expect(result.topUrgent).toHaveLength(3);
      expect(result.topUrgent[0].id).toBe(3); // Due tomorrow
      expect(result.topUrgent[1].id).toBe(2); // Due soon
      expect(result.topUrgent[2].id).toBe(4); // Due middle
      // id=1 (far) and id=5 (no date) not in top 3
    });

    it("handles empty issues array", () => {
      const result = calculateWorkload([], DEFAULT_SCHEDULE);

      expect(result.totalEstimated).toBe(0);
      expect(result.totalSpent).toBe(0);
      expect(result.remaining).toBe(0);
      expect(result.topUrgent).toHaveLength(0);
    });

    it("handles issues without estimated hours", () => {
      const issues = [
        createIssue({ id: 1, estimated_hours: null, spent_hours: 5 }),
        createIssue({ id: 2, estimated_hours: 10, spent_hours: 3 }),
      ];

      const result = calculateWorkload(issues, DEFAULT_SCHEDULE);

      // Only count issues with estimates
      expect(result.totalEstimated).toBe(10);
      expect(result.totalSpent).toBe(3);
      expect(result.remaining).toBe(7);
    });

    it("excludes closed issues from top urgent", () => {
      const issues = [
        createIssue({
          id: 1,
          subject: "Closed",
          due_date: "2025-11-25",
          estimated_hours: 10,
          spent_hours: 10,
          done_ratio: 100,
        }),
        createIssue({
          id: 2,
          subject: "Open",
          due_date: "2025-11-26",
          estimated_hours: 8,
          spent_hours: 2,
          done_ratio: 25,
        }),
      ];

      const result = calculateWorkload(
        issues,
        DEFAULT_SCHEDULE,
        new Date("2025-11-24")
      );

      // Closed issue (done_ratio=100) should be excluded from urgent
      expect(result.topUrgent).toHaveLength(1);
      expect(result.topUrgent[0].id).toBe(2);
    });
  });
});
