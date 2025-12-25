import * as vscode from "vscode";
import { ActionProperties } from "./action-properties";
import openActionsForIssueId from "./commons/open-actions-for-issue-id";

export default async ({ server }: ActionProperties, ...args: unknown[]) => {
  let issueId = args[0] as string | undefined;
  if (!issueId) {
    issueId = await vscode.window.showInputBox({
      placeHolder: "Type in issue id",
    });
  }

  await openActionsForIssueId(server, issueId);
};
