import * as vscode from "vscode";
import { RedmineSecretManager } from "../utilities/secret-manager";
import { showStatusBarMessage } from "../utilities/status-bar";

export async function setApiKey(
  context: vscode.ExtensionContext
): Promise<void> {
  const secretManager = new RedmineSecretManager(context);

  const apiKey = await vscode.window.showInputBox({
    prompt: "Enter Redmine API Key",
    password: true,
    validateInput: (value) => {
      if (!value) return "API key cannot be empty";
      if (value.length < 20) return "API key appears invalid";
      return null;
    },
  });

  if (!apiKey) return;

  await secretManager.setApiKey(apiKey);
  showStatusBarMessage("$(check) API key stored securely", 2000);
}
