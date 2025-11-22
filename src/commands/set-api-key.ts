import * as vscode from "vscode";
import { RedmineSecretManager } from "../utilities/secret-manager";

export async function setApiKey(
  context: vscode.ExtensionContext
): Promise<void> {
  const secretManager = new RedmineSecretManager(context);

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder open");
    return;
  }

  const folder =
    folders.length === 1
      ? folders[0]
      : await vscode.window.showWorkspaceFolderPick();

  if (!folder) return;

  const apiKey = await vscode.window.showInputBox({
    prompt: `Enter Redmine API Key for ${folder.name}`,
    password: true,
    validateInput: (value) => {
      if (!value) return "API key cannot be empty";
      if (value.length < 20) return "API key appears invalid";
      return null;
    },
  });

  if (!apiKey) return;

  await secretManager.setApiKey(folder.uri, apiKey);
  vscode.window.showInformationMessage(
    `API key for ${folder.name} stored securely`
  );
}
