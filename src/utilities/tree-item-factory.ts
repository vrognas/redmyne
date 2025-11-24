import * as vscode from "vscode";
import { Issue } from "../redmine/models/issue";
import { RedmineServer } from "../redmine/redmine-server";
import { FlexibilityScore } from "./flexibility-calculator";

/**
 * Creates a VS Code TreeItem for displaying a Redmine issue
 * Format: Label="{Subject}", Description="#{id}" (reduced opacity)
 */
export function createIssueTreeItem(
  issue: Issue,
  server: RedmineServer | undefined,
  commandName: string
): vscode.TreeItem {
  const treeItem = new vscode.TreeItem(
    issue.subject,
    vscode.TreeItemCollapsibleState.None
  );
  treeItem.description = `#${issue.id}`;

  treeItem.command = {
    command: commandName,
    arguments: [false, { server }, `${issue.id}`],
    title: `Open actions for issue #${issue.id}`,
  };

  return treeItem;
}

/**
 * Status display text and icons for flexibility scores
 */
const STATUS_CONFIG = {
  completed: { icon: "pass", color: "testing.iconPassed", text: "Done" },
  "on-track": { icon: "map", color: "testing.iconPassed", text: "On Track" },
  "at-risk": { icon: "warning", color: "list.warningForeground", text: "At Risk" },
  overbooked: { icon: "error", color: "list.errorForeground", text: "Overbooked" },
} as const;

/**
 * Creates an enhanced TreeItem with flexibility score and risk indicators
 * Format: Label="{Subject}", Description="#id spent/est days status"
 */
export function createEnhancedIssueTreeItem(
  issue: Issue,
  flexibility: FlexibilityScore | null,
  server: RedmineServer | undefined,
  commandName: string
): vscode.TreeItem {
  const treeItem = new vscode.TreeItem(
    issue.subject,
    vscode.TreeItemCollapsibleState.None
  );

  // Build description based on flexibility
  if (flexibility) {
    const config = STATUS_CONFIG[flexibility.status];
    const spentHours = issue.spent_hours ?? 0;
    const estHours = issue.estimated_hours ?? 0;

    // Format: "#123 10/40h 5d On Track"
    treeItem.description =
      `#${issue.id} ${spentHours}/${estHours}h ${flexibility.daysRemaining}d ${config.text}`;

    // ThemeIcon for accessibility
    treeItem.iconPath = new vscode.ThemeIcon(
      config.icon,
      new vscode.ThemeColor(config.color)
    );

    // Rich tooltip with full details
    treeItem.tooltip = createFlexibilityTooltip(issue, flexibility, server);

    // Context value for menus
    treeItem.contextValue =
      flexibility.status === "completed" ? "issue-completed" : "issue-active";
  } else {
    // Fallback for issues without flexibility data
    treeItem.description = `#${issue.id}`;
    treeItem.contextValue = "issue";
  }

  treeItem.command = {
    command: commandName,
    arguments: [false, { server }, `${issue.id}`],
    title: `Open actions for issue #${issue.id}`,
  };

  return treeItem;
}

/**
 * Creates rich tooltip with flexibility details
 */
function createFlexibilityTooltip(
  issue: Issue,
  flexibility: FlexibilityScore,
  server: RedmineServer | undefined
): vscode.MarkdownString {
  const config = STATUS_CONFIG[flexibility.status];
  const spentHours = issue.spent_hours ?? 0;
  const estHours = issue.estimated_hours ?? 0;
  const progress = estHours > 0 ? Math.round((spentHours / estHours) * 100) : 0;

  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = true;

  md.appendMarkdown(`**#${issue.id}: ${issue.subject}**\n\n`);
  md.appendMarkdown(`**Progress:** ${spentHours}h / ${estHours}h (${progress}%)\n\n`);

  if (flexibility.status !== "completed") {
    md.appendMarkdown(`**Days Remaining:** ${flexibility.daysRemaining}\n\n`);
    md.appendMarkdown(`**Hours Remaining:** ${flexibility.hoursRemaining}h\n\n`);
    md.appendMarkdown(
      `**Flexibility:** ${flexibility.remaining >= 0 ? "+" : ""}${flexibility.remaining}%\n\n`
    );
  }

  md.appendMarkdown(`**Status:** ${config.text}\n\n`);

  if (server) {
    const baseUrl = server.options.address;
    md.appendMarkdown(`[Open in Browser](${baseUrl}/issues/${issue.id})`);
  }

  return md;
}
