/**
 * Draft Mode Status Bar
 * Shows when draft mode is active using theme-aware prominent styling
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
      100
    );
    this.statusBar.command = "redmyne.reviewDrafts";
    this.statusBar.name = "Redmyne Draft Mode";
    this.statusBar.text = "$(edit) Redmine Draft Mode";
    this.statusBar.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    this.statusBar.color = new vscode.ThemeColor(
      "statusBarItem.warningForeground"
    );

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
      this.statusBar.tooltip = new vscode.MarkdownString(
        "**Draft Mode Active**\n\n" +
        "Changes will be queued locally.\n\n" +
        "_Click to review_"
      );
    } else {
      this.statusBar.tooltip = new vscode.MarkdownString(
        `**Draft Mode Active**\n\n` +
        `**${count}** pending change${count === 1 ? "" : "s"}\n\n` +
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
