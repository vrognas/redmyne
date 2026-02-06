import * as vscode from "vscode";
import { Issue } from "../redmine/models/issue";
import { RedmineServer } from "../redmine/redmine-server";
import { autoUpdateTracker } from "../utilities/auto-update-tracker";
import { adHocTracker } from "../utilities/adhoc-tracker";
import { toggleAdHoc, contributeToIssue, removeContribution } from "./adhoc-commands";
import { togglePrecedence, setPrecedence, clearPrecedence } from "../utilities/precedence-tracker";
import { showStatusBarMessage } from "../utilities/status-bar";
import { setInternalEstimate } from "../utilities/internal-estimates";
import { parseTimeInput } from "../utilities/time-input";
import { GanttPanel } from "../webviews/gantt-panel";

const DONE_RATIO_OPTIONS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

export interface IssueContextCommandsDeps {
  globalState: vscode.Memento;
  getProjectsServer: () => RedmineServer | undefined;
  refreshProjectsTree: () => void;
  getAssignedIssues: () => Issue[];
  getDependencyIssues: () => Issue[];
  getProjectNodeById: (projectId: number) => unknown;
  getProjectsTreeView: () => vscode.TreeView<unknown> | undefined;
  getTimeEntriesServer: () => RedmineServer | undefined;
  refreshTimeEntries: () => void;
}

export function registerIssueContextCommands(
  deps: IssueContextCommandsDeps
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    // Set done ratio (% Done) for issue
    vscode.commands.registerCommand(
      "redmyne.setDoneRatio",
      async (issue: { id: number; done_ratio?: number; percentage?: number } | undefined) => {
        if (!issue?.id) {
          vscode.window.showErrorMessage("Could not determine issue ID");
          return;
        }
        const server = deps.getProjectsServer();
        if (!server) {
          vscode.window.showErrorMessage("No Redmine server configured");
          return;
        }

        let selectedValue: number;

        if (issue.percentage !== undefined) {
          selectedValue = issue.percentage;
        } else {
          const options = DONE_RATIO_OPTIONS.map((pct) => ({
            label: `${pct}%`,
            value: pct,
            picked: issue.done_ratio === pct,
          }));

          const selected = await vscode.window.showQuickPick(options, {
            placeHolder: `Set % Done for #${issue.id}`,
          });

          if (selected === undefined) return;
          selectedValue = selected.value;
        }

        try {
          await server.updateDoneRatio(issue.id, selectedValue);
          autoUpdateTracker.disable(issue.id);

          const hoursInput = await vscode.window.showInputBox({
            title: `Internal Estimate: #${issue.id}`,
            prompt: "Hours remaining until 100% done (e.g., 5, 2.5, 1:30, 2h 30min)",
            placeHolder: "Leave blank to skip",
            validateInput: (value) => {
              if (!value.trim()) return null;
              const parsed = parseTimeInput(value);
              if (parsed === null) return "Invalid format. Use: 5, 2.5, 1:30, or 2h 30min";
              if (parsed < 0) return "Hours cannot be negative";
              return null;
            },
          });

          if (hoursInput && hoursInput.trim()) {
            const hours = parseTimeInput(hoursInput);
            if (hours !== null) {
              await setInternalEstimate(deps.globalState, issue.id, hours);
              showStatusBarMessage(
                `$(check) #${issue.id} set to ${selectedValue}% with ${hours}h remaining`,
                2000
              );
            }
          } else {
            showStatusBarMessage(`$(check) #${issue.id} set to ${selectedValue}%`, 2000);
          }

          GanttPanel.currentPanel?.updateIssueDoneRatio(issue.id, selectedValue);
          vscode.commands.executeCommand("redmyne.refreshGanttData");
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update: ${error}`);
        }
      }
    ),

    // Set status for issue
    vscode.commands.registerCommand(
      "redmyne.setStatus",
      async (issue: { id: number; status?: { id: number; name: string } } | undefined) => {
        if (!issue?.id) {
          vscode.window.showErrorMessage("Could not determine issue ID");
          return;
        }
        const server = deps.getProjectsServer();
        if (!server) {
          vscode.window.showErrorMessage("No Redmine server configured");
          return;
        }

        try {
          const statuses = await server.getIssueStatusesTyped();
          const options = statuses.map((s) => ({
            label: s.name,
            value: s.statusId,
            picked: issue.status?.id === s.statusId,
          }));

          const selected = await vscode.window.showQuickPick(options, {
            placeHolder: `Set status for #${issue.id}`,
          });

          if (selected === undefined) return;

          await server.setIssueStatus({ id: issue.id }, selected.value);
          showStatusBarMessage(`$(check) #${issue.id} set to ${selected.label}`, 2000);

          deps.refreshProjectsTree();
          vscode.commands.executeCommand("redmyne.refreshGanttData");
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update: ${error}`);
        }
      }
    ),

    // Bulk set done ratio for multiple issues
    vscode.commands.registerCommand("redmyne.bulkSetDoneRatio", async (issueIds: number[]) => {
      if (!issueIds || issueIds.length === 0) {
        vscode.window.showErrorMessage("No issues selected");
        return;
      }
      const server = deps.getProjectsServer();
      if (!server) {
        vscode.window.showErrorMessage("No Redmine server configured");
        return;
      }

      const options = DONE_RATIO_OPTIONS.map((pct) => ({
        label: `${pct}%`,
        value: pct,
      }));

      const selected = await vscode.window.showQuickPick(options, {
        placeHolder: `Set % Done for ${issueIds.length} issues`,
      });

      if (selected === undefined) return;

      try {
        await Promise.all(issueIds.map((id) => server.updateDoneRatio(id, selected.value)));
        issueIds.forEach((id) => autoUpdateTracker.disable(id));

        const hoursInput = await vscode.window.showInputBox({
          title: `Internal Estimate for ${issueIds.length} issues`,
          prompt: "Hours remaining per issue until 100% done (e.g., 5, 2.5, 1:30)",
          placeHolder: "Leave blank to skip",
          validateInput: (value) => {
            if (!value.trim()) return null;
            const parsed = parseTimeInput(value);
            if (parsed === null) return "Invalid format. Use: 5, 2.5, 1:30, or 2h 30min";
            if (parsed < 0) return "Hours cannot be negative";
            return null;
          },
        });

        if (hoursInput && hoursInput.trim()) {
          const hours = parseTimeInput(hoursInput);
          if (hours !== null) {
            await Promise.all(issueIds.map((id) => setInternalEstimate(deps.globalState, id, hours)));
            showStatusBarMessage(
              `$(check) ${issueIds.length} issues set to ${selected.value}% with ${hours}h remaining each`,
              2000
            );
          }
        } else {
          showStatusBarMessage(`$(check) ${issueIds.length} issues set to ${selected.value}%`, 2000);
        }

        issueIds.forEach((id) => GanttPanel.currentPanel?.updateIssueDoneRatio(id, selected.value));
        vscode.commands.executeCommand("redmyne.refreshGanttData");
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to update: ${error}`);
      }
    }),

    // Set issue status (pattern-based or picker)
    vscode.commands.registerCommand(
      "redmyne.setIssueStatus",
      async (issue: { id: number; statusPattern?: "new" | "in_progress" | "closed" } | undefined) => {
        if (!issue?.id) {
          vscode.window.showErrorMessage("Could not determine issue ID");
          return;
        }
        const server = deps.getProjectsServer();
        if (!server) {
          vscode.window.showErrorMessage("No Redmine server configured");
          return;
        }

        try {
          const statuses = (await server.getIssueStatuses()).issue_statuses;
          let targetStatus: { id: number; name: string; is_closed: boolean } | undefined;

          if (issue.statusPattern) {
            if (issue.statusPattern === "new") {
              targetStatus = statuses.find((s) => s.name.toLowerCase() === "new")
                ?? statuses.find((s) => !s.is_closed);
            } else if (issue.statusPattern === "in_progress") {
              targetStatus = statuses.find((s) => s.name.toLowerCase() === "in progress")
                ?? statuses.find((s) => !s.is_closed && s.name.toLowerCase().includes("progress"))
                ?? statuses.filter((s) => !s.is_closed)[1];
            } else if (issue.statusPattern === "closed") {
              targetStatus = statuses.find((s) => s.name.toLowerCase() === "closed")
                ?? statuses.find((s) => s.is_closed);
            }

            if (!targetStatus) {
              vscode.window.showErrorMessage(`No matching status found for pattern: ${issue.statusPattern}`);
              return;
            }
          } else {
            const options = statuses.map((s) => ({
              label: s.name,
              description: s.is_closed ? "(closed)" : "",
              status: s,
            }));

            const selected = await vscode.window.showQuickPick(options, {
              placeHolder: `Set status for #${issue.id}`,
            });

            if (!selected) return;
            targetStatus = selected.status;
          }

          await server.setIssueStatus({ id: issue.id }, targetStatus.id);
          showStatusBarMessage(`$(check) #${issue.id} set to ${targetStatus.name}`, 2000);
          vscode.commands.executeCommand("redmyne.refreshGanttData");
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update status: ${error}`);
        }
      }
    ),

    // Open project in browser
    vscode.commands.registerCommand("redmyne.openProjectInBrowser", async (node: { project?: { identifier?: string } } | undefined) => {
      const identifier = node?.project?.identifier;
      if (!identifier) {
        vscode.window.showErrorMessage("Could not determine project identifier");
        return;
      }
      const url = vscode.workspace.getConfiguration("redmyne").get<string>("serverUrl");
      if (!url) {
        vscode.window.showErrorMessage("No Redmine URL configured");
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(`${url}/projects/${identifier}`));
    }),

    // Show project in Gantt
    vscode.commands.registerCommand("redmyne.showProjectInGantt", async (node: { project?: { id?: number }; id?: number } | undefined) => {
      const projectId = node?.project?.id ?? node?.id;
      if (!projectId) {
        vscode.window.showErrorMessage("Could not determine project ID");
        return;
      }
      await vscode.commands.executeCommand("redmyne.showGantt");
      GanttPanel.currentPanel?.showProject(projectId);
    }),

    // Reveal issue in tree
    vscode.commands.registerCommand("redmyne.revealIssueInTree", async (issueId: number) => {
      if (!issueId) return;
      const assignedIssues = deps.getAssignedIssues();
      const dependencyIssues = deps.getDependencyIssues();
      const issue = assignedIssues.find((i: Issue) => i.id === issueId)
        ?? dependencyIssues.find((i: Issue) => i.id === issueId);
      const projectsTreeView = deps.getProjectsTreeView();
      if (issue && projectsTreeView) {
        await vscode.commands.executeCommand("redmyne-explorer-projects.focus");
        await projectsTreeView.reveal(issue, { select: true, focus: true, expand: true });
      }
    }),

    // Reveal project in tree
    vscode.commands.registerCommand("redmyne.revealProjectInTree", async (projectId: number) => {
      if (!projectId || projectId < 0) return;
      const projectNode = deps.getProjectNodeById(projectId);
      const projectsTreeView = deps.getProjectsTreeView();
      if (projectNode && projectsTreeView) {
        await vscode.commands.executeCommand("redmyne-explorer-projects.focus");
        await projectsTreeView.reveal(projectNode, { select: true, focus: true, expand: true });
      }
    }),

    // Toggle auto-update %done
    vscode.commands.registerCommand("redmyne.toggleAutoUpdateDoneRatio", async (issue: { id: number } | undefined) => {
      if (!issue?.id) {
        vscode.window.showErrorMessage("Could not determine issue ID");
        return;
      }
      const nowEnabled = autoUpdateTracker.toggle(issue.id);
      showStatusBarMessage(
        nowEnabled
          ? `$(check) Auto-update %done enabled for #${issue.id}`
          : `$(x) Auto-update %done disabled for #${issue.id}`,
        2000
      );
    }),

    // Toggle ad-hoc budget tag for issue
    vscode.commands.registerCommand("redmyne.toggleAdHoc", toggleAdHoc),

    // Contribute time entry hours to another issue
    vscode.commands.registerCommand("redmyne.contributeToIssue", (item) =>
      contributeToIssue(item, deps.getTimeEntriesServer(), () => {
        deps.refreshTimeEntries();
        vscode.commands.executeCommand("redmyne.refreshGanttData");
      })
    ),

    // Remove contribution from time entry
    vscode.commands.registerCommand("redmyne.removeContribution", (item) =>
      removeContribution(item, deps.getTimeEntriesServer(), () => {
        deps.refreshTimeEntries();
        vscode.commands.executeCommand("redmyne.refreshGanttData");
      })
    ),

    // Toggle precedence priority
    vscode.commands.registerCommand("redmyne.togglePrecedence", async (issue: { id: number } | undefined) => {
      if (!issue?.id) {
        vscode.window.showErrorMessage("Could not determine issue ID");
        return;
      }
      const isNow = await togglePrecedence(deps.globalState, issue.id);
      showStatusBarMessage(
        isNow ? `$(check) #${issue.id} tagged with precedence` : `$(check) #${issue.id} precedence removed`,
        2000
      );
      vscode.commands.executeCommand("redmyne.refreshGanttData");
    }),

    // Set issue priority (pattern-based or picker)
    vscode.commands.registerCommand(
      "redmyne.setIssuePriority",
      async (issue: { id: number; priorityPattern?: string } | undefined) => {
        if (!issue?.id) {
          vscode.window.showErrorMessage("Could not determine issue ID");
          return;
        }
        const server = deps.getProjectsServer();
        if (!server) {
          vscode.window.showErrorMessage("No Redmine server configured");
          return;
        }

        try {
          const { issue_priorities: priorities } = await server.getIssuePriorities();
          let targetPriority: { id: number; name: string } | undefined;

          if (issue.priorityPattern) {
            const pattern = issue.priorityPattern.toLowerCase();
            targetPriority = priorities.find((p) => p.name.toLowerCase() === pattern)
              ?? priorities.find((p) => p.name.toLowerCase().includes(pattern));

            if (!targetPriority) {
              vscode.window.showErrorMessage(`No matching priority found for: ${issue.priorityPattern}`);
              return;
            }
          } else {
            const options = priorities.map((p) => ({ label: p.name, priority: p }));
            const selected = await vscode.window.showQuickPick(options, {
              placeHolder: `Set priority for #${issue.id}`,
            });
            if (!selected) return;
            targetPriority = selected.priority;
          }

          await server.setIssuePriority(issue.id, targetPriority.id);
          showStatusBarMessage(`$(check) #${issue.id} priority set to ${targetPriority.name}`, 2000);
          vscode.commands.executeCommand("redmyne.refreshGanttData");
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update priority: ${error}`);
        }
      }
    ),

    // Set auto-update %done (explicit on/off)
    vscode.commands.registerCommand(
      "redmyne.setAutoUpdateDoneRatio",
      async (issue: { id: number; value: boolean } | undefined) => {
        if (!issue?.id) {
          vscode.window.showErrorMessage("Could not determine issue ID");
          return;
        }
        if (issue.value) {
          autoUpdateTracker.enable(issue.id);
          showStatusBarMessage(`$(check) Auto-update %done enabled for #${issue.id}`, 2000);
        } else {
          autoUpdateTracker.disable(issue.id);
          showStatusBarMessage(`$(x) Auto-update %done disabled for #${issue.id}`, 2000);
        }
      }
    ),

    // Set ad-hoc budget (explicit on/off)
    vscode.commands.registerCommand(
      "redmyne.setAdHoc",
      async (issue: { id: number; value: boolean } | undefined) => {
        if (!issue?.id) {
          vscode.window.showErrorMessage("Could not determine issue ID");
          return;
        }
        if (issue.value) {
          adHocTracker.tag(issue.id);
          showStatusBarMessage(`$(check) #${issue.id} tagged as ad-hoc budget`, 2000);
        } else {
          adHocTracker.untag(issue.id);
          showStatusBarMessage(`$(check) #${issue.id} ad-hoc budget removed`, 2000);
        }
        vscode.commands.executeCommand("redmyne.refreshGanttData");
      }
    ),

    // Set precedence (explicit on/off)
    vscode.commands.registerCommand(
      "redmyne.setPrecedence",
      async (issue: { id: number; value: boolean } | undefined) => {
        if (!issue?.id) {
          vscode.window.showErrorMessage("Could not determine issue ID");
          return;
        }
        if (issue.value) {
          await setPrecedence(deps.globalState, issue.id);
          showStatusBarMessage(`$(check) #${issue.id} tagged with precedence`, 2000);
        } else {
          await clearPrecedence(deps.globalState, issue.id);
          showStatusBarMessage(`$(check) #${issue.id} precedence removed`, 2000);
        }
        vscode.commands.executeCommand("redmyne.refreshGanttData");
      }
    )
  );

  return disposables;
}
