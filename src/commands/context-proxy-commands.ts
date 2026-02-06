import * as vscode from "vscode";
import { showStatusBarMessage } from "../utilities/status-bar";
import { buildProjectUrl } from "./command-urls";

const DONE_RATIO_PRESETS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

interface IssueIdContext {
  issueId?: number;
}

interface IssueContext {
  id?: number;
}

interface ProjectIdContext {
  projectId?: number;
}

interface ProjectIdentifierContext {
  projectIdentifier?: string;
}

interface ProjectContext extends ProjectIdContext, ProjectIdentifierContext {}
interface SubIssueContext extends IssueIdContext, ProjectIdContext {}

function hasIssueId(ctx: IssueIdContext | undefined): ctx is { issueId: number } {
  return Boolean(ctx?.issueId);
}

function hasIssue(ctx: IssueContext | undefined): ctx is { id: number } {
  return Boolean(ctx?.id);
}

function hasProjectId(ctx: ProjectIdContext | undefined): ctx is { projectId: number } {
  return Boolean(ctx?.projectId);
}

function hasProjectIdentifier(
  ctx: ProjectIdentifierContext | undefined
): ctx is { projectIdentifier: string } {
  return Boolean(ctx?.projectIdentifier);
}

function hasIssueAndProjectId(
  ctx: SubIssueContext | undefined
): ctx is { issueId: number; projectId: number } {
  return Boolean(ctx?.issueId && ctx?.projectId);
}

function forwardIssueIdPayload(
  targetCommand: string,
  extraPayload: Record<string, unknown> = {}
): (ctx: IssueIdContext | undefined) => void {
  return (ctx: IssueIdContext | undefined): void => {
    if (!hasIssueId(ctx)) {
      return;
    }
    vscode.commands.executeCommand(targetCommand, { id: ctx.issueId, ...extraPayload });
  };
}

function forwardIssueIdValue(
  targetCommand: string
): (ctx: IssueIdContext | undefined) => void {
  return (ctx: IssueIdContext | undefined): void => {
    if (!hasIssueId(ctx)) {
      return;
    }
    vscode.commands.executeCommand(targetCommand, ctx.issueId);
  };
}

function forwardIssuePayload(
  targetCommand: string,
  extraPayload: Record<string, unknown> = {}
): (issue: IssueContext | undefined) => void {
  return (issue: IssueContext | undefined): void => {
    if (!hasIssue(issue)) {
      return;
    }
    vscode.commands.executeCommand(targetCommand, { id: issue.id, ...extraPayload });
  };
}

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
    vscode.commands.registerCommand(
      "redmyne.gantt.updateIssue",
      forwardIssueIdPayload("redmyne.openActionsForIssue")
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.openInBrowser",
      forwardIssueIdPayload("redmyne.openIssueInBrowser")
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.showInIssues",
      forwardIssueIdValue("redmyne.revealIssueInTree")
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.logTime",
      forwardIssueIdPayload("redmyne.quickLogTime")
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.setDoneRatio",
      forwardIssueIdPayload("redmyne.setDoneRatio")
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.setStatus",
      forwardIssueIdPayload("redmyne.setStatus")
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.setIssuePriority",
      forwardIssueIdPayload("redmyne.setIssuePriority")
    ),
    ...DONE_RATIO_PRESETS.map((pct) =>
      vscode.commands.registerCommand(
        `redmyne.gantt.setDoneRatio${pct}`,
        forwardIssueIdPayload("redmyne.setDoneRatio", { percentage: pct })
      )
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.setDoneRatioCustom",
      forwardIssueIdPayload("redmyne.setDoneRatio")
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.setStatusNew",
      forwardIssueIdPayload("redmyne.setIssueStatus", { statusPattern: "new" })
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.setStatusInProgress",
      forwardIssueIdPayload("redmyne.setIssueStatus", { statusPattern: "in_progress" })
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.setStatusClosed",
      forwardIssueIdPayload("redmyne.setIssueStatus", { statusPattern: "closed" })
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.setStatusOther",
      forwardIssueIdPayload("redmyne.setIssueStatus")
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.toggleAutoUpdate",
      forwardIssueIdPayload("redmyne.toggleAutoUpdateDoneRatio")
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.toggleAdHoc",
      forwardIssueIdPayload("redmyne.toggleAdHoc")
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.togglePrecedence",
      forwardIssueIdPayload("redmyne.togglePrecedence")
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.copyUrl",
      forwardIssueIdPayload("redmyne.copyIssueUrl")
    ),
    vscode.commands.registerCommand("redmyne.gantt.copyIssueId", (ctx: IssueIdContext | undefined) => {
      if (hasIssueId(ctx)) {
        vscode.env.clipboard.writeText(`#${ctx.issueId}`);
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.copyProjectId", (ctx: ProjectIdContext | undefined) => {
      if (hasProjectId(ctx)) {
        vscode.env.clipboard.writeText(`#${ctx.projectId}`);
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.copyProjectUrl", (ctx: ProjectContext | undefined) => {
      if (!hasProjectIdentifier(ctx)) {
        return;
      }
      const url = vscode.workspace.getConfiguration("redmyne").get<string>("serverUrl");
      if (url) {
        vscode.env.clipboard.writeText(buildProjectUrl(url, ctx.projectIdentifier));
        showStatusBarMessage("$(check) Copied project URL", 2000);
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.createSubIssue", (ctx: SubIssueContext | undefined) => {
      if (!hasIssueAndProjectId(ctx)) {
        return;
      }
      vscode.commands.executeCommand("redmyne.quickCreateSubIssue", {
        id: ctx.issueId,
        project: { id: ctx.projectId },
      });
    }),
    vscode.commands.registerCommand("redmyne.gantt.openProjectInBrowser", (ctx: ProjectContext | undefined) => {
      if (hasProjectIdentifier(ctx)) {
        vscode.commands.executeCommand("redmyne.openProjectInBrowser", {
          project: { identifier: ctx.projectIdentifier },
        });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.showProjectInGantt", (ctx: ProjectContext | undefined) => {
      if (hasProjectId(ctx)) {
        vscode.commands.executeCommand("redmyne.showProjectInGantt", {
          project: { id: ctx.projectId },
        });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.showProjectInIssues", (ctx: ProjectIdContext | undefined) => {
      if (hasProjectId(ctx)) {
        vscode.commands.executeCommand("redmyne.revealProjectInTree", ctx.projectId);
      }
    }),

    // Timesheet webview context menu commands
    vscode.commands.registerCommand(
      "redmyne.timesheet.openIssueInBrowser",
      forwardIssueIdPayload("redmyne.openIssueInBrowser")
    ),
    vscode.commands.registerCommand(
      "redmyne.timesheet.showIssueInSidebar",
      forwardIssueIdValue("redmyne.revealIssueInTree")
    ),
    vscode.commands.registerCommand(
      "redmyne.timesheet.openProjectInBrowser",
      (ctx: ProjectContext | undefined) => {
        if (hasProjectIdentifier(ctx)) {
          vscode.commands.executeCommand("redmyne.openProjectInBrowser", {
            project: { identifier: ctx.projectIdentifier },
          });
        }
      }
    ),
    vscode.commands.registerCommand("redmyne.timesheet.showProjectInSidebar", (ctx: ProjectIdContext | undefined) => {
      if (hasProjectId(ctx)) {
        vscode.commands.executeCommand("redmyne.revealProjectInTree", ctx.projectId);
      }
    }),

    // Gantt submenu commands
    vscode.commands.registerCommand(
      "redmyne.gantt.setPriorityLow",
      forwardIssueIdPayload("redmyne.setIssuePriority", { priorityPattern: "low" })
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.setPriorityNormal",
      forwardIssueIdPayload("redmyne.setIssuePriority", { priorityPattern: "normal" })
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.setPriorityHigh",
      forwardIssueIdPayload("redmyne.setIssuePriority", { priorityPattern: "high" })
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.setPriorityUrgent",
      forwardIssueIdPayload("redmyne.setIssuePriority", { priorityPattern: "urgent" })
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.setPriorityImmediate",
      forwardIssueIdPayload("redmyne.setIssuePriority", { priorityPattern: "immediate" })
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.setPriorityOther",
      forwardIssueIdPayload("redmyne.setIssuePriority")
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.autoUpdateOn",
      forwardIssueIdPayload("redmyne.setAutoUpdateDoneRatio", { value: true })
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.autoUpdateOff",
      forwardIssueIdPayload("redmyne.setAutoUpdateDoneRatio", { value: false })
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.adHocOn",
      forwardIssueIdPayload("redmyne.setAdHoc", { value: true })
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.adHocOff",
      forwardIssueIdPayload("redmyne.setAdHoc", { value: false })
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.precedenceOn",
      forwardIssueIdPayload("redmyne.setPrecedence", { value: true })
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.precedenceOff",
      forwardIssueIdPayload("redmyne.setPrecedence", { value: false })
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.setInternalEstimate",
      forwardIssueIdPayload("redmyne.setInternalEstimate")
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.clearInternalEstimate",
      forwardIssueIdPayload("redmyne.clearInternalEstimate")
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.addToKanban",
      forwardIssueIdPayload("redmyne.addIssueToKanban")
    ),
    vscode.commands.registerCommand("redmyne.gantt.createIssue", (ctx: ProjectIdContext | undefined) => {
      if (hasProjectId(ctx)) {
        vscode.commands.executeCommand("redmyne.quickCreateIssue", { project: { id: ctx.projectId } });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.createVersion", (ctx: ProjectIdContext | undefined) => {
      if (hasProjectId(ctx)) {
        vscode.commands.executeCommand("redmyne.quickCreateVersion", { project: { id: ctx.projectId } });
      }
    }),

    // Sidebar submenu commands
    ...DONE_RATIO_PRESETS.map((pct) =>
      vscode.commands.registerCommand(
        `redmyne.setDoneRatio${pct}`,
        forwardIssuePayload("redmyne.setDoneRatio", { percentage: pct })
      )
    ),
    vscode.commands.registerCommand(
      "redmyne.setDoneRatioCustom",
      forwardIssuePayload("redmyne.setDoneRatio")
    ),
    vscode.commands.registerCommand(
      "redmyne.setStatusNew",
      forwardIssuePayload("redmyne.setIssueStatus", { statusPattern: "new" })
    ),
    vscode.commands.registerCommand(
      "redmyne.setStatusInProgress",
      forwardIssuePayload("redmyne.setIssueStatus", { statusPattern: "in_progress" })
    ),
    vscode.commands.registerCommand(
      "redmyne.setStatusClosed",
      forwardIssuePayload("redmyne.setIssueStatus", { statusPattern: "closed" })
    ),
    vscode.commands.registerCommand(
      "redmyne.setStatusOther",
      forwardIssuePayload("redmyne.setIssueStatus")
    ),
    vscode.commands.registerCommand(
      "redmyne.setPriorityLow",
      forwardIssuePayload("redmyne.setIssuePriority", { priorityPattern: "low" })
    ),
    vscode.commands.registerCommand(
      "redmyne.setPriorityNormal",
      forwardIssuePayload("redmyne.setIssuePriority", { priorityPattern: "normal" })
    ),
    vscode.commands.registerCommand(
      "redmyne.setPriorityHigh",
      forwardIssuePayload("redmyne.setIssuePriority", { priorityPattern: "high" })
    ),
    vscode.commands.registerCommand(
      "redmyne.setPriorityUrgent",
      forwardIssuePayload("redmyne.setIssuePriority", { priorityPattern: "urgent" })
    ),
    vscode.commands.registerCommand(
      "redmyne.setPriorityImmediate",
      forwardIssuePayload("redmyne.setIssuePriority", { priorityPattern: "immediate" })
    ),
    vscode.commands.registerCommand(
      "redmyne.setPriorityOther",
      forwardIssuePayload("redmyne.setIssuePriority")
    ),
    vscode.commands.registerCommand(
      "redmyne.autoUpdateOn",
      forwardIssuePayload("redmyne.setAutoUpdateDoneRatio", { value: true })
    ),
    vscode.commands.registerCommand(
      "redmyne.autoUpdateOff",
      forwardIssuePayload("redmyne.setAutoUpdateDoneRatio", { value: false })
    ),
    vscode.commands.registerCommand(
      "redmyne.adHocOn",
      forwardIssuePayload("redmyne.setAdHoc", { value: true })
    ),
    vscode.commands.registerCommand(
      "redmyne.adHocOff",
      forwardIssuePayload("redmyne.setAdHoc", { value: false })
    ),
    vscode.commands.registerCommand(
      "redmyne.precedenceOn",
      forwardIssuePayload("redmyne.setPrecedence", { value: true })
    ),
    vscode.commands.registerCommand(
      "redmyne.precedenceOff",
      forwardIssuePayload("redmyne.setPrecedence", { value: false })
    ),
    vscode.commands.registerCommand("redmyne.updateIssue", (issue: IssueContext | undefined) => {
      if (hasIssue(issue)) {
        vscode.commands.executeCommand("redmyne.issueActions", false, {}, `${issue.id}`);
      }
    })
  );

  return disposables;
}
