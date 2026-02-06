/**
 * Draft Mode Commands
 * Registration for all draft mode related commands
 */

import * as vscode from "vscode";
import type { DraftQueue } from "../draft-mode/draft-queue";
import type { DraftModeManager } from "../draft-mode/draft-mode-manager";
import type { DraftModeServer } from "../draft-mode/draft-mode-server";
import type { DraftOperation } from "../draft-mode/draft-operation";
import { DRAFT_COMMAND_SOURCE } from "../draft-mode/draft-change-sources";
import { getServerOrShowError } from "./command-guards";

export interface DraftModeCommandDeps {
  queue: DraftQueue;
  manager: DraftModeManager;
  getServer: () => DraftModeServer | undefined;
  refreshTrees: () => void;
  showReviewPanel: () => void;
}

/** Result of applying drafts with tracking */
export interface ApplyDraftsResult {
  succeeded: DraftOperation[];
  failed: Array<{ operation: DraftOperation; error: string }>;
  skipped: DraftOperation[];
}

/**
 * Apply drafts with full tracking of succeeded/failed/skipped operations.
 * Exported for testing.
 */
export async function applyDraftsWithTracking(
  server: DraftModeServer,
  queue: Pick<DraftQueue, "remove"> & Partial<Pick<DraftQueue, "removeMany">>,
  operations: DraftOperation[],
  onError: (op: DraftOperation, error: string) => boolean | Promise<boolean>,
  onProgress?: (current: number, total: number, description: string) => void
): Promise<ApplyDraftsResult> {
  const result: ApplyDraftsResult = {
    succeeded: [],
    failed: [],
    skipped: [],
  };

  const successfulOperationIds: string[] = [];

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    onProgress?.(i + 1, operations.length, op.description);

    try {
      await executeOperation(server, op);
      result.succeeded.push(op);
      successfulOperationIds.push(op.id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.failed.push({ operation: op, error: msg });

      const shouldContinue = await onError(op, msg);
      if (!shouldContinue) {
        for (let j = i + 1; j < operations.length; j++) {
          result.skipped.push(operations[j]);
        }
        break;
      }
    }
  }

  if (successfulOperationIds.length > 0) {
    if (queue.removeMany) {
      try {
        await queue.removeMany(successfulOperationIds, DRAFT_COMMAND_SOURCE);
      } catch {
        // Fallback to per-item removal if batch persistence fails.
        for (const id of successfulOperationIds) {
          await queue.remove(id, DRAFT_COMMAND_SOURCE);
        }
      }
    } else {
      for (const id of successfulOperationIds) {
        await queue.remove(id, DRAFT_COMMAND_SOURCE);
      }
    }
  }

  return result;
}

function formatApplyResultSummary(result: ApplyDraftsResult): string {
  const parts: string[] = [];
  if (result.succeeded.length > 0) {
    parts.push(`${result.succeeded.length} applied`);
  }
  if (result.failed.length > 0) {
    parts.push(`${result.failed.length} failed`);
  }
  if (result.skipped.length > 0) {
    parts.push(`${result.skipped.length} skipped`);
  }
  return parts.join(", ");
}

function formatFailedOperationsReport(failed: ApplyDraftsResult["failed"]): string {
  if (failed.length === 0) return "";
  const lines = ["Failed operations:"];
  for (const { operation, error } of failed) {
    lines.push(`  - ${operation.description}: ${error}`);
  }
  return lines.join("\n");
}

export function registerDraftModeCommands(
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
        // Note: modal dialogs automatically have a Cancel option (X button / Escape)
        const action = await vscode.window.showWarningMessage(
          `You have ${queue.count} pending draft${queue.count === 1 ? "" : "s"}. What do you want to do?`,
          { modal: true },
          "Apply All",
          "Discard All"
        );

        if (action === "Apply All") {
          await vscode.commands.executeCommand("redmyne.applyDrafts");
        } else if (action === "Discard All") {
          await vscode.commands.executeCommand("redmyne.discardDrafts");
        } else {
          // Cancel (closed dialog) - keep draft mode on
          return;
        }
      }

      await manager.toggle();
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
      const server = getServerOrShowError(deps.getServer);
      if (!server) return;

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
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Applying drafts",
          cancellable: false,
        },
        async (progress) => {
          return applyDraftsWithTracking(
            server,
            queue,
            operations,
            async (op, msg) => {
              const action = await vscode.window.showErrorMessage(
                `Failed to apply: ${op.description}
${msg}`,
                "Continue",
                "Stop"
              );
              return action === "Continue";
            },
            (current, total, description) => {
              progress.report({
                message: `${current}/${total}: ${description}`,
                increment: 100 / total,
              });
            }
          );
        }
      );

      refreshTrees();

      if (result.failed.length === 0 && result.skipped.length === 0) {
        vscode.window.showInformationMessage(
          `Successfully applied ${result.succeeded.length} draft${result.succeeded.length === 1 ? "" : "s"}`
        );
      } else {
        const summary = formatApplyResultSummary(result);
        const action = await vscode.window.showWarningMessage(
          `Drafts: ${summary}`,
          "Show Details"
        );
        if (action === "Show Details") {
          const report = formatFailedOperationsReport(result.failed);
          if (result.skipped.length > 0) {
            const skippedNames = result.skipped.map(op => op.description).join(", ");
            const fullReport = report + `

Skipped (not attempted): ${skippedNames}`;
            vscode.window.showInformationMessage(fullReport, { modal: true });
          } else {
            vscode.window.showInformationMessage(report, { modal: true });
          }
        }
      }
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

      await queue.clear(DRAFT_COMMAND_SOURCE);
      refreshTrees(); // Refresh all views after discard
      vscode.window.showInformationMessage(`Discarded ${count} draft${count === 1 ? "" : "s"}`);
    }
  );

  const removeDraft = vscode.commands.registerCommand(
    "redmyne.removeDraft",
    async (draftId: string) => {
      await queue.remove(draftId, DRAFT_COMMAND_SOURCE);
      refreshTrees(); // Refresh all views after remove
    }
  );

  const applySingleDraft = vscode.commands.registerCommand(
    "redmyne.applySingleDraft",
    async (draftId: string) => {
      const server = getServerOrShowError(deps.getServer);
      if (!server) return;

      const operations = queue.getAll();
      const op = operations.find(o => o.id === draftId);
      if (!op) {
        vscode.window.showErrorMessage("Draft not found");
        return;
      }

      try {
        await executeOperation(server, op);
        await queue.remove(op.id, DRAFT_COMMAND_SOURCE);
        refreshTrees();
        vscode.window.showInformationMessage(`Applied: ${op.description}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to apply: ${op.description}\n${msg}`);
      }
    }
  );

  return [
    toggleDraftMode,
    reviewDrafts,
    applyDrafts,
    discardDrafts,
    removeDraft,
    applySingleDraft,
    managerSub,
    queueSub,
  ];
}

// Execute a draft operation by calling the inner server directly
function requireOperationIssueId(op: DraftOperation): number {
  if (!op.issueId) {
    throw new Error(`Draft operation ${op.id} (${op.type}) is missing issueId`);
  }
  return op.issueId;
}

function requireOperationResourceId(op: DraftOperation): number {
  if (!op.resourceId) {
    throw new Error(`Draft operation ${op.id} (${op.type}) is missing resourceId`);
  }
  return op.resourceId;
}

async function executeOperation(
  server: DraftModeServer,
  op: DraftOperation
): Promise<void> {
  const { http } = op;

  // Route based on operation type and HTTP path
  switch (op.type) {
    case "setIssueStatus": {
      const issueId = requireOperationIssueId(op);
      const statusId = (http.data as { issue: { status_id: number } }).issue.status_id;
      await server.setIssueStatus({ id: issueId }, statusId, { _bypassDraft: true });
      break;
    }
    case "setIssueDates": {
      const issueId = requireOperationIssueId(op);
      const data = (http.data as { issue: { start_date?: string; due_date?: string } }).issue;
      await server.updateIssueDates(issueId, data.start_date ?? null, data.due_date ?? null, { _bypassDraft: true });
      break;
    }
    case "setIssueDoneRatio": {
      const issueId = requireOperationIssueId(op);
      const doneRatio = (http.data as { issue: { done_ratio: number } }).issue.done_ratio;
      await server.updateDoneRatio(issueId, doneRatio, { _bypassDraft: true });
      break;
    }
    case "setIssuePriority": {
      const issueId = requireOperationIssueId(op);
      const priorityId = (http.data as { issue: { priority_id: number } }).issue.priority_id;
      await server.setIssuePriority(issueId, priorityId, { _bypassDraft: true });
      break;
    }
    case "setIssueAssignee": {
      const issueId = requireOperationIssueId(op);
      const assignedToId = (http.data as { issue: { assigned_to_id: number } }).issue.assigned_to_id;
      await server.put(`/issues/${issueId}.json`, { issue: { assigned_to_id: assignedToId } });
      break;
    }
    case "addIssueNote": {
      const issueId = requireOperationIssueId(op);
      const notes = (http.data as { issue: { notes: string } }).issue.notes;
      await server.put(`/issues/${issueId}.json`, { issue: { notes } });
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
        custom_fields?: Array<{ id: number; value: string | string[] }>;
      } }).time_entry;
      await server.addTimeEntry(
        entry.issue_id,
        entry.activity_id,
        entry.hours,
        entry.comments,
        entry.spent_on,
        entry.custom_fields,
        { _bypassDraft: true }
      );
      break;
    }
    case "updateTimeEntry": {
      const id = requireOperationResourceId(op);
      const updates = (http.data as { time_entry: Parameters<typeof server.updateTimeEntry>[1] }).time_entry;
      await server.updateTimeEntry(id, updates, { _bypassDraft: true });
      break;
    }
    case "deleteTimeEntry": {
      const id = requireOperationResourceId(op);
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
      const id = requireOperationResourceId(op);
      const versionData = (http.data as { version: Parameters<typeof server.updateVersion>[1] }).version;
      await server.updateVersion(id, versionData, { _bypassDraft: true });
      break;
    }
    case "deleteVersion": {
      const id = requireOperationResourceId(op);
      await server.deleteVersion(id, { _bypassDraft: true });
      break;
    }
    case "createRelation": {
      const match = http.path.match(/\/issues\/(\d+)\/relations\.json/);
      if (!match) throw new Error("Invalid relation path");
      const issueId = parseInt(match[1], 10);
      const relationData = (http.data as { relation: { issue_to_id: number; relation_type: string; delay?: number } }).relation;
      await server.createRelation(
        issueId,
        relationData.issue_to_id,
        relationData.relation_type as Parameters<typeof server.createRelation>[2],
        relationData.delay,
        { _bypassDraft: true }
      );
      break;
    }
    case "deleteRelation": {
      const id = requireOperationResourceId(op);
      await server.deleteRelation(id, { _bypassDraft: true });
      break;
    }
    default:
      throw new Error(`Unknown operation type: ${op.type}`);
  }
}
