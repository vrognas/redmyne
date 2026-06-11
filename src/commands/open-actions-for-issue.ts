import * as vscode from "vscode";
import { ActionProperties } from "./action-properties";
import openActionsForIssueId from "./commons/open-actions-for-issue-id";

/** Context menus forward `{ id }` payloads; palette invocations pass nothing. */
function normalizeIssueIdArg(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && "id" in arg) {
    const id = (arg as { id: unknown }).id;
    if (typeof id === "number" || typeof id === "string") return String(id);
  }
  return undefined;
}

export default async ({ server }: ActionProperties, ...args: unknown[]) => {
  let issueId = normalizeIssueIdArg(args[0]);
  if (!issueId) {
    issueId = await vscode.window.showInputBox({
      placeHolder: "Type in issue id",
    });
  }

  await openActionsForIssueId(server, issueId);
};
