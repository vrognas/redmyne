import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TimerController } from "../../src/timer/timer-controller";
import { createWorkUnit, WorkUnit, TimerState } from "../../src/timer/timer-state";

/**
 * E2E Integration Tests: Timer State Machine
 *
 * Tests complete timer workflows through all state transitions.
 * Uses fast-forwarded time for realistic multi-unit scenarios.
 */
describe("E2E: Timer State Machine", () => {
  // Use short durations for fast tests
  const WORK_DURATION = 5; // 5 seconds
  const BREAK_DURATION = 2; // 2 seconds

  let controller: TimerController;

  beforeEach(() => {
    vi.useFakeTimers();
    controller = new TimerController(WORK_DURATION, BREAK_DURATION);
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
  });

  function createUnit(
    issueId: number,
    subject: string,
    activityId = 9,
    activityName = "Development"
  ): WorkUnit {
    return createWorkUnit(issueId, subject, activityId, activityName, WORK_DURATION);
  }

  describe("Single Unit Workflow", () => {
    it("should complete full lifecycle: idle → start → complete → log → break → idle", async () => {
      const events: string[] = [];
      controller.onStateChange(() => events.push(controller.getPhase()));
      controller.onTimerComplete(() => events.push("timer-complete"));

      // Setup
      const unit = createUnit(123, "Task 123");
      controller.setPlan([unit]);
      expect(controller.getPhase()).toBe("idle");
      expect(controller.getPlan()).toHaveLength(1);

      // Start
      controller.start();
      expect(controller.getPhase()).toBe("working");
      expect(controller.getCurrentUnit()?.unitPhase).toBe("working");

      // Fast-forward to timer completion
      vi.advanceTimersByTime(WORK_DURATION * 1000);

      // Should be in logging phase
      expect(controller.getPhase()).toBe("logging");
      expect(events).toContain("timer-complete");

      // Mark logged
      controller.markLogged(0.75);
      expect(controller.getPhase()).toBe("break");
      expect(controller.getCurrentUnit()?.logged).toBe(true);
      expect(controller.getCurrentUnit()?.loggedHours).toBe(0.75);
      expect(controller.getCurrentUnit()?.unitPhase).toBe("completed");

      // Fast-forward break
      vi.advanceTimersByTime(BREAK_DURATION * 1000);

      // Break done, no more units - should stay in break until user acts
      expect(controller.getPhase()).toBe("break");

      // Skip break (would start next, but no next unit)
      controller.skipBreak();
      expect(controller.getPhase()).toBe("idle");
    });

    it("should handle pause/resume cycle", () => {
      const unit = createUnit(456, "Task 456");
      controller.setPlan([unit]);

      controller.start();
      expect(controller.getPhase()).toBe("working");
      const initialSeconds = controller.getSecondsLeft();

      // Advance 2 seconds
      vi.advanceTimersByTime(2000);
      expect(controller.getSecondsLeft()).toBe(initialSeconds - 2);

      // Pause
      controller.pause();
      expect(controller.getPhase()).toBe("paused");
      expect(controller.getCurrentUnit()?.unitPhase).toBe("paused");

      // Advance time while paused - should not change
      vi.advanceTimersByTime(10000);
      const pausedSeconds = controller.getSecondsLeft();

      // Resume
      controller.resume();
      expect(controller.getPhase()).toBe("working");
      expect(controller.getSecondsLeft()).toBe(pausedSeconds); // Unchanged
      expect(controller.getCurrentUnit()?.unitPhase).toBe("working");
    });

    it("should handle stop command", () => {
      const unit = createUnit(789, "Task 789");
      controller.setPlan([unit]);

      controller.start();
      vi.advanceTimersByTime(2000);

      controller.stop();
      expect(controller.getPhase()).toBe("idle");
      expect(controller.getCurrentUnit()?.unitPhase).toBe("paused");

      // Can restart
      controller.start();
      expect(controller.getPhase()).toBe("working");
    });
  });

  describe("Multi-Unit Workflow", () => {
    it("should cycle through multiple units: work → log → break → work → log", () => {
      const units = [
        createUnit(1, "Task 1"),
        createUnit(2, "Task 2"),
        createUnit(3, "Task 3"),
      ];
      controller.setPlan(units);

      // === Unit 1 ===
      controller.start();
      expect(controller.getCurrentUnitIndex()).toBe(0);

      vi.advanceTimersByTime(WORK_DURATION * 1000);
      expect(controller.getPhase()).toBe("logging");

      controller.markLogged(0.75);
      expect(controller.getPhase()).toBe("break");

      // Start next unit (skip break)
      controller.startNextUnit();
      expect(controller.getPhase()).toBe("working");
      expect(controller.getCurrentUnitIndex()).toBe(1);

      // === Unit 2 ===
      vi.advanceTimersByTime(WORK_DURATION * 1000);
      expect(controller.getPhase()).toBe("logging");

      controller.skipLogging(); // Don't log this one
      expect(controller.getPhase()).toBe("break");
      expect(controller.getPlan()[1].logged).toBe(false);
      expect(controller.getPlan()[1].unitPhase).toBe("completed");

      controller.startNextUnit();
      expect(controller.getCurrentUnitIndex()).toBe(2);

      // === Unit 3 ===
      vi.advanceTimersByTime(WORK_DURATION * 1000);
      controller.markLogged(0.75);

      // After last unit's break
      controller.skipBreak();
      expect(controller.getPhase()).toBe("idle");

      // Verify final state
      const plan = controller.getPlan();
      expect(plan[0].unitPhase).toBe("completed");
      expect(plan[0].logged).toBe(true);
      expect(plan[1].unitPhase).toBe("completed");
      expect(plan[1].logged).toBe(false);
      expect(plan[2].unitPhase).toBe("completed");
      expect(plan[2].logged).toBe(true);
    });

    it("should allow starting any unit directly", () => {
      const units = [
        createUnit(1, "Task 1"),
        createUnit(2, "Task 2"),
        createUnit(3, "Task 3"),
      ];
      controller.setPlan(units);

      // Start unit 2 directly
      controller.startUnit(1);
      expect(controller.getCurrentUnitIndex()).toBe(1);
      expect(controller.getPhase()).toBe("working");
      expect(controller.getPlan()[1].unitPhase).toBe("working");

      // Switch to unit 0 (pauses unit 1)
      controller.startUnit(0);
      expect(controller.getCurrentUnitIndex()).toBe(0);
      expect(controller.getPlan()[0].unitPhase).toBe("working");
      expect(controller.getPlan()[1].unitPhase).toBe("paused");
    });

    it("should handle unit removal", () => {
      const units = [
        createUnit(1, "Task 1"),
        createUnit(2, "Task 2"),
        createUnit(3, "Task 3"),
      ];
      controller.setPlan(units);

      // Remove middle unit
      controller.removeUnit(1);
      expect(controller.getPlan()).toHaveLength(2);
      expect(controller.getPlan()[1].issueId).toBe(3);

      // Remove while paused
      controller.start();
      controller.pause();
      controller.removeUnit(0); // Remove paused unit
      expect(controller.getPhase()).toBe("idle"); // Transitions to idle
    });

    it("should handle unit reordering", () => {
      const units = [
        createUnit(1, "Task 1"),
        createUnit(2, "Task 2"),
        createUnit(3, "Task 3"),
      ];
      controller.setPlan(units);

      controller.start();
      expect(controller.getCurrentUnitIndex()).toBe(0);

      // Move current unit to end
      controller.moveUnit(0, 2);
      expect(controller.getCurrentUnitIndex()).toBe(2);
      expect(controller.getPlan()[2].issueId).toBe(1);
      expect(controller.getPlan()[0].issueId).toBe(2);
    });
  });

  describe("State Persistence & Recovery", () => {
    it("should restore state and handle interrupted session", () => {
      const units = [
        createUnit(1, "Task 1"),
        createUnit(2, "Task 2"),
      ];

      // Simulate previous session: unit 1 was working with 100 seconds left
      const previousState: TimerState = {
        phase: "working",
        plan: [
          { ...units[0], unitPhase: "working", secondsLeft: 100 },
          { ...units[1], unitPhase: "pending", secondsLeft: WORK_DURATION },
        ],
        currentUnitIndex: 0,
        breakSecondsLeft: 0,
      };

      controller.restoreState(previousState);

      // After restore, phase is idle but unit is paused (interrupted)
      expect(controller.getPhase()).toBe("idle");
      expect(controller.getPlan()[0].unitPhase).toBe("paused");
      expect(controller.getPlan()[0].secondsLeft).toBe(100);

      // User can resume
      controller.start();
      expect(controller.getPhase()).toBe("working");
    });

    it("should preserve logging phase on restore", () => {
      const units = [createUnit(1, "Task 1")];

      // Simulate: timer ran out but user hadn't logged yet
      const previousState: TimerState = {
        phase: "logging",
        plan: [{ ...units[0], unitPhase: "working", secondsLeft: 0 }],
        currentUnitIndex: 0,
        breakSecondsLeft: 0,
      };

      controller.restoreState(previousState);

      // Logging phase preserved - user needs to complete action
      expect(controller.getPhase()).toBe("logging");
    });
  });

  describe("Toggle Behavior", () => {
    it("should toggle through states correctly", () => {
      const unit = createUnit(1, "Task 1");
      controller.setPlan([unit]);

      // idle → working
      controller.toggle();
      expect(controller.getPhase()).toBe("working");

      // working → paused
      controller.toggle();
      expect(controller.getPhase()).toBe("paused");

      // paused → working
      controller.toggle();
      expect(controller.getPhase()).toBe("working");

      // Complete timer
      vi.advanceTimersByTime(WORK_DURATION * 1000);
      expect(controller.getPhase()).toBe("logging");

      // logging - toggle does nothing (requires explicit action)
      controller.toggle();
      expect(controller.getPhase()).toBe("logging");

      // Mark logged → break
      controller.markLogged(0.5);
      expect(controller.getPhase()).toBe("break");

      // break → starts next (goes to idle if no next)
      controller.toggle();
      expect(controller.getPhase()).toBe("idle");
    });
  });

  describe("Early Logging (Log Now)", () => {
    it("should allow logging unit before timer expires", () => {
      const units = [createUnit(1, "Task 1"), createUnit(2, "Task 2")];
      controller.setPlan(units);

      controller.start();
      vi.advanceTimersByTime(2000);

      // Log now (before timer runs out)
      controller.markUnitLogged(0, 0.25, 999);

      expect(controller.getPlan()[0].unitPhase).toBe("completed");
      expect(controller.getPlan()[0].logged).toBe(true);
      expect(controller.getPlan()[0].loggedHours).toBe(0.25);
      expect(controller.getPlan()[0].timeEntryId).toBe(999);
      expect(controller.getPhase()).toBe("idle");
    });

    it("should support log and continue for mid-session logging", () => {
      const unit = createUnit(1, "Long task");
      controller.setPlan([unit]);

      controller.start();
      vi.advanceTimersByTime(2000);

      // Log partial time and continue
      controller.logAndContinue(0, 0.5);

      expect(controller.getPlan()[0].logged).toBe(true);
      expect(controller.getPlan()[0].loggedHours).toBe(0.5);
      expect(controller.getPlan()[0].unitPhase).toBe("working");
      expect(controller.getPlan()[0].secondsLeft).toBe(WORK_DURATION); // Reset
      expect(controller.getPhase()).toBe("working");

      // Can accumulate more logged time
      vi.advanceTimersByTime(2000);
      controller.logAndContinue(0, 0.25);
      expect(controller.getPlan()[0].loggedHours).toBe(0.75);
    });
  });
});
