import * as vscode from "vscode";
import {
  KanbanTask,
  TaskPriority,
  createKanbanTask,
} from "./kanban-state";

const STORAGE_KEY = "redmine.kanban";

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
}

/**
 * Controller for kanban tasks with CRUD, timer, persistence, and events
 */
export class KanbanController {
  private tasks: KanbanTask[] = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly workDurationSeconds: number;

  private readonly _onTasksChange = new vscode.EventEmitter<void>();
  readonly onTasksChange = this._onTasksChange.event;

  private readonly _onTimerComplete = new vscode.EventEmitter<KanbanTask>();
  readonly onTimerComplete = this._onTimerComplete.event;

  constructor(
    private readonly globalState: MockGlobalState,
    options?: KanbanControllerOptions
  ) {
    this.workDurationSeconds = options?.workDurationSeconds ?? 45 * 60;
    this.restore();
  }

  dispose(): void {
    this.disposed = true;
    this.stopInterval();
    this._onTasksChange.dispose();
    this._onTimerComplete.dispose();
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
      loggedHours: 0,
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
