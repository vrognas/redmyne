import * as vscode from "vscode";

/**
 * Typed accessors for `redmyne.*` settings — the single owner of these key
 * strings and their defaults, replacing scattered
 * `vscode.workspace.getConfiguration("redmyne").get(...)` reads.
 *
 * Excluded by design (they have dedicated owners or decoupling needs):
 * `serverUrl` (site-specific normalization), `weeklySchedule`
 * (getWeeklySchedule in flexibility-calculator), `caFile`/`additionalHeaders`
 * (buildServerOptionsFromConfig in server-config), and `autoUpdateDonePercent`
 * (read via dynamic vscode import in redmine-server, which stays vscode-free).
 */
function read(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("redmyne");
}

export const redmyneConfig = {
  taskTypeField: (): string => read().get<string>("taskTypeField", "Task Type"),
  loggingEnabled: (): boolean => read().get<boolean>("logging.enabled") ?? false,
  maxConcurrentRequests: (): number => read().get<number>("maxConcurrentRequests") ?? 4,
  showProjectMembers: (): boolean => read().get<boolean>("showProjectMembers", true),
  hideProjectMembersFor: (): number[] => read().get<number[]>("hideProjectMembersFor", []),
  showWorkload: (): boolean =>
    vscode.workspace.getConfiguration("redmyne.statusBar").get<boolean>("showWorkload", false),
};
