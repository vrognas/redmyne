import * as vscode from "vscode";
import { Issue } from "../redmine/models/issue";
import { RedmineServer } from "../redmine/redmine-server";
import { RedmineConfig } from "../definitions/redmine-config";

class ServerStatus {
  constructor(public readonly url: string) {}
}

export class MyIssuesTree implements vscode.TreeDataProvider<Issue | ServerStatus> {
  server?: RedmineServer;
  serverUrl?: string;
  constructor() {
    // Don't initialize server here - will be set via setServer() when config is ready
  }

  onDidChangeTreeData$ = new vscode.EventEmitter<void>();
  onDidChangeTreeData: vscode.Event<void> = this.onDidChangeTreeData$.event;
  getTreeItem(element: Issue | ServerStatus): vscode.TreeItem | Thenable<vscode.TreeItem> {
    if (element instanceof ServerStatus) {
      const item = new vscode.TreeItem(
        element.url,
        vscode.TreeItemCollapsibleState.None
      );
      item.iconPath = new vscode.ThemeIcon('globe');
      item.description = 'Redmine Server';
      item.contextValue = 'serverStatus';
      return item;
    }

    const issue = element as Issue;
    const item = new vscode.TreeItem(
      `#${issue.id} [${issue.tracker.name}] (${issue.status.name}) ${issue.subject} by ${issue.author.name}`,
      vscode.TreeItemCollapsibleState.None
    );

    item.command = {
      command: "redmine.openActionsForIssue",
      arguments: [false, { server: this.server }, `${issue.id}`],
      title: `Open actions for issue #${issue.id}`,
    };

    return item;
  }
  async getChildren(_element?: Issue | ServerStatus): Promise<(Issue | ServerStatus)[]> {
    if (!this.server) {
      return [];
    }
    const items: (Issue | ServerStatus)[] = [];
    if (this.serverUrl) {
      items.push(new ServerStatus(this.serverUrl));
    }
    const issues = (await this.server.getIssuesAssignedToMe()).issues;
    return items.concat(issues);
  }

  setServer(server: RedmineServer | undefined) {
    this.server = server;
    this.serverUrl = server?.options.address;
  }
}
