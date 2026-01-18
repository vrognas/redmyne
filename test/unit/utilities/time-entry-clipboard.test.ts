import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  setClipboard,
  getClipboard,
  clearClipboard,
  getWorkingDaysInWeek,
  calculatePasteTargetDates,
  ClipboardEntry,
  TimeEntryClipboard,
} from "../../../src/utilities/time-entry-clipboard";
import { WeeklySchedule } from "../../../src/utilities/flexibility-calculator";
import { MonthlyScheduleOverrides } from "../../../src/utilities/monthly-schedule";

// Mock vscode
vi.mock("vscode", () => ({
  commands: {
    executeCommand: vi.fn(),
  },
}));

describe("time-entry-clipboard", () => {
  const defaultSchedule: WeeklySchedule = {
    Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8, Sat: 0, Sun: 0,
  };

  const entry1: ClipboardEntry = {
    issue_id: 123,
    activity_id: 9,
    hours: "2",
    comments: "Work on feature",
  };

  const entry2: ClipboardEntry = {
    issue_id: 456,
    activity_id: 10,
    hours: "1.5",
    comments: "Review",
  };

  beforeEach(() => {
    clearClipboard();
  });

  describe("clipboard state management", () => {
    it("stores and retrieves entry clipboard", () => {
      const clip: TimeEntryClipboard = {
        kind: "entry",
        entries: [entry1],
        sourceDate: "2025-01-15",
      };
      setClipboard(clip);
      expect(getClipboard()).toEqual(clip);
    });

    it("stores and retrieves day clipboard", () => {
      const clip: TimeEntryClipboard = {
        kind: "day",
        entries: [entry1, entry2],
        sourceDate: "2025-01-15",
      };
      setClipboard(clip);
      expect(getClipboard()).toEqual(clip);
    });

    it("stores and retrieves week clipboard", () => {
      const weekMap = new Map<number, ClipboardEntry[]>();
      weekMap.set(0, [entry1]); // Monday
      weekMap.set(2, [entry2]); // Wednesday

      const clip: TimeEntryClipboard = {
        kind: "week",
        entries: [entry1, entry2],
        weekMap,
        sourceWeekStart: "2025-01-13",
      };
      setClipboard(clip);
      expect(getClipboard()).toEqual(clip);
    });

    it("clearClipboard removes clipboard data", () => {
      setClipboard({ kind: "entry", entries: [entry1], sourceDate: "2025-01-15" });
      expect(getClipboard()).not.toBeNull();
      clearClipboard();
      expect(getClipboard()).toBeNull();
    });
  });

  describe("getWorkingDaysInWeek", () => {
    it("returns working days from default schedule", () => {
      const weekStart = "2025-01-13"; // Monday Jan 13, 2025
      const days = getWorkingDaysInWeek(weekStart, defaultSchedule, {});
      expect(days).toEqual([
        "2025-01-13", // Mon
        "2025-01-14", // Tue
        "2025-01-15", // Wed
        "2025-01-16", // Thu
        "2025-01-17", // Fri
      ]);
    });

    it("respects schedule with no Friday", () => {
      const schedule: WeeklySchedule = {
        Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 0, Sat: 0, Sun: 0,
      };
      const weekStart = "2025-01-13";
      const days = getWorkingDaysInWeek(weekStart, schedule, {});
      expect(days).toEqual([
        "2025-01-13",
        "2025-01-14",
        "2025-01-15",
        "2025-01-16",
      ]);
    });

    it("uses monthly override when available", () => {
      const overrides: MonthlyScheduleOverrides = {
        "2025-01": { Mon: 4, Tue: 4, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 },
      };
      const weekStart = "2025-01-13";
      const days = getWorkingDaysInWeek(weekStart, defaultSchedule, overrides);
      expect(days).toEqual([
        "2025-01-13", // Mon
        "2025-01-14", // Tue
      ]);
    });
  });

  describe("calculatePasteTargetDates", () => {
    it("entry → day: returns single target date", () => {
      const clip: TimeEntryClipboard = {
        kind: "entry",
        entries: [entry1],
        sourceDate: "2025-01-15",
      };
      const dates = calculatePasteTargetDates(
        clip,
        "day",
        "2025-01-20",
        undefined,
        defaultSchedule,
        {}
      );
      expect(dates).toEqual(["2025-01-20"]);
    });

    it("entry → week: returns all working days in target week", () => {
      const clip: TimeEntryClipboard = {
        kind: "entry",
        entries: [entry1],
        sourceDate: "2025-01-15",
      };
      const dates = calculatePasteTargetDates(
        clip,
        "week",
        undefined,
        "2025-01-20", // Mon Jan 20
        defaultSchedule,
        {}
      );
      expect(dates).toEqual([
        "2025-01-20",
        "2025-01-21",
        "2025-01-22",
        "2025-01-23",
        "2025-01-24",
      ]);
    });

    it("day → day: returns single target date", () => {
      const clip: TimeEntryClipboard = {
        kind: "day",
        entries: [entry1, entry2],
        sourceDate: "2025-01-15",
      };
      const dates = calculatePasteTargetDates(
        clip,
        "day",
        "2025-01-20",
        undefined,
        defaultSchedule,
        {}
      );
      expect(dates).toEqual(["2025-01-20"]);
    });

    it("day → week: returns all working days", () => {
      const clip: TimeEntryClipboard = {
        kind: "day",
        entries: [entry1, entry2],
        sourceDate: "2025-01-15",
      };
      const dates = calculatePasteTargetDates(
        clip,
        "week",
        undefined,
        "2025-01-20",
        defaultSchedule,
        {}
      );
      expect(dates).toEqual([
        "2025-01-20",
        "2025-01-21",
        "2025-01-22",
        "2025-01-23",
        "2025-01-24",
      ]);
    });

    it("week → week: returns mapped days (Mon→Mon, etc)", () => {
      const weekMap = new Map<number, ClipboardEntry[]>();
      weekMap.set(0, [entry1]); // Monday
      weekMap.set(2, [entry2]); // Wednesday

      const clip: TimeEntryClipboard = {
        kind: "week",
        entries: [entry1, entry2],
        weekMap,
        sourceWeekStart: "2025-01-13",
      };

      const dates = calculatePasteTargetDates(
        clip,
        "week",
        undefined,
        "2025-01-20",
        defaultSchedule,
        {}
      );
      // Should only return Mon and Wed since those are the source days
      expect(dates).toEqual(["2025-01-20", "2025-01-22"]);
    });

    it("week → day: returns null (disallowed)", () => {
      const weekMap = new Map<number, ClipboardEntry[]>();
      weekMap.set(0, [entry1]);

      const clip: TimeEntryClipboard = {
        kind: "week",
        entries: [entry1],
        weekMap,
        sourceWeekStart: "2025-01-13",
      };

      const dates = calculatePasteTargetDates(
        clip,
        "day",
        "2025-01-20",
        undefined,
        defaultSchedule,
        {}
      );
      expect(dates).toBeNull();
    });
  });
});
