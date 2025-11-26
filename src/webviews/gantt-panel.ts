import * as vscode from "vscode";
import { Issue } from "../redmine/models/issue";
import { RedmineServer } from "../redmine/redmine-server";
import { FlexibilityScore } from "../utilities/flexibility-calculator";

interface GanttIssue {
  id: number;
  subject: string;
  start_date: string | null;
  due_date: string | null;
  status: FlexibilityScore["status"] | null;
  project: string;
  projectId: number;
  parentId: number | null;
  estimated_hours: number | null;
  spent_hours: number | null;
}

interface GanttRow {
  type: "project" | "issue";
  id: number;
  label: string;
  depth: number;
  issue?: GanttIssue;
}

/**
 * Build hierarchical rows from flat issues list
 * Groups by project, then organizes parent/child issues
 */
function buildHierarchicalRows(issues: GanttIssue[]): GanttRow[] {
  const rows: GanttRow[] = [];

  // Group issues by project
  const byProject = new Map<number, { name: string; issues: GanttIssue[] }>();
  for (const issue of issues) {
    if (!byProject.has(issue.projectId)) {
      byProject.set(issue.projectId, { name: issue.project, issues: [] });
    }
    byProject.get(issue.projectId)!.issues.push(issue);
  }

  // Sort projects by issue count (descending)
  const sortedProjects = [...byProject.entries()].sort(
    (a, b) => b[1].issues.length - a[1].issues.length
  );

  for (const [projectId, { name, issues: projectIssues }] of sortedProjects) {
    // Add project header
    rows.push({
      type: "project",
      id: projectId,
      label: name,
      depth: 0,
    });

    // Build issue tree within project
    const issueMap = new Map(projectIssues.map((i) => [i.id, i]));
    const children = new Map<number | null, GanttIssue[]>();

    // Group by parent
    for (const issue of projectIssues) {
      const parentId = issue.parentId;
      // Only use parentId if parent is in this project's issues
      const effectiveParent = parentId && issueMap.has(parentId) ? parentId : null;
      if (!children.has(effectiveParent)) {
        children.set(effectiveParent, []);
      }
      children.get(effectiveParent)!.push(issue);
    }

    // Recursively add issues
    function addIssues(parentId: number | null, depth: number) {
      const childIssues = children.get(parentId) || [];
      for (const issue of childIssues) {
        rows.push({
          type: "issue",
          id: issue.id,
          label: issue.subject,
          depth,
          issue,
        });
        addIssues(issue.id, depth + 1);
      }
    }

    addIssues(null, 1);
  }

  return rows;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function formatDateWithWeekday(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return `${dateStr} (${WEEKDAYS[d.getDay()]})`;
}

/**
 * Get ISO week number for a date
 */
function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/**
 * Format decimal hours as HH:MM (rounded up to nearest minute)
 */
function formatHoursAsTime(hours: number | null): string {
  if (hours === null) return "—";
  const totalMinutes = Math.ceil(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${m.toString().padStart(2, "0")}`;
}

/**
 * Gantt timeline webview panel
 * Shows issues as horizontal bars on a timeline
 */
export class GanttPanel {
  public static currentPanel: GanttPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _issues: GanttIssue[] = [];
  private _server: RedmineServer | undefined;

  private constructor(panel: vscode.WebviewPanel, server?: RedmineServer) {
    this._panel = panel;
    this._server = server;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (message) => this._handleMessage(message),
      null,
      this._disposables
    );
  }

  public static createOrShow(server?: RedmineServer): GanttPanel {
    const column = vscode.ViewColumn.One;

    if (GanttPanel.currentPanel) {
      GanttPanel.currentPanel._panel.reveal(column);
      // Update server reference
      if (server) {
        GanttPanel.currentPanel._server = server;
      }
      return GanttPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "redmineGantt",
      "Redmine Gantt",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    GanttPanel.currentPanel = new GanttPanel(panel, server);
    return GanttPanel.currentPanel;
  }

  public updateIssues(
    issues: Issue[],
    flexibilityCache: Map<number, FlexibilityScore | null>
  ): void {
    // Filter issues with dates and map to Gantt format
    this._issues = issues
      .filter((i) => i.start_date || i.due_date)
      .map((i) => ({
        id: i.id,
        subject: i.subject,
        start_date: i.start_date || null,
        due_date: i.due_date || null,
        status: flexibilityCache.get(i.id)?.status ?? null,
        project: i.project?.name ?? "Unknown",
        projectId: i.project?.id ?? 0,
        parentId: i.parent?.id ?? null,
        estimated_hours: i.estimated_hours ?? null,
        spent_hours: i.spent_hours ?? null,
      }));

    this._updateContent();
  }

  private _updateContent(): void {
    this._panel.webview.html = this._getHtmlContent();
  }

  private _handleMessage(message: {
    command: string;
    issueId?: number;
    startDate?: string | null;
    dueDate?: string | null;
  }): void {
    switch (message.command) {
      case "openIssue":
        if (message.issueId && this._server) {
          vscode.commands.executeCommand(
            "redmine.openActionsForIssue",
            false,
            { server: this._server },
            String(message.issueId)
          );
        }
        break;
      case "updateDates":
        if (message.issueId && this._server) {
          this._updateIssueDates(
            message.issueId,
            message.startDate ?? null,
            message.dueDate ?? null
          );
        }
        break;
    }
  }

  private async _updateIssueDates(
    issueId: number,
    startDate: string | null,
    dueDate: string | null
  ): Promise<void> {
    if (!this._server) return;

    try {
      await this._server.updateIssueDates(issueId, startDate, dueDate);
      // Update local data and refresh
      const issue = this._issues.find((i) => i.id === issueId);
      if (issue) {
        if (startDate !== null) issue.start_date = startDate;
        if (dueDate !== null) issue.due_date = dueDate;
      }
      this._updateContent();
      vscode.window.showInformationMessage(`Issue #${issueId} dates updated`);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to update dates: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public dispose(): void {
    GanttPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  private _getHtmlContent(): string {
    const nonce = getNonce();

    // Calculate date range
    const dates = this._issues.flatMap((i) =>
      [i.start_date, i.due_date].filter(Boolean)
    ) as string[];

    if (dates.length === 0) {
      return this._getEmptyHtml();
    }

    const minDate = new Date(
      Math.min(...dates.map((d) => new Date(d).getTime()))
    );
    const maxDate = new Date(
      Math.max(...dates.map((d) => new Date(d).getTime()))
    );

    // Add padding days
    minDate.setDate(minDate.getDate() - 7);
    maxDate.setDate(maxDate.getDate() + 7);

    const totalDays = Math.ceil(
      (maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    const timelineWidth = Math.max(600, totalDays * 40);
    const labelWidth = 250;
    const barHeight = 30;
    const barGap = 10;
    const headerHeight = 40;
    const indentSize = 16;

    // Build hierarchical rows
    const rows = buildHierarchicalRows(this._issues);
    const contentHeight = rows.length * (barHeight + barGap);

    // Left labels (fixed column)
    const labels = rows
      .map((row, index) => {
        const y = headerHeight + index * (barHeight + barGap);
        const indent = row.depth * indentSize;

        if (row.type === "project") {
          // Project header row
          return `
            <g class="project-label">
              <text x="${5 + indent}" y="${y + barHeight / 2 + 5}" fill="var(--vscode-foreground)" font-size="12" font-weight="bold">
                ${row.label}
              </text>
            </g>
          `;
        }

        // Issue row
        const issue = row.issue!;
        const tooltip = [
          `#${issue.id} ${issue.subject}`,
          `Project: ${issue.project}`,
          `Start: ${formatDateWithWeekday(issue.start_date)}`,
          `Due: ${formatDateWithWeekday(issue.due_date)}`,
          `Estimated: ${formatHoursAsTime(issue.estimated_hours)}`,
          `Spent: ${formatHoursAsTime(issue.spent_hours)}`,
        ].join("\n");

        return `
          <g class="issue-label" data-issue-id="${issue.id}" style="cursor: pointer;">
            <text x="${5 + indent}" y="${y + barHeight / 2 + 5}" fill="var(--vscode-foreground)" font-size="12">
              #${issue.id} ${issue.subject}
            </text>
            <title>${tooltip}</title>
          </g>
        `;
      })
      .join("");

    // Right bars (scrollable timeline) - only for issue rows
    const bars = rows
      .map((row, index) => {
        // Skip project headers - no bar
        if (row.type === "project") {
          return "";
        }

        const issue = row.issue!;
        const start = issue.start_date
          ? new Date(issue.start_date)
          : new Date(issue.due_date!);
        const end = issue.due_date
          ? new Date(issue.due_date)
          : new Date(issue.start_date!);

        const startX =
          ((start.getTime() - minDate.getTime()) /
            (maxDate.getTime() - minDate.getTime())) *
          timelineWidth;
        const endX =
          ((end.getTime() - minDate.getTime()) /
            (maxDate.getTime() - minDate.getTime())) *
          timelineWidth;

        const width = Math.max(10, endX - startX);
        const y = headerHeight + index * (barHeight + barGap);
        const color = this._getStatusColor(issue.status);

        const tooltip = [
          `#${issue.id} ${issue.subject}`,
          `Project: ${issue.project}`,
          `Start: ${formatDateWithWeekday(issue.start_date)}`,
          `Due: ${formatDateWithWeekday(issue.due_date)}`,
          `Estimated: ${formatHoursAsTime(issue.estimated_hours)}`,
          `Spent: ${formatHoursAsTime(issue.spent_hours)}`,
        ].join("\n");

        const handleWidth = 8;
        return `
          <g class="issue-bar" data-issue-id="${issue.id}"
             data-start-date="${issue.start_date || ""}"
             data-due-date="${issue.due_date || ""}"
             data-start-x="${startX}" data-end-x="${endX}">
            <rect class="bar-main" x="${startX}" y="${y}" width="${width}" height="${barHeight}"
                  fill="${color}" rx="4" ry="4" opacity="0.8" style="cursor: pointer;"/>
            <rect class="drag-handle drag-left" x="${startX}" y="${y}" width="${handleWidth}" height="${barHeight}"
                  fill="transparent" style="cursor: ew-resize;"/>
            <rect class="drag-handle drag-right" x="${startX + width - handleWidth}" y="${y}" width="${handleWidth}" height="${barHeight}"
                  fill="transparent" style="cursor: ew-resize;"/>
            <title>${tooltip}</title>
          </g>
        `;
      })
      .join("");

    // Date markers (for timeline SVG, no leftMargin needed)
    const dateMarkers = this._generateDateMarkers(
      minDate,
      maxDate,
      timelineWidth,
      0
    );

    // Calculate today's position for auto-scroll
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayX =
      ((today.getTime() - minDate.getTime()) /
        (maxDate.getTime() - minDate.getTime())) *
      timelineWidth;

    const svgHeight = headerHeight + contentHeight;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Redmine Gantt</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      overflow: hidden;
    }
    .gantt-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .gantt-header h2 { margin: 0; }
    .gantt-actions {
      display: flex;
      gap: 4px;
    }
    .gantt-actions button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }
    .gantt-actions button:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .gantt-actions button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .gantt-container {
      display: flex;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
    }
    .gantt-labels {
      flex-shrink: 0;
      width: ${labelWidth}px;
      min-width: 150px;
      max-width: 500px;
      background: var(--vscode-editor-background);
      z-index: 1;
      overflow: hidden;
    }
    .gantt-labels svg {
      width: 100%;
    }
    .gantt-resize-handle {
      width: 6px;
      background: var(--vscode-panel-border);
      cursor: col-resize;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    .gantt-resize-handle:hover, .gantt-resize-handle.dragging {
      background: var(--vscode-focusBorder);
    }
    .gantt-timeline {
      flex-grow: 1;
      overflow-x: auto;
      overflow-y: hidden;
    }
    .gantt-timeline::-webkit-scrollbar {
      height: 8px;
    }
    .gantt-timeline::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 4px;
    }
    svg { display: block; }
    .issue-bar:hover .bar-main, .issue-label:hover { opacity: 0.8; }
    .issue-bar .drag-handle:hover { fill: var(--vscode-list-hoverBackground); }
    .issue-bar.dragging .bar-main { opacity: 0.5; }
    .weekend-bg { fill: var(--vscode-editor-inactiveSelectionBackground); opacity: 0.3; }
    .day-grid { stroke: var(--vscode-editorRuler-foreground); stroke-width: 0.5; opacity: 0.3; }
    .date-marker { stroke: var(--vscode-editorRuler-foreground); stroke-dasharray: 2,2; }
    .today-marker { stroke: var(--vscode-charts-red); stroke-width: 2; }
  </style>
</head>
<body>
  <div class="gantt-header">
    <h2>Timeline</h2>
    <div class="gantt-actions">
      <button id="undoBtn" disabled title="Undo (Ctrl+Z)">↩ Undo</button>
      <button id="redoBtn" disabled title="Redo (Ctrl+Shift+Z)">↪ Redo</button>
    </div>
  </div>
  <div class="gantt-container">
    <div class="gantt-labels" id="ganttLabels">
      <svg width="${labelWidth}" height="${svgHeight}">
        ${labels}
      </svg>
    </div>
    <div class="gantt-resize-handle" id="resizeHandle"></div>
    <div class="gantt-timeline">
      <svg width="${timelineWidth}" height="${svgHeight}">
        ${dateMarkers}
        ${bars}
      </svg>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const timelineWidth = ${timelineWidth};
    const minDateMs = ${minDate.getTime()};
    const maxDateMs = ${maxDate.getTime()};

    // Restore state from previous session
    const previousState = vscode.getState() || { undoStack: [], redoStack: [], labelWidth: ${labelWidth} };
    const undoStack = previousState.undoStack || [];
    const redoStack = previousState.redoStack || [];
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');

    function saveState() {
      vscode.setState({ undoStack, redoStack, labelWidth: labelsColumn?.offsetWidth || ${labelWidth} });
    }

    function updateUndoRedoButtons() {
      undoBtn.disabled = undoStack.length === 0;
      redoBtn.disabled = redoStack.length === 0;
      saveState();
    }

    // Apply saved label width
    const labelsColumn = document.getElementById('ganttLabels');
    if (previousState.labelWidth && labelsColumn) {
      labelsColumn.style.width = previousState.labelWidth + 'px';
    }

    // Initial button state
    updateUndoRedoButtons();

    // Convert x position to date string (YYYY-MM-DD)
    function xToDate(x) {
      const ms = minDateMs + (x / timelineWidth) * (maxDateMs - minDateMs);
      const d = new Date(ms);
      return d.toISOString().slice(0, 10);
    }

    // Drag state
    let dragState = null;

    // Handle drag start on handles
    document.querySelectorAll('.drag-handle').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        const bar = handle.closest('.issue-bar');
        const isLeft = handle.classList.contains('drag-left');
        const issueId = parseInt(bar.dataset.issueId);
        const startX = parseFloat(bar.dataset.startX);
        const endX = parseFloat(bar.dataset.endX);
        const oldStartDate = bar.dataset.startDate || null;
        const oldDueDate = bar.dataset.dueDate || null;
        const barMain = bar.querySelector('.bar-main');
        const leftHandle = bar.querySelector('.drag-left');
        const rightHandle = bar.querySelector('.drag-right');

        bar.classList.add('dragging');
        dragState = {
          issueId,
          isLeft,
          initialMouseX: e.clientX,
          startX,
          endX,
          oldStartDate,
          oldDueDate,
          barMain,
          leftHandle,
          rightHandle,
          bar
        };
      });
    });

    // Handle click on bar (open issue) - only if not dragging
    document.querySelectorAll('.issue-bar .bar-main').forEach(bar => {
      bar.addEventListener('click', (e) => {
        if (dragState) return;
        const issueId = parseInt(bar.closest('.issue-bar').dataset.issueId);
        vscode.postMessage({ command: 'openIssue', issueId });
      });
    });

    // Labels click
    document.querySelectorAll('.issue-label').forEach(el => {
      el.addEventListener('click', () => {
        const issueId = parseInt(el.dataset.issueId);
        vscode.postMessage({ command: 'openIssue', issueId });
      });
    });

    // Handle drag move
    document.addEventListener('mousemove', (e) => {
      if (!dragState) return;
      const delta = e.clientX - dragState.initialMouseX;
      let newStartX = dragState.startX;
      let newEndX = dragState.endX;

      if (dragState.isLeft) {
        newStartX = Math.max(0, Math.min(dragState.startX + delta, dragState.endX - 20));
      } else {
        newEndX = Math.max(dragState.startX + 20, Math.min(dragState.endX + delta, timelineWidth));
      }

      // Update visual
      const width = newEndX - newStartX;
      dragState.barMain.setAttribute('x', newStartX);
      dragState.barMain.setAttribute('width', width);
      dragState.leftHandle.setAttribute('x', newStartX);
      dragState.rightHandle.setAttribute('x', newEndX - 8);
      dragState.newStartX = newStartX;
      dragState.newEndX = newEndX;
    });

    // Handle drag end
    document.addEventListener('mouseup', () => {
      if (!dragState) return;
      const { issueId, isLeft, newStartX, newEndX, bar, startX, endX, oldStartDate, oldDueDate } = dragState;
      bar.classList.remove('dragging');

      // Only update if position changed
      if (newStartX !== undefined || newEndX !== undefined) {
        const newStartDate = isLeft && newStartX !== startX ? xToDate(newStartX) : null;
        const newDueDate = !isLeft && newEndX !== endX ? xToDate(newEndX) : null;

        if (newStartDate || newDueDate) {
          // Push to undo stack before making change
          undoStack.push({
            issueId,
            oldStartDate: newStartDate ? oldStartDate : null,
            oldDueDate: newDueDate ? oldDueDate : null,
            newStartDate,
            newDueDate
          });
          redoStack.length = 0; // Clear redo stack on new action
          updateUndoRedoButtons();
          vscode.postMessage({ command: 'updateDates', issueId, startDate: newStartDate, dueDate: newDueDate });
        }
      }
      dragState = null;
    });

    // Undo button
    undoBtn.addEventListener('click', () => {
      if (undoStack.length === 0) return;
      const action = undoStack.pop();
      redoStack.push(action);
      updateUndoRedoButtons();
      vscode.postMessage({
        command: 'updateDates',
        issueId: action.issueId,
        startDate: action.oldStartDate,
        dueDate: action.oldDueDate
      });
    });

    // Redo button
    redoBtn.addEventListener('click', () => {
      if (redoStack.length === 0) return;
      const action = redoStack.pop();
      undoStack.push(action);
      updateUndoRedoButtons();
      vscode.postMessage({
        command: 'updateDates',
        issueId: action.issueId,
        startDate: action.newStartDate,
        dueDate: action.newDueDate
      });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modKey = isMac ? e.metaKey : e.ctrlKey;

      if (modKey && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undoBtn.click();
      } else if (modKey && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        redoBtn.click();
      } else if (modKey && e.key === 'y') {
        e.preventDefault();
        redoBtn.click();
      }
    });

    // Auto-scroll to today marker (centered)
    const timeline = document.querySelector('.gantt-timeline');
    const todayX = ${Math.round(todayX)};
    if (timeline && todayX > 0) {
      const containerWidth = timeline.clientWidth;
      timeline.scrollLeft = Math.max(0, todayX - containerWidth / 2);
    }

    // Column resize handling
    const resizeHandle = document.getElementById('resizeHandle');
    let isResizing = false;
    let resizeStartX = 0;
    let resizeStartWidth = 0;

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      resizeStartX = e.clientX;
      resizeStartWidth = labelsColumn.offsetWidth;
      resizeHandle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const delta = e.clientX - resizeStartX;
      const newWidth = Math.min(500, Math.max(150, resizeStartWidth + delta));
      labelsColumn.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        resizeHandle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        saveState(); // Persist new column width
      }
    });
  </script>
</body>
</html>`;
  }

  private _getEmptyHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>Redmine Gantt</title>
  <style>
    body {
      padding: 20px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
    }
  </style>
</head>
<body>
  <h2>Timeline</h2>
  <p>No issues with dates to display. Add start_date or due_date to your issues.</p>
</body>
</html>`;
  }

  private _getStatusColor(
    status: FlexibilityScore["status"] | null
  ): string {
    switch (status) {
      case "overbooked":
        return "var(--vscode-charts-red)";
      case "at-risk":
        return "var(--vscode-charts-orange)";
      case "on-track":
        return "var(--vscode-charts-green)";
      case "completed":
        return "var(--vscode-charts-blue)";
      default:
        return "var(--vscode-charts-foreground)";
    }
  }

  private _generateDateMarkers(
    minDate: Date,
    maxDate: Date,
    svgWidth: number,
    leftMargin: number
  ): string {
    const backgrounds: string[] = [];
    const weekHeaders: string[] = [];
    const dayHeaders: string[] = [];
    const markers: string[] = [];
    const current = new Date(minDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dayWidth =
      (svgWidth - leftMargin) /
      ((maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24));

    while (current <= maxDate) {
      const x =
        leftMargin +
        ((current.getTime() - minDate.getTime()) /
          (maxDate.getTime() - minDate.getTime())) *
          (svgWidth - leftMargin);

      // Weekend backgrounds (Saturday=6, Sunday=0)
      const dayOfWeek = current.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        backgrounds.push(`
          <rect x="${x}" y="0" width="${dayWidth}" height="100%" class="weekend-bg"/>
        `);
      }

      // Week header (top row) - show at start of each week (Monday)
      if (dayOfWeek === 1) {
        const weekNum = getWeekNumber(current);
        const year = current.getFullYear();
        // Calculate week end (Sunday)
        const weekEnd = new Date(current);
        weekEnd.setDate(weekEnd.getDate() + 6);
        const startDay = current.getDate();
        const startMonth = current.toLocaleString("en", { month: "short" });
        const endDay = weekEnd.getDate();
        const endMonth = weekEnd.toLocaleString("en", { month: "short" });
        const dateRange = startMonth === endMonth
          ? `${startDay} - ${endDay} ${endMonth}`
          : `${startDay} ${startMonth} - ${endDay} ${endMonth}`;
        weekHeaders.push(`
          <line x1="${x}" y1="0" x2="${x}" y2="100%" class="date-marker"/>
          <text x="${x + 4}" y="14" fill="var(--vscode-foreground)" font-size="11" font-weight="bold">W${weekNum} (${dateRange}), ${year}</text>
        `);
      }

      // Day grid line (subtle vertical separator)
      dayHeaders.push(`
        <line x1="${x}" y1="35" x2="${x}" y2="100%" class="day-grid"/>
      `);

      // Day header (bottom row) - show day number and weekday
      const dayLabel = `${current.getDate()} ${WEEKDAYS_SHORT[dayOfWeek]}`;
      dayHeaders.push(`
        <text x="${x + dayWidth / 2}" y="30" fill="var(--vscode-descriptionForeground)" font-size="10" text-anchor="middle">${dayLabel}</text>
      `);

      // Today marker
      if (current.toDateString() === today.toDateString()) {
        markers.push(`
          <line x1="${x}" y1="0" x2="${x}" y2="100%" class="today-marker"/>
        `);
      }

      current.setDate(current.getDate() + 1);
    }

    // Backgrounds first, then headers, then today marker
    return backgrounds.join("") + weekHeaders.join("") + dayHeaders.join("") + markers.join("");
  }
}

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
