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
  queue: Pick<DraftQueue, "remove">,
  operations: DraftOperation[],
  onError: (op: DraftOperation, error: string) => boolean | Promise<boolean>,
  onProgress?: (current: number, total: number, description: string) => void
): Promise<ApplyDraftsResult> {
  const result: ApplyDraftsResult = {
    succeeded: [],
    failed: [],
    skipped: [],
  };

  // Stub (negative) ID → real server ID, filled in as creates apply.
  // Creates precede their dependents in queue order.
  const stubIdMap = new Map<number, number>();

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (!op) continue;
    onProgress?.(i + 1, operations.length, op.description);

    let applied = false;
    let realId: number | undefined;
    try {
      realId = await executeOperation(server, remapStubIds(op, stubIdMap));
      applied = true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.failed.push({ operation: op, error: msg });

      const shouldContinue = await onError(op, msg);
      if (!shouldContinue) {
        for (let j = i + 1; j < operations.length; j++) {
          const skipped = operations[j];
          if (skipped) result.skipped.push(skipped);
        }
        break;
      }
    }

    if (applied) {
      if (op.stubId !== undefined && realId !== undefined) {
        stubIdMap.set(op.stubId, realId);
      }
      result.succeeded.push(op);
      // Remove immediately: a mid-batch pause (error toast) or window
      // reload must not leave an already-applied op replayable.
      try {
        await queue.remove(op.id, DRAFT_COMMAND_SOURCE);
      } catch {
        // The op reached the server; failing the batch here would
        // misreport it as not applied. Removal is best-effort.
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

  // Single-flight guard: a batch apply pauses on its (non-modal) error
  // toast, during which panel buttons stay clickable — block re-entry.
  let applyInFlight = false;

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

        if (queue.count > 0) {
          // Apply/discard was cancelled or partially failed — disabling
          // draft mode now would orphan the remaining drafts.
          vscode.window.showInformationMessage(
            "Draft mode stays on: drafts are still pending"
          );
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
      if (applyInFlight) {
        vscode.window.showInformationMessage("A draft apply is already in progress");
        return;
      }
      const server = getServerOrShowError(deps.getServer);
      if (!server) return;

      const snapshotOperations = queue.getAll();
      if (snapshotOperations.length === 0) {
        vscode.window.showInformationMessage("No drafts to apply");
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Apply ${snapshotOperations.length} draft${snapshotOperations.length === 1 ? "" : "s"} to Redmine?`,
        { modal: true },
        "Apply All"
      );

      if (confirm !== "Apply All") return;
      // Re-read queue after confirm dialog — ops may have changed while dialog was open
      const operations = queue.getAll();
      applyInFlight = true;
      let result: ApplyDraftsResult;
      try {
        result = await vscode.window.withProgress(
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
      } finally {
        applyInFlight = false;
      }

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
      if (applyInFlight) {
        vscode.window.showInformationMessage("A draft apply is already in progress");
        return;
      }
      const server = getServerOrShowError(deps.getServer);
      if (!server) return;

      const operations = queue.getAll();
      const op = operations.find(o => o.id === draftId);
      if (!op) {
        vscode.window.showErrorMessage("Draft not found");
        return;
      }

      applyInFlight = true;
      try {
        await executeOperation(server, op);
        await queue.remove(op.id, DRAFT_COMMAND_SOURCE);
        refreshTrees();
        vscode.window.showInformationMessage(`Applied: ${op.description}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to apply: ${op.description}\n${msg}`);
      } finally {
        applyInFlight = false;
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

/**
 * Rewrite negative draft stub IDs to the real server IDs assigned by
 * creates earlier in the batch. Returns a clone — queued ops must stay
 * untouched so a failed batch can be retried.
 */
function remapStubIds(
  op: DraftOperation,
  stubIdMap: Map<number, number>
): DraftOperation {
  if (stubIdMap.size === 0) return op;

  const clone = structuredClone(op);
  if (clone.issueId !== undefined && stubIdMap.has(clone.issueId)) {
    clone.issueId = stubIdMap.get(clone.issueId);
  }
  if (clone.resourceId !== undefined && stubIdMap.has(clone.resourceId)) {
    clone.resourceId = stubIdMap.get(clone.resourceId);
  }
  clone.http.path = clone.http.path.replace(/-\d+/g, (m) => {
    const real = stubIdMap.get(parseInt(m, 10));
    return real !== undefined ? String(real) : m;
  });
  if (clone.http.data) {
    for (const wrapper of Object.values(clone.http.data)) {
      if (!wrapper || typeof wrapper !== "object") continue;
      const record = wrapper as Record<string, unknown>;
      for (const key of ["issue_id", "issue_to_id", "parent_issue_id", "fixed_version_id"]) {
        const v = record[key];
        if (typeof v === "number" && stubIdMap.has(v)) {
          record[key] = stubIdMap.get(v);
        }
      }
    }
  }
  return clone;
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

/**
 * Execute one draft op against the inner server. Returns the real ID
 * assigned by the server for create operations (undefined otherwise).
 */
async function executeOperation(
  server: DraftModeServer,
  op: DraftOperation
): Promise<number | undefined> {
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
      const created = await server.createIssue(issueData, { _bypassDraft: true });
      return created?.issue?.id;
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
      const created = await server.addTimeEntry(
        entry.issue_id,
        entry.activity_id,
        entry.hours,
        entry.comments,
        entry.spent_on,
        entry.custom_fields,
        { _bypassDraft: true }
      );
      return created?.time_entry?.id;
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
      if (!match || !match[1]) throw new Error("Invalid version path");
      const projectId = match[1];
      const versionData = (http.data as { version: Parameters<typeof server.createVersion>[1] }).version;
      const created = await server.createVersion(projectId, versionData, { _bypassDraft: true });
      return created?.id;
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
      if (!match || !match[1]) throw new Error("Invalid relation path");
      const issueId = parseInt(match[1], 10);
      const relationData = (http.data as { relation: { issue_to_id: number; relation_type: string; delay?: number } }).relation;
      const created = await server.createRelation(
        issueId,
        relationData.issue_to_id,
        relationData.relation_type as Parameters<typeof server.createRelation>[2],
        relationData.delay,
        { _bypassDraft: true }
      );
      return created?.relation?.id;
    }
    case "deleteRelation": {
      const id = requireOperationResourceId(op);
      await server.deleteRelation(id, { _bypassDraft: true });
      break;
    }
    default:
      throw new Error(`Unknown operation type: ${op.type}`);
  }
  return undefined;
}
