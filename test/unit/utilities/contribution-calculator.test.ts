import { describe, it, expect, vi, beforeEach } from "vitest";
import { TimeEntry } from "../../../src/redmine/models/time-entry";

// Mock vscode
vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(),
    })),
  },
}));

// Mock adhoc-tracker
const mockAdHocIssues = new Set<number>();
vi.mock("../../../src/utilities/adhoc-tracker", () => ({
  adHocTracker: {
    isAdHoc: (id: number) => mockAdHocIssues.has(id),
    getAll: () => Array.from(mockAdHocIssues),
  },
}));

describe("ContributionCalculator", () => {
  beforeEach(() => {
    mockAdHocIssues.clear();
  });

  describe("parseTargetIssueId", () => {
    it("extracts issue ID from comment with #1234", async () => {
      const { parseTargetIssueId } = await import("../../../src/utilities/contribution-calculator");
      expect(parseTargetIssueId("work for #1234")).toBe(1234);
    });

    it("extracts first issue ID when multiple present", async () => {
      const { parseTargetIssueId } = await import("../../../src/utilities/contribution-calculator");
      expect(parseTargetIssueId("#1234 and #5678")).toBe(1234);
    });

    it("returns null for comments without #", async () => {
      const { parseTargetIssueId } = await import("../../../src/utilities/contribution-calculator");
      expect(parseTargetIssueId("regular work")).toBeNull();
    });

    it("returns null for empty comments", async () => {
      const { parseTargetIssueId } = await import("../../../src/utilities/contribution-calculator");
      expect(parseTargetIssueId("")).toBeNull();
    });

    it("handles # followed by non-numbers", async () => {
      const { parseTargetIssueId } = await import("../../../src/utilities/contribution-calculator");
      expect(parseTargetIssueId("issue #abc")).toBeNull();
    });
  });

  describe("calculateContributions", () => {
    it("returns empty maps when no ad-hoc issues", async () => {
      const { calculateContributions } = await import("../../../src/utilities/contribution-calculator");
      const entries: TimeEntry[] = [
        { issue_id: 100, hours: "2", comments: "work #200" },
      ];

      const result = calculateContributions(entries);

      expect(result.contributedTo.size).toBe(0);
      expect(result.donatedFrom.size).toBe(0);
    });

    it("calculates contributions from ad-hoc to target issues", async () => {
      mockAdHocIssues.add(100); // Mark issue 100 as ad-hoc

      const { calculateContributions } = await import("../../../src/utilities/contribution-calculator");
      const entries: TimeEntry[] = [
        { issue_id: 100, hours: "2", comments: "work for #200" },
        { issue_id: 100, hours: "3", comments: "more work #200" },
      ];

      const result = calculateContributions(entries);

      expect(result.contributedTo.get(200)).toBe(5); // 2 + 3 hours
      expect(result.donatedFrom.get(100)).toBe(5);
    });

    it("ignores time entries without # in comment", async () => {
      mockAdHocIssues.add(100);

      const { calculateContributions } = await import("../../../src/utilities/contribution-calculator");
      const entries: TimeEntry[] = [
        { issue_id: 100, hours: "2", comments: "admin work" },
      ];

      const result = calculateContributions(entries);

      expect(result.contributedTo.size).toBe(0);
      expect(result.donatedFrom.size).toBe(0);
    });

    it("ignores time entries on non-ad-hoc issues", async () => {
      // Don't mark any issue as ad-hoc

      const { calculateContributions } = await import("../../../src/utilities/contribution-calculator");
      const entries: TimeEntry[] = [
        { issue_id: 100, hours: "2", comments: "work #200" },
      ];

      const result = calculateContributions(entries);

      expect(result.contributedTo.size).toBe(0);
    });

    it("tracks contributions to multiple target issues", async () => {
      mockAdHocIssues.add(100);

      const { calculateContributions } = await import("../../../src/utilities/contribution-calculator");
      const entries: TimeEntry[] = [
        { issue_id: 100, hours: "2", comments: "work #200" },
        { issue_id: 100, hours: "3", comments: "work #300" },
      ];

      const result = calculateContributions(entries);

      expect(result.contributedTo.get(200)).toBe(2);
      expect(result.contributedTo.get(300)).toBe(3);
      expect(result.donatedFrom.get(100)).toBe(5);
    });

    it("tracks donations from multiple ad-hoc issues", async () => {
      mockAdHocIssues.add(100);
      mockAdHocIssues.add(101);

      const { calculateContributions } = await import("../../../src/utilities/contribution-calculator");
      const entries: TimeEntry[] = [
        { issue_id: 100, hours: "2", comments: "work #200" },
        { issue_id: 101, hours: "3", comments: "work #200" },
      ];

      const result = calculateContributions(entries);

      expect(result.contributedTo.get(200)).toBe(5);
      expect(result.donatedFrom.get(100)).toBe(2);
      expect(result.donatedFrom.get(101)).toBe(3);
    });

    it("builds detailed sources for contributedTo", async () => {
      mockAdHocIssues.add(100);
      mockAdHocIssues.add(101);

      const { calculateContributions } = await import("../../../src/utilities/contribution-calculator");
      const entries: TimeEntry[] = [
        { issue_id: 100, hours: "2", comments: "work #200" },
        { issue_id: 101, hours: "3", comments: "work #200" },
      ];

      const result = calculateContributions(entries);

      expect(result.contributionSources.get(200)).toEqual([
        { fromIssueId: 100, hours: 2 },
        { fromIssueId: 101, hours: 3 },
      ]);
    });

    it("builds detailed targets for donatedFrom", async () => {
      mockAdHocIssues.add(100);

      const { calculateContributions } = await import("../../../src/utilities/contribution-calculator");
      const entries: TimeEntry[] = [
        { issue_id: 100, hours: "2", comments: "work #200" },
        { issue_id: 100, hours: "3", comments: "work #300" },
      ];

      const result = calculateContributions(entries);

      expect(result.donationTargets.get(100)).toEqual([
        { toIssueId: 200, hours: 2 },
        { toIssueId: 300, hours: 3 },
      ]);
    });
  });

  describe("getEffectiveSpentHours", () => {
    it("returns spent hours for normal issues without contributions", async () => {
      const { getEffectiveSpentHours, ContributionResult: _ContributionResult } = await import("../../../src/utilities/contribution-calculator");
      const contributions: _ContributionResult = {
        contributedTo: new Map(),
        donatedFrom: new Map(),
        contributionSources: new Map(),
        donationTargets: new Map(),
      };

      expect(getEffectiveSpentHours(100, 10, contributions)).toBe(10);
    });

    it("adds contributed hours for normal issues", async () => {
      const { getEffectiveSpentHours, ContributionResult: _ContributionResult } = await import("../../../src/utilities/contribution-calculator");
      const contributions: _ContributionResult = {
        contributedTo: new Map([[100, 5]]),
        donatedFrom: new Map(),
        contributionSources: new Map(),
        donationTargets: new Map(),
      };

      expect(getEffectiveSpentHours(100, 10, contributions)).toBe(15); // 10 + 5
    });

    it("returns negative for ad-hoc issues (donated hours)", async () => {
      mockAdHocIssues.add(100);

      const { getEffectiveSpentHours, ContributionResult: _ContributionResult } = await import("../../../src/utilities/contribution-calculator");
      const contributions: _ContributionResult = {
        contributedTo: new Map(),
        donatedFrom: new Map([[100, 5]]),
        contributionSources: new Map(),
        donationTargets: new Map(),
      };

      expect(getEffectiveSpentHours(100, 10, contributions)).toBe(-5);
    });
  });
});
