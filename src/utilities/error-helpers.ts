/**
 * Error and Progress Helpers
 * Shared utilities for error handling and progress display
 */

import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { errorToString } from "./error-to-string";

/**
 * Show error message with consistent formatting
 */
export function showError(error: unknown, context?: string): void {
  const message = context
    ? `${context}: ${errorToString(error)}`
    : errorToString(error);
  vscode.window.showErrorMessage(message);
}

/**
 * Show progress notification while waiting for server response
 */
export function showServerProgress<T>(
  server: RedmineServer,
  promise: Promise<T>
): void {
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification },
    (progress) => {
      progress.report({
        message: `Waiting for response from ${server.options.url.hostname}...`,
      });
      return promise;
    }
  );
}

/**
 * Execute action with error handling
 * Returns result or undefined if error occurred
 */
export async function withErrorHandler<T>(
  action: () => Promise<T>,
  context: string
): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    showError(error, context);
    return undefined;
  }
}
