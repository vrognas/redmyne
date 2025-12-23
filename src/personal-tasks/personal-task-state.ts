/**
 * Personal task (local subtask under a Redmine issue)
 */
export interface PersonalTask {
  id: string; // UUID
  title: string; // → time entry comment
  description?: string;
  priority: TaskPriority;

  // Required Redmine link
  linkedIssueId: number;
  linkedIssueSubject: string;
  linkedProjectId: number;
  linkedProjectName: string;

  // Time tracking
  estimatedHours?: number;
  loggedHours: number; // Accumulated from logging

  // Metadata
  createdAt: string; // ISO
  updatedAt: string; // ISO
  completedAt?: string; // ISO - set when manually marked done
}

export type TaskPriority = "low" | "medium" | "high";

/**
 * Derived status based on loggedHours and completedAt
 */
export type TaskStatus = "todo" | "in-progress" | "done";

/**
 * Get derived status for a task
 */
export function getTaskStatus(task: PersonalTask): TaskStatus {
  if (task.completedAt) return "done";
  if (task.loggedHours > 0) return "in-progress";
  return "todo";
}

/**
 * Generate UUID v4
 */
export function generateId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Create a new personal task
 */
export function createPersonalTask(
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
): PersonalTask {
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
    estimatedHours: options?.estimatedHours,
    loggedHours: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Group tasks by derived status
 */
export function groupTasksByStatus(tasks: PersonalTask[]): {
  todo: PersonalTask[];
  inProgress: PersonalTask[];
  done: PersonalTask[];
} {
  const todo: PersonalTask[] = [];
  const inProgress: PersonalTask[] = [];
  const done: PersonalTask[] = [];

  for (const task of tasks) {
    const status = getTaskStatus(task);
    if (status === "todo") todo.push(task);
    else if (status === "in-progress") inProgress.push(task);
    else done.push(task);
  }

  return { todo, inProgress, done };
}

/**
 * Sort tasks by priority (high first), then by creation date (newest first)
 */
export function sortTasksByPriority(tasks: PersonalTask[]): PersonalTask[] {
  const priorityOrder: Record<TaskPriority, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  return [...tasks].sort((a, b) => {
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
