/**
 * Draft Review Panel
 * Webview panel to review, apply, and discard pending drafts
 *
 * UX improvements:
 * - Incremental DOM updates via postMessage (no full HTML regeneration)
 * - Loading/processing states with visual feedback
 * - Confirmation dialog for Discard All
 * - Per-row apply button
 * - Sticky header
 * - Keyboard navigation (Arrow keys, Enter, Delete, Tab)
 */

import * as vscode from "vscode";
import type { DraftQueue } from "./draft-queue";
import type { DraftOperation } from "./draft-operation";

export class DraftReviewPanel implements vscode.Disposable {
  public static currentPanel: DraftReviewPanel | undefined;
  private static readonly viewType = "redmyneDraftReview";

  private readonly panel: vscode.WebviewPanel;
  private readonly queue: DraftQueue;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private lastOperationIds: Set<string> = new Set();
  private disposed = false;

  public static createOrShow(queue: DraftQueue, extensionUri: vscode.Uri): DraftReviewPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (DraftReviewPanel.currentPanel) {
      DraftReviewPanel.currentPanel.panel.reveal(column);
      DraftReviewPanel.currentPanel.update();
      return DraftReviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      DraftReviewPanel.viewType,
      "Draft Review",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );

    DraftReviewPanel.currentPanel = new DraftReviewPanel(panel, queue, extensionUri);
    return DraftReviewPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel, queue: DraftQueue, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.queue = queue;
    this.extensionUri = extensionUri;

    // Initial render
    this.panel.webview.html = this.getHtmlForWebview(this.queue.getAll());
    this.lastOperationIds = new Set(this.queue.getAll().map(op => op.id));

    // Listen for queue changes - send incremental updates
    this.disposables.push(
      this.queue.onDidChange(() => this.sendIncrementalUpdate())
    );

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "applyAll":
            await this.handleApplyAll();
            break;
          case "applyDraft":
            await this.handleApplyDraft(message.id);
            break;
          case "discardAll":
            await this.handleDiscardAll();
            break;
          case "removeDraft":
            await vscode.commands.executeCommand("redmyne.removeDraft", message.id);
            break;
        }
      },
      null,
      this.disposables
    );

    // Handle panel disposal
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async handleApplyAll(): Promise<void> {
    if (this.disposed) return;
    this.panel.webview.postMessage({ command: "setLoading", loading: true, action: "applyAll" });
    try {
      await vscode.commands.executeCommand("redmyne.applyDrafts");
    } finally {
      if (this.disposed) return;
      this.panel.webview.postMessage({ command: "setLoading", loading: false });
    }
  }

  private async handleApplyDraft(id: string): Promise<void> {
    if (this.disposed) return;
    this.panel.webview.postMessage({ command: "setRowLoading", id, loading: true });
    try {
      await vscode.commands.executeCommand("redmyne.applySingleDraft", id);
    } finally {
      if (this.disposed) return;
      this.panel.webview.postMessage({ command: "setRowLoading", id, loading: false });
    }
  }

  private async handleDiscardAll(): Promise<void> {
    if (this.disposed) return;
    // Command already shows confirmation modal
    this.panel.webview.postMessage({ command: "setLoading", loading: true, action: "discardAll" });
    try {
      await vscode.commands.executeCommand("redmyne.discardDrafts");
    } finally {
      if (this.disposed) return;
      this.panel.webview.postMessage({ command: "setLoading", loading: false });
    }
  }

  private sendIncrementalUpdate(): void {
    const operations = this.queue.getAll();
    const currentIds = new Set(operations.map(op => op.id));


    // Always send update since this handler is only called when queue actually changes.
    // Covers additions, removals, AND in-place updates (same ID, different content).
    this.panel.webview.postMessage({
      command: "updateOperations",
      operations: operations.map(op => ({
        id: op.id,
        type: op.type,
        description: op.description,
        issueId: op.issueId,
        timestamp: op.timestamp,
        http: op.http,
      })),
      count: operations.length,
    });

    this.lastOperationIds = currentIds;
  }


  public update(): void {
    const operations = this.queue.getAll();
    this.panel.webview.postMessage({
      command: "updateOperations",
      operations: operations.map(op => ({
        id: op.id,
        type: op.type,
        description: op.description,
        issueId: op.issueId,
        timestamp: op.timestamp,
        http: op.http,
      })),
      count: operations.length,
    });
    this.lastOperationIds = new Set(operations.map(op => op.id));
  }

  private getHtmlForWebview(operations: DraftOperation[]): string {
    const nonce = getNonce();
    const webview = this.panel.webview;
    const commonCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview-common.css")
    );

    const operationRows = operations.map((op) => {
      const httpMethod = op.http?.method || "";
      const httpPath = op.http?.path || "";
      const httpDataJson = op.http?.data ? JSON.stringify(op.http.data) : "";
      const apiCellContent = op.http
        ? `<span class="api-method ${escapeHtml(httpMethod)}">${escapeHtml(httpMethod)}</span><span class="api-path">${escapeHtml(httpPath)}</span>`
        : "-";
      const changesPreview = formatChangesPreview(op.http?.data);
      return `
      <tr data-id="${escapeHtml(op.id)}" tabindex="0">
        <td class="type"><span class="type-pill" data-type="${escapeHtml(op.type.toLowerCase())}">${escapeHtml(op.type)}</span></td>
        <td class="description">
          <div class="desc-text">${escapeHtml(op.description)}</div>
          ${changesPreview ? `<div class="changes-preview">${changesPreview}</div>` : ""}
        </td>
        <td class="api-call" data-method="${escapeHtml(httpMethod)}" data-path="${escapeHtml(httpPath)}" data-body="${escapeHtml(httpDataJson)}">${apiCellContent}</td>
        <td class="issue">${op.issueId ? `#${op.issueId}` : "-"}</td>
        <td class="time">${formatTime(op.timestamp)}</td>
        <td class="actions">
          <button class="icon-btn apply-btn" data-id="${escapeHtml(op.id)}" title="Apply (Enter)">✓</button>
          <button class="icon-btn remove-btn" data-id="${escapeHtml(op.id)}" title="Remove (⌫)">✕</button>
          <span class="row-spinner" style="display:none;"></span>
        </td>
      </tr>
    `;
    }).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Draft Review</title>
  <link rel="stylesheet" href="${commonCssUri}">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
      margin: 0;
    }
    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
    }
    .header-left { display: flex; flex-direction: column; gap: 6px; }
    .header-left h1 {
      margin: 0;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-foreground);
    }
    .count {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .count-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: 9px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 11px;
      font-weight: 600;
    }
    .actions-bar { display: flex; gap: 8px; align-items: center; }
    /* Buttons */
    .spinner {
      display: none;
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-button-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    .loading .spinner { display: inline-block; margin-right: 6px; }
    .loading .btn-text { opacity: 0.7; }
    @keyframes spin { to { transform: rotate(360deg); } }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 5px 12px;
      cursor: pointer;
      border-radius: 3px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      transition: background 0.1s, opacity 0.1s;
    }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    /* Table */
    .table-container {
      max-height: calc(100vh - 150px);
      overflow-y: auto;
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
    }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground, rgba(128,128,128,0.1));
    }
    th {
      font-weight: 500;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background));
      position: sticky;
      top: 0;
      z-index: 5;
    }
    tbody tr { outline: none; transition: background 0.1s ease-out; }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    tbody tr:focus, tbody tr.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    tbody tr:focus { box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
    tbody tr:last-child td { border-bottom: none; }
    /* Type pill */
    .type { width: 90px; }
    .type-pill {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 10px;
      font-weight: 500;
      text-transform: capitalize;
      background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.1));
      color: var(--vscode-descriptionForeground);
    }
    .type-pill[data-type="create"] {
      background: color-mix(in srgb, var(--vscode-charts-green, #4caf50) 15%, transparent);
      color: var(--vscode-charts-green, #4caf50);
    }
    .type-pill[data-type="update"] {
      background: color-mix(in srgb, var(--vscode-charts-blue, #2196f3) 15%, transparent);
      color: var(--vscode-charts-blue, #2196f3);
    }
    .type-pill[data-type="delete"] {
      background: color-mix(in srgb, var(--vscode-charts-red, #f44336) 15%, transparent);
      color: var(--vscode-charts-red, #f44336);
    }
    .description { min-width: 180px; font-size: 12px; }
    .desc-text { margin-bottom: 2px; }
    .changes-preview {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      line-height: 1.4;
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-badge-background) 30%, transparent);
      border: 1px solid color-mix(in srgb, var(--vscode-badge-background) 50%, transparent);
      padding: 4px 8px;
      border-radius: 4px;
      margin-top: 6px;
      display: inline-block;
    }
    .changes-preview .change-key { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); font-weight: 500; }
    .changes-preview .change-val { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
    .changes-preview .change-num { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); font-weight: 500; }
    .issue {
      width: 60px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      color: var(--vscode-textLink-foreground);
    }
    /* API call */
    .api-call {
      width: 200px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      cursor: help;
    }
    .api-method {
      display: inline-block;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.02em;
      margin-right: 5px;
      vertical-align: middle;
    }
    .api-method.GET {
      background: color-mix(in srgb, var(--vscode-charts-blue, #61afef) 20%, transparent);
      color: var(--vscode-charts-blue, #61afef);
    }
    .api-method.POST {
      background: color-mix(in srgb, var(--vscode-charts-green, #98c379) 20%, transparent);
      color: var(--vscode-charts-green, #98c379);
    }
    .api-method.PUT {
      background: color-mix(in srgb, var(--vscode-charts-orange, #d19a66) 20%, transparent);
      color: var(--vscode-charts-orange, #d19a66);
    }
    .api-method.DELETE {
      background: color-mix(in srgb, var(--vscode-charts-red, #e06c75) 20%, transparent);
      color: var(--vscode-charts-red, #e06c75);
    }
    .api-path { color: var(--vscode-descriptionForeground); word-break: break-all; vertical-align: middle; }
    .time { width: 70px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    /* Actions */
    .actions { width: 60px; text-align: right; white-space: nowrap; }
    .icon-btn {
      background: transparent;
      padding: 3px;
      font-size: 12px;
      min-width: 22px;
      height: 22px;
      border-radius: 3px;
      opacity: 0;
      transition: opacity 0.1s, background 0.1s, color 0.1s;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--vscode-foreground);
    }
    tbody tr:hover .icon-btn, tbody tr:focus .icon-btn, tbody tr.selected .icon-btn { opacity: 0.6; }
    .icon-btn:hover:not(:disabled) { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    .icon-btn:focus { opacity: 1; outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .apply-btn:hover:not(:disabled) { color: var(--vscode-testing-iconPassed, #73c991); }
    .remove-btn:hover:not(:disabled) { color: var(--vscode-testing-iconFailed, #f14c4c); }
    .row-spinner {
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-descriptionForeground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      display: none;
    }
    tr.row-loading .icon-btn { display: none; }
    tr.row-loading .row-spinner { display: inline-block !important; }
    tr.row-loading { animation: row-pulse 1s ease-in-out infinite; }
    @keyframes row-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
    /* Empty state */
    .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 180px;
      padding: 40px 24px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
    .empty-icon {
      width: 40px;
      height: 40px;
      margin-bottom: 12px;
      opacity: 0.35;
      color: var(--vscode-descriptionForeground);
    }
    .empty-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--vscode-foreground);
      margin-bottom: 6px;
    }
    .empty-description {
      font-size: 12px;
      line-height: 1.5;
      max-width: 260px;
    }
    /* Keyboard hints */
    .keyboard-hint {
      display: flex;
      justify-content: center;
      gap: 14px;
      padding: 10px 0;
      margin-top: 8px;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
    }
    .hint-group {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 4px;
      background: var(--vscode-keybindingLabel-background);
      color: var(--vscode-keybindingLabel-foreground);
      border: 1px solid var(--vscode-keybindingLabel-border);
      border-bottom-width: 2px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 10px;
      font-weight: 500;
    }
    /* Tooltip */
    #api-tooltip { max-width: 400px; }
    #api-tooltip.visible { animation: tooltip-enter 0.1s ease-out; }
    @keyframes tooltip-enter { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
    #api-tooltip .webview-tooltip-title { font-family: var(--vscode-editor-font-family); font-size: 12px; }
    #api-tooltip .webview-tooltip-body {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      white-space: pre-wrap;
      max-height: 180px;
      overflow-y: auto;
      line-height: 1.4;
    }
    /* Row animations */
    @keyframes row-enter { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
    tbody tr.entering { animation: row-enter 0.2s ease-out; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>Pending Drafts</h1>
      <span class="count">
        <span class="count-badge" id="count-badge">${operations.length}</span>
        <span id="count-text">${operations.length === 1 ? "change queued" : "changes queued"}</span>
      </span>
    </div>
    <div class="actions-bar">
      <button id="apply-all" ${operations.length === 0 ? "disabled" : ""}>
        <span class="spinner"></span>
        <span class="btn-text">Apply All</span>
      </button>
      <button id="discard-all" class="secondary" ${operations.length === 0 ? "disabled" : ""}>
        <span class="spinner"></span>
        <span class="btn-text">Discard All</span>
      </button>
    </div>
  </div>

  <div id="content">
    ${operations.length === 0 ? `
      <div class="empty">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
        </svg>
        <div class="empty-title">No pending drafts</div>
        <div class="empty-description">Changes you make while in draft mode will be queued here for review.</div>
      </div>
    ` : `
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Description</th>
              <th>API Call</th>
              <th>Issue</th>
              <th>Time</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="operations-body">
            ${operationRows}
          </tbody>
        </table>
      </div>
      <div class="keyboard-hint">
        <span class="hint-group"><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
        <span class="hint-group"><kbd>Enter</kbd> Apply</span>
        <span class="hint-group"><kbd>⌫</kbd> Remove</span>
      </div>
    `}
  </div>

  <div id="api-tooltip" class="webview-tooltip webview-tooltip--static">
    <div class="webview-tooltip-title"></div>
    <div class="webview-tooltip-divider"></div>
    <div class="webview-tooltip-body"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let selectedIndex = -1;
    let operations = ${JSON.stringify(operations.map(op => ({
      id: op.id,
      type: op.type,
      description: op.description,
      issueId: op.issueId,
      timestamp: op.timestamp,
      http: op.http,
    })))};

    // API tooltip hover
    const tooltip = document.getElementById('api-tooltip');
    const tooltipHeader = tooltip.querySelector('.webview-tooltip-title');
    const tooltipBody = tooltip.querySelector('.webview-tooltip-body');
    let tooltipTimeout = null;

    document.addEventListener('mouseover', (e) => {
      const apiCell = e.target.closest('.api-call');
      if (apiCell && apiCell.dataset.method) {
        clearTimeout(tooltipTimeout);
        const method = apiCell.dataset.method || '';
        const path = apiCell.dataset.path || '';
        const bodyStr = apiCell.dataset.body || '';

        tooltipHeader.textContent = method + ' ' + path;
        if (bodyStr) {
          try {
            tooltipBody.textContent = JSON.stringify(JSON.parse(bodyStr), null, 2);
          } catch { tooltipBody.textContent = bodyStr; }
        } else {
          tooltipBody.textContent = '(no body)';
        }

        const rect = apiCell.getBoundingClientRect();
        tooltip.style.left = rect.left + 'px';
        tooltip.style.top = (rect.bottom + 6) + 'px';
        tooltip.classList.add('visible');
      }
    });

    document.addEventListener('mouseout', (e) => {
      const apiCell = e.target.closest('.api-call');
      if (apiCell) {
        tooltipTimeout = setTimeout(() => {
          tooltip.classList.remove('visible');
        }, 100);
      }
    });

    // Event delegation for buttons
    document.addEventListener('click', (e) => {
      const target = e.target.closest('button');
      if (!target) return;

      if (target.id === 'apply-all') {
        vscode.postMessage({ command: 'applyAll' });
      } else if (target.id === 'discard-all') {
        vscode.postMessage({ command: 'discardAll' });
      } else if (target.classList.contains('apply-btn')) {
        vscode.postMessage({ command: 'applyDraft', id: target.dataset.id });
      } else if (target.classList.contains('remove-btn')) {
        vscode.postMessage({ command: 'removeDraft', id: target.dataset.id });
      }
    });

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      const rows = document.querySelectorAll('#operations-body tr');
      if (rows.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, rows.length - 1);
        focusRow(rows, selectedIndex);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        focusRow(rows, selectedIndex);
      } else if (e.key === 'Enter' && selectedIndex >= 0) {
        e.preventDefault();
        const row = rows[selectedIndex];
        const id = row?.dataset.id;
        if (id) vscode.postMessage({ command: 'applyDraft', id });
      } else if (e.key === 'Backspace' && selectedIndex >= 0) {
        e.preventDefault();
        const row = rows[selectedIndex];
        const id = row?.dataset.id;
        if (id) vscode.postMessage({ command: 'removeDraft', id });
      }
    });

    // Row click to select
    document.addEventListener('click', (e) => {
      const row = e.target.closest('#operations-body tr');
      if (row && !e.target.closest('button')) {
        const rows = document.querySelectorAll('#operations-body tr');
        selectedIndex = Array.from(rows).indexOf(row);
        focusRow(rows, selectedIndex);
      }
    });

    function focusRow(rows, index) {
      rows.forEach((r, i) => {
        r.classList.toggle('selected', i === index);
        if (i === index) r.focus();
      });
    }

    function formatTime(timestamp) {
      const date = new Date(timestamp);
      const now = new Date();
      if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    function escapeHtml(unsafe) {
      return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function formatChangesPreview(data) {
      if (!data) return '';
      const entries = Object.entries(data);
      if (entries.length === 0) return '';
      const innerData = entries[0][1];
      if (!innerData || typeof innerData !== 'object') return '';
      const fields = innerData;
      const parts = [];
      const fieldLabels = {
        hours: 'hours', comments: 'comment', activity_id: 'activity',
        issue_id: 'issue', spent_on: 'date', status_id: 'status',
        done_ratio: 'progress', priority_id: 'priority', assigned_to_id: 'assignee',
        start_date: 'start', due_date: 'due', subject: 'subject', description: 'desc'
      };
      const priorityFields = ['hours', 'comments', 'subject', 'status_id', 'done_ratio', 'start_date', 'due_date'];
      const sortedKeys = [
        ...priorityFields.filter(k => k in fields),
        ...Object.keys(fields).filter(k => !priorityFields.includes(k) && k in fieldLabels)
      ];
      for (const key of sortedKeys.slice(0, 3)) {
        const label = fieldLabels[key] || key;
        const value = fields[key];
        if (value === null || value === undefined) continue;
        let formatted;
        if (typeof value === 'string') {
          const truncated = value.length > 30 ? value.slice(0, 27) + '...' : value;
          formatted = '<span class="change-key">' + escapeHtml(label) + '</span>: <span class="change-val">"' + escapeHtml(truncated) + '"</span>';
        } else if (typeof value === 'number') {
          formatted = '<span class="change-key">' + escapeHtml(label) + '</span>: <span class="change-num">' + value + '</span>';
        } else continue;
        parts.push(formatted);
      }
      return parts.join(' · ');
    }

    function renderOperations(ops) {
      operations = ops;
      const content = document.getElementById('content');
      const countEl = document.getElementById('count');
      const applyBtn = document.getElementById('apply-all');
      const discardBtn = document.getElementById('discard-all');

      // Update count badge
      const countBadge = document.getElementById('count-badge');
      const countText = document.getElementById('count-text');
      if (countBadge) {
        countBadge.textContent = ops.length;
      }
      if (countText) {
        countText.textContent = ops.length === 1 ? 'change queued' : 'changes queued';
      }
      applyBtn.disabled = ops.length === 0;
      discardBtn.disabled = ops.length === 0;

      if (ops.length === 0) {
        // Empty state - use safe DOM construction
        content.replaceChildren();
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'empty';
        emptyDiv.innerHTML = '<svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg><div class="empty-title">No pending drafts</div><div class="empty-description">Changes you make while in draft mode will be queued here for review.</div>';
        content.appendChild(emptyDiv);
        selectedIndex = -1;
        return;
      }

      const rows = ops.map(op => {
        const httpMethod = op.http ? op.http.method : '';
        const httpPath = op.http ? op.http.path : '';
        const httpDataJson = op.http && op.http.data ? JSON.stringify(op.http.data) : '';
        const apiCellContent = op.http
          ? '<span class="api-method ' + escapeHtml(httpMethod) + '">' + escapeHtml(httpMethod) + '</span><span class="api-path">' + escapeHtml(httpPath) + '</span>'
          : '-';
        const changesPreview = formatChangesPreview(op.http ? op.http.data : null);
        const changesHtml = changesPreview ? '<div class="changes-preview">' + changesPreview + '</div>' : '';
        return '<tr data-id="' + escapeHtml(op.id) + '" tabindex="0">' +
          '<td class="type"><span class="type-pill" data-type="' + escapeHtml(op.type.toLowerCase()) + '">' + escapeHtml(op.type) + '</span></td>' +
          '<td class="description"><div class="desc-text">' + escapeHtml(op.description) + '</div>' + changesHtml + '</td>' +
          '<td class="api-call" data-method="' + escapeHtml(httpMethod) + '" data-path="' + escapeHtml(httpPath) + '" data-body="' + escapeHtml(httpDataJson) + '">' + apiCellContent + '</td>' +
          '<td class="issue">' + (op.issueId ? '#' + op.issueId : '-') + '</td>' +
          '<td class="time">' + formatTime(op.timestamp) + '</td>' +
          '<td class="actions">' +
            '<button class="icon-btn apply-btn" data-id="' + escapeHtml(op.id) + '" title="Apply (Enter)">✓</button>' +
            '<button class="icon-btn remove-btn" data-id="' + escapeHtml(op.id) + '" title="Remove (⌫)">✕</button>' +
            '<span class="row-spinner" style="display:none;"></span>' +
          '</td>' +
        '</tr>';
      }).join('');

      // Build table structure safely
      content.replaceChildren();
      const container = document.createElement('div');
      container.className = 'table-container';
      container.innerHTML = '<table><thead><tr><th>Type</th><th>Description</th><th>API Call</th><th>Issue</th><th>Time</th><th></th></tr></thead><tbody id="operations-body">' + rows + '</tbody></table>';
      content.appendChild(container);

      const hint = document.createElement('div');
      hint.className = 'keyboard-hint';
      hint.innerHTML = '<span class="hint-group"><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span class="hint-group"><kbd>Enter</kbd> Apply</span><span class="hint-group"><kbd>⌫</kbd> Remove</span>';
      content.appendChild(hint);

      // Restore selection if still valid
      if (selectedIndex >= ops.length) {
        selectedIndex = ops.length - 1;
      }
      if (selectedIndex >= 0) {
        const newRows = document.querySelectorAll('#operations-body tr');
        focusRow(newRows, selectedIndex);
      }
    }

    // Handle messages from extension
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.command) {
        case 'updateOperations':
          renderOperations(msg.operations);
          break;
        case 'setLoading':
          setGlobalLoading(msg.loading, msg.action);
          break;
        case 'setRowLoading':
          setRowLoading(msg.id, msg.loading);
          break;
      }
    });

    function setGlobalLoading(loading, action) {
      const applyBtn = document.getElementById('apply-all');
      const discardBtn = document.getElementById('discard-all');

      if (loading) {
        if (action === 'applyAll') {
          applyBtn.classList.add('loading');
          applyBtn.disabled = true;
        } else if (action === 'discardAll') {
          discardBtn.classList.add('loading');
          discardBtn.disabled = true;
        }
      } else {
        applyBtn.classList.remove('loading');
        discardBtn.classList.remove('loading');
        applyBtn.disabled = operations.length === 0;
        discardBtn.disabled = operations.length === 0;
      }
    }

    function setRowLoading(id, loading) {
      const row = document.querySelector('tr[data-id="' + id + '"]');
      if (row) {
        row.classList.toggle('row-loading', loading);
      }
    }
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    this.disposed = true;
    DraftReviewPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

export function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();

  // If today, show time only
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // Otherwise show date
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Format a preview of the changes being made from the HTTP data payload
 * Returns HTML string showing key fields that will be updated
 */
export function formatChangesPreview(data: Record<string, unknown> | undefined): string {
  if (!data) return "";

  // Extract the inner object (time_entry, issue, etc.)
  const entries = Object.entries(data);
  if (entries.length === 0) return "";

  const [, innerData] = entries[0];
  if (!innerData || typeof innerData !== "object") return "";

  const fields = innerData as Record<string, unknown>;
  const parts: string[] = [];

  // Field display names and formatting
  const fieldLabels: Record<string, string> = {
    hours: "hours",
    comments: "comment",
    activity_id: "activity",
    issue_id: "issue",
    spent_on: "date",
    status_id: "status",
    done_ratio: "progress",
    priority_id: "priority",
    assigned_to_id: "assignee",
    start_date: "start",
    due_date: "due",
    subject: "subject",
    description: "desc",
  };

  // Priority order for display
  const priorityFields = ["hours", "comments", "subject", "status_id", "done_ratio", "start_date", "due_date"];

  // Get fields in priority order, then remaining fields
  const sortedKeys = [
    ...priorityFields.filter(k => k in fields),
    ...Object.keys(fields).filter(k => !priorityFields.includes(k) && k in fieldLabels),
  ];

  for (const key of sortedKeys.slice(0, 3)) { // Max 3 fields
    const label = fieldLabels[key] || key;
    const value = fields[key];

    if (value === null || value === undefined) continue;

    let formatted: string;
    if (typeof value === "string") {
      // Truncate long strings
      const truncated = value.length > 30 ? value.slice(0, 27) + "..." : value;
      formatted = `<span class="change-key">${escapeHtml(label)}</span>: <span class="change-val">"${escapeHtml(truncated)}"</span>`;
    } else if (typeof value === "number") {
      formatted = `<span class="change-key">${escapeHtml(label)}</span>: <span class="change-num">${value}</span>`;
    } else {
      continue;
    }

    parts.push(formatted);
  }

  return parts.join(" · ");
}
