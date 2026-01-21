/**
 * Gantt Commands
 * Commands for the Gantt timeline view
 */

import * as vscode from "vscode";
import { WeeklySchedule, DEFAULT_WEEKLY_SCHEDULE, FlexibilityScore } from "../utilities/flexibility-calculator";
import { GanttPanel } from "../webviews/gantt-panel";
import { Issue } from "../redmine/models/issue";
import { RedmineServer } from "../redmine/redmine-server";
import { RedmineProject } from "../redmine/redmine-project";
import { IssueFilter } from "../redmine/models/common";

export interface GanttCommandDeps {
  getServer: () => RedmineServer | undefined;
  fetchIssuesIfNeeded: () => Promise<Issue[]>;
  getDependencyIssues: () => Issue[];
  getFlexibilityCache: () => Map<number, FlexibilityScore | null>;
  getProjects: () => RedmineProject[];
  clearProjects: () => void;
  getFilter: () => IssueFilter;
  setFilter: (filter: IssueFilter) => void;
}

export function registerGanttCommands(
  context: vscode.ExtensionContext,
  deps: GanttCommandDeps
): void {
  context.subscriptions.push(
    // Gantt timeline command
    vscode.commands.registerCommand("redmyne.showGantt", async () => {
      // Ensure issues are fetched
      const issues = await deps.fetchIssuesIfNeeded();

      if (issues.length === 0) {
        vscode.window.showInformationMessage(
          "No issues to display. Configure Redmine and assign issues to yourself."
        );
        return;
      }

      // Get working hours schedule for intensity calculation
      const scheduleConfig = vscode.workspace.getConfiguration("redmyne.workingHours");
      const schedule = scheduleConfig.get<WeeklySchedule>("weeklySchedule", DEFAULT_WEEKLY_SCHEDULE);

      const panel = GanttPanel.createOrShow(context.extensionUri, deps.getServer);
      panel.updateIssues(issues, deps.getFlexibilityCache(), deps.getProjects(), schedule, deps.getFilter(), deps.getDependencyIssues(), deps.getServer);
      panel.setFilterChangeCallback((filter) => deps.setFilter(filter));
    }),

    // Refresh Gantt data without resetting view state
    vscode.commands.registerCommand("redmyne.refreshGanttData", async () => {
      const panel = GanttPanel.currentPanel;
      if (!panel) return;

      // Use already-fetched data (don't clear cache to avoid refresh loop)
      const issues = await deps.fetchIssuesIfNeeded();

      if (issues.length === 0) return;

      const scheduleConfig = vscode.workspace.getConfiguration("redmyne.workingHours");
      const schedule = scheduleConfig.get<WeeklySchedule>("weeklySchedule", DEFAULT_WEEKLY_SCHEDULE);

      panel.updateIssues(issues, deps.getFlexibilityCache(), deps.getProjects(), schedule, deps.getFilter(), deps.getDependencyIssues(), deps.getServer);
    }),

    // Open specific issue in Gantt (context menu)
    vscode.commands.registerCommand("redmyne.openIssueInGantt", async (issue: { id: number; project?: { id: number } } | undefined) => {
      if (!issue?.id) {
        vscode.window.showErrorMessage("Could not determine issue ID");
        return;
      }

      // Ensure Gantt is open and has data
      const issues = await deps.fetchIssuesIfNeeded();
      if (issues.length === 0) {
        vscode.window.showInformationMessage(
          "No issues to display. Configure Redmine and assign issues to yourself."
        );
        return;
      }

      const scheduleConfig = vscode.workspace.getConfiguration("redmyne.workingHours");
      const schedule = scheduleConfig.get<WeeklySchedule>("weeklySchedule", DEFAULT_WEEKLY_SCHEDULE);

      const panel = GanttPanel.createOrShow(context.extensionUri, deps.getServer);
      panel.updateIssues(issues, deps.getFlexibilityCache(), deps.getProjects(), schedule, deps.getFilter(), deps.getDependencyIssues(), deps.getServer);
      panel.setFilterChangeCallback((filter) => deps.setFilter(filter));

      // Find the issue's project and switch to it so the issue is visible
      const targetIssue = issues.find(i => i.id === issue.id);
      const projectId = issue.project?.id ?? targetIssue?.project?.id;
      if (projectId) {
        panel.showProject(projectId);
      }

      // Wait for webview to render, then scroll to issue
      setTimeout(() => panel.scrollToIssue(issue.id), 150);
    })
  );
}
