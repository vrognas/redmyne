/**
 * Migration from redmine.* namespace to redmyne.* namespace
 * Handles secrets and globalState migration on extension activation
 */

import * as vscode from "vscode";

const MIGRATION_VERSION_KEY = "redmyne.migrationVersion";
const CURRENT_MIGRATION_VERSION = 1;

/** Old → New key mappings for globalState */
const GLOBAL_STATE_MIGRATIONS: [string, string][] = [
  // Trackers
  ["redmine.autoUpdateEnabledIssues", "redmyne.autoUpdateEnabledIssues"],
  ["redmine.adHocIssues", "redmyne.adHocIssues"],
  ["redmine.internalEstimates", "redmyne.internalEstimates"],
  ["redmine.monthlySchedules", "redmyne.monthlySchedules"],
  ["redmine.precedenceIssues", "redmyne.precedenceIssues"],
  // Kanban
  ["redmine.kanban", "redmyne.kanban"],
  ["redmine.kanban.filterPriority", "redmyne.kanban.filterPriority"],
  ["redmine.kanban.sortField", "redmyne.kanban.sortField"],
  ["redmine.kanban.sortDirection", "redmyne.kanban.sortDirection"],
  // Projects tree
  ["redmine.issueFilter", "redmyne.issueFilter"],
  ["redmine.issueSort", "redmyne.issueSort"],
  // Timer
  ["redmine.timer.unitDuration", "redmyne.timer.unitDuration"],
  ["redmine.timer.workDuration", "redmyne.timer.workDuration"],
  ["redmine.timer.soundEnabled", "redmyne.timer.soundEnabled"],
  // Gantt
  ["redmine.gantt.viewMode", "redmyne.gantt.viewMode"],
  ["redmine.gantt.viewFocus", "redmyne.gantt.viewFocus"],
  ["redmine.gantt.selectedProject", "redmyne.gantt.selectedProject"],
  ["redmine.gantt.selectedAssignee", "redmyne.gantt.selectedAssignee"],
  ["redmine.gantt.filterAssignee", "redmyne.gantt.filterAssignee"],
  ["redmine.gantt.filterStatus", "redmyne.gantt.filterStatus"],
  ["redmine.gantt.filterHealth", "redmyne.gantt.filterHealth"],
  ["redmine.gantt.lookbackYears", "redmyne.gantt.lookbackYears"],
];

/** Old → New key mappings for secrets */
const SECRET_MIGRATIONS: [string, string][] = [
  ["redmine:global:apiKey:v2", "redmyne:global:apiKey:v2"],
];

/**
 * Migrate a single globalState key if old exists and new doesn't
 */
async function migrateGlobalStateKey(
  globalState: vscode.Memento,
  oldKey: string,
  newKey: string
): Promise<boolean> {
  const oldValue = globalState.get<unknown>(oldKey);
  if (oldValue === undefined) return false;

  const newValue = globalState.get<unknown>(newKey);
  if (newValue !== undefined) return false; // Don't overwrite

  await globalState.update(newKey, oldValue);
  await globalState.update(oldKey, undefined); // Clear old
  return true;
}

/**
 * Migrate a single secret key if old exists and new doesn't
 */
async function migrateSecretKey(
  secrets: vscode.SecretStorage,
  oldKey: string,
  newKey: string
): Promise<boolean> {
  try {
    const oldValue = await secrets.get(oldKey);
    if (!oldValue) return false;

    const newValue = await secrets.get(newKey);
    if (newValue) return false; // Don't overwrite

    await secrets.store(newKey, oldValue);
    await secrets.delete(oldKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run all migrations if not already done
 * Call at start of activate() before any other initialization
 */
export async function runMigration(
  context: vscode.ExtensionContext
): Promise<void> {
  const currentVersion = context.globalState.get<number>(
    MIGRATION_VERSION_KEY,
    0
  );
  if (currentVersion >= CURRENT_MIGRATION_VERSION) return;

  let migratedCount = 0;

  // Migrate globalState keys
  for (const [oldKey, newKey] of GLOBAL_STATE_MIGRATIONS) {
    if (await migrateGlobalStateKey(context.globalState, oldKey, newKey)) {
      migratedCount++;
    }
  }

  // Migrate secrets
  for (const [oldKey, newKey] of SECRET_MIGRATIONS) {
    if (await migrateSecretKey(context.secrets, oldKey, newKey)) {
      migratedCount++;
    }
  }

  // Mark migration complete
  await context.globalState.update(
    MIGRATION_VERSION_KEY,
    CURRENT_MIGRATION_VERSION
  );

  if (migratedCount > 0) {
    vscode.window.showInformationMessage(
      `Redmyne: Migrated ${migratedCount} settings to new namespace`
    );
  }
}
