import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  calculateDailyCapacity,
  DailyCapacity,
} from "../../../src/utilities/capacity-calculator";
import type { Issue } from "../../../src/redmine/models/issue";
import { WeeklySchedule, DEFAULT_WEEKLY_SCHEDULE } from "../../../src/utilities/flexibility-calculator";

function createMockIssue(overrides: Partial<Issue> & { id: number }): Issue {
  return {
    id: overrides.id,
    subject: overrides.subject ?? `Issue ${overrides.id}`,
    project: overrides.project ?? { id: 1, name: "Project A" },
    tracker: { id: 1, name: "Task" },
    status: { id: 1, name: "In Progress" },
    priority: { id: 2, name: "Normal" },
    author: { id: 1, name: "Author" },
    assigned_to: overrides.assigned_to ?? { id: 1, name: "Me" },
    description: "",
    done_ratio: 0,
    is_private: false,
    created_on: "2025-01-01T00:00:00Z",
    updated_on: "2025-01-01T00:00:00Z",
    closed_on: null,
    start_date: "start_date" in overrides ? overrides.start_date! : "2025-01-06",
    due_date: "due_date" in overrides ? overrides.due_date! : "2025-01-10",
    estimated_hours: "estimated_hours" in overrides ? overrides.estimated_hours! : 40,
    spent_hours: overrides.spent_hours ?? 0,
    parent: overrides.parent,
  };
}

describe("calculateDailyCapacity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-06")); // Monday
  });

  it("returns capacity entries with zero load for empty issues", () => {
    const result = calculateDailyCapacity(
      [],
      DEFAULT_WEEKLY_SCHEDULE,
      "2025-01-06",
      "2025-01-10"
    );
    // Should still show days with capacity but zero load
    expect(result.length).toBe(5);
    expect(result[0].loadHours).toBe(0);
    expect(result[0].capacityHours).toBe(8);
    expect(result[0].status).toBe("available");
  });

  it("calculates even distribution for single issue", () => {
    // 40h estimated over 5 working days (Mon-Fri) = 8h/day
    const issues = [
      createMockIssue({
        id: 1,
        start_date: "2025-01-06", // Monday
        due_date: "2025-01-10", // Friday
        estimated_hours: 40,
      }),
    ];

    const result = calculateDailyCapacity(
      issues,
      DEFAULT_WEEKLY_SCHEDULE,
      "2025-01-06",
      "2025-01-10"
    );

    expect(result.length).toBe(5); // Mon-Fri
    expect(result[0].date).toBe("2025-01-06");
    expect(result[0].loadHours).toBe(8); // 40h / 5 days
    expect(result[0].capacityHours).toBe(8);
    expect(result[0].percentage).toBe(100);
  });

  it("sums concurrent issues", () => {
    // Two 8h/day issues = 16h/day load
    const issues = [
      createMockIssue({
        id: 1,
        start_date: "2025-01-06",
        due_date: "2025-01-10",
        estimated_hours: 40, // 8h/day
      }),
      createMockIssue({
        id: 2,
        start_date: "2025-01-06",
        due_date: "2025-01-10",
        estimated_hours: 40, // 8h/day
      }),
    ];

    const result = calculateDailyCapacity(
      issues,
      DEFAULT_WEEKLY_SCHEDULE,
      "2025-01-06",
      "2025-01-10"
    );

    expect(result[0].loadHours).toBe(16); // 8 + 8
    expect(result[0].percentage).toBe(200); // 16/8 = 200%
  });

  it("handles partial overlap", () => {
    // Issue 1: Mon-Wed (3 days, 24h = 8h/day)
    // Issue 2: Wed-Fri (3 days, 24h = 8h/day)
    // Wednesday has both = 16h
    const issues = [
      createMockIssue({
        id: 1,
        start_date: "2025-01-06", // Mon
        due_date: "2025-01-08", // Wed
        estimated_hours: 24, // 8h/day
      }),
      createMockIssue({
        id: 2,
        start_date: "2025-01-08", // Wed
        due_date: "2025-01-10", // Fri
        estimated_hours: 24, // 8h/day
      }),
    ];

    const result = calculateDailyCapacity(
      issues,
      DEFAULT_WEEKLY_SCHEDULE,
      "2025-01-06",
      "2025-01-10"
    );

    expect(result[0].loadHours).toBe(8); // Mon: issue 1 only
    expect(result[1].loadHours).toBe(8); // Tue: issue 1 only
    expect(result[2].loadHours).toBe(16); // Wed: both issues
    expect(result[3].loadHours).toBe(8); // Thu: issue 2 only
    expect(result[4].loadHours).toBe(8); // Fri: issue 2 only
  });

  it("skips weekends (zero capacity)", () => {
    // Range includes Sat/Sun - should not appear in results
    const issues = [
      createMockIssue({
        id: 1,
        start_date: "2025-01-10", // Fri
        due_date: "2025-01-13", // Mon
        estimated_hours: 16, // 2 working days = 8h/day
      }),
    ];

    const result = calculateDailyCapacity(
      issues,
      DEFAULT_WEEKLY_SCHEDULE,
      "2025-01-10",
      "2025-01-13"
    );

    // Should only show Fri and Mon, skip Sat/Sun
    expect(result.length).toBe(2);
    expect(result[0].date).toBe("2025-01-10"); // Fri
    expect(result[1].date).toBe("2025-01-13"); // Mon
  });

  it("ignores issues without estimated_hours", () => {
    const issues = [
      createMockIssue({
        id: 1,
        start_date: "2025-01-06",
        due_date: "2025-01-10",
        estimated_hours: null,
      }),
    ];

    const result = calculateDailyCapacity(
      issues,
      DEFAULT_WEEKLY_SCHEDULE,
      "2025-01-06",
      "2025-01-10"
    );

    // Days should exist but have 0 load
    expect(result.length).toBe(5);
    expect(result[0].loadHours).toBe(0);
  });

  it("ignores issues without dates", () => {
    const issues = [
      createMockIssue({
        id: 1,
        start_date: undefined as any,
        due_date: null,
        estimated_hours: 40,
      }),
    ];

    const result = calculateDailyCapacity(
      issues,
      DEFAULT_WEEKLY_SCHEDULE,
      "2025-01-06",
      "2025-01-10"
    );

    expect(result.length).toBe(5);
    expect(result[0].loadHours).toBe(0);
  });

  it("respects custom weekly schedule", () => {
    const halfDaySchedule: WeeklySchedule = {
      Mon: 4,
      Tue: 4,
      Wed: 4,
      Thu: 4,
      Fri: 4,
      Sat: 0,
      Sun: 0,
    };

    const issues = [
      createMockIssue({
        id: 1,
        start_date: "2025-01-06",
        due_date: "2025-01-10",
        estimated_hours: 20, // 4h/day over 5 days
      }),
    ];

    const result = calculateDailyCapacity(
      issues,
      halfDaySchedule,
      "2025-01-06",
      "2025-01-10"
    );

    expect(result[0].loadHours).toBe(4);
    expect(result[0].capacityHours).toBe(4);
    expect(result[0].percentage).toBe(100);
  });

  it("calculates correct status based on percentage", () => {
    // Under capacity (50%)
    const underCapacity = createMockIssue({
      id: 1,
      start_date: "2025-01-06",
      due_date: "2025-01-10",
      estimated_hours: 20, // 4h/day = 50%
    });

    const result1 = calculateDailyCapacity(
      [underCapacity],
      DEFAULT_WEEKLY_SCHEDULE,
      "2025-01-06",
      "2025-01-06"
    );
    expect(result1[0].status).toBe("available"); // < 80%

    // Near capacity (80%)
    const nearCapacity = createMockIssue({
      id: 2,
      start_date: "2025-01-06",
      due_date: "2025-01-10",
      estimated_hours: 32, // 6.4h/day = 80%
    });

    const result2 = calculateDailyCapacity(
      [nearCapacity],
      DEFAULT_WEEKLY_SCHEDULE,
      "2025-01-06",
      "2025-01-06"
    );
    expect(result2[0].status).toBe("busy"); // 80-100%

    // Overloaded (150%)
    const overloaded = createMockIssue({
      id: 3,
      start_date: "2025-01-06",
      due_date: "2025-01-10",
      estimated_hours: 60, // 12h/day = 150%
    });

    const result3 = calculateDailyCapacity(
      [overloaded],
      DEFAULT_WEEKLY_SCHEDULE,
      "2025-01-06",
      "2025-01-06"
    );
    expect(result3[0].status).toBe("overloaded"); // > 100%
  });
});
