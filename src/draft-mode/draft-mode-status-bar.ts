/**
 * Draft Mode Status Bar
 * Shows when draft mode is active using theme-aware prominent styling
 */

import * as vscode from "vscode";
import { BaseStatusBar } from "../shared/base-status-bar";
import type { DraftQueue } from "./draft-queue";
import type { DraftModeManager } from "./draft-mode-manager";

export class DraftModeStatusBar extends BaseStatusBar {
  private queue: DraftQueue;
  private manager: DraftModeManager;

  constructor(queue: DraftQueue, manager: DraftModeManager) {
    super(vscode.StatusBarAlignment.Left, 100);
    this.queue = queue;
    this.manager = manager;

    this.item.command = "redmyne.reviewDrafts";
    this.item.name = "Redmyne Draft Mode";
    this.item.text = "$(edit) Redmine Draft Mode";
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    this.item.color = new vscode.ThemeColor(
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
      this.item.hide();
      return;
    }

    const count = this.queue.count;

    if (count === 0) {
      const md = new vscode.MarkdownString(
        "**Draft Mode Active**\n\n" +
        "Changes will be queued locally.\n\n" +
        "_Click to review_"
      );
      md.supportThemeIcons = true;
      this.item.tooltip = md;
    } else {
      const md = new vscode.MarkdownString(
        `**Draft Mode Active**\n\n` +
        `**${count}** pending change${count === 1 ? "" : "s"}\n\n` +
        `_Click to review and apply_`
      );
      md.supportThemeIcons = true;
      this.item.tooltip = md;
    }

    this.item.show();
  }
}
