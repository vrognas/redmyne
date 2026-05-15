import type { IRedmineServer } from "../redmine/redmine-server-interface";
import { Issue } from "../redmine/models/issue";

/**
 * Fetch "my open" and "my closed" issues in parallel. Shared by issue
 * pickers and kanban dialogs.
 */
export async function fetchMyOpenAndClosedIssues(
  server: IRedmineServer
): Promise<{ open: Issue[]; closed: Issue[] }> {
  const [openResult, closedResult] = await Promise.all([
    server.getFilteredIssues({ assignee: "me", status: "open" }),
    server.getFilteredIssues({ assignee: "me", status: "closed" }),
  ]);
  return { open: openResult.issues, closed: closedResult.issues };
}
