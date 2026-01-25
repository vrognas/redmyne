/**
 * Gantt HTML/SVG Generator
 * Stateless rendering functions - all data passed explicitly
 */

import type { GanttRenderContext, GroupRange, AvatarColors } from "./gantt-render-types";
import type { GanttRow, GanttIssue } from "../gantt-model";
import { escapeAttr, escapeHtml } from "../gantt-html-escape";
import { parseLocalDate, formatLocalDate } from "../../utilities/date-utils";
import type { WeeklySchedule } from "../../utilities/flexibility-calculator";

// ============================================================================
// Helper Functions (exported for testing)
// ============================================================================

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const AVATAR_COLOR_COUNT = 12;

/** Extract initials from full name (e.g., "Viktor Rognås" → "VR") */
export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

/** Generate consistent fill + stroke color indices from name (144 unique combos) */
export function getAvatarColorIndices(name: string): AvatarColors {
  let hash1 = 0;
  for (let i = 0; i < name.length; i++) {
    hash1 = name.charCodeAt(i) + ((hash1 << 5) - hash1);
  }
  let hash2 = 0;
  for (let i = name.length - 1; i >= 0; i--) {
    hash2 = name.charCodeAt(i) + ((hash2 << 7) - hash2);
  }
  const fill = Math.abs(hash1) % AVATAR_COLOR_COUNT;
  const stroke = (Math.abs(hash2) + 6) % AVATAR_COLOR_COUNT;
  return { fill, stroke };
}

/** Format decimal hours as HH:MM (rounded up to nearest minute) */
export function formatHoursAsTime(hours: number | null): string {
  if (hours === null) return "—";
  const totalMinutes = Math.ceil(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${m.toString().padStart(2, "0")}`;
}

/** Format name as "Firstname L." for compact display */
export function formatShortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return name;
  const firstName = parts[0];
  const lastInitial = parts[parts.length - 1][0];
  return `${firstName} ${lastInitial}.`;
}

/** Format date with weekday suffix */
function formatDateWithWeekday(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return `${dateStr} (${WEEKDAYS[d.getUTCDay()]})`;
}

/** Get day name key for WeeklySchedule lookup */
function getDayKey(date: Date): keyof WeeklySchedule {
  const keys: (keyof WeeklySchedule)[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return keys[date.getDay()];
}

// ============================================================================
// Intensity Calculation
// ============================================================================

/** Calculate daily intensity for an issue (uniform distribution) */
function calculateDailyIntensity(
  issue: GanttIssue,
  schedule: WeeklySchedule
): { dayOffset: number; intensity: number }[] {
  const result: { dayOffset: number; intensity: number }[] = [];

  if (!issue.start_date || !issue.due_date) return result;

  const start = parseLocalDate(issue.start_date);
  const end = parseLocalDate(issue.due_date);
  const estimatedHours = issue.estimated_hours ?? 0;

  let totalAvailable = 0;
  const current = new Date(start);
  while (current <= end) {
    totalAvailable += schedule[getDayKey(current)];
    current.setUTCDate(current.getUTCDate() + 1);
  }

  if (totalAvailable === 0 || estimatedHours === 0) {
    const dayCount = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    for (let i = 0; i < dayCount; i++) {
      result.push({ dayOffset: i, intensity: 0 });
    }
    return result;
  }

  const hoursPerAvailableHour = estimatedHours / totalAvailable;
  current.setTime(start.getTime());
  let dayOffset = 0;
  while (current <= end) {
    const dayHours = schedule[getDayKey(current)];
    const intensity = dayHours > 0 ? hoursPerAvailableHour : 0;
    result.push({ dayOffset, intensity: Math.min(intensity, 1.5) });
    current.setUTCDate(current.getUTCDate() + 1);
    dayOffset++;
  }

  return result;
}

/** Get scheduled intensity from pre-computed schedule map */
function getScheduledIntensity(
  issue: GanttIssue,
  schedule: WeeklySchedule,
  issueScheduleMap: Map<number, Map<string, number>>
): { dayOffset: number; intensity: number }[] {
  const result: { dayOffset: number; intensity: number }[] = [];

  if (!issue.start_date || !issue.due_date) return result;

  const issueHoursMap = issueScheduleMap.get(issue.id);
  const start = parseLocalDate(issue.start_date);
  const end = parseLocalDate(issue.due_date);

  const current = new Date(start);
  let dayOffset = 0;
  while (current <= end) {
    const dateStr = formatLocalDate(current);
    const dayCapacity = schedule[getDayKey(current)];
    const scheduledHours = issueHoursMap?.get(dateStr) ?? 0;
    const intensity = dayCapacity > 0 ? scheduledHours / dayCapacity : 0;
    result.push({ dayOffset, intensity: Math.min(intensity, 1.5) });
    current.setDate(current.getDate() + 1);
    dayOffset++;
  }

  return result;
}

// ============================================================================
// Label Generation
// ============================================================================

/** Generate SVG for issue label row */
export function generateIssueLabel(
  row: GanttRow,
  _idx: number,
  y: number,
  originalY: number,
  ctx: GanttRenderContext
): string {
  const issue = row.issue!;
  const hiddenAttr = row.isVisible ? "" : ' visibility="hidden"';
  const hiddenClass = row.isVisible ? "" : " gantt-row-hidden";
  const indent = row.depth * ctx.indentSize;
  const textOffset = ctx.chevronWidth;

  const chevron = row.hasChildren
    ? generateChevron(indent, ctx.barHeight, row.isExpanded)
    : "";

  const escapedSubject = escapeHtml(issue.subject);
  const escapedProject = escapeHtml(issue.project);

  // Build tooltip
  const leftEffectiveStatus = issue.isClosed ? "completed" : (issue.status ?? "unknown");
  const leftStatusDesc = ctx.getStatusDescription(leftEffectiveStatus);
  const leftFlexPct = issue.flexibilityPercent;
  const leftFlexText = leftFlexPct === null ? null
    : leftFlexPct > 0 ? `Flexibility: +${leftFlexPct}%`
    : leftFlexPct === 0 ? `Flexibility: 0% (no buffer)`
    : `Flexibility: ${leftFlexPct}%`;

  const tooltipLines = [
    issue.isAdHoc ? "🎲 AD-HOC BUDGET POOL" : null,
    issue.isExternal ? "⚡ EXTERNAL DEPENDENCY" : null,
    leftStatusDesc,
    `#${issue.id} ${escapedSubject}`,
    `Project: ${escapedProject}`,
    issue.isExternal ? `Assigned to: ${issue.assignee ?? "Unassigned"}` : null,
    `Start: ${formatDateWithWeekday(issue.start_date)}`,
    `Due: ${formatDateWithWeekday(issue.due_date)}`,
    `Progress: ${issue.done_ratio ?? 0}%`,
    `Estimated: ${formatHoursAsTime(issue.estimated_hours)}`,
    `Spent: ${formatHoursAsTime(issue.spent_hours)}`,
  ];

  if (leftFlexText) tooltipLines.push(leftFlexText);
  if (issue.blocks.length > 0) {
    tooltipLines.push(`🚧 BLOCKS ${issue.blocks.length} TASK${issue.blocks.length > 1 ? "S" : ""}`);
  }
  if (issue.blockedBy.length > 0) {
    tooltipLines.push(`⛔ BLOCKED BY ${issue.blockedBy.length}`);
  }

  const tooltip = tooltipLines.filter(Boolean).join("\n");

  const projectBadge = ctx.viewFocus === "person" && row.projectName
    ? `<tspan fill="var(--vscode-descriptionForeground)" font-size="10">[${escapeHtml(row.projectName)}]</tspan> `
    : "";
  const externalBadge = issue.isExternal
    ? `<tspan fill="var(--vscode-charts-yellow)" font-size="10">(dep)</tspan> `
    : "";
  const taskOpacity = issue.isClosed ? "0.5" : "1";

  return `
    <g class="issue-label gantt-row cursor-pointer${hiddenClass}" data-issue-id="${issue.id}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-expanded="${row.isExpanded}" data-has-children="${row.hasChildren}" data-original-y="${originalY}" data-tooltip="${escapeAttr(tooltip)}" data-vscode-context='{"webviewSection":"issueBar","issueId":${issue.id},"projectId":${issue.projectId},"hasParent":${issue.parentId !== null},"preventDefaultContextMenuItems":true}' transform="translate(0, ${y})"${hiddenAttr} tabindex="0" role="button" aria-label="Open issue #${issue.id}">
      <rect class="row-hit-area" x="0" y="-1" width="100%" height="${ctx.barHeight + 2}" fill="transparent" pointer-events="all"/>
      ${chevron}
      <text class="issue-text" x="${10 + indent + textOffset}" y="${ctx.barHeight / 2 + 5}" fill="${issue.isExternal ? "var(--vscode-descriptionForeground)" : "var(--vscode-foreground)"}" font-size="13" opacity="${taskOpacity}">
        ${externalBadge}${projectBadge}${escapedSubject}
      </text>
    </g>
  `;
}

/** Generate SVG for project label row */
export function generateProjectLabel(
  row: GanttRow,
  _idx: number,
  y: number,
  originalY: number,
  ctx: GanttRenderContext
): string {
  const hiddenAttr = row.isVisible ? "" : ' visibility="hidden"';
  const hiddenClass = row.isVisible ? "" : " gantt-row-hidden";
  const indent = row.depth * ctx.indentSize;

  const chevron = row.hasChildren
    ? generateChevron(indent, ctx.barHeight, row.isExpanded)
    : "";

  const health = row.health;
  const healthDot = health ? ctx.getHealthDot(health.status) : "";
  const labelX = 10 + indent + ctx.chevronWidth;

  let countsStr = "";
  if (health && health.counts.total > 0) {
    const parts: string[] = [`${health.counts.open} open`];
    if (health.counts.blocked > 0) parts.push(`${health.counts.blocked} blocked`);
    if (health.counts.overdue > 0) parts.push(`${health.counts.overdue} overdue`);
    countsStr = parts.join(" · ");
  }

  const progressBarWidth = 40;
  const progressBarHeight = 4;
  const progressBarX = labelX + escapeHtml(row.label).length * 7 + 24;
  const progressBarY = ctx.barHeight / 2 - progressBarHeight / 2;
  const progressFillWidth = health ? (health.progress / 100) * progressBarWidth : 0;
  const progressBar = health && health.counts.total > 0 ? `
    <rect x="${progressBarX}" y="${progressBarY}" width="${progressBarWidth}" height="${progressBarHeight}" rx="2" fill="var(--vscode-progressBar-background)" opacity="0.3"/>
    <rect x="${progressBarX}" y="${progressBarY}" width="${progressFillWidth}" height="${progressBarHeight}" rx="2" fill="var(--vscode-progressBar-foreground)"/>
    <text x="${progressBarX + progressBarWidth + 4}" y="${ctx.barHeight / 2 + 4}" fill="var(--vscode-descriptionForeground)" font-size="10">${health.progress}%</text>
  ` : "";

  const countsX = progressBarX + progressBarWidth + 30;
  const countsText = countsStr ? `<text x="${countsX}" y="${ctx.barHeight / 2 + 4}" fill="var(--vscode-descriptionForeground)" font-size="10">${countsStr}</text>` : "";

  const tooltip = ctx.buildProjectTooltip(row);

  return `
    <g class="project-label gantt-row cursor-pointer${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-project-id="${row.id}" data-expanded="${row.isExpanded}" data-has-children="${row.hasChildren}" data-original-y="${originalY}" data-tooltip="${escapeAttr(tooltip)}" data-vscode-context='${escapeAttr(JSON.stringify({ webviewSection: "projectLabel", projectId: row.id, projectIdentifier: row.identifier || "", preventDefaultContextMenuItems: true }))}' transform="translate(0, ${y})"${hiddenAttr} tabindex="0" role="button" aria-label="Toggle project ${escapeHtml(row.label)}">
      <rect class="row-hit-area" x="0" y="-1" width="100%" height="${ctx.barHeight + 2}" fill="transparent" pointer-events="all"/>
      ${chevron}
      <text x="${labelX}" y="${ctx.barHeight / 2 + 5}" fill="var(--vscode-descriptionForeground)" font-size="13" pointer-events="none">
        ${healthDot}${escapeHtml(row.label)}
      </text>
      ${progressBar}
      ${countsText}
    </g>
  `;
}

/** Generate SVG for time-group label row */
export function generateTimeGroupLabel(
  row: GanttRow,
  _idx: number,
  y: number,
  originalY: number,
  ctx: GanttRenderContext
): string {
  const hiddenAttr = row.isVisible ? "" : ' visibility="hidden"';
  const hiddenClass = row.isVisible ? "" : " gantt-row-hidden";
  const indent = row.depth * ctx.indentSize;

  const chevron = row.hasChildren
    ? generateChevron(indent, ctx.barHeight, row.isExpanded)
    : "";

  const timeGroupClass = `time-group-${row.timeGroup}`;
  const countBadge = row.childCount ? ` (${row.childCount})` : "";

  return `
    <g class="time-group-label gantt-row ${timeGroupClass}${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-time-group="${row.timeGroup}" data-expanded="${row.isExpanded}" data-has-children="${row.hasChildren}" data-original-y="${originalY}" data-tooltip="${escapeAttr(row.label)}" transform="translate(0, ${y})"${hiddenAttr} tabindex="0" role="button" aria-label="Toggle ${escapeHtml(row.label)}">
      <rect class="row-hit-area" x="0" y="-1" width="100%" height="${ctx.barHeight + 2}" fill="transparent" pointer-events="all"/>
      ${chevron}
      <text x="${10 + indent + ctx.chevronWidth}" y="${ctx.barHeight / 2 + 5}" fill="var(--vscode-foreground)" font-size="13" font-weight="bold" pointer-events="none">
        ${row.icon || ""} ${escapeHtml(row.label)}${countBadge}
      </text>
    </g>
  `;
}

/** Generate chevron SVG */
function generateChevron(indent: number, barHeight: number, isExpanded: boolean): string {
  const chevronX = 10 + indent;
  const chevronY = barHeight / 2;
  const hitAreaSize = 18;
  return `<g class="collapse-toggle user-select-none${isExpanded ? " expanded" : ""}" transform-origin="${chevronX} ${chevronY}"><rect x="${chevronX - hitAreaSize / 2}" y="${chevronY - hitAreaSize / 2}" width="${hitAreaSize}" height="${hitAreaSize}" fill="transparent" class="chevron-hit-area"/><path d="M${chevronX - 3},${chevronY - 4} L${chevronX + 2},${chevronY} L${chevronX - 3},${chevronY + 4}" fill="none" stroke="var(--vscode-foreground)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></g>`;
}

// ============================================================================
// Column Cell Generation
// ============================================================================

/** Generate ID column cell */
export function generateIdCell(
  row: GanttRow,
  y: number,
  originalY: number,
  ctx: GanttRenderContext
): string {
  const hiddenAttr = row.isVisible ? "" : ' visibility="hidden"';
  const hiddenClass = row.isVisible ? "" : " gantt-row-hidden";

  if (row.type !== "issue") {
    return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}></g>`;
  }

  const issue = row.issue!;
  return `<g class="gantt-row cursor-pointer${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr} data-vscode-context='{"webviewSection":"issueIdColumn","issueId":${issue.id},"preventDefaultContextMenuItems":true}'>
    <text class="gantt-col-cell" x="${ctx.idColumnWidth / 2}" y="${ctx.barHeight / 2 + 4}" text-anchor="middle">#${issue.id}</text>
  </g>`;
}

/** Generate start date column cell */
export function generateStartDateCell(
  row: GanttRow,
  y: number,
  originalY: number,
  ctx: GanttRenderContext
): string {
  const hiddenAttr = row.isVisible ? "" : ' visibility="hidden"';
  const hiddenClass = row.isVisible ? "" : " gantt-row-hidden";

  if (row.type !== "issue") {
    return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}></g>`;
  }

  const issue = row.issue!;
  if (!issue.start_date) {
    return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}><text class="gantt-col-cell" x="4" y="${ctx.barHeight / 2 + 4}" text-anchor="start">—</text></g>`;
  }

  const startDate = parseLocalDate(issue.start_date);
  const displayDate = startDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}>
    <title>${escapeAttr(issue.start_date)}</title>
    <text class="gantt-col-cell" x="4" y="${ctx.barHeight / 2 + 4}" text-anchor="start">${displayDate}</text>
  </g>`;
}

/** Generate status column cell */
export function generateStatusCell(
  row: GanttRow,
  y: number,
  originalY: number,
  ctx: GanttRenderContext
): string {
  const hiddenAttr = row.isVisible ? "" : ' visibility="hidden"';
  const hiddenClass = row.isVisible ? "" : " gantt-row-hidden";

  if (row.type !== "issue") {
    return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}></g>`;
  }

  const issue = row.issue!;
  const statusName = issue.statusName ?? "Unknown";

  let dotColor = "var(--vscode-descriptionForeground)";
  if (issue.done_ratio === 100 || issue.isClosed) {
    dotColor = "var(--vscode-charts-green)";
  } else if (issue.done_ratio > 0) {
    dotColor = "var(--vscode-charts-blue)";
  }

  const cx = ctx.statusColumnWidth / 2;
  const cy = ctx.barHeight / 2;

  return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}>
    <title>${escapeAttr(statusName)}</title>
    <circle cx="${cx}" cy="${cy}" r="5" fill="${dotColor}"/>
  </g>`;
}

/** Generate due date column cell */
export function generateDueDateCell(
  row: GanttRow,
  y: number,
  originalY: number,
  ctx: GanttRenderContext
): string {
  const hiddenAttr = row.isVisible ? "" : ' visibility="hidden"';
  const hiddenClass = row.isVisible ? "" : " gantt-row-hidden";

  if (row.type !== "issue") {
    return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}></g>`;
  }

  const issue = row.issue!;
  if (!issue.due_date) {
    return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}><text class="gantt-col-cell" x="4" y="${ctx.barHeight / 2 + 4}" text-anchor="start">—</text></g>`;
  }

  const dueDate = parseLocalDate(issue.due_date);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const displayDate = `${monthNames[dueDate.getMonth()]} ${dueDate.getDate()}`;

  const daysUntilDue = Math.floor((dueDate.getTime() - ctx.today.getTime()) / (1000 * 60 * 60 * 24));
  let dueClass = "";
  let dueTooltip = issue.due_date;

  if (!issue.isClosed && issue.done_ratio < 100 && daysUntilDue < 0) {
    dueClass = "due-overdue";
    dueTooltip = `${issue.due_date} (Overdue by ${Math.abs(daysUntilDue)} day${Math.abs(daysUntilDue) === 1 ? "" : "s"})`;
  } else if (!issue.isClosed && issue.done_ratio < 100 && daysUntilDue <= 3) {
    dueClass = "due-soon";
    dueTooltip = daysUntilDue === 0 ? `${issue.due_date} (Due today)` : `${issue.due_date} (Due in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"})`;
  }

  return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}>
    <title>${escapeAttr(dueTooltip)}</title>
    <text class="gantt-col-cell ${dueClass}" x="4" y="${ctx.barHeight / 2 + 4}" text-anchor="start">${displayDate}</text>
  </g>`;
}

/** Generate assignee column cell */
export function generateAssigneeCell(
  row: GanttRow,
  y: number,
  originalY: number,
  ctx: GanttRenderContext
): string {
  const hiddenAttr = row.isVisible ? "" : ' visibility="hidden"';
  const hiddenClass = row.isVisible ? "" : " gantt-row-hidden";

  if (row.type !== "issue") {
    return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}></g>`;
  }

  const issue = row.issue!;
  if (!issue.assignee) {
    return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}><text class="gantt-col-cell" x="${ctx.assigneeColumnWidth / 2}" y="${ctx.barHeight / 2 + 4}" text-anchor="middle">—</text></g>`;
  }

  const initials = getInitials(issue.assignee);
  const colors = getAvatarColorIndices(issue.assignee);
  const isCurrentUser = issue.assigneeId === ctx.currentUserId;
  const radius = 9;
  const cx = ctx.assigneeColumnWidth / 2;
  const cy = ctx.barHeight / 2;

  return `<g class="gantt-row assignee-badge${isCurrentUser ? " current-user" : ""}${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}>
    <title>${escapeAttr(issue.assignee)}</title>
    <circle class="avatar-fill-${colors.fill} avatar-stroke-${colors.stroke}" cx="${cx}" cy="${cy}" r="${radius}"/>
    <text x="${cx}" y="${cy + 3}" text-anchor="middle" fill="var(--vscode-editor-background)" font-size="9" font-weight="600">${escapeHtml(initials)}</text>
  </g>`;
}

// ============================================================================
// Bar Generation
// ============================================================================

/** Generate issue bar SVG */
export function generateIssueBar(
  row: GanttRow,
  _idx: number,
  y: number,
  originalY: number,
  ctx: GanttRenderContext
): string {
  const hiddenAttr = row.isVisible ? "" : ' visibility="hidden"';
  const hiddenClass = row.isVisible ? "" : " gantt-row-hidden";

  // Project aggregate bars
  if (row.type === "project") {
    return generateProjectAggregateBar(row, y, originalY, hiddenAttr, hiddenClass, ctx);
  }

  // Time-group aggregate bars
  if (row.type === "time-group") {
    return generateTimeGroupAggregateBar(row, y, originalY, hiddenAttr, hiddenClass, ctx);
  }

  // Issue bars
  if (row.type !== "issue" || !row.issue) return "";

  const issue = row.issue;
  if (!issue.start_date && !issue.due_date) return "";

  const isParent = row.isParent ?? false;
  const hasOnlyStart = Boolean(issue.start_date && !issue.due_date);
  const maxDateStr = ctx.maxDate.toISOString().slice(0, 10);
  const startDate = issue.start_date ?? issue.due_date!;
  const dueDate = issue.due_date ?? (hasOnlyStart ? maxDateStr : issue.start_date!);

  const start = new Date(startDate);
  const end = new Date(dueDate);
  const endPlusOne = new Date(end);
  endPlusOne.setUTCDate(endPlusOne.getUTCDate() + 1);

  const startX = ((start.getTime() - ctx.minDate.getTime()) / (ctx.maxDate.getTime() - ctx.minDate.getTime())) * ctx.timelineWidth;
  const endX = ((endPlusOne.getTime() - ctx.minDate.getTime()) / (ctx.maxDate.getTime() - ctx.minDate.getTime())) * ctx.timelineWidth;
  const width = Math.max(10, endX - startX);

  const effectiveStatus = issue.isClosed ? "completed" : (issue.status ?? "unknown");
  const color = isParent ? "var(--vscode-descriptionForeground)" : ctx.getStatusColor(effectiveStatus);
  const textColor = isParent ? "var(--vscode-editor-foreground)" : ctx.getStatusTextColor(effectiveStatus);
  const fillOpacity = isParent ? 0.5 : ctx.getStatusOpacity(effectiveStatus);

  const isPast = end < ctx.today;
  const isOverdue = !isParent && !issue.isClosed && issue.done_ratio < 100 && end < ctx.today;

  const barY = ctx.barPadding;

  // Parent issue: summary bar
  if (isParent) {
    return generateParentBar(row, issue, y, originalY, startX, endX, width, barY, color, hiddenAttr, hiddenClass, ctx);
  }

  // Regular issue bar
  return generateRegularBar(row, issue, y, originalY, startX, endX, width, barY, color, textColor, fillOpacity, isPast, isOverdue, hasOnlyStart, hiddenAttr, hiddenClass, ctx);
}

/** Generate project aggregate bar */
function generateProjectAggregateBar(
  row: GanttRow,
  y: number,
  originalY: number,
  hiddenAttr: string,
  hiddenClass: string,
  ctx: GanttRenderContext
): string {
  if (!row.childDateRanges || row.childDateRanges.length === 0) {
    return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}></g>`;
  }

  const tooltip = ctx.buildProjectTooltip(row);
  const barY = ctx.barPadding;

  const aggregateBars = row.childDateRanges
    .filter(range => range.startDate || range.dueDate)
    .map(range => {
      const startDate = range.startDate ?? range.dueDate!;
      const dueDate = range.dueDate ?? range.startDate!;
      const start = new Date(startDate);
      const end = new Date(dueDate);
      const endPlusOne = new Date(end);
      endPlusOne.setUTCDate(endPlusOne.getUTCDate() + 1);

      const startX = ((start.getTime() - ctx.minDate.getTime()) / (ctx.maxDate.getTime() - ctx.minDate.getTime())) * ctx.timelineWidth;
      const endX = ((endPlusOne.getTime() - ctx.minDate.getTime()) / (ctx.maxDate.getTime() - ctx.minDate.getTime())) * ctx.timelineWidth;
      const width = Math.max(4, endX - startX);

      return `<rect class="aggregate-bar" x="${startX}" y="${barY}" width="${width}" height="${ctx.barContentHeight}" fill="var(--vscode-descriptionForeground)" opacity="0.5" rx="2" ry="2"><title>${escapeAttr(tooltip)}</title></rect>`;
    })
    .join("");

  return `<g class="aggregate-bars gantt-row${hiddenClass}" data-project-id="${row.id}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" data-tooltip="${escapeAttr(tooltip)}" data-vscode-context='${escapeAttr(JSON.stringify({ webviewSection: "projectLabel", projectId: row.id, projectIdentifier: row.identifier || "", preventDefaultContextMenuItems: true }))}' transform="translate(0, ${y})"${hiddenAttr}><title>${escapeAttr(tooltip)}</title>${aggregateBars}</g>`;
}

/** Generate time-group aggregate bar */
function generateTimeGroupAggregateBar(
  row: GanttRow,
  y: number,
  originalY: number,
  hiddenAttr: string,
  hiddenClass: string,
  ctx: GanttRenderContext
): string {
  if (!row.childDateRanges || row.childDateRanges.length === 0) {
    return `<g class="gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}></g>`;
  }

  const barY = ctx.barPadding;
  const timeGroupColor = row.timeGroup === "overdue" ? "var(--vscode-charts-red)"
    : row.timeGroup === "this-week" ? "var(--vscode-charts-yellow)"
    : row.timeGroup === "later" ? "var(--vscode-charts-green)"
    : "var(--vscode-descriptionForeground)";

  const aggregateBars = row.childDateRanges
    .filter(range => range.startDate || range.dueDate)
    .map(range => {
      const startDate = range.startDate ?? range.dueDate!;
      const dueDate = range.dueDate ?? range.startDate!;
      const start = new Date(startDate);
      const end = new Date(dueDate);
      const endPlusOne = new Date(end);
      endPlusOne.setUTCDate(endPlusOne.getUTCDate() + 1);

      const startX = ((start.getTime() - ctx.minDate.getTime()) / (ctx.maxDate.getTime() - ctx.minDate.getTime())) * ctx.timelineWidth;
      const endX = ((endPlusOne.getTime() - ctx.minDate.getTime()) / (ctx.maxDate.getTime() - ctx.minDate.getTime())) * ctx.timelineWidth;
      const width = Math.max(4, endX - startX);

      return `<rect class="aggregate-bar" x="${startX}" y="${barY}" width="${width}" height="${ctx.barContentHeight}" fill="${timeGroupColor}" opacity="0.4" rx="2" ry="2"/>`;
    })
    .join("");

  return `<g class="aggregate-bars time-group-bars gantt-row${hiddenClass}" data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}" data-time-group="${row.timeGroup}" data-original-y="${originalY}" transform="translate(0, ${y})"${hiddenAttr}>${aggregateBars}</g>`;
}

/** Generate parent (summary) bar */
function generateParentBar(
  row: GanttRow,
  issue: GanttIssue,
  y: number,
  originalY: number,
  startX: number,
  endX: number,
  _width: number,
  barY: number,
  color: string,
  hiddenAttr: string,
  hiddenClass: string,
  ctx: GanttRenderContext
): string {
  const escapedSubject = escapeHtml(issue.subject);
  const doneRatio = issue.done_ratio;
  const parentDoneWidth = (doneRatio / 100) * (endX - startX - 8);

  const barTooltip = `#${issue.id} ${escapedSubject}\n(Parent issue - ${doneRatio}% aggregated progress)`;

  return `
    <g class="issue-bar parent-bar gantt-row${hiddenClass}" data-issue-id="${issue.id}"
       data-project-id="${issue.projectId}"
       data-subject="${escapedSubject}"
       data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}"
       data-original-y="${originalY}"
       data-start-date="${issue.start_date || ""}"
       data-due-date="${issue.due_date || ""}"
       data-start-x="${startX}" data-end-x="${endX}" data-center-y="${y + ctx.barHeight / 2}"
       data-vscode-context='{"webviewSection":"issueBar","issueId":${issue.id},"projectId":${issue.projectId},"hasParent":${issue.parentId !== null},"preventDefaultContextMenuItems":true}'
       transform="translate(0, ${y})"${hiddenAttr}
       tabindex="0" role="button" aria-label="#${issue.id} ${escapedSubject} (parent, ${doneRatio}% done)">
      <title>${escapeAttr(barTooltip)}</title>
      <rect class="parent-hit-area" x="${startX}" y="0" width="${endX - startX}" height="${ctx.barHeight}" fill="transparent" pointer-events="all"/>
      <path class="bar-outline" d="M ${startX + 3} ${barY + ctx.barContentHeight * 0.2}
            L ${startX + 3} ${barY + ctx.barContentHeight * 0.8}
            L ${startX} ${barY + ctx.barContentHeight}
            M ${startX + 3} ${barY + ctx.barContentHeight * 0.5}
            H ${endX - 3}
            M ${endX - 3} ${barY + ctx.barContentHeight * 0.2}
            L ${endX - 3} ${barY + ctx.barContentHeight * 0.8}
            L ${endX} ${barY + ctx.barContentHeight}"
            fill="none" stroke="${color}" stroke-width="2" opacity="0.8" class="cursor-pointer"/>
      ${doneRatio > 0 ? `
        <line class="parent-progress" x1="${startX + 3}" y1="${barY + ctx.barContentHeight * 0.5}"
              x2="${startX + 3 + parentDoneWidth}" y2="${barY + ctx.barContentHeight * 0.5}"
              stroke="var(--vscode-charts-green)" stroke-width="2" opacity="0.8"/>
      ` : ""}
    </g>
  `;
}

/** Generate regular issue bar */
function generateRegularBar(
  row: GanttRow,
  issue: GanttIssue,
  y: number,
  originalY: number,
  startX: number,
  endX: number,
  width: number,
  barY: number,
  color: string,
  textColor: string,
  fillOpacity: number,
  isPast: boolean,
  isOverdue: boolean,
  hasOnlyStart: boolean,
  hiddenAttr: string,
  hiddenClass: string,
  ctx: GanttRenderContext
): string {
  const escapedSubject = escapeHtml(issue.subject);
  const doneRatio = issue.done_ratio;

  // Calculate visual progress
  const contributedHours = ctx.contributionSources?.get(issue.id)?.reduce((sum, c) => sum + c.hours, 0) ?? 0;
  const effectiveSpentHours = (issue.spent_hours ?? 0) + contributedHours;
  let visualDoneRatio = doneRatio;
  let isFallbackProgress = false;
  if (doneRatio === 0 && effectiveSpentHours > 0 && issue.estimated_hours && issue.estimated_hours > 0) {
    visualDoneRatio = Math.min(100, Math.round((effectiveSpentHours / issue.estimated_hours) * 100));
    isFallbackProgress = true;
  }

  const doneWidth = (visualDoneRatio / 100) * width;
  const handleWidth = 14;

  // Past portion
  const todayX = ((ctx.today.getTime() - ctx.minDate.getTime()) / (ctx.maxDate.getTime() - ctx.minDate.getTime())) * ctx.timelineWidth;
  const start = new Date(issue.start_date!);
  const pastEndX = Math.min(todayX, endX);
  const pastWidth = Math.max(0, pastEndX - startX);
  const hasPastPortion = start < ctx.today && pastWidth > 0;

  // Status/tooltip
  const effectiveStatus = issue.isClosed ? "completed" : (issue.status ?? "unknown");
  const statusDesc = ctx.getStatusDescription(effectiveStatus);
  const flexPct = issue.flexibilityPercent;
  const isCriticalPath = flexPct !== null && flexPct <= 0 && !issue.isClosed;

  // Build bar tooltip
  const barTooltip = [
    issue.isAdHoc ? "🎲 AD-HOC BUDGET POOL" : null,
    issue.isExternal ? "⚡ EXTERNAL DEPENDENCY" : null,
    isCriticalPath ? "🔶 CRITICAL PATH" : null,
    statusDesc,
    `#${issue.id} ${escapedSubject}`,
    `Progress: ${doneRatio}%${isFallbackProgress ? ` (~${visualDoneRatio}% from time)` : ""}`,
    `Estimated: ${formatHoursAsTime(issue.estimated_hours)}`,
    `Spent: ${formatHoursAsTime(issue.spent_hours)}`,
  ].filter(Boolean).join("\n");

  // Intensity data
  const canShowIntensity = ctx.viewFocus === "person";
  const intensities = canShowIntensity
    ? (ctx.issueScheduleMap.size > 0
        ? getScheduledIntensity(issue, ctx.schedule, ctx.issueScheduleMap)
        : calculateDailyIntensity(issue, ctx.schedule))
    : [];
  const hasIntensityData = canShowIntensity && intensities.length > 0 && issue.estimated_hours !== null;

  // Generate intensity segments
  let intensitySegments = "";
  if (hasIntensityData) {
    const dayCount = intensities.length;
    const segmentWidth = width / dayCount;
    const maxIntensityForOpacity = 1.5;
    intensitySegments = intensities
      .map((d, i) => {
        const segX = startX + i * segmentWidth;
        const normalizedForOpacity = Math.min(d.intensity, maxIntensityForOpacity) / maxIntensityForOpacity;
        const opacity = (0.5 + normalizedForOpacity * 0.4) * fillOpacity;
        return `<rect x="${segX}" y="${barY}" width="${segmentWidth + 0.5}" height="${ctx.barContentHeight}" fill="${color}" opacity="${opacity.toFixed(2)}"/>`;
      })
      .join("");
  }

  // Subject text on bar
  const subjectOnBar = (() => {
    const padding = 12;
    const availableWidth = width - padding * 2;
    if (availableWidth < 30) return "";
    const maxChars = Math.floor(availableWidth / 6);
    if (maxChars < 3) return "";
    const displaySubject = issue.subject.length > maxChars
      ? issue.subject.substring(0, maxChars - 1) + "…"
      : issue.subject;
    return `<text class="bar-subject" x="${startX + padding}" y="${barY + ctx.barContentHeight / 2 + 3}" fill="${textColor}" font-size="9" font-weight="500" pointer-events="none">${escapeHtml(displaySubject)}</text>`;
  })();

  return `
    <g class="issue-bar gantt-row${hiddenClass}${isPast ? " bar-past" : ""}${isOverdue ? " bar-overdue" : ""}${hasOnlyStart ? " bar-open-ended" : ""}${issue.isExternal ? " bar-external" : ""}${issue.isAdHoc ? " bar-adhoc" : ""}${isCriticalPath ? " bar-critical" : ""}" data-issue-id="${issue.id}"
       data-project-id="${issue.projectId}"
       data-subject="${escapedSubject}"
       data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}"
       data-original-y="${originalY}"
       data-start-date="${issue.start_date || ""}"
       data-due-date="${issue.due_date || ""}"
       data-start-x="${startX}" data-end-x="${endX}" data-center-y="${y + ctx.barHeight / 2}"
       data-vscode-context='{"webviewSection":"issueBar","issueId":${issue.id},"projectId":${issue.projectId},"hasParent":${issue.parentId !== null},"preventDefaultContextMenuItems":true}'
       transform="translate(0, ${y})"${hiddenAttr}
       tabindex="0" role="button" aria-label="#${issue.id} ${escapedSubject}${isOverdue ? " (overdue)" : ""}">
      <title>${escapeAttr(barTooltip)}</title>
      <defs>
        <clipPath id="bar-clip-${issue.id}">
          <rect x="${startX}" y="${barY}" width="${width}" height="${ctx.barContentHeight}" rx="6" ry="6"/>
        </clipPath>
      </defs>
      <g clip-path="url(#bar-clip-${issue.id})">
        ${hasIntensityData ? `
          <g class="bar-intensity">${intensitySegments}</g>
          <rect class="bar-main bar-solid-fallback" x="${startX}" y="${barY}" width="${width}" height="${ctx.barContentHeight}" fill="${color}" opacity="${(0.85 * fillOpacity).toFixed(2)}" filter="url(#barShadow)"/>
        ` : `
          <rect class="bar-main" x="${startX}" y="${barY}" width="${width}" height="${ctx.barContentHeight}" fill="${color}" opacity="${(0.85 * fillOpacity).toFixed(2)}" filter="url(#barShadow)"/>
        `}
        ${hasPastPortion ? `<rect class="past-overlay" x="${startX}" y="${barY}" width="${pastWidth}" height="${ctx.barContentHeight}" fill="url(#past-stripes)"/>` : ""}
        ${visualDoneRatio > 0 && visualDoneRatio < 100 ? `
          <rect class="progress-unfilled" x="${startX + doneWidth}" y="${barY}" width="${width - doneWidth}" height="${ctx.barContentHeight}" fill="black" opacity="0.3"/>
          <line class="progress-divider" x1="${startX + doneWidth}" y1="${barY + 1}" x2="${startX + doneWidth}" y2="${barY + ctx.barContentHeight - 1}" stroke="white" stroke-width="2" opacity="0.6"/>
        ` : ""}
      </g>
      <rect class="bar-outline cursor-move" x="${startX}" y="${barY}" width="${width}" height="${ctx.barContentHeight}" fill="none" stroke="var(--vscode-panel-border)" stroke-width="1" rx="6" ry="6" pointer-events="all"/>
      ${subjectOnBar}
      <g class="drag-handle drag-left cursor-ew-resize">
        <rect x="${startX}" y="0" width="${handleWidth}" height="${ctx.barHeight}" fill="transparent"/>
        <g class="drag-grip" pointer-events="none">
          <circle cx="${startX + 9}" cy="${ctx.barHeight / 2 - 4}" r="1.5"/>
          <circle cx="${startX + 9}" cy="${ctx.barHeight / 2}" r="1.5"/>
          <circle cx="${startX + 9}" cy="${ctx.barHeight / 2 + 4}" r="1.5"/>
        </g>
      </g>
      <g class="drag-handle drag-right cursor-ew-resize">
        <rect x="${startX + width - handleWidth}" y="0" width="${handleWidth}" height="${ctx.barHeight}" fill="transparent"/>
        <g class="drag-grip" pointer-events="none">
          <circle cx="${startX + width - 9}" cy="${ctx.barHeight / 2 - 4}" r="1.5"/>
          <circle cx="${startX + width - 9}" cy="${ctx.barHeight / 2}" r="1.5"/>
          <circle cx="${startX + width - 9}" cy="${ctx.barHeight / 2 + 4}" r="1.5"/>
        </g>
      </g>
      <g class="link-handle link-handle-start cursor-crosshair" data-anchor="start" data-cx="${startX - 8}" data-cy="${y + barY + ctx.barContentHeight / 2}">
        <title>Drag to link (from start)</title>
        <circle cx="${startX - 8}" cy="${barY + ctx.barContentHeight / 2}" r="12" fill="transparent" pointer-events="all"/>
        <circle class="link-handle-visual" cx="${startX - 8}" cy="${barY + ctx.barContentHeight / 2}" r="4" fill="var(--vscode-button-background)" stroke="var(--vscode-button-foreground)" stroke-width="1" pointer-events="none"/>
      </g>
      <g class="link-handle link-handle-end cursor-crosshair" data-anchor="end" data-cx="${endX + 8}" data-cy="${y + barY + ctx.barContentHeight / 2}">
        <title>Drag to link (from end)</title>
        <circle cx="${endX + 8}" cy="${barY + ctx.barContentHeight / 2}" r="12" fill="transparent" pointer-events="all"/>
        <circle class="link-handle-visual" cx="${endX + 8}" cy="${barY + ctx.barContentHeight / 2}" r="4" fill="var(--vscode-button-background)" stroke="var(--vscode-button-foreground)" stroke-width="1" pointer-events="none"/>
      </g>
    </g>
  `;
}

// ============================================================================
// Zebra Stripes & Indent Guides
// ============================================================================

/** Generate zebra stripe backgrounds */
export function generateZebraStripes(
  groupRanges: GroupRange[],
  visibleRows: GanttRow[],
  rowYPositions: number[],
  rowHeights: number[]
): string {
  const getGapBefore = (_row: GanttRow, idx: number): number => {
    if (idx === 0) return rowYPositions[0];
    return rowYPositions[idx] - (rowYPositions[idx - 1] + rowHeights[idx - 1]);
  };

  return groupRanges
    .map(g => {
      const firstRow = visibleRows[g.startIdx];
      const gapBeforeFirst = getGapBefore(firstRow, g.startIdx);
      const startY = rowYPositions[g.startIdx] - gapBeforeFirst;
      const endY = rowYPositions[g.endIdx] + rowHeights[g.endIdx];
      const height = endY - startY;
      const opacity = g.groupIdx % 2 === 0 ? 0.03 : 0.06;

      const rowContributions: Record<string, number> = {};
      for (let i = g.startIdx; i <= g.endIdx; i++) {
        const row = visibleRows[i];
        const gapOwned = i === g.startIdx ? gapBeforeFirst : getGapBefore(row, i);
        rowContributions[row.collapseKey] = gapOwned + rowHeights[i];
      }

      return `<rect class="zebra-stripe" x="0" y="${startY}" width="100%" height="${height}" opacity="${opacity}" data-first-row-key="${firstRow.collapseKey}" data-original-y="${startY}" data-original-height="${height}" data-row-contributions='${JSON.stringify(rowContributions)}' />`;
    })
    .join("");
}

/** Generate indent guide lines */
export function generateIndentGuides(
  visibleRows: GanttRow[],
  rowYPositions: number[],
  barHeight: number,
  indentSize: number
): string {
  const subtreeEndIndex = new Array<number>(visibleRows.length);
  const parentStack: number[] = [];

  for (let i = 0; i < visibleRows.length; i++) {
    const depth = visibleRows[i].depth;
    while (parentStack.length > 0 && depth <= visibleRows[parentStack[parentStack.length - 1]].depth) {
      const idx = parentStack.pop()!;
      subtreeEndIndex[idx] = i - 1;
    }
    parentStack.push(i);
  }
  while (parentStack.length > 0) {
    const idx = parentStack.pop()!;
    subtreeEndIndex[idx] = visibleRows.length - 1;
  }

  const lines: string[] = [];
  for (let i = 0; i < visibleRows.length; i++) {
    const row = visibleRows[i];
    if (!row.hasChildren) continue;

    const parentDepth = row.depth;
    const firstDescendantIndex = i + 1;
    if (firstDescendantIndex >= visibleRows.length) continue;
    if (visibleRows[firstDescendantIndex].depth <= parentDepth) continue;
    const lastDescendantIndex = subtreeEndIndex[i];
    if (lastDescendantIndex <= i) continue;

    const lineX = 8 + parentDepth * indentSize;
    const startY = rowYPositions[firstDescendantIndex];
    const endY = rowYPositions[lastDescendantIndex] + barHeight;

    lines.push(
      `<line class="indent-guide-line" data-for-parent="${row.collapseKey}" x1="${lineX}" y1="${startY}" x2="${lineX}" y2="${endY}" stroke="var(--vscode-tree-indentGuidesStroke)" stroke-width="1" opacity="0.4"/>`
    );
  }

  return lines.length > 0 ? `<g class="indent-guides-layer">${lines.join("")}</g>` : "";
}
