import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { GanttPanel } from "../../../src/webviews/gantt-panel";
import { registerIssueContextCommands } from "../../../src/commands/issue-context-commands";
import { autoUpdateTracker } from "../../../src/utilities/auto-update-tracker";

type RegisteredHandler = (...args: unknown[]) => unknown;

describe("registerIssueContextCommands", () => {
  let handlers: Map<string, RegisteredHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map<string, RegisteredHandler>();
    vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
      handlers.set(command as string, callback as RegisteredHandler);
      return { dispose: vi.fn() } as unknown as vscode.Disposable;
    });
    (GanttPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  });

  function setServerUrl(url: string | undefined): void {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn().mockReturnValue(url),
      update: vi.fn(),
    } as unknown as vscode.WorkspaceConfiguration);
  }

  function registerCommands(overrides?: Record<string, unknown>): vscode.Disposable[] {
    const baseDeps = {
      globalState: {
        get: vi.fn(),
        update: vi.fn(),
      } as unknown as vscode.Memento,
      getProjectsServer: () => undefined,
      refreshProjectsTree: vi.fn(),
      getAssignedIssues: () => [],
      getDependencyIssues: () => [],
      getProjectNodeById: () => undefined,
      getProjectsTreeView: () => undefined,
      getTimeEntriesServer: () => undefined,
      refreshTimeEntries: vi.fn(),
    };
    return registerIssueContextCommands({
      ...baseDeps,
      ...(overrides ?? {}),
    });
  }

  it("registers issue context command surface", () => {
    const disposables = registerCommands();

    expect(disposables).toHaveLength(17);
    expect(Array.from(handlers.keys())).toEqual(
      expect.arrayContaining([
        "redmyne.setDoneRatio",
        "redmyne.setStatus",
        "redmyne.bulkSetDoneRatio",
        "redmyne.setIssueStatus",
        "redmyne.openProjectInBrowser",
        "redmyne.showProjectInGantt",
        "redmyne.revealIssueInTree",
        "redmyne.revealProjectInTree",
        "redmyne.toggleAutoUpdateDoneRatio",
        "redmyne.toggleAdHoc",
        "redmyne.contributeToIssue",
        "redmyne.removeContribution",
        "redmyne.togglePrecedence",
        "redmyne.setIssuePriority",
        "redmyne.setAutoUpdateDoneRatio",
        "redmyne.setAdHoc",
        "redmyne.setPrecedence",
      ])
    );
  });

  it("opens project in browser when project identifier and URL exist", async () => {
    setServerUrl("https://redmine.example.test");
    registerCommands();

    await handlers.get("redmyne.openProjectInBrowser")?.({
      project: { identifier: "ops" },
    });

    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
    const [uri] = vi.mocked(vscode.env.openExternal).mock.calls[0];
    expect((uri as { toString(): string }).toString()).toBe(
      "https://redmine.example.test/projects/ops"
    );
  });

  it("shows error when project identifier is missing", async () => {
    setServerUrl("https://redmine.example.test");
    registerCommands();

    await handlers.get("redmyne.openProjectInBrowser")?.({});

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Could not determine project identifier"
    );
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });

  it("shows project in gantt and reveals selected project id", async () => {
    registerCommands();
    const showProject = vi.fn();
    (GanttPanel as unknown as { currentPanel: { showProject: ReturnType<typeof vi.fn> } }).currentPanel = {
      showProject,
    };

    await handlers.get("redmyne.showProjectInGantt")?.({
      project: { id: 123 },
    });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.showGantt");
    expect(showProject).toHaveBeenCalledWith(123);
  });

  it("shows error when gantt project id cannot be determined", async () => {
    registerCommands();

    await handlers.get("redmyne.showProjectInGantt")?.({});

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Could not determine project ID"
    );
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("redmyne.showGantt");
  });

  it("updates done ratio with preset percentage and refreshes gantt", async () => {
    const mockServer = {
      updateDoneRatio: vi.fn().mockResolvedValue(undefined),
    };
    const disableSpy = vi.spyOn(autoUpdateTracker, "disable");
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("");
    const updateIssueDoneRatio = vi.fn();
    (GanttPanel as unknown as { currentPanel: { updateIssueDoneRatio: ReturnType<typeof vi.fn> } }).currentPanel = {
      updateIssueDoneRatio,
    };

    registerCommands({ getProjectsServer: () => mockServer });

    await handlers.get("redmyne.setDoneRatio")?.({ id: 42, percentage: 60 });

    expect(mockServer.updateDoneRatio).toHaveBeenCalledWith(42, 60);
    expect(disableSpy).toHaveBeenCalledWith(42);
    expect(updateIssueDoneRatio).toHaveBeenCalledWith(42, 60);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.refreshGanttData");
  });

  it("updates status from picker and refreshes tree and gantt", async () => {
    const mockServer = {
      getIssueStatusesTyped: vi.fn().mockResolvedValue([
        { statusId: 2, name: "In Progress" },
      ]),
      setIssueStatus: vi.fn().mockResolvedValue(undefined),
    };
    const refreshProjectsTree = vi.fn();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: "In Progress",
      value: 2,
    } as unknown as vscode.QuickPickItem);

    registerCommands({
      getProjectsServer: () => mockServer,
      refreshProjectsTree,
    });

    await handlers.get("redmyne.setStatus")?.({ id: 42 });

    expect(mockServer.getIssueStatusesTyped).toHaveBeenCalled();
    expect(mockServer.setIssueStatus).toHaveBeenCalledWith({ id: 42 }, 2);
    expect(refreshProjectsTree).toHaveBeenCalled();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.refreshGanttData");
  });

  it("updates issue priority from pattern without picker", async () => {
    const mockServer = {
      getIssuePriorities: vi.fn().mockResolvedValue({
        issue_priorities: [
          { id: 1, name: "Low" },
          { id: 3, name: "High" },
        ],
      }),
      setIssuePriority: vi.fn().mockResolvedValue(undefined),
    };

    registerCommands({ getProjectsServer: () => mockServer });

    await handlers.get("redmyne.setIssuePriority")?.({
      id: 12,
      priorityPattern: "high",
    });

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(mockServer.setIssuePriority).toHaveBeenCalledWith(12, 3);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.refreshGanttData");
  });

  it("shows server error when status command runs without configured server", async () => {
    registerCommands();

    await handlers.get("redmyne.setStatus")?.({ id: 9 });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "No Redmine server configured"
    );
  });
});
