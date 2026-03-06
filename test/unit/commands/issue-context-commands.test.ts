import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { GanttPanel } from "../../../src/webviews/gantt-panel";
import { registerIssueContextCommands } from "../../../src/commands/issue-context-commands";
import { autoUpdateTracker } from "../../../src/utilities/auto-update-tracker";
import { adHocTracker } from "../../../src/utilities/adhoc-tracker";
import * as adhocCommands from "../../../src/commands/adhoc-commands";
import * as precedenceTracker from "../../../src/utilities/precedence-tracker";
import * as internalEstimates from "../../../src/utilities/internal-estimates";

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

  it("bulk updates done ratio and internal estimates for selected issues", async () => {
    const mockServer = {
      updateDoneRatio: vi.fn().mockResolvedValue(undefined),
    };
    const disableSpy = vi.spyOn(autoUpdateTracker, "disable");
    const estimateSpy = vi.spyOn(internalEstimates, "setInternalEstimate").mockResolvedValue(undefined);
    const updateIssueDoneRatio = vi.fn();
    (GanttPanel as unknown as { currentPanel: { updateIssueDoneRatio: ReturnType<typeof vi.fn> } }).currentPanel = {
      updateIssueDoneRatio,
    };
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: "80%",
      value: 80,
    } as unknown as vscode.QuickPickItem);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("2.5");

    registerCommands({ getProjectsServer: () => mockServer });
    await handlers.get("redmyne.bulkSetDoneRatio")?.([11, 12]);

    expect(mockServer.updateDoneRatio).toHaveBeenNthCalledWith(1, 11, 80);
    expect(mockServer.updateDoneRatio).toHaveBeenNthCalledWith(2, 12, 80);
    expect(disableSpy).toHaveBeenCalledWith(11);
    expect(disableSpy).toHaveBeenCalledWith(12);
    expect(estimateSpy).toHaveBeenCalledWith(expect.anything(), 11, 2.5);
    expect(estimateSpy).toHaveBeenCalledWith(expect.anything(), 12, 2.5);
    expect(updateIssueDoneRatio).toHaveBeenCalledWith(11, 80);
    expect(updateIssueDoneRatio).toHaveBeenCalledWith(12, 80);
  });

  it("setIssueStatus uses pattern fallback and handles missing pattern matches", async () => {
    const mockServer = {
      getIssueStatuses: vi.fn()
        .mockResolvedValueOnce({
          issue_statuses: [
            { id: 1, name: "New", is_closed: false },
            { id: 2, name: "Work In Progress", is_closed: false },
            { id: 3, name: "Closed", is_closed: true },
          ],
        })
        .mockResolvedValueOnce({
          issue_statuses: [{ id: 1, name: "Open", is_closed: false }],
        }),
      setIssueStatus: vi.fn().mockResolvedValue(undefined),
    };

    registerCommands({ getProjectsServer: () => mockServer });
    await handlers.get("redmyne.setIssueStatus")?.({ id: 55, statusPattern: "in_progress" });
    await handlers.get("redmyne.setIssueStatus")?.({ id: 56, statusPattern: "closed" });

    expect(mockServer.setIssueStatus).toHaveBeenCalledWith({ id: 55 }, 2);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "No matching status found for pattern: closed"
    );
  });

  it("reveals issue and project in tree when nodes exist", async () => {
    const reveal = vi.fn().mockResolvedValue(undefined);
    const getProjectsTreeView = () => ({
      reveal,
    }) as unknown as vscode.TreeView<unknown>;

    registerCommands({
      getAssignedIssues: () => [],
      getDependencyIssues: () => [{ id: 77 } as never],
      getProjectNodeById: (projectId: number) => (projectId === 99 ? { id: 99 } : undefined),
      getProjectsTreeView,
    });

    await handlers.get("redmyne.revealIssueInTree")?.(77);
    await handlers.get("redmyne.revealProjectInTree")?.(99);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne-explorer-projects.focus");
    expect(reveal).toHaveBeenCalledTimes(2);
  });

  it("routes explicit toggles to trackers and precedence helpers", async () => {
    const enableSpy = vi.spyOn(autoUpdateTracker, "enable");
    const disableSpy = vi.spyOn(autoUpdateTracker, "disable");
    const tagSpy = vi.spyOn(adHocTracker, "tag");
    const untagSpy = vi.spyOn(adHocTracker, "untag");
    const setPrecedenceSpy = vi.spyOn(precedenceTracker, "setPrecedence").mockResolvedValue(undefined);
    const clearPrecedenceSpy = vi.spyOn(precedenceTracker, "clearPrecedence").mockResolvedValue(undefined);
    vi.spyOn(precedenceTracker, "togglePrecedence").mockResolvedValue(true);

    registerCommands();

    await handlers.get("redmyne.setAutoUpdateDoneRatio")?.({ id: 1, value: true });
    await handlers.get("redmyne.setAutoUpdateDoneRatio")?.({ id: 1, value: false });
    await handlers.get("redmyne.setAdHoc")?.({ id: 2, value: true });
    await handlers.get("redmyne.setAdHoc")?.({ id: 2, value: false });
    await handlers.get("redmyne.setPrecedence")?.({ id: 3, value: true });
    await handlers.get("redmyne.setPrecedence")?.({ id: 3, value: false });
    await handlers.get("redmyne.togglePrecedence")?.({ id: 3 });

    expect(enableSpy).toHaveBeenCalledWith(1);
    expect(disableSpy).toHaveBeenCalledWith(1);
    expect(tagSpy).toHaveBeenCalledWith(2);
    expect(untagSpy).toHaveBeenCalledWith(2);
    expect(setPrecedenceSpy).toHaveBeenCalledWith(expect.anything(), 3);
    expect(clearPrecedenceSpy).toHaveBeenCalledWith(expect.anything(), 3);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.refreshGanttData");
  });

  it("handles no-selection and invalid-selection branches", async () => {
    const mockServer = {
      updateDoneRatio: vi.fn().mockResolvedValue(undefined),
      getIssuePriorities: vi.fn().mockResolvedValue({
        issue_priorities: [{ id: 1, name: "Normal" }],
      }),
      setIssuePriority: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    registerCommands({ getProjectsServer: () => mockServer });
    await handlers.get("redmyne.bulkSetDoneRatio")?.([]);
    await handlers.get("redmyne.setDoneRatio")?.({ id: 9 });
    await handlers.get("redmyne.setIssuePriority")?.({ id: 9 });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("No issues selected");
    expect(mockServer.updateDoneRatio).not.toHaveBeenCalled();
    expect(mockServer.setIssuePriority).not.toHaveBeenCalled();
  });

  it("covers guard and cancel paths across issue-context handlers", async () => {
    const mockServer = {
      updateDoneRatio: vi.fn().mockResolvedValue(undefined),
      getIssueStatusesTyped: vi.fn().mockResolvedValue([{ statusId: 1, name: "Open" }]),
      setIssueStatus: vi.fn().mockResolvedValue(undefined),
      getIssueStatuses: vi.fn().mockResolvedValue({
        issue_statuses: [{ id: 1, name: "Open", is_closed: false }],
      }),
      getIssuePriorities: vi.fn().mockResolvedValue({
        issue_priorities: [{ id: 1, name: "Normal" }],
      }),
      setIssuePriority: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);
    vi.mocked(vscode.window.showInputBox).mockImplementation(async (options) => {
      if (options?.validateInput) {
        expect(options.validateInput("")).toBeNull();
        expect(options.validateInput("bad-value")).toContain("Invalid format");
      }
      return "";
    });

    registerCommands({ getProjectsServer: () => mockServer });

    await handlers.get("redmyne.setDoneRatio")?.(undefined);
    await handlers.get("redmyne.setDoneRatio")?.({ id: 44 });
    await handlers.get("redmyne.setStatus")?.({ id: 44 });
    await handlers.get("redmyne.bulkSetDoneRatio")?.([44, 45]);
    await handlers.get("redmyne.setIssueStatus")?.({ id: 44 });
    await handlers.get("redmyne.setIssuePriority")?.({ id: 44 });
    await handlers.get("redmyne.revealIssueInTree")?.(0);
    await handlers.get("redmyne.revealProjectInTree")?.(-1);
    await handlers.get("redmyne.toggleAutoUpdateDoneRatio")?.(undefined);
    await handlers.get("redmyne.setAutoUpdateDoneRatio")?.(undefined);
    await handlers.get("redmyne.setAdHoc")?.(undefined);
    await handlers.get("redmyne.setPrecedence")?.(undefined);

    registerCommands();
    await handlers.get("redmyne.setDoneRatio")?.({ id: 99, percentage: 40 });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("No Redmine server configured");
  });

  it("covers catch branches for done ratio, status, bulk, issue status, and priority", async () => {
    const mockServer = {
      updateDoneRatio: vi.fn().mockRejectedValue(new Error("done fail")),
      getIssueStatusesTyped: vi.fn().mockRejectedValue(new Error("status fail")),
      setIssueStatus: vi.fn().mockResolvedValue(undefined),
      getIssueStatuses: vi.fn().mockRejectedValue(new Error("issue status fail")),
      getIssuePriorities: vi.fn().mockRejectedValue(new Error("priority fail")),
      setIssuePriority: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ label: "70%", value: 70 } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Any", value: 1 } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "50%", value: 50 } as unknown as vscode.QuickPickItem);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("");

    registerCommands({ getProjectsServer: () => mockServer });

    await handlers.get("redmyne.setDoneRatio")?.({ id: 1 });
    await handlers.get("redmyne.setStatus")?.({ id: 2 });
    await handlers.get("redmyne.bulkSetDoneRatio")?.([3]);
    await handlers.get("redmyne.setIssueStatus")?.({ id: 4 });
    await handlers.get("redmyne.setIssuePriority")?.({ id: 5, priorityPattern: "high" });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to update: Error: done fail");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to update: Error: status fail");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to update: Error: done fail");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to update status: Error: issue status fail");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to update priority: Error: priority fail");
  });

  it("routes ad-hoc wrapper commands through callbacks and refreshes", async () => {
    const toggleAdHocSpy = vi.spyOn(adhocCommands, "toggleAdHoc").mockResolvedValue(undefined as never);
    const contributeSpy = vi.spyOn(adhocCommands, "contributeToIssue").mockImplementation(
      (_item, _server, onDone) => {
        onDone();
      }
    );
    const removeSpy = vi.spyOn(adhocCommands, "removeContribution").mockImplementation(
      (_item, _server, onDone) => {
        onDone();
      }
    );
    const refreshTimeEntries = vi.fn();
    const mockTimeServer = { id: "time-server" };

    registerCommands({
      getTimeEntriesServer: () => mockTimeServer as never,
      refreshTimeEntries,
    });

    await handlers.get("redmyne.toggleAdHoc")?.({ id: 10 });
    await handlers.get("redmyne.contributeToIssue")?.({ entry_id: 100 });
    await handlers.get("redmyne.removeContribution")?.({ entry_id: 101 });

    expect(toggleAdHocSpy).toHaveBeenCalled();
    expect(contributeSpy).toHaveBeenCalledWith(
      { entry_id: 100 },
      mockTimeServer,
      expect.any(Function)
    );
    expect(removeSpy).toHaveBeenCalledWith(
      { entry_id: 101 },
      mockTimeServer,
      expect.any(Function)
    );
    expect(refreshTimeEntries).toHaveBeenCalledTimes(2);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.refreshGanttData");
  });
});
