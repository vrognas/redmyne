import * as vscode from "vscode";
import { Issue, IssueRelation } from "../redmine/models/issue";
import type { IRedmineServer } from "../redmine/redmine-server-interface";
import { RedmineProject } from "../redmine/redmine-project";
import { FlexibilityScore } from "./flexibility-calculator";
import { formatHoursAsHHMM } from "./time-input";
import { formatCustomFieldValue } from "./custom-field-formatter";
import { Membership, groupMembersByRole } from "../controllers/domain";
import { escapeMarkdown } from "./markdown-escape";
import { formatIssueLabel } from "./issue-label";
import { normalizeServerUrl } from "./server-url";
import { configuredCommandArgs } from "../commands/configured-command-registrar";
import type { ActionProperties } from "../commands/action-properties";

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
  server: IRedmineServer | undefined,
  commandName: string,
  showAssignee = false
): vscode.TreeItem {
  // Label always includes issue ID for scannability
  const treeItem = new vscode.TreeItem(
    formatIssueLabel(issue),
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
  treeItem.tooltip = createIssueTooltip(issue, server, flexibility);

  treeItem.command = {
    command: commandName,
    arguments: configuredCommandArgs({ server } as ActionProperties, `${issue.id}`),
    title: `Open actions for issue #${issue.id}`,
  };

  return treeItem;
}

/**
 * Appends the non-empty custom-fields section to an issue tooltip.
 * Untrusted: field names and values are server-controlled and escaped.
 */
function appendCustomFields(
  md: vscode.MarkdownString,
  customFields: Issue["custom_fields"]
): void {
  if (!customFields || customFields.length === 0) {
    return;
  }
  md.appendMarkdown("---\n\n");
  for (const cf of customFields) {
    const val = formatCustomFieldValue(cf.value);
    if (val !== "") {
      md.appendMarkdown(`**${escapeMarkdown(cf.name)}:** ${escapeMarkdown(val)}  \n`);
    }
  }
  md.appendMarkdown("\n");
}

/**
 * Appends an "Open in Browser" link to a tooltip.
 * `path` is the trusted, code-built resource path (e.g. `/issues/123`);
 * server address has trailing slashes stripped.
 */
function appendBrowserLink(
  md: vscode.MarkdownString,
  server: IRedmineServer | undefined,
  path: string
): void {
  if (!server) {
    return;
  }
  const base = normalizeServerUrl(server.options.address);
  md.appendMarkdown(`[Open in Browser](${base}${path})`);
}

/**
 * Creates an issue tooltip. With flexibility data it renders the rich
 * Status/Progress/Remaining lines; without it, the basic Status/Hours lines.
 * All other sections (title, metadata, description, relations, custom fields,
 * browser link) are identical between the two variants.
 * Uses tight line breaks within sections, separators between groups.
 */
function createIssueTooltip(
  issue: Issue,
  server: IRedmineServer | undefined,
  flexibility: FlexibilityScore | null
): vscode.MarkdownString {
  const spentHours = issue.spent_hours ?? 0;
  const estHours = issue.estimated_hours ?? 0;

  // Untrusted + no HTML: subject/description/custom fields are
  // server-controlled; with trust, an embedded [x](command:...) link
  // would execute commands from a tooltip.
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;

  const subject = escapeMarkdown(issue.subject?.trim() || "Unknown");

  // Title
  md.appendMarkdown(`**#${issue.id}: ${subject}**\n\n`);

  // Core metadata (tight spacing with soft breaks)
  md.appendMarkdown(`**Tracker:** ${escapeMarkdown(issue.tracker?.name?.trim() ?? "Unknown")}  \n`);
  md.appendMarkdown(`**Priority:** ${escapeMarkdown(issue.priority?.name?.trim() ?? "Unknown")}  \n`);
  if (flexibility) {
    md.appendMarkdown(`**Status:** ${STATUS_TEXT[flexibility.status]}  \n`);
  } else {
    md.appendMarkdown(`**Status:** ${escapeMarkdown(issue.status?.name?.trim() ?? "Unknown")}  \n`);
  }
  // Always surface scheduling dates so it's obvious when an issue is
  // unscheduled (no start/due = it won't appear on the Gantt timeline).
  const dateOrMissing = (d: string | null | undefined): string =>
    d && d.trim() ? d : "_Not set_";
  md.appendMarkdown(`**Start:** ${dateOrMissing(issue.start_date)}  \n`);
  md.appendMarkdown(`**Due:** ${dateOrMissing(issue.due_date)}  \n`);
  if (flexibility) {
    const progress = estHours > 0 ? Math.round((spentHours / estHours) * 100) : 0;
    md.appendMarkdown(`**Progress:** ${formatHoursAsHHMM(spentHours)} / ${formatHoursAsHHMM(estHours)} (${progress}%)`);
    if (flexibility.status !== "completed") {
      md.appendMarkdown(`  \n**Remaining:** ${flexibility.daysRemaining}d · ${formatHoursAsHHMM(flexibility.hoursRemaining)}h`);
    }
  } else if (estHours > 0 || spentHours > 0) {
    md.appendMarkdown(`**Hours:** ${formatHoursAsHHMM(spentHours)} / ${formatHoursAsHHMM(estHours)}`);
  }
  md.appendMarkdown("\n\n");

  // Description section
  if (issue.description?.trim()) {
    md.appendMarkdown(`---\n\n${escapeMarkdown(issue.description.trim())}\n\n`);
  }

  // Relations section
  if (issue.relations && issue.relations.length > 0) {
    const relationsText = formatRelationsCompact(issue.relations);
    if (relationsText) {
      md.appendMarkdown(`---\n\n${relationsText}\n\n`);
    }
  }

  // Custom fields section
  appendCustomFields(md, issue.custom_fields);

  // Browser link
  appendBrowserLink(md, server, `/issues/${issue.id}`);

  return md;
}

/**
 * Format relations with tight spacing (soft breaks)
 */
function formatRelationsCompact(relations: IssueRelation[]): string {
  const groups: Record<string, number[]> = {};

  for (const rel of relations) {
    if (!groups[rel.relation_type]) {
      groups[rel.relation_type] = [];
    }
    groups[rel.relation_type]!.push(rel.issue_to_id);
  }

  const lines: string[] = [];

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
    "blocked", "blocks", "precedes", "follows", "relates",
    "duplicates", "duplicated", "copied_to", "copied_from",
  ];

  for (const type of order) {
    if (groups[type] && groups[type].length > 0) {
      const label = typeLabels[type] || type;
      const ids = groups[type].map((id) => `#${id}`).join(", ");
      lines.push(`**${label}:** ${ids}`);
    }
  }

  return lines.join("  \n"); // Soft breaks between relations
}

/**
 * Creates tooltip for project tree items
 */
export function createProjectTooltip(
  project: RedmineProject,
  server: IRedmineServer | undefined,
  members?: Membership[]
): vscode.MarkdownString {
  // Untrusted + no HTML — server-controlled text must not smuggle
  // command links or markup into the tooltip.
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;

  md.appendMarkdown("**");
  md.appendText(`#${project.id} ${project.name}`);
  md.appendMarkdown("**\n\n");

  if (project.description?.trim()) {
    md.appendMarkdown(`${escapeMarkdown(project.description.trim())}\n\n---\n\n`);
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

  // Members grouped by role
  if (members && members.length > 0) {
    const byRole = groupMembersByRole(members);
    if (byRole.size > 0) {
      md.appendMarkdown("---\n\n");
      for (const [role, names] of byRole) {
        md.appendMarkdown("**");
        md.appendText(`${role}:`);
        md.appendMarkdown("** ");
        md.appendText(names.join(", "));
        md.appendMarkdown("\n\n");
      }
    }
  }

  appendBrowserLink(md, server, `/projects/${project.identifier}`);
  return md;
}
