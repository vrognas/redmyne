import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerViewCommands } from "../../../src/commands/view-commands";
import { ProjectsViewStyle } from "../../../src/trees/projects-tree";
import * as statusBarUtil from "../../../src/utilities/status-bar";

type Handler = (...args: unknown[]) => unknown;

describe("registerViewCommands", () => {
  let handlers: Map<string, Handler>;
  let context: vscode.ExtensionContext;
  let projectsTree: {
    clearProjects: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    setViewStyle: ReturnType<typeof vi.fn>;
    setFilter: ReturnType<typeof vi.fn>;
    setSort: ReturnType<typeof vi.fn>;
  };
  let timeEntriesTree: {
    setShowAllUsers: ReturnType<typeof vi.fn>;
    setSort: ReturnType<typeof vi.fn>;
  };
  let outputChannel: {
    show: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };
  let updateConfiguredContext: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(statusBarUtil, "showStatusBarMessage").mockImplementation(() => undefined);

    handlers = new Map<string, Handler>();
    context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    projectsTree = {
      clearProjects: vi.fn(),
      refresh: vi.fn(),
      setViewStyle: vi.fn(),
      setFilter: vi.fn(),
      setSort: vi.fn(),
    };
    timeEntriesTree = {
      setShowAllUsers: vi.fn(),
      setHideZeroDays: vi.fn(),
      getHideZeroDays: vi.fn().mockReturnValue(true),
      setSort: vi.fn(),
    };
    outputChannel = {
      show: vi.fn(),
      clear: vi.fn(),
    };
    updateConfiguredContext = vi.fn().mockResolvedValue(undefined);

    vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
      handlers.set(command as string, callback as Handler);
      return { dispose: vi.fn() } as unknown as vscode.Disposable;
    });
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn().mockReturnValue(false),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as vscode.WorkspaceConfiguration);

    registerViewCommands(context, {
      projectsTree: projectsTree as never,
      timeEntriesTree: timeEntriesTree as never,
      outputChannel: outputChannel as never,
      updateConfiguredContext,
    });
  });

  it("registers command surface and debounces refresh issues", () => {
    vi.useFakeTimers();
    try {
      expect(handlers.has("redmyne.refreshIssues")).toBe(true);
      expect(handlers.has("redmyne.toggleApiLogging")).toBe(true);
      expect(handlers.has("redmyne.filterMyOpen")).toBe(true);
      expect(handlers.has("redmyne.timeSortUser")).toBe(true);

      handlers.get("redmyne.refreshIssues")?.();
      handlers.get("redmyne.refreshIssues")?.();

      expect(projectsTree.clearProjects).not.toHaveBeenCalled();
      expect(projectsTree.refresh).not.toHaveBeenCalled();

      vi.advanceTimersByTime(300);

      expect(projectsTree.clearProjects).toHaveBeenCalledTimes(1);
      expect(projectsTree.refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("toggles API logging and updates configured context", async () => {
    const configUpdate = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation((section) => {
      if (section === "redmyne") {
        return {
          get: vi.fn((key: string) => (key === "logging.enabled" ? true : undefined)),
          update: configUpdate,
        } as unknown as vscode.WorkspaceConfiguration;
      }
      return {
        get: vi.fn(),
        update: vi.fn(),
      } as unknown as vscode.WorkspaceConfiguration;
    });

    await (handlers.get("redmyne.toggleApiLogging") as () => Promise<void>)();

    expect(configUpdate).toHaveBeenCalledWith(
      "logging.enabled",
      false,
      vscode.ConfigurationTarget.Global
    );
    expect(updateConfiguredContext).toHaveBeenCalledTimes(1);
  });

  it("enables API logging when currently disabled", async () => {
    const configUpdate = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation((section) => {
      if (section === "redmyne") {
        return {
          get: vi.fn((key: string) => (key === "logging.enabled" ? false : undefined)),
          update: configUpdate,
        } as unknown as vscode.WorkspaceConfiguration;
      }
      return {
        get: vi.fn(),
        update: vi.fn(),
      } as unknown as vscode.WorkspaceConfiguration;
    });

    await (handlers.get("redmyne.toggleApiLogging") as () => Promise<void>)();

    expect(configUpdate).toHaveBeenCalledWith(
      "logging.enabled",
      true,
      vscode.ConfigurationTarget.Global
    );
    expect(statusBarUtil.showStatusBarMessage).toHaveBeenCalledWith(
      "$(check) API logging enabled",
      2000
    );
  });

  it("wires representative view/filter/sort/output commands", async () => {
    handlers.get("redmyne.toggleTreeView")?.();
    handlers.get("redmyne.toggleListView")?.();
    handlers.get("redmyne.filterNone")?.();
    handlers.get("redmyne.timeFilterAll")?.();
    handlers.get("redmyne.issueSortSubject")?.();
    handlers.get("redmyne.timeSortUser")?.();
    handlers.get("redmyne.showApiOutput")?.();
    handlers.get("redmyne.clearApiOutput")?.();
    handlers.get("redmyne.openTimeEntriesSettings")?.();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "redmyne:treeViewStyle",
      ProjectsViewStyle.LIST
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "redmyne:treeViewStyle",
      ProjectsViewStyle.TREE
    );
    expect(projectsTree.setViewStyle).toHaveBeenCalledWith(ProjectsViewStyle.LIST);
    expect(projectsTree.setViewStyle).toHaveBeenCalledWith(ProjectsViewStyle.TREE);
    expect(projectsTree.setFilter).toHaveBeenCalledWith({
      assignee: "any",
      status: "any",
      showEmptyProjects: true,
    });
    expect(timeEntriesTree.setShowAllUsers).toHaveBeenCalledWith(true);
    expect(projectsTree.setSort).toHaveBeenCalledWith("subject");
    expect(timeEntriesTree.setSort).toHaveBeenCalledWith("user");
    expect(outputChannel.show).toHaveBeenCalledTimes(1);
    expect(outputChannel.clear).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.openSettings",
      "redmyne.workingHours.weeklySchedule"
    );
  });

  it("applies all issue filters with expected payloads", () => {
    handlers.get("redmyne.filterMyOpen")?.();
    handlers.get("redmyne.filterAllOpen")?.();
    handlers.get("redmyne.filterMyClosed")?.();
    handlers.get("redmyne.filterAll")?.();
    handlers.get("redmyne.filterMyIssues")?.();

    expect(projectsTree.setFilter).toHaveBeenCalledWith({ assignee: "me", status: "open" });
    expect(projectsTree.setFilter).toHaveBeenCalledWith({ assignee: "any", status: "open" });
    expect(projectsTree.setFilter).toHaveBeenCalledWith({ assignee: "me", status: "closed" });
    expect(projectsTree.setFilter).toHaveBeenCalledWith({ assignee: "any", status: "any" });
    expect(projectsTree.setFilter).toHaveBeenCalledWith({ assignee: "me", status: "any" });
  });

  it("applies all sort commands for issues and time entries", () => {
    handlers.get("redmyne.issueSortId")?.();
    handlers.get("redmyne.issueSortAssignee")?.();
    handlers.get("redmyne.timeSortId")?.();
    handlers.get("redmyne.timeSortSubject")?.();
    handlers.get("redmyne.timeSortComment")?.();
    handlers.get("redmyne.timeSortUser")?.();
    handlers.get("redmyne.timeFilterMy")?.();

    expect(projectsTree.setSort).toHaveBeenCalledWith("id");
    expect(projectsTree.setSort).toHaveBeenCalledWith("assignee");
    expect(timeEntriesTree.setSort).toHaveBeenCalledWith("id");
    expect(timeEntriesTree.setSort).toHaveBeenCalledWith("subject");
    expect(timeEntriesTree.setSort).toHaveBeenCalledWith("comment");
    expect(timeEntriesTree.setSort).toHaveBeenCalledWith("user");
    expect(timeEntriesTree.setShowAllUsers).toHaveBeenCalledWith(false);
  });
});
