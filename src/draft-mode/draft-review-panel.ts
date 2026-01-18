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
  private disposables: vscode.Disposable[] = [];
  private lastOperationIds: Set<string> = new Set();

  public static createOrShow(queue: DraftQueue): DraftReviewPanel {
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
      }
    );

    DraftReviewPanel.currentPanel = new DraftReviewPanel(panel, queue);
    return DraftReviewPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel, queue: DraftQueue) {
    this.panel = panel;
    this.queue = queue;

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
    this.panel.webview.postMessage({ command: "setLoading", loading: true, action: "applyAll" });
    try {
      await vscode.commands.executeCommand("redmyne.applyDrafts");
    } finally {
      this.panel.webview.postMessage({ command: "setLoading", loading: false });
    }
  }

  private async handleApplyDraft(id: string): Promise<void> {
    this.panel.webview.postMessage({ command: "setRowLoading", id, loading: true });
    try {
      await vscode.commands.executeCommand("redmyne.applySingleDraft", id);
    } finally {
      this.panel.webview.postMessage({ command: "setRowLoading", id, loading: false });
    }
  }

  private async handleDiscardAll(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Discard all ${this.queue.count} pending drafts? This cannot be undone.`,
      { modal: true },
      "Discard All"
    );
    if (confirm === "Discard All") {
      this.panel.webview.postMessage({ command: "setLoading", loading: true, action: "discardAll" });
      try {
        await vscode.commands.executeCommand("redmyne.discardDrafts");
      } finally {
        this.panel.webview.postMessage({ command: "setLoading", loading: false });
      }
    }
  }

  private sendIncrementalUpdate(): void {
    const operations = this.queue.getAll();
    const currentIds = new Set(operations.map(op => op.id));

    // Detect added, removed, or if we should just do full update
    const added = operations.filter(op => !this.lastOperationIds.has(op.id));
    const removed = [...this.lastOperationIds].filter(id => !currentIds.has(id));

    // For simplicity, if changes are complex (updates in place), do full update
    // Otherwise send delta
    if (added.length > 0 || removed.length > 0) {
      this.panel.webview.postMessage({
        command: "updateOperations",
        operations: operations.map(op => ({
          id: op.id,
          type: op.type,
          description: op.description,
          issueId: op.issueId,
          timestamp: op.timestamp,
        })),
        count: operations.length,
      });
    }

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
      })),
      count: operations.length,
    });
    this.lastOperationIds = new Set(operations.map(op => op.id));
  }

  private getHtmlForWebview(operations: DraftOperation[]): string {
    const nonce = getNonce();

    const operationRows = operations.map((op) => `
      <tr data-id="${escapeHtml(op.id)}" tabindex="0">
        <td class="type">${escapeHtml(op.type)}</td>
        <td class="description">${escapeHtml(op.description)}</td>
        <td class="issue">${op.issueId ? `#${op.issueId}` : "-"}</td>
        <td class="time">${formatTime(op.timestamp)}</td>
        <td class="actions">
          <button class="apply-btn" data-id="${escapeHtml(op.id)}" title="Apply this draft">
            <span class="icon">$(check)</span>
          </button>
          <button class="remove-btn" data-id="${escapeHtml(op.id)}" title="Remove">
            <span class="icon">$(trash)</span>
          </button>
          <span class="row-spinner" style="display:none;">$(loading~spin)</span>
        </td>
      </tr>
    `).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Draft Review</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
      margin: 0;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
      padding: 8px 0;
      z-index: 10;
    }
    h1 {
      margin: 0;
      font-size: 1.4em;
    }
    .count {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
    .actions-bar {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .spinner {
      display: none;
    }
    .loading .spinner {
      display: inline-block;
      margin-right: 8px;
    }
    .loading .btn-text {
      opacity: 0.6;
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      cursor: pointer;
      border-radius: 2px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    button:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .table-container {
      max-height: calc(100vh - 120px);
      overflow-y: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    thead {
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
      z-index: 5;
    }
    th, td {
      text-align: left;
      padding: 8px;
      border-bottom: 1px solid var(--vscode-widget-border);
    }
    th {
      font-weight: 600;
      color: var(--vscode-foreground);
      border-bottom: 2px solid var(--vscode-widget-border);
    }
    tbody tr {
      outline: none;
    }
    tbody tr:hover {
      background: var(--vscode-list-hoverBackground);
    }
    tbody tr:focus {
      background: var(--vscode-list-focusBackground);
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    tbody tr.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .type {
      width: 120px;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.85em;
    }
    .description {
      min-width: 200px;
    }
    .issue {
      width: 80px;
      font-family: var(--vscode-editor-font-family);
    }
    .time {
      width: 80px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
    }
    .actions {
      width: 80px;
      text-align: center;
      white-space: nowrap;
    }
    .apply-btn, .remove-btn {
      background: transparent;
      padding: 4px 6px;
      font-size: 1em;
      min-width: 28px;
    }
    .apply-btn:hover:not(:disabled) {
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-charts-green);
    }
    .remove-btn:hover:not(:disabled) {
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-charts-red);
    }
    .row-spinner {
      color: var(--vscode-descriptionForeground);
    }
    tr.row-loading .apply-btn,
    tr.row-loading .remove-btn {
      display: none;
    }
    tr.row-loading .row-spinner {
      display: inline-block !important;
    }
    .empty {
      text-align: center;
      color: var(--vscode-descriptionForeground);
      padding: 32px;
    }
    .keyboard-hint {
      color: var(--vscode-descriptionForeground);
      font-size: 0.8em;
      margin-top: 16px;
      text-align: center;
    }
    kbd {
      background: var(--vscode-keybindingLabel-background);
      color: var(--vscode-keybindingLabel-foreground);
      border: 1px solid var(--vscode-keybindingLabel-border);
      border-radius: 3px;
      padding: 1px 4px;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Pending Drafts</h1>
      <span class="count" id="count">${operations.length} change${operations.length === 1 ? "" : "s"} queued</span>
    </div>
    <div class="actions-bar">
      <button id="apply-all" ${operations.length === 0 ? "disabled" : ""}>
        <span class="spinner">$(loading~spin)</span>
        <span class="btn-text">Apply All</span>
      </button>
      <button id="discard-all" class="secondary" ${operations.length === 0 ? "disabled" : ""}>
        <span class="spinner">$(loading~spin)</span>
        <span class="btn-text">Discard All</span>
      </button>
    </div>
  </div>

  <div id="content">
    ${operations.length === 0 ? `
      <div class="empty">
        No pending drafts. Changes you make in draft mode will appear here.
      </div>
    ` : `
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Description</th>
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
        <kbd>↑</kbd><kbd>↓</kbd> Navigate
        <kbd>Enter</kbd> Apply
        <kbd>Backspace</kbd> Remove
      </div>
    `}
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
    })))};

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

    function renderOperations(ops) {
      operations = ops;
      const content = document.getElementById('content');
      const countEl = document.getElementById('count');
      const applyBtn = document.getElementById('apply-all');
      const discardBtn = document.getElementById('discard-all');

      countEl.textContent = ops.length + ' change' + (ops.length === 1 ? '' : 's') + ' queued';
      applyBtn.disabled = ops.length === 0;
      discardBtn.disabled = ops.length === 0;

      if (ops.length === 0) {
        content.innerHTML = '<div class="empty">No pending drafts. Changes you make in draft mode will appear here.</div>';
        selectedIndex = -1;
        return;
      }

      const rows = ops.map(op =>
        '<tr data-id="' + escapeHtml(op.id) + '" tabindex="0">' +
          '<td class="type">' + escapeHtml(op.type) + '</td>' +
          '<td class="description">' + escapeHtml(op.description) + '</td>' +
          '<td class="issue">' + (op.issueId ? '#' + op.issueId : '-') + '</td>' +
          '<td class="time">' + formatTime(op.timestamp) + '</td>' +
          '<td class="actions">' +
            '<button class="apply-btn" data-id="' + escapeHtml(op.id) + '" title="Apply this draft">' +
              '<span class="icon">$(check)</span>' +
            '</button>' +
            '<button class="remove-btn" data-id="' + escapeHtml(op.id) + '" title="Remove">' +
              '<span class="icon">$(trash)</span>' +
            '</button>' +
            '<span class="row-spinner" style="display:none;">$(loading~spin)</span>' +
          '</td>' +
        '</tr>'
      ).join('');

      content.innerHTML =
        '<div class="table-container">' +
          '<table>' +
            '<thead><tr><th>Type</th><th>Description</th><th>Issue</th><th>Time</th><th></th></tr></thead>' +
            '<tbody id="operations-body">' + rows + '</tbody>' +
          '</table>' +
        '</div>' +
        '<div class="keyboard-hint">' +
          '<kbd>↑</kbd><kbd>↓</kbd> Navigate ' +
          '<kbd>Enter</kbd> Apply ' +
          '<kbd>Backspace</kbd> Remove' +
        '</div>';

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
