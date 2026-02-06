import * as vscode from "vscode";
import { showStatusBarMessage } from "../utilities/status-bar";

const DONE_RATIO_PRESETS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

/**
 * Register webview context-menu and submenu proxy commands.
 *
 * These commands receive lightweight context payloads from webviews/menus and
 * forward actions to existing canonical commands.
 */
export function registerContextProxyCommands(): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Gantt webview context menu commands
  disposables.push(
    vscode.commands.registerCommand("redmyne.gantt.updateIssue", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.openActionsForIssue", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.openInBrowser", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.openIssueInBrowser", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.showInIssues", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.revealIssueInTree", ctx.issueId);
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.logTime", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.quickLogTime", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setDoneRatio", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setDoneRatio", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setStatus", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setStatus", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setIssuePriority", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: ctx.issueId });
      }
    }),
    ...DONE_RATIO_PRESETS.map((pct) =>
      vscode.commands.registerCommand(`redmyne.gantt.setDoneRatio${pct}`, (ctx: { issueId: number }) => {
        if (ctx?.issueId) {
          vscode.commands.executeCommand("redmyne.setDoneRatio", { id: ctx.issueId, percentage: pct });
        }
      })
    ),
    vscode.commands.registerCommand("redmyne.gantt.setDoneRatioCustom", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setDoneRatio", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setStatusNew", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssueStatus", { id: ctx.issueId, statusPattern: "new" });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setStatusInProgress", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssueStatus", { id: ctx.issueId, statusPattern: "in_progress" });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setStatusClosed", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssueStatus", { id: ctx.issueId, statusPattern: "closed" });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setStatusOther", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssueStatus", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.toggleAutoUpdate", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.toggleAutoUpdateDoneRatio", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.toggleAdHoc", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.toggleAdHoc", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.togglePrecedence", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.togglePrecedence", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.copyUrl", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.copyIssueUrl", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.copyIssueId", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.env.clipboard.writeText(`#${ctx.issueId}`);
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.copyProjectId", (ctx: { projectId: number }) => {
      if (ctx?.projectId) {
        vscode.env.clipboard.writeText(`#${ctx.projectId}`);
      }
    }),
    vscode.commands.registerCommand(
      "redmyne.gantt.copyProjectUrl",
      (ctx: { projectId: number; projectIdentifier: string }) => {
        if (ctx?.projectIdentifier) {
          const url = vscode.workspace.getConfiguration("redmyne").get<string>("serverUrl");
          if (url) {
            const projectUrl = `${url}/projects/${ctx.projectIdentifier}`;
            vscode.env.clipboard.writeText(projectUrl);
            showStatusBarMessage("$(check) Copied project URL", 2000);
          }
        }
      }
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.createSubIssue",
      (ctx: { issueId: number; projectId: number }) => {
        if (ctx?.issueId && ctx?.projectId) {
          vscode.commands.executeCommand("redmyne.quickCreateSubIssue", {
            id: ctx.issueId,
            project: { id: ctx.projectId },
          });
        }
      }
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.openProjectInBrowser",
      (ctx: { projectId: number; projectIdentifier: string }) => {
        if (ctx?.projectIdentifier) {
          vscode.commands.executeCommand("redmyne.openProjectInBrowser", {
            project: { identifier: ctx.projectIdentifier },
          });
        }
      }
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.showProjectInGantt",
      (ctx: { projectId: number; projectIdentifier: string }) => {
        if (ctx?.projectId) {
          vscode.commands.executeCommand("redmyne.showProjectInGantt", {
            project: { id: ctx.projectId },
          });
        }
      }
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.showProjectInIssues",
      (ctx: { projectId: number }) => {
        if (ctx?.projectId) {
          vscode.commands.executeCommand("redmyne.revealProjectInTree", ctx.projectId);
        }
      }
    ),

    // Timesheet webview context menu commands
    vscode.commands.registerCommand("redmyne.timesheet.openIssueInBrowser", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.openIssueInBrowser", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.timesheet.showIssueInSidebar", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.revealIssueInTree", ctx.issueId);
      }
    }),
    vscode.commands.registerCommand(
      "redmyne.timesheet.openProjectInBrowser",
      (ctx: { projectId: number; projectIdentifier: string }) => {
        if (ctx?.projectIdentifier) {
          vscode.commands.executeCommand("redmyne.openProjectInBrowser", {
            project: { identifier: ctx.projectIdentifier },
          });
        }
      }
    ),
    vscode.commands.registerCommand(
      "redmyne.timesheet.showProjectInSidebar",
      (ctx: { projectId: number }) => {
        if (ctx?.projectId) {
          vscode.commands.executeCommand("redmyne.revealProjectInTree", ctx.projectId);
        }
      }
    ),

    // Gantt submenu commands
    vscode.commands.registerCommand("redmyne.gantt.setPriorityLow", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: ctx.issueId, priorityPattern: "low" });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setPriorityNormal", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: ctx.issueId, priorityPattern: "normal" });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setPriorityHigh", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: ctx.issueId, priorityPattern: "high" });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setPriorityUrgent", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: ctx.issueId, priorityPattern: "urgent" });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setPriorityImmediate", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: ctx.issueId, priorityPattern: "immediate" });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setPriorityOther", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.autoUpdateOn", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setAutoUpdateDoneRatio", { id: ctx.issueId, value: true });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.autoUpdateOff", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setAutoUpdateDoneRatio", { id: ctx.issueId, value: false });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.adHocOn", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setAdHoc", { id: ctx.issueId, value: true });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.adHocOff", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setAdHoc", { id: ctx.issueId, value: false });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.precedenceOn", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setPrecedence", { id: ctx.issueId, value: true });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.precedenceOff", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setPrecedence", { id: ctx.issueId, value: false });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setInternalEstimate", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setInternalEstimate", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.clearInternalEstimate", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.clearInternalEstimate", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.addToKanban", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.addIssueToKanban", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.createIssue", (ctx: { projectId: number }) => {
      if (ctx?.projectId) {
        vscode.commands.executeCommand("redmyne.quickCreateIssue", { project: { id: ctx.projectId } });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.createVersion", (ctx: { projectId: number }) => {
      if (ctx?.projectId) {
        vscode.commands.executeCommand("redmyne.quickCreateVersion", { project: { id: ctx.projectId } });
      }
    }),

    // Sidebar submenu commands
    ...DONE_RATIO_PRESETS.map((pct) =>
      vscode.commands.registerCommand(`redmyne.setDoneRatio${pct}`, (issue: { id: number }) => {
        if (issue?.id) {
          vscode.commands.executeCommand("redmyne.setDoneRatio", { id: issue.id, percentage: pct });
        }
      })
    ),
    vscode.commands.registerCommand("redmyne.setDoneRatioCustom", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setDoneRatio", { id: issue.id });
      }
    }),
    vscode.commands.registerCommand("redmyne.setStatusNew", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssueStatus", { id: issue.id, statusPattern: "new" });
      }
    }),
    vscode.commands.registerCommand("redmyne.setStatusInProgress", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssueStatus", { id: issue.id, statusPattern: "in_progress" });
      }
    }),
    vscode.commands.registerCommand("redmyne.setStatusClosed", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssueStatus", { id: issue.id, statusPattern: "closed" });
      }
    }),
    vscode.commands.registerCommand("redmyne.setStatusOther", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssueStatus", { id: issue.id });
      }
    }),
    vscode.commands.registerCommand("redmyne.setPriorityLow", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: issue.id, priorityPattern: "low" });
      }
    }),
    vscode.commands.registerCommand("redmyne.setPriorityNormal", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: issue.id, priorityPattern: "normal" });
      }
    }),
    vscode.commands.registerCommand("redmyne.setPriorityHigh", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: issue.id, priorityPattern: "high" });
      }
    }),
    vscode.commands.registerCommand("redmyne.setPriorityUrgent", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: issue.id, priorityPattern: "urgent" });
      }
    }),
    vscode.commands.registerCommand("redmyne.setPriorityImmediate", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: issue.id, priorityPattern: "immediate" });
      }
    }),
    vscode.commands.registerCommand("redmyne.setPriorityOther", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: issue.id });
      }
    }),
    vscode.commands.registerCommand("redmyne.autoUpdateOn", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setAutoUpdateDoneRatio", { id: issue.id, value: true });
      }
    }),
    vscode.commands.registerCommand("redmyne.autoUpdateOff", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setAutoUpdateDoneRatio", { id: issue.id, value: false });
      }
    }),
    vscode.commands.registerCommand("redmyne.adHocOn", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setAdHoc", { id: issue.id, value: true });
      }
    }),
    vscode.commands.registerCommand("redmyne.adHocOff", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setAdHoc", { id: issue.id, value: false });
      }
    }),
    vscode.commands.registerCommand("redmyne.precedenceOn", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setPrecedence", { id: issue.id, value: true });
      }
    }),
    vscode.commands.registerCommand("redmyne.precedenceOff", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setPrecedence", { id: issue.id, value: false });
      }
    }),
    vscode.commands.registerCommand("redmyne.updateIssue", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.issueActions", false, {}, `${issue.id}`);
      }
    })
  );

  return disposables;
}
