import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerContextProxyCommands } from "../../../src/commands/context-proxy-commands";

type RegisteredHandler = (...args: unknown[]) => unknown;

describe("registerContextProxyCommands", () => {
  let handlers: Map<string, RegisteredHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map<string, RegisteredHandler>();

    vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
      handlers.set(command as string, callback as RegisteredHandler);
      return { dispose: vi.fn() } as unknown as vscode.Disposable;
    });
  });

  it("registers a stable command surface", () => {
    const disposables = registerContextProxyCommands();

    expect(disposables).toHaveLength(handlers.size);
    expect(handlers.size).toBeGreaterThan(70);
    expect(handlers.has("redmyne.gantt.updateIssue")).toBe(true);
    expect(handlers.has("redmyne.gantt.setPriorityHigh")).toBe(true);
    expect(handlers.has("redmyne.timesheet.showIssueInSidebar")).toBe(true);
    expect(handlers.has("redmyne.setDoneRatio60")).toBe(true);
    expect(handlers.has("redmyne.updateIssue")).toBe(true);
  });

  it("forwards gantt priority command to canonical command with payload", () => {
    registerContextProxyCommands();

    handlers.get("redmyne.gantt.setPriorityHigh")?.({ issueId: 42 });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.setIssuePriority", {
      id: 42,
      priorityPattern: "high",
    });
  });

  it("forwards reveal commands with raw id argument", () => {
    registerContextProxyCommands();

    handlers.get("redmyne.gantt.showInIssues")?.({ issueId: 77 });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.revealIssueInTree", 77);
  });

  it("forwards sidebar presets with percentage payload", () => {
    registerContextProxyCommands();

    handlers.get("redmyne.setDoneRatio60")?.({ id: 123 });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.setDoneRatio", {
      id: 123,
      percentage: 60,
    });
  });

  it("forwards project commands with nested project object", () => {
    registerContextProxyCommands();

    handlers.get("redmyne.gantt.showProjectInGantt")?.({ projectId: 9 });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.showProjectInGantt", {
      project: { id: 9 },
    });
  });

  it("copies project URL from gantt context when server URL exists", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn().mockReturnValue("https://redmine.example.test"),
      update: vi.fn(),
    } as unknown as vscode.WorkspaceConfiguration);
    registerContextProxyCommands();

    handlers.get("redmyne.gantt.copyProjectUrl")?.({ projectIdentifier: "ops" });

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
      "https://redmine.example.test/projects/ops"
    );
  });

  it("does not copy project URL when server URL is missing", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
      update: vi.fn(),
    } as unknown as vscode.WorkspaceConfiguration);
    registerContextProxyCommands();

    handlers.get("redmyne.gantt.copyProjectUrl")?.({ projectIdentifier: "ops" });

    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("does not execute when required context is missing", () => {
    registerContextProxyCommands();

    handlers.get("redmyne.gantt.updateIssue")?.({});
    handlers.get("redmyne.setPriorityLow")?.({});

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it("forwards gantt presets and toggles to canonical commands", () => {
    registerContextProxyCommands();

    handlers.get("redmyne.gantt.setDoneRatio0")?.({ issueId: 7 });
    handlers.get("redmyne.gantt.setDoneRatio100")?.({ issueId: 7 });
    handlers.get("redmyne.gantt.autoUpdateOn")?.({ issueId: 7 });
    handlers.get("redmyne.gantt.autoUpdateOff")?.({ issueId: 7 });
    handlers.get("redmyne.gantt.adHocOn")?.({ issueId: 7 });
    handlers.get("redmyne.gantt.adHocOff")?.({ issueId: 7 });
    handlers.get("redmyne.gantt.precedenceOn")?.({ issueId: 7 });
    handlers.get("redmyne.gantt.precedenceOff")?.({ issueId: 7 });
    handlers.get("redmyne.gantt.setInternalEstimate")?.({ issueId: 7 });
    handlers.get("redmyne.gantt.clearInternalEstimate")?.({ issueId: 7 });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "redmyne.setDoneRatio",
      { id: 7, percentage: 0 }
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "redmyne.setDoneRatio",
      { id: 7, percentage: 100 }
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "redmyne.setAutoUpdateDoneRatio",
      { id: 7, value: true }
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "redmyne.setAdHoc",
      { id: 7, value: false }
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "redmyne.setPrecedence",
      { id: 7, value: true }
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "redmyne.clearInternalEstimate",
      { id: 7 }
    );
  });

  it("handles gantt clipboard commands for issue and project ids", () => {
    registerContextProxyCommands();

    handlers.get("redmyne.gantt.copyIssueId")?.({ issueId: 22 });
    handlers.get("redmyne.gantt.copyProjectId")?.({ projectId: 33 });
    handlers.get("redmyne.gantt.copyIssueId")?.({});
    handlers.get("redmyne.gantt.copyProjectId")?.({});

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("#22");
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("#33");
    expect(vi.mocked(vscode.env.clipboard.writeText).mock.calls).toHaveLength(2);
  });

  it("forwards project creation/open commands from gantt and timesheet contexts", () => {
    registerContextProxyCommands();

    handlers.get("redmyne.gantt.createIssue")?.({ projectId: 8 });
    handlers.get("redmyne.gantt.createVersion")?.({ projectId: 8 });
    handlers.get("redmyne.gantt.createSubIssue")?.({ issueId: 44, projectId: 8 });
    handlers.get("redmyne.gantt.openProjectInBrowser")?.({ projectIdentifier: "ops" });
    handlers.get("redmyne.gantt.showProjectInIssues")?.({ projectId: 8 });
    handlers.get("redmyne.timesheet.openProjectInBrowser")?.({ projectIdentifier: "ops" });
    handlers.get("redmyne.timesheet.showProjectInSidebar")?.({ projectId: 8 });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.quickCreateIssue", {
      project: { id: 8 },
    });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.quickCreateVersion", {
      project: { id: 8 },
    });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.quickCreateSubIssue", {
      id: 44,
      project: { id: 8 },
    });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.openProjectInBrowser", {
      project: { identifier: "ops" },
    });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.revealProjectInTree", 8);
  });

  it("forwards sidebar status/priority/toggle commands", () => {
    registerContextProxyCommands();

    handlers.get("redmyne.setStatusNew")?.({ id: 5 });
    handlers.get("redmyne.setStatusInProgress")?.({ id: 5 });
    handlers.get("redmyne.setStatusClosed")?.({ id: 5 });
    handlers.get("redmyne.setStatusOther")?.({ id: 5 });
    handlers.get("redmyne.setPriorityLow")?.({ id: 5 });
    handlers.get("redmyne.setPriorityNormal")?.({ id: 5 });
    handlers.get("redmyne.setPriorityHigh")?.({ id: 5 });
    handlers.get("redmyne.setPriorityUrgent")?.({ id: 5 });
    handlers.get("redmyne.setPriorityImmediate")?.({ id: 5 });
    handlers.get("redmyne.setPriorityOther")?.({ id: 5 });
    handlers.get("redmyne.autoUpdateOn")?.({ id: 5 });
    handlers.get("redmyne.autoUpdateOff")?.({ id: 5 });
    handlers.get("redmyne.adHocOn")?.({ id: 5 });
    handlers.get("redmyne.adHocOff")?.({ id: 5 });
    handlers.get("redmyne.precedenceOn")?.({ id: 5 });
    handlers.get("redmyne.precedenceOff")?.({ id: 5 });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.setIssueStatus", {
      id: 5,
      statusPattern: "new",
    });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.setIssuePriority", {
      id: 5,
      priorityPattern: "immediate",
    });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.setAutoUpdateDoneRatio", {
      id: 5,
      value: true,
    });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.setPrecedence", {
      id: 5,
      value: false,
    });
  });

  it("forwards updateIssue to legacy issueActions signature", () => {
    registerContextProxyCommands();

    handlers.get("redmyne.updateIssue")?.({ id: 99 });
    handlers.get("redmyne.updateIssue")?.({});

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "redmyne.issueActions",
      false,
      {},
      "99"
    );
  });
});
