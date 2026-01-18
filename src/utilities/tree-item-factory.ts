import * as vscode from "vscode";
import { Issue, IssueRelation } from "../redmine/models/issue";
import { RedmineServer } from "../redmine/redmine-server";
import { RedmineProject } from "../redmine/redmine-project";
import { FlexibilityScore } from "./flexibility-calculator";
import { formatHoursAsHHMM } from "./time-input";
import { formatCustomFieldValue, isCustomFieldMeaningful } from "./custom-field-formatter";

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
 * Compact layout: metadata on one line, clear sections
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

  const subject = issue.subject?.trim() || "Unknown";
  const tracker = issue.tracker?.name?.trim() ?? "Unknown";
  const priority = issue.priority?.name?.trim() ?? "Unknown";

  // Header
  md.appendMarkdown(`**#${issue.id}: ${subject}**\n\n`);

  // Compact metadata line
  md.appendMarkdown(`${tracker} · ${priority} · ${statusText}\n\n`);

  // Progress line
  const progressLine = [`${formatHoursAsHHMM(spentHours)}/${formatHoursAsHHMM(estHours)} (${progress}%)`];
  if (flexibility.status !== "completed") {
    progressLine.push(`${flexibility.daysRemaining}d left`);
  }
  if (issue.due_date) {
    progressLine.push(`due ${issue.due_date}`);
  }
  md.appendMarkdown(`${progressLine.join(" · ")}\n\n`);

  // Description section
  if (issue.description?.trim()) {
    md.appendMarkdown(`---\n\n${issue.description.trim()}\n\n`);
  }

  // Relations section
  if (issue.relations && issue.relations.length > 0) {
    const relationsText = formatRelations(issue.relations);
    if (relationsText) {
      if (!issue.description?.trim()) md.appendMarkdown("---\n\n");
      md.appendMarkdown(relationsText);
    }
  }

  // Custom fields section (only meaningful values)
  const meaningfulFields = issue.custom_fields?.filter(cf => isCustomFieldMeaningful(cf.value)) ?? [];
  if (meaningfulFields.length > 0) {
    md.appendMarkdown("---\n\n");
    for (const cf of meaningfulFields) {
      const val = formatCustomFieldValue(cf.value);
      md.appendMarkdown(`**${cf.name}:** ${val}\n\n`);
    }
  }

  // Browser link
  if (server) {
    md.appendMarkdown(`[Open in Browser](${server.options.address}/issues/${issue.id})`);
  }

  return md;
}

/**
 * Creates basic tooltip for issues without flexibility data
 * Compact layout: metadata on one line, clear sections
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

  const subject = issue.subject?.trim() || "Unknown";
  const tracker = issue.tracker?.name?.trim() ?? "Unknown";
  const priority = issue.priority?.name?.trim() ?? "Unknown";
  const status = issue.status?.name?.trim() ?? "Unknown";

  // Header
  md.appendMarkdown(`**#${issue.id}: ${subject}**\n\n`);

  // Compact metadata line
  md.appendMarkdown(`${tracker} · ${priority} · ${status}\n\n`);

  // Details line (hours and due date if present)
  const details: string[] = [];
  if (estHours > 0 || spentHours > 0) {
    details.push(`${formatHoursAsHHMM(spentHours)}/${formatHoursAsHHMM(estHours)}`);
  }
  if (issue.due_date) {
    details.push(`due ${issue.due_date}`);
  }
  if (details.length > 0) {
    md.appendMarkdown(`${details.join(" · ")}\n\n`);
  }

  // Description section
  if (issue.description?.trim()) {
    md.appendMarkdown(`---\n\n${issue.description.trim()}\n\n`);
  }

  // Relations section
  if (issue.relations && issue.relations.length > 0) {
    const relationsText = formatRelations(issue.relations);
    if (relationsText) {
      if (!issue.description?.trim()) md.appendMarkdown("---\n\n");
      md.appendMarkdown(relationsText);
    }
  }

  // Custom fields section (only meaningful values)
  const meaningfulFields = issue.custom_fields?.filter(cf => isCustomFieldMeaningful(cf.value)) ?? [];
  if (meaningfulFields.length > 0) {
    md.appendMarkdown("---\n\n");
    for (const cf of meaningfulFields) {
      const val = formatCustomFieldValue(cf.value);
      md.appendMarkdown(`**${cf.name}:** ${val}\n\n`);
    }
  }

  // Browser link
  if (server) {
    md.appendMarkdown(`[Open in Browser](${server.options.address}/issues/${issue.id})`);
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
