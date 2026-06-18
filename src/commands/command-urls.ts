import { normalizeServerUrl } from "../utilities/server-url";

export function buildIssueUrl(serverUrl: string, issueId: number): string {
  return `${normalizeServerUrl(serverUrl)}/issues/${issueId}`;
}

export function buildProjectUrl(
  serverUrl: string,
  projectIdentifier: string
): string {
  return `${normalizeServerUrl(serverUrl)}/projects/${projectIdentifier}`;
}
