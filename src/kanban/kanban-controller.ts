import * as vscode from "vscode";
import {
  KanbanTask,
  TaskPriority,
  createKanbanTask,
  getTaskStatus,
  sortTasksByPriority,
} from "./kanban-state";

const STORAGE_KEY = "redmyne.kanban";

/**
 * Interface for globalState-like storage
 */
export interface MockGlobalState {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Promise<void> | Thenable<void>;
}

/**
 * Controller options
 */
export interface KanbanControllerOptions {
  workDurationSeconds?: number;
  breakDurationSeconds?: number;
}

/**
 * Controller for kanban tasks with CRUD, timer, persistence, and events
 */
export class KanbanController {
  private tasks: KanbanTask[] = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private breakIntervalId: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private workDurationSeconds: number;
  private breakDurationSeconds: number;
  private breakSecondsLeft: number = 0;
  // Card whose timer auto-resumes when the current "keep working" break ends.
  private keepWorkingId?: string;

  // Data-mutation event (task added/moved/edited/etc). Heavy subscribers
  // (tree provider, context sync) listen here.
  private readonly _onTasksChange = new vscode.EventEmitter<void>();
  readonly onTasksChange = this._onTasksChange.event;

  // Per-second timer countdown event. Only the status bar listens — the
  // tree and context state never change between ticks, so they stay
  // subscribed to onTasksChange and skip the per-second work.
  private readonly _onTimerTick = new vscode.EventEmitter<void>();
  readonly onTimerTick = this._onTimerTick.event;

  private readonly _onTimerComplete = new vscode.EventEmitter<KanbanTask>();
  readonly onTimerComplete = this._onTimerComplete.event;

  private readonly _onBreakComplete = new vscode.EventEmitter<void>();
  readonly onBreakComplete = this._onBreakComplete.event;

  constructor(
    private readonly globalState: MockGlobalState,
    options?: KanbanControllerOptions
  ) {
    this.workDurationSeconds = options?.workDurationSeconds ?? 45 * 60;
    this.breakDurationSeconds = options?.breakDurationSeconds ?? 15 * 60;
    this.restore();
  }

  dispose(): void {
    this.disposed = true;
    this.stopInterval();
    this.stopBreakInterval();
    this._onTasksChange.dispose();
    this._onTimerTick.dispose();
    this._onTimerComplete.dispose();
    this._onBreakComplete.dispose();
  }

  // --- Getters ---

  getTasks(): KanbanTask[] {
    return [...this.tasks];
  }

  getTaskById(id: string): KanbanTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  getTasksByIssueId(issueId: number): KanbanTask[] {
    return this.tasks.filter((t) => t.linkedIssueId === issueId);
  }

  /**
   * Check if currently on break
   */
  isOnBreak(): boolean {
    return this.breakSecondsLeft > 0;
  }

  /**
   * Get break seconds remaining
   */
  getBreakSecondsLeft(): number {
    return this.breakSecondsLeft;
  }

  /**
   * Get configured work duration in seconds
   */
  getWorkDurationSeconds(): number {
    return this.workDurationSeconds;
  }

  /**
   * Get configured break duration in seconds
   */
  getBreakDurationSeconds(): number {
    return this.breakDurationSeconds;
  }

  /**
   * Update work duration (for settings changes)
   */
  setWorkDurationSeconds(seconds: number): void {
    this.workDurationSeconds = seconds;
  }

  /**
   * Update break duration (for settings changes)
   */
  setBreakDurationSeconds(seconds: number): void {
    this.breakDurationSeconds = seconds;
  }

  // --- CRUD ---

  async addTask(
    title: string,
    linkedIssueId: number,
    linkedIssueSubject: string,
    linkedProjectId: number,
    linkedProjectName: string,
    options?: {
      description?: string;
      priority?: TaskPriority;
      estimatedHours?: number;
      linkedParentProjectId?: number;
      linkedParentProjectName?: string;
    }
  ): Promise<KanbanTask> {
    const task = createKanbanTask(
      title,
      linkedIssueId,
      linkedIssueSubject,
      linkedProjectId,
      linkedProjectName,
      options
    );
    this.tasks.push(task);
    await this.persist();
    this._onTasksChange.fire();
    return task;
  }

  /**
   * Locate a task by id, merge a patch (auto-stamping updatedAt), persist, and
   * fire the change event. Returns whether a task was found and patched.
   *
   * `patch` may be a partial object or a function that derives the partial from
   * the current task (for read-modify-write fields like loggedHours). Methods
   * with extra side effects (interval start/stop, auto-pause of other tasks)
   * keep those at the call site, around this call.
   */
  private async patchTask(
    id: string,
    patch: Partial<KanbanTask> | ((task: KanbanTask) => Partial<KanbanTask>)
  ): Promise<boolean> {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return false;
    const task = this.tasks[index];
    if (!task) return false;

    const updates = typeof patch === "function" ? patch(task) : patch;
    this.tasks[index] = {
      ...task,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    this._onTasksChange.fire();
    return true;
  }

  async updateTask(
    id: string,
    updates: Partial<Pick<KanbanTask, "title" | "description" | "priority" | "estimatedHours">>
  ): Promise<void> {
    await this.patchTask(id, updates);
  }

  /**
   * Update parent project info for a task
   */
  async updateParentProject(
    id: string,
    linkedParentProjectId: number | undefined,
    linkedParentProjectName: string | undefined
  ): Promise<void> {
    await this.patchTask(id, { linkedParentProjectId, linkedParentProjectName });
  }

  async deleteTask(id: string): Promise<void> {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;

    this.tasks.splice(index, 1);
    await this.persist();
    this._onTasksChange.fire();
  }

  // --- Status Transitions ---

  async markDone(id: string): Promise<void> {
    // A done task must not keep ticking: it would stay getActiveTask()
    // and eventually fire a completion prompt to log time again.
    if (this.getTaskById(id)?.timerPhase === "working") {
      this.stopInterval();
    }

    await this.patchTask(id, {
      timerPhase: undefined,
      timerSecondsLeft: undefined,
      lastActiveAt: undefined,
      completedAt: new Date().toISOString(),
    });
  }

  async reopen(id: string): Promise<void> {
    await this.patchTask(id, { completedAt: undefined });
  }

  async addLoggedHours(id: string, hours: number): Promise<void> {
    if (hours <= 0) return; // Reject non-positive hours
    await this.patchTask(id, (task) => ({ loggedHours: task.loggedHours + hours }));
  }

  /**
   * Bank un-logged seconds onto a card's pending accumulator (work units +
   * keep-working breaks). The single record of un-logged work until Log it /
   * Transfer flushes it — persisted with the task.
   */
  async accruePending(id: string, seconds: number): Promise<void> {
    if (seconds <= 0) return;
    await this.patchTask(id, (task) => ({
      pendingSeconds: (task.pendingSeconds ?? 0) + seconds,
    }));
  }

  /**
   * Read and clear a card's pending seconds (called when its accrued time is
   * logged). Returns the amount cleared.
   */
  async consumePending(id: string): Promise<number> {
    const pending = this.getTaskById(id)?.pendingSeconds ?? 0;
    if (pending > 0) await this.patchTask(id, { pendingSeconds: 0 });
    return pending;
  }

  // --- Bulk Operations ---

  async clearDone(): Promise<void> {
    this.tasks = this.tasks.filter((t) => !t.completedAt);
    await this.persist();
    this._onTasksChange.fire();
  }

  // --- Reorder Operations ---

  /**
   * Move task up in its status column
   */
  async moveUp(id: string): Promise<void> {
    await this.move(id, -1);
  }

  /**
   * Move task down in its status column
   */
  async moveDown(id: string): Promise<void> {
    await this.move(id, 1);
  }

  /**
   * Swap a task with its column neighbor in the given direction
   * (-1 = up/earlier, +1 = down/later). No-op at the column boundary.
   */
  private async move(id: string, direction: -1 | 1): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;

    const status = getTaskStatus(task);
    const sameStatusTasks = sortTasksByPriority(
      this.tasks.filter((t) => getTaskStatus(t) === status)
    );

    const currentIndex = sameStatusTasks.findIndex((t) => t.id === id);
    if (currentIndex < 0) return;
    const neighborIndex = currentIndex + direction;
    if (neighborIndex < 0 || neighborIndex >= sameStatusTasks.length) return; // At boundary

    const neighborTask = sameStatusTasks[neighborIndex];
    if (!neighborTask) return;
    const currentOrder = task.sortOrder ?? currentIndex;
    const neighborOrder = neighborTask.sortOrder ?? neighborIndex;

    // Find and update in main array
    const taskIdx = this.tasks.findIndex((t) => t.id === id);
    const neighborIdx = this.tasks.findIndex((t) => t.id === neighborTask.id);
    const taskAtIdx = this.tasks[taskIdx];
    const neighborAtIdx = this.tasks[neighborIdx];
    if (!taskAtIdx || !neighborAtIdx) return;

    this.tasks[taskIdx] = {
      ...taskAtIdx,
      sortOrder: neighborOrder,
      updatedAt: new Date().toISOString(),
    };
    this.tasks[neighborIdx] = {
      ...neighborAtIdx,
      sortOrder: currentOrder,
      updatedAt: new Date().toISOString(),
    };

    await this.persist();
    this._onTasksChange.fire();
  }

  // --- Timer Operations ---

  /**
   * Get task with active timer (timerPhase = "working")
   */
  getActiveTask(): KanbanTask | undefined {
    return this.tasks.find((t) => t.timerPhase === "working");
  }

  /**
   * Start timer for a task.
   * @param reset if true, force seconds back to full workDurationSeconds; otherwise
   *   preserve any existing timerSecondsLeft (e.g. set by moveToDoing).
   */
  async startTimer(
    id: string,
    activityId: number,
    activityName: string,
    reset = false
  ): Promise<void> {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;
    const task = this.tasks[index];
    if (!task) return;

    // Auto-pause any currently working task
    const activeIndex = this.tasks.findIndex((t) => t.timerPhase === "working");
    if (activeIndex >= 0 && activeIndex !== index) {
      const activeTask = this.tasks[activeIndex];
      if (activeTask) {
        this.tasks[activeIndex] = {
          ...activeTask,
          timerPhase: "paused",
          updatedAt: new Date().toISOString(),
        };
      }
    }

    // Start timer on this task
    this.startInterval();
    await this.patchTask(id, {
      timerPhase: "working",
      timerSecondsLeft: reset
        ? this.workDurationSeconds
        : (task.timerSecondsLeft ?? this.workDurationSeconds),
      activityId,
      activityName,
      lastActiveAt: new Date().toISOString(),
    });
  }

  /**
   * Pause timer for a task
   */
  async pauseTimer(id: string): Promise<void> {
    if (this.getTaskById(id)?.timerPhase !== "working") return;

    this.stopInterval();
    await this.patchTask(id, { timerPhase: "paused" });
  }

  /**
   * Resume timer for a paused task
   */
  async resumeTimer(id: string): Promise<void> {
    if (this.getTaskById(id)?.timerPhase !== "paused") return;

    // Auto-pause any currently working task
    const activeIndex = this.tasks.findIndex((t) => t.timerPhase === "working");
    if (activeIndex >= 0) {
      const activeTask = this.tasks[activeIndex];
      if (activeTask) {
        this.tasks[activeIndex] = {
          ...activeTask,
          timerPhase: "paused",
          updatedAt: new Date().toISOString(),
        };
      }
    }

    this.startInterval();
    await this.patchTask(id, {
      timerPhase: "working",
      lastActiveAt: new Date().toISOString(),
    });
  }

  /**
   * Stop timer for a task (clears timer state, keeps logged hours)
   */
  async stopTimer(id: string): Promise<void> {
    if (this.getTaskById(id)?.timerPhase === "working") {
      this.stopInterval();
    }

    await this.patchTask(id, {
      timerPhase: undefined,
      timerSecondsLeft: undefined,
      lastActiveAt: undefined,
    });
  }

  /**
   * Move task back to todo (clears timer state AND logged hours)
   */
  async moveToTodo(id: string): Promise<void> {
    if (this.getTaskById(id)?.timerPhase === "working") {
      this.stopInterval();
    }

    await this.patchTask(id, {
      timerPhase: undefined,
      timerSecondsLeft: undefined,
      activityId: undefined,
      activityName: undefined,
      lastActiveAt: undefined,
      doingAt: undefined,
      completedAt: undefined, // Clear if moving from Done
      loggedHours: 0,
    });
  }

  /**
   * Move task to Doing (initializes timer but doesn't start countdown)
   */
  async moveToDoing(id: string): Promise<void> {
    await this.patchTask(id, {
      doingAt: new Date().toISOString(),
      timerSecondsLeft: this.workDurationSeconds,
      completedAt: undefined, // Clear if reopening from Done
    });
  }

  /**
   * Reset timer to full duration (for continuing same task)
   */
  async resetTimer(id: string): Promise<void> {
    await this.patchTask(id, {
      timerSecondsLeft: this.workDurationSeconds,
      timerPhase: "pending",
    });
  }

  // --- Timer Internals ---

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
    if (this.disposed) return;

    const activeIndex = this.tasks.findIndex((t) => t.timerPhase === "working");
    if (activeIndex < 0) return;

    const task = this.tasks[activeIndex];
    if (!task) return;
    const secondsLeft = task.timerSecondsLeft ?? 0;

    if (secondsLeft <= 1) {
      const completed: KanbanTask = {
        ...task,
        timerSecondsLeft: 0,
        updatedAt: new Date().toISOString(),
      };
      this.tasks[activeIndex] = completed;
      this.stopInterval();
      this._onTimerComplete.fire(completed);
      // Timer completion changes task state, so notify data subscribers.
      this._onTasksChange.fire();
    } else {
      this.tasks[activeIndex] = {
        ...task,
        timerSecondsLeft: secondsLeft - 1,
        lastActiveAt: new Date().toISOString(),
      };
      // Countdown only — only the status bar needs to repaint.
      this._onTimerTick.fire();
    }
  }

  // --- Break Timer ---

  /**
   * "Keep working": after a finished work unit, take the break and roll straight
   * into the next unit. The work interval is stopped here; when the break ends,
   * its elapsed time is banked on the card and the timer auto-resumes.
   */
  keepWorking(id: string): void {
    this.stopInterval();
    this.keepWorkingId = id;
    this.startBreak();
  }

  /**
   * Start break timer after work session
   */
  startBreak(): void {
    this.breakSecondsLeft = this.breakDurationSeconds;
    this.stopBreakInterval();
    this.breakIntervalId = setInterval(() => this.breakTick(), 1000);
    this._onTasksChange.fire();
  }

  /**
   * Skip remaining break time (banks only the portion actually elapsed)
   */
  skipBreak(): void {
    this.endBreak();
  }

  private stopBreakInterval(): void {
    if (this.breakIntervalId !== null) {
      clearInterval(this.breakIntervalId);
      this.breakIntervalId = null;
    }
  }

  private breakTick(): void {
    if (this.disposed) return;

    if (this.breakSecondsLeft <= 1) {
      this.breakSecondsLeft = 0; // full break elapsed
      this.endBreak();
    } else {
      this.breakSecondsLeft--;
      // Countdown only — only the status bar needs to repaint.
      this._onTimerTick.fire();
    }
  }

  /**
   * End the break (natural completion or skip). Banks the elapsed break onto the
   * keep-working card and auto-resumes its timer for the next unit. Direct task
   * mutation (mirrors {@link tick}) so it is synchronous and testable.
   */
  private endBreak(): void {
    const elapsed = Math.max(0, this.breakDurationSeconds - this.breakSecondsLeft);
    this.breakSecondsLeft = 0;
    this.stopBreakInterval();

    const resumeId = this.keepWorkingId;
    this.keepWorkingId = undefined;
    if (resumeId) {
      const idx = this.tasks.findIndex((t) => t.id === resumeId);
      const task = this.tasks[idx];
      if (task) {
        this.tasks[idx] = {
          ...task,
          pendingSeconds: (task.pendingSeconds ?? 0) + elapsed,
          timerPhase: "working",
          timerSecondsLeft: this.workDurationSeconds,
          lastActiveAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        this.startInterval();
        void this.persist();
      }
    }

    this._onBreakComplete.fire();
    // Break end transitions state for tree/context subscribers too.
    this._onTasksChange.fire();
  }

  // --- Persistence ---

  private async persist(): Promise<void> {
    await this.globalState.update(STORAGE_KEY, this.tasks);
  }

  private restore(): void {
    const stored = this.globalState.get<unknown[]>(STORAGE_KEY, []);
    this.tasks = this.validateAndFilter(stored);

    // Session recovery: adjust timer for elapsed time since last active
    const now = Date.now();
    for (let i = 0; i < this.tasks.length; i++) {
      const task = this.tasks[i];
      if (!task) continue;
      if (task.timerPhase === "working" && task.lastActiveAt && task.timerSecondsLeft !== undefined) {
        const lastActive = new Date(task.lastActiveAt).getTime();
        const elapsedSeconds = Math.floor((now - lastActive) / 1000);
        const adjustedSeconds = Math.max(0, task.timerSecondsLeft - elapsedSeconds);

        if (adjustedSeconds === 0) {
          // Timer had completed - clear timer state, user can start fresh
          this.tasks[i] = {
            ...task,
            timerPhase: undefined,
            timerSecondsLeft: undefined,
            lastActiveAt: undefined,
          };
        } else {
          // Pause the task (user must explicitly resume)
          this.tasks[i] = {
            ...task,
            timerPhase: "paused",
            timerSecondsLeft: adjustedSeconds,
          };
        }
      }
    }
  }

  private validateAndFilter(data: unknown[]): KanbanTask[] {
    if (!Array.isArray(data)) return [];

    return data.filter((item): item is KanbanTask => {
      if (!item || typeof item !== "object") return false;
      const obj = item as Record<string, unknown>;
      // Validate all required fields
      return (
        typeof obj.id === "string" &&
        typeof obj.title === "string" &&
        typeof obj.linkedIssueId === "number" &&
        typeof obj.linkedIssueSubject === "string" &&
        typeof obj.linkedProjectId === "number" &&
        typeof obj.linkedProjectName === "string" &&
        typeof obj.loggedHours === "number" &&
        obj.loggedHours >= 0 &&
        typeof obj.priority === "string" &&
        ["low", "medium", "high"].includes(obj.priority as string) &&
        typeof obj.createdAt === "string" &&
        typeof obj.updatedAt === "string"
      );
    });
  }
}
