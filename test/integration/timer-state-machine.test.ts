import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TimerController } from "../../src/timer/timer-controller";
import { createWorkUnit, WorkUnit, TimerState } from "../../src/timer/timer-state";

/**
 * Integration Tests: Timer State Machine
 *
 * Tests complete multi-step timer workflows.
 * Unit tests cover individual transitions; these test realistic user scenarios.
 */
describe("Integration: Timer State Machine", () => {
  const WORK_DURATION = 5;
  const BREAK_DURATION = 2;

  let controller: TimerController;

  beforeEach(() => {
    vi.useFakeTimers();
    controller = new TimerController(WORK_DURATION, BREAK_DURATION);
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
  });

  function createUnit(issueId: number, subject: string): WorkUnit {
    return createWorkUnit(issueId, subject, 9, "Development", WORK_DURATION);
  }

  it("full day workflow: idle → work → log → break → work → skip → break → idle", () => {
    const units = [createUnit(1, "Task 1"), createUnit(2, "Task 2")];
    controller.setPlan(units);

    // Unit 1: work → log
    controller.start();
    vi.advanceTimersByTime(WORK_DURATION * 1000);
    expect(controller.getPhase()).toBe("logging");
    controller.markLogged(0.75);
    expect(controller.getPhase()).toBe("break");

    // Skip break, start unit 2
    controller.startNextUnit();
    expect(controller.getCurrentUnitIndex()).toBe(1);

    // Unit 2: work → skip logging
    vi.advanceTimersByTime(WORK_DURATION * 1000);
    controller.skipLogging();
    expect(controller.getPlan()[1].logged).toBe(false);
    expect(controller.getPlan()[1].unitPhase).toBe("completed");

    // End of day
    controller.skipBreak();
    expect(controller.getPhase()).toBe("idle");

    // Verify final state
    expect(controller.getPlan()[0].logged).toBe(true);
    expect(controller.getPlan()[1].logged).toBe(false);
  });

  it("session recovery: restore interrupted session and continue", () => {
    const previousState: TimerState = {
      phase: "working",
      plan: [
        { ...createUnit(1, "Task 1"), unitPhase: "working", secondsLeft: 100 },
        { ...createUnit(2, "Task 2"), unitPhase: "pending", secondsLeft: WORK_DURATION },
      ],
      currentUnitIndex: 0,
      breakSecondsLeft: 0,
    };

    controller.restoreState(previousState);

    // Interrupted session becomes paused
    expect(controller.getPhase()).toBe("idle");
    expect(controller.getPlan()[0].unitPhase).toBe("paused");
    expect(controller.getPlan()[0].secondsLeft).toBe(100);

    // User resumes
    controller.start();
    expect(controller.getPhase()).toBe("working");

    // Timer continues from where it left off
    vi.advanceTimersByTime(100 * 1000);
    expect(controller.getPhase()).toBe("logging");
  });

  it("log and continue: accumulate hours across multiple mid-session logs", () => {
    controller.setPlan([createUnit(1, "Long task")]);
    controller.start();

    // First log: 0.5h
    vi.advanceTimersByTime(2000);
    controller.logAndContinue(0, 0.5);
    expect(controller.getPlan()[0].loggedHours).toBe(0.5);
    expect(controller.getPlan()[0].secondsLeft).toBe(WORK_DURATION); // Reset

    // Second log: +0.25h
    vi.advanceTimersByTime(2000);
    controller.logAndContinue(0, 0.25);
    expect(controller.getPlan()[0].loggedHours).toBe(0.75);
    expect(controller.getPhase()).toBe("working"); // Still working
  });
});
