/**
 * Draft Mode Status Bar
 * Shows draft mode state and pending count in status bar
 */

import * as vscode from "vscode";
import type { DraftQueue } from "./draft-queue";
import type { DraftModeManager } from "./draft-mode-manager";

export class DraftModeStatusBar implements vscode.Disposable {
  private statusBar: vscode.StatusBarItem;
  private queue: DraftQueue;
  private manager: DraftModeManager;
  private disposables: vscode.Disposable[] = [];

  constructor(queue: DraftQueue, manager: DraftModeManager) {
    this.queue = queue;
    this.manager = manager;

    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100 // Higher priority = more to the left
    );
    this.statusBar.command = "redmyne.reviewDrafts";

    // Subscribe to changes
    this.disposables.push(
      this.queue.onDidChange(() => this.update()),
      this.manager.onDidChangeEnabled(() => this.update())
    );

    this.update();
  }

  update(): void {
    if (!this.manager.isEnabled) {
      this.statusBar.hide();
      return;
    }

    const count = this.queue.count;

    if (count === 0) {
      this.statusBar.text = "$(edit) Draft Mode";
      this.statusBar.backgroundColor = undefined;
      this.statusBar.tooltip = "Draft mode enabled. Changes are queued locally.";
    } else {
      this.statusBar.text = `$(edit) Draft: ${count} pending`;
      this.statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      this.statusBar.tooltip = new vscode.MarkdownString(
        `**Draft Mode**\n\n${count} pending change${count === 1 ? "" : "s"}.\n\nClick to review and apply.`
      );
    }

    this.statusBar.show();
  }

  dispose(): void {
    this.statusBar.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
