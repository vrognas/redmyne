import * as vscode from "vscode";
import { Issue, IssueRelation } from "../redmine/models/issue";
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
  "on-track": { icon: "git-pull-request-draft", color: "testing.iconPassed", text: "On Track" },
  "at-risk": { icon: "warning", color: "list.warningForeground", text: "At Risk" },
  overbooked: { icon: "error", color: "list.errorForeground", text: "Overbooked" },
} as const;

/**
 * Determines if an issue is billable based on tracker name.
 * Currently: tracker name "Task" = billable
 */
function isBillable(issue: Issue): boolean {
  return issue.tracker?.name === "Task";
}

/**
 * Checks if issue is blocked by another issue
 */
function isBlocked(issue: Issue): boolean {
  return issue.relations?.some((r) => r.relation_type === "blocked") ?? false;
}

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
    const blocked = isBlocked(issue);

    // Format: "🚫 #123 10/40h 5d On Track" (with blocked indicator if applicable)
    const blockedPrefix = blocked ? "🚫 " : "";
    treeItem.description =
      `${blockedPrefix}#${issue.id} ${spentHours}/${estHours}h ${flexibility.daysRemaining}d ${config.text}`;

    // Determine icon color: dim non-billable issues
    const iconColor = isBillable(issue)
      ? new vscode.ThemeColor(config.color)
      : new vscode.ThemeColor("list.deemphasizedForeground");

    // ThemeIcon for accessibility
    treeItem.iconPath = new vscode.ThemeIcon(config.icon, iconColor);

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
  md.appendMarkdown(`**Tracker:** ${issue.tracker?.name ?? "Unknown"}\n\n`);
  md.appendMarkdown(`**Progress:** ${spentHours}h / ${estHours}h (${progress}%)\n\n`);

  if (flexibility.status !== "completed") {
    md.appendMarkdown(`**Days Remaining:** ${flexibility.daysRemaining}\n\n`);
    md.appendMarkdown(`**Hours Remaining:** ${flexibility.hoursRemaining}h\n\n`);
    md.appendMarkdown(
      `**Flexibility:** ${flexibility.remaining >= 0 ? "+" : ""}${flexibility.remaining}%\n\n`
    );
  }

  md.appendMarkdown(`**Status:** ${config.text}\n\n`);

  // Add relations if present
  if (issue.relations && issue.relations.length > 0) {
    const relationsText = formatRelations(issue.relations);
    if (relationsText) {
      md.appendMarkdown(relationsText);
    }
  }

  if (server) {
    const baseUrl = server.options.address;
    md.appendMarkdown(`[Open in Browser](${baseUrl}/issues/${issue.id})`);
  }

  return md;
}

/**
 * Format relations for tooltip display
 * Priority order: blocked, blocks, precedes/follows, others
 */
function formatRelations(relations: IssueRelation[]): string {
  const groups: Record<string, number[]> = {};

  for (const rel of relations) {
    if (!groups[rel.relation_type]) {
      groups[rel.relation_type] = [];
    }
    groups[rel.relation_type].push(rel.issue_to_id);
  }

  const lines: string[] = [];

  // Priority order for display
  const typeLabels: Record<string, string> = {
    blocked: "⛔ Blocked by",
    blocks: "▶ Blocks",
    precedes: "⏩ Precedes",
    follows: "⏪ Follows",
    relates: "🔗 Related to",
    duplicates: "📋 Duplicates",
    duplicated: "📋 Duplicated by",
    copied_to: "📄 Copied to",
    copied_from: "📄 Copied from",
  };

  const order = [
    "blocked",
    "blocks",
    "precedes",
    "follows",
    "relates",
    "duplicates",
    "duplicated",
    "copied_to",
    "copied_from",
  ];

  for (const type of order) {
    if (groups[type] && groups[type].length > 0) {
      const label = typeLabels[type] || type;
      const ids = groups[type].map((id) => `#${id}`).join(", ");
      lines.push(`**${label}:** ${ids}\n\n`);
    }
  }

  return lines.join("");
}
