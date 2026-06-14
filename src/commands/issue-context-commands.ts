import * as vscode from "vscode";
import { Issue } from "../redmine/models/issue";
import type { IRedmineServer } from "../redmine/redmine-server-interface";
import { autoUpdateTracker } from "../utilities/auto-update-tracker";
import { contributeToIssue, removeContribution, toggleAdHoc } from "./adhoc-commands";
import { showStatusBarMessage } from "../utilities/status-bar";
import { setInternalEstimate, clearInternalEstimate } from "../utilities/internal-estimates";
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
  getProjectsServer: () => IRedmineServer | undefined;
  refreshProjectsTree: () => void;
  getAssignedIssues: () => Issue[];
  getDependencyIssues: () => Issue[];
  getProjectNodeById: (projectId: number) => unknown;
  getProjectsTreeView: () => vscode.TreeView<unknown> | undefined;
  getTimeEntriesServer: () => IRedmineServer | undefined;
  refreshTimeEntries: () => void;
}

function refreshGanttData(): Thenable<unknown> {
  return vscode.commands.executeCommand("redmyne.refreshGanttData");
}

export function registerIssueContextCommands(
  deps: IssueContextCommandsDeps
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Keep the tree's cached issue in sync with a done-ratio write. refreshGanttData
  // re-reads these objects via fetchIssuesIfNeeded — the server write only
  // invalidates the per-issue getIssueById cache, not this list — so without
  // this the optimistic updateIssueDoneRatio is overwritten by the stale value
  // and the bar snaps back. (Same objects feed the gantt on its next open.)
  function syncCachedDoneRatio(issueId: number, doneRatio: number): void {
    for (const list of [deps.getAssignedIssues(), deps.getDependencyIssues()]) {
      const cached = list.find((i) => i.id === issueId);
      if (cached) cached.done_ratio = doneRatio;
    }
  }

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
          await autoUpdateTracker.disable(issueId);

          // 100% = nothing remains by definition: don't ask, and clear any
          // stale internal estimate — it outranks done_ratio in
          // remainingHours(), so a leftover "5h remaining" would keep the
          // ghost projection and red arrows alive on a finished task.
          if (selectedValue === 100) {
            await clearInternalEstimate(deps.globalState, issueId);
            showStatusBarMessage(`$(check) #${issueId} set to 100%`, 2000);
            syncCachedDoneRatio(issueId, 100);
            GanttPanel.currentPanel?.updateIssueDoneRatio(issueId, selectedValue);
            refreshGanttData();
            return;
          }

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

          syncCachedDoneRatio(issueId, selectedValue);
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

    // Clear manual % done: back to time-based progress. done_ratio 0 makes
    // the gantt fill fall back to spent/estimated, the internal estimate
    // stops overriding remaining-work, and the issue rejoins per-issue
    // auto-update (a no-op unless redmyne.autoUpdateDonePercent is on).
    vscode.commands.registerCommand(
      "redmyne.clearDoneRatio",
      async (issue: { id: number } | undefined) => {
        if (!ensureIssueId(issue)) return;
        const issueId = issue.id;

        const server = getServerOrShowError(deps.getProjectsServer);
        if (!server) return;

        try {
          await server.updateDoneRatio(issueId, 0);
          await clearInternalEstimate(deps.globalState, issueId);
          await autoUpdateTracker.enable(issueId);

          showStatusBarMessage(`$(check) #${issueId} % done cleared — tracking logged time`, 2000);
          syncCachedDoneRatio(issueId, 0);
          GanttPanel.currentPanel?.updateIssueDoneRatio(issueId, 0);
          refreshGanttData();
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update: ${error}`);
        }
      }
    ),

    // Toggle the ad-hoc budget tag (purple dotted border in the Gantt;
    // time on the issue can contribute hours to other issues). Ad-hoc state
    // is read only by the Gantt — the projects tree never renders it — so a
    // single Gantt refresh suffices, matching the done-ratio/estimate
    // siblings. (refreshProjectsTree would double-render: refresh() fires
    // onDidChangeTreeData, which already triggers refreshGanttData.)
    vscode.commands.registerCommand("redmyne.toggleAdHoc", async (item: { id: number } | undefined) => {
      await toggleAdHoc(item as Parameters<typeof toggleAdHoc>[0]);
      refreshGanttData();
    }),

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
        placeHolder: `Set % Done for ${issueIds.length} ${issueIds.length === 1 ? "issue" : "issues"}`,
      });

      if (selected === undefined) return;

      try {
        await Promise.all(issueIds.map((id) => server.updateDoneRatio(id, selected.value)));
        await Promise.all(issueIds.map((id) => autoUpdateTracker.disable(id)));

        // Same 100% rule as the single-issue path: nothing remains, so no
        // prompt, and stale internal estimates must not outlive done.
        if (selected.value === 100) {
          for (const id of issueIds) {
            await clearInternalEstimate(deps.globalState, id);
          }
          showStatusBarMessage(`$(check) ${issueIds.length} ${issueIds.length === 1 ? "issue" : "issues"} set to 100%`, 2000);
          issueIds.forEach((id) => syncCachedDoneRatio(id, 100));
          issueIds.forEach((id) => GanttPanel.currentPanel?.updateIssueDoneRatio(id, 100));
          refreshGanttData();
          return;
        }

        const hoursInput = await vscode.window.showInputBox({
          title: `Internal Estimate for ${issueIds.length} ${issueIds.length === 1 ? "issue" : "issues"}`,
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
            // Sequential: setInternalEstimate is read-modify-write on a shared
            // globalState key; parallel writes drop all but the last estimate.
            for (const id of issueIds) {
              await setInternalEstimate(deps.globalState, id, hours);
            }
            showStatusBarMessage(
              `$(check) ${issueIds.length} ${issueIds.length === 1 ? "issue" : "issues"} set to ${selected.value}% with ${hours}h remaining each`,
              2000
            );
          }
        } else {
          showStatusBarMessage(`$(check) ${issueIds.length} ${issueIds.length === 1 ? "issue" : "issues"} set to ${selected.value}%`, 2000);
        }

        issueIds.forEach((id) => syncCachedDoneRatio(id, selected.value));
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

          if (issue.statusPattern === "new") {
            targetStatus = statuses.find((s) => s.name.toLowerCase() === "new")
              ?? statuses.find((s) => !s.is_closed);
          } else if (issue.statusPattern === "in_progress") {
            targetStatus = statuses.find((s) => s.name.toLowerCase() === "in progress")
              ?? statuses.find((s) => !s.is_closed && s.name.toLowerCase().includes("progress"));
          } else if (issue.statusPattern === "closed") {
            targetStatus = statuses.find((s) => s.name.toLowerCase() === "closed")
              ?? statuses.find((s) => s.is_closed);
          }

          if (!targetStatus) {
            // No pattern, or the pattern matched none of this server's
            // status names (e.g. localized Redmine) — never write a
            // guessed status id; let the user pick.
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

  );

  return disposables;
}
