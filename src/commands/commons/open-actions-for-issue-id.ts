import { RedmineServer } from "../../redmine/redmine-server";
import * as vscode from "vscode";
import { IssueController } from "../../controllers/issue-controller";
import { errorToString } from "../../utilities/error-feedback";
import { parseIssueId } from "../../utilities/validation";

export default async (
  server: RedmineServer,
  issueId: string | null | undefined
) => {
  const parsedId = parseIssueId(issueId);
  if (!parsedId) {
    return;
  }

  const promise = server.getIssueById(parsedId);

  vscode.window.withProgress(
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

  try {
    const issue = await promise;

    if (!issue) return;

    const controller = new IssueController(issue.issue, server);

    controller.listActions();
  } catch (error) {
    vscode.window.showErrorMessage(errorToString(error));
  }
};
