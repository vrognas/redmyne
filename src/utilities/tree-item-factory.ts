import * as vscode from "vscode";
import { Issue, IssueRelation } from "../redmine/models/issue";
import { RedmineServer } from "../redmine/redmine-server";
import { RedmineProject } from "../redmine/redmine-project";
import { FlexibilityScore } from "./flexibility-calculator";
import { formatHoursAsHHMM } from "./time-input";
import { formatCustomFieldValue } from "./custom-field-formatter";

/**
 * Creates a VS Code TreeItem for displaying a Redmine issue
 * Format: Label="{Subject}", Description="#{id}" (reduced opacity)
 * @param showAssignee If true, show assignee name in description
 */
export function createIssueTreeItem(
  issue: Issue,
  server: RedmineServer | undefined,
  commandName: string,
  showAssignee = false
): vscode.TreeItem {
  const treeItem = new vscode.TreeItem(
    issue.subject,
    vscode.TreeItemCollapsibleState.None
  );

  // Show assignee when viewing all issues
  const assignee = showAssignee && issue.assigned_to?.name;
  treeItem.description = assignee ? `#${issue.id} • ${assignee}` : `#${issue.id}`;

  treeItem.command = {
    command: commandName,
    arguments: [false, { server }, `${issue.id}`],
    title: `Open actions for issue #${issue.id}`,
  };

  return treeItem;
}

/**
 * Status display text for flexibility scores (used in tooltips)
 */
const STATUS_TEXT = {
  completed: "Done",
  "on-track": "On Track",
  "at-risk": "At Risk",
  overbooked: "Overbooked",
} as const;

/**
 * Checks if issue is blocked by another issue
 */
export function isBlocked(issue: Issue): boolean {
  return issue.relations?.some((r) => r.relation_type === "blocked") ?? false;
}

/**
 * Creates an enhanced TreeItem with flexibility score and risk indicators
 * Format: Label="#id Subject", Description="spent/est • days"
 * Status conveyed via icon color, blocked/billable info in tooltip
 * @param showAssignee If true, show assignee name in description
 */
export function createEnhancedIssueTreeItem(
  issue: Issue,
  flexibility: FlexibilityScore | null,
  server: RedmineServer | undefined,
  commandName: string,
  showAssignee = false
): vscode.TreeItem {
  // Label always includes issue ID for scannability
  const treeItem = new vscode.TreeItem(
    `#${issue.id} ${issue.subject}`,
    vscode.TreeItemCollapsibleState.None
  );

  // Build description based on flexibility
  const assignee = showAssignee && issue.assigned_to?.name;

  const spentHours = issue.spent_hours ?? 0;
  const estHours = issue.estimated_hours ?? 0;
  const hasDescription = !!issue.description?.trim();
  const isClosed = issue.status?.is_closed === true;
  const parentSuffix = issue.parent ? "-child" : "-root";

  // Minimal icons: closed = grayed checkmark, open = neutral dot
  if (isClosed) {
    treeItem.iconPath = new vscode.ThemeIcon("pass", new vscode.ThemeColor("list.deemphasizedForeground"));
    treeItem.contextValue = `issue-completed${parentSuffix}`;
  } else {
    treeItem.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("list.deemphasizedForeground"));
    treeItem.contextValue = `issue-active${parentSuffix}`;
  }

  // Build description
  const baseDesc = flexibility
    ? `${formatHoursAsHHMM(spentHours)}/${formatHoursAsHHMM(estHours)} • ${flexibility.daysRemaining}d`
    : `${formatHoursAsHHMM(spentHours)}/${formatHoursAsHHMM(estHours)}`;
  const descIndicator = hasDescription ? " ⋯" : "";
  treeItem.description = assignee ? `${baseDesc} • ${assignee}${descIndicator}` : `${baseDesc}${descIndicator}`;

  // Tooltip: rich if flexibility data available, basic otherwise
  treeItem.tooltip = flexibility
    ? createFlexibilityTooltip(issue, flexibility, server)
    : createBasicTooltip(issue, server);

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
  const statusText = STATUS_TEXT[flexibility.status];
  const spentHours = issue.spent_hours ?? 0;
  const estHours = issue.estimated_hours ?? 0;
  const progress = estHours > 0 ? Math.round((spentHours / estHours) * 100) : 0;

  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = true;

  const subject = issue.subject?.trim();
  const subjectText = subject ? subject : "Unknown";

  md.appendMarkdown(`**#${issue.id}: ${subjectText}**\n\n`);
  md.appendMarkdown(`**Tracker:** ${issue.tracker?.name?.trim() ?? "Unknown"}\n\n`);
  md.appendMarkdown(`**Priority:** ${issue.priority?.name?.trim() ?? "Unknown"}\n\n`);
  md.appendMarkdown(`**Progress:** ${formatHoursAsHHMM(spentHours)} / ${formatHoursAsHHMM(estHours)} (${progress}%)\n\n`);

  if (flexibility.status !== "completed") {
    md.appendMarkdown(`**Days Remaining:** ${flexibility.daysRemaining}\n\n`);
    md.appendMarkdown(`**Hours Remaining:** ${formatHoursAsHHMM(flexibility.hoursRemaining)}\n\n`);
    md.appendMarkdown(
      `**Flexibility:** ${flexibility.remaining >= 0 ? "+" : ""}${flexibility.remaining}%\n\n`
    );
  }

  md.appendMarkdown(`**Status:** ${statusText}\n\n`);

  // Add description if present
  if (issue.description?.trim()) {
    md.appendMarkdown(`---\n\n${issue.description.trim()}\n\n`);
  }

  // Add relations if present
  if (issue.relations && issue.relations.length > 0) {
    const relationsText = formatRelations(issue.relations);
    if (relationsText) {
      md.appendMarkdown(relationsText);
    }
  }

  // Add custom fields if present
  if (issue.custom_fields && issue.custom_fields.length > 0) {
    for (const cf of issue.custom_fields) {
      const val = formatCustomFieldValue(cf.value);
      if (val) {
        md.appendMarkdown("**");
        md.appendText(`${cf.name}:`);
        md.appendMarkdown("** ");
        md.appendText(val);
        md.appendMarkdown("\n\n");
      }
    }
  }

  if (server) {
    const baseUrl = server.options.address;
    md.appendMarkdown(`[Open in Browser](${baseUrl}/issues/${issue.id})`);
  }

  return md;
}

/**
 * Creates basic tooltip for issues without flexibility data
 */
function createBasicTooltip(
  issue: Issue,
  server: RedmineServer | undefined
): vscode.MarkdownString {
  const spentHours = issue.spent_hours ?? 0;
  const estHours = issue.estimated_hours ?? 0;

  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = true;

  const subject = issue.subject?.trim();
  const subjectText = subject ? subject : "Unknown";

  md.appendMarkdown(`**#${issue.id}: ${subjectText}**\n\n`);
  md.appendMarkdown(`**Tracker:** ${issue.tracker?.name?.trim() ?? "Unknown"}\n\n`);
  md.appendMarkdown(`**Priority:** ${issue.priority?.name?.trim() ?? "Unknown"}\n\n`);
  md.appendMarkdown(`**Status:** ${issue.status?.name?.trim() ?? "Unknown"}\n\n`);

  if (issue.due_date) {
    md.appendMarkdown(`**Due Date:** ${issue.due_date}\n\n`);
  }

  if (estHours > 0 || spentHours > 0) {
    md.appendMarkdown(`**Hours:** ${formatHoursAsHHMM(spentHours)} / ${formatHoursAsHHMM(estHours)}\n\n`);
  }

  // Add description if present
  if (issue.description?.trim()) {
    md.appendMarkdown(`---\n\n${issue.description.trim()}\n\n`);
  }

  // Add relations if present
  if (issue.relations && issue.relations.length > 0) {
    const relationsText = formatRelations(issue.relations);
    if (relationsText) {
      md.appendMarkdown(relationsText);
    }
  }

  // Add custom fields if present
  if (issue.custom_fields && issue.custom_fields.length > 0) {
    for (const cf of issue.custom_fields) {
      const val = formatCustomFieldValue(cf.value);
      if (val) {
        md.appendMarkdown("**");
        md.appendText(`${cf.name}:`);
        md.appendMarkdown("** ");
        md.appendText(val);
        md.appendMarkdown("\n\n");
      }
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
    blocked: "Blocked by",
    blocks: "Blocks",
    precedes: "Precedes",
    follows: "Follows",
    relates: "Related to",
    duplicates: "Duplicates",
    duplicated: "Duplicated by",
    copied_to: "Copied to",
    copied_from: "Copied from",
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

/**
 * Creates tooltip for project tree items
 */
export function createProjectTooltip(
  project: RedmineProject,
  server: RedmineServer | undefined
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = true;

  md.appendMarkdown("**");
  md.appendText(`#${project.id} ${project.name}`);
  md.appendMarkdown("**\n\n");

  if (project.description?.trim()) {
    md.appendMarkdown(`${project.description.trim()}\n\n---\n\n`);
  }

  // Non-empty custom fields only
  for (const cf of project.customFields) {
    const val = formatCustomFieldValue(cf.value);
    if (val) {
      md.appendMarkdown("**");
      md.appendText(`${cf.name}:`);
      md.appendMarkdown("** ");
      md.appendText(val);
      md.appendMarkdown("\n\n");
    }
  }

  if (server) {
    md.appendMarkdown(`[Open in Browser](${server.options.address}/projects/${project.identifier})`);
  }
  return md;
}
