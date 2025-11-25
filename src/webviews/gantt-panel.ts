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
  estimated_hours: number | null;
  spent_hours: number | null;
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
    const column = vscode.ViewColumn.Beside;

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
        estimated_hours: i.estimated_hours ?? null,
        spent_hours: i.spent_hours ?? null,
      }));

    this._updateContent();
  }

  private _updateContent(): void {
    this._panel.webview.html = this._getHtmlContent();
  }

  private _handleMessage(message: { command: string; issueId?: number }): void {
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

    const timelineWidth = Math.max(600, totalDays * 20);
    const labelWidth = 200;
    const barHeight = 30;
    const barGap = 10;
    const headerHeight = 40;
    const contentHeight = this._issues.length * (barHeight + barGap);

    // Left labels (fixed column)
    const labels = this._issues
      .map((issue, index) => {
        const y = headerHeight + index * (barHeight + barGap);
        const truncatedSubject =
          issue.subject.length > 22
            ? issue.subject.substring(0, 19) + "..."
            : issue.subject;

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
            <text x="5" y="${y + barHeight / 2 + 5}" fill="var(--vscode-foreground)" font-size="12">
              #${issue.id} ${truncatedSubject}
            </text>
            <title>${tooltip}</title>
          </g>
        `;
      })
      .join("");

    // Right bars (scrollable timeline)
    const bars = this._issues
      .map((issue, index) => {
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

        return `
          <g class="issue-bar" data-issue-id="${issue.id}" style="cursor: pointer;">
            <rect x="${startX}" y="${y}" width="${width}" height="${barHeight}"
                  fill="${color}" rx="4" ry="4" opacity="0.8"/>
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
    h2 { margin-bottom: 16px; }
    .gantt-container {
      display: flex;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
    }
    .gantt-labels {
      flex-shrink: 0;
      width: ${labelWidth}px;
      background: var(--vscode-editor-background);
      border-right: 1px solid var(--vscode-panel-border);
      z-index: 1;
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
    .issue-bar:hover rect, .issue-label:hover { opacity: 0.8; }
    .weekend-bg { fill: var(--vscode-editor-inactiveSelectionBackground); opacity: 0.3; }
    .date-marker { stroke: var(--vscode-editorRuler-foreground); stroke-dasharray: 2,2; }
    .today-marker { stroke: var(--vscode-charts-red); stroke-width: 2; }
  </style>
</head>
<body>
  <h2>Timeline</h2>
  <div class="gantt-container">
    <div class="gantt-labels">
      <svg width="${labelWidth}" height="${svgHeight}">
        ${labels}
      </svg>
    </div>
    <div class="gantt-timeline">
      <svg width="${timelineWidth}" height="${svgHeight}">
        ${dateMarkers}
        ${bars}
      </svg>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('.issue-bar, .issue-label').forEach(el => {
      el.addEventListener('click', () => {
        const issueId = parseInt(el.dataset.issueId);
        vscode.postMessage({ command: 'openIssue', issueId });
      });
    });
    // Auto-scroll to today marker (centered)
    const timeline = document.querySelector('.gantt-timeline');
    const todayX = ${Math.round(todayX)};
    if (timeline && todayX > 0) {
      const containerWidth = timeline.clientWidth;
      timeline.scrollLeft = Math.max(0, todayX - containerWidth / 2);
    }
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

      // Day header (bottom row) - show day number and weekday
      const dayLabel = `${current.getDate()} ${WEEKDAYS_SHORT[dayOfWeek]}`;
      dayHeaders.push(`
        <text x="${x + dayWidth / 2}" y="30" fill="var(--vscode-descriptionForeground)" font-size="9" text-anchor="middle">${dayLabel}</text>
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
