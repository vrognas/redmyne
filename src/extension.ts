import * as vscode from "vscode";
import { redmyneConfig } from "./utilities/redmyne-config";
import {
  RedmineServer,
  RedmineServerConnectionOptions,
} from "./redmine/redmine-server";
import type { IRedmineServer } from "./redmine/redmine-server-interface";
import { LoggingRedmineServer } from "./redmine/logging-redmine-server";
import { RedmineProject } from "./redmine/redmine-project";
import openActionsForIssue from "./commands/open-actions-for-issue";
import openActionsForIssueUnderCursor from "./commands/open-actions-for-issue-under-cursor";
import listOpenIssuesAssignedToMe from "./commands/list-open-issues-assigned-to-me";
import newIssue from "./commands/new-issue";
import { ProjectsTree, ProjectsViewStyle } from "./trees/projects-tree";
import { collapseState } from "./utilities/collapse-state";
import { MyTimeEntriesTreeDataProvider } from "./trees/my-time-entries-tree";
import { RedmineSecretManager } from "./utilities/secret-manager";
import { setApiKey } from "./commands/set-api-key";
import { MonthlyScheduleOverrides, loadMonthlySchedules } from "./utilities/monthly-schedule";
import { disposeStatusBar } from "./utilities/status-bar";
import { errorToString } from "./utilities/error-feedback";
import type { KanbanController } from "./kanban/kanban-controller";
import type { KanbanStatusBar } from "./kanban/kanban-status-bar";
import type { KanbanTreeProvider } from "./kanban/kanban-tree-provider";
import { setupKanban } from "./kanban/kanban-setup";
import { registerTimeEntryCommands, type SelectableNode } from "./commands/time-entry-commands";
import { updateClipboardContext, clearClipboard } from "./utilities/time-entry-clipboard";
import { registerMonthlyScheduleCommands } from "./commands/monthly-schedule-commands";
import { registerGanttCommands } from "./commands/gantt-commands";
import { registerTimeSheetCommands } from "./commands/timesheet-commands";
import { registerInternalEstimateCommands } from "./commands/internal-estimate-commands";
import { registerIssueContextCommands } from "./commands/issue-context-commands";
import { registerNavigationClipboardCommands } from "./commands/navigation-clipboard-commands";
import { registerQuickIssueCommands } from "./commands/quick-issue-commands";
import { createConfiguredCommandRegistrar } from "./commands/configured-command-registrar";
import { GanttPanel } from "./webviews/gantt-panel";
import { getWeeklySchedule } from "./utilities/flexibility-calculator";
import { registerConfigureCommand } from "./commands/configure-command";
import { registerViewCommands } from "./commands/view-commands";
import { registerContextProxyCommands } from "./commands/context-proxy-commands";
import { registerCreateTestIssuesCommand } from "./commands/create-test-issues";
import { WorkloadStatusBar } from "./status-bars/workload-status-bar";
import { debounce, DebouncedFunction } from "./utilities/debounce";
import { runMigration } from "./utilities/migration";
import { initRecentIssues } from "./utilities/recent-issues";
import { initAdHocTracker } from "./utilities/adhoc-tracker";
import { isClientStateOnlyConfigChange } from "./utilities/config-change";
import { createConfiguredContextUpdater } from "./utilities/configured-context-updater";
import { DraftQueue } from "./draft-mode/draft-queue";
import { DraftModeManager } from "./draft-mode/draft-mode-manager";
import type { DraftModeServer } from "./draft-mode/draft-mode-server";
import { DraftModeStatusBar } from "./draft-mode/draft-mode-status-bar";
import { registerDraftModeCommands } from "./commands/draft-mode-commands";
import { DraftReviewPanel } from "./draft-mode/draft-review-panel";

// Constants
const CONFIG_DEBOUNCE_MS = 300;
const SERVER_CACHE_SIZE = 3;

// Module-level cleanup resources
let cleanupResources: {
  projectsTree?: ProjectsTree;
  myTimeEntriesTree?: MyTimeEntriesTreeDataProvider;
  projectsTreeView?: vscode.TreeView<unknown>;
  myTimeEntriesTreeView?: vscode.TreeView<unknown>;
  kanbanTreeView?: vscode.TreeView<unknown>;
  workloadStatusBar?: WorkloadStatusBar;
  debouncedConfigChange?: DebouncedFunction<(event: vscode.ConfigurationChangeEvent) => void>;
  kanbanController?: KanbanController;
  kanbanStatusBar?: KanbanStatusBar;
  kanbanTreeProvider?: KanbanTreeProvider;
  bucket?: {
    servers: IRedmineServer[];
    projects: RedmineProject[];
  };
  userFte?: number;
  monthlySchedules?: MonthlyScheduleOverrides;
  draftQueue?: DraftQueue;
  draftModeManager?: DraftModeManager;
  draftModeStatusBar?: DraftModeStatusBar;
  draftModeServer?: DraftModeServer;
} = {};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Register the tree views FIRST — before the awaited migration and
  // draft-mode init below (which touch the keychain and filesystem) — so the
  // Issues / Time Entries panes show their own (empty, then skeleton) state
  // instead of VS Code's "no data provider registered" message at startup.
  // getChildren guards the unwired state (no server -> []), so this is safe.
  const projectsTree = new ProjectsTree(context.globalState);
  const myTimeEntriesTree = new MyTimeEntriesTreeDataProvider(context.globalState);
  cleanupResources.projectsTree = projectsTree;
  cleanupResources.myTimeEntriesTree = myTimeEntriesTree;
  cleanupResources.projectsTreeView = vscode.window.createTreeView("redmyne-explorer-projects", {
    treeDataProvider: projectsTree,
    showCollapseAll: true,
  });
  projectsTree.setTreeView(cleanupResources.projectsTreeView);
  cleanupResources.myTimeEntriesTreeView = vscode.window.createTreeView("redmyne-explorer-my-time-entries", {
    treeDataProvider: myTimeEntriesTree,
    showCollapseAll: true,
  });
  myTimeEntriesTree.setTreeView(cleanupResources.myTimeEntriesTreeView as vscode.TreeView<import("./trees/my-time-entries-tree").TimeEntryNode>);

  // Run migration from redmine.* to redmyne.* namespace (one-time on upgrade)
  await runMigration(context);

  // Initialize recent issues tracker
  initRecentIssues(context);

  // Initialize time entry clipboard context (for copy/paste)
  updateClipboardContext();

  // Initialize draft mode manager
  const draftModeManager = new DraftModeManager({
    globalState: context.globalState,
    setContext: (key, value) => vscode.commands.executeCommand("setContext", key, value),
  });
  cleanupResources.draftModeManager = draftModeManager;
  await draftModeManager.initialize();
  // Always start with draft mode OFF
  await draftModeManager.disable();

  // Initialize draft queue with file system persistence
  const draftQueue = new DraftQueue({
    storagePath: vscode.Uri.joinPath(context.globalStorageUri, "drafts.json"),
    fs: vscode.workspace.fs,
  });
  cleanupResources.draftQueue = draftQueue;

  // Link queue to manager so panels can access it via manager.queue
  draftModeManager.setQueue(draftQueue);

  // Create draft mode status bar
  const draftModeStatusBar = new DraftModeStatusBar(draftQueue, draftModeManager);
  cleanupResources.draftModeStatusBar = draftModeStatusBar;
  context.subscriptions.push(draftModeStatusBar);

  const bucket = {
    servers: [] as IRedmineServer[],
    projects: [] as RedmineProject[],
  };
  cleanupResources.bucket = bucket;

  // Load monthly schedule overrides
  cleanupResources.monthlySchedules = loadMonthlySchedules(context.globalState);

  const secretManager = new RedmineSecretManager(context);
  const outputChannel = vscode.window.createOutputChannel("Redmyne");

  context.subscriptions.push(outputChannel);

  const createServer = (
    options: RedmineServerConnectionOptions
  ): RedmineServer => {
    const loggingEnabled = redmyneConfig.loggingEnabled();
    const maxConcurrentRequests = redmyneConfig.maxConcurrentRequests();

    const serverOptions = { ...options, maxConcurrentRequests };

    if (loggingEnabled) {
      return new LoggingRedmineServer(serverOptions, outputChannel, {
        enabled: true,
      });
    }

    return new RedmineServer(serverOptions);
  };

  // Initialize GanttPanel with globalState for persistence
  GanttPanel.initialize(context.globalState);
  // Sync collapse state between Issues pane and Gantt
  const getCollapseKey = (element: unknown): string | null => {
    if (!element || typeof element !== "object") return null;
    // ProjectNode has 'project' property with 'id'
    if ("project" in element && element.project && typeof element.project === "object" && "id" in element.project) {
      return `project-${(element.project as { id: number }).id}`;
    }
    // Issue has 'id' and 'subject'
    if ("id" in element && "subject" in element) {
      return `issue-${(element as { id: number }).id}`;
    }
    return null;
  };

  cleanupResources.projectsTreeView.onDidExpandElement((e) => {
    const key = getCollapseKey(e.element);
    if (key) collapseState.expand(key);
  });
  cleanupResources.projectsTreeView.onDidCollapseElement((e) => {
    const key = getCollapseKey(e.element);
    if (key) collapseState.collapse(key);
  });

  myTimeEntriesTree.setMonthlySchedules(cleanupResources.monthlySchedules ?? {});
  myTimeEntriesTree.setDraftQueue(draftQueue);

  // Shared fan-out after a time-entry data change: refresh the time-entries
  // tree and the Gantt (time entries affect contribution data).
  const refreshTimeAndGantt = () => {
    myTimeEntriesTree.refresh();
    void vscode.commands.executeCommand("redmyne.refreshGanttData");
  };

  const { controller: kanbanController, statusBar: kanbanStatusBar, treeProvider: kanbanTreeProvider, treeView: kanbanTreeView } =
    setupKanban({
      context,
      getServer: () => projectsTree.server,
      refreshAfterTimeLog: refreshTimeAndGantt,
    });
  cleanupResources.kanbanController = kanbanController;
  cleanupResources.kanbanStatusBar = kanbanStatusBar;
  cleanupResources.kanbanTreeProvider = kanbanTreeProvider;
  cleanupResources.kanbanTreeView = kanbanTreeView;

  // Feed the Time Entries "now" row from the active Kanban timer. getActiveTimerInfo
  // is undefined when idle or on a keep-working break, and never double-counts a
  // just-finished unit — see KanbanController.getActiveTimerInfo.
  myTimeEntriesTree.setActiveTimer(() => kanbanController.getActiveTimerInfo());

  // Live "now" anchor across views. On an active-issue change (start/stop/switch/
  // break) pulse the Gantt bar (debounced — only on id-change, not per tick) and
  // refresh the Time Entries running row's presence.
  let lastActiveIssueId: number | null = null;
  let lastShownMinute = -1;
  context.subscriptions.push(
    kanbanController.onTasksChange(() => {
      const activeIssueId = kanbanController.getActiveTimerInfo()?.issueId ?? null;
      if (activeIssueId !== lastActiveIssueId) {
        lastActiveIssueId = activeIssueId;
        lastShownMinute = -1; // a new task's first minute boundary must refresh
        GanttPanel.currentPanel?.setActiveIssue(activeIssueId);
        myTimeEntriesTree.notifyNowChanged();
      }
    })
  );

  // Tick the running row's accrued time once per minute (the status bar keeps the
  // per-second view; a per-second tree refresh would be too heavy).
  context.subscriptions.push(
    kanbanController.onTimerTick(() => {
      const info = kanbanController.getActiveTimerInfo();
      const minute = info ? Math.floor(info.accruedSeconds / 60) : -1;
      if (minute !== lastShownMinute) {
        lastShownMinute = minute;
        myTimeEntriesTree.refreshRunningRowTime();
      }
    })
  );

  // Register time entry commands
  registerTimeEntryCommands(context, {
    getServer: () => projectsTree.server,
    refreshTree: refreshTimeAndGantt,
    getMonthlySchedules: () => cleanupResources.monthlySchedules ?? {},
    getSelectedNode: () => myTimeEntriesTree.getSelectedNode() as SelectableNode | undefined,
    isDraftMode: () => draftModeManager.isEnabled,
  });

  // Register monthly schedule commands
  registerMonthlyScheduleCommands(context, {
    getOverrides: () => cleanupResources.monthlySchedules ?? {},
    setOverrides: (overrides) => { cleanupResources.monthlySchedules = overrides; },
    refreshTree: () => myTimeEntriesTree.refresh(),
    setTreeSchedules: (overrides) => myTimeEntriesTree.setMonthlySchedules(overrides),
  });

  // Register gantt commands
  registerGanttCommands(context, {
    getServer: () => projectsTree.server,
    fetchIssuesIfNeeded: () => projectsTree.fetchIssuesIfNeeded(),
    getDependencyIssues: () => projectsTree.getDependencyIssues(),
    getFlexibilityCache: () => projectsTree.getFlexibilityCache(),
    getProjects: () => projectsTree.getProjects(),
    clearProjects: () => projectsTree.clearProjects(),
    getFilter: () => projectsTree.getFilter(),
    setFilter: (filter) => projectsTree.setFilter(filter),
    getDraftModeManager: () => draftModeManager,
  });

  // Register timesheet commands
  context.subscriptions.push(
    ...registerTimeSheetCommands(context, {
      getServer: () => projectsTree.server,
      getDraftQueue: () => draftQueue,
      getDraftModeManager: () => draftModeManager,
      getCachedIssues: () => projectsTree.getAssignedIssues(),
    })
  );

  // Register internal estimate commands
  registerInternalEstimateCommands(context);

  // Register Gantt panel serializer for window reload persistence
  vscode.window.registerWebviewPanelSerializer("redmyneGantt", {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
      // Restore panel with loading skeleton (use getter function for late binding)
      const ganttPanel = GanttPanel.restore(panel, context.extensionUri, () => projectsTree.server, () => draftModeManager);
      // Always wire the filter callback so webview filter changes reach the tree,
      // even when the fetch yields zero issues.
      ganttPanel.setFilterChangeCallback((filter) => projectsTree.setFilter(filter));
      try {
        // Fetch and populate data. Pass the (possibly empty) array so the panel
        // renders its empty state instead of being stuck on the loading skeleton.
        const issues = await projectsTree.fetchIssuesIfNeeded();
        const schedule = getWeeklySchedule();
        await ganttPanel.updateIssues(
          issues,
          projectsTree.getFlexibilityCache(),
          projectsTree.getProjects(),
          schedule,
          projectsTree.getFilter(),
          projectsTree.getDependencyIssues(),
          () => projectsTree.server
        );
      } catch (error) {
        // Don't let a fetch/render rejection escape deserializeWebviewPanel and
        // leave the panel silently stuck on the skeleton.
        void vscode.window.showErrorMessage(errorToString(error));
      }
    },
  });

  // Register Draft Review panel serializer for window reload persistence
  vscode.window.registerWebviewPanelSerializer("redmyneDraftReview", {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
      DraftReviewPanel.restore(panel, draftQueue, context.extensionUri);
    },
  });

  // Initialize workload status bar
  cleanupResources.workloadStatusBar = new WorkloadStatusBar({
    fetchIssuesIfNeeded: async () => { await projectsTree.fetchIssuesIfNeeded(); return projectsTree.getAssignedIssues(); },
    getMonthlySchedules: () => cleanupResources.monthlySchedules,
    getUserFte: () => cleanupResources.userFte,
  });
  // Defer initial update to avoid blocking activation
  setImmediate(() => { void cleanupResources.workloadStatusBar?.update(); });

  // Update on tree refresh (workload bar + Gantt if open)
  projectsTree.onDidChangeTreeData(() => {
    void cleanupResources.workloadStatusBar?.update();
    // Refresh Gantt if open
    void vscode.commands.executeCommand("redmyne.refreshGanttData");
  });

  // Listen for secret changes
  context.subscriptions.push(
    secretManager.onSecretChanged(() => {
      void updateConfiguredContext();
    })
  );

  // Check if configured and update context
  const updateConfiguredContext = createConfiguredContextUpdater({
    secretManager,
    createServer,
    draftQueue,
    draftModeManager,
    projectsTree,
    timeEntriesTree: myTimeEntriesTree,
    setDraftModeServer: (server) => {
      cleanupResources.draftModeServer = server;
    },
    setUserFte: (fte) => {
      cleanupResources.userFte = fte;
    },
    updateWorkloadStatusBar: () => { void cleanupResources.workloadStatusBar?.update(); },
  });

  // Initial check
  void updateConfiguredContext();

  // Listen for configuration changes (debounced)
  cleanupResources.debouncedConfigChange = debounce(
    CONFIG_DEBOUNCE_MS,
    (event: vscode.ConfigurationChangeEvent) => {
      void (async () => {
        // Drop the time-entry clipboard when the user switches servers — its
        // issue_id values are scoped to the previous Redmine instance and
        // would either 404 or hit unrelated issues on the new one.
        if (event.affectsConfiguration("redmyne.serverUrl")) {
          clearClipboard();
        }
        // Rebuild the server context for server-related config changes only.
        // Skip UI-only configs (statusBar, workingHours) and the client-side
        // id-set toggles (ad-hoc/auto-update/precedence) — the latter write
        // state only and self-refresh, so rebuilding the server (wiping every
        // cache + reloading all issues) on each toggle is pure waste.
        if (
          !isClientStateOnlyConfigChange(event) &&
          !event.affectsConfiguration("redmyne.statusBar") &&
          !event.affectsConfiguration("redmyne.workingHours")
        ) {
          await updateConfiguredContext();
        }
        // Re-initialize status bar on config change
        if (event.affectsConfiguration("redmyne.statusBar")) {
          cleanupResources.workloadStatusBar?.reinitialize();
          void cleanupResources.workloadStatusBar?.update();
        }
        // Update status bar on schedule change
        if (event.affectsConfiguration("redmyne.workingHours")) {
          void cleanupResources.workloadStatusBar?.update();
        }
      })();
    }
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("redmyne")) return;
      cleanupResources.debouncedConfigChange?.(event);
    })
  );

  initAdHocTracker(context);

  // Register configure command
  registerConfigureCommand(context, {
    secretManager,
    updateConfiguredContext,
  });

  // Register set API key command
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.setApiKey", async () => {
      await setApiKey(context);
      await updateConfiguredContext();
    })
  );

  vscode.commands.executeCommand(
    "setContext",
    "redmyne:treeViewStyle",
    ProjectsViewStyle.TREE
  );

  const registerCommand = createConfiguredCommandRegistrar({
    context,
    secretManager,
    createServer,
    bucket,
    maxServerCacheSize: SERVER_CACHE_SIZE,
    disposeServer: (server) => {
      if (server instanceof LoggingRedmineServer) {
        server.dispose();
      }
    },
  });

  registerCommand("listOpenIssuesAssignedToMe", listOpenIssuesAssignedToMe);
  registerCommand("openActionsForIssue", openActionsForIssue);
  registerCommand(
    "openActionsForIssueUnderCursor",
    openActionsForIssueUnderCursor
  );
  registerCommand("newIssue", newIssue);
  // addTimeEntryForDate moved to time-entry-commands.ts
  registerQuickIssueCommands({
    registerConfiguredCommand: registerCommand,
    projectsTree,
    timeEntriesTree: myTimeEntriesTree,
    getWorkloadStatusBar: () => cleanupResources.workloadStatusBar,
  });

  context.subscriptions.push(...registerNavigationClipboardCommands());

  context.subscriptions.push(
    ...registerIssueContextCommands({
      globalState: context.globalState,
      getProjectsServer: () => projectsTree.server,
      refreshProjectsTree: () => projectsTree.refresh(),
      getAssignedIssues: () => projectsTree.getAssignedIssues(),
      getDependencyIssues: () => projectsTree.getDependencyIssues(),
      getProjectNodeById: (projectId: number) => projectsTree.getProjectNodeById(projectId),
      getProjectsTreeView: () => cleanupResources.projectsTreeView,
      getTimeEntriesServer: () => myTimeEntriesTree.server,
      refreshTimeEntries: () => myTimeEntriesTree.refresh(),
    })
  );

  context.subscriptions.push(...registerContextProxyCommands());

  // Register view commands
  registerViewCommands(context, {
    projectsTree,
    timeEntriesTree: myTimeEntriesTree,
    outputChannel,
    updateConfiguredContext,
  });

  // Register draft mode commands
  context.subscriptions.push(
    ...registerDraftModeCommands({
      queue: draftQueue,
      manager: draftModeManager,
      getServer: () => cleanupResources.draftModeServer,
      refreshTrees: () => {
        projectsTree.refresh();
        myTimeEntriesTree.refresh();
        vscode.commands.executeCommand("redmyne.refreshGanttData");
        vscode.commands.executeCommand("redmyne.refreshTimesheet");
      },
      showReviewPanel: () => {
        DraftReviewPanel.createOrShow(draftQueue, context.extensionUri);
      },
    })
  );

  // Register create test issues command
  registerCreateTestIssuesCommand(context, {
    getServer: () => projectsTree.server,
    refreshProjects: () => {
      projectsTree.clearProjects();
      projectsTree.refresh();
    },
  });
}

export function deactivate(): void {
  // Cancel pending debounced config change
  cleanupResources.debouncedConfigChange?.cancel();

  // Dispose views BEFORE their providers (views subscribe to provider
  // EventEmitters; disposing providers first can throw on unsubscribe).
  if (cleanupResources.projectsTreeView) {
    cleanupResources.projectsTreeView.dispose();
  }
  if (cleanupResources.myTimeEntriesTreeView) {
    cleanupResources.myTimeEntriesTreeView.dispose();
  }
  if (cleanupResources.kanbanTreeView) {
    cleanupResources.kanbanTreeView.dispose();
  }

  // Dispose tree providers
  if (cleanupResources.projectsTree) {
    cleanupResources.projectsTree.dispose();
  }
  if (cleanupResources.myTimeEntriesTree) {
    cleanupResources.myTimeEntriesTree.dispose();
  }
  if (cleanupResources.kanbanTreeProvider) {
    cleanupResources.kanbanTreeProvider.dispose();
  }

  // Dispose kanban controller and status bar
  if (cleanupResources.kanbanController) {
    cleanupResources.kanbanController.dispose();
  }
  if (cleanupResources.kanbanStatusBar) {
    cleanupResources.kanbanStatusBar.dispose();
  }

  // Dispose status bar
  if (cleanupResources.workloadStatusBar) {
    cleanupResources.workloadStatusBar.dispose();
  }

  // Dispose shared status bar utility
  disposeStatusBar();

  // Dispose draft mode resources
  if (cleanupResources.draftModeStatusBar) {
    cleanupResources.draftModeStatusBar.dispose();
  }
  if (cleanupResources.draftModeServer instanceof LoggingRedmineServer) {
    cleanupResources.draftModeServer.dispose();
  }
  if (cleanupResources.draftQueue) {
    cleanupResources.draftQueue.dispose();
  }
  if (cleanupResources.draftModeManager) {
    cleanupResources.draftModeManager.dispose();
  }

  // Dispose and clear bucket servers
  if (cleanupResources.bucket) {
    for (const server of cleanupResources.bucket.servers) {
      if (server instanceof LoggingRedmineServer) {
        server.dispose();
      }
    }
    cleanupResources.bucket.servers.length = 0;
    cleanupResources.bucket.projects.length = 0;
  }

  // Clear cleanup resources
  cleanupResources = {};
}
