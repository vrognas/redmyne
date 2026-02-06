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
import { buildProjectUrl } from "./command-urls";
import {
  ensureIssueId,
  getConfiguredServerUrlOrShowError,
  getNestedProjectIdOrShowError,
  getNestedProjectIdentifierOrShowError,
  getServerOrShowError,
} from "./command-guards";

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

function refreshGanttData(): Thenable<unknown> {
  return vscode.commands.executeCommand("redmyne.refreshGanttData");
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
        if (!ensureIssueId(issue)) return;
        const issueId = issue.id;

        const server = getServerOrShowError(deps.getProjectsServer);
        if (!server) return;

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
            placeHolder: `Set % Done for #${issueId}`,
          });

          if (selected === undefined) return;
          selectedValue = selected.value;
        }

        try {
          await server.updateDoneRatio(issueId, selectedValue);
          autoUpdateTracker.disable(issueId);

          const hoursInput = await vscode.window.showInputBox({
            title: `Internal Estimate: #${issueId}`,
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
              await setInternalEstimate(deps.globalState, issueId, hours);
              showStatusBarMessage(
                `$(check) #${issueId} set to ${selectedValue}% with ${hours}h remaining`,
                2000
              );
            }
          } else {
            showStatusBarMessage(`$(check) #${issueId} set to ${selectedValue}%`, 2000);
          }

          GanttPanel.currentPanel?.updateIssueDoneRatio(issueId, selectedValue);
          refreshGanttData();
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update: ${error}`);
        }
      }
    ),

    // Set status for issue
    vscode.commands.registerCommand(
      "redmyne.setStatus",
      async (issue: { id: number; status?: { id: number; name: string } } | undefined) => {
        if (!ensureIssueId(issue)) return;
        const issueId = issue.id;

        const server = getServerOrShowError(deps.getProjectsServer);
        if (!server) return;

        try {
          const statuses = await server.getIssueStatusesTyped();
          const options = statuses.map((s) => ({
            label: s.name,
            value: s.statusId,
            picked: issue.status?.id === s.statusId,
          }));

          const selected = await vscode.window.showQuickPick(options, {
            placeHolder: `Set status for #${issueId}`,
          });

          if (selected === undefined) return;

          await server.setIssueStatus({ id: issueId }, selected.value);
          showStatusBarMessage(`$(check) #${issueId} set to ${selected.label}`, 2000);

          deps.refreshProjectsTree();
          refreshGanttData();
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
      const server = getServerOrShowError(deps.getProjectsServer);
      if (!server) return;

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
        refreshGanttData();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to update: ${error}`);
      }
    }),

    // Set issue status (pattern-based or picker)
    vscode.commands.registerCommand(
      "redmyne.setIssueStatus",
      async (issue: { id: number; statusPattern?: "new" | "in_progress" | "closed" } | undefined) => {
        if (!ensureIssueId(issue)) return;
        const issueId = issue.id;

        const server = getServerOrShowError(deps.getProjectsServer);
        if (!server) return;

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
              placeHolder: `Set status for #${issueId}`,
            });

            if (!selected) return;
            targetStatus = selected.status;
          }

          await server.setIssueStatus({ id: issueId }, targetStatus.id);
          showStatusBarMessage(`$(check) #${issueId} set to ${targetStatus.name}`, 2000);
          refreshGanttData();
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update status: ${error}`);
        }
      }
    ),

    // Open project in browser
    vscode.commands.registerCommand("redmyne.openProjectInBrowser", async (node: { project?: { identifier?: string } } | undefined) => {
      const identifier = getNestedProjectIdentifierOrShowError(node);
      if (!identifier) return;
      const url = getConfiguredServerUrlOrShowError();
      if (!url) return;
      await vscode.env.openExternal(vscode.Uri.parse(buildProjectUrl(url, identifier)));
    }),

    // Show project in Gantt
    vscode.commands.registerCommand("redmyne.showProjectInGantt", async (node: { project?: { id?: number }; id?: number } | undefined) => {
      const projectId = getNestedProjectIdOrShowError(node);
      if (!projectId) return;
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
      if (!ensureIssueId(issue)) return;
      const issueId = issue.id;

      const nowEnabled = autoUpdateTracker.toggle(issueId);
      showStatusBarMessage(
        nowEnabled
          ? `$(check) Auto-update %done enabled for #${issueId}`
          : `$(x) Auto-update %done disabled for #${issueId}`,
        2000
      );
    }),

    // Toggle ad-hoc budget tag for issue
    vscode.commands.registerCommand("redmyne.toggleAdHoc", toggleAdHoc),

    // Contribute time entry hours to another issue
    vscode.commands.registerCommand("redmyne.contributeToIssue", (item) =>
      contributeToIssue(item, deps.getTimeEntriesServer(), () => {
        deps.refreshTimeEntries();
        refreshGanttData();
      })
    ),

    // Remove contribution from time entry
    vscode.commands.registerCommand("redmyne.removeContribution", (item) =>
      removeContribution(item, deps.getTimeEntriesServer(), () => {
        deps.refreshTimeEntries();
        refreshGanttData();
      })
    ),

    // Toggle precedence priority
    vscode.commands.registerCommand("redmyne.togglePrecedence", async (issue: { id: number } | undefined) => {
      if (!ensureIssueId(issue)) return;
      const issueId = issue.id;

      const isNow = await togglePrecedence(deps.globalState, issueId);
      showStatusBarMessage(
        isNow ? `$(check) #${issueId} tagged with precedence` : `$(check) #${issueId} precedence removed`,
        2000
      );
      refreshGanttData();
    }),

    // Set issue priority (pattern-based or picker)
    vscode.commands.registerCommand(
      "redmyne.setIssuePriority",
      async (issue: { id: number; priorityPattern?: string } | undefined) => {
        if (!ensureIssueId(issue)) return;
        const issueId = issue.id;

        const server = getServerOrShowError(deps.getProjectsServer);
        if (!server) return;

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
              placeHolder: `Set priority for #${issueId}`,
            });
            if (!selected) return;
            targetPriority = selected.priority;
          }

          await server.setIssuePriority(issueId, targetPriority.id);
          showStatusBarMessage(`$(check) #${issueId} priority set to ${targetPriority.name}`, 2000);
          refreshGanttData();
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update priority: ${error}`);
        }
      }
    ),

    // Set auto-update %done (explicit on/off)
    vscode.commands.registerCommand(
      "redmyne.setAutoUpdateDoneRatio",
      async (issue: { id: number; value: boolean } | undefined) => {
        if (!ensureIssueId(issue)) return;
        const issueId = issue.id;

        if (issue.value) {
          autoUpdateTracker.enable(issueId);
          showStatusBarMessage(`$(check) Auto-update %done enabled for #${issueId}`, 2000);
        } else {
          autoUpdateTracker.disable(issueId);
          showStatusBarMessage(`$(x) Auto-update %done disabled for #${issueId}`, 2000);
        }
      }
    ),

    // Set ad-hoc budget (explicit on/off)
    vscode.commands.registerCommand(
      "redmyne.setAdHoc",
      async (issue: { id: number; value: boolean } | undefined) => {
        if (!ensureIssueId(issue)) return;
        const issueId = issue.id;

        if (issue.value) {
          adHocTracker.tag(issueId);
          showStatusBarMessage(`$(check) #${issueId} tagged as ad-hoc budget`, 2000);
        } else {
          adHocTracker.untag(issueId);
          showStatusBarMessage(`$(check) #${issueId} ad-hoc budget removed`, 2000);
        }
        refreshGanttData();
      }
    ),

    // Set precedence (explicit on/off)
    vscode.commands.registerCommand(
      "redmyne.setPrecedence",
      async (issue: { id: number; value: boolean } | undefined) => {
        if (!ensureIssueId(issue)) return;
        const issueId = issue.id;

        if (issue.value) {
          await setPrecedence(deps.globalState, issueId);
          showStatusBarMessage(`$(check) #${issueId} tagged with precedence`, 2000);
        } else {
          await clearPrecedence(deps.globalState, issueId);
          showStatusBarMessage(`$(check) #${issueId} precedence removed`, 2000);
        }
        refreshGanttData();
      }
    )
  );

  return disposables;
}
