import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { RedmineConfig } from "../definitions/redmine-config";
import { RedmineProject } from "../redmine/redmine-project";
import { Issue } from "../redmine/models/issue";

export enum ProjectsViewStyle {
  LIST = 0,
  TREE = 1,
}

class ServerStatus {
  constructor(public readonly url: string) {}
}

export class ProjectsTree
  implements vscode.TreeDataProvider<RedmineProject | Issue | ServerStatus> {
  server?: RedmineServer;
  serverUrl?: string;
  viewStyle: ProjectsViewStyle;
  projects: RedmineProject[] | null = null;
  constructor() {
    // Don't initialize server here - will be set via setServer() when config is ready
    this.viewStyle = ProjectsViewStyle.LIST;
  }

  onDidChangeTreeData$ = new vscode.EventEmitter<void>();
  onDidChangeTreeData: vscode.Event<void> = this
    .onDidChangeTreeData$.event;
  getTreeItem(
    element: RedmineProject | Issue | ServerStatus
  ): vscode.TreeItem | Thenable<vscode.TreeItem> {
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

    if (element instanceof RedmineProject) {
      return new vscode.TreeItem(
        element.toQuickPickItem().label,
        vscode.TreeItemCollapsibleState.Collapsed
      );
    } else {
      const item = new vscode.TreeItem(
        `#${element.id} [${element.tracker.name}] (${element.status.name}) ${element.subject} by ${element.author.name}`,
        vscode.TreeItemCollapsibleState.None
      );

      item.command = {
        command: "redmine.openActionsForIssue",
        arguments: [false, { server: this.server }, `${element.id}`],
        title: `Open actions for issue #${element.id}`,
      };

      return item;
    }
  }
  async getChildren(
    element?: RedmineProject | Issue | ServerStatus
  ): Promise<(RedmineProject | Issue | ServerStatus)[]> {
    if (!this.server) {
      return [];
    }

    // Don't expand server status or issues
    if (element instanceof ServerStatus || (element && !(element instanceof RedmineProject))) {
      return [];
    }

    if (
      element !== null &&
      element !== undefined &&
      element instanceof RedmineProject
    ) {
      if (this.viewStyle === ProjectsViewStyle.TREE) {
        const subprojects: (RedmineProject | Issue)[] = (this.projects ?? []).filter(
          (project) => project.parent && project.parent.id === element.id
        );
        return subprojects.concat(
          (await this.server.getOpenIssuesForProject(element.id, false))
            .issues
        );
      }

      return (await this.server.getOpenIssuesForProject(element.id))
        .issues;
    }

    if (!this.projects || this.projects.length === 0) {
      this.projects = await this.server.getProjects();
    }

    const items: (RedmineProject | Issue | ServerStatus)[] = [];
    if (this.serverUrl) {
      items.push(new ServerStatus(this.serverUrl));
    }

    if (this.viewStyle === ProjectsViewStyle.TREE) {
      return items.concat(this.projects.filter((project) => !project.parent));
    }
    return items.concat(this.projects);
  }

  clearProjects() {
    this.projects = [];
  }

  setViewStyle(style: ProjectsViewStyle) {
    this.viewStyle = style;
    this.onDidChangeTreeData$.fire();
  }

  setServer(server: RedmineServer | undefined) {
    this.server = server;
    this.serverUrl = server?.options.address;
  }
}
