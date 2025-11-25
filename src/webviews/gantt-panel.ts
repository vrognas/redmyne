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

function formatDateWithWeekday(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return `${dateStr} (${WEEKDAYS[d.getDay()]})`;
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

    const svgWidth = Math.max(800, totalDays * 20);
    const barHeight = 30;
    const barGap = 10;
    const headerHeight = 40;
    const leftMargin = 200;
    const svgHeight = headerHeight + this._issues.length * (barHeight + barGap);

    const bars = this._issues
      .map((issue, index) => {
        const start = issue.start_date
          ? new Date(issue.start_date)
          : new Date(issue.due_date!);
        const end = issue.due_date
          ? new Date(issue.due_date)
          : new Date(issue.start_date!);

        const startX =
          leftMargin +
          ((start.getTime() - minDate.getTime()) /
            (maxDate.getTime() - minDate.getTime())) *
            (svgWidth - leftMargin);
        const endX =
          leftMargin +
          ((end.getTime() - minDate.getTime()) /
            (maxDate.getTime() - minDate.getTime())) *
            (svgWidth - leftMargin);

        const width = Math.max(10, endX - startX);
        const y = headerHeight + index * (barHeight + barGap);
        const color = this._getStatusColor(issue.status);

        const truncatedSubject =
          issue.subject.length > 25
            ? issue.subject.substring(0, 22) + "..."
            : issue.subject;

        const estHours = issue.estimated_hours !== null ? `${issue.estimated_hours}h` : "—";
        const spentHours = issue.spent_hours !== null ? `${issue.spent_hours}h` : "—";
        const tooltip = [
          `#${issue.id} ${issue.subject}`,
          `Project: ${issue.project}`,
          `Start: ${formatDateWithWeekday(issue.start_date)}`,
          `Due: ${formatDateWithWeekday(issue.due_date)}`,
          `Estimated: ${estHours}`,
          `Spent: ${spentHours}`,
        ].join("\n");

        return `
          <g class="issue-bar" data-issue-id="${issue.id}" style="cursor: pointer;">
            <text x="5" y="${y + barHeight / 2 + 5}" fill="var(--vscode-foreground)" font-size="12">
              #${issue.id} ${truncatedSubject}
            </text>
            <rect x="${startX}" y="${y}" width="${width}" height="${barHeight}"
                  fill="${color}" rx="4" ry="4" opacity="0.8"/>
            <title>${tooltip}</title>
          </g>
        `;
      })
      .join("");

    // Date markers
    const dateMarkers = this._generateDateMarkers(
      minDate,
      maxDate,
      svgWidth,
      leftMargin
    );

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
      overflow: auto;
    }
    h2 { margin-bottom: 16px; }
    svg { display: block; }
    .issue-bar:hover rect { opacity: 1; }
    .date-marker { stroke: var(--vscode-editorRuler-foreground); stroke-dasharray: 2,2; }
    .today-marker { stroke: var(--vscode-charts-red); stroke-width: 2; }
  </style>
</head>
<body>
  <h2>Timeline</h2>
  <svg width="${svgWidth}" height="${svgHeight}">
    ${dateMarkers}
    ${bars}
  </svg>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('.issue-bar').forEach(bar => {
      bar.addEventListener('click', () => {
        const issueId = parseInt(bar.dataset.issueId);
        vscode.postMessage({ command: 'openIssue', issueId });
      });
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
    const markers: string[] = [];
    const current = new Date(minDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    while (current <= maxDate) {
      const x =
        leftMargin +
        ((current.getTime() - minDate.getTime()) /
          (maxDate.getTime() - minDate.getTime())) *
          (svgWidth - leftMargin);

      // Weekly markers
      if (current.getDay() === 1) {
        const label = `${current.getMonth() + 1}/${current.getDate()}`;
        markers.push(`
          <line x1="${x}" y1="0" x2="${x}" y2="100%" class="date-marker"/>
          <text x="${x + 2}" y="12" fill="var(--vscode-descriptionForeground)" font-size="10">${label}</text>
        `);
      }

      // Today marker
      if (current.toDateString() === today.toDateString()) {
        markers.push(`
          <line x1="${x}" y1="0" x2="${x}" y2="100%" class="today-marker"/>
        `);
      }

      current.setDate(current.getDate() + 1);
    }

    return markers.join("");
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
