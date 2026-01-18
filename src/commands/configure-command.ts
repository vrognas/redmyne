/**
 * Configure Command
 * Handles Redmine URL and API key configuration
 */

import * as vscode from "vscode";
import { RedmineSecretManager } from "../utilities/secret-manager";
import { showStatusBarMessage } from "../utilities/status-bar";

export interface ConfigureCommandDeps {
  secretManager: RedmineSecretManager;
  updateConfiguredContext: () => Promise<void>;
}

export function registerConfigureCommand(
  context: vscode.ExtensionContext,
  deps: ConfigureCommandDeps
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.configure", async () => {
      const config = vscode.workspace.getConfiguration("redmyne");
      const existingUrl = config.get<string>("serverUrl");
      const existingApiKey = await deps.secretManager.getApiKey();

      let url = existingUrl;
      let shouldUpdateApiKey = false;

      if (existingUrl && existingApiKey) {
        const choice = await vscode.window.showQuickPick(
          [
            {
              label: "$(link) Update Redmine URL",
              description: `Current: ${existingUrl}`,
              value: "url",
            },
            {
              label: "$(key) Update API Key",
              description: "Stored securely in secrets",
              value: "apiKey",
            },
            { label: "$(settings-gear) Reconfigure Both", value: "both" },
          ],
          {
            title: "Redmyne Configuration",
            placeHolder: "What would you like to update?",
          }
        );

        if (!choice) return;

        if (choice.value === "url" || choice.value === "both") {
          url = await promptForUrl(existingUrl);
          if (!url) return;
          await config.update("serverUrl", url, vscode.ConfigurationTarget.Global);
        }

        shouldUpdateApiKey = choice.value === "apiKey" || choice.value === "both";
      } else if (existingUrl && !existingApiKey) {
        const choice = await vscode.window.showQuickPick(
          [
            {
              label: "$(check) Keep Current URL",
              description: existingUrl,
              value: "keep",
            },
            { label: "$(link) Change URL", value: "change" },
          ],
          {
            title: "Redmyne Configuration",
            placeHolder: "Your Redmine URL is configured. Do you want to change it?",
          }
        );

        if (!choice) return;

        if (choice.value === "change") {
          url = await promptForUrl(existingUrl);
          if (!url) return;
          await config.update("serverUrl", url, vscode.ConfigurationTarget.Global);
        }

        shouldUpdateApiKey = true;
      } else if (!existingUrl && existingApiKey) {
        const action = await vscode.window.showWarningMessage(
          "Invalid configuration detected",
          {
            modal: true,
            detail:
              "An API key exists but no Redmine URL is configured. API keys are specific to a Redmine server.\n\nWould you like to reconfigure from scratch?",
          },
          "Reconfigure"
        );

        if (action !== "Reconfigure") return;

        await deps.secretManager.deleteApiKey();

        url = await promptForUrl();
        if (!url) return;
        await config.update("serverUrl", url, vscode.ConfigurationTarget.Global);
        shouldUpdateApiKey = true;
      } else {
        const proceed = await vscode.window.showInformationMessage(
          "Secure Configuration",
          {
            modal: true,
            detail:
              "How your credentials are stored:\n\n• URL: User settings (settings.json)\n• API Key: Encrypted secrets storage\n  - Windows: Credential Manager\n  - macOS: Keychain\n  - Linux: libsecret\n\nAPI keys are machine-local and never synced to the cloud.",
          },
          "Continue"
        );

        if (proceed !== "Continue") return;

        url = await promptForUrl();
        if (!url) return;
        await config.update("serverUrl", url, vscode.ConfigurationTarget.Global);
        shouldUpdateApiKey = true;
      }

      if (shouldUpdateApiKey && url) {
        const success = await promptForApiKey(deps.secretManager, url);
        if (!success) return;
      }

      await deps.updateConfiguredContext();
      showStatusBarMessage("$(check) Redmyne configured", 3000);
    })
  );
}

async function promptForUrl(currentUrl?: string): Promise<string | undefined> {
  const prompt = currentUrl
    ? "Update your server URL (changing URL will require new API key)"
    : "Step 1/2: Enter your Redmine server URL (HTTPS required)";

  return await vscode.window.showInputBox({
    prompt,
    value: currentUrl,
    placeHolder: "https://redmine.example.com",
    validateInput: (value) => {
      if (!value) return "URL cannot be empty";
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return "Invalid URL format";
      }
      if (url.protocol !== "https:") {
        return "HTTPS required. URL must start with https://";
      }
      return null;
    },
  });
}

async function promptForApiKey(
  manager: RedmineSecretManager,
  url: string
): Promise<boolean> {
  const action = await vscode.window.showInformationMessage(
    "You need your Redmine API key",
    {
      modal: true,
      detail:
        'Your API key can be found in your Redmine account settings.\n\nClick "Open Redmine" to open your account page, then copy your API key and paste it in the next step.',
    },
    "Open Redmine Account",
    "I Have My Key"
  );

  if (!action) return false;

  if (action === "Open Redmine Account") {
    await vscode.env.openExternal(vscode.Uri.parse(`${url}/my/account`));
    await vscode.window.showInformationMessage(
      'Copy your API key from the "API access key" section on the right side of the page.',
      { modal: false },
      "Got It"
    );
  }

  const apiKey = await vscode.window.showInputBox({
    prompt: "Paste your Redmine API key",
    placeHolder: "e.g., a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0",
    password: true,
    validateInput: (value) => {
      if (!value) return "API key cannot be empty";
      if (value.length < 20) return "API key appears too short";
      return null;
    },
  });

  if (!apiKey) return false;

  await manager.setApiKey(apiKey);
  return true;
}
