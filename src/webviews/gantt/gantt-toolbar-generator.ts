/**
 * Gantt Toolbar HTML Generator
 * Stateless rendering - all data passed via context
 */

import { escapeAttr, escapeHtml } from "../gantt-html-escape";
import type { IssueFilter } from "../../redmine/models/common";

type ZoomLevel = "day" | "week" | "month" | "quarter" | "year";

/** Minimal project interface for toolbar rendering */
export interface ToolbarProject {
  id: number;
  name: string;
  parent?: { id: number; name: string };
}

/** Context for toolbar generation */
export interface GanttToolbarContext {
  // View state
  viewFocus: "project" | "person";
  selectedProjectId: number | null;
  selectedAssignee: string | null;
  currentUserName: string | null;
  uniqueAssignees: string[];
  projects: ToolbarProject[];

  // Settings
  lookbackYears: 2 | 5 | 10 | null;
  zoomLevel: ZoomLevel;
  currentFilter: IssueFilter;

  // Toggle states
  showDependencies: boolean;
  showBadges: boolean;
  showCapacityRibbon: boolean;
  showIntensity: boolean;

  // Sort state
  sortBy: "id" | "assignee" | "start" | "due" | "status" | null;
  sortOrder: "asc" | "desc";

  // Today button state
  todayInRange: boolean;

  // Draft mode
  draftModeEnabled: boolean;
  draftQueueCount: number;
}

/**
 * Generate project selector options with hierarchy
 */
export function generateProjectOptions(
  projects: ToolbarProject[],
  selectedId: number | null
): string {
  // Build parent-children map
  const childrenMap = new Map<number, ToolbarProject[]>();
  for (const p of projects) {
    if (p.parent?.id) {
      if (!childrenMap.has(p.parent.id)) childrenMap.set(p.parent.id, []);
      childrenMap.get(p.parent.id)!.push(p);
    }
  }

  // Get root projects (no parent)
  const rootProjects = projects
    .filter((p) => !p.parent)
    .sort((a, b) => a.name.localeCompare(b.name));

  // Recursive renderer
  const renderProject = (p: ToolbarProject, depth = 0): string => {
    const children = (childrenMap.get(p.id) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    const isSelected = p.id === selectedId;
    const indent = "\u00A0\u00A0".repeat(depth);
    const option = `<option value="${p.id}"${isSelected ? " selected" : ""}>${indent}${escapeHtml(p.name)}</option>`;
    return option + children.map((c) => renderProject(c, depth + 1)).join("");
  };

  return rootProjects.map((p) => renderProject(p)).join("");
}

/**
 * Generate assignee selector options
 */
export function generateAssigneeOptions(
  assignees: string[],
  selectedAssignee: string | null,
  currentUserName: string | null
): string {
  return assignees
    .map((name) => {
      const isMe = name === currentUserName;
      const isSelected = name === selectedAssignee;
      return `<option value="${escapeAttr(name)}"${isSelected ? " selected" : ""}>${escapeHtml(name)}${isMe ? " (me)" : ""}</option>`;
    })
    .join("");
}

/**
 * Generate complete toolbar HTML
 */
export function generateToolbar(ctx: GanttToolbarContext): string {
  const draftBadgeTooltip =
    ctx.draftQueueCount === 1
      ? "1 change queued - click to review"
      : `${ctx.draftQueueCount} changes queued - click to review`;

  const projectSelector =
    ctx.viewFocus === "project"
      ? `
      <select id="projectSelector" class="toolbar-select" data-toolbar-tooltip="Select project">
        <option value=""${ctx.selectedProjectId === null ? " selected" : ""}>All Projects</option>
        ${generateProjectOptions(ctx.projects, ctx.selectedProjectId)}
      </select>`
      : `
      <select id="focusSelector" class="toolbar-select" data-toolbar-tooltip="Select person">
        ${generateAssigneeOptions(ctx.uniqueAssignees, ctx.selectedAssignee, ctx.currentUserName)}
      </select>`;

  const assigneeFilter =
    ctx.viewFocus === "project"
      ? `
      <select id="filterAssignee" class="toolbar-select" data-toolbar-tooltip="Filter by assignee">
        <option value="me"${ctx.currentFilter.assignee === "me" ? " selected" : ""}>My issues</option>
        <option value="any"${ctx.currentFilter.assignee === "any" ? " selected" : ""}>All assignees</option>
      </select>`
      : "";

  return `
    <div class="gantt-actions" role="toolbar" aria-label="Gantt chart controls">
      <!-- Draft mode badge and toggle -->
      <span id="draftBadge" class="draft-count-badge${ctx.draftModeEnabled ? "" : " hidden"}" data-toolbar-tooltip="${escapeAttr(draftBadgeTooltip)}">${ctx.draftQueueCount}</span>
      <button id="draftModeToggle" class="draft-mode-toggle${ctx.draftModeEnabled ? " active" : ""}">${ctx.draftModeEnabled ? "Disable Draft Mode" : "Enable Draft Mode"}</button>
      <div class="toolbar-separator"></div>
      <!-- Lookback period -->
      <select id="lookbackSelect" class="toolbar-select" data-toolbar-tooltip="Data lookback period">
        <option value="2"${ctx.lookbackYears === 2 ? " selected" : ""}>2 Years</option>
        <option value="5"${ctx.lookbackYears === 5 ? " selected" : ""}>5 Years</option>
        <option value="10"${ctx.lookbackYears === 10 ? " selected" : ""}>10 Years</option>
        <option value=""${ctx.lookbackYears === null ? " selected" : ""}>All Time</option>
      </select>
      <!-- Zoom -->
      <select id="zoomSelect" class="toolbar-select" data-toolbar-tooltip="Zoom level">
        <option value="day"${ctx.zoomLevel === "day" ? " selected" : ""}>Day</option>
        <option value="week"${ctx.zoomLevel === "week" ? " selected" : ""}>Week</option>
        <option value="month"${ctx.zoomLevel === "month" ? " selected" : ""}>Month</option>
        <option value="quarter"${ctx.zoomLevel === "quarter" ? " selected" : ""}>Quarter</option>
        <option value="year"${ctx.zoomLevel === "year" ? " selected" : ""}>Year</option>
      </select>
      <!-- View -->
      <select id="viewFocusSelect" class="toolbar-select" data-toolbar-tooltip="View by (V)">
        <option value="project"${ctx.viewFocus === "project" ? " selected" : ""}>By Project</option>
        <option value="person"${ctx.viewFocus === "person" ? " selected" : ""}>By Person</option>
      </select>
      <!-- Context selector -->
      ${projectSelector}
      <div class="toolbar-separator"></div>
      <!-- Filters -->
      ${assigneeFilter}
      <select id="filterStatus" class="toolbar-select" data-toolbar-tooltip="Filter by status">
        <option value="open"${ctx.currentFilter.status === "open" ? " selected" : ""}>Open</option>
        <option value="closed"${ctx.currentFilter.status === "closed" ? " selected" : ""}>Closed</option>
        <option value="any"${ctx.currentFilter.status === "any" ? " selected" : ""}>Any status</option>
      </select>
      <!-- Primary actions -->
      <button id="refreshBtn" class="toggle-btn text-btn" data-toolbar-tooltip="Refresh (R)">↻</button>
      <button id="todayBtn" class="toggle-btn text-btn" data-toolbar-tooltip="${ctx.todayInRange ? "Today (T)" : "Today is outside timeline range"}"${ctx.todayInRange ? "" : " disabled"}>T</button>
      <!-- Overflow menu -->
      <div class="toolbar-dropdown">
        <button class="toggle-btn text-btn">⋮</button>
        <div class="toolbar-dropdown-menu">
          <div class="toolbar-dropdown-menu-inner">
            <div class="toolbar-dropdown-item${ctx.showDependencies ? " active" : ""}" id="menuDeps">
              <span class="icon">⤤</span>
              <span>Relations</span>
              <span class="shortcut">D</span>
            </div>
            <div class="toolbar-dropdown-item${ctx.showBadges ? " active" : ""}" id="menuBadges">
              <span class="icon">⏳</span>
              <span>Badges</span>
              <span class="shortcut">B</span>
            </div>
            <div class="toolbar-dropdown-item${ctx.showCapacityRibbon && ctx.viewFocus === "person" ? " active" : ""}" id="menuCapacity"${ctx.viewFocus !== "person" ? " disabled" : ""}>
              <span class="icon">▤</span>
              <span>Capacity</span>
              <span class="shortcut">Y</span>
            </div>
            <div class="toolbar-dropdown-item${ctx.showIntensity && ctx.viewFocus === "person" ? " active" : ""}" id="menuIntensity"${ctx.viewFocus !== "person" ? " disabled" : ""}>
              <span class="icon">▥</span>
              <span>Intensity</span>
              <span class="shortcut">I</span>
            </div>
            <div class="toolbar-dropdown-divider"></div>
            <div class="toolbar-dropdown-item" id="menuUndo" disabled>
              <span class="icon">↩</span>
              <span>Undo</span>
              <span class="shortcut">⌘Z</span>
            </div>
            <div class="toolbar-dropdown-item" id="menuRedo" disabled>
              <span class="icon">↪</span>
              <span>Redo</span>
              <span class="shortcut">⌘Y</span>
            </div>
            <div class="toolbar-dropdown-divider"></div>
            <div class="toolbar-dropdown-item" id="menuExpand">
              <span class="icon">+</span>
              <span>Expand all</span>
              <span class="shortcut">E</span>
            </div>
            <div class="toolbar-dropdown-item" id="menuCollapse">
              <span class="icon">−</span>
              <span>Collapse all</span>
              <span class="shortcut">C</span>
            </div>
          </div>
        </div>
      </div>
      <div class="toolbar-separator"></div>
      <div class="help-dropdown">
        <button class="toggle-btn text-btn">?</button>
        <div class="help-tooltip">
            <div class="help-section">
              <div class="help-title">Bar Badges</div>
              <span class="help-item"><span style="color:var(--vscode-charts-green)">+Nd</span> days of slack</span>
              <span class="help-item"><span style="color:var(--vscode-charts-red)">-Nd</span> days late</span>
              <span class="help-item">🚧N blocked by this</span>
              <span class="help-item"><span style="color:var(--vscode-charts-red)">⛔N</span> blockers</span>
              <span class="help-item"><span style="color:var(--vscode-charts-purple)">◆</span> milestone</span>
            </div>
            <div class="help-section">
              <div class="help-title">Relations</div>
              <span class="help-item"><span class="relation-legend-line rel-line-blocks"></span>blocking</span>
              <span class="help-item"><span class="relation-legend-line rel-line-scheduling"></span>scheduling</span>
              <span class="help-item"><span class="relation-legend-line rel-line-informational"></span>informational</span>
            </div>
            <div class="help-section">
              <div class="help-title">Shortcuts</div>
              <span class="help-item"><kbd>1-5</kbd> Zoom</span>
              <span class="help-item"><kbd>V</kbd> View</span>
              <span class="help-item"><kbd>D</kbd> Relations</span>
              <span class="help-item"><kbd>Y</kbd> Capacity</span>
              <span class="help-item"><kbd>R</kbd> Refresh</span>
              <span class="help-item"><kbd>T</kbd> Today</span>
              <span class="help-item"><kbd>E</kbd> Expand</span>
              <span class="help-item"><kbd>C</kbd> Collapse</span>
              <span class="help-item"><kbd>B</kbd> Badges</span>
            </div>
        </div>
      </div>
      <span id="selectionCount" class="selection-count hidden"></span>
    </div>
  `;
}

/**
 * Generate title section HTML
 */
export function generateTitle(
  viewFocus: "project" | "person",
  selectedProjectId: number | null,
  projects: ToolbarProject[]
): string {
  if (viewFocus === "project" && selectedProjectId) {
    const project = projects.find((p) => p.id === selectedProjectId);
    if (project) {
      const clientName = project.parent?.name;
      if (clientName) {
        return `<div class="gantt-title"><span class="client-name">${escapeHtml(clientName)}:</span> ${escapeHtml(project.name)}</div>`;
      }
      return `<div class="gantt-title">${escapeHtml(project.name)}</div>`;
    }
  }
  return '<div class="gantt-title"></div>';
}

/**
 * Generate complete header HTML (title + toolbar)
 */
export function generateHeader(ctx: GanttToolbarContext): string {
  return `
    <div class="gantt-header">
      ${generateTitle(ctx.viewFocus, ctx.selectedProjectId, ctx.projects)}
      ${generateToolbar(ctx)}
    </div>
  `;
}
