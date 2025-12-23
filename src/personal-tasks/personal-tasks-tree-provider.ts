import * as vscode from "vscode";
import { PersonalTaskController } from "./personal-task-controller";
import {
  PersonalTask,
  TaskStatus,
  getTaskStatus,
  groupTasksByStatus,
  sortTasksByPriority,
} from "./personal-task-state";
import { formatHoursAsHHMM } from "../utilities/time-input";

type TaskTreeItemType = "add-button" | "status-header" | "task";

interface TaskTreeItem {
  type: TaskTreeItemType;
  status?: TaskStatus;
  task?: PersonalTask;
}

/**
 * Tree provider for "Personal Tasks" view
 */
export class PersonalTasksTreeProvider
  implements vscode.TreeDataProvider<TaskTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    TaskTreeItem | undefined | null
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private disposables: vscode.Disposable[] = [];

  constructor(private controller: PersonalTaskController) {
    this.disposables.push(controller.onTasksChange(() => this.refresh()));
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onDidChangeTreeData.dispose();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    if (element.type === "add-button") {
      const item = new vscode.TreeItem("Add task...");
      item.iconPath = new vscode.ThemeIcon("add");
      item.command = {
        command: "redmine.personalTasks.add",
        title: "Add Task",
      };
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
      item.iconPath = this.getStatusIcon(element.status!);
      item.contextValue = `status-header-${element.status}`;
      return item;
    }

    if (element.type === "task" && element.task) {
      return this.createTaskTreeItem(element.task);
    }

    return new vscode.TreeItem("");
  }

  private createTaskTreeItem(task: PersonalTask): vscode.TreeItem {
    const status = getTaskStatus(task);
    const item = new vscode.TreeItem(task.title);

    // Icon based on priority and status
    if (status === "done") {
      item.iconPath = new vscode.ThemeIcon(
        "check",
        new vscode.ThemeColor("testing.iconPassed")
      );
    } else {
      item.iconPath = this.getPriorityIcon(task.priority);
    }

    // Description: "#ID Project (Xh logged)"
    const hoursStr =
      task.loggedHours > 0 ? ` (${formatHoursAsHHMM(task.loggedHours)} logged)` : "";
    item.description = `#${task.linkedIssueId} ${task.linkedProjectName}${hoursStr}`;

    // Context value for menus
    item.contextValue = `task-${status}`;

    // Tooltip
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${task.title}**\n\n`);
    md.appendMarkdown(
      `Linked to: #${task.linkedIssueId} ${task.linkedIssueSubject}\n\n`
    );
    md.appendMarkdown(`Project: ${task.linkedProjectName}\n\n`);
    md.appendMarkdown(`Priority: ${task.priority}\n\n`);
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

    // Command to add to Today's Plan on click
    item.command = {
      command: "redmine.personalTasks.addToPlan",
      title: "Add to Today's Plan",
      arguments: [task.id],
    };

    return item;
  }

  getChildren(element?: TaskTreeItem): TaskTreeItem[] {
    // Children of a status header
    if (element?.type === "status-header" && element.status) {
      const tasks = this.getTasksForStatus(element.status);
      return sortTasksByPriority(tasks).map((task) => ({
        type: "task" as const,
        task,
      }));
    }

    // No children for other elements
    if (element) return [];

    // Root level
    const tasks = this.controller.getTasks();
    const grouped = groupTasksByStatus(tasks);

    const items: TaskTreeItem[] = [];

    // Add button first
    items.push({ type: "add-button" });

    // In Progress header (if any)
    if (grouped.inProgress.length > 0) {
      items.push({ type: "status-header", status: "in-progress" });
    }

    // To Do header (if any)
    if (grouped.todo.length > 0) {
      items.push({ type: "status-header", status: "todo" });
    }

    // Done header (if any)
    if (grouped.done.length > 0) {
      items.push({ type: "status-header", status: "done" });
    }

    return items;
  }

  private getTasksForStatus(status: TaskStatus): PersonalTask[] {
    const tasks = this.controller.getTasks();
    return tasks.filter((t) => getTaskStatus(t) === status);
  }

  private getStatusLabel(status: TaskStatus): string {
    switch (status) {
      case "in-progress":
        return "In Progress";
      case "todo":
        return "To Do";
      case "done":
        return "Done";
    }
  }

  private getStatusIcon(status: TaskStatus): vscode.ThemeIcon {
    switch (status) {
      case "in-progress":
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
