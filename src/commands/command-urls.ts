export function buildIssueUrl(serverUrl: string, issueId: number): string {
  return `${serverUrl}/issues/${issueId}`;
}

export function buildProjectUrl(
  serverUrl: string,
  projectIdentifier: string
): string {
  return `${serverUrl}/projects/${projectIdentifier}`;
}
