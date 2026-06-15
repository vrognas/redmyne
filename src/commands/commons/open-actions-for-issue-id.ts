import type { IRedmineServer } from "../../redmine/redmine-server-interface";
import * as vscode from "vscode";
import { IssueController } from "../../controllers/issue-controller";
import { errorToString } from "../../utilities/error-feedback";
import { parseIssueId } from "../../utilities/validation";

/**
 * Run a server operation while showing a fire-and-forget
 * "Waiting for response from {hostname}..." notification, surfacing any
 * failure via showErrorMessage(errorToString(error)).
 *
 * Returns the resolved value, or undefined if the operation rejected (the
 * error is reported to the user, not re-thrown). The progress notification is
 * given its own catch so a rejection does not produce a second unhandled
 * rejection alongside the awaited one.
 */
export async function runWithServerProgress<T>(
  server: IRedmineServer,
  operation: () => Promise<T>
): Promise<T | undefined> {
  const promise = operation();

  void vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
    },
    (progress) => {
      progress.report({
        message: `Waiting for response from ${server.options.url.hostname}...`,
      });
      return promise;
    }
  );
  // Swallow the progress notification's copy of the rejection; the awaited
  // call below is the single place we surface the error from.
  promise.catch(() => undefined);

  try {
    return await promise;
  } catch (error) {
    vscode.window.showErrorMessage(errorToString(error));
    return undefined;
  }
}

export default async (
  server: IRedmineServer,
  issueId: string | null | undefined
) => {
  const parsedId = parseIssueId(issueId);
  if (!parsedId) {
    return;
  }

  const issue = await runWithServerProgress(server, () =>
    server.getIssueById(parsedId)
  );

  if (!issue) return;

  const controller = new IssueController(issue.issue, server);

  void controller.listActions();
};
