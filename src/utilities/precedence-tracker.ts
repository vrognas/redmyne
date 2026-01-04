/**
 * Precedence priority tracker - tags issues that should be scheduled before all others.
 * Stored locally in VS Code globalState (not synced to Redmine).
 */

import * as vscode from "vscode";

const STORAGE_KEY = "redmine.precedenceIssues";

/**
 * Get all issue IDs tagged with precedence priority
 */
export function getPrecedenceIssues(globalState: vscode.Memento): Set<number> {
  const stored = globalState.get<number[]>(STORAGE_KEY, []);
  return new Set(stored);
}

/**
 * Check if an issue has precedence priority
 */
export function hasPrecedence(globalState: vscode.Memento, issueId: number): boolean {
  return getPrecedenceIssues(globalState).has(issueId);
}

/**
 * Set precedence priority for an issue
 */
export async function setPrecedence(globalState: vscode.Memento, issueId: number): Promise<void> {
  const issues = getPrecedenceIssues(globalState);
  issues.add(issueId);
  await globalState.update(STORAGE_KEY, Array.from(issues));
}

/**
 * Remove precedence priority from an issue
 */
export async function clearPrecedence(globalState: vscode.Memento, issueId: number): Promise<void> {
  const issues = getPrecedenceIssues(globalState);
  issues.delete(issueId);
  await globalState.update(STORAGE_KEY, Array.from(issues));
}

/**
 * Toggle precedence priority for an issue
 * Returns true if precedence is now set, false if cleared
 */
export async function togglePrecedence(globalState: vscode.Memento, issueId: number): Promise<boolean> {
  if (hasPrecedence(globalState, issueId)) {
    await clearPrecedence(globalState, issueId);
    return false;
  } else {
    await setPrecedence(globalState, issueId);
    return true;
  }
}
