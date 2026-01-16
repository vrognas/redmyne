/**
 * Time Entry Commands
 * Commands for managing time entries (edit, delete, open in browser)
 */

import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { formatHoursAsHHMM, parseTimeInput } from "../utilities/time-input";
import { showStatusBarMessage } from "../utilities/status-bar";
import { validateDateInput } from "../utilities/date-picker";
import { quickLogTime } from "./quick-log-time";
import { pickIssue } from "../utilities/issue-picker";

/** Time entry node from tree view */
interface TimeEntryNode {
  _entry?: {
    id?: number;
    hours: string;
    comments: string;
    activity?: { id: number; name: string };
    spent_on?: string;
    issue_id?: number;
    issue?: { id: number; subject: string };
  };
}

/** Day group node from tree view */
interface DayGroupNode {
  _date?: string; // YYYY-MM-DD
}

export interface TimeEntryCommandDeps {
  getServer: () => RedmineServer | undefined;
  refreshTree: () => void;
}

export function registerTimeEntryCommands(
  context: vscode.ExtensionContext,
  deps: TimeEntryCommandDeps
): void {
  // Open time entry's issue in browser
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.openTimeEntryInBrowser", async (...args: unknown[]) => {
      let issueId: number | undefined;

      // Handle command URI (tooltip link passes [issueId] as first arg)
      if (typeof args[0] === "number") {
        issueId = args[0];
      }
      // Handle context menu (tree node with _entry)
      else if (args[0] && typeof args[0] === "object" && "_entry" in args[0]) {
        const node = args[0] as TimeEntryNode;
        issueId = node._entry?.issue_id ?? node._entry?.issue?.id;
      }
      // Handle object with issue_id
      else if (args[0] && typeof args[0] === "object" && "issue_id" in args[0]) {
        const params = args[0] as { issue_id: number };
        issueId = params.issue_id;
      }
      // Handle string
      else if (typeof args[0] === "string") {
        const parsed = parseInt(args[0], 10);
        if (!isNaN(parsed)) {
          issueId = parsed;
        }
      }

      if (!issueId) {
        vscode.window.showErrorMessage("Could not determine issue ID");
        return;
      }

      // Get URL from config
      const config = vscode.workspace.getConfiguration("redmyne");
      const url = config.get<string>("url");
      if (!url) {
        vscode.window.showErrorMessage("Redmine URL not configured");
        return;
      }

      await vscode.env.openExternal(vscode.Uri.parse(`${url}/issues/${issueId}`));
    })
  );

  // Edit time entry
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.editTimeEntry", async (node: TimeEntryNode) => {
      const entry = node?._entry;
      if (!entry?.id) {
        vscode.window.showErrorMessage("No time entry selected");
        return;
      }

      const server = deps.getServer();
      if (!server) {
        vscode.window.showErrorMessage("No Redmine server configured");
        return;
      }

      // Show what to edit
      const hoursDisplay = formatHoursAsHHMM(parseFloat(entry.hours));
      const issueDisplay = entry.issue ? `#${entry.issue.id} ${entry.issue.subject || ""}`.trim() : `#${entry.issue_id || "?"}`;
      const options = [
        { label: `Issue: ${issueDisplay}`, field: "issue" as const },
        { label: `Hours: ${hoursDisplay}`, field: "hours" as const },
        { label: `Comment: ${entry.comments || "(none)"}`, field: "comments" as const },
        { label: `Activity: ${entry.activity?.name || "Unknown"}`, field: "activity" as const },
        { label: `Date: ${entry.spent_on || "Unknown"}`, field: "date" as const },
      ];

      const choice = await vscode.window.showQuickPick(options, {
        title: `Edit Time Entry #${entry.id}`,
        placeHolder: `#${entry.issue?.id} ${entry.issue?.subject || ""}`,
      });

      if (!choice) return;

      try {
        if (choice.field === "issue") {
          const newIssue = await pickIssue(server, "Move Time Entry to Issue");
          if (!newIssue) return;
          if (newIssue.id === (entry.issue?.id || entry.issue_id)) {
            vscode.window.showInformationMessage("Same issue selected, no change made");
            return;
          }
          await server.updateTimeEntry(entry.id, { issue_id: newIssue.id });
          showStatusBarMessage(`$(check) Moved to #${newIssue.id}`, 2000);
        } else if (choice.field === "hours") {
          const input = await vscode.window.showInputBox({
            title: "Edit Hours",
            value: formatHoursAsHHMM(parseFloat(entry.hours)),
            placeHolder: "e.g., 1:30, 1.5, 1h 30min",
            validateInput: (v) => {
              const parsed = parseTimeInput(v);
              if (parsed === null || parsed <= 0) return "Enter valid hours (e.g., 1:30, 1.5, 1h 30min)";
              return null;
            },
          });
          if (input === undefined) return;
          const hours = parseTimeInput(input)!;
          await server.updateTimeEntry(entry.id, { hours: hours.toString() });
        } else if (choice.field === "comments") {
          const input = await vscode.window.showInputBox({
            title: "Edit Comment",
            value: entry.comments,
            placeHolder: "Comment (optional)",
          });
          if (input === undefined) return;
          await server.updateTimeEntry(entry.id, { comments: input });
        } else if (choice.field === "activity") {
          // Need to fetch activities for this issue's project
          const issueResult = await server.getIssueById(entry.issue?.id || 0);
          const projectId = issueResult.issue.project?.id;
          if (!projectId) {
            vscode.window.showErrorMessage("Could not determine project");
            return;
          }
          const activities = await server.getProjectTimeEntryActivities(projectId);
          const activityChoice = await vscode.window.showQuickPick(
            activities.map((a: { name: string; id: number }) => ({ label: a.name, activityId: a.id })),
            { title: "Select Activity", placeHolder: "Activity" }
          );
          if (!activityChoice) return;
          await server.updateTimeEntry(entry.id, { activity_id: activityChoice.activityId });
        } else if (choice.field === "date") {
          const input = await vscode.window.showInputBox({
            title: "Edit Date",
            value: entry.spent_on || "",
            placeHolder: "YYYY-MM-DD",
            validateInput: (v) => validateDateInput(v, true),
          });
          if (input === undefined) return;
          await server.updateTimeEntry(entry.id, { spent_on: input });
        }

        showStatusBarMessage("$(check) Time entry updated", 2000);
        deps.refreshTree();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to update: ${error}`);
      }
    })
  );

  // Delete time entry
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.deleteTimeEntry", async (node: TimeEntryNode) => {
      const entry = node?._entry;
      if (!entry?.id) {
        vscode.window.showErrorMessage("No time entry selected");
        return;
      }

      const server = deps.getServer();
      if (!server) {
        vscode.window.showErrorMessage("No Redmine server configured");
        return;
      }

      const hoursDisplay = formatHoursAsHHMM(parseFloat(entry.hours));
      const issueInfo = entry.issue ? `#${entry.issue.id} ${entry.issue.subject || ""}`.trim() : "Unknown issue";
      const activityInfo = entry.activity?.name ? `[${entry.activity.name}]` : "";
      const confirm = await vscode.window.showWarningMessage(
        "Delete time entry?",
        { modal: true, detail: `${issueInfo}\n${hoursDisplay} ${activityInfo} on ${entry.spent_on || "?"}` },
        "Delete"
      );

      if (confirm !== "Delete") return;

      try {
        await server.deleteTimeEntry(entry.id);
        showStatusBarMessage("$(check) Time entry deleted", 2000);
        deps.refreshTree();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to delete: ${error}`);
      }
    })
  );

  // Add time entry for a specific date (context menu on day-group)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.addTimeEntryForDate", async (node: DayGroupNode) => {
      const server = deps.getServer();
      if (!server) {
        vscode.window.showErrorMessage("No Redmine server configured");
        return;
      }

      const config = vscode.workspace.getConfiguration("redmyne");
      const url = config.get<string>("url") || "";

      await quickLogTime(
        { server, config: { ...config, url, apiKey: "" } },
        context,
        node?._date
      );
      deps.refreshTree();
    })
  );
}
