/**
 * Error Helpers
 * Shared utilities for error handling
 */

import * as vscode from "vscode";
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
