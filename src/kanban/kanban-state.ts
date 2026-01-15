/**
 * Timer phase for embedded timer
 */
export type TimerPhase = "pending" | "working" | "paused" | "completed";

/**
 * Kanban task (local subtask under a Redmine issue)
 */
export interface KanbanTask {
  id: string; // UUID
  title: string; // → time entry comment
  description?: string;
  priority: TaskPriority;

  // Required Redmine link
  linkedIssueId: number;
  linkedIssueSubject: string;
  linkedProjectId: number;
  linkedProjectName: string;
  linkedParentProjectId?: number;
  linkedParentProjectName?: string;

  // Time tracking
  estimatedHours?: number;
  loggedHours: number; // Accumulated from logging

  // Timer state (embedded from former Today's Plan)
  timerSecondsLeft?: number;
  timerPhase?: TimerPhase;
  activityId?: number;
  activityName?: string;
  lastActiveAt?: string; // ISO for session recovery

  // Metadata
  createdAt: string; // ISO
  updatedAt: string; // ISO
  completedAt?: string; // ISO - set when manually marked done
  doingAt?: string; // ISO - set when moved to Doing via drag-drop
  sortOrder?: number; // Manual sort order (lower = higher in list)
}

export type TaskPriority = "low" | "medium" | "high";

/**
 * Derived status: 3-column kanban (todo, doing, done)
 */
export type TaskStatus = "todo" | "doing" | "done";

/**
 * Get derived status for a task:
 * - done: completedAt is set
 * - doing: has logged hours OR active/paused timer
 * - todo: neither
 */
export function getTaskStatus(task: KanbanTask): TaskStatus {
  if (task.completedAt) return "done";
  if (
    task.doingAt ||
    task.loggedHours > 0 ||
    task.timerPhase === "working" ||
    task.timerPhase === "paused"
  ) {
    return "doing";
  }
  return "todo";
}

/**
 * Generate UUID v4
 */
function generateId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Create a new kanban task
 */
export function createKanbanTask(
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
): KanbanTask {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    title,
    description: options?.description,
    priority: options?.priority ?? "medium",
    linkedIssueId,
    linkedIssueSubject,
    linkedProjectId,
    linkedProjectName,
    linkedParentProjectId: options?.linkedParentProjectId,
    linkedParentProjectName: options?.linkedParentProjectName,
    estimatedHours: options?.estimatedHours,
    loggedHours: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Group tasks by derived status (3 columns)
 */
export function groupTasksByStatus(tasks: KanbanTask[]): {
  todo: KanbanTask[];
  doing: KanbanTask[];
  done: KanbanTask[];
} {
  const todo: KanbanTask[] = [];
  const doing: KanbanTask[] = [];
  const done: KanbanTask[] = [];

  for (const task of tasks) {
    const status = getTaskStatus(task);
    if (status === "todo") todo.push(task);
    else if (status === "doing") doing.push(task);
    else done.push(task);
  }

  return { todo, doing, done };
}

/**
 * Sort tasks by sortOrder (if set), then priority (high first), then creation date (newest first)
 */
export function sortTasksByPriority(tasks: KanbanTask[]): KanbanTask[] {
  const priorityOrder: Record<TaskPriority, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  return [...tasks].sort((a, b) => {
    // Manual sort order takes precedence (lower = higher in list)
    const aOrder = a.sortOrder ?? Infinity;
    const bOrder = b.sortOrder ?? Infinity;
    if (aOrder !== bOrder) return aOrder - bOrder;
    // Default to medium (1) if priority is invalid
    const aPriority = priorityOrder[a.priority] ?? 1;
    const bPriority = priorityOrder[b.priority] ?? 1;
    const priorityDiff = aPriority - bPriority;
    if (priorityDiff !== 0) return priorityDiff;
    // Handle invalid dates by treating them as oldest
    const aTime = new Date(a.createdAt).getTime() || 0;
    const bTime = new Date(b.createdAt).getTime() || 0;
    return bTime - aTime;
  });
}
