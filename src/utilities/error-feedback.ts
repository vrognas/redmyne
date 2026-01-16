import * as vscode from "vscode";

/**
 * Convert unknown error to string message
 */
export const errorToString = (error: unknown): string => {
  if (!error) {
    return "";
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object") {
    return (
      (error as { message?: string })?.message ??
      `Unknown error object (keys: ${Object.keys(error ?? {})}`
    );
  }

  return `Unknown error`;
};

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
 *   { title: "Configure", command: "redmyne.configure" },
 *   { title: "View Docs", command: "redmyne.openDocs" },
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
