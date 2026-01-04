/**
 * Internal Estimates Storage
 *
 * Stores user-provided "hours remaining" estimates in VS Code globalState.
 * Used when original estimated_hours is no longer accurate (sent to client).
 * Takes priority over done_ratio/spent_hours for capacity scheduling.
 */

import type * as vscode from "vscode";

export const STORAGE_KEY = "redmine.internalEstimates";

export interface InternalEstimate {
  hoursRemaining: number;
  updatedAt: string; // ISO timestamp
}

export type InternalEstimates = Map<number, InternalEstimate>;

interface StoredEstimates {
  [issueId: string]: InternalEstimate;
}

/**
 * Get all internal estimates from storage
 */
export function getInternalEstimates(
  globalState: vscode.Memento
): InternalEstimates {
  const stored = globalState.get<StoredEstimates>(STORAGE_KEY);
  if (!stored) return new Map();

  const result: InternalEstimates = new Map();
  for (const [idStr, estimate] of Object.entries(stored)) {
    const id = parseInt(idStr, 10);
    if (!isNaN(id)) {
      result.set(id, estimate);
    }
  }
  return result;
}

/**
 * Set internal estimate for an issue
 */
export async function setInternalEstimate(
  globalState: vscode.Memento,
  issueId: number,
  hoursRemaining: number
): Promise<void> {
  const stored = globalState.get<StoredEstimates>(STORAGE_KEY) ?? {};

  stored[String(issueId)] = {
    hoursRemaining,
    updatedAt: new Date().toISOString(),
  };

  await globalState.update(STORAGE_KEY, stored);
}

/**
 * Clear internal estimate for an issue
 */
export async function clearInternalEstimate(
  globalState: vscode.Memento,
  issueId: number
): Promise<void> {
  const stored = globalState.get<StoredEstimates>(STORAGE_KEY) ?? {};

  delete stored[String(issueId)];

  await globalState.update(STORAGE_KEY, stored);
}

/**
 * Get internal estimate for a single issue (convenience)
 */
export function getInternalEstimate(
  globalState: vscode.Memento,
  issueId: number
): InternalEstimate | undefined {
  const stored = globalState.get<StoredEstimates>(STORAGE_KEY);
  return stored?.[String(issueId)];
}
