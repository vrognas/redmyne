import * as vscode from "vscode";
import {
  RedmineServer,
  RedmineServerConnectionOptions,
} from "./redmine/redmine-server";
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
import type { KanbanController } from "./kanban/kanban-controller";
import type { KanbanStatusBar } from "./kanban/kanban-status-bar";
import type { KanbanTreeProvider } from "./kanban/kanban-tree-provider";
import { setupKanban } from "./kanban/kanban-setup";
import { registerTimeEntryCommands } from "./commands/time-entry-commands";
import { updateClipboardContext } from "./utilities/time-entry-clipboard";
import { registerMonthlyScheduleCommands } from "./commands/monthly-schedule-commands";
import { registerGanttCommands } from "./commands/gantt-commands";
import { registerTimeSheetCommands } from "./commands/timesheet-commands";
import { registerInternalEstimateCommands } from "./commands/internal-estimate-commands";
import { registerIssueContextCommands } from "./commands/issue-context-commands";
import { registerNavigationClipboardCommands } from "./commands/navigation-clipboard-commands";
import { registerQuickIssueCommands } from "./commands/quick-issue-commands";
import { createConfiguredCommandRegistrar } from "./commands/configured-command-registrar";
import { GanttPanel } from "./webviews/gantt-panel";
import { WeeklySchedule, DEFAULT_WEEKLY_SCHEDULE } from "./utilities/flexibility-calculator";
import { registerConfigureCommand } from "./commands/configure-command";
import { registerViewCommands } from "./commands/view-commands";
import { registerContextProxyCommands } from "./commands/context-proxy-commands";
import { registerCreateTestIssuesCommand } from "./commands/create-test-issues";
import { WorkloadStatusBar } from "./status-bars/workload-status-bar";
import { autoUpdateTracker } from "./utilities/auto-update-tracker";
import { adHocTracker } from "./utilities/adhoc-tracker";
import { debounce, DebouncedFunction } from "./utilities/debounce";
import { runMigration } from "./utilities/migration";
import { initRecentIssues } from "./utilities/recent-issues";
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
    servers: RedmineServer[];
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
  // Run migration from redmine.* to redmyne.* namespace (one-time on upgrade)
  runMigration(context);

  // Initialize recent issues tracker
  initRecentIssues(context);

  // Initialize auto-update tracker
  autoUpdateTracker.initialize(context);

  // Initialize ad-hoc budget tracker
  adHocTracker.initialize(context);

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
    servers: [] as RedmineServer[],
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
    const config = vscode.workspace.getConfiguration("redmyne");
    const loggingEnabled = config.get<boolean>("logging.enabled") || false;
    const maxConcurrentRequests = config.get<number>("maxConcurrentRequests") || 2;

    const serverOptions = { ...options, maxConcurrentRequests };

    if (loggingEnabled) {
      return new LoggingRedmineServer(serverOptions, outputChannel, {
        enabled: true,
      });
    }

    return new RedmineServer(serverOptions);
  };

  const projectsTree = new ProjectsTree(context.globalState);
  const myTimeEntriesTree = new MyTimeEntriesTreeDataProvider();
  cleanupResources.projectsTree = projectsTree;
  cleanupResources.myTimeEntriesTree = myTimeEntriesTree;

  // Initialize GanttPanel with globalState for persistence
  GanttPanel.initialize(context.globalState);

  cleanupResources.projectsTreeView = vscode.window.createTreeView("redmyne-explorer-projects", {
    treeDataProvider: projectsTree,
  });

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

  cleanupResources.myTimeEntriesTreeView = vscode.window.createTreeView("redmyne-explorer-my-time-entries", {
    treeDataProvider: myTimeEntriesTree,
  });
  myTimeEntriesTree.setTreeView(cleanupResources.myTimeEntriesTreeView as vscode.TreeView<import("./trees/my-time-entries-tree").TimeEntryNode>);
  myTimeEntriesTree.setMonthlySchedules(cleanupResources.monthlySchedules ?? {});
  myTimeEntriesTree.setDraftQueue(draftQueue);

  const { controller: kanbanController, statusBar: kanbanStatusBar, treeProvider: kanbanTreeProvider, treeView: kanbanTreeView } =
    setupKanban({
      context,
      getServer: () => projectsTree.server,
      refreshAfterTimeLog: () => {
        myTimeEntriesTree.refresh();
        vscode.commands.executeCommand("redmyne.refreshGanttData");
      },
    });
  cleanupResources.kanbanController = kanbanController;
  cleanupResources.kanbanStatusBar = kanbanStatusBar;
  cleanupResources.kanbanTreeProvider = kanbanTreeProvider;
  cleanupResources.kanbanTreeView = kanbanTreeView;

  // Register time entry commands
  registerTimeEntryCommands(context, {
    getServer: () => projectsTree.server,
    refreshTree: () => {
      myTimeEntriesTree.refresh();
      // Also refresh Gantt if open (time entries affect contribution data)
      vscode.commands.executeCommand("redmyne.refreshGanttData");
    },
    getMonthlySchedules: () => cleanupResources.monthlySchedules ?? {},
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
  registerTimeSheetCommands(context, {
    getServer: () => projectsTree.server,
    getDraftQueue: () => draftQueue,
    getDraftModeManager: () => draftModeManager,
    getCachedIssues: () => projectsTree.getAssignedIssues(),
  });

  // Register internal estimate commands
  registerInternalEstimateCommands(context);

  // Register Gantt panel serializer for window reload persistence
  vscode.window.registerWebviewPanelSerializer("redmyneGantt", {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
      // Restore panel with loading skeleton (use getter function for late binding)
      const ganttPanel = GanttPanel.restore(panel, context.extensionUri, () => projectsTree.server, () => draftModeManager);
      // Fetch and populate data
      const issues = await projectsTree.fetchIssuesIfNeeded();
      if (issues.length > 0) {
        const scheduleConfig = vscode.workspace.getConfiguration("redmyne.workingHours");
        const schedule = scheduleConfig.get<WeeklySchedule>("weeklySchedule", DEFAULT_WEEKLY_SCHEDULE);
        await ganttPanel.updateIssues(
          issues,
          projectsTree.getFlexibilityCache(),
          projectsTree.getProjects(),
          schedule,
          projectsTree.getFilter(),
          projectsTree.getDependencyIssues(),
          () => projectsTree.server
        );
        ganttPanel.setFilterChangeCallback((filter) => projectsTree.setFilter(filter));
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
    fetchIssuesIfNeeded: () => projectsTree.fetchIssuesIfNeeded(),
    getMonthlySchedules: () => cleanupResources.monthlySchedules,
    getUserFte: () => cleanupResources.userFte,
  });
  // Defer initial update to avoid blocking activation
  setImmediate(() => cleanupResources.workloadStatusBar?.update());

  // Update on tree refresh (workload bar + Gantt if open)
  projectsTree.onDidChangeTreeData(() => {
    cleanupResources.workloadStatusBar?.update();
    // Refresh Gantt if open
    vscode.commands.executeCommand("redmyne.refreshGanttData");
  });

  // Listen for secret changes
  context.subscriptions.push(
    secretManager.onSecretChanged(() => {
      updateConfiguredContext();
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
    updateWorkloadStatusBar: () => cleanupResources.workloadStatusBar?.update(),
  });

  // Initial check
  updateConfiguredContext();

  // Listen for configuration changes (debounced)
  cleanupResources.debouncedConfigChange = debounce(
    CONFIG_DEBOUNCE_MS,
    async (event: vscode.ConfigurationChangeEvent) => {
      // Only update server context for server-related config changes
      // Skip for UI-only configs (statusBar, workingHours)
      if (
        !event.affectsConfiguration("redmyne.statusBar") &&
        !event.affectsConfiguration("redmyne.workingHours")
      ) {
        await updateConfiguredContext();
      }
      // Re-initialize status bar on config change
      if (event.affectsConfiguration("redmyne.statusBar")) {
        cleanupResources.workloadStatusBar?.reinitialize();
        cleanupResources.workloadStatusBar?.update();
      }
      // Update status bar on schedule change
      if (event.affectsConfiguration("redmyne.workingHours")) {
        cleanupResources.workloadStatusBar?.update();
      }
    }
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("redmyne")) return;
      cleanupResources.debouncedConfigChange?.(event);
    })
  );

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
    context,
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

  // Dispose tree providers
  if (cleanupResources.projectsTree) {
    cleanupResources.projectsTree.dispose();
  }
  if (cleanupResources.myTimeEntriesTree) {
    cleanupResources.myTimeEntriesTree.dispose();
  }

  // Dispose tree view instances
  if (cleanupResources.projectsTreeView) {
    cleanupResources.projectsTreeView.dispose();
  }
  if (cleanupResources.myTimeEntriesTreeView) {
    cleanupResources.myTimeEntriesTreeView.dispose();
  }
  // Dispose kanban resources
  if (cleanupResources.kanbanTreeView) {
    cleanupResources.kanbanTreeView.dispose();
  }
  if (cleanupResources.kanbanTreeProvider) {
    cleanupResources.kanbanTreeProvider.dispose();
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
