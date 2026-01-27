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
  private readonly breakDurationSeconds: number;
  private breakSecondsLeft: number = 0;
  private deferredMinutes: number = 0;

  private readonly _onTasksChange = new vscode.EventEmitter<void>();
  readonly onTasksChange = this._onTasksChange.event;

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
   * Update work duration (for settings changes)
   */
  setWorkDurationSeconds(seconds: number): void {
    this.workDurationSeconds = seconds;
  }

  /**
   * Get deferred minutes (accumulated from previous tasks)
   */
  getDeferredMinutes(): number {
    return this.deferredMinutes;
  }

  /**
   * Add deferred minutes (called when deferring a task)
   */
  addDeferredMinutes(minutes: number): void {
    this.deferredMinutes += minutes;
    this._onTasksChange.fire();
  }

  /**
   * Consume deferred minutes (called when logging - returns total and resets)
   */
  consumeDeferredMinutes(): number {
    const deferred = this.deferredMinutes;
    this.deferredMinutes = 0;
    return deferred;
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

  async updateTask(
    id: string,
    updates: Partial<Pick<KanbanTask, "title" | "description" | "priority" | "estimatedHours">>
  ): Promise<void> {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;

    this.tasks[index] = {
      ...this.tasks[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    this._onTasksChange.fire();
  }

  /**
   * Update parent project info for a task
   */
  async updateParentProject(
    id: string,
    linkedParentProjectId: number | undefined,
    linkedParentProjectName: string | undefined
  ): Promise<void> {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;

    this.tasks[index] = {
      ...this.tasks[index],
      linkedParentProjectId,
      linkedParentProjectName,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    this._onTasksChange.fire();
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
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;

    this.tasks[index] = {
      ...this.tasks[index],
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    this._onTasksChange.fire();
  }

  async reopen(id: string): Promise<void> {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;

    this.tasks[index] = {
      ...this.tasks[index],
      completedAt: undefined,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    this._onTasksChange.fire();
  }

  async addLoggedHours(id: string, hours: number): Promise<void> {
    if (hours <= 0) return; // Reject non-positive hours
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;

    this.tasks[index] = {
      ...this.tasks[index],
      loggedHours: this.tasks[index].loggedHours + hours,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    this._onTasksChange.fire();
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
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;

    const status = getTaskStatus(task);
    const sameStatusTasks = sortTasksByPriority(
      this.tasks.filter((t) => getTaskStatus(t) === status)
    );

    const currentIndex = sameStatusTasks.findIndex((t) => t.id === id);
    if (currentIndex <= 0) return; // Already at top

    // Ensure both tasks have sortOrder, then swap
    const prevTask = sameStatusTasks[currentIndex - 1];
    const currentOrder = task.sortOrder ?? currentIndex;
    const prevOrder = prevTask.sortOrder ?? currentIndex - 1;

    // Find and update in main array
    const taskIdx = this.tasks.findIndex((t) => t.id === id);
    const prevIdx = this.tasks.findIndex((t) => t.id === prevTask.id);

    this.tasks[taskIdx] = {
      ...this.tasks[taskIdx],
      sortOrder: prevOrder,
      updatedAt: new Date().toISOString(),
    };
    this.tasks[prevIdx] = {
      ...this.tasks[prevIdx],
      sortOrder: currentOrder,
      updatedAt: new Date().toISOString(),
    };

    await this.persist();
    this._onTasksChange.fire();
  }

  /**
   * Move task down in its status column
   */
  async moveDown(id: string): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;

    const status = getTaskStatus(task);
    const sameStatusTasks = sortTasksByPriority(
      this.tasks.filter((t) => getTaskStatus(t) === status)
    );

    const currentIndex = sameStatusTasks.findIndex((t) => t.id === id);
    if (currentIndex < 0 || currentIndex >= sameStatusTasks.length - 1) return; // Already at bottom

    // Ensure both tasks have sortOrder, then swap
    const nextTask = sameStatusTasks[currentIndex + 1];
    const currentOrder = task.sortOrder ?? currentIndex;
    const nextOrder = nextTask.sortOrder ?? currentIndex + 1;

    // Find and update in main array
    const taskIdx = this.tasks.findIndex((t) => t.id === id);
    const nextIdx = this.tasks.findIndex((t) => t.id === nextTask.id);

    this.tasks[taskIdx] = {
      ...this.tasks[taskIdx],
      sortOrder: nextOrder,
      updatedAt: new Date().toISOString(),
    };
    this.tasks[nextIdx] = {
      ...this.tasks[nextIdx],
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
   * Start timer for a task
   */
  async startTimer(
    id: string,
    activityId: number,
    activityName: string
  ): Promise<void> {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;

    // Auto-pause any currently working task
    const activeIndex = this.tasks.findIndex((t) => t.timerPhase === "working");
    if (activeIndex >= 0 && activeIndex !== index) {
      this.tasks[activeIndex] = {
        ...this.tasks[activeIndex],
        timerPhase: "paused",
        updatedAt: new Date().toISOString(),
      };
    }

    // Start timer on this task
    this.tasks[index] = {
      ...this.tasks[index],
      timerPhase: "working",
      timerSecondsLeft: this.tasks[index].timerSecondsLeft ?? this.workDurationSeconds,
      activityId,
      activityName,
      lastActiveAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.startInterval();
    await this.persist();
    this._onTasksChange.fire();
  }

  /**
   * Pause timer for a task
   */
  async pauseTimer(id: string): Promise<void> {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;
    if (this.tasks[index].timerPhase !== "working") return;

    this.stopInterval();
    this.tasks[index] = {
      ...this.tasks[index],
      timerPhase: "paused",
      updatedAt: new Date().toISOString(),
    };

    await this.persist();
    this._onTasksChange.fire();
  }

  /**
   * Resume timer for a paused task
   */
  async resumeTimer(id: string): Promise<void> {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;
    if (this.tasks[index].timerPhase !== "paused") return;

    // Auto-pause any currently working task
    const activeIndex = this.tasks.findIndex((t) => t.timerPhase === "working");
    if (activeIndex >= 0) {
      this.tasks[activeIndex] = {
        ...this.tasks[activeIndex],
        timerPhase: "paused",
        updatedAt: new Date().toISOString(),
      };
    }

    this.tasks[index] = {
      ...this.tasks[index],
      timerPhase: "working",
      lastActiveAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.startInterval();
    await this.persist();
    this._onTasksChange.fire();
  }

  /**
   * Stop timer for a task (clears timer state, keeps logged hours)
   */
  async stopTimer(id: string): Promise<void> {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;

    if (this.tasks[index].timerPhase === "working") {
      this.stopInterval();
    }

    this.tasks[index] = {
      ...this.tasks[index],
      timerPhase: undefined,
      timerSecondsLeft: undefined,
      lastActiveAt: undefined,
      updatedAt: new Date().toISOString(),
    };

    await this.persist();
    this._onTasksChange.fire();
  }

  /**
   * Move task back to todo (clears timer state AND logged hours)
   */
  async moveToTodo(id: string): Promise<void> {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;

    if (this.tasks[index].timerPhase === "working") {
      this.stopInterval();
    }

    this.tasks[index] = {
      ...this.tasks[index],
      timerPhase: undefined,
      timerSecondsLeft: undefined,
      activityId: undefined,
      activityName: undefined,
      lastActiveAt: undefined,
      doingAt: undefined,
      completedAt: undefined, // Clear if moving from Done
      loggedHours: 0,
      updatedAt: new Date().toISOString(),
    };

    await this.persist();
    this._onTasksChange.fire();
  }

  /**
   * Move task to Doing (initializes timer but doesn't start countdown)
   */
  async moveToDoing(id: string): Promise<void> {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;

    this.tasks[index] = {
      ...this.tasks[index],
      doingAt: new Date().toISOString(),
      timerSecondsLeft: this.workDurationSeconds,
      completedAt: undefined, // Clear if reopening from Done
      updatedAt: new Date().toISOString(),
    };

    await this.persist();
    this._onTasksChange.fire();
  }

  /**
   * Reset timer to full duration (for continuing same task)
   */
  async resetTimer(id: string): Promise<void> {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;

    this.tasks[index] = {
      ...this.tasks[index],
      timerSecondsLeft: this.workDurationSeconds,
      timerPhase: "pending",
      updatedAt: new Date().toISOString(),
    };

    await this.persist();
    this._onTasksChange.fire();
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
    const secondsLeft = task.timerSecondsLeft ?? 0;

    if (secondsLeft <= 1) {
      this.tasks[activeIndex] = {
        ...task,
        timerSecondsLeft: 0,
        updatedAt: new Date().toISOString(),
      };
      this.stopInterval();
      this._onTimerComplete.fire(this.tasks[activeIndex]);
    } else {
      this.tasks[activeIndex] = {
        ...task,
        timerSecondsLeft: secondsLeft - 1,
        lastActiveAt: new Date().toISOString(),
      };
    }

    this._onTasksChange.fire();
  }

  // --- Break Timer ---

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
   * Skip remaining break time
   */
  skipBreak(): void {
    this.stopBreakInterval();
    this.breakSecondsLeft = 0;
    this._onBreakComplete.fire();
    this._onTasksChange.fire();
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
      this.breakSecondsLeft = 0;
      this.stopBreakInterval();
      this._onBreakComplete.fire();
    } else {
      this.breakSecondsLeft--;
    }

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
