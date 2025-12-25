import { describe, it, expect } from "vitest";
import {
  getMonthKey,
  countAvailableHoursMonthly,
  getHoursForDateMonthly,
  calculateMonthlyTotal,
  formatMonthKeyDisplay,
  getMonthOptions,
  formatScheduleDisplay,
  calculateWeeklyTotal,
  MonthlyScheduleOverrides,
} from "../../../src/utilities/monthly-schedule";
import { WeeklySchedule } from "../../../src/utilities/flexibility-calculator";

describe("monthly-schedule", () => {
  const defaultSchedule: WeeklySchedule = {
    Mon: 8,
    Tue: 8,
    Wed: 8,
    Thu: 8,
    Fri: 8,
    Sat: 0,
    Sun: 0,
  };

  const halfTimeSchedule: WeeklySchedule = {
    Mon: 4,
    Tue: 4,
    Wed: 4,
    Thu: 4,
    Fri: 4,
    Sat: 0,
    Sun: 0,
  };

  describe("getMonthKey", () => {
    it("returns YYYY-MM format", () => {
      const date = new Date(2025, 0, 15); // Jan 15, 2025
      expect(getMonthKey(date)).toBe("2025-01");
    });

    it("pads single digit months", () => {
      const date = new Date(2025, 5, 1); // Jun 1, 2025
      expect(getMonthKey(date)).toBe("2025-06");
    });

    it("handles December correctly", () => {
      const date = new Date(2025, 11, 25); // Dec 25, 2025
      expect(getMonthKey(date)).toBe("2025-12");
    });
  });

  describe("getHoursForDateMonthly", () => {
    it("returns hours for day using correct schedule", () => {
      const overrides: MonthlyScheduleOverrides = {
        "2025-01": halfTimeSchedule,
      };

      // Monday in January (should use half-time)
      const janMon = new Date(2025, 0, 6); // Jan 6, 2025 is Monday
      expect(getHoursForDateMonthly(janMon, overrides, defaultSchedule)).toBe(4);

      // Monday in February (should use default)
      const febMon = new Date(2025, 1, 3); // Feb 3, 2025 is Monday
      expect(getHoursForDateMonthly(febMon, overrides, defaultSchedule)).toBe(8);
    });

    it("returns 0 for weekends", () => {
      const sat = new Date(2025, 0, 4); // Jan 4, 2025 is Saturday
      expect(getHoursForDateMonthly(sat, {}, defaultSchedule)).toBe(0);
    });
  });

  describe("countAvailableHoursMonthly", () => {
    it("counts hours within single month", () => {
      // Mon-Fri in January with default schedule
      const start = new Date(2025, 0, 6); // Mon Jan 6
      const end = new Date(2025, 0, 10); // Fri Jan 10
      expect(countAvailableHoursMonthly(start, end, {}, defaultSchedule)).toBe(
        40
      ); // 5 days * 8h
    });

    it("handles month boundary correctly", () => {
      const overrides: MonthlyScheduleOverrides = {
        "2025-01": halfTimeSchedule, // 4h/day
        "2025-02": defaultSchedule, // 8h/day
      };

      // Jan 30 (Thu) to Feb 3 (Mon) - 3 days in Jan (Thu,Fri,Mon?) + 1 day in Feb
      // Actually: Jan 30=Thu (4h), Jan 31=Fri (4h), Feb 1=Sat (0h), Feb 2=Sun (0h), Feb 3=Mon (8h)
      const start = new Date(2025, 0, 30); // Thu Jan 30
      const end = new Date(2025, 1, 3); // Mon Feb 3
      expect(countAvailableHoursMonthly(start, end, overrides, defaultSchedule)).toBe(
        4 + 4 + 0 + 0 + 8 // Jan30:4h + Jan31:4h + Feb1:0h + Feb2:0h + Feb3:8h
      );
    });
  });

  describe("calculateMonthlyTotal", () => {
    it("calculates total hours for January 2025", () => {
      // January 2025 has 23 weekdays
      const total = calculateMonthlyTotal("2025-01", defaultSchedule);
      expect(total).toBe(23 * 8); // 184 hours
    });

    it("calculates total for half-time schedule", () => {
      const total = calculateMonthlyTotal("2025-01", halfTimeSchedule);
      expect(total).toBe(23 * 4); // 92 hours
    });
  });

  describe("formatMonthKeyDisplay", () => {
    it("formats month for display", () => {
      expect(formatMonthKeyDisplay("2025-01")).toBe("January 2025");
      expect(formatMonthKeyDisplay("2025-12")).toBe("December 2025");
    });
  });

  describe("getMonthOptions", () => {
    it("returns list of month options", () => {
      const options = getMonthOptions();

      // Should have 10 options (3 past + current + 6 future)
      expect(options.length).toBe(10);

      // All should have key and label
      options.forEach((opt) => {
        expect(opt.key).toMatch(/^\d{4}-\d{2}$/);
        expect(opt.label).toBeTruthy();
      });

      // Current month should be marked
      const currentOpt = options.find((o) => o.label.includes("(current)"));
      expect(currentOpt).toBeDefined();
    });
  });

  describe("formatScheduleDisplay", () => {
    it("formats schedule with working days", () => {
      expect(formatScheduleDisplay(defaultSchedule)).toBe(
        "Mon: 8h, Tue: 8h, Wed: 8h, Thu: 8h, Fri: 8h"
      );
    });

    it("handles partial schedules", () => {
      const partial: WeeklySchedule = {
        Mon: 8,
        Tue: 8,
        Wed: 4,
        Thu: 0,
        Fri: 0,
        Sat: 0,
        Sun: 0,
      };
      expect(formatScheduleDisplay(partial)).toBe("Mon: 8h, Tue: 8h, Wed: 4h");
    });

    it("handles empty schedule", () => {
      const empty: WeeklySchedule = {
        Mon: 0,
        Tue: 0,
        Wed: 0,
        Thu: 0,
        Fri: 0,
        Sat: 0,
        Sun: 0,
      };
      expect(formatScheduleDisplay(empty)).toBe("No working days");
    });
  });

  describe("calculateWeeklyTotal", () => {
    it("sums all days", () => {
      expect(calculateWeeklyTotal(defaultSchedule)).toBe(40);
      expect(calculateWeeklyTotal(halfTimeSchedule)).toBe(20);
    });
  });

});
