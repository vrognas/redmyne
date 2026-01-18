/**
 * Draft Mode Commands
 * Registration for all draft mode related commands
 */

import * as vscode from "vscode";
import type { DraftQueue } from "../draft-mode/draft-queue";
import type { DraftModeManager } from "../draft-mode/draft-mode-manager";
import type { DraftModeServer } from "../draft-mode/draft-mode-server";

export interface DraftModeCommandDeps {
  queue: DraftQueue;
  manager: DraftModeManager;
  getServer: () => DraftModeServer | undefined;
  refreshTrees: () => void;
  showReviewPanel: () => void;
}

export function registerDraftModeCommands(
  context: vscode.ExtensionContext,
  deps: DraftModeCommandDeps
): vscode.Disposable[] {
  const { queue, manager, refreshTrees, showReviewPanel } = deps;

  const updateContexts = () => {
    vscode.commands.executeCommand("setContext", "redmyne:draftMode", manager.isEnabled);
    vscode.commands.executeCommand("setContext", "redmyne:hasDrafts", queue.count > 0);
  };

  // Initial context update
  updateContexts();

  // Update contexts when state changes
  const managerSub = manager.onDidChangeEnabled(() => updateContexts());
  const queueSub = queue.onDidChange(() => updateContexts());

  const toggleDraftMode = vscode.commands.registerCommand(
    "redmyne.toggleDraftMode",
    async () => {
      if (manager.isEnabled && queue.count > 0) {
        // Prompt user to apply or discard pending drafts
        const action = await vscode.window.showWarningMessage(
          `You have ${queue.count} pending draft${queue.count === 1 ? "" : "s"}. What do you want to do?`,
          { modal: true },
          "Apply All",
          "Discard All",
          "Cancel"
        );

        if (action === "Apply All") {
          await vscode.commands.executeCommand("redmyne.applyDrafts");
        } else if (action === "Discard All") {
          await vscode.commands.executeCommand("redmyne.discardDrafts");
        } else {
          // Cancel - keep draft mode on
          return;
        }
      }

      const newState = await manager.toggle();
      vscode.window.showInformationMessage(
        `Draft mode ${newState ? "enabled" : "disabled"}`
      );
    }
  );

  const reviewDrafts = vscode.commands.registerCommand(
    "redmyne.reviewDrafts",
    () => {
      showReviewPanel();
    }
  );

  const applyDrafts = vscode.commands.registerCommand(
    "redmyne.applyDrafts",
    async () => {
      const server = deps.getServer();
      if (!server) {
        vscode.window.showErrorMessage("No Redmine server configured");
        return;
      }

      const operations = queue.getAll();
      if (operations.length === 0) {
        vscode.window.showInformationMessage("No drafts to apply");
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Apply ${operations.length} draft${operations.length === 1 ? "" : "s"} to Redmine?`,
        { modal: true },
        "Apply All"
      );

      if (confirm !== "Apply All") return;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Applying drafts",
          cancellable: false,
        },
        async (progress) => {
          let successCount = 0;
          let errorCount = 0;

          for (let i = 0; i < operations.length; i++) {
            const op = operations[i];
            progress.report({
              message: `${i + 1}/${operations.length}: ${op.description}`,
              increment: 100 / operations.length,
            });

            try {
              // Execute the operation through the inner server
              // This bypasses draft mode interception
              await executeOperation(server, op);
              await queue.remove(op.id);
              successCount++;
            } catch (error) {
              errorCount++;
              const msg = error instanceof Error ? error.message : String(error);
              const action = await vscode.window.showErrorMessage(
                `Failed to apply: ${op.description}\n${msg}`,
                "Continue",
                "Stop"
              );
              if (action === "Stop") break;
            }
          }

          // Refresh trees after all operations
          refreshTrees();

          if (errorCount === 0) {
            vscode.window.showInformationMessage(
              `Successfully applied ${successCount} draft${successCount === 1 ? "" : "s"}`
            );
          } else {
            vscode.window.showWarningMessage(
              `Applied ${successCount} draft${successCount === 1 ? "" : "s"}, ${errorCount} failed`
            );
          }
        }
      );
    }
  );

  const discardDrafts = vscode.commands.registerCommand(
    "redmyne.discardDrafts",
    async () => {
      const count = queue.count;
      if (count === 0) {
        vscode.window.showInformationMessage("No drafts to discard");
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Discard ${count} draft${count === 1 ? "" : "s"}? This cannot be undone.`,
        { modal: true },
        "Discard All"
      );

      if (confirm !== "Discard All") return;

      await queue.clear();
      vscode.window.showInformationMessage(`Discarded ${count} draft${count === 1 ? "" : "s"}`);
    }
  );

  const removeDraft = vscode.commands.registerCommand(
    "redmyne.removeDraft",
    async (draftId: string) => {
      await queue.remove(draftId);
    }
  );

  return [
    toggleDraftMode,
    reviewDrafts,
    applyDrafts,
    discardDrafts,
    removeDraft,
    managerSub,
    queueSub,
  ];
}

// Execute a draft operation by calling the inner server directly
async function executeOperation(
  server: DraftModeServer,
  op: import("../draft-mode/draft-operation").DraftOperation
): Promise<void> {
  const { http } = op;

  // Route based on operation type and HTTP path
  switch (op.type) {
    case "setIssueStatus": {
      const issueId = op.issueId!;
      const statusId = (http.data as { issue: { status_id: number } }).issue.status_id;
      await server.setIssueStatus({ id: issueId }, statusId, { _bypassDraft: true });
      break;
    }
    case "setIssueDates": {
      const issueId = op.issueId!;
      const data = (http.data as { issue: { start_date?: string; due_date?: string } }).issue;
      await server.updateIssueDates(issueId, data.start_date ?? null, data.due_date ?? null, { _bypassDraft: true });
      break;
    }
    case "setIssueDoneRatio": {
      const issueId = op.issueId!;
      const doneRatio = (http.data as { issue: { done_ratio: number } }).issue.done_ratio;
      await server.updateDoneRatio(issueId, doneRatio, { _bypassDraft: true });
      break;
    }
    case "setIssuePriority": {
      const issueId = op.issueId!;
      const priorityId = (http.data as { issue: { priority_id: number } }).issue.priority_id;
      await server.setIssuePriority(issueId, priorityId, { _bypassDraft: true });
      break;
    }
    case "setIssueAssignee": {
      // This is part of applyQuickUpdate, we'll handle via direct PUT
      // For now, skip - the full quick update should handle this
      break;
    }
    case "addIssueNote": {
      // Notes are part of applyQuickUpdate, skip for now
      break;
    }
    case "createIssue": {
      const issueData = (http.data as { issue: Parameters<typeof server.createIssue>[0] }).issue;
      await server.createIssue(issueData, { _bypassDraft: true });
      break;
    }
    case "createTimeEntry": {
      const entry = (http.data as { time_entry: {
        issue_id: number;
        activity_id: number;
        hours: string;
        comments: string;
        spent_on?: string;
      } }).time_entry;
      await server.addTimeEntry(
        entry.issue_id,
        entry.activity_id,
        entry.hours,
        entry.comments,
        entry.spent_on,
        { _bypassDraft: true }
      );
      break;
    }
    case "updateTimeEntry": {
      const id = op.resourceId!;
      const updates = (http.data as { time_entry: Parameters<typeof server.updateTimeEntry>[1] }).time_entry;
      await server.updateTimeEntry(id, updates, { _bypassDraft: true });
      break;
    }
    case "deleteTimeEntry": {
      const id = op.resourceId!;
      await server.deleteTimeEntry(id, { _bypassDraft: true });
      break;
    }
    case "createVersion": {
      const match = http.path.match(/\/projects\/([^/]+)\/versions\.json/);
      if (!match) throw new Error("Invalid version path");
      const projectId = match[1];
      const versionData = (http.data as { version: Parameters<typeof server.createVersion>[1] }).version;
      await server.createVersion(projectId, versionData, { _bypassDraft: true });
      break;
    }
    case "updateVersion": {
      const id = op.resourceId!;
      const versionData = (http.data as { version: Parameters<typeof server.updateVersion>[1] }).version;
      await server.updateVersion(id, versionData, { _bypassDraft: true });
      break;
    }
    case "deleteVersion": {
      const id = op.resourceId!;
      await server.deleteVersion(id, { _bypassDraft: true });
      break;
    }
    case "createRelation": {
      const match = http.path.match(/\/issues\/(\d+)\/relations\.json/);
      if (!match) throw new Error("Invalid relation path");
      const issueId = parseInt(match[1], 10);
      const relationData = (http.data as { relation: { issue_to_id: number; relation_type: string } }).relation;
      await server.createRelation(
        issueId,
        relationData.issue_to_id,
        relationData.relation_type as Parameters<typeof server.createRelation>[2],
        { _bypassDraft: true }
      );
      break;
    }
    case "deleteRelation": {
      const id = op.resourceId!;
      await server.deleteRelation(id, { _bypassDraft: true });
      break;
    }
    default:
      throw new Error(`Unknown operation type: ${op.type}`);
  }
}
