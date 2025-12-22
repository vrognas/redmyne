import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TimerController } from "../../../src/timer/timer-controller";
import { WorkUnit } from "../../../src/timer/timer-state";

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

describe("TimerController", () => {
  let controller: TimerController;

  beforeEach(() => {
    vi.useFakeTimers();
    // Use 10 second work duration for faster tests
    controller = new TimerController(10, 5);
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
  });

  describe("initial state", () => {
    it("starts in idle phase with empty plan", () => {
      expect(controller.getPhase()).toBe("idle");
      expect(controller.getPlan()).toEqual([]);
      expect(controller.getCurrentUnitIndex()).toBe(0);
    });
  });

  describe("setPlan", () => {
    it("sets plan and remains idle", () => {
      const units = [createTestUnit(), createTestUnit({ issueId: 5678 })];
      controller.setPlan(units);

      expect(controller.getPlan()).toHaveLength(2);
      expect(controller.getPhase()).toBe("idle");
    });
  });

  describe("idle -> working transition", () => {
    it("starts timer when plan exists", () => {
      controller.setPlan([createTestUnit({ secondsLeft: 10 })]);
      controller.start();

      expect(controller.getPhase()).toBe("working");
      expect(controller.getSecondsLeft()).toBe(10);
      expect(controller.getPlan()[0].unitPhase).toBe("working");
    });

    it("does nothing when plan is empty", () => {
      controller.start();
      expect(controller.getPhase()).toBe("idle");
    });
  });

  describe("working -> paused transition", () => {
    it("pauses timer", () => {
      controller.setPlan([createTestUnit({ secondsLeft: 10 })]);
      controller.start();
      const secondsBefore = controller.getSecondsLeft();

      controller.pause();
      expect(controller.getPhase()).toBe("paused");
      expect(controller.getPlan()[0].unitPhase).toBe("paused");

      // Time should not advance while paused
      vi.advanceTimersByTime(5000);
      expect(controller.getSecondsLeft()).toBe(secondsBefore);
    });
  });

  describe("paused -> working transition", () => {
    it("resumes timer", () => {
      controller.setPlan([createTestUnit({ secondsLeft: 10 })]);
      controller.start();
      controller.pause();
      controller.resume();

      expect(controller.getPhase()).toBe("working");
      expect(controller.getPlan()[0].unitPhase).toBe("working");
    });
  });

  describe("working -> logging transition", () => {
    it("transitions to logging when timer hits 0", () => {
      controller.setPlan([createTestUnit({ secondsLeft: 3 })]);
      controller.start();

      // Advance time past work duration
      vi.advanceTimersByTime(4000);

      expect(controller.getPhase()).toBe("logging");
    });
  });

  describe("logging -> break transition", () => {
    it("transitions to break after logging", () => {
      controller.setPlan([createTestUnit({ secondsLeft: 2 })]);
      controller.start();

      // Fast-forward to logging phase
      vi.advanceTimersByTime(3000);
      expect(controller.getPhase()).toBe("logging");

      // Mark as logged
      controller.markLogged(1.0);
      expect(controller.getPhase()).toBe("break");
      expect(controller.getPlan()[0].logged).toBe(true);
      expect(controller.getPlan()[0].loggedHours).toBe(1.0);
      expect(controller.getPlan()[0].unitPhase).toBe("completed");
    });

    it("transitions to break after skipping", () => {
      controller.setPlan([createTestUnit({ secondsLeft: 2 })]);
      controller.start();

      vi.advanceTimersByTime(3000);

      controller.skipLogging();
      expect(controller.getPhase()).toBe("break");
      expect(controller.getPlan()[0].logged).toBe(false);
      expect(controller.getPlan()[0].unitPhase).toBe("completed");
    });
  });

  describe("break -> working transition", () => {
    it("starts next unit manually after break", () => {
      controller.setPlan([
        createTestUnit({ secondsLeft: 2 }),
        createTestUnit({ issueId: 5678, secondsLeft: 10 }),
      ]);
      controller.start();

      // Complete first unit
      vi.advanceTimersByTime(3000);
      controller.markLogged(1.0);

      expect(controller.getPhase()).toBe("break");
      expect(controller.getCurrentUnitIndex()).toBe(0);

      // Start next unit
      controller.startNextUnit();
      expect(controller.getPhase()).toBe("working");
      expect(controller.getCurrentUnitIndex()).toBe(1);
      expect(controller.getPlan()[1].unitPhase).toBe("working");
    });
  });

  describe("break -> idle transition", () => {
    it("goes to idle when all units done", () => {
      controller.setPlan([createTestUnit({ secondsLeft: 2 })]);
      controller.start();

      // Complete only unit
      vi.advanceTimersByTime(3000);
      controller.markLogged(1.0);

      expect(controller.getPhase()).toBe("break");

      // Try to start next - should go idle since no more units
      controller.startNextUnit();
      expect(controller.getPhase()).toBe("idle");
    });
  });

  describe("stop (any -> idle, keeps plan)", () => {
    it("stops from working but keeps plan", () => {
      controller.setPlan([createTestUnit({ secondsLeft: 10 })]);
      controller.start();
      controller.stop();

      expect(controller.getPhase()).toBe("idle");
      expect(controller.getPlan()).toHaveLength(1); // Plan preserved
      expect(controller.getPlan()[0].unitPhase).toBe("paused");
    });

    it("stops from paused", () => {
      controller.setPlan([createTestUnit({ secondsLeft: 10 })]);
      controller.start();
      controller.pause();
      controller.stop();

      expect(controller.getPhase()).toBe("idle");
      expect(controller.getPlan()).toHaveLength(1);
    });

    it("stops from break", () => {
      controller.setPlan([
        createTestUnit({ secondsLeft: 2 }),
        createTestUnit({ secondsLeft: 10 }),
      ]);
      controller.start();

      vi.advanceTimersByTime(3000);
      controller.markLogged(1.0);

      controller.stop();
      expect(controller.getPhase()).toBe("idle");
      expect(controller.getPlan()).toHaveLength(2);
    });
  });

  describe("clearPlan", () => {
    it("clears plan completely", () => {
      controller.setPlan([createTestUnit(), createTestUnit()]);
      controller.start();
      controller.clearPlan();

      expect(controller.getPhase()).toBe("idle");
      expect(controller.getPlan()).toEqual([]);
    });
  });

  describe("state change events", () => {
    it("emits event on phase change", () => {
      const listener = vi.fn();
      controller.onStateChange(listener);

      controller.setPlan([createTestUnit()]);
      controller.start();

      expect(listener).toHaveBeenCalled();
    });
  });

  describe("per-unit timer features", () => {
    it("auto-pauses current unit when starting another", () => {
      controller.setPlan([
        createTestUnit({ secondsLeft: 100 }),
        createTestUnit({ issueId: 5678, secondsLeft: 100 }),
      ]);
      controller.start();

      // First unit is working
      expect(controller.getPlan()[0].unitPhase).toBe("working");

      // Advance some time
      vi.advanceTimersByTime(10000);
      expect(controller.getPlan()[0].secondsLeft).toBe(90);

      // Start second unit directly
      controller.startUnit(1);

      // First unit should be paused, second should be working
      expect(controller.getPlan()[0].unitPhase).toBe("paused");
      expect(controller.getPlan()[0].secondsLeft).toBe(90); // Timer preserved
      expect(controller.getPlan()[1].unitPhase).toBe("working");
    });

    it("resets unit timer to full duration", () => {
      controller.setPlan([createTestUnit({ secondsLeft: 100 })]);
      controller.start();

      // Advance some time
      vi.advanceTimersByTime(30000);
      expect(controller.getPlan()[0].secondsLeft).toBe(70);

      // Reset timer
      controller.resetUnit(0);
      expect(controller.getPlan()[0].secondsLeft).toBe(10); // Reset to workDurationSeconds (10)
    });
  });
});
