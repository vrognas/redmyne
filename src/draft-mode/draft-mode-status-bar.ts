/**
 * Draft Mode Status Bar
 * Shows draft mode state and pending count in status bar with pulsing effect
 */

import * as vscode from "vscode";
import type { DraftQueue } from "./draft-queue";
import type { DraftModeManager } from "./draft-mode-manager";

export class DraftModeStatusBar implements vscode.Disposable {
  private statusBar: vscode.StatusBarItem;
  private queue: DraftQueue;
  private manager: DraftModeManager;
  private disposables: vscode.Disposable[] = [];
  private pulseInterval: ReturnType<typeof setInterval> | undefined;
  private pulseState = false; // Toggles for pulse effect

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

  private startPulse(): void {
    if (this.pulseInterval) return; // Already pulsing

    this.pulseInterval = setInterval(() => {
      this.pulseState = !this.pulseState;
      this.renderPulse();
    }, 800); // Toggle every 800ms for noticeable but not annoying pulse
  }

  private stopPulse(): void {
    if (this.pulseInterval) {
      clearInterval(this.pulseInterval);
      this.pulseInterval = undefined;
    }
    this.pulseState = false;
  }

  private renderPulse(): void {
    const count = this.queue.count;

    if (count === 0) {
      // No pending - gentle pulse with sync icon
      const icon = this.pulseState ? "$(sync~spin)" : "$(edit)";
      this.statusBar.text = `${icon} DRAFT MODE`;
      this.statusBar.backgroundColor = this.pulseState
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
    } else {
      // Pending changes - more urgent pulse with error background
      const icon = this.pulseState ? "$(alert)" : "$(edit)";
      const emphasis = this.pulseState ? "⚠️ " : "";
      this.statusBar.text = `${icon} ${emphasis}DRAFT: ${count} pending`;
      this.statusBar.backgroundColor = new vscode.ThemeColor(
        this.pulseState ? "statusBarItem.errorBackground" : "statusBarItem.warningBackground"
      );
    }
  }

  update(): void {
    if (!this.manager.isEnabled) {
      this.stopPulse();
      this.statusBar.hide();
      return;
    }

    const count = this.queue.count;

    // Start pulsing when draft mode is enabled
    this.startPulse();

    // Set tooltip
    if (count === 0) {
      this.statusBar.tooltip = new vscode.MarkdownString(
        "**$(warning) Draft Mode Active**\n\n" +
        "Changes are queued locally and will NOT be sent to the server.\n\n" +
        "Click to review drafts."
      );
    } else {
      this.statusBar.tooltip = new vscode.MarkdownString(
        `**$(warning) Draft Mode Active**\n\n` +
        `**${count}** pending change${count === 1 ? "" : "s"} waiting to be applied.\n\n` +
        `Click to review and apply.`
      );
    }

    // Initial render
    this.renderPulse();
    this.statusBar.show();
  }

  dispose(): void {
    this.stopPulse();
    this.statusBar.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
