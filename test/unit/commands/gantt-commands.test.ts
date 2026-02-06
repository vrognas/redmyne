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
      getFilter: vi.fn(() => ({}) as unknown),
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

  it("shows issue ID error when opening issue in gantt without issue", async () => {
    const fetchIssuesIfNeeded = vi.fn().mockResolvedValue([]);
    registerCommands(fetchIssuesIfNeeded);

    await handlers.get("redmyne.openIssueInGantt")?.(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Could not determine issue ID"
    );
    expect(fetchIssuesIfNeeded).not.toHaveBeenCalled();
  });

  it("opens issue in gantt, shows project, and scrolls to issue", async () => {
    vi.useFakeTimers();
    try {
      const fetchIssuesIfNeeded = vi.fn().mockResolvedValue([
        { id: 42, project: { id: 7 } },
      ]);
      registerCommands(fetchIssuesIfNeeded);

      const panel = {
        updateIssues: vi.fn(),
        setFilterChangeCallback: vi.fn(),
        showProject: vi.fn(),
        scrollToIssue: vi.fn(),
      };
      vi.spyOn(GanttPanel, "createOrShow").mockReturnValue(panel as never);

      await handlers.get("redmyne.openIssueInGantt")?.({ id: 42 });

      expect(fetchIssuesIfNeeded).toHaveBeenCalled();
      expect(GanttPanel.createOrShow).toHaveBeenCalled();
      expect(panel.updateIssues).toHaveBeenCalled();
      expect(panel.setFilterChangeCallback).toHaveBeenCalled();
      expect(panel.showProject).toHaveBeenCalledWith(7);
      expect(panel.scrollToIssue).not.toHaveBeenCalled();

      vi.advanceTimersByTime(150);
      expect(panel.scrollToIssue).toHaveBeenCalledWith(42);
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
