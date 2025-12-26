import * as vscode from "vscode";

/**
 * Tracks which issues have auto-update %done enabled (opt-in per issue)
 * Persisted in workspace state
 */
class AutoUpdateTracker {
  private context: vscode.ExtensionContext | null = null;
  private readonly STORAGE_KEY = "redmine.autoUpdateEnabledIssues";

  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  private getEnabledIssues(): Set<number> {
    if (!this.context) return new Set();
    const stored = this.context.globalState.get<number[]>(this.STORAGE_KEY, []);
    return new Set(stored);
  }

  private saveEnabledIssues(issues: Set<number>): void {
    if (!this.context) return;
    this.context.globalState.update(this.STORAGE_KEY, Array.from(issues));
  }

  isEnabled(issueId: number): boolean {
    return this.getEnabledIssues().has(issueId);
  }

  enable(issueId: number): void {
    const issues = this.getEnabledIssues();
    issues.add(issueId);
    this.saveEnabledIssues(issues);
  }

  disable(issueId: number): void {
    const issues = this.getEnabledIssues();
    issues.delete(issueId);
    this.saveEnabledIssues(issues);
  }

  toggle(issueId: number): boolean {
    if (this.isEnabled(issueId)) {
      this.disable(issueId);
      return false;
    } else {
      this.enable(issueId);
      return true;
    }
  }
}

export const autoUpdateTracker = new AutoUpdateTracker();
