import type * as vscode from "vscode";

/**
 * True when a `redmyne.*` configuration change touches ONLY a client-side
 * id-set (ad-hoc budget / auto-update / precedence) and nothing server-related.
 *
 * Those sets are written purely as local state by in-extension toggles, which
 * already trigger their own lightweight Gantt/tree refresh. Rebuilding the
 * server context for them (which constructs a fresh RedmineServer, wiping every
 * cache, and reloads all issues/time entries) is pure waste — and it discards
 * the very caches the toggle's self-refresh would otherwise reuse.
 *
 * Returns false the moment a server-affecting key (`serverUrl`,
 * `additionalHeaders`, `caFile`, `maxConcurrentRequests`, `logging`) is also
 * part of the change, so a combined change still rebuilds the server.
 */
export function isClientStateOnlyConfigChange(
  event: vscode.ConfigurationChangeEvent,
): boolean {
  const serverAffecting =
    event.affectsConfiguration("redmyne.serverUrl") ||
    event.affectsConfiguration("redmyne.additionalHeaders") ||
    event.affectsConfiguration("redmyne.caFile") ||
    event.affectsConfiguration("redmyne.maxConcurrentRequests") ||
    event.affectsConfiguration("redmyne.logging");
  if (serverAffecting) return false;

  return (
    event.affectsConfiguration("redmyne.adHocBudgetIssues") ||
    event.affectsConfiguration("redmyne.autoUpdateIssues") ||
    event.affectsConfiguration("redmyne.precedenceIssues")
  );
}
