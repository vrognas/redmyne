import * as vscode from "vscode";
import { showStatusBarMessage } from "../utilities/status-bar";

function getServerUrl(): string | undefined {
  return vscode.workspace.getConfiguration("redmyne").get<string>("serverUrl");
}

export function registerNavigationClipboardCommands(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("redmyne.openIssueInBrowser", async (issue: { id: number } | undefined) => {
      if (!issue?.id) {
        vscode.window.showErrorMessage("Could not determine issue ID");
        return;
      }

      const url = getServerUrl();
      if (!url) {
        vscode.window.showErrorMessage("No Redmine URL configured");
        return;
      }

      await vscode.env.openExternal(vscode.Uri.parse(`${url}/issues/${issue.id}`));
    }),

    vscode.commands.registerCommand("redmyne.copyIssueUrl", async (issue: { id: number } | undefined) => {
      if (!issue?.id) {
        vscode.window.showErrorMessage("Could not determine issue ID");
        return;
      }

      const url = getServerUrl();
      if (!url) {
        vscode.window.showErrorMessage("No Redmine URL configured");
        return;
      }

      const issueUrl = `${url}/issues/${issue.id}`;
      await vscode.env.clipboard.writeText(issueUrl);
      showStatusBarMessage(`$(check) Copied #${issue.id} URL`, 2000);
    }),

    vscode.commands.registerCommand("redmyne.copyIssueId", async (issue: { id: number } | undefined) => {
      if (!issue?.id) {
        vscode.window.showErrorMessage("Could not determine issue ID");
        return;
      }

      await vscode.env.clipboard.writeText(`#${issue.id}`);
      showStatusBarMessage(`$(check) Copied #${issue.id}`, 2000);
    }),

    vscode.commands.registerCommand("redmyne.copyProjectId", async (project: { id: number } | undefined) => {
      if (!project?.id) {
        vscode.window.showErrorMessage("Could not determine project ID");
        return;
      }

      await vscode.env.clipboard.writeText(`#${project.id}`);
      showStatusBarMessage(`$(check) Copied project #${project.id}`, 2000);
    }),

    vscode.commands.registerCommand(
      "redmyne.copyProjectUrl",
      async (project: { id: number; identifier?: string } | undefined) => {
        if (!project?.identifier) {
          vscode.window.showErrorMessage("Could not determine project identifier");
          return;
        }

        const url = getServerUrl();
        if (!url) {
          vscode.window.showErrorMessage("No Redmine URL configured");
          return;
        }

        const projectUrl = `${url}/projects/${project.identifier}`;
        await vscode.env.clipboard.writeText(projectUrl);
        showStatusBarMessage("$(check) Copied project URL", 2000);
      }
    ),
  ];
}
