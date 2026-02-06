import * as vscode from "vscode";
import {
  getConfiguredServerUrlOrShowError,
  getIssueIdOrShowError,
  getProjectIdOrShowError,
  getProjectIdentifierOrShowError,
} from "./command-guards";
import { buildIssueUrl, buildProjectUrl } from "./command-urls";
import { showStatusBarMessage } from "../utilities/status-bar";

export function registerNavigationClipboardCommands(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("redmyne.openIssueInBrowser", async (issue: { id: number } | undefined) => {
      const issueId = getIssueIdOrShowError(issue);
      if (!issueId) return;
      const url = getConfiguredServerUrlOrShowError();
      if (!url) return;
      await vscode.env.openExternal(vscode.Uri.parse(buildIssueUrl(url, issueId)));
    }),

    vscode.commands.registerCommand("redmyne.copyIssueUrl", async (issue: { id: number } | undefined) => {
      const issueId = getIssueIdOrShowError(issue);
      if (!issueId) return;
      const url = getConfiguredServerUrlOrShowError();
      if (!url) return;
      await vscode.env.clipboard.writeText(buildIssueUrl(url, issueId));
      showStatusBarMessage(`$(check) Copied #${issueId} URL`, 2000);
    }),

    vscode.commands.registerCommand("redmyne.copyIssueId", async (issue: { id: number } | undefined) => {
      const issueId = getIssueIdOrShowError(issue);
      if (!issueId) return;
      await vscode.env.clipboard.writeText(`#${issueId}`);
      showStatusBarMessage(`$(check) Copied #${issueId}`, 2000);
    }),

    vscode.commands.registerCommand("redmyne.copyProjectId", async (project: { id: number } | undefined) => {
      const projectId = getProjectIdOrShowError(project);
      if (!projectId) return;
      await vscode.env.clipboard.writeText(`#${projectId}`);
      showStatusBarMessage(`$(check) Copied project #${projectId}`, 2000);
    }),

    vscode.commands.registerCommand(
      "redmyne.copyProjectUrl",
      async (project: { id: number; identifier?: string } | undefined) => {
        const identifier = getProjectIdentifierOrShowError(project);
        if (!identifier) return;
        const url = getConfiguredServerUrlOrShowError();
        if (!url) return;
        await vscode.env.clipboard.writeText(buildProjectUrl(url, identifier));
        showStatusBarMessage("$(check) Copied project URL", 2000);
      }
    ),
  ];
}
