import * as vscode from "vscode";
import { KanbanController } from "./kanban-controller";
import {
  KanbanTask,
  TaskPriority,
  TaskStatus,
  getTaskStatus,
  sortTasksByPriority,
} from "./kanban-state";
import { formatHoursAsHHMM } from "../utilities/time-input";
import { BaseTreeProvider } from "../shared/base-tree-provider";

// Filter/sort persistence keys
const FILTER_KEY = "redmyne.kanban.filterPriority";
const SORT_FIELD_KEY = "redmyne.kanban.sortField";
const SORT_DIR_KEY = "redmyne.kanban.sortDirection";

export type KanbanFilterPriority = TaskPriority | "all";
export type KanbanSortField = "priority" | "issueId";
export type SortDirection = "asc" | "desc";

type TaskTreeItemType = "status-header" | "client-folder" | "project-folder" | "task" | "break-status";

export interface TaskTreeItem {
  type: TaskTreeItemType;
  status?: TaskStatus;
  task?: KanbanTask;
  // For client (parent project) folders
  clientId?: number;
  clientName?: string;
  // For project folders
  projectId?: number;
  projectName?: string;
  // For break status
  breakSecondsLeft?: number;
}

const MIME_TYPE = "application/vnd.code.tree.redmyne-kanban";

/**
 * Tree provider for "Kanban" view with drag-and-drop support
 */
export class KanbanTreeProvider
  extends BaseTreeProvider<TaskTreeItem>
  implements vscode.TreeDragAndDropController<TaskTreeItem>
{
  // TreeDragAndDropController properties
  readonly dropMimeTypes = [MIME_TYPE];
  readonly dragMimeTypes = [MIME_TYPE];

  // Filter/sort state
  private filterPriority: KanbanFilterPriority = "all";
  private sortField: KanbanSortField = "priority";
  private sortDirection: SortDirection = "desc";
  private globalState?: vscode.Memento;

  constructor(private controller: KanbanController, globalState?: vscode.Memento) {
    super();
    this.globalState = globalState;
    this.disposables.push(controller.onTasksChange(() => this.refresh()));

    // Restore filter/sort from globalState
    if (globalState) {
      this.filterPriority = globalState.get<KanbanFilterPriority>(FILTER_KEY, "all");
      this.sortField = globalState.get<KanbanSortField>(SORT_FIELD_KEY, "priority");
      this.sortDirection = globalState.get<SortDirection>(SORT_DIR_KEY, "desc");
    }
  }

  /**
   * Set filter by priority. Persists to globalState.
   */
  setFilter(priority: KanbanFilterPriority): void {
    this.filterPriority = priority;
    this.globalState?.update(FILTER_KEY, priority);
    this.refresh();
  }

  /**
   * Set sort field. Toggles direction if same field. Persists to globalState.
   */
  setSort(field: KanbanSortField): void {
    if (this.sortField === field) {
      this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
    } else {
      this.sortField = field;
      this.sortDirection = "desc";
    }
    this.globalState?.update(SORT_FIELD_KEY, this.sortField);
    this.globalState?.update(SORT_DIR_KEY, this.sortDirection);
    this.refresh();
  }

  /** Get current filter for UI display */
  getFilter(): KanbanFilterPriority {
    return this.filterPriority;
  }

  /** Get current sort for UI display */
  getSort(): { field: KanbanSortField; direction: SortDirection } {
    return { field: this.sortField, direction: this.sortDirection };
  }

  // --- TreeDragAndDropController methods ---

  handleDrag(
    source: readonly TaskTreeItem[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): void {
    // Only allow dragging task items
    const tasks = source.filter((s) => s.type === "task" && s.task);
    if (tasks.length === 0) return;

    dataTransfer.set(
      MIME_TYPE,
      new vscode.DataTransferItem(tasks.map((t) => t.task!.id))
    );
  }

  async handleDrop(
    target: TaskTreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // Only accept drops on status headers
    if (target?.type !== "status-header" || !target.status) return;

    const item = dataTransfer.get(MIME_TYPE);
    if (!item) return;

    const taskIds: string[] = item.value;
    const targetStatus = target.status;

    for (const taskId of taskIds) {
      await this.moveTaskToStatus(taskId, targetStatus);
    }
  }

  private async moveTaskToStatus(
    taskId: string,
    status: TaskStatus
  ): Promise<void> {
    const task = this.controller.getTaskById(taskId);
    if (!task) return;

    const currentStatus = getTaskStatus(task);
    if (currentStatus === status) return; // No-op

    switch (status) {
      case "todo":
        await this.controller.moveToTodo(taskId);
        break;
      case "doing":
        await this.controller.moveToDoing(taskId);
        break;
      case "done":
        await this.controller.markDone(taskId);
        break;
    }
  }

  getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    if (element.type === "break-status") {
      const timeStr = this.formatSecondsAsMmSs(element.breakSecondsLeft ?? 0);
      const item = new vscode.TreeItem(`☕ Break: ${timeStr}`, vscode.TreeItemCollapsibleState.None);
      item.id = "kanban-break";
      item.iconPath = new vscode.ThemeIcon("coffee", new vscode.ThemeColor("charts.blue"));
      item.contextValue = "break-status";
      item.command = {
        command: "redmyne.kanban.skipBreak",
        title: "Skip Break",
      };
      const md = new vscode.MarkdownString();
      md.appendMarkdown("**Break time**\n\n");
      md.appendMarkdown(`${timeStr} remaining\n\n`);
      md.appendMarkdown("*Click to skip break*");
      item.tooltip = md;
      return item;
    }

    if (element.type === "status-header") {
      const tasks = this.getTasksForStatus(element.status!);
      const label = this.getStatusLabel(element.status!);
      const collapsed =
        element.status === "done"
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded;

      const item = new vscode.TreeItem(`${label} (${tasks.length})`, collapsed);
      item.id = `kanban-header-${element.status}`; // Stable ID preserves collapse state
      item.iconPath = this.getStatusIcon(element.status!);
      item.contextValue = `status-header-${element.status}`;
      return item;
    }

    if (element.type === "client-folder") {
      const tasks = this.getTasksForStatusAndClient(element.status!, element.clientId!);
      const item = new vscode.TreeItem(
        `${element.clientName} (${tasks.length})`,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.id = `kanban-client-${element.status}-${element.clientId}`;
      item.iconPath = new vscode.ThemeIcon(
        "folder-opened",
        new vscode.ThemeColor("list.highlightForeground")
      );
      item.contextValue = `client-folder-${element.status}`;
      return item;
    }

    if (element.type === "project-folder") {
      const tasks = this.getTasksForStatusAndProject(
        element.status!,
        element.projectId!,
        element.clientId
      );
      const item = new vscode.TreeItem(
        `${element.projectName} (${tasks.length})`,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.id = `kanban-project-${element.status}-${element.projectId}`;
      item.iconPath = new vscode.ThemeIcon(
        "folder-opened",
        new vscode.ThemeColor("list.highlightForeground")
      );
      item.contextValue = `project-folder-${element.status}`;
      return item;
    }

    if (element.type === "task" && element.task) {
      return this.createTaskTreeItem(element.task);
    }

    return new vscode.TreeItem("");
  }

  private createTaskTreeItem(task: KanbanTask): vscode.TreeItem {
    const status = getTaskStatus(task);
    const item = new vscode.TreeItem(task.title);
    item.id = `kanban-task-${task.id}`; // Stable ID preserves state across refresh

    // Icon based on timer phase, then priority/status
    if (task.timerPhase === "working") {
      item.iconPath = new vscode.ThemeIcon(
        "pulse",
        new vscode.ThemeColor("charts.green")
      );
    } else if (task.timerPhase === "paused") {
      item.iconPath = new vscode.ThemeIcon(
        "debug-pause",
        new vscode.ThemeColor("charts.yellow")
      );
    } else if (task.timerSecondsLeft !== undefined && task.timerSecondsLeft > 0) {
      // Initialized but not running - show gray clock
      item.iconPath = new vscode.ThemeIcon("clock");
    } else if (status === "done") {
      item.iconPath = new vscode.ThemeIcon(
        "check",
        new vscode.ThemeColor("testing.iconPassed")
      );
    } else {
      item.iconPath = this.getPriorityIcon(task.priority);
    }

    // Description: timer info if active/initialized, else project/hours
    if (task.timerSecondsLeft !== undefined && task.timerSecondsLeft > 0) {
      const timeStr = this.formatSecondsAsMmSs(task.timerSecondsLeft);
      const activityStr = task.activityName ? ` [${task.activityName}]` : "";
      const stateStr = task.timerPhase ? "" : " (ready)";
      item.description = `${timeStr}${activityStr}${stateStr} #${task.linkedIssueId}`;
    } else {
      const hoursStr =
        task.loggedHours > 0 ? ` (${formatHoursAsHHMM(task.loggedHours)} logged)` : "";
      item.description = `#${task.linkedIssueId} ${task.linkedIssueSubject}${hoursStr}`;
    }

    // Context value for menus: task-{status}-{timerPhase?}
    if (task.timerPhase) {
      item.contextValue = `task-${status}-${task.timerPhase}`;
    } else if (task.timerSecondsLeft !== undefined && task.timerSecondsLeft > 0) {
      item.contextValue = `task-${status}-initialized`;
    } else {
      item.contextValue = `task-${status}`;
    }

    // Tooltip
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${task.title}**\n\n`);
    md.appendMarkdown(
      `Linked to: #${task.linkedIssueId} ${task.linkedIssueSubject}\n\n`
    );
    md.appendMarkdown(`Project: ${task.linkedProjectName}\n\n`);
    md.appendMarkdown(`Priority: ${task.priority}\n\n`);
    if (task.timerPhase && task.timerSecondsLeft !== undefined) {
      const timeStr = this.formatSecondsAsMmSs(task.timerSecondsLeft);
      md.appendMarkdown(`Timer: ${timeStr} (${task.timerPhase})\n\n`);
    }
    if (task.activityName) {
      md.appendMarkdown(`Activity: ${task.activityName}\n\n`);
    }
    if (task.description) {
      md.appendMarkdown(`---\n\n${task.description}\n\n`);
    }
    if (task.estimatedHours) {
      md.appendMarkdown(`Estimated: ${formatHoursAsHHMM(task.estimatedHours)}\n\n`);
    }
    if (task.loggedHours > 0) {
      md.appendMarkdown(`Logged: ${formatHoursAsHHMM(task.loggedHours)}\n\n`);
    }
    item.tooltip = md;

    // Command on click: toggle timer for doing tasks, start timer for todo
    if (task.timerPhase === "working") {
      item.command = {
        command: "redmyne.kanban.pauseTimer",
        title: "Pause Timer",
        arguments: [task.id],
      };
    } else if (task.timerPhase === "paused") {
      item.command = {
        command: "redmyne.kanban.resumeTimer",
        title: "Resume Timer",
        arguments: [task.id],
      };
    } else if (status !== "done") {
      item.command = {
        command: "redmyne.kanban.startTimer",
        title: "Start Timer",
        arguments: [task.id],
      };
    }

    return item;
  }

  private formatSecondsAsMmSs(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  getChildren(element?: TaskTreeItem): TaskTreeItem[] {
    // Children of a status header
    if (element?.type === "status-header" && element.status) {
      const tasks = this.getTasksForStatus(element.status);

      // Doing board: flat list (no folders)
      if (element.status === "doing") {
        return this.sortTasks(tasks).map((task) => ({
          type: "task" as const,
          task,
        }));
      }

      // To Do and Done boards: group by client (parent project), then project
      return this.getClientFolders(element.status, tasks);
    }

    // Children of a client folder
    if (element?.type === "client-folder" && element.status && element.clientId !== undefined) {
      const tasks = this.getTasksForStatusAndClient(element.status, element.clientId);
      return this.getProjectFoldersForClient(element.status, element.clientId, tasks);
    }

    // Children of a project folder
    if (element?.type === "project-folder" && element.status && element.projectId) {
      const tasks = this.getTasksForStatusAndProject(element.status, element.projectId, element.clientId);
      return this.sortTasks(tasks).map((task) => ({
        type: "task" as const,
        task,
      }));
    }

    // No children for other elements
    if (element) return [];

    // Root level - always show all 3 columns for drag-drop targets
    const items: TaskTreeItem[] = [];

    // Show break status if on break
    if (this.controller.isOnBreak()) {
      items.push({
        type: "break-status",
        breakSecondsLeft: this.controller.getBreakSecondsLeft(),
      });
    }

    items.push(
      { type: "status-header", status: "done" },
      { type: "status-header", status: "doing" },
      { type: "status-header", status: "todo" },
    );

    return items;
  }

  /**
   * Get client (parent project) folders for a status board.
   * Tasks without a parent project show as project folders directly (no "No Client" wrapper).
   */
  private getClientFolders(status: TaskStatus, tasks: KanbanTask[]): TaskTreeItem[] {
    // Separate tasks with and without parent project
    const tasksWithClient: KanbanTask[] = [];
    const tasksWithoutClient: KanbanTask[] = [];

    for (const task of tasks) {
      if (task.linkedParentProjectId) {
        tasksWithClient.push(task);
      } else {
        tasksWithoutClient.push(task);
      }
    }

    // Group tasks with client by parent project
    const clientMap = new Map<number, { name: string; tasks: KanbanTask[] }>();
    for (const task of tasksWithClient) {
      const clientId = task.linkedParentProjectId!;
      const clientName = task.linkedParentProjectName!;

      const existing = clientMap.get(clientId);
      if (existing) {
        existing.tasks.push(task);
      } else {
        clientMap.set(clientId, { name: clientName, tasks: [task] });
      }
    }

    // Build client folder items (sorted alphabetically)
    const clientFolders: TaskTreeItem[] = Array.from(clientMap.entries())
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([clientId, { name }]) => ({
        type: "client-folder" as const,
        status,
        clientId,
        clientName: name,
      }));

    // Build project folders for tasks without client (sorted alphabetically, after client folders)
    const projectMap = new Map<number, { name: string }>();
    for (const task of tasksWithoutClient) {
      if (!projectMap.has(task.linkedProjectId)) {
        projectMap.set(task.linkedProjectId, { name: task.linkedProjectName });
      }
    }

    const projectFolders: TaskTreeItem[] = Array.from(projectMap.entries())
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([projectId, { name }]) => ({
        type: "project-folder" as const,
        status,
        projectId,
        projectName: name,
      }));

    // Client folders first, then standalone project folders
    return [...clientFolders, ...projectFolders];
  }

  /**
   * Get project folders within a client folder.
   */
  private getProjectFoldersForClient(
    status: TaskStatus,
    clientId: number,
    tasks: KanbanTask[]
  ): TaskTreeItem[] {
    // Group tasks by project
    const projectMap = new Map<number, { name: string; tasks: KanbanTask[] }>();

    for (const task of tasks) {
      const existing = projectMap.get(task.linkedProjectId);
      if (existing) {
        existing.tasks.push(task);
      } else {
        projectMap.set(task.linkedProjectId, {
          name: task.linkedProjectName,
          tasks: [task],
        });
      }
    }

    // Convert to folder items, sorted by project name
    return Array.from(projectMap.entries())
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([projectId, { name }]) => ({
        type: "project-folder" as const,
        status,
        clientId,
        projectId,
        projectName: name,
      }));
  }

  /**
   * Get tasks for a status and client (parent project).
   */
  private getTasksForStatusAndClient(status: TaskStatus, clientId: number): KanbanTask[] {
    return this.getTasksForStatus(status).filter((t) => {
      const taskClientId = t.linkedParentProjectId ?? 0;
      return taskClientId === clientId;
    });
  }

  /**
   * Get tasks for a status, project, and optionally client.
   * When clientId is undefined, returns tasks WITHOUT a parent project.
   * When clientId is set, returns tasks with that parent project.
   */
  private getTasksForStatusAndProject(
    status: TaskStatus,
    projectId: number,
    clientId?: number
  ): KanbanTask[] {
    return this.getTasksForStatus(status).filter((t) => {
      if (t.linkedProjectId !== projectId) return false;
      if (clientId !== undefined) {
        // Under a client folder - match tasks with this parent project
        return t.linkedParentProjectId === clientId;
      }
      // Standalone project folder - only tasks WITHOUT parent project
      return !t.linkedParentProjectId;
    });
  }

  private getTasksForStatus(status: TaskStatus): KanbanTask[] {
    const tasks = this.controller.getTasks();
    let filtered = tasks.filter((t) => getTaskStatus(t) === status);

    // Apply priority filter
    if (this.filterPriority !== "all") {
      filtered = filtered.filter((t) => t.priority === this.filterPriority);
    }

    return filtered;
  }

  /**
   * Sort tasks based on current sort settings.
   */
  private sortTasks(tasks: KanbanTask[]): KanbanTask[] {
    if (this.sortField === "priority") {
      // Use existing priority sort, then apply direction
      const sorted = sortTasksByPriority(tasks);
      return this.sortDirection === "asc" ? sorted.reverse() : sorted;
    }

    // Sort by issue ID
    const sorted = [...tasks].sort((a, b) => a.linkedIssueId - b.linkedIssueId);
    return this.sortDirection === "asc" ? sorted : sorted.reverse();
  }

  private getStatusLabel(status: TaskStatus): string {
    switch (status) {
      case "doing":
        return "Doing";
      case "todo":
        return "To Do";
      case "done":
        return "Done";
    }
  }

  private getStatusIcon(status: TaskStatus): vscode.ThemeIcon {
    switch (status) {
      case "doing":
        return new vscode.ThemeIcon(
          "pulse",
          new vscode.ThemeColor("charts.blue")
        );
      case "todo":
        return new vscode.ThemeIcon("circle-outline");
      case "done":
        return new vscode.ThemeIcon(
          "checklist",
          new vscode.ThemeColor("testing.iconPassed")
        );
    }
  }

  private getPriorityIcon(priority: string): vscode.ThemeIcon {
    switch (priority) {
      case "high":
        return new vscode.ThemeIcon(
          "arrow-up",
          new vscode.ThemeColor("charts.red")
        );
      case "low":
        return new vscode.ThemeIcon(
          "arrow-down",
          new vscode.ThemeColor("charts.gray")
        );
      default:
        return new vscode.ThemeIcon("dash");
    }
  }
}
