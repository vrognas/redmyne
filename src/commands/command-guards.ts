import * as vscode from "vscode";

export type OptionalId = { id?: number } | undefined;
export type OptionalProjectIdentifier = { identifier?: string } | undefined;
export type OptionalNestedProjectIdentifier = { project?: { identifier?: string } } | undefined;
export type OptionalNestedProjectId = { project?: { id?: number }; id?: number } | undefined;

export function ensureIssueId<T extends OptionalId>(
  issue: T
): issue is Exclude<T, undefined> & { id: number } {
  if (!issue?.id) {
    vscode.window.showErrorMessage("Could not determine issue ID");
    return false;
  }
  return true;
}

export function getIssueIdOrShowError(issue: OptionalId): number | undefined {
  if (!issue?.id) {
    vscode.window.showErrorMessage("Could not determine issue ID");
    return undefined;
  }
  return issue.id;
}

export function getProjectIdOrShowError(project: OptionalId): number | undefined {
  if (!project?.id) {
    vscode.window.showErrorMessage("Could not determine project ID");
    return undefined;
  }
  return project.id;
}

export function getNestedProjectIdOrShowError(
  node: OptionalNestedProjectId
): number | undefined {
  const projectId = node?.project?.id ?? node?.id;
  if (!projectId) {
    vscode.window.showErrorMessage("Could not determine project ID");
    return undefined;
  }
  return projectId;
}

export function getProjectIdentifierOrShowError(
  project: OptionalProjectIdentifier
): string | undefined {
  const identifier = project?.identifier;
  if (!identifier) {
    vscode.window.showErrorMessage("Could not determine project identifier");
    return undefined;
  }
  return identifier;
}

export function getNestedProjectIdentifierOrShowError(
  node: OptionalNestedProjectIdentifier
): string | undefined {
  const identifier = node?.project?.identifier;
  if (!identifier) {
    vscode.window.showErrorMessage("Could not determine project identifier");
    return undefined;
  }
  return identifier;
}

export function getConfiguredServerUrlOrShowError(
  message = "No Redmine URL configured"
): string | undefined {
  const url = vscode.workspace.getConfiguration("redmyne").get<string>("serverUrl");
  if (!url) {
    vscode.window.showErrorMessage(message);
    return undefined;
  }
  return url;
}

export function getServerOrShowError<TServer>(
  getServer: () => TServer | undefined,
  message = "No Redmine server configured"
): TServer | undefined {
  const server = getServer();
  if (!server) {
    vscode.window.showErrorMessage(message);
    return undefined;
  }
  return server;
}
