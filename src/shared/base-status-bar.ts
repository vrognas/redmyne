import * as vscode from "vscode";

/**
 * Shared base for simple status-bar owners: owns a single StatusBarItem plus a
 * disposables array and one idempotent dispose(). Mirrors BaseTreeProvider.
 *
 * WorkloadStatusBar intentionally opts out — it creates/destroys its item in
 * response to config changes, so it keeps a nullable item of its own.
 */
export abstract class BaseStatusBar implements vscode.Disposable {
  protected readonly item: vscode.StatusBarItem;
  protected readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  constructor(alignment: vscode.StatusBarAlignment, priority: number) {
    this.item = vscode.window.createStatusBarItem(alignment, priority);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.item.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
