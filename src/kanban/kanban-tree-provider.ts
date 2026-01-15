import * as vscode from "vscode";
import { KanbanController } from "./kanban-controller";
import {
  KanbanTask,
  TaskStatus,
  getTaskStatus,
  sortTasksByPriority,
} from "./kanban-state";
import { formatHoursAsHHMM } from "../utilities/time-input";
import { BaseTreeProvider } from "../shared/base-tree-provider";

type TaskTreeItemType = "status-header" | "project-folder" | "task";

export interface TaskTreeItem {
  type: TaskTreeItemType;
  status?: TaskStatus;
  task?: KanbanTask;
  // For project folders
  projectId?: number;
  projectName?: string;
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

  constructor(private controller: KanbanController) {
    super();
    this.disposables.push(controller.onTasksChange(() => this.refresh()));
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

    if (element.type === "project-folder") {
      const tasks = this.getTasksForStatusAndProject(
        element.status!,
        element.projectId!
      );
      const item = new vscode.TreeItem(
        `${element.projectName} (${tasks.length})`,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.id = `kanban-project-${element.status}-${element.projectId}`;
      item.iconPath = new vscode.ThemeIcon("folder");
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
      item.description = `#${task.linkedIssueId} ${task.linkedProjectName}${hoursStr}`;
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
        command: "redmine.kanban.pauseTimer",
        title: "Pause Timer",
        arguments: [task.id],
      };
    } else if (task.timerPhase === "paused") {
      item.command = {
        command: "redmine.kanban.resumeTimer",
        title: "Resume Timer",
        arguments: [task.id],
      };
    } else if (status !== "done") {
      item.command = {
        command: "redmine.kanban.startTimer",
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
        return sortTasksByPriority(tasks).map((task) => ({
          type: "task" as const,
          task,
        }));
      }

      // To Do and Done boards: group by project
      return this.getProjectFolders(element.status, tasks);
    }

    // Children of a project folder
    if (element?.type === "project-folder" && element.status && element.projectId) {
      const tasks = this.getTasksForStatusAndProject(element.status, element.projectId);
      return sortTasksByPriority(tasks).map((task) => ({
        type: "task" as const,
        task,
      }));
    }

    // No children for other elements
    if (element) return [];

    // Root level - always show all 3 columns for drag-drop targets
    return [
      { type: "status-header", status: "doing" },
      { type: "status-header", status: "todo" },
      { type: "status-header", status: "done" },
    ] as TaskTreeItem[];
  }

  private getProjectFolders(status: TaskStatus, tasks: KanbanTask[]): TaskTreeItem[] {
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
        projectId,
        projectName: name,
      }));
  }

  private getTasksForStatusAndProject(status: TaskStatus, projectId: number): KanbanTask[] {
    return this.getTasksForStatus(status).filter(
      (t) => t.linkedProjectId === projectId
    );
  }

  private getTasksForStatus(status: TaskStatus): KanbanTask[] {
    const tasks = this.controller.getTasks();
    return tasks.filter((t) => getTaskStatus(t) === status);
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
