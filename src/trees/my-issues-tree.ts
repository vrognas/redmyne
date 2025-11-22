import * as vscode from "vscode";
import { Issue } from "../redmine/models/issue";
import { RedmineServer } from "../redmine/redmine-server";
import { RedmineConfig } from "../definitions/redmine-config";

export class MyIssuesTree implements vscode.TreeDataProvider<Issue> {
  server?: RedmineServer;
  constructor() {
    // Don't initialize server here - will be set via setServer() when config is ready
  }

  onDidChangeTreeData$ = new vscode.EventEmitter<void>();
  onDidChangeTreeData: vscode.Event<void> = this.onDidChangeTreeData$.event;
  getTreeItem(issue: Issue): vscode.TreeItem | Thenable<vscode.TreeItem> {
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
  async getChildren(_element?: Issue): Promise<Issue[]> {
    if (!this.server) {
      return [];
    }
    return (await this.server.getIssuesAssignedToMe()).issues;
  }

  setServer(server: RedmineServer | undefined) {
    this.server = server;
  }
}
