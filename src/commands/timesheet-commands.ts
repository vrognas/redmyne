/**
 * TimeSheet Commands Registration
 */

import * as vscode from "vscode";
import { TimeSheetPanel } from "../webviews/timesheet-panel";
import { RedmineServer } from "../redmine/redmine-server";
import { DraftQueue } from "../draft-mode/draft-queue";
import { DraftModeManager } from "../draft-mode/draft-mode-manager";
import { Issue } from "../redmine/models/issue";

export interface TimeSheetCommandsDeps {
  getServer: () => RedmineServer | undefined;
  getDraftQueue: () => DraftQueue | undefined;
  getDraftModeManager: () => DraftModeManager | undefined;
  getCachedIssues: () => Issue[];
}

export function registerTimeSheetCommands(
  context: vscode.ExtensionContext,
  deps: TimeSheetCommandsDeps
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Register show command
  disposables.push(
    vscode.commands.registerCommand("redmyne.showTimeSheet", () => {
      TimeSheetPanel.createOrShow(
        context.extensionUri,
        context,
        deps.getServer(),
        deps.getDraftQueue(),
        deps.getDraftModeManager(),
        deps.getCachedIssues
      );
    })
  );

  // Register webview panel serializer for restore on reload
  vscode.window.registerWebviewPanelSerializer("redmyneTimeSheet", {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
      TimeSheetPanel.restore(panel, context.extensionUri, context, deps.getServer());
    },
  });

  return disposables;
}
