import * as vscode from "vscode";
import { BaseStatusBar } from "../shared/base-status-bar";
import { KanbanController } from "./kanban-controller";
import { getTaskStatus, KANBAN_TIMER_KEYS, KANBAN_TIMER_DEFAULTS } from "./kanban-state";
import { formatHoursAsHHMM, formatSecondsAsMMSS } from "../utilities/time-input";

/**
 * Status bar display for Kanban progress and timer
 * Priority 49 (left of workload bar at 50)
 */
export class KanbanStatusBar extends BaseStatusBar {
  constructor(
    private controller: KanbanController,
    private globalState: vscode.Memento
  ) {
    super(vscode.StatusBarAlignment.Left, 0);
    this.item.name = "Redmyne Kanban Timer";
    this.item.command = "redmyne.kanban.toggleTimer";

    // Subscribe to both data mutations and per-second timer ticks.
    this.disposables.push(
      controller.onTasksChange(() => this.update()),
      controller.onTimerTick(() => this.update())
    );

    // Initial render
    this.update();
    this.item.show();
  }

  private update(): void {
    const tasks = this.controller.getTasks();
    const activeTask = this.controller.getActiveTask();
    const isOnBreak = this.controller.isOnBreak();
    const breakSecondsLeft = this.controller.getBreakSecondsLeft();

    // Count tasks by status
    let doingCount = 0;
    let doneCount = 0;
    let totalLoggedHours = 0;
    let totalPendingSeconds = 0;

    for (const task of tasks) {
      const status = getTaskStatus(task);
      if (status === "doing") doingCount++;
      if (status === "done") doneCount++;
      totalLoggedHours += task.loggedHours;
      totalPendingSeconds += task.pendingSeconds ?? 0;
    }

    // Find paused task
    const pausedTask = tasks.find((t) => t.timerPhase === "paused");

    if (isOnBreak) {
      // Show break countdown
      const timeStr = formatSecondsAsMMSS(breakSecondsLeft);
      this.item.text = `$(coffee) ${timeStr} break`;
      this.item.tooltip = this.buildBreakTooltip(doneCount, tasks.length, totalLoggedHours);
      this.item.command = "redmyne.kanban.skipBreak";
    } else if (activeTask) {
      // Show active timer with progress bar
      const secondsLeft = activeTask.timerSecondsLeft ?? 0;
      const totalSeconds = this.controller.getWorkDurationSeconds();
      const timeStr = formatSecondsAsMMSS(secondsLeft);
      const progressBar = this.buildProgressBar(secondsLeft, totalSeconds);
      const pendingStr = totalPendingSeconds > 0 ? ` (+${formatHoursAsHHMM(totalPendingSeconds / 3600)})` : "";
      this.item.text = `$(pulse) ${timeStr} ${progressBar} ${this.truncate(activeTask.title, 100)}${pendingStr}`;
      this.item.tooltip = this.buildWorkingTooltip(activeTask, doneCount, tasks.length, totalLoggedHours, totalPendingSeconds);
      this.item.command = "redmyne.kanban.toggleTimer";
    } else if (pausedTask) {
      // Show paused timer with progress bar
      const secondsLeft = pausedTask.timerSecondsLeft ?? 0;
      const totalSeconds = this.controller.getWorkDurationSeconds();
      const timeStr = formatSecondsAsMMSS(secondsLeft);
      const progressBar = this.buildProgressBar(secondsLeft, totalSeconds);
      this.item.text = `$(debug-pause) ${timeStr} ${progressBar} ${this.truncate(pausedTask.title, 100)}`;
      this.item.tooltip = this.buildPausedTooltip(pausedTask, doneCount, tasks.length, totalLoggedHours);
      this.item.command = "redmyne.kanban.toggleTimer";
    } else if (doingCount > 0) {
      // Show "ready to start" with first doing task
      const doingTask = tasks.find((t) => getTaskStatus(t) === "doing");
      const totalSeconds = this.controller.getWorkDurationSeconds();
      const timeStr = formatSecondsAsMMSS(totalSeconds);
      const progressBar = this.buildProgressBar(totalSeconds, totalSeconds); // Full time left = empty bar
      this.item.text = doingTask
        ? `$(play) ${timeStr} ${progressBar} ${this.truncate(doingTask.title, 100)}`
        : `$(play) Ready (${doneCount}/${tasks.length})`;
      this.item.tooltip = this.buildIdleTooltip(doingTask, doneCount, tasks.length, totalLoggedHours);
      this.item.command = doingTask ? {
        title: "Start Timer",
        command: "redmyne.kanban.startTimer",
        arguments: [doingTask.id],
      } : undefined;
    } else if (tasks.length > 0) {
      // All done or only todo tasks
      this.item.text = `$(check) ${doneCount}/${tasks.length} done`;
      this.item.tooltip = this.buildDoneTooltip(doneCount, tasks.length, totalLoggedHours);
      this.item.command = "redmyne.kanban.add";
    } else {
      // No tasks
      this.item.text = "$(plus) Add task";
      this.item.tooltip = "Click to add a Kanban task";
      this.item.command = "redmyne.kanban.add";
    }
  }

  private truncate(text: string, maxLen: number): string {
    return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
  }

  private buildProgressBar(secondsLeft: number, totalSeconds: number): string {
    const width = this.globalState.get<number>(KANBAN_TIMER_KEYS.progressBarWidth, KANBAN_TIMER_DEFAULTS.progressBarWidth);
    const clampedWidth = Math.max(3, Math.min(100, width));
    const elapsed = totalSeconds - secondsLeft;
    const progress = Math.max(0, Math.min(1, elapsed / totalSeconds));
    // Don't fill last bar until timer completes
    const maxFilled = secondsLeft > 0 ? clampedWidth - 1 : clampedWidth;
    const filled = Math.min(Math.round(progress * clampedWidth), maxFilled);
    const empty = clampedWidth - filled;
    return "▰".repeat(filled) + "▱".repeat(empty);
  }

  private buildBreakTooltip(done: number, total: number, hours: number): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
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
    hours: number,
    pendingSeconds = 0
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.appendMarkdown("**Working** $(pulse)\n\n");
    md.appendMarkdown(`#${task.linkedIssueId} - ${task.linkedIssueSubject}\n\n`);
    if (task.activityName) {
      md.appendMarkdown(`Activity: ${task.activityName}\n\n`);
    }
    md.appendMarkdown("---\n\n");
    md.appendMarkdown(`Progress: ${done}/${total} tasks\n\n`);
    const pendingNote = pendingSeconds > 0 ? ` (+${formatHoursAsHHMM(pendingSeconds / 3600)} pending)` : "";
    md.appendMarkdown(`Logged: ${formatHoursAsHHMM(hours)}${pendingNote}\n\n`);
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
    md.supportThemeIcons = true;
    md.appendMarkdown("**Paused** $(debug-pause)\n\n");
    md.appendMarkdown(`#${task.linkedIssueId} - ${task.linkedIssueSubject}\n\n`);
    md.appendMarkdown(`Remaining: ${formatSecondsAsMMSS(task.timerSecondsLeft ?? 0)}\n\n`);
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
    md.supportThemeIcons = true;
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
    md.supportThemeIcons = true;
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
