/**
 * Per-unit phase states
 */
export type UnitPhase = "pending" | "working" | "paused" | "completed";

/**
 * A planned work unit with its own timer
 */
export interface WorkUnit {
  issueId: number;
  issueSubject: string;
  activityId: number;
  activityName: string;
  comment?: string;
  logged: boolean;
  loggedHours?: number;
  completedAt?: string; // ISO timestamp when unit was logged
  // Per-unit timer state
  secondsLeft: number;
  unitPhase: UnitPhase;
}

/**
 * Global timer phases (only for break and logging states)
 */
export type TimerPhase = "idle" | "working" | "paused" | "logging" | "break";

/**
 * Runtime timer state
 */
export interface TimerState {
  phase: TimerPhase;
  plan: WorkUnit[];
  currentUnitIndex: number;
  breakSecondsLeft: number;
  startedAt?: Date;
}

/**
 * Persisted state for recovery across sessions
 */
export interface PersistedTimerState {
  plan: WorkUnit[];
  currentUnitIndex: number;
  todayDate: string; // YYYY-MM-DD - invalidate if different
  phase: TimerPhase;
  breakSecondsLeft: number;
  lastActiveAt: string; // ISO timestamp - for calculating elapsed on working unit
}

/**
 * Create initial idle state
 */
export function createIdleState(): TimerState {
  return {
    phase: "idle",
    plan: [],
    currentUnitIndex: 0,
    breakSecondsLeft: 0,
  };
}

/**
 * Create a new work unit with default timer
 */
export function createWorkUnit(
  issueId: number,
  issueSubject: string,
  activityId: number,
  activityName: string,
  workDurationSeconds: number,
  comment?: string
): WorkUnit {
  return {
    issueId,
    issueSubject,
    activityId,
    activityName,
    comment,
    logged: false,
    secondsLeft: workDurationSeconds,
    unitPhase: "pending",
  };
}

/**
 * Get current unit from state (undefined if no plan or out of bounds)
 */
export function getCurrentUnit(state: TimerState): WorkUnit | undefined {
  return state.plan[state.currentUnitIndex];
}

/**
 * Check if all units are completed
 */
export function isAllCompleted(state: TimerState): boolean {
  return state.plan.length > 0 && state.plan.every((u) => u.logged);
}

/**
 * Count completed units
 */
export function countCompleted(state: TimerState): number {
  return state.plan.filter((u) => u.logged).length;
}

/**
 * Get the currently working unit (if any)
 */
export function getWorkingUnit(state: TimerState): WorkUnit | undefined {
  return state.plan.find((u) => u.unitPhase === "working");
}

/**
 * Get index of the currently working unit (-1 if none)
 */
export function getWorkingUnitIndex(state: TimerState): number {
  return state.plan.findIndex((u) => u.unitPhase === "working");
}

/**
 * Convert state to persisted format
 */
export function toPersistedState(state: TimerState): PersistedTimerState {
  return {
    plan: state.plan,
    currentUnitIndex: state.currentUnitIndex,
    todayDate: new Date().toISOString().split("T")[0],
    phase: state.phase,
    breakSecondsLeft: state.breakSecondsLeft,
    lastActiveAt: state.startedAt?.toISOString() || new Date().toISOString(),
  };
}

/** Valid timer phases */
const VALID_PHASES: TimerPhase[] = ["idle", "working", "paused", "logging", "break"];

/**
 * Restore state from persisted format with validation
 */
export function fromPersistedState(persisted: PersistedTimerState): TimerState {
  // Validate and sanitize persisted data
  const plan = Array.isArray(persisted.plan) ? persisted.plan : [];
  const validPlan = plan.filter(u =>
    u && typeof u.issueId === "number" && typeof u.secondsLeft === "number"
  );

  const currentUnitIndex = Math.max(0, Math.min(
    persisted.currentUnitIndex ?? 0,
    Math.max(0, validPlan.length - 1)
  ));

  const startedAt = new Date(persisted.lastActiveAt);
  const validStartedAt = isNaN(startedAt.getTime()) ? new Date() : startedAt;

  // Validate phase - default to idle if invalid
  const phase: TimerPhase = VALID_PHASES.includes(persisted.phase as TimerPhase)
    ? persisted.phase
    : "idle";

  return {
    phase,
    plan: validPlan,
    currentUnitIndex,
    breakSecondsLeft: Math.max(0, persisted.breakSecondsLeft ?? 0),
    startedAt: validStartedAt,
  };
}
