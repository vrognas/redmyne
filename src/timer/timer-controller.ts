import * as vscode from "vscode";
import {
  WorkUnit,
  TimerPhase,
  TimerState,
  createIdleState,
  getWorkingUnit,
  getWorkingUnitIndex,
} from "./timer-state";

/**
 * Timer state machine controller (per-unit timers)
 *
 * Each WorkUnit has its own secondsLeft and unitPhase.
 * Global phase tracks break/logging states only.
 *
 * State transitions:
 *   idle → working     (start)
 *   working → paused   (pause)
 *   working → logging  (unit timer hits 0)
 *   paused → working   (resume)
 *   logging → break    (markLogged/skipLogging)
 *   break → working    (startNextUnit - manual)
 *   break → idle       (all units done)
 *   any → idle         (stop)
 */
export class TimerController {
  private state: TimerState = createIdleState();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  private readonly _onStateChange = new vscode.EventEmitter<TimerState>();
  readonly onStateChange = this._onStateChange.event;

  private readonly _onTimerComplete = new vscode.EventEmitter<WorkUnit>();
  readonly onTimerComplete = this._onTimerComplete.event;

  constructor(
    private readonly workDurationSeconds: number = 45 * 60,
    private readonly breakDurationSeconds: number = 15 * 60
  ) {}

  dispose(): void {
    this.disposed = true;
    this.stopInterval();
    this._onStateChange.dispose();
    this._onTimerComplete.dispose();
  }

  // --- Getters ---

  getPhase(): TimerPhase {
    return this.state.phase;
  }

  getPlan(): WorkUnit[] {
    // Return a shallow copy to prevent external mutation
    return [...this.state.plan];
  }

  getCurrentUnitIndex(): number {
    return this.state.currentUnitIndex;
  }

  getCurrentUnit(): WorkUnit | undefined {
    return this.state.plan[this.state.currentUnitIndex];
  }

  /**
   * Get seconds left for the currently active unit (working or paused), or break time
   */
  getSecondsLeft(): number {
    if (this.state.phase === "break") {
      return this.state.breakSecondsLeft;
    }
    // For working phase, get the working unit
    if (this.state.phase === "working") {
      const workingUnit = getWorkingUnit(this.state);
      return workingUnit?.secondsLeft ?? 0;
    }
    // For paused phase, get the current unit (which should be paused)
    const currentUnit = this.getCurrentUnit();
    return currentUnit?.secondsLeft ?? 0;
  }

  getState(): TimerState {
    return { ...this.state };
  }

  /**
   * Get the currently working unit (if any)
   */
  getWorkingUnit(): WorkUnit | undefined {
    return getWorkingUnit(this.state);
  }

  // --- Commands ---

  setPlan(units: WorkUnit[]): void {
    this.state.plan = [...units];
    this.state.currentUnitIndex = 0;
    this.emitChange();
  }

  /**
   * Restore full state (for session recovery)
   * Units already have their secondsLeft and unitPhase from persistence
   */
  restoreState(state: TimerState): void {
    // Stop any existing interval before restoring state
    this.stopInterval();

    // Deep clone all units to avoid reference leaks
    this.state = {
      ...state,
      plan: state.plan.map(u => ({ ...u })),
    };

    // Handle special phases
    if (state.phase === "logging") {
      // Keep logging phase - user needs to complete the log action
      this.state.phase = "logging";
    } else {
      // Restore to idle, user chooses to resume
      this.state.phase = "idle";
      // Pause any working units (they were interrupted)
      this.state.plan = this.state.plan.map(u =>
        u.unitPhase === "working" ? { ...u, unitPhase: "paused" as const } : u
      );
    }
    this.emitChange();
  }

  /**
   * Start or resume the current unit
   */
  start(): void {
    if (this.state.plan.length === 0) return;
    if (this.state.phase !== "idle") return;

    const unit = this.getCurrentUnit();
    if (!unit) return;

    // Start the current unit
    this.setUnitPhase(this.state.currentUnitIndex, "working");
    this.state.phase = "working";
    this.state.startedAt = new Date();
    this.startInterval();
    this.emitChange();
  }

  pause(): void {
    if (this.state.phase !== "working") return;

    // Pause the currently working unit
    const workingIdx = getWorkingUnitIndex(this.state);
    if (workingIdx >= 0) {
      this.setUnitPhase(workingIdx, "paused");
    }

    this.state.phase = "paused";
    this.stopInterval();
    this.emitChange();
  }

  resume(): void {
    if (this.state.phase !== "paused") return;

    // Find the paused unit (may not be at currentUnitIndex if user switched)
    const pausedIdx = this.state.plan.findIndex(u => u.unitPhase === "paused");
    if (pausedIdx >= 0) {
      this.state.currentUnitIndex = pausedIdx;
      this.setUnitPhase(pausedIdx, "working");
    } else {
      // No paused unit found - resume current unit
      this.setUnitPhase(this.state.currentUnitIndex, "working");
    }

    this.state.phase = "working";
    this.startInterval();
    this.emitChange();
  }

  stop(): void {
    this.stopInterval();
    // Pause any working unit
    const workingIdx = getWorkingUnitIndex(this.state);
    if (workingIdx >= 0) {
      this.setUnitPhase(workingIdx, "paused");
    }
    this.state.phase = "idle";
    this.emitChange();
  }

  clearPlan(): void {
    this.stopInterval();
    this.state = createIdleState();
    this.emitChange();
  }

  markLogged(hours: number, timeEntryId?: number): void {
    if (this.state.phase !== "logging") return;

    const index = this.state.currentUnitIndex;
    const unit = this.state.plan[index];
    if (unit) {
      // Create new object to avoid mutation of shared references
      this.state.plan[index] = {
        ...unit,
        logged: true,
        loggedHours: hours,
        unitPhase: "completed",
        completedAt: new Date().toISOString(),
        timeEntryId,
      };
    }

    this.transitionToBreak();
  }

  skipLogging(): void {
    if (this.state.phase !== "logging") return;
    // Mark as completed even if not logged
    const index = this.state.currentUnitIndex;
    const unit = this.state.plan[index];
    if (unit) {
      this.state.plan[index] = {
        ...unit,
        unitPhase: "completed",
        completedAt: new Date().toISOString(),
      };
    }
    this.transitionToBreak();
  }

  /**
   * Defer logging to the next unit (carry time forward)
   * Used when user doesn't want to log the current unit's time now
   */
  deferToNext(unitDurationMinutes: number): void {
    if (this.state.phase !== "logging") return;

    const currentIndex = this.state.currentUnitIndex;
    const currentUnit = this.state.plan[currentIndex];
    if (!currentUnit) return;

    // Calculate total time to defer (unit duration + any already deferred)
    const currentDeferred = currentUnit.deferredMinutes ?? 0;
    const totalDeferred = currentDeferred + unitDurationMinutes;

    // Mark current unit as completed (skipped)
    this.state.plan[currentIndex] = {
      ...currentUnit,
      unitPhase: "completed",
      completedAt: new Date().toISOString(),
    };

    // Find next pending or paused unit and add deferred time
    const nextIndex = this.state.plan.findIndex(
      (u, i) => i > currentIndex && (u.unitPhase === "pending" || u.unitPhase === "paused")
    );

    if (nextIndex >= 0) {
      const nextUnit = this.state.plan[nextIndex];
      this.state.plan[nextIndex] = {
        ...nextUnit,
        deferredMinutes: (nextUnit.deferredMinutes ?? 0) + totalDeferred,
      };
    }
    // If no next unit (all completed), deferred time is lost (end of day)

    this.transitionToBreak();
  }

  /**
   * Mark a specific unit as logged (for early logging before timer runs out)
   */
  markUnitLogged(index: number, hours: number, timeEntryId?: number): void {
    const unit = this.state.plan[index];
    if (!unit || unit.unitPhase === "completed") return;

    // Update the unit
    this.state.plan[index] = {
      ...unit,
      logged: true,
      loggedHours: hours,
      unitPhase: "completed",
      completedAt: new Date().toISOString(),
      timeEntryId,
    };

    // If this was the current working unit, go to idle
    if (unit.unitPhase === "working") {
      this.stopInterval();
      this.state.phase = "idle";
    }

    this.emitChange();
  }

  /**
   * Log time for a unit and continue working (timer resets)
   * Used for mid-unit logging of personal task subtasks
   */
  logAndContinue(index: number, hours: number): void {
    const unit = this.state.plan[index];
    if (!unit || unit.unitPhase !== "working") return;

    // Accumulate logged hours
    const existingHours = unit.loggedHours ?? 0;
    this.state.plan[index] = {
      ...unit,
      logged: true,
      loggedHours: existingHours + hours,
      // Reset timer to full duration
      secondsLeft: this.workDurationSeconds,
      // Keep working phase
      unitPhase: "working",
    };

    this.emitChange();
  }

  startNextUnit(): void {
    if (this.state.phase !== "break") return;

    const nextIndex = this.state.currentUnitIndex + 1;
    if (nextIndex >= this.state.plan.length) {
      // All units done
      this.state.phase = "idle";
      this.emitChange();
      return;
    }

    this.state.currentUnitIndex = nextIndex;
    this.setUnitPhase(nextIndex, "working");
    this.state.phase = "working";
    this.state.startedAt = new Date();
    this.startInterval();
    this.emitChange();
  }

  skipBreak(): void {
    if (this.state.phase !== "break") return;
    this.startNextUnit();
  }

  removeUnit(index: number): void {
    if (index < 0 || index >= this.state.plan.length) return;
    // Don't remove current unit while working
    if (index === this.state.currentUnitIndex && this.state.phase === "working") return;

    // Check if we're removing the paused unit
    const removedUnit = this.state.plan[index];
    const removingPausedUnit = removedUnit?.unitPhase === "paused";

    this.state.plan = this.state.plan.filter((_, i) => i !== index);

    // Handle empty plan
    if (this.state.plan.length === 0) {
      this.stopInterval();
      this.state.phase = "idle";
      this.state.currentUnitIndex = 0;
      this.emitChange();
      return;
    }

    // If we removed the paused unit while in paused phase, go to idle
    if (removingPausedUnit && this.state.phase === "paused") {
      this.state.phase = "idle";
    }

    // Adjust currentUnitIndex if needed
    if (index < this.state.currentUnitIndex) {
      this.state.currentUnitIndex = Math.max(0, this.state.currentUnitIndex - 1);
    } else if (index === this.state.currentUnitIndex) {
      this.state.currentUnitIndex = Math.min(this.state.currentUnitIndex, this.state.plan.length - 1);
    }
    this.emitChange();
  }

  updateUnit(index: number, unit: WorkUnit): void {
    if (index < 0 || index >= this.state.plan.length) return;
    this.state.plan[index] = { ...unit };
    this.emitChange();
  }

  /**
   * Start a specific unit, auto-pausing any currently working unit
   */
  startUnit(index: number): void {
    if (index < 0 || index >= this.state.plan.length) return;
    if (this.state.phase === "logging") return;

    // Auto-pause any currently working unit
    const workingIdx = getWorkingUnitIndex(this.state);
    if (workingIdx >= 0 && workingIdx !== index) {
      this.setUnitPhase(workingIdx, "paused");
    }

    this.stopInterval();
    this.state.currentUnitIndex = index;
    this.setUnitPhase(index, "working");
    this.state.phase = "working";
    this.state.startedAt = new Date();
    this.startInterval();
    this.emitChange();
  }

  /**
   * Reset a unit's timer to full duration
   */
  resetUnit(index: number): void {
    if (index < 0 || index >= this.state.plan.length) return;

    const unit = this.state.plan[index];
    if (!unit) return;

    // Can't reset a completed unit
    if (unit.unitPhase === "completed") return;

    // If resetting a paused unit while in paused phase, go to idle
    const resettingPausedUnit = unit.unitPhase === "paused";

    this.state.plan[index] = {
      ...unit,
      secondsLeft: this.workDurationSeconds,
      unitPhase: unit.unitPhase === "working" ? "working" : "pending",
    };

    if (resettingPausedUnit && this.state.phase === "paused") {
      this.state.phase = "idle";
    }

    this.emitChange();
  }

  moveUnit(fromIndex: number, toIndex: number): void {
    if (fromIndex < 0 || fromIndex >= this.state.plan.length) return;
    if (toIndex < 0 || toIndex >= this.state.plan.length) return;
    if (fromIndex === toIndex) return;

    const plan = [...this.state.plan];
    const [unit] = plan.splice(fromIndex, 1);
    plan.splice(toIndex, 0, unit);
    this.state.plan = plan;

    // Adjust currentUnitIndex if it was affected
    if (this.state.currentUnitIndex === fromIndex) {
      this.state.currentUnitIndex = toIndex;
    } else if (fromIndex < this.state.currentUnitIndex && toIndex >= this.state.currentUnitIndex) {
      this.state.currentUnitIndex--;
    } else if (fromIndex > this.state.currentUnitIndex && toIndex <= this.state.currentUnitIndex) {
      this.state.currentUnitIndex++;
    }

    this.emitChange();
  }

  // --- Timer Toggle (convenience) ---

  toggle(): void {
    switch (this.state.phase) {
      case "idle":
        this.start();
        break;
      case "working":
        this.pause();
        break;
      case "paused":
        this.resume();
        break;
      case "break":
        this.startNextUnit();
        break;
      // logging phase requires explicit action
    }
  }

  // --- Private ---

  /**
   * Set a unit's phase (helper to avoid mutation issues)
   */
  private setUnitPhase(index: number, phase: "pending" | "working" | "paused" | "completed"): void {
    const unit = this.state.plan[index];
    if (unit) {
      this.state.plan[index] = { ...unit, unitPhase: phase };
    }
  }

  private transitionToBreak(): void {
    this.state.phase = "break";
    this.state.breakSecondsLeft = this.breakDurationSeconds;
    this.state.startedAt = new Date();
    this.startBreakInterval();
    this.emitChange();
  }

  private startBreakInterval(): void {
    this.stopInterval();
    this.intervalId = setInterval(() => this.breakTick(), 1000);
  }

  private breakTick(): void {
    if (this.disposed || this.state.phase !== "break") return;

    if (this.state.breakSecondsLeft <= 1) {
      this.state.breakSecondsLeft = 0;
      this.stopInterval();
      // Break done - wait for user to start next unit
    } else {
      this.state.breakSecondsLeft--;
    }
    this.emitChange();
  }

  private startInterval(): void {
    this.stopInterval();
    this.intervalId = setInterval(() => this.tick(), 1000);
  }

  private stopInterval(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private tick(): void {
    if (this.disposed || this.state.phase !== "working") return;

    // Find the working unit and decrement its timer
    const workingIdx = getWorkingUnitIndex(this.state);
    if (workingIdx < 0) return;

    const unit = this.state.plan[workingIdx];
    if (!unit) return;

    // Check before decrementing to avoid negative values
    if (unit.secondsLeft <= 1) {
      this.state.plan[workingIdx] = { ...unit, secondsLeft: 0 };
      this.stopInterval();
      this.state.phase = "logging";
      this._onTimerComplete.fire(this.state.plan[workingIdx]);
    } else {
      this.state.plan[workingIdx] = { ...unit, secondsLeft: unit.secondsLeft - 1 };
    }

    this.emitChange();
  }

  private emitChange(): void {
    this._onStateChange.fire(this.getState());
  }
}
