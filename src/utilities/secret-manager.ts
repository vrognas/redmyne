import * as vscode from "vscode";

const GLOBAL_API_KEY = "redmine:global:apiKey:v2";

export class RedmineSecretManager {
  constructor(private context: vscode.ExtensionContext) {}

  async getApiKey(): Promise<string | undefined> {
    try {
      return await this.context.secrets.get(GLOBAL_API_KEY);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to retrieve API key: ${err}`);
      return undefined;
    }
  }

  async setApiKey(apiKey: string): Promise<void> {
    await this.context.secrets.store(GLOBAL_API_KEY, apiKey);
  }

  async deleteApiKey(): Promise<void> {
    await this.context.secrets.delete(GLOBAL_API_KEY);
  }

  onSecretChanged(callback: () => void): vscode.Disposable {
    return this.context.secrets.onDidChange((event) => {
      if (event.key === GLOBAL_API_KEY) {
        callback();
      }
    });
  }
}
