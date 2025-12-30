import * as vscode from "vscode";

/**
 * Tracks which issues are tagged as "ad-hoc budget" pools.
 * Ad-hoc issues can contribute hours to other issues via time entry comments.
 * Persisted in global state.
 */
class AdHocTracker {
  private context: vscode.ExtensionContext | null = null;
  private readonly STORAGE_KEY = "redmine.adHocIssues";

  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  private getAdHocIssues(): Set<number> {
    if (!this.context) return new Set();
    const stored = this.context.globalState.get<number[]>(this.STORAGE_KEY, []);
    return new Set(stored);
  }

  private saveAdHocIssues(issues: Set<number>): void {
    if (!this.context) return;
    this.context.globalState.update(this.STORAGE_KEY, Array.from(issues));
  }

  isAdHoc(issueId: number): boolean {
    return this.getAdHocIssues().has(issueId);
  }

  tag(issueId: number): void {
    const issues = this.getAdHocIssues();
    issues.add(issueId);
    this.saveAdHocIssues(issues);
  }

  untag(issueId: number): void {
    const issues = this.getAdHocIssues();
    issues.delete(issueId);
    this.saveAdHocIssues(issues);
  }

  toggle(issueId: number): boolean {
    if (this.isAdHoc(issueId)) {
      this.untag(issueId);
      return false;
    } else {
      this.tag(issueId);
      return true;
    }
  }

  getAll(): number[] {
    return Array.from(this.getAdHocIssues());
  }
}

export const adHocTracker = new AdHocTracker();
