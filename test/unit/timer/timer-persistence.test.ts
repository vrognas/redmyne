import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  WorkUnit,
  TimerState,
  PersistedTimerState,
  toPersistedState,
  fromPersistedState,
  createIdleState,
} from "../../../src/timer/timer-state";

function createTestUnit(overrides?: Partial<WorkUnit>): WorkUnit {
  return {
    issueId: 1234,
    issueSubject: "Test Issue",
    activityId: 1,
    activityName: "Development",
    comment: "",
    logged: false,
    secondsLeft: 2700, // 45 min default
    unitPhase: "pending",
    ...overrides,
  };
}

describe("Timer Persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-03-15T10:30:00Z"));
  });

  describe("toPersistedState", () => {
    it("converts runtime state to persisted format", () => {
      const state: TimerState = {
        phase: "working",
        plan: [
          createTestUnit({ unitPhase: "working", secondsLeft: 1800 }),
          createTestUnit({ issueId: 5678, logged: true, unitPhase: "completed" }),
        ],
        currentUnitIndex: 0,
        breakSecondsLeft: 0,
        startedAt: new Date("2025-03-15T10:00:00Z"),
      };

      const persisted = toPersistedState(state);

      expect(persisted.phase).toBe("working");
      expect(persisted.plan).toHaveLength(2);
      expect(persisted.currentUnitIndex).toBe(0);
      expect(persisted.plan[0].secondsLeft).toBe(1800);
      expect(persisted.todayDate).toBe("2025-03-15");
      expect(persisted.lastActiveAt).toBe("2025-03-15T10:00:00.000Z");
    });

    it("uses current time when startedAt is undefined", () => {
      const state: TimerState = {
        phase: "idle",
        plan: [],
        currentUnitIndex: 0,
        breakSecondsLeft: 0,
      };

      const persisted = toPersistedState(state);

      expect(persisted.lastActiveAt).toBe("2025-03-15T10:30:00.000Z");
    });
  });

  describe("fromPersistedState", () => {
    it("converts persisted format to runtime state", () => {
      const persisted: PersistedTimerState = {
        phase: "paused",
        plan: [createTestUnit({ unitPhase: "paused", secondsLeft: 1500 })],
        currentUnitIndex: 0,
        breakSecondsLeft: 0,
        todayDate: "2025-03-15",
        lastActiveAt: "2025-03-15T10:15:00.000Z",
      };

      const state = fromPersistedState(persisted);

      expect(state.phase).toBe("paused");
      expect(state.plan).toHaveLength(1);
      expect(state.currentUnitIndex).toBe(0);
      expect(state.plan[0].secondsLeft).toBe(1500);
      expect(state.startedAt).toEqual(new Date("2025-03-15T10:15:00.000Z"));
    });
  });

  describe("roundtrip", () => {
    it("preserves state through persist/restore cycle", () => {
      const original: TimerState = {
        phase: "break",
        plan: [
          createTestUnit({ logged: true, loggedHours: 1.0, unitPhase: "completed" }),
          createTestUnit({ issueId: 5678, comment: "Meeting notes", unitPhase: "pending" }),
        ],
        currentUnitIndex: 1,
        breakSecondsLeft: 600,
        startedAt: new Date("2025-03-15T10:25:00Z"),
      };

      const persisted = toPersistedState(original);
      const restored = fromPersistedState(persisted);

      expect(restored.phase).toBe(original.phase);
      expect(restored.plan).toEqual(original.plan);
      expect(restored.currentUnitIndex).toBe(original.currentUnitIndex);
      expect(restored.breakSecondsLeft).toBe(original.breakSecondsLeft);
      expect(restored.startedAt).toEqual(original.startedAt);
    });
  });

  describe("date validation", () => {
    it("persisted state includes today date for staleness check", () => {
      const state = createIdleState();
      const persisted = toPersistedState(state);

      expect(persisted.todayDate).toBe("2025-03-15");
    });

    it("date changes when system time changes", () => {
      vi.setSystemTime(new Date("2025-03-16T08:00:00Z"));

      const state = createIdleState();
      const persisted = toPersistedState(state);

      expect(persisted.todayDate).toBe("2025-03-16");
    });
  });
});
