import * as vscode from "vscode";
import { getTaskStatus } from "./kanban-state";
import { pickActivityForProject } from "../utilities/issue-picker";
import { showActionableError } from "../utilities/error-feedback";
import { parseTimeInput, validateTimeInput } from "../utilities/time-input";
import { formatLocalDate } from "../utilities/date-utils";
import { KanbanCommandDeps, TaskTreeItem, getFreshTimerSecondsLeft, logTimeFlow } from "./kanban-command-helpers";

/** Timer, time-logging/banking, transfer, and card-order commands. */
export function registerKanbanTimerCommands(deps: KanbanCommandDeps): vscode.Disposable[] {
  const { controller, getServer } = deps;
  const disposables: vscode.Disposable[] = [];

  // --- Timer Commands ---

  // Start Timer
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.startTimer",
      async (taskId: string | TaskTreeItem) => {
        const id = typeof taskId === "string" ? taskId : taskId?.task?.id;
        if (!id) return;

        const task = controller.getTaskById(id);
        if (!task) return;

        const status = getTaskStatus(task);
        if (status === "done") {
          vscode.window.showInformationMessage("Cannot start timer on done tasks");
          return;
        }

        const server = getServer();
        if (!server) {
          void showActionableError("Redmyne not configured", [
            { title: "Configure", command: "redmyne.configure" },
          ]);
          return;
        }

        // Pick activity for the linked issue's project
        const picked = await pickActivityForProject(
          server,
          task.linkedProjectId,
          "Start Timer",
          `#${task.linkedIssueId}`
        );
        if (!picked) return;

        await controller.startTimer(task.id, picked.activityId, picked.activityName);
      }
    )
  );

  // Pause Timer
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.pauseTimer",
      async (taskId: string | TaskTreeItem) => {
        const id = typeof taskId === "string" ? taskId : taskId?.task?.id;
        if (!id) return;

        await controller.pauseTimer(id);
      }
    )
  );

  // Resume Timer
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.resumeTimer",
      async (taskId: string | TaskTreeItem) => {
        const id = typeof taskId === "string" ? taskId : taskId?.task?.id;
        if (!id) return;

        await controller.resumeTimer(id);
      }
    )
  );

  // Stop Timer
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.stopTimer",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;
        await controller.stopTimer(item.task.id);
      }
    )
  );

  // Move to To Do (clears timer and hours)
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.moveToTodo",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;
        await controller.moveToTodo(item.task.id);
      }
    )
  );

  // Toggle Timer (keyboard shortcut)
  disposables.push(
    vscode.commands.registerCommand("redmyne.kanban.toggleTimer", async () => {
      const active = controller.getActiveTask();
      if (active) {
        await controller.pauseTimer(active.id);
        return;
      }

      // Find first paused task to resume
      const paused = controller.getTasks().find((t) => t.timerPhase === "paused");
      if (paused) {
        await controller.resumeTimer(paused.id);
        return;
      }

      vscode.window.showInformationMessage("No active or paused timer to toggle");
    })
  );

  // Skip Break
  disposables.push(
    vscode.commands.registerCommand("redmyne.kanban.skipBreak", async () => {
      if (!controller.isOnBreak()) {
        vscode.window.showInformationMessage("No break in progress");
        return;
      }
      controller.skipBreak();
    })
  );

  // Log Early (proportional time)
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.logEarly",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;

        const task = item.task;
        if (!task.timerPhase || task.timerSecondsLeft === undefined) {
          vscode.window.showInformationMessage("No active timer to log");
          return;
        }

        const server = getServer();
        if (!server) {
          void showActionableError("Redmyne not configured", [
            { title: "Configure", command: "redmyne.configure" },
          ]);
          return;
        }

        // Elapsed in the current unit plus any time already banked on this card.
        const workDuration = controller.getWorkDurationSeconds();
        const elapsedSeconds =
          workDuration - getFreshTimerSecondsLeft(controller, task);
        const pendingSeconds = controller.getTaskById(task.id)?.pendingSeconds ?? 0;
        const hours = (elapsedSeconds + pendingSeconds) / 3600;

        if (hours < 0.01) {
          vscode.window.showInformationMessage("Not enough time elapsed to log");
          return;
        }

        const roundedHours = Math.round(hours * 100) / 100;
        const pendingNote = pendingSeconds > 0 ? ` (${Math.round(pendingSeconds / 60)} min banked included)` : "";

        // Pause so the controller interval cannot complete the timer and fire
        // onTimerComplete (a second, full-duration log flow) while these dialogs
        // are open. Elapsed was already captured above, so the amount is fixed.
        await controller.pauseTimer(task.id);
        const logged = await logTimeFlow({
          server,
          controller,
          task,
          roundedHours,
          confirm: async () => {
            const choice = await vscode.window.showWarningMessage(
              `Log ${roundedHours}h for #${task.linkedIssueId}?${pendingNote}`,
              { modal: true },
              "Log"
            );
            return choice === "Log";
          },
          onLogged: () => controller.stopTimer(task.id),
          successMessage: `Logged ${roundedHours}h`,
        });
        // On success onLogged stopped the timer; on cancel/failure resume it.
        if (!logged) {
          await controller.resumeTimer(task.id);
        }
      }
    )
  );

  // Bank Time (stop timer, bank elapsed onto this card for a later Log it / Transfer)
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.deferTime",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;

        const task = item.task;
        if (!task.timerPhase || task.timerSecondsLeft === undefined) {
          vscode.window.showInformationMessage("No active timer to bank");
          return;
        }

        // Calculate elapsed time from current timer state (not stale snapshot)
        const workDuration = controller.getWorkDurationSeconds();
        const elapsedSeconds =
          workDuration - getFreshTimerSecondsLeft(controller, task);
        const elapsedMinutes = Math.round(elapsedSeconds / 60);

        if (elapsedMinutes < 1) {
          vscode.window.showInformationMessage("Not enough time elapsed to bank");
          return;
        }

        // Pause so the timer cannot complete (and log full duration) while the
        // confirm dialog is open; resume if the user cancels.
        await controller.pauseTimer(task.id);
        const confirm = await vscode.window.showWarningMessage(
          `Bank ${elapsedMinutes}min on this card?`,
          { modal: true },
          "Bank"
        );
        if (confirm !== "Bank") {
          await controller.resumeTimer(task.id);
          return;
        }

        await controller.accruePending(task.id, elapsedSeconds);
        await controller.stopTimer(task.id);
        vscode.window.showInformationMessage(`Banked ${elapsedMinutes}min on this card`);
      }
    )
  );

  // Log and Continue (log full duration, reset timer)
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.logAndContinue",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;

        const task = item.task;
        // Guard: only operate on the currently-working task. Otherwise
        // startTimer below would steal the real active timer (auto-pausing it).
        const activeTask = controller.getActiveTask();
        if (!activeTask || activeTask.id !== task.id) {
          vscode.window.showInformationMessage(
            "Log and continue only works on the active timer"
          );
          return;
        }

        const server = getServer();
        if (!server) {
          void showActionableError("Redmyne not configured", [
            { title: "Configure", command: "redmyne.configure" },
          ]);
          return;
        }

        // Log the full work unit plus any time already banked on this card.
        const workDuration = controller.getWorkDurationSeconds();
        const pendingSeconds = controller.getTaskById(task.id)?.pendingSeconds ?? 0;
        const hours = (workDuration + pendingSeconds) / 3600;
        const roundedHours = Math.round(hours * 100) / 100;
        const pendingNote = pendingSeconds > 0 ? ` (${Math.round(pendingSeconds / 60)} min banked included)` : "";

        await logTimeFlow({
          server,
          controller,
          task,
          roundedHours,
          // Reset timer to full duration and keep running
          onLogged: () =>
            controller.startTimer(task.id, task.activityId ?? 0, task.activityName ?? "", true),
          successMessage: `Logged ${roundedHours}h, timer restarted${pendingNote}`,
        });
      }
    )
  );

  // Transfer an unlogged Done card to Time Entries (creates the entry, clears the card)
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.transferToTimeEntries",
      async (item: TaskTreeItem) => {
        const task = item?.task;
        if (!task) return;
        if (getTaskStatus(task) !== "done") {
          vscode.window.showErrorMessage("Only Done cards can be transferred");
          return;
        }
        if (task.loggedHours > 0) {
          vscode.window.showErrorMessage("Time already logged on this card");
          return;
        }

        const server = getServer();
        if (!server) {
          void showActionableError("Redmyne not configured", [
            { title: "Configure", command: "redmyne.configure" },
          ]);
          return;
        }

        // Activity: the card's, or pick one when it was never timed.
        let activityId = task.activityId;
        if (!activityId) {
          const picked = await pickActivityForProject(
            server,
            task.linkedProjectId,
            "Transfer to Time Entries",
            `#${task.linkedIssueId}`
          );
          if (!picked) return;
          activityId = picked.activityId;
        }

        // Hours: banked pending, or prompt when nothing was banked.
        const pendingSeconds = task.pendingSeconds ?? 0;
        let roundedHours: number;
        if (pendingSeconds > 0) {
          roundedHours = Math.round((pendingSeconds / 3600) * 100) / 100;
        } else {
          const input = await vscode.window.showInputBox({
            title: "Transfer to Time Entries",
            prompt: `Hours for #${task.linkedIssueId}`,
            placeHolder: "e.g. 1.5, 1:30, 1h 30min",
            validateInput: (v) => validateTimeInput(v),
          });
          if (input === undefined) return;
          const parsed = parseTimeInput(input);
          if (parsed === null) return;
          roundedHours = Math.round(parsed * 100) / 100;
        }

        // Date: the day the card was finished.
        const spentOn = task.completedAt
          ? formatLocalDate(new Date(task.completedAt))
          : formatLocalDate(new Date());

        await logTimeFlow({
          server,
          controller,
          task: { ...task, activityId },
          roundedHours,
          spentOn,
          confirm: async () => {
            const choice = await vscode.window.showWarningMessage(
              `Transfer ${roundedHours}h to #${task.linkedIssueId} on ${spentOn}?`,
              { modal: true },
              "Transfer"
            );
            return choice === "Transfer";
          },
          onLogged: () => controller.deleteTask(task.id),
          successMessage: `Transferred ${roundedHours}h to #${task.linkedIssueId}`,
        });
      }
    )
  );

  // Move Up
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.moveUp",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;
        await controller.moveUp(item.task.id);
      }
    )
  );

  // Move Down
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.moveDown",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;
        await controller.moveDown(item.task.id);
      }
    )
  );

  // Reveal Time Entry (focus My Time Entries view)
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.revealTimeEntry",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;

        // Focus the time entries view and refresh
        await vscode.commands.executeCommand("redmyne-explorer-my-time-entries.focus");
        await vscode.commands.executeCommand("redmyne.refreshTimeEntries");

        vscode.window.showInformationMessage(
          `Look for entries on #${item.task.linkedIssueId}`
        );
      }
    )
  );

  return disposables;
}
