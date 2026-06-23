import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerGanttCommands } from "../../../src/commands/gantt-commands";
import { GanttPanel } from "../../../src/webviews/gantt-panel";

type RegisteredHandler = (...args: unknown[]) => unknown;

describe("registerGanttCommands", () => {
  let handlers: Map<string, RegisteredHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map<string, RegisteredHandler>();
    GanttPanel.currentPanel = undefined;

    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_: string, fallback: unknown) => fallback),
    } as unknown as vscode.WorkspaceConfiguration);

    vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
      handlers.set(command as string, callback as RegisteredHandler);
      return { dispose: vi.fn() } as unknown as vscode.Disposable;
    });
  });

  function registerCommands(fetchIssuesIfNeeded: ReturnType<typeof vi.fn>) {
    const context = {
      subscriptions: [],
      extensionUri: {} as vscode.Uri,
    } as unknown as vscode.ExtensionContext;

    const deps = {
      getServer: vi.fn(() => undefined),
      fetchIssuesIfNeeded,
      getDependencyIssues: vi.fn(() => []),
      getFlexibilityCache: vi.fn(() => new Map()),
      getProjects: vi.fn(() => []),
      clearProjects: vi.fn(),
      getFilter: vi.fn(() => ({ mode: "all" }) as unknown),
      setFilter: vi.fn(),
      getDraftModeManager: vi.fn(() => undefined),
    };

    registerGanttCommands(context, deps as never);
    return deps;
  }

  it("registers gantt command surface", () => {
    registerCommands(vi.fn().mockResolvedValue([]));

    expect(Array.from(handlers.keys())).toEqual(
      expect.arrayContaining([
        "redmyne.showGantt",
        "redmyne.refreshGanttData",
        "redmyne.openIssueInGantt",
      ])
    );
  });

  it("showGantt shows info when no issues", async () => {
    const fetchIssuesIfNeeded = vi.fn().mockResolvedValue([]);
    const createOrShowSpy = vi.spyOn(GanttPanel, "createOrShow");
    registerCommands(fetchIssuesIfNeeded);

    await handlers.get("redmyne.showGantt")?.();

    expect(fetchIssuesIfNeeded).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "No issues to display. Configure Redmine and assign issues to yourself."
    );
    expect(createOrShowSpy).not.toHaveBeenCalled();
  });

  it("showGantt updates panel and forwards filter callback", async () => {
    const fetchIssuesIfNeeded = vi.fn().mockResolvedValue([{ id: 42, project: { id: 7 } }]);
    const deps = registerCommands(fetchIssuesIfNeeded);
    let filterCallback: ((filter: unknown) => void) | undefined;
    const panel = {
      updateIssues: vi.fn(),
      setFilterChangeCallback: vi.fn((cb: (filter: unknown) => void) => {
        filterCallback = cb;
      }),
      showProject: vi.fn(),
      scrollToIssue: vi.fn(),
    };
    vi.spyOn(GanttPanel, "createOrShow").mockReturnValue(panel as never);

    await handlers.get("redmyne.showGantt")?.();
    filterCallback?.({ mode: "mine" });

    expect(GanttPanel.createOrShow).toHaveBeenCalledTimes(1);
    expect(panel.updateIssues).toHaveBeenCalledTimes(1);
    expect(deps.setFilter).toHaveBeenCalledWith({ mode: "mine" });
  });

  it("refreshGanttData exits when panel is missing", async () => {
    const fetchIssuesIfNeeded = vi.fn().mockResolvedValue([{ id: 1 }]);
    registerCommands(fetchIssuesIfNeeded);

    await handlers.get("redmyne.refreshGanttData")?.();

    expect(fetchIssuesIfNeeded).not.toHaveBeenCalled();
  });

  it("refreshGanttData exits when panel exists but no issues", async () => {
    const fetchIssuesIfNeeded = vi.fn().mockResolvedValue([]);
    registerCommands(fetchIssuesIfNeeded);
    GanttPanel.currentPanel = {
      updateIssues: vi.fn(),
    } as unknown as GanttPanel;

    await handlers.get("redmyne.refreshGanttData")?.();

    expect(fetchIssuesIfNeeded).toHaveBeenCalledTimes(1);
    expect(GanttPanel.currentPanel.updateIssues).not.toHaveBeenCalled();
  });

  it("refreshGanttData updates panel when issues exist", async () => {
    const fetchIssuesIfNeeded = vi.fn().mockResolvedValue([{ id: 42 }]);
    registerCommands(fetchIssuesIfNeeded);
    GanttPanel.currentPanel = {
      updateIssues: vi.fn(),
    } as unknown as GanttPanel;

    await handlers.get("redmyne.refreshGanttData")?.();

    expect(fetchIssuesIfNeeded).toHaveBeenCalledTimes(1);
    expect(GanttPanel.currentPanel.updateIssues).toHaveBeenCalledTimes(1);
  });

  it("shows issue ID error when opening issue in gantt without issue", async () => {
    const fetchIssuesIfNeeded = vi.fn().mockResolvedValue([]);
    registerCommands(fetchIssuesIfNeeded);

    await handlers.get("redmyne.openIssueInGantt")?.(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Could not determine issue ID"
    );
    expect(fetchIssuesIfNeeded).not.toHaveBeenCalled();
  });

  it("reveals the issue in place when it passes the current filter", async () => {
    vi.useFakeTimers();
    try {
      const fetchIssuesIfNeeded = vi.fn().mockResolvedValue([
        { id: 42, project: { id: 7 } },
      ]);
      const deps = registerCommands(fetchIssuesIfNeeded);
      let filterCallback: ((filter: unknown) => void) | undefined;
      const panel = {
        updateIssues: vi.fn(),
        setFilterChangeCallback: vi.fn((cb: (filter: unknown) => void) => {
          filterCallback = cb;
        }),
        isIssueInCurrentFilter: vi.fn(() => true),
        broadenViewForReveal: vi.fn(),
        revealIssue: vi.fn(),
      };
      vi.spyOn(GanttPanel, "createOrShow").mockReturnValue(panel as never);

      await handlers.get("redmyne.openIssueInGantt")?.({ id: 42 });
      filterCallback?.({ mode: "done" });

      expect(GanttPanel.createOrShow).toHaveBeenCalled();
      expect(panel.updateIssues).toHaveBeenCalledTimes(1);
      expect(deps.setFilter).toHaveBeenCalledWith({ mode: "done" });
      // Visible → no broadening, just reveal.
      expect(panel.broadenViewForReveal).not.toHaveBeenCalled();
      expect(panel.revealIssue).not.toHaveBeenCalled();

      vi.advanceTimersByTime(150);
      expect(panel.revealIssue).toHaveBeenCalledWith(42);
    } finally {
      vi.useRealTimers();
    }
  });

  it("broadens the view then reveals when the issue is filtered out", async () => {
    vi.useFakeTimers();
    try {
      const fetchIssuesIfNeeded = vi.fn().mockResolvedValue([{ id: 42 }]);
      registerCommands(fetchIssuesIfNeeded);
      const panel = {
        updateIssues: vi.fn(),
        setFilterChangeCallback: vi.fn(),
        isIssueInCurrentFilter: vi.fn(() => false),
        broadenViewForReveal: vi.fn(),
        revealIssue: vi.fn(),
      };
      vi.spyOn(GanttPanel, "createOrShow").mockReturnValue(panel as never);

      await handlers.get("redmyne.openIssueInGantt")?.({ id: 42 });

      expect(panel.broadenViewForReveal).toHaveBeenCalled();
      // bootstrap render + the broadened re-render.
      expect(panel.updateIssues).toHaveBeenCalledTimes(2);
      expect(panel.revealIssue).not.toHaveBeenCalled();

      vi.advanceTimersByTime(250);
      expect(panel.revealIssue).toHaveBeenCalledWith(42);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows info when there are no issues to display", async () => {
    const fetchIssuesIfNeeded = vi.fn().mockResolvedValue([]);
    registerCommands(fetchIssuesIfNeeded);

    await handlers.get("redmyne.openIssueInGantt")?.({ id: 42 });

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "No issues to display. Configure Redmine and assign issues to yourself."
    );
  });
});
