/**
 * Draft Review Panel
 * Webview panel to review, apply, and discard pending drafts
 */

import * as vscode from "vscode";
import type { DraftQueue } from "./draft-queue";
import type { DraftModeManager } from "./draft-mode-manager";
import type { DraftOperation } from "./draft-operation";

export class DraftReviewPanel implements vscode.Disposable {
  public static currentPanel: DraftReviewPanel | undefined;
  private static readonly viewType = "redmyneDraftReview";

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly queue: DraftQueue;
  private readonly manager: DraftModeManager;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    queue: DraftQueue,
    manager: DraftModeManager
  ): DraftReviewPanel {
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

    DraftReviewPanel.currentPanel = new DraftReviewPanel(panel, extensionUri, queue, manager);
    return DraftReviewPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    queue: DraftQueue,
    manager: DraftModeManager
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.queue = queue;
    this.manager = manager;

    this.update();

    // Listen for queue changes
    this.disposables.push(
      this.queue.onDidChange(() => this.update())
    );

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "applyAll":
            await vscode.commands.executeCommand("redmyne.applyDrafts");
            break;
          case "discardAll":
            await vscode.commands.executeCommand("redmyne.discardDrafts");
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

  public update(): void {
    const operations = this.queue.getAll();
    this.panel.webview.html = this.getHtmlForWebview(operations);
  }

  private getHtmlForWebview(operations: DraftOperation[]): string {
    const nonce = getNonce();

    const operationRows = operations.map((op) => `
      <tr>
        <td class="type">${escapeHtml(op.type)}</td>
        <td class="description">${escapeHtml(op.description)}</td>
        <td class="issue">${op.issueId ? `#${op.issueId}` : "-"}</td>
        <td class="time">${formatTime(op.timestamp)}</td>
        <td class="actions">
          <button class="remove-btn" data-id="${escapeHtml(op.id)}" title="Remove">🗑</button>
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
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      cursor: pointer;
      border-radius: 2px;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 16px;
    }
    th, td {
      text-align: left;
      padding: 8px;
      border-bottom: 1px solid var(--vscode-widget-border);
    }
    th {
      font-weight: 600;
      color: var(--vscode-foreground);
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
      width: 50px;
      text-align: center;
    }
    .remove-btn {
      background: transparent;
      padding: 4px;
      font-size: 1em;
    }
    .remove-btn:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .empty {
      text-align: center;
      color: var(--vscode-descriptionForeground);
      padding: 32px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Pending Drafts</h1>
      <span class="count">${operations.length} change${operations.length === 1 ? "" : "s"} queued</span>
    </div>
    <div class="actions-bar">
      <button id="apply-all" ${operations.length === 0 ? "disabled" : ""}>Apply All</button>
      <button id="discard-all" class="secondary" ${operations.length === 0 ? "disabled" : ""}>Discard All</button>
    </div>
  </div>

  ${operations.length === 0 ? `
    <div class="empty">
      No pending drafts. Changes you make in draft mode will appear here.
    </div>
  ` : `
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
      <tbody>
        ${operationRows}
      </tbody>
    </table>
  `}

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.getElementById('apply-all')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'applyAll' });
    });

    document.getElementById('discard-all')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'discardAll' });
    });

    document.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ command: 'removeDraft', id: btn.dataset.id });
      });
    });
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

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();

  // If today, show time only
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // Otherwise show date
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
