import * as vscode from "vscode";

/**
 * Shared status bar for transient notifications
 * Prevents creating multiple status bar items (spam)
 */
let sharedStatusBar: vscode.StatusBarItem | undefined;
let hideTimeout: ReturnType<typeof setTimeout> | undefined;

/**
 * Show a temporary status bar message
 * Reuses single shared status bar item
 */
export function showStatusBarMessage(
  text: string,
  durationMs: number = 3000
): void {
  // Create shared status bar if not exists
  if (!sharedStatusBar) {
    sharedStatusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100 // High priority to appear consistently
    );
  }

  // Clear any pending hide
  if (hideTimeout) {
    clearTimeout(hideTimeout);
  }

  // Show message
  sharedStatusBar.text = text;
  sharedStatusBar.show();

  // Schedule hide
  hideTimeout = setTimeout(() => {
    sharedStatusBar?.hide();
  }, durationMs);
}

/**
 * Dispose the shared status bar (call on extension deactivation)
 */
export function disposeStatusBar(): void {
  if (hideTimeout) {
    clearTimeout(hideTimeout);
  }
  sharedStatusBar?.dispose();
  sharedStatusBar = undefined;
}
