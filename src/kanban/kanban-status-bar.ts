import * as vscode from "vscode";
import { KanbanController } from "./kanban-controller";
import { getTaskStatus } from "./kanban-state";
import { formatHoursAsHHMM } from "../utilities/time-input";

/**
 * Status bar display for Kanban progress and timer
 * Priority 49 (left of workload bar at 50)
 */
export class KanbanStatusBar {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor(private controller: KanbanController) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      49
    );
    this.statusBarItem.command = "redmyne.kanban.toggleTimer";

    // Subscribe to state changes
    this.disposables.push(
      controller.onTasksChange(() => this.update())
    );

    // Initial render
    this.update();
    this.statusBarItem.show();
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  private update(): void {
    const tasks = this.controller.getTasks();
    const activeTask = this.controller.getActiveTask();
    const isOnBreak = this.controller.isOnBreak();
    const breakSecondsLeft = this.controller.getBreakSecondsLeft();
    const deferredMinutes = this.controller.getDeferredMinutes();

    // Count tasks by status
    let doingCount = 0;
    let doneCount = 0;
    let totalLoggedHours = 0;

    for (const task of tasks) {
      const status = getTaskStatus(task);
      if (status === "doing") doingCount++;
      if (status === "done") doneCount++;
      totalLoggedHours += task.loggedHours;
    }

    // Find paused task
    const pausedTask = tasks.find((t) => t.timerPhase === "paused");

    if (isOnBreak) {
      // Show break countdown
      const timeStr = this.formatSecondsAsMmSs(breakSecondsLeft);
      this.statusBarItem.text = `$(coffee) ${timeStr} break`;
      this.statusBarItem.tooltip = this.buildBreakTooltip(doneCount, tasks.length, totalLoggedHours);
      this.statusBarItem.command = "redmyne.kanban.skipBreak";
    } else if (activeTask) {
      // Show active timer
      const timeStr = this.formatSecondsAsMmSs(activeTask.timerSecondsLeft ?? 0);
      const deferredStr = deferredMinutes > 0 ? ` +${deferredMinutes}m` : "";
      this.statusBarItem.text = `$(pulse) ${timeStr} #${activeTask.linkedIssueId}${deferredStr}`;
      this.statusBarItem.tooltip = this.buildWorkingTooltip(activeTask, doneCount, tasks.length, totalLoggedHours);
      this.statusBarItem.command = "redmyne.kanban.toggleTimer";
    } else if (pausedTask) {
      // Show paused timer
      const timeStr = this.formatSecondsAsMmSs(pausedTask.timerSecondsLeft ?? 0);
      this.statusBarItem.text = `$(debug-pause) ${timeStr} #${pausedTask.linkedIssueId}`;
      this.statusBarItem.tooltip = this.buildPausedTooltip(pausedTask, doneCount, tasks.length, totalLoggedHours);
      this.statusBarItem.command = "redmyne.kanban.toggleTimer";
    } else if (doingCount > 0) {
      // Show "ready to start" with first doing task
      const doingTask = tasks.find((t) => getTaskStatus(t) === "doing");
      this.statusBarItem.text = `$(play) Ready (${doneCount}/${tasks.length})`;
      this.statusBarItem.tooltip = this.buildIdleTooltip(doingTask, doneCount, tasks.length, totalLoggedHours);
      this.statusBarItem.command = doingTask ? {
        title: "Start Timer",
        command: "redmyne.kanban.startTimer",
        arguments: [doingTask.id],
      } : undefined;
    } else if (tasks.length > 0) {
      // All done or only todo tasks
      this.statusBarItem.text = `$(check) ${doneCount}/${tasks.length} done`;
      this.statusBarItem.tooltip = this.buildDoneTooltip(doneCount, tasks.length, totalLoggedHours);
      this.statusBarItem.command = "redmyne.kanban.add";
    } else {
      // No tasks
      this.statusBarItem.text = "$(plus) Add task";
      this.statusBarItem.tooltip = "Click to add a Kanban task";
      this.statusBarItem.command = "redmyne.kanban.add";
    }
  }

  private formatSecondsAsMmSs(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  private buildBreakTooltip(done: number, total: number, hours: number): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown("**Break time** $(coffee)\n\n");
    md.appendMarkdown("Take a moment to rest.\n\n");
    md.appendMarkdown("---\n\n");
    md.appendMarkdown(`Progress: ${done}/${total} tasks\n\n`);
    md.appendMarkdown(`Logged: ${formatHoursAsHHMM(hours)}\n\n`);
    md.appendMarkdown("*Click to skip break*");
    return md;
  }

  private buildWorkingTooltip(
    task: { linkedIssueId: number; linkedIssueSubject: string; activityName?: string; timerSecondsLeft?: number },
    done: number,
    total: number,
    hours: number
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown("**Working** $(pulse)\n\n");
    md.appendMarkdown(`#${task.linkedIssueId} - ${task.linkedIssueSubject}\n\n`);
    if (task.activityName) {
      md.appendMarkdown(`Activity: ${task.activityName}\n\n`);
    }
    md.appendMarkdown("---\n\n");
    md.appendMarkdown(`Progress: ${done}/${total} tasks\n\n`);
    md.appendMarkdown(`Logged: ${formatHoursAsHHMM(hours)}\n\n`);
    md.appendMarkdown("*Click to pause*");
    return md;
  }

  private buildPausedTooltip(
    task: { linkedIssueId: number; linkedIssueSubject: string; timerSecondsLeft?: number },
    done: number,
    total: number,
    hours: number
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown("**Paused** $(debug-pause)\n\n");
    md.appendMarkdown(`#${task.linkedIssueId} - ${task.linkedIssueSubject}\n\n`);
    md.appendMarkdown(`Remaining: ${this.formatSecondsAsMmSs(task.timerSecondsLeft ?? 0)}\n\n`);
    md.appendMarkdown("---\n\n");
    md.appendMarkdown(`Progress: ${done}/${total} tasks\n\n`);
    md.appendMarkdown(`Logged: ${formatHoursAsHHMM(hours)}\n\n`);
    md.appendMarkdown("*Click to resume*");
    return md;
  }

  private buildIdleTooltip(
    task: { linkedIssueId: number; linkedIssueSubject: string } | undefined,
    done: number,
    total: number,
    hours: number
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown("**Ready to start**\n\n");
    if (task) {
      md.appendMarkdown(`Next: #${task.linkedIssueId} - ${task.linkedIssueSubject}\n\n`);
    }
    md.appendMarkdown("---\n\n");
    md.appendMarkdown(`Progress: ${done}/${total} tasks\n\n`);
    md.appendMarkdown(`Logged: ${formatHoursAsHHMM(hours)}\n\n`);
    md.appendMarkdown("*Click to start timer*");
    return md;
  }

  private buildDoneTooltip(done: number, total: number, hours: number): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    if (done === total && total > 0) {
      md.appendMarkdown("**All done!** $(check)\n\n");
    } else {
      md.appendMarkdown("**No tasks in Doing**\n\n");
    }
    md.appendMarkdown(`Progress: ${done}/${total} tasks\n\n`);
    md.appendMarkdown(`Logged: ${formatHoursAsHHMM(hours)}\n\n`);
    md.appendMarkdown("*Click to add task*");
    return md;
  }
}
