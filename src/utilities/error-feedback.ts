import * as vscode from "vscode";

/**
 * Actionable error button definition
 */
export interface ErrorAction {
  /** Button text shown in the error dialog */
  title: string;
  /** VS Code command to execute when clicked */
  command: string;
  /** Optional arguments to pass to the command */
  args?: unknown[];
}

/**
 * Show an error message with optional action buttons
 *
 * When a button is clicked, the associated command is executed.
 * This provides a better UX than plain error messages by offering
 * immediate recovery actions.
 *
 * @example
 * ```ts
 * showActionableError("Redmine not configured", [
 *   { title: "Configure", command: "redmine.configure" },
 *   { title: "View Docs", command: "redmine.openDocs" },
 * ]);
 * ```
 */
export async function showActionableError(
  message: string,
  actions: ErrorAction[] = []
): Promise<void> {
  const titles = actions.map((a) => a.title);
  const selection = await vscode.window.showErrorMessage(message, ...titles);

  if (selection) {
    const action = actions.find((a) => a.title === selection);
    if (action) {
      if (action.args && action.args.length > 0) {
        await vscode.commands.executeCommand(action.command, ...action.args);
      } else {
        await vscode.commands.executeCommand(action.command);
      }
    }
  }
}
