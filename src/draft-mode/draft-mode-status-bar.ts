/**
 * Draft Mode Status Bar
 * Shows draft mode state with clear visual differentiation
 *
 * Design principles:
 * - Solid color = persistent awareness without annoyance
 * - Spinning icon only when pending (meaningful motion)
 * - Clean, concise text
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
    this.statusBar.name = "Redmyne Draft Mode";

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
      // Draft mode on, nothing pending - warning level
      this.statusBar.text = "$(edit) DRAFT";
      this.statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      this.statusBar.tooltip = new vscode.MarkdownString(
        "**Draft Mode Active**\n\n" +
        "Changes will be queued locally.\n\n" +
        "_Click to review drafts_"
      );
    } else {
      // Pending changes - error level urgency, spinning to show "waiting to sync"
      this.statusBar.text = `$(sync~spin) DRAFT · ${count}`;
      this.statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
      this.statusBar.tooltip = new vscode.MarkdownString(
        `**Draft Mode Active**\n\n` +
        `**${count}** unsaved change${count === 1 ? "" : "s"}\n\n` +
        `_Click to review and apply_`
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
