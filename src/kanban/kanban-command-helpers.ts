import * as vscode from "vscode";
import { KanbanController } from "./kanban-controller";
import type { KanbanTask } from "./kanban-state";
import type { IRedmineServer } from "../redmine/redmine-server-interface";
import type { KanbanTreeProvider } from "./kanban-tree-provider";
import { promptForRequiredCustomFields } from "../utilities/custom-field-picker";
import { confirmLogTimeOnClosedIssue } from "../utilities/closed-issue-guard";

/** Shared dependencies passed to every kanban command registrar. */
export interface KanbanCommandDeps {
  context: vscode.ExtensionContext;
  controller: KanbanController;
  getServer: () => IRedmineServer | undefined;
  treeProvider?: KanbanTreeProvider;
}

export interface TaskTreeItem {
  task?: KanbanTask;
}

interface IntegerRangeValidatorOptions {
  min: number;
  max: number;
  minMessage: string;
  maxMessage: string;
  maxInclusive?: boolean;
}

/**
 * Read the task's current timerSecondsLeft from the controller, falling back to
 * the captured snapshot. Avoids computing elapsed time from a stale task object
 * when the timer ticked or state changed while dialogs were open.
 */
export function getFreshTimerSecondsLeft(
  controller: KanbanController,
  task: KanbanTask
): number {
  const current = controller.getTaskById(task.id);
  return current?.timerSecondsLeft ?? task.timerSecondsLeft ?? 0;
}

interface LogTimeFlowArgs {
  server: IRedmineServer;
  controller: KanbanController;
  task: KanbanTask;
  /** Pre-rounded hours to log. */
  roundedHours: number;
  /** Optional YYYY-MM-DD date for the entry; defaults to today when omitted. */
  spentOn?: string;
  /**
   * Optional confirmation prompt shown after custom-field/closed-issue checks
   * but before writing the time entry. Return false to abort silently.
   */
  confirm?: () => Promise<boolean>;
  /** Side effect run after a successful log (e.g. stop/restart timer). */
  onLogged: () => Promise<void>;
  /** Success message shown after onLogged. */
  successMessage: string;
}

/**
 * Shared time-logging flow for kanban timer commands.
 *
 * Owns the common sequence: required-custom-field prompt -> closed-issue
 * confirmation -> optional confirm -> addTimeEntry -> addLoggedHours ->
 * consumePending -> caller side effect -> success message, plus the
 * custom-field-aware error handling. Callers supply the per-site hours, confirm
 * step, post-log side effect, and success message.
 *
 * Pending consumption ordering is preserved exactly: the card's banked seconds
 * are cleared only after a successful addTimeEntry + addLoggedHours.
 *
 * @returns true if the time entry was written, false if the flow was aborted
 *          (cancelled prompt, declined confirmation) or failed.
 */
export async function logTimeFlow({
  server,
  controller,
  task,
  roundedHours,
  spentOn,
  confirm,
  onLogged,
  successMessage,
}: LogTimeFlowArgs): Promise<boolean> {
  // Prompt for required custom fields first
  const { values: customFieldValues, cancelled, prompted } =
    await promptForRequiredCustomFields(() => server.getTimeEntryCustomFields());
  if (cancelled) return false;

  // Confirm if issue is closed
  const closedConfirmed = await confirmLogTimeOnClosedIssue(server, task.linkedIssueId);
  if (!closedConfirmed) return false;

  if (confirm && !(await confirm())) return false;

  try {
    await server.addTimeEntry(
      task.linkedIssueId,
      task.activityId ?? 0,
      roundedHours.toString(),
      task.title,
      spentOn,
      customFieldValues
    );
    await controller.addLoggedHours(task.id, roundedHours);
    await controller.consumePending(task.id); // clear banked time now that it's logged
    await onLogged();
    vscode.window.showInformationMessage(successMessage);
    return true;
  } catch (error) {
    const errorMsg = String(error);
    if (/custom.?field/i.test(errorMsg) && !prompted) {
      vscode.window.showErrorMessage(
        `${errorMsg} - Custom fields API requires admin access.`
      );
    } else {
      vscode.window.showErrorMessage(`Failed to log time: ${error}`);
    }
    return false;
  }
}

export function createIntegerRangeValidator({
  min,
  max,
  minMessage,
  maxMessage,
  maxInclusive = true,
}: IntegerRangeValidatorOptions): (value: string) => string | null {
  return (value: string): string | null => {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed) || parsed < min) return minMessage;

    const exceedsMax = maxInclusive ? parsed > max : parsed >= max;
    if (exceedsMax) return maxMessage;

    return null;
  };
}
