import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { GanttPanel } from "../../../src/webviews/gantt-panel";
import { registerIssueContextCommands } from "../../../src/commands/issue-context-commands";
import { autoUpdateTracker } from "../../../src/utilities/auto-update-tracker";
import * as adhocCommands from "../../../src/commands/adhoc-commands";
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

    expect(disposables).toHaveLength(13);
    expect(Array.from(handlers.keys())).toEqual(
      expect.arrayContaining([
        "redmyne.setDoneRatio",
        "redmyne.clearDoneRatio",
        "redmyne.setStatus",
        "redmyne.bulkSetDoneRatio",
        "redmyne.setIssueStatus",
        "redmyne.openProjectInBrowser",
        "redmyne.showProjectInGantt",
        "redmyne.revealIssueInTree",
        "redmyne.revealProjectInTree",
        "redmyne.contributeToIssue",
        "redmyne.removeContribution",
        "redmyne.toggleAdHoc",
        "redmyne.setIssuePriority",
      ])
    );
  });

  it("setting 100% skips the remaining-hours prompt and clears the estimate", async () => {
    const mockServer = { updateDoneRatio: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(autoUpdateTracker, "disable").mockResolvedValue(undefined);
    const clearSpy = vi.spyOn(internalEstimates, "clearInternalEstimate").mockResolvedValue(undefined);
    registerCommands({ getProjectsServer: () => mockServer });

    await handlers.get("redmyne.setDoneRatio")?.({ id: 42, percentage: 100 });

    expect(mockServer.updateDoneRatio).toHaveBeenCalledWith(42, 100);
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalledWith(expect.anything(), 42);
  });

  it("clearDoneRatio resets to time-based progress", async () => {
    const mockServer = { updateDoneRatio: vi.fn().mockResolvedValue(undefined) };
    const enableSpy = vi.spyOn(autoUpdateTracker, "enable").mockResolvedValue(undefined);
    const clearSpy = vi.spyOn(internalEstimates, "clearInternalEstimate").mockResolvedValue(undefined);
    registerCommands({ getProjectsServer: () => mockServer });

    await handlers.get("redmyne.clearDoneRatio")?.({ id: 42 });

    expect(mockServer.updateDoneRatio).toHaveBeenCalledWith(42, 0);
    expect(clearSpy).toHaveBeenCalledWith(expect.anything(), 42);
    expect(enableSpy).toHaveBeenCalledWith(42);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.refreshGanttData");
  });

  it("toggleAdHoc routes to the tracker and refreshes the gantt", async () => {
    const toggleSpy = vi.spyOn(adhocCommands, "toggleAdHoc").mockResolvedValue(undefined);
    registerCommands();

    await handlers.get("redmyne.toggleAdHoc")?.({ id: 42 });

    expect(toggleSpy).toHaveBeenCalledWith({ id: 42 });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.refreshGanttData");
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
    const disableSpy = vi.spyOn(autoUpdateTracker, "disable").mockResolvedValue(undefined);
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

  it("setDoneRatio syncs the tree cache so refreshGanttData can't revert it", async () => {
    const mockServer = { updateDoneRatio: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(autoUpdateTracker, "disable").mockResolvedValue(undefined);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("");
    const cached = { id: 42, done_ratio: 30 } as never;
    registerCommands({ getProjectsServer: () => mockServer, getAssignedIssues: () => [cached] });

    await handlers.get("redmyne.setDoneRatio")?.({ id: 42, percentage: 60 });

    // The gantt re-reads this object on refresh; stale 30 would revert the bar.
    expect((cached as { done_ratio: number }).done_ratio).toBe(60);
  });

  it("clearDoneRatio resets the cached object (assigned and dependency) to 0", async () => {
    const mockServer = { updateDoneRatio: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(autoUpdateTracker, "enable").mockResolvedValue(undefined);
    vi.spyOn(internalEstimates, "clearInternalEstimate").mockResolvedValue(undefined);
    const assigned = { id: 7, done_ratio: 80 } as never;
    const dep = { id: 9, done_ratio: 50 } as never;
    registerCommands({
      getProjectsServer: () => mockServer,
      getAssignedIssues: () => [assigned],
      getDependencyIssues: () => [dep],
    });

    await handlers.get("redmyne.clearDoneRatio")?.({ id: 9 }); // a dependency issue

    expect((dep as { done_ratio: number }).done_ratio).toBe(0);
    expect((assigned as { done_ratio: number }).done_ratio).toBe(80); // untouched
  });

  it("bulkSetDoneRatio syncs every selected issue in the tree cache", async () => {
    const mockServer = { updateDoneRatio: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(autoUpdateTracker, "disable").mockResolvedValue(undefined);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: "40%", value: 40 } as never);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("");
    const c1 = { id: 1, done_ratio: 0 } as never;
    const c2 = { id: 2, done_ratio: 90 } as never;
    registerCommands({ getProjectsServer: () => mockServer, getAssignedIssues: () => [c1, c2] });

    await handlers.get("redmyne.bulkSetDoneRatio")?.([1, 2]);

    expect((c1 as { done_ratio: number }).done_ratio).toBe(40);
    expect((c2 as { done_ratio: number }).done_ratio).toBe(40);
  });

  it("updates status from picker and refreshes tree and gantt", async () => {
    const mockServer = {
      getIssueStatuses: vi.fn().mockResolvedValue({
        issue_statuses: [{ id: 2, name: "In Progress", is_closed: false }],
      }),
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

    expect(mockServer.getIssueStatuses).toHaveBeenCalled();
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

  it("serializes setInternalEstimate in bulk so writes don't race on globalState", async () => {
    const mockServer = {
      updateDoneRatio: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(autoUpdateTracker, "disable").mockResolvedValue(undefined);
    let inFlight = 0;
    let maxInFlight = 0;
    const estimateSpy = vi
      .spyOn(internalEstimates, "setInternalEstimate")
      .mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
      });
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: "50%",
      value: 50,
    } as unknown as vscode.QuickPickItem);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("1");

    registerCommands({ getProjectsServer: () => mockServer });
    await handlers.get("redmyne.bulkSetDoneRatio")?.([1, 2, 3]);

    expect(estimateSpy).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
  });

  it("bulk updates done ratio and internal estimates for selected issues", async () => {
    const mockServer = {
      updateDoneRatio: vi.fn().mockResolvedValue(undefined),
    };
    const disableSpy = vi.spyOn(autoUpdateTracker, "disable").mockResolvedValue(undefined);
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
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    registerCommands({ getProjectsServer: () => mockServer });
    await handlers.get("redmyne.setIssueStatus")?.({ id: 55, statusPattern: "in_progress" });
    await handlers.get("redmyne.setIssueStatus")?.({ id: 56, statusPattern: "closed" });

    expect(mockServer.setIssueStatus).toHaveBeenCalledTimes(1);
    expect(mockServer.setIssueStatus).toHaveBeenCalledWith({ id: 55 }, 2);
    // Unmatched pattern falls back to the picker instead of erroring
    expect(vscode.window.showQuickPick).toHaveBeenCalled();
  });

  it("setIssueStatus never writes a guessed status when pattern has no match", async () => {
    const mockServer = {
      // Localized server: no status name contains "progress"
      getIssueStatuses: vi.fn().mockResolvedValue({
        issue_statuses: [
          { id: 1, name: "Neu", is_closed: false },
          { id: 4, name: "Feedback", is_closed: false },
          { id: 5, name: "Erledigt", is_closed: true },
        ],
      }),
      setIssueStatus: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    registerCommands({ getProjectsServer: () => mockServer });
    await handlers.get("redmyne.setIssueStatus")?.({ id: 55, statusPattern: "in_progress" });

    expect(mockServer.setIssueStatus).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).toHaveBeenCalled();
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
      getIssueStatuses: vi.fn().mockResolvedValue({
        issue_statuses: [{ id: 1, name: "Open", is_closed: false }],
      }),
      setIssueStatus: vi.fn().mockResolvedValue(undefined),
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

    registerCommands();
    await handlers.get("redmyne.setDoneRatio")?.({ id: 99, percentage: 40 });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("No Redmine server configured");
  });

  it("covers catch branches for done ratio, status, bulk, issue status, and priority", async () => {
    const mockServer = {
      updateDoneRatio: vi.fn().mockRejectedValue(new Error("done fail")),
      getIssueStatuses: vi.fn().mockRejectedValue(new Error("status fail")),
      setIssueStatus: vi.fn().mockResolvedValue(undefined),
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
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to update status: Error: status fail");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to update priority: Error: priority fail");
  });

  it("routes ad-hoc wrapper commands through callbacks and refreshes", async () => {
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

    await handlers.get("redmyne.contributeToIssue")?.({ entry_id: 100 });
    await handlers.get("redmyne.removeContribution")?.({ entry_id: 101 });

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
