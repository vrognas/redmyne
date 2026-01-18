/**
 * Draft Mode Status Bar
 * Shows draft mode state with subtle pulsating indicator
 *
 * Design principles:
 * - Solid background color for persistent awareness
 * - Subtle pulse (breathing dot) when draft mode active with no pending
 * - Spinning icon when changes pending (meaningful motion)
 * - Slow rhythm (~1.5s) for organic, non-jarring feel
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
  private pulsePhase = 0; // 0, 1, 2 for subtle 3-phase pulse

  constructor(queue: DraftQueue, manager: DraftModeManager) {
    this.queue = queue;
    this.manager = manager;

    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBar.command = "redmyne.reviewDrafts";
    this.statusBar.name = "Redmyne Draft Mode";

    this.disposables.push(
      this.queue.onDidChange(() => this.update()),
      this.manager.onDidChangeEnabled(() => this.update())
    );

    this.update();
  }

  private startPulse(): void {
    if (this.pulseInterval) return;

    // 3-phase pulse: dot appears, stays, fades - creates breathing effect
    this.pulseInterval = setInterval(() => {
      this.pulsePhase = (this.pulsePhase + 1) % 3;
      this.render();
    }, 600); // 600ms × 3 phases = 1.8s full cycle
  }

  private stopPulse(): void {
    if (this.pulseInterval) {
      clearInterval(this.pulseInterval);
      this.pulseInterval = undefined;
    }
    this.pulsePhase = 0;
  }

  private getPulseIndicator(): string {
    // Subtle 3-phase breathing: nothing → small → large → nothing
    const indicators = ["", " ·", " ●"];
    return indicators[this.pulsePhase];
  }

  private render(): void {
    const count = this.queue.count;

    if (count === 0) {
      // Draft mode on, nothing pending - subtle breathing pulse
      const pulse = this.getPulseIndicator();
      this.statusBar.text = `$(edit) DRAFT${pulse}`;
      this.statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
    } else {
      // Pending changes - spin provides motion, no extra pulse needed
      this.statusBar.text = `$(sync~spin) DRAFT · ${count}`;
      this.statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
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

    // Pulse only when no pending changes (spin handles pending state)
    if (count === 0) {
      this.startPulse();
    } else {
      this.stopPulse();
    }

    // Set tooltip
    if (count === 0) {
      this.statusBar.tooltip = new vscode.MarkdownString(
        "**Draft Mode Active**\n\n" +
        "Changes will be queued locally.\n\n" +
        "_Click to review drafts_"
      );
    } else {
      this.statusBar.tooltip = new vscode.MarkdownString(
        `**Draft Mode Active**\n\n` +
        `**${count}** unsaved change${count === 1 ? "" : "s"}\n\n` +
        `_Click to review and apply_`
      );
    }

    this.render();
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
