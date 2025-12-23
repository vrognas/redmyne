import * as vscode from "vscode";
import {
  PersonalTask,
  TaskPriority,
  createPersonalTask,
} from "./personal-task-state";

const STORAGE_KEY = "redmine.personalTasks";

/**
 * Interface for globalState-like storage
 */
export interface MockGlobalState {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Promise<void> | Thenable<void>;
}

/**
 * Controller for personal tasks with CRUD, persistence, and events
 */
export class PersonalTaskController {
  private tasks: PersonalTask[] = [];

  private readonly _onTasksChange = new vscode.EventEmitter<void>();
  readonly onTasksChange = this._onTasksChange.event;

  constructor(private readonly globalState: MockGlobalState) {
    this.restore();
  }

  dispose(): void {
    this._onTasksChange.dispose();
  }

  // --- Getters ---

  getTasks(): PersonalTask[] {
    return [...this.tasks];
  }

  getTaskById(id: string): PersonalTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  getTasksByIssueId(issueId: number): PersonalTask[] {
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
  ): Promise<PersonalTask> {
    const task = createPersonalTask(
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
    updates: Partial<Pick<PersonalTask, "title" | "description" | "priority" | "estimatedHours">>
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

  // --- Persistence ---

  private async persist(): Promise<void> {
    await this.globalState.update(STORAGE_KEY, this.tasks);
  }

  private restore(): void {
    const stored = this.globalState.get<unknown[]>(STORAGE_KEY, []);
    this.tasks = this.validateAndFilter(stored);
  }

  private validateAndFilter(data: unknown[]): PersonalTask[] {
    if (!Array.isArray(data)) return [];

    return data.filter((item): item is PersonalTask => {
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
