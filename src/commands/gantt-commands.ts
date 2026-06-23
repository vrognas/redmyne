/**
 * Gantt Commands
 * Commands for the Gantt timeline view
 */

import * as vscode from "vscode";
import { FlexibilityScore, getWeeklySchedule } from "../utilities/flexibility-calculator";
import { GanttPanel } from "../webviews/gantt-panel";
import { Issue } from "../redmine/models/issue";
import type { IRedmineServer } from "../redmine/redmine-server-interface";
import { RedmineProject } from "../redmine/redmine-project";
import { IssueFilter } from "../redmine/models/common";
import type { DraftModeManager } from "../draft-mode/draft-mode-manager";
import { getIssueIdOrShowError } from "./command-guards";

export interface GanttCommandDeps {
  getServer: () => IRedmineServer | undefined;
  fetchIssuesIfNeeded: () => Promise<Issue[]>;
  getDependencyIssues: () => Issue[];
  getFlexibilityCache: () => Map<number, FlexibilityScore | null>;
  getProjects: () => RedmineProject[];
  clearProjects: () => void;
  getFilter: () => IssueFilter;
  setFilter: (filter: IssueFilter) => void;
  getDraftModeManager: () => DraftModeManager | undefined;
}

export function registerGanttCommands(
  context: vscode.ExtensionContext,
  deps: GanttCommandDeps
): void {
  const getSchedule = getWeeklySchedule;

  function bootstrapPanel(issues: Issue[]): ReturnType<typeof GanttPanel.createOrShow> {
    const panel = GanttPanel.createOrShow(context.extensionUri, deps.getServer, deps.getDraftModeManager);
    void panel.updateIssues(issues, deps.getFlexibilityCache(), deps.getProjects(), getSchedule(), deps.getFilter(), deps.getDependencyIssues(), deps.getServer);
    panel.setFilterChangeCallback((filter) => deps.setFilter(filter));
    return panel;
  }

  context.subscriptions.push(
    // Gantt timeline command
    vscode.commands.registerCommand("redmyne.showGantt", async () => {
      const issues = await deps.fetchIssuesIfNeeded();
      if (issues.length === 0) {
        vscode.window.showInformationMessage(
          "No issues to display. Configure Redmine and assign issues to yourself."
        );
        return;
      }
      bootstrapPanel(issues);
    }),

    // Refresh Gantt data without resetting view state
    vscode.commands.registerCommand("redmyne.refreshGanttData", async () => {
      const panel = GanttPanel.currentPanel;
      if (!panel) return;
      const issues = await deps.fetchIssuesIfNeeded();
      if (issues.length === 0) return;
      void panel.updateIssues(issues, deps.getFlexibilityCache(), deps.getProjects(), getSchedule(), deps.getFilter(), deps.getDependencyIssues(), deps.getServer);
    }),

    // Open specific issue in Gantt (context menu)
    vscode.commands.registerCommand("redmyne.openIssueInGantt", async (issue: { id: number; project?: { id: number } } | undefined) => {
      const issueId = getIssueIdOrShowError(issue);
      if (!issueId) return;
      const issues = await deps.fetchIssuesIfNeeded();
      if (issues.length === 0) {
        vscode.window.showInformationMessage(
          "No issues to display. Configure Redmine and assign issues to yourself."
        );
        return;
      }
      const panel = bootstrapPanel(issues);

      // Reveal in place when the issue already passes the current filters;
      // otherwise broaden to the all-projects by-project view first, then
      // reveal. bootstrapPanel set _issues synchronously, so the check is
      // valid now even though the render is still in flight.
      if (panel.isIssueInCurrentFilter(issueId)) {
        setTimeout(() => panel.revealIssue(issueId), 150);
      } else {
        panel.broadenViewForReveal();
        void panel.updateIssues(
          issues,
          deps.getFlexibilityCache(),
          deps.getProjects(),
          getSchedule(),
          deps.getFilter(),
          deps.getDependencyIssues(),
          deps.getServer
        );
        setTimeout(() => panel.revealIssue(issueId), 250);
      }
    })
  );
}
