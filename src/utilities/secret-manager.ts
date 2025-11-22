import * as vscode from 'vscode';

export class RedmineSecretManager {
  constructor(private context: vscode.ExtensionContext) {}

  private buildKey(folderUri: vscode.Uri, field: string): string {
    const encoded = Buffer.from(folderUri.toString()).toString('hex');
    return `redmine:${encoded}:${field}:v1`;
  }

  async getApiKey(folderUri: vscode.Uri): Promise<string | undefined> {
    const key = this.buildKey(folderUri, 'apiKey');
    try {
      return await this.context.secrets.get(key);
    } catch (err) {
      console.error('Failed to retrieve API key:', err);
      return undefined;
    }
  }

  async setApiKey(folderUri: vscode.Uri, apiKey: string): Promise<void> {
    const key = this.buildKey(folderUri, 'apiKey');
    await this.context.secrets.store(key, apiKey);
  }

  async deleteApiKey(folderUri: vscode.Uri): Promise<void> {
    const key = this.buildKey(folderUri, 'apiKey');
    await this.context.secrets.delete(key);
  }

  onSecretChanged(callback: (key: string) => void): vscode.Disposable {
    return this.context.secrets.onDidChange((event) => {
      if (event.key.startsWith('redmine:')) {
        callback(event.key);
      }
    });
  }
}
