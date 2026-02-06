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

  it("does not execute when required context is missing", () => {
    registerContextProxyCommands();

    handlers.get("redmyne.gantt.updateIssue")?.({});
    handlers.get("redmyne.setPriorityLow")?.({});

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});
