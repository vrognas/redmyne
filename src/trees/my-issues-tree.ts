import * as vscode from "vscode";
import { Issue } from "../redmine/models/issue";
import { RedmineServer } from "../redmine/redmine-server";
import { createIssueTreeItem } from "../utilities/tree-item-factory";

interface LoadingPlaceholder {
  isLoadingPlaceholder: true;
}

type TreeItem = Issue | LoadingPlaceholder;

export class MyIssuesTree implements vscode.TreeDataProvider<TreeItem> {
  server?: RedmineServer;
  private isLoading = false;

  constructor() {
    // Don't initialize server here - will be set via setServer() when config is ready
  }

  onDidChangeTreeData$ = new vscode.EventEmitter<void>();
  onDidChangeTreeData: vscode.Event<void> = this.onDidChangeTreeData$.event;
  getTreeItem(item: TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    if ("isLoadingPlaceholder" in item && item.isLoadingPlaceholder) {
      return new vscode.TreeItem(
        "⏳ Loading issues...",
        vscode.TreeItemCollapsibleState.None
      );
    }

    // Type narrowed to Issue here
    const issue = item as Issue;
    return createIssueTreeItem(issue, this.server, "redmine.openActionsForIssue");
  }
  async getChildren(_element?: TreeItem): Promise<TreeItem[]> {
    if (!this.server) {
      return [];
    }

    if (this.isLoading) {
      return [{ isLoadingPlaceholder: true }];
    }

    this.isLoading = true;
    try {
      const result = await this.server.getIssuesAssignedToMe();
      return result.issues;
    } finally {
      this.isLoading = false;
    }
  }

  setServer(server: RedmineServer | undefined) {
    this.server = server;
  }
}
