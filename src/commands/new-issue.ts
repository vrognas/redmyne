import * as vscode from "vscode";
import { errorToString } from "../utilities/error-feedback";
import { ActionProperties } from "./action-properties";
import { runWithServerProgress } from "./commons/open-actions-for-issue-id";

export default async ({ server, config }: ActionProperties) => {
  const open = (projectName: string) => {
    vscode.commands
      .executeCommand(
        "vscode.open",
        vscode.Uri.parse(
          `${server.options.address}/projects/${projectName}/issues/new`
        )
      )
      .then(undefined, (reason) => {
        vscode.window.showErrorMessage(reason);
      });
  };

  if (config.defaultProject) {
    return open(config.defaultProject);
  }

  const projects = await runWithServerProgress(server, () =>
    server.getProjects()
  );
  if (!projects) return;

  try {
    const project = await vscode.window.showQuickPick(
      projects.map((project) => project.toQuickPickItem()),
      {
        title: "New Issue",
        placeHolder: "Choose project to create issue in",
      }
    );

    if (project === undefined) return;

    open(project.identifier);
  } catch (error) {
    vscode.window.showErrorMessage(errorToString(error));
  }
};
