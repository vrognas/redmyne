import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

const hoisted = vi.hoisted(() => {
  const projectsTree = {
    server: undefined,
    setServer: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
    clearProjects: vi.fn(),
    fetchIssuesIfNeeded: vi.fn().mockResolvedValue([]),
    getDependencyIssues: vi.fn().mockReturnValue([]),
    getFlexibilityCache: vi.fn().mockReturnValue(new Map()),
    getProjects: vi.fn().mockReturnValue([]),
    getFilter: vi.fn().mockReturnValue({}),
    setFilter: vi.fn(),
    onDidChangeTreeData: vi.fn(),
    getAssignedIssues: vi.fn().mockReturnValue([]),
    getProjectNodeById: vi.fn(),
    setTreeView: vi.fn(),
  };
  const myTimeEntriesTree = {
    server: undefined,
    setServer: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
    setTreeView: vi.fn(),
    setMonthlySchedules: vi.fn(),
    setDraftQueue: vi.fn(),
  };
  const kanbanTreeView = {
    dispose: vi.fn(),
  };
  const kanbanTreeProvider = {
    dispose: vi.fn(),
  };
  const kanbanController = {
    dispose: vi.fn(),
  };
  const kanbanStatusBar = {
    dispose: vi.fn(),
  };
  const workloadStatusBar = {
    update: vi.fn(),
    reinitialize: vi.fn(),
    dispose: vi.fn(),
  };
  let workloadStatusBarOptions:
    | {
        fetchIssuesIfNeeded: () => Promise<unknown>;
        getMonthlySchedules: () => unknown;
        getUserFte: () => unknown;
      }
    | undefined;
  const draftQueue = {
    dispose: vi.fn(),
  };
  const draftModeManager = {
    initialize: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    setQueue: vi.fn(),
  };
  let draftModeCtorOptions:
    | {
        setContext: (key: string, value: unknown) => Promise<unknown>;
      }
    | undefined;
  const draftModeStatusBar = {
    dispose: vi.fn(),
  };
  const outputChannel = {
    dispose: vi.fn(),
  };
  const projectsTreeView = {
    onDidExpandElement: vi.fn(),
    onDidCollapseElement: vi.fn(),
    dispose: vi.fn(),
  };
  const myTimeEntriesTreeView = {
    dispose: vi.fn(),
  };
  const registerCommandCallbacks: Record<string, (...args: unknown[]) => unknown> = {};
  const serializers: Record<string, { deserializeWebviewPanel: (panel: vscode.WebviewPanel) => Promise<void> }> = {};
  const setImmediateSpy = vi.fn((fn: () => void) => fn());
  let configChangeHandler: ((event: vscode.ConfigurationChangeEvent) => void) | undefined;
  let secretChangedHandler: (() => void) | undefined;
  const configValues: Record<string, unknown> = {};

  return {
    projectsTree,
    myTimeEntriesTree,
    kanbanTreeView,
    kanbanTreeProvider,
    kanbanController,
    kanbanStatusBar,
    workloadStatusBar,
    draftQueue,
    draftModeManager,
    draftModeStatusBar,
    outputChannel,
    projectsTreeView,
    myTimeEntriesTreeView,
    registerCommandCallbacks,
    serializers,
    setImmediateSpy,
    configChangeHandler: () => configChangeHandler,
    setConfigChangeHandler: (handler: (event: vscode.ConfigurationChangeEvent) => void) => {
      configChangeHandler = handler;
    },
    secretChangedHandler: () => secretChangedHandler,
    setSecretChangedHandler: (handler: () => void) => {
      secretChangedHandler = handler;
    },
    configValues,
    runMigration: vi.fn(),
    initRecentIssues: vi.fn(),
    updateClipboardContext: vi.fn(),
    loadMonthlySchedules: vi.fn().mockReturnValue({}),
    disposeStatusBar: vi.fn(),
    setApiKey: vi.fn().mockResolvedValue(undefined),
    registerTimeEntryCommands: vi.fn(),
    registerMonthlyScheduleCommands: vi.fn(),
    registerTimeSheetCommands: vi.fn(),
    registerInternalEstimateCommands: vi.fn(),
    registerIssueContextCommands: vi.fn().mockReturnValue([]),
    registerNavigationClipboardCommands: vi.fn().mockReturnValue([]),
    registerQuickIssueCommands: vi.fn(),
    registerConfigureCommand: vi.fn(),
    registerViewCommands: vi.fn(),
    registerContextProxyCommands: vi.fn().mockReturnValue([]),
    registerCreateTestIssuesCommand: vi.fn(),
    registerDraftModeCommands: vi.fn().mockReturnValue([]),
    createConfiguredContextUpdater: vi.fn(),
    createConfiguredCommandRegistrar: vi.fn(),
    setupKanban: vi.fn(),
    secretChangedListener: vi.fn(),
    createServerInstances: [] as Array<{ dispose: () => void }>,
    draftModeCtorOptions: () => draftModeCtorOptions,
    setDraftModeCtorOptions: (
      options: {
        setContext: (key: string, value: unknown) => Promise<unknown>;
      } | undefined
    ) => {
      draftModeCtorOptions = options;
    },
    workloadStatusBarOptions: () => workloadStatusBarOptions,
    setWorkloadStatusBarOptions: (
      options:
        | {
            fetchIssuesIfNeeded: () => Promise<unknown>;
            getMonthlySchedules: () => unknown;
            getUserFte: () => unknown;
          }
        | undefined
    ) => {
      workloadStatusBarOptions = options;
    },
  };
});

vi.mock("../../../src/redmine/redmine-server", () => ({
  RedmineServer: class {
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
    }
  },
}));

vi.mock("../../../src/redmine/logging-redmine-server", () => ({
  LoggingRedmineServer: class {
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
      hoisted.createServerInstances.push(this as unknown as { dispose: () => void });
    }
    dispose = vi.fn();
  },
}));

vi.mock("../../../src/redmine/redmine-project", () => ({
  RedmineProject: class {},
}));

vi.mock("../../../src/commands/open-actions-for-issue", () => ({
  default: vi.fn(),
}));
vi.mock("../../../src/commands/open-actions-for-issue-under-cursor", () => ({
  default: vi.fn(),
}));
vi.mock("../../../src/commands/list-open-issues-assigned-to-me", () => ({
  default: vi.fn(),
}));
vi.mock("../../../src/commands/new-issue", () => ({
  default: vi.fn(),
}));

vi.mock("../../../src/trees/projects-tree", () => ({
  ProjectsViewStyle: { TREE: "TREE" },
  ProjectsTree: class {
    server = hoisted.projectsTree.server;
    setServer = hoisted.projectsTree.setServer;
    refresh = hoisted.projectsTree.refresh;
    dispose = hoisted.projectsTree.dispose;
    clearProjects = hoisted.projectsTree.clearProjects;
    fetchIssuesIfNeeded = hoisted.projectsTree.fetchIssuesIfNeeded;
    getDependencyIssues = hoisted.projectsTree.getDependencyIssues;
    getFlexibilityCache = hoisted.projectsTree.getFlexibilityCache;
    getProjects = hoisted.projectsTree.getProjects;
    getFilter = hoisted.projectsTree.getFilter;
    setFilter = hoisted.projectsTree.setFilter;
    onDidChangeTreeData = hoisted.projectsTree.onDidChangeTreeData;
    getAssignedIssues = hoisted.projectsTree.getAssignedIssues;
    getProjectNodeById = hoisted.projectsTree.getProjectNodeById;
    setTreeView = hoisted.projectsTree.setTreeView;
    constructor() {}
  },
}));

vi.mock("../../../src/utilities/collapse-state", () => ({
  collapseState: {
    expand: vi.fn(),
    collapse: vi.fn(),
  },
}));

vi.mock("../../../src/trees/my-time-entries-tree", () => ({
  MyTimeEntriesTreeDataProvider: class {
    server = hoisted.myTimeEntriesTree.server;
    setServer = hoisted.myTimeEntriesTree.setServer;
    refresh = hoisted.myTimeEntriesTree.refresh;
    dispose = hoisted.myTimeEntriesTree.dispose;
    setTreeView = hoisted.myTimeEntriesTree.setTreeView;
    setMonthlySchedules = hoisted.myTimeEntriesTree.setMonthlySchedules;
    setDraftQueue = hoisted.myTimeEntriesTree.setDraftQueue;
  },
}));

vi.mock("../../../src/utilities/secret-manager", () => ({
  RedmineSecretManager: class {
    constructor() {}
    onSecretChanged = (listener: () => void) => {
      hoisted.secretChangedListener.mockImplementation(listener);
      hoisted.setSecretChangedHandler(listener);
      return { dispose: vi.fn() };
    };
  },
}));

vi.mock("../../../src/commands/set-api-key", () => ({
  setApiKey: hoisted.setApiKey,
}));

vi.mock("../../../src/utilities/monthly-schedule", () => ({
  loadMonthlySchedules: hoisted.loadMonthlySchedules,
}));

vi.mock("../../../src/utilities/status-bar", () => ({
  disposeStatusBar: hoisted.disposeStatusBar,
}));

vi.mock("../../../src/kanban/kanban-setup", () => ({
  setupKanban: hoisted.setupKanban,
}));

vi.mock("../../../src/commands/time-entry-commands", () => ({
  registerTimeEntryCommands: hoisted.registerTimeEntryCommands,
}));
vi.mock("../../../src/utilities/time-entry-clipboard", () => ({
  updateClipboardContext: hoisted.updateClipboardContext,
}));
vi.mock("../../../src/commands/monthly-schedule-commands", () => ({
  registerMonthlyScheduleCommands: hoisted.registerMonthlyScheduleCommands,
}));
vi.mock("../../../src/commands/timesheet-commands", () => ({
  registerTimeSheetCommands: hoisted.registerTimeSheetCommands,
}));
vi.mock("../../../src/commands/internal-estimate-commands", () => ({
  registerInternalEstimateCommands: hoisted.registerInternalEstimateCommands,
}));
vi.mock("../../../src/commands/issue-context-commands", () => ({
  registerIssueContextCommands: hoisted.registerIssueContextCommands,
}));
vi.mock("../../../src/commands/navigation-clipboard-commands", () => ({
  registerNavigationClipboardCommands: hoisted.registerNavigationClipboardCommands,
}));
vi.mock("../../../src/commands/quick-issue-commands", () => ({
  registerQuickIssueCommands: hoisted.registerQuickIssueCommands,
}));
vi.mock("../../../src/commands/configure-command", () => ({
  registerConfigureCommand: hoisted.registerConfigureCommand,
}));
vi.mock("../../../src/commands/view-commands", () => ({
  registerViewCommands: hoisted.registerViewCommands,
}));
vi.mock("../../../src/commands/context-proxy-commands", () => ({
  registerContextProxyCommands: hoisted.registerContextProxyCommands,
}));
vi.mock("../../../src/commands/create-test-issues", () => ({
  registerCreateTestIssuesCommand: hoisted.registerCreateTestIssuesCommand,
}));

vi.mock("../../../src/commands/configured-command-registrar", () => ({
  createConfiguredCommandRegistrar: hoisted.createConfiguredCommandRegistrar,
}));

vi.mock("../../../src/webviews/gantt-panel", () => ({
  GanttPanel: {
    currentPanel: undefined,
    initialize: vi.fn(),
    createOrShow: vi.fn().mockReturnValue({
      updateIssues: vi.fn().mockResolvedValue(undefined),
      setFilterChangeCallback: vi.fn(),
      showProject: vi.fn(),
      scrollToIssue: vi.fn(),
    }),
    restore: vi.fn().mockReturnValue({
      updateIssues: vi.fn().mockResolvedValue(undefined),
      setFilterChangeCallback: vi.fn(),
    }),
  },
}));

vi.mock("../../../src/status-bars/workload-status-bar", () => ({
  WorkloadStatusBar: class {
    constructor(options: {
      fetchIssuesIfNeeded: () => Promise<unknown>;
      getMonthlySchedules: () => unknown;
      getUserFte: () => unknown;
    }) {
      hoisted.setWorkloadStatusBarOptions(options);
    }
    update = hoisted.workloadStatusBar.update;
    reinitialize = hoisted.workloadStatusBar.reinitialize;
    dispose = hoisted.workloadStatusBar.dispose;
  },
}));

vi.mock("../../../src/utilities/auto-update-tracker", () => ({
  autoUpdateTracker: {},
}));
vi.mock("../../../src/utilities/adhoc-tracker", () => ({
  adHocTracker: {},
}));

vi.mock("../../../src/utilities/debounce", () => ({
  debounce: (_delay: number, fn: (...args: unknown[]) => unknown) => {
    const wrapped = ((...args: unknown[]) => fn(...args)) as ((...args: unknown[]) => unknown) & {
      cancel: () => void;
    };
    wrapped.cancel = vi.fn();
    return wrapped;
  },
}));

vi.mock("../../../src/utilities/migration", () => ({
  runMigration: hoisted.runMigration,
}));
vi.mock("../../../src/utilities/recent-issues", () => ({
  initRecentIssues: hoisted.initRecentIssues,
}));
vi.mock("../../../src/utilities/configured-context-updater", () => ({
  createConfiguredContextUpdater: hoisted.createConfiguredContextUpdater,
}));

vi.mock("../../../src/draft-mode/draft-queue", () => ({
  DraftQueue: class {
    constructor() {
      return hoisted.draftQueue;
    }
  },
}));
vi.mock("../../../src/draft-mode/draft-mode-manager", () => ({
  DraftModeManager: class {
    constructor(options: {
      setContext: (key: string, value: unknown) => Promise<unknown>;
    }) {
      hoisted.setDraftModeCtorOptions(options);
      return hoisted.draftModeManager;
    }
  },
}));
vi.mock("../../../src/draft-mode/draft-mode-status-bar", () => ({
  DraftModeStatusBar: class {
    constructor() {
      return hoisted.draftModeStatusBar;
    }
  },
}));
vi.mock("../../../src/commands/draft-mode-commands", () => ({
  registerDraftModeCommands: hoisted.registerDraftModeCommands,
}));
vi.mock("../../../src/draft-mode/draft-review-panel", () => ({
  DraftReviewPanel: {
    restore: vi.fn(),
    createOrShow: vi.fn(),
  },
}));

import { activate, deactivate } from "../../../src/extension";
import { collapseState } from "../../../src/utilities/collapse-state";
import { GanttPanel } from "../../../src/webviews/gantt-panel";
import * as ganttCommandModule from "../../../src/commands/gantt-commands";

function createContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    globalState: {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update: vi.fn().mockResolvedValue(undefined),
    },
    extensionUri: vscode.Uri.parse("file:///ext"),
    globalStorageUri: vscode.Uri.parse("file:///storage"),
  } as unknown as vscode.ExtensionContext;
}

describe("extension lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    hoisted.createServerInstances.length = 0;
    for (const key of Object.keys(hoisted.registerCommandCallbacks)) {
      delete hoisted.registerCommandCallbacks[key];
    }
    for (const key of Object.keys(hoisted.serializers)) {
      delete hoisted.serializers[key];
    }

    hoisted.setupKanban.mockReturnValue({
      controller: hoisted.kanbanController,
      statusBar: hoisted.kanbanStatusBar,
      treeProvider: hoisted.kanbanTreeProvider,
      treeView: hoisted.kanbanTreeView,
    });
    hoisted.createConfiguredContextUpdater.mockImplementation(
      (options: {
        createServer: (opts: unknown) => unknown;
        setDraftModeServer?: (server: unknown) => void;
        setUserFte?: (fte: number) => void;
        updateWorkloadStatusBar?: () => void;
      }) =>
        vi.fn().mockImplementation(async () => {
          const server = options.createServer({
            address: "https://server.example",
            url: new URL("https://server.example"),
            apiKey: "k",
          });
          options.setDraftModeServer?.(server);
          options.setUserFte?.(0.8);
          options.updateWorkloadStatusBar?.();
        })
    );
    hoisted.createConfiguredCommandRegistrar.mockImplementation(
      (options: {
        createServer: (opts: unknown) => unknown;
        bucket: { servers: unknown[] };
      }) => {
        const server = options.createServer({
          address: "https://bucket.example",
          url: new URL("https://bucket.example"),
          apiKey: "k2",
        });
        options.bucket.servers.push(server);
        return vi.fn((_name: string) => undefined);
      }
    );

    (vscode.window as unknown as { createOutputChannel: ReturnType<typeof vi.fn> })
      .createOutputChannel = vi
      .fn()
      .mockReturnValue(hoisted.outputChannel as unknown as vscode.OutputChannel);
    vi.spyOn(vscode.window, "createTreeView")
      .mockReturnValueOnce(
        hoisted.projectsTreeView as unknown as vscode.TreeView<unknown>
      )
      .mockReturnValueOnce(
        hoisted.myTimeEntriesTreeView as unknown as vscode.TreeView<unknown>
      );
    (
      vscode.window as unknown as {
        registerWebviewPanelSerializer: ReturnType<typeof vi.fn>;
      }
    ).registerWebviewPanelSerializer = vi.fn(
      (viewType: string, serializer: unknown) => {
        hoisted.serializers[viewType] = serializer as {
          deserializeWebviewPanel: (panel: vscode.WebviewPanel) => Promise<void>;
        };
        return { dispose: vi.fn() } as unknown as vscode.Disposable;
      }
    );
    vi.spyOn(vscode.workspace, "onDidChangeConfiguration").mockImplementation(
      (handler: (event: vscode.ConfigurationChangeEvent) => void) => {
        hoisted.setConfigChangeHandler(handler);
        return { dispose: vi.fn() } as unknown as vscode.Disposable;
      }
    );
    vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(
      () =>
        ({
          get: vi.fn((key: string, fallback?: unknown) =>
            key in hoisted.configValues ? hoisted.configValues[key] : fallback
          ),
          update: vi.fn(),
        }) as unknown as vscode.WorkspaceConfiguration
    );

    vi.spyOn(vscode.commands, "registerCommand").mockImplementation(
      (name: string, callback: (...args: unknown[]) => unknown) => {
        hoisted.registerCommandCallbacks[name] = callback;
        return { dispose: vi.fn() } as unknown as vscode.Disposable;
      }
    );
    vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    (
      vscode.Uri as unknown as {
        joinPath: (...parts: unknown[]) => vscode.Uri;
      }
    ).joinPath = (...parts: unknown[]) =>
      vscode.Uri.parse(parts.map((part) => String(part)).join("/"));

    vi.stubGlobal("setImmediate", hoisted.setImmediateSpy);
  });

  it("activates extension and registers integrations", async () => {
    const context = createContext();

    await activate(context);

    expect(hoisted.runMigration).toHaveBeenCalledWith(context);
    expect(hoisted.initRecentIssues).toHaveBeenCalledWith(context);
    expect(hoisted.updateClipboardContext).toHaveBeenCalled();
    expect(hoisted.draftModeManager.initialize).toHaveBeenCalled();
    expect(hoisted.draftModeManager.disable).toHaveBeenCalled();
    expect(hoisted.draftModeManager.setQueue).toHaveBeenCalledWith(
      hoisted.draftQueue
    );
    expect(hoisted.myTimeEntriesTree.setDraftQueue).toHaveBeenCalledWith(
      hoisted.draftQueue
    );
    expect(hoisted.registerTimeEntryCommands).toHaveBeenCalled();
    expect(hoisted.registerMonthlyScheduleCommands).toHaveBeenCalled();
    expect(hoisted.registerTimeSheetCommands).toHaveBeenCalled();
    expect(hoisted.registerInternalEstimateCommands).toHaveBeenCalledWith(
      context
    );
    expect(hoisted.registerConfigureCommand).toHaveBeenCalled();
    expect(hoisted.registerQuickIssueCommands).toHaveBeenCalled();
    expect(hoisted.registerCreateTestIssuesCommand).toHaveBeenCalled();
    expect(hoisted.registerViewCommands).toHaveBeenCalled();
    expect(hoisted.setImmediateSpy).toHaveBeenCalled();
    expect(hoisted.workloadStatusBar.update).toHaveBeenCalled();

    expect(hoisted.serializers.redmyneGantt).toBeDefined();
    expect(hoisted.serializers.redmyneDraftReview).toBeDefined();
    expect(hoisted.registerCommandCallbacks["redmyne.setApiKey"]).toBeDefined();
  });

  it("supports serializer restore, setApiKey command, and deactivation cleanup", async () => {
    const context = createContext();

    await activate(context);

    const setApiKeyCmd = hoisted.registerCommandCallbacks["redmyne.setApiKey"];
    expect(setApiKeyCmd).toBeDefined();
    await setApiKeyCmd?.();
    expect(hoisted.setApiKey).toHaveBeenCalledWith(context);

    const ganttSerializer = hoisted.serializers.redmyneGantt;
    await ganttSerializer.deserializeWebviewPanel({
      webview: {},
    } as unknown as vscode.WebviewPanel);

    deactivate();

    expect(hoisted.projectsTree.dispose).toHaveBeenCalled();
    expect(hoisted.myTimeEntriesTree.dispose).toHaveBeenCalled();
    expect(hoisted.projectsTreeView.dispose).toHaveBeenCalled();
    expect(hoisted.myTimeEntriesTreeView.dispose).toHaveBeenCalled();
    expect(hoisted.kanbanTreeView.dispose).toHaveBeenCalled();
    expect(hoisted.kanbanTreeProvider.dispose).toHaveBeenCalled();
    expect(hoisted.workloadStatusBar.dispose).toHaveBeenCalled();
    expect(hoisted.disposeStatusBar).toHaveBeenCalled();
    expect(hoisted.draftModeStatusBar.dispose).toHaveBeenCalled();
  });

  it("reacts to secret/config changes and disposes logging servers", async () => {
    hoisted.configValues["logging.enabled"] = true;
    const context = createContext();

    await activate(context);

    const secretHandler = hoisted.secretChangedHandler();
    await secretHandler?.();

    const configHandler = hoisted.configChangeHandler();
    configHandler?.({
      affectsConfiguration: (key: string) => key === "redmyne",
    } as vscode.ConfigurationChangeEvent);

    deactivate();

    expect(hoisted.createServerInstances.length).toBeGreaterThan(0);
    const disposeCalls = hoisted.createServerInstances.map(
      (instance) =>
        (instance as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose
    );
    expect(disposeCalls.some((fn) => fn.mock.calls.length > 0)).toBe(true);
  });

  it("handles collapse-sync callbacks and config branch events", async () => {
    const context = createContext();
    await activate(context);

    const expandHandler = hoisted.projectsTreeView.onDidExpandElement.mock.calls[0]?.[0] as
      | ((e: { element: unknown }) => void)
      | undefined;
    const collapseHandler = hoisted.projectsTreeView.onDidCollapseElement.mock.calls[0]?.[0] as
      | ((e: { element: unknown }) => void)
      | undefined;

    expect(expandHandler).toBeDefined();
    expect(collapseHandler).toBeDefined();

    expandHandler?.({ element: { project: { id: 77 } } });
    expandHandler?.({ element: { id: 88, subject: "Task" } });
    expandHandler?.({ element: null });
    collapseHandler?.({ element: { project: { id: 77 } } });
    collapseHandler?.({ element: { id: 88, subject: "Task" } });
    collapseHandler?.({ element: { label: "ignored" } });

    expect(collapseState.expand).toHaveBeenCalledWith("project-77");
    expect(collapseState.expand).toHaveBeenCalledWith("issue-88");
    expect(collapseState.collapse).toHaveBeenCalledWith("project-77");
    expect(collapseState.collapse).toHaveBeenCalledWith("issue-88");

    const updateConfiguredContext = hoisted.createConfiguredContextUpdater.mock.results[0]
      ?.value as ReturnType<typeof vi.fn>;
    const baseline = updateConfiguredContext.mock.calls.length;

    const configHandler = hoisted.configChangeHandler();
    configHandler?.({
      affectsConfiguration: (key: string) => key === "redmyne" || key === "redmyne.statusBar",
    } as vscode.ConfigurationChangeEvent);
    configHandler?.({
      affectsConfiguration: (key: string) => key === "redmyne" || key === "redmyne.workingHours",
    } as vscode.ConfigurationChangeEvent);
    configHandler?.({
      affectsConfiguration: (key: string) => key === "redmyne",
    } as vscode.ConfigurationChangeEvent);
    configHandler?.({
      affectsConfiguration: () => false,
    } as vscode.ConfigurationChangeEvent);

    expect(hoisted.workloadStatusBar.reinitialize).toHaveBeenCalled();
    expect(hoisted.workloadStatusBar.update).toHaveBeenCalled();
    expect(updateConfiguredContext.mock.calls.length).toBeGreaterThan(baseline);
  });

  it("skips gantt serializer update when no issues", async () => {
    const context = createContext();
    const updateIssues = vi.fn().mockResolvedValue(undefined);
    const setFilterChangeCallback = vi.fn();

    vi.mocked(GanttPanel.restore).mockReturnValue({
      updateIssues,
      setFilterChangeCallback,
    } as unknown as ReturnType<typeof GanttPanel.restore>);
    hoisted.projectsTree.fetchIssuesIfNeeded.mockResolvedValue([]);

    await activate(context);
    await hoisted.serializers.redmyneGantt.deserializeWebviewPanel({
      webview: {},
    } as unknown as vscode.WebviewPanel);

    expect(updateIssues).not.toHaveBeenCalled();
    expect(setFilterChangeCallback).not.toHaveBeenCalled();
  });

  it("executes callback dependencies passed to command registrars", async () => {
    const context = createContext();
    hoisted.configValues["logging.enabled"] = true;
    const ganttSpy = vi.spyOn(ganttCommandModule, "registerGanttCommands");
    await activate(context);

    await hoisted.draftModeCtorOptions()?.setContext("redmyne:draftMode", true);

    const kanbanArgs = hoisted.setupKanban.mock.calls[0]?.[0] as {
      refreshAfterTimeLog: () => void;
      getServer: () => unknown;
    };
    kanbanArgs.getServer();
    kanbanArgs.refreshAfterTimeLog();

    const timeEntryArgs = hoisted.registerTimeEntryCommands.mock.calls[0]?.[1] as {
      refreshTree: () => void;
      getMonthlySchedules: () => unknown;
      getServer: () => unknown;
    };
    timeEntryArgs.getServer();
    timeEntryArgs.getMonthlySchedules();
    timeEntryArgs.refreshTree();

    const monthlyArgs = hoisted.registerMonthlyScheduleCommands.mock.calls[0]?.[1] as {
      getOverrides: () => unknown;
      setOverrides: (value: unknown) => void;
      refreshTree: () => void;
      setTreeSchedules: (value: unknown) => void;
    };
    monthlyArgs.getOverrides();
    monthlyArgs.setOverrides({ february: { "2026-02-07": 0 } });
    monthlyArgs.refreshTree();
    monthlyArgs.setTreeSchedules({ march: { "2026-03-01": 8 } });

    const ganttArgs = ganttSpy.mock.calls[0]?.[1] as {
      getServer: () => unknown;
      fetchIssuesIfNeeded: () => Promise<unknown>;
      getDependencyIssues: () => unknown;
      getFlexibilityCache: () => unknown;
      getProjects: () => unknown;
      clearProjects: () => void;
      getFilter: () => unknown;
      setFilter: (filter: unknown) => void;
      getDraftModeManager: () => unknown;
    };
    ganttArgs.getServer();
    await ganttArgs.fetchIssuesIfNeeded();
    ganttArgs.getDependencyIssues();
    ganttArgs.getFlexibilityCache();
    ganttArgs.getProjects();
    ganttArgs.clearProjects();
    ganttArgs.getFilter();
    ganttArgs.setFilter({ assignee: "me" });
    ganttArgs.getDraftModeManager();

    const timesheetArgs = hoisted.registerTimeSheetCommands.mock.calls[0]?.[1] as {
      getServer: () => unknown;
      getDraftQueue: () => unknown;
      getDraftModeManager: () => unknown;
      getCachedIssues: () => unknown;
    };
    timesheetArgs.getServer();
    timesheetArgs.getDraftQueue();
    timesheetArgs.getDraftModeManager();
    timesheetArgs.getCachedIssues();

    const issueContextArgs = hoisted.registerIssueContextCommands.mock.calls[0]?.[0] as {
      refreshProjectsTree: () => void;
      refreshTimeEntries: () => void;
      getProjectNodeById: (id: number) => unknown;
      getProjectsTreeView: () => unknown;
      getProjectsServer: () => unknown;
      getTimeEntriesServer: () => unknown;
      getAssignedIssues: () => unknown;
      getDependencyIssues: () => unknown;
    };
    issueContextArgs.getProjectsServer();
    issueContextArgs.getTimeEntriesServer();
    issueContextArgs.getAssignedIssues();
    issueContextArgs.getDependencyIssues();
    issueContextArgs.getProjectNodeById(99);
    issueContextArgs.getProjectsTreeView();
    issueContextArgs.refreshProjectsTree();
    issueContextArgs.refreshTimeEntries();

    const viewArgs = hoisted.registerViewCommands.mock.calls[0]?.[1] as {
      updateConfiguredContext: () => Promise<void>;
    };
    await viewArgs.updateConfiguredContext();

    const quickIssueArgs = hoisted.registerQuickIssueCommands.mock.calls[0]?.[0] as {
      getWorkloadStatusBar: () => unknown;
    };
    quickIssueArgs.getWorkloadStatusBar();

    const draftArgs = hoisted.registerDraftModeCommands.mock.calls[0]?.[0] as {
      refreshTrees: () => void;
      showReviewPanel: () => void;
      getServer: () => unknown;
    };
    draftArgs.getServer();
    draftArgs.refreshTrees();
    draftArgs.showReviewPanel();

    const createTestArgs = hoisted.registerCreateTestIssuesCommand.mock.calls[0]?.[1] as {
      refreshProjects: () => void;
      getServer: () => unknown;
    };
    createTestArgs.getServer();
    createTestArgs.refreshProjects();

    const configuredRegistrarArgs = hoisted.createConfiguredCommandRegistrar.mock.calls[0]?.[0] as {
      disposeServer: (server: unknown) => void;
    };
    configuredRegistrarArgs.disposeServer(hoisted.createServerInstances[0]);

    const treeChangeHandler = hoisted.projectsTree.onDidChangeTreeData.mock.calls[0]?.[0] as
      | (() => void)
      | undefined;
    treeChangeHandler?.();

    hoisted.projectsTree.fetchIssuesIfNeeded.mockResolvedValueOnce([{ id: 1 }]);
    await hoisted.serializers.redmyneGantt.deserializeWebviewPanel({
      webview: {},
    } as unknown as vscode.WebviewPanel);
    const restoreResult = vi.mocked(GanttPanel.restore).mock.results[0]?.value as
      | {
          updateIssues: ReturnType<typeof vi.fn>;
        }
      | undefined;
    const updateIssuesLastArg = restoreResult?.updateIssues.mock.calls[0]?.[6] as
      | (() => unknown)
      | undefined;
    updateIssuesLastArg?.();
    await hoisted.serializers.redmyneDraftReview.deserializeWebviewPanel({
      webview: {},
    } as unknown as vscode.WebviewPanel);

    await hoisted.workloadStatusBarOptions()?.fetchIssuesIfNeeded();
    hoisted.workloadStatusBarOptions()?.getMonthlySchedules();
    hoisted.workloadStatusBarOptions()?.getUserFte();

    expect(hoisted.projectsTree.clearProjects).toHaveBeenCalled();
    expect(hoisted.projectsTree.refresh).toHaveBeenCalled();
    expect(hoisted.projectsTree.setFilter).toHaveBeenCalledWith({ assignee: "me" });
    expect(hoisted.myTimeEntriesTree.refresh).toHaveBeenCalled();
    expect(hoisted.workloadStatusBar.update).toHaveBeenCalled();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.refreshTimesheet");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "redmyne:draftMode",
      true
    );
  });
});
