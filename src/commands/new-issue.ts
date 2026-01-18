import * as vscode from "vscode";
import { errorToString } from "../utilities/error-feedback";
import { ActionProperties } from "./action-properties";

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

  const promise = server.getProjects();

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
    },
    (progress) => {
      progress.report({
        message: `Waiting for response from ${server.options.url.hostname}...`,
      });
      return promise;
    }
  );

  try {
    const projects = await promise;

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
