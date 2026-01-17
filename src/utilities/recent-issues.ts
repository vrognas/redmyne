import * as vscode from "vscode";

const RECENT_ISSUES_KEY = "recentIssues";
const MAX_RECENT_ISSUES = 20;

interface RecentIssue {
  id: number;
  subject: string;
  projectName: string;
  timestamp: number;
}

let extensionContext: vscode.ExtensionContext | null = null;

/**
 * Initialize the recent issues tracker with extension context
 */
export function initRecentIssues(context: vscode.ExtensionContext): void {
  extensionContext = context;
}

/**
 * Record an issue as recently selected
 */
export function recordRecentIssue(
  issueId: number,
  subject: string,
  projectName: string
): void {
  if (!extensionContext) return;

  const recent = getRecentIssues();

  // Remove existing entry for this issue (if any)
  const filtered = recent.filter(r => r.id !== issueId);

  // Add to front
  filtered.unshift({
    id: issueId,
    subject,
    projectName,
    timestamp: Date.now(),
  });

  // Trim to max size
  const trimmed = filtered.slice(0, MAX_RECENT_ISSUES);

  extensionContext.globalState.update(RECENT_ISSUES_KEY, trimmed);
}

/**
 * Get list of recent issue IDs (most recent first)
 */
export function getRecentIssueIds(): number[] {
  return getRecentIssues().map(r => r.id);
}

/**
 * Get recent issues with metadata
 */
export function getRecentIssues(): RecentIssue[] {
  if (!extensionContext) return [];
  return extensionContext.globalState.get<RecentIssue[]>(RECENT_ISSUES_KEY) ?? [];
}

/**
 * Clear all recent issues
 */
export function clearRecentIssues(): void {
  if (!extensionContext) return;
  extensionContext.globalState.update(RECENT_ISSUES_KEY, []);
}
