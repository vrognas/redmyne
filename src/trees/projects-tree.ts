import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { RedmineProject } from "../redmine/redmine-project";
import { Issue } from "../redmine/models/issue";

export enum ProjectsViewStyle {
  LIST = 0,
  TREE = 1,
}

export class ProjectsTree
  implements vscode.TreeDataProvider<RedmineProject | Issue>
{
  server?: RedmineServer;
  viewStyle: ProjectsViewStyle;
  projects: RedmineProject[] | null = null;
  private isLoadingProjects = false;
  private loadingIssuesForProject = new Set<number>();

  constructor() {
    // Don't initialize server here - will be set via setServer() when config is ready
    this.viewStyle = ProjectsViewStyle.LIST;
  }

  onDidChangeTreeData$ = new vscode.EventEmitter<void>();
  onDidChangeTreeData: vscode.Event<void> = this.onDidChangeTreeData$.event;
  getTreeItem(
    projectOrIssue: RedmineProject | Issue | any
  ): vscode.TreeItem | Thenable<vscode.TreeItem> {
    if (projectOrIssue.isLoadingPlaceholder) {
      return new vscode.TreeItem(
        projectOrIssue.message || "⏳ Loading...",
        vscode.TreeItemCollapsibleState.None
      );
    }

    if (projectOrIssue instanceof RedmineProject) {
      return new vscode.TreeItem(
        projectOrIssue.toQuickPickItem().label,
        vscode.TreeItemCollapsibleState.Collapsed
      );
    } else {
      const item = new vscode.TreeItem(
        `#${projectOrIssue.id} [${projectOrIssue.tracker.name}] (${projectOrIssue.status.name}) ${projectOrIssue.subject} by ${projectOrIssue.author.name}`,
        vscode.TreeItemCollapsibleState.None
      );

      item.command = {
        command: "redmine.openActionsForIssue",
        arguments: [false, { server: this.server }, `${projectOrIssue.id}`],
        title: `Open actions for issue #${projectOrIssue.id}`,
      };

      return item;
    }
  }
  async getChildren(
    projectOrIssue?: RedmineProject | Issue
  ): Promise<(RedmineProject | Issue | any)[]> {
    if (!this.server) {
      return [];
    }

    if (
      projectOrIssue !== null &&
      projectOrIssue !== undefined &&
      projectOrIssue instanceof RedmineProject
    ) {
      if (this.loadingIssuesForProject.has(projectOrIssue.id)) {
        return [{ isLoadingPlaceholder: true, message: "⏳ Loading issues..." }];
      }

      this.loadingIssuesForProject.add(projectOrIssue.id);
      try {
        if (this.viewStyle === ProjectsViewStyle.TREE) {
          const subprojects: (RedmineProject | Issue)[] = (
            this.projects ?? []
          ).filter(
            (project) => project.parent && project.parent.id === projectOrIssue.id
          );
          return subprojects.concat(
            (await this.server.getOpenIssuesForProject(projectOrIssue.id, false))
              .issues
          );
        }

        return (await this.server.getOpenIssuesForProject(projectOrIssue.id))
          .issues;
      } finally {
        this.loadingIssuesForProject.delete(projectOrIssue.id);
      }
    }

    if (this.isLoadingProjects) {
      return [{ isLoadingPlaceholder: true, message: "⏳ Loading projects..." }];
    }

    if (!this.projects || this.projects.length === 0) {
      this.isLoadingProjects = true;
      try {
        this.projects = await this.server.getProjects();
      } finally {
        this.isLoadingProjects = false;
      }
    }

    if (this.viewStyle === ProjectsViewStyle.TREE) {
      return this.projects.filter((project) => !project.parent);
    }
    return this.projects;
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
  }
}
