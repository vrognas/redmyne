import * as vscode from "vscode";
import { formatHoursAsHHMM } from "../utilities/time-input";
import { playCompletionSound } from "../utilities/completion-sound";
import { showStatusBarMessage } from "../utilities/status-bar";
import { promptForRequiredCustomFields } from "../utilities/custom-field-picker";
import { confirmLogTimeOnClosedIssue } from "../utilities/closed-issue-guard";
import type { RedmineServer } from "../redmine/redmine-server";
import type { KanbanTask } from "./kanban-state";

type TimerCompletionTask = Pick<KanbanTask, "id" | "title" | "linkedIssueId" | "activityId">;

type TimerController = {
  onTimerComplete: (
    listener: (task: TimerCompletionTask) => void | Promise<void>
  ) => vscode.Disposable;
  onBreakComplete: (
    listener: () => void | Promise<void>
  ) => vscode.Disposable;
  getWorkDurationSeconds: () => number;
  addLoggedHours: (taskId: string, hours: number) => Promise<void>;
  markDone: (taskId: string) => Promise<void>;
  resetTimer: (taskId: string) => Promise<void>;
  startBreak: () => void;
};

export interface KanbanTimerHandlerDeps {
  controller: TimerController;
  getServer: () => RedmineServer | undefined;
  globalState: vscode.Memento;
  refreshAfterTimeLog: () => void;
}

export function registerKanbanTimerHandlers(
  deps: KanbanTimerHandlerDeps
): vscode.Disposable[] {
  const timerCompletion = deps.controller.onTimerComplete(async (task) => {
    const server = deps.getServer();
    if (!server) return;

    const soundEnabled = deps.globalState.get<boolean>(
      "redmyne.timer.soundEnabled",
      true
    );
    if (soundEnabled) {
      playCompletionSound();
    }

    const baseMinutes = deps.controller.getWorkDurationSeconds() / 60;
    const totalHours = baseMinutes / 60;
    const formattedTime = formatHoursAsHHMM(totalHours);

    const customFieldResult = await promptForRequiredCustomFields(() =>
      server.getTimeEntryCustomFields()
    );
    if (customFieldResult.cancelled) {
      return;
    }

    const closedConfirmed = await confirmLogTimeOnClosedIssue(
      server,
      task.linkedIssueId
    );
    if (!closedConfirmed) return;

    const action = await vscode.window.showWarningMessage(
      `Timer complete: ${task.title} (${formattedTime})`,
      { modal: true },
      "Log & complete",
      "Log & continue"
    );

    if (action === "Log & complete") {
      try {
        await server.addTimeEntry(
          task.linkedIssueId,
          task.activityId ?? 0,
          totalHours.toString(),
          task.title,
          undefined,
          customFieldResult.values
        );
        await deps.controller.addLoggedHours(task.id, totalHours);
        await deps.controller.markDone(task.id);
        showStatusBarMessage(
          `$(check) Logged ${formattedTime} to #${task.linkedIssueId}`,
          2000
        );
        deps.refreshAfterTimeLog();
        deps.controller.startBreak();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to log time: ${error}`);
      }
    } else if (action === "Log & continue") {
      try {
        await server.addTimeEntry(
          task.linkedIssueId,
          task.activityId ?? 0,
          totalHours.toString(),
          task.title,
          undefined,
          customFieldResult.values
        );
        await deps.controller.addLoggedHours(task.id, totalHours);
        await deps.controller.resetTimer(task.id);
        showStatusBarMessage(
          `$(check) Logged ${formattedTime}, timer reset`,
          2000
        );
        deps.refreshAfterTimeLog();
        deps.controller.startBreak();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to log time: ${error}`);
      }
    }
    // Cancel/close: do nothing, timer stays completed.
  });

  const breakCompletion = deps.controller.onBreakComplete(async () => {
    const soundEnabled = deps.globalState.get<boolean>(
      "redmyne.timer.soundEnabled",
      true
    );
    if (soundEnabled) {
      playCompletionSound();
    }
    vscode.window.showInformationMessage(
      "Break over! Ready to start next task."
    );
  });

  return [timerCompletion, breakCompletion];
}
