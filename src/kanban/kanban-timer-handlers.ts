import * as vscode from "vscode";
import { formatHoursAsHHMM } from "../utilities/time-input";
import { playCompletionSound } from "../utilities/completion-sound";
import { showStatusBarMessage } from "../utilities/status-bar";
import { promptForRequiredCustomFields } from "../utilities/custom-field-picker";
import { confirmLogTimeOnClosedIssue } from "../utilities/closed-issue-guard";
import type { IRedmineServer } from "../redmine/redmine-server-interface";
import type { KanbanTask } from "./kanban-state";
import { KANBAN_TIMER_KEYS, KANBAN_TIMER_DEFAULTS } from "./kanban-state";

type TimerCompletionTask = Pick<KanbanTask, "id" | "title" | "linkedIssueId" | "activityId">;

type TimerController = {
  onTimerComplete: (
    listener: (task: TimerCompletionTask) => void | Promise<void>
  ) => vscode.Disposable;
  onBreakComplete: (
    listener: () => void | Promise<void>
  ) => vscode.Disposable;
  getWorkDurationSeconds: () => number;
  getBreakDurationSeconds: () => number;
  getTaskById: (taskId: string) => KanbanTask | undefined;
  accruePending: (taskId: string, seconds: number) => Promise<void>;
  consumePending: (taskId: string) => Promise<number>;
  keepWorking: (taskId: string) => void;
  addLoggedHours: (taskId: string, hours: number) => Promise<void>;
  markDone: (taskId: string) => Promise<void>;
};

export interface KanbanTimerHandlerDeps {
  controller: TimerController;
  getServer: () => IRedmineServer | undefined;
  globalState: vscode.Memento;
  refreshAfterTimeLog: () => void;
}

export function registerKanbanTimerHandlers(
  deps: KanbanTimerHandlerDeps
): vscode.Disposable[] {
  const timerCompletion = deps.controller.onTimerComplete(async (task) => {
    const server = deps.getServer();
    if (!server) return;

    // Bank the finished work unit on the card immediately — never lost,
    // whatever the user chooses next.
    await deps.controller.accruePending(
      task.id,
      deps.controller.getWorkDurationSeconds()
    );

    const soundEnabled = deps.globalState.get<boolean>(
      KANBAN_TIMER_KEYS.soundEnabled,
      KANBAN_TIMER_DEFAULTS.soundEnabled
    );
    if (soundEnabled) {
      playCompletionSound();
    }

    const action = await vscode.window.showWarningMessage(
      `Timer complete: ${task.title}`,
      { modal: true },
      "Log it",
      "Keep working"
    );

    // Keep working: take the break, then auto-resume the next unit (the break's
    // elapsed time is banked by the controller). No log.
    if (action === "Keep working") {
      deps.controller.keepWorking(task.id);
      showStatusBarMessage(`$(coffee) Break started — still on ${task.title}`, 2000);
      return;
    }

    // Dismissed: leave the accrued time on the Doing card for a later Log it / Transfer.
    if (action !== "Log it") return;

    // Log it bills the card's accrued time plus a full break for this final block.
    const pendingSeconds = deps.controller.getTaskById(task.id)?.pendingSeconds ?? 0;
    const totalSeconds = pendingSeconds + deps.controller.getBreakDurationSeconds();
    const totalHours = Math.round((totalSeconds / 3600) * 100) / 100;
    const formattedTime = formatHoursAsHHMM(totalHours);

    const customFieldResult = await promptForRequiredCustomFields(() =>
      server.getTimeEntryCustomFields()
    );
    if (customFieldResult.cancelled) return; // nothing consumed yet — safe to abort

    const closedConfirmed = await confirmLogTimeOnClosedIssue(
      server,
      task.linkedIssueId
    );
    if (!closedConfirmed) return;

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
      await deps.controller.consumePending(task.id); // clear now that it's logged
      await deps.controller.markDone(task.id);
      showStatusBarMessage(
        `$(check) Logged ${formattedTime} to #${task.linkedIssueId}`,
        2000
      );
      deps.refreshAfterTimeLog();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to log time: ${error}`);
    }
  });

  const breakCompletion = deps.controller.onBreakComplete(async () => {
    const soundEnabled = deps.globalState.get<boolean>(
      KANBAN_TIMER_KEYS.soundEnabled,
      KANBAN_TIMER_DEFAULTS.soundEnabled
    );
    if (soundEnabled) {
      playCompletionSound();
    }
    vscode.window.showInformationMessage("Break over! Back to work.");
  });

  return [timerCompletion, breakCompletion];
}
