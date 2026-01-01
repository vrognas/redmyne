import * as vscode from "vscode";
import {
  RedmineServer,
  RedmineServerConnectionOptions,
} from "./redmine/redmine-server";
import { LoggingRedmineServer } from "./redmine/logging-redmine-server";
import { RedmineProject } from "./redmine/redmine-project";
import { Issue } from "./redmine/models/issue";
import openActionsForIssue from "./commands/open-actions-for-issue";
import openActionsForIssueUnderCursor from "./commands/open-actions-for-issue-under-cursor";
import listOpenIssuesAssignedToMe from "./commands/list-open-issues-assigned-to-me";
import newIssue from "./commands/new-issue";
import { quickLogTime } from "./commands/quick-log-time";
import { quickCreateIssue, quickCreateSubIssue } from "./commands/quick-create-issue";
import { quickCreateVersion } from "./commands/quick-create-version";
import { ActionProperties } from "./commands/action-properties";
import { ProjectsTree, ProjectsViewStyle } from "./trees/projects-tree";
import { collapseState } from "./utilities/collapse-state";
import { MyTimeEntriesTreeDataProvider } from "./trees/my-time-entries-tree";
import { RedmineSecretManager } from "./utilities/secret-manager";
import { setApiKey } from "./commands/set-api-key";
import { MonthlyScheduleOverrides, loadMonthlySchedules } from "./utilities/monthly-schedule";
import { formatSecondsAsMMSS } from "./utilities/time-input";
import { disposeStatusBar, showStatusBarMessage } from "./utilities/status-bar";
import { TimerController } from "./timer/timer-controller";
import { TimerStatusBar } from "./timer/timer-status-bar";
import { TimerTreeProvider } from "./timer/timer-tree-provider";
import { registerTimerCommands } from "./timer/timer-commands";
import { toPersistedState, fromPersistedState, PersistedTimerState } from "./timer/timer-state";
import { KanbanController } from "./kanban/kanban-controller";
import { KanbanTreeProvider } from "./kanban/kanban-tree-provider";
import { registerKanbanCommands } from "./kanban/kanban-commands";
import { getTaskStatus } from "./kanban/kanban-state";
import { registerTimeEntryCommands } from "./commands/time-entry-commands";
import { registerMonthlyScheduleCommands } from "./commands/monthly-schedule-commands";
import { registerGanttCommands } from "./commands/gantt-commands";
import { GanttPanel } from "./webviews/gantt-panel";
import { registerConfigureCommand } from "./commands/configure-command";
import { registerViewCommands } from "./commands/view-commands";
import { registerCreateTestIssuesCommand } from "./commands/create-test-issues";
import { WorkloadStatusBar } from "./status-bars/workload-status-bar";
import { autoUpdateTracker } from "./utilities/auto-update-tracker";
import { adHocTracker } from "./utilities/adhoc-tracker";
import { toggleAdHoc, contributeToIssue, removeContribution } from "./commands/adhoc-commands";
import { debounce, DebouncedFunction } from "./utilities/debounce";

// Constants
const CONFIG_DEBOUNCE_MS = 300;
const SERVER_CACHE_SIZE = 3;

// Module-level cleanup resources
let cleanupResources: {
  projectsTree?: ProjectsTree;
  myTimeEntriesTree?: MyTimeEntriesTreeDataProvider;
  projectsTreeView?: vscode.TreeView<unknown>;
  myTimeEntriesTreeView?: vscode.TreeView<unknown>;
  timerTreeView?: vscode.TreeView<unknown>;
  kanbanTreeView?: vscode.TreeView<unknown>;
  workloadStatusBar?: WorkloadStatusBar;
  debouncedConfigChange?: DebouncedFunction<(event: vscode.ConfigurationChangeEvent) => void>;
  timerController?: TimerController;
  timerStatusBar?: TimerStatusBar;
  timerTreeProvider?: TimerTreeProvider;
  kanbanController?: KanbanController;
  kanbanTreeProvider?: KanbanTreeProvider;
  bucket?: {
    servers: RedmineServer[];
    projects: RedmineProject[];
  };
  userFte?: number;
  monthlySchedules?: MonthlyScheduleOverrides;
} = {};

export function activate(context: vscode.ExtensionContext): void {
  // Initialize auto-update tracker
  autoUpdateTracker.initialize(context);

  // Initialize ad-hoc budget tracker
  adHocTracker.initialize(context);

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
    const loggingEnabled =
      vscode.workspace.getConfiguration("redmine").get<boolean>("logging.enabled") ||
      false;

    if (loggingEnabled) {
      return new LoggingRedmineServer(options, outputChannel, {
        enabled: true,
      });
    }

    return new RedmineServer(options);
  };

  const projectsTree = new ProjectsTree(context.globalState);
  const myTimeEntriesTree = new MyTimeEntriesTreeDataProvider();
  cleanupResources.projectsTree = projectsTree;
  cleanupResources.myTimeEntriesTree = myTimeEntriesTree;

  // Initialize GanttPanel with globalState for persistence
  GanttPanel.initialize(context.globalState);

  cleanupResources.projectsTreeView = vscode.window.createTreeView("redmine-explorer-projects", {
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

  cleanupResources.myTimeEntriesTreeView = vscode.window.createTreeView("redmine-explorer-my-time-entries", {
    treeDataProvider: myTimeEntriesTree,
  });
  myTimeEntriesTree.setTreeView(cleanupResources.myTimeEntriesTreeView as vscode.TreeView<import("./trees/my-time-entries-tree").TimeEntryNode>);
  myTimeEntriesTree.setMonthlySchedules(cleanupResources.monthlySchedules ?? {});

  // Initialize timer controller with settings from globalState
  const unitDuration = context.globalState.get<number>("redmine.timer.unitDuration", 60);
  const workDuration = Math.max(1, Math.min(
    context.globalState.get<number>("redmine.timer.workDuration", 45),
    unitDuration
  ));
  const breakDuration = unitDuration - workDuration;
  const showTimerInStatusBar = vscode.workspace.getConfiguration("redmine.timer")
    .get<boolean>("showInStatusBar", true);

  // Controller expects seconds, config is in minutes
  const timerController = new TimerController(workDuration * 60, breakDuration * 60);
  cleanupResources.timerController = timerController;
  context.subscriptions.push({ dispose: () => timerController.dispose() });

  // Timer status bar (opt-in via config)
  if (showTimerInStatusBar) {
    const timerStatusBar = new TimerStatusBar(timerController);
    cleanupResources.timerStatusBar = timerStatusBar;
    context.subscriptions.push({ dispose: () => timerStatusBar.dispose() });
  }

  // Timer tree view
  const timerTreeProvider = new TimerTreeProvider(timerController);
  cleanupResources.timerTreeProvider = timerTreeProvider;
  cleanupResources.timerTreeView = vscode.window.createTreeView("redmine-explorer-timer", {
    treeDataProvider: timerTreeProvider,
  });
  context.subscriptions.push(cleanupResources.timerTreeView);

  // Update timer context variables for menu visibility and tree view title
  const updateTimerContext = () => {
    const phase = timerController.getPhase();
    const hasPlan = timerController.getPlan().length > 0;
    vscode.commands.executeCommand("setContext", "redmine:timerPhase", phase);
    vscode.commands.executeCommand("setContext", "redmine:timerHasPlan", hasPlan);

    // Update tree view title based on phase (4.6 Timer Phase Clarity)
    if (cleanupResources.timerTreeView) {
      const phaseTitles: Record<string, string> = {
        idle: hasPlan ? "Today's Plan" : "Today's Plan",
        working: "Today's Plan (Working)",
        paused: "Today's Plan (Paused)",
        logging: "Today's Plan (Log Time)",
        break: "Today's Plan (Break)",
      };
      cleanupResources.timerTreeView.title = phaseTitles[phase] || "Today's Plan";
    }
  };

  // Initial context update
  updateTimerContext();

  // Update context on state changes
  context.subscriptions.push(
    timerController.onStateChange(() => {
      updateTimerContext();
      // Auto-save state
      const persisted = toPersistedState(timerController.getState());
      context.globalState.update("redmine.timer.state", persisted);
    })
  );

  // Restore timer state (persists until manually cleared)
  const restoreTimerState = async () => {
    const persisted = context.globalState.get<PersistedTimerState>("redmine.timer.state");
    if (!persisted) return;

    // Restore state
    if (persisted.plan.length > 0) {
      const restored = fromPersistedState(persisted);

      // Handle working phase - adjust working unit's timer for elapsed time
      if (persisted.phase === "working") {
        const elapsedSeconds = Math.floor(
          (Date.now() - new Date(persisted.lastActiveAt).getTime()) / 1000
        );

        // Find working unit and adjust its timer
        const workingIdx = restored.plan.findIndex(u => u.unitPhase === "working");
        if (workingIdx >= 0) {
          const unit = restored.plan[workingIdx];
          const adjustedSecondsLeft = Math.max(0, unit.secondsLeft - elapsedSeconds);

          if (adjustedSecondsLeft <= 0) {
            // Timer would have completed - restore in logging phase
            restored.plan[workingIdx] = { ...unit, secondsLeft: 0 };
            restored.phase = "logging"; // Set to logging so markLogged/skipLogging work
            timerController.restoreState(restored);
            // Override the idle phase that restoreState sets
            // by directly triggering the log dialog which handles the logging phase
            vscode.commands.executeCommand("redmine.timer.showLogDialog");
            return;
          }

          // Adjust timer and offer to continue
          restored.plan[workingIdx] = { ...unit, secondsLeft: adjustedSecondsLeft };
          const pendingCount = restored.plan.filter(u => u.unitPhase !== "completed").length;
          const action = await vscode.window.showWarningMessage(
            `Timer recovered: ${formatSecondsAsMMSS(adjustedSecondsLeft)} left (${pendingCount} unit${pendingCount !== 1 ? "s" : ""})`,
            { modal: true },
            "Continue",
            "Start Fresh"
          );
          if (action === "Continue") {
            timerController.restoreState(restored);
            timerController.start();
          } else {
            await context.globalState.update("redmine.timer.state", undefined);
          }
          return;
        }
      }

      // Paused or other states - just offer to restore plan
      const pausedUnit = restored.plan.find(u => u.unitPhase === "paused");
      if (pausedUnit) {
        const pendingCount = restored.plan.filter(u => u.unitPhase !== "completed").length;
        const action = await vscode.window.showWarningMessage(
          `Timer recovered: ${formatSecondsAsMMSS(pausedUnit.secondsLeft)} left, paused (${pendingCount} unit${pendingCount !== 1 ? "s" : ""})`,
          { modal: true },
          "Continue",
          "Start Fresh"
        );
        if (action === "Continue") {
          timerController.restoreState(restored);
        } else {
          await context.globalState.update("redmine.timer.state", undefined);
        }
      } else {
        // Not working/paused - silently restore plan
        timerController.restoreState(restored);
      }
    }
  };

  restoreTimerState();

  // Initialize Kanban (before timer commands so we can pass the callback)
  const kanbanController = new KanbanController(context.globalState);
  cleanupResources.kanbanController = kanbanController;

  // Register timer commands (needs server access and tree view for selection)
  registerTimerCommands(
    context,
    timerController,
    () => projectsTree.server,
    cleanupResources.timerTreeView as vscode.TreeView<{ type?: string; index?: number }>,
    {
      onTimeLogged: async (kanbanTaskId, hours) => {
        await kanbanController.addLoggedHours(kanbanTaskId, hours);
      },
    }
  );

  const kanbanTreeProvider = new KanbanTreeProvider(kanbanController);
  cleanupResources.kanbanTreeProvider = kanbanTreeProvider;

  cleanupResources.kanbanTreeView = vscode.window.createTreeView("redmine-explorer-kanban", {
    treeDataProvider: kanbanTreeProvider,
  });
  context.subscriptions.push(cleanupResources.kanbanTreeView);

  // Update context for "Clear Done" button visibility
  const updateKanbanContext = () => {
    const tasks = kanbanController.getTasks();
    const hasDone = tasks.some((t) => getTaskStatus(t) === "done");
    vscode.commands.executeCommand("setContext", "redmine:hasKanbanDoneTasks", hasDone);
  };
  updateKanbanContext();
  context.subscriptions.push(
    kanbanController.onTasksChange(() => updateKanbanContext())
  );

  // Register kanban commands
  context.subscriptions.push(
    ...registerKanbanCommands(
      context,
      kanbanController,
      () => projectsTree.server,
      () => timerController,
      () => workDuration * 60
    )
  );

  // Register time entry commands
  registerTimeEntryCommands(context, {
    getServer: () => projectsTree.server,
    refreshTree: () => {
      myTimeEntriesTree.refresh();
      // Also refresh Gantt if open (time entries affect contribution data)
      vscode.commands.executeCommand("redmine.refreshGanttData");
    },
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
  });

  // Register Gantt panel serializer for window reload persistence
  vscode.window.registerWebviewPanelSerializer("redmineGantt", {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
      // Restore panel with loading skeleton
      const ganttPanel = GanttPanel.restore(panel, projectsTree.server);
      // Fetch and populate data
      const issues = await projectsTree.fetchIssuesIfNeeded();
      if (issues.length > 0) {
        await ganttPanel.updateIssues(
          issues,
          projectsTree.getFlexibilityCache(),
          projectsTree.getProjects()
        );
      }
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
    vscode.commands.executeCommand("redmine.refreshGanttData");
  });

  // Listen for secret changes
  context.subscriptions.push(
    secretManager.onSecretChanged(() => {
      updateConfiguredContext();
    })
  );

  // Check if configured and update context
  const updateConfiguredContext = async () => {
    const config = vscode.workspace.getConfiguration("redmine");
    const hasUrl = !!config.get<string>("url");
    const apiKey = await secretManager.getApiKey();
    const isConfigured = hasUrl && !!apiKey;

    // Set context in parallel with server init (no await needed)
    vscode.commands.executeCommand(
      "setContext",
      "redmine:configured",
      isConfigured
    );

    // If configured, initialize server for trees
    if (isConfigured) {
      try {
        const server = createServer({
          address: config.get<string>("url")!,
          key: apiKey!,
          additionalHeaders: config.get("additionalHeaders"),
        });

        projectsTree.setServer(server);
        myTimeEntriesTree.setServer(server);
        projectsTree.refresh();
        myTimeEntriesTree.refresh();

        // Fetch FTE from user's custom fields
        server.getCurrentUser().then((user) => {
          const fteField = user?.custom_fields?.find(
            (f) => f.name.toLowerCase().includes("fte")
          );
          if (fteField?.value) {
            const fte = parseFloat(fteField.value);
            if (!isNaN(fte) && fte > 0) {
              cleanupResources.userFte = fte;
              // Trigger workload recalc with new FTE
              cleanupResources.workloadStatusBar?.update();
            }
          }
        });
        // Status bar updates via projectsTree event listener
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to initialize Redmine server: ${error}`
        );
      }
    } else {
      // Clear servers when not configured (don't refresh - let welcome view show)
      projectsTree.setServer(undefined);
      myTimeEntriesTree.setServer(undefined);
    }
  };

  // Initial check
  updateConfiguredContext();

  // Listen for configuration changes (debounced)
  cleanupResources.debouncedConfigChange = debounce(
    CONFIG_DEBOUNCE_MS,
    async (event: vscode.ConfigurationChangeEvent) => {
      // Only update server context for server-related config changes
      // Skip for UI-only configs (statusBar, workingHours)
      if (
        !event.affectsConfiguration("redmine.statusBar") &&
        !event.affectsConfiguration("redmine.workingHours")
      ) {
        await updateConfiguredContext();
      }
      // Re-initialize status bar on config change
      if (event.affectsConfiguration("redmine.statusBar")) {
        cleanupResources.workloadStatusBar?.reinitialize();
        cleanupResources.workloadStatusBar?.update();
      }
      // Update status bar on schedule change
      if (event.affectsConfiguration("redmine.workingHours")) {
        cleanupResources.workloadStatusBar?.update();
      }
    }
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("redmine")) return;
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
    vscode.commands.registerCommand("redmine.setApiKey", async () => {
      await setApiKey(context);
      await updateConfiguredContext();
    })
  );

  vscode.commands.executeCommand(
    "setContext",
    "redmine:treeViewStyle",
    ProjectsViewStyle.TREE
  );

  const parseConfiguration = async (
    withPick = true,
    props?: ActionProperties,
    ...args: unknown[]
  ): Promise<{
    props?: ActionProperties;
    args: unknown[];
  }> => {
    if (!withPick) {
      return Promise.resolve({
        props,
        args,
      });
    }

    const config = vscode.workspace.getConfiguration("redmine");
    const url = config.get<string>("url");

    if (!url) {
      vscode.window.showErrorMessage(
        'No Redmine URL configured. Run "Redmine: Configure"'
      );
      return Promise.resolve({ props: undefined, args: [] });
    }

    // Get API key from secrets
    const apiKey = await secretManager.getApiKey();

    if (!apiKey) {
      vscode.window.showErrorMessage(
        'No API key configured. Run "Redmine: Configure"'
      );
      return Promise.resolve({ props: undefined, args: [] });
    }

    const redmineServer = createServer({
      address: url,
      key: apiKey,
      additionalHeaders: config.get("additionalHeaders"),
    });

    const fromBucket = bucket.servers.find((s) => s.compare(redmineServer));
    const server = fromBucket || redmineServer;

    if (!fromBucket) {
      // LRU cache: evict oldest when at capacity
      if (bucket.servers.length >= SERVER_CACHE_SIZE) {
        const removed = bucket.servers.shift(); // Remove oldest server
        // Dispose if it's a LoggingRedmineServer
        if (removed && removed instanceof LoggingRedmineServer) {
          removed.dispose();
        }
      }
      bucket.servers.push(server);
    } else {
      // Move to end (most recently used)
      const index = bucket.servers.indexOf(fromBucket);
      if (index > -1) {
        bucket.servers.splice(index, 1);
        bucket.servers.push(fromBucket);
      }
    }

    return {
      props: {
        server,
        config: {
          ...config,
          url,
          apiKey: "", // Deprecated, not used
        },
      },
      args: [],
    };
  };

  const registerCommand = (
    name: string,
    action: (
      props: ActionProperties,
      ...args: unknown[]
    ) => void | Promise<void>
  ) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        `redmine.${name}`,
        (withPick?: boolean, props?: ActionProperties, ...args: unknown[]) => {
          parseConfiguration(withPick, props, ...args).then(
            ({ props, args }) => {
              // `props` should be set when `withPick` is `false`.
              // Otherwise `parseConfiguration` will take care of getting ActionProperties.
              // It's used mainly by trees that always pass props argument.
              if (props) {
                action(props, ...args);
              }
            }
          );
        }
      )
    );
  };

  registerCommand("listOpenIssuesAssignedToMe", listOpenIssuesAssignedToMe);
  registerCommand("openActionsForIssue", openActionsForIssue);
  registerCommand(
    "openActionsForIssueUnderCursor",
    openActionsForIssueUnderCursor
  );
  registerCommand("newIssue", newIssue);
  registerCommand("quickLogTime", (props) => quickLogTime(props, context));
  // addTimeEntryForDate moved to time-entry-commands.ts
  registerCommand("quickCreateIssue", async (props, ...args) => {
    // Extract project ID from tree node if invoked from context menu
    // ProjectNode has project.id, not direct id
    let projectId: number | undefined;
    if (args[0] && typeof args[0] === "object" && "project" in args[0]) {
      projectId = (args[0] as { project: { id: number } }).project.id;
    } else if (typeof args[0] === "number") {
      projectId = args[0];
    }
    const created = await quickCreateIssue(props, projectId);
    if (created) {
      // Refresh issues to show newly created issue
      projectsTree.clearProjects();
      projectsTree.refresh();
    }
  });
  registerCommand("quickCreateSubIssue", async (props, ...args) => {
    // Extract parent issue ID from tree node or command argument
    let parentId: number | undefined;
    if (args[0] && typeof args[0] === "object" && "id" in args[0]) {
      parentId = (args[0] as { id: number }).id;
    } else if (typeof args[0] === "number") {
      parentId = args[0];
    } else if (typeof args[0] === "string") {
      parentId = parseInt(args[0], 10);
    }

    if (!parentId) {
      const input = await vscode.window.showInputBox({
        prompt: "Enter parent issue ID",
        placeHolder: "e.g., 123",
        validateInput: (v) => /^\d+$/.test(v) ? null : "Must be a number",
      });
      if (!input) return;
      parentId = parseInt(input, 10);
    }

    const created = await quickCreateSubIssue(props, parentId);
    if (created) {
      projectsTree.clearProjects();
      projectsTree.refresh();
    }
  });
  registerCommand("quickCreateVersion", async (props, ...args) => {
    // Extract project ID from tree node if invoked from context menu
    // ProjectNode has project.id, not direct id
    let projectId: number | undefined;
    if (args[0] && typeof args[0] === "object" && "project" in args[0]) {
      projectId = (args[0] as { project: { id: number } }).project.id;
    } else if (typeof args[0] === "number") {
      projectId = args[0];
    }
    const created = await quickCreateVersion(props, projectId);
    if (created) {
      // Refresh Gantt if open to show new milestone
      vscode.commands.executeCommand("redmine.refreshGantt");
    }
  });
  registerCommand("changeDefaultServer", (conf) => {
    projectsTree.setServer(conf.server);
    myTimeEntriesTree.setServer(conf.server);

    projectsTree.refresh();
    myTimeEntriesTree.refresh();
  });

  registerCommand("refreshTimeEntries", () => {
    myTimeEntriesTree.refresh();
  });

  // Open issue in browser (context menu - receives tree element directly)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.openIssueInBrowser", async (issue: { id: number } | undefined) => {
      if (!issue?.id) {
        vscode.window.showErrorMessage('Could not determine issue ID');
        return;
      }
      const url = vscode.workspace.getConfiguration("redmine").get<string>("url");
      if (!url) {
        vscode.window.showErrorMessage('No Redmine URL configured');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(`${url}/issues/${issue.id}`));
    })
  );

  // Copy issue URL to clipboard (context menu - receives tree element directly)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.copyIssueUrl", async (issue: { id: number } | undefined) => {
      if (!issue?.id) {
        vscode.window.showErrorMessage('Could not determine issue ID');
        return;
      }
      const url = vscode.workspace.getConfiguration("redmine").get<string>("url");
      if (!url) {
        vscode.window.showErrorMessage('No Redmine URL configured');
        return;
      }
      const issueUrl = `${url}/issues/${issue.id}`;
      await vscode.env.clipboard.writeText(issueUrl);
      showStatusBarMessage(`$(check) Copied #${issue.id} URL`, 2000);
    })
  );

  // Set done ratio (% Done) for issue (context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.setDoneRatio", async (issue: { id: number; done_ratio?: number } | undefined) => {
      if (!issue?.id) {
        vscode.window.showErrorMessage("Could not determine issue ID");
        return;
      }
      const server = projectsTree.server;
      if (!server) {
        vscode.window.showErrorMessage("No Redmine server configured");
        return;
      }

      const options = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((pct) => ({
        label: `${pct}%`,
        value: pct,
        picked: issue.done_ratio === pct,
      }));

      const selected = await vscode.window.showQuickPick(options, {
        placeHolder: `Set % Done for #${issue.id}`,
      });

      if (selected === undefined) return;

      try {
        await server.updateDoneRatio(issue.id, selected.value);
        // Disable auto-update for this issue since user manually set %done
        autoUpdateTracker.disable(issue.id);
        showStatusBarMessage(`$(check) #${issue.id} set to ${selected.value}%`, 2000);
        // Update only the Gantt panel if open, avoid full tree refresh
        GanttPanel.currentPanel?.updateIssueDoneRatio(issue.id, selected.value);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to update: ${error}`);
      }
    })
  );

  // Bulk set done ratio for multiple issues (Gantt multi-select)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.bulkSetDoneRatio", async (issueIds: number[]) => {
      if (!issueIds || issueIds.length === 0) {
        vscode.window.showErrorMessage("No issues selected");
        return;
      }
      const server = projectsTree.server;
      if (!server) {
        vscode.window.showErrorMessage("No Redmine server configured");
        return;
      }

      const options = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((pct) => ({
        label: `${pct}%`,
        value: pct,
      }));

      const selected = await vscode.window.showQuickPick(options, {
        placeHolder: `Set % Done for ${issueIds.length} issues`,
      });

      if (selected === undefined) return;

      try {
        // Update all issues in parallel
        await Promise.all(issueIds.map(id => server.updateDoneRatio(id, selected.value)));
        // Disable auto-update for all these issues
        issueIds.forEach(id => autoUpdateTracker.disable(id));
        showStatusBarMessage(`$(check) ${issueIds.length} issues set to ${selected.value}%`, 2000);
        // Update Gantt panel for each issue
        issueIds.forEach(id => GanttPanel.currentPanel?.updateIssueDoneRatio(id, selected.value));
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to update: ${error}`);
      }
    })
  );

  // Open project in browser (context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.openProjectInBrowser", async (node: { project?: { identifier?: string } } | undefined) => {
      const identifier = node?.project?.identifier;
      if (!identifier) {
        vscode.window.showErrorMessage("Could not determine project identifier");
        return;
      }
      const url = vscode.workspace.getConfiguration("redmine").get<string>("url");
      if (!url) {
        vscode.window.showErrorMessage("No Redmine URL configured");
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(`${url}/projects/${identifier}`));
    })
  );

  // Show project in Gantt (context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.showProjectInGantt", async (node: { project?: { id?: number } } | undefined) => {
      if (!node?.project?.id) {
        vscode.window.showErrorMessage("Could not determine project ID");
        return;
      }
      // Open Gantt - it will show all issues from the current filter
      await vscode.commands.executeCommand("redmine.showGantt");
    })
  );

  // Reveal issue in tree (from Gantt context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.revealIssueInTree", async (issueId: number) => {
      if (!issueId) return;
      // Find the issue in the tree data
      const issues = projectsTree.getAssignedIssues();
      const issue = issues.find((i: Issue) => i.id === issueId);
      if (issue && cleanupResources.projectsTreeView) {
        // Reveal the issue in the tree view
        await cleanupResources.projectsTreeView.reveal(issue, { select: true, focus: true, expand: true });
      }
    })
  );

  // Toggle auto-update %done for issue (opt-in per issue)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.toggleAutoUpdateDoneRatio", async (issue: { id: number } | undefined) => {
      if (!issue?.id) {
        vscode.window.showErrorMessage("Could not determine issue ID");
        return;
      }
      const nowEnabled = autoUpdateTracker.toggle(issue.id);
      showStatusBarMessage(
        nowEnabled
          ? `$(check) Auto-update %done enabled for #${issue.id}`
          : `$(x) Auto-update %done disabled for #${issue.id}`,
        2000
      );
    })
  );

  // Toggle ad-hoc budget tag for issue
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.toggleAdHoc", toggleAdHoc)
  );

  // Contribute time entry hours to another issue
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.contributeToIssue", (item) =>
      contributeToIssue(item, myTimeEntriesTree.server, () => myTimeEntriesTree.refresh())
    )
  );

  // Remove contribution from time entry
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.removeContribution", (item) =>
      removeContribution(item, myTimeEntriesTree.server, () => myTimeEntriesTree.refresh())
    )
  );

  // Register view commands
  registerViewCommands(context, {
    projectsTree,
    timeEntriesTree: myTimeEntriesTree,
    outputChannel,
    updateConfiguredContext,
  });

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
  if (cleanupResources.timerTreeView) {
    cleanupResources.timerTreeView.dispose();
  }

  // Dispose timer resources
  if (cleanupResources.timerStatusBar) {
    cleanupResources.timerStatusBar.dispose();
  }
  if (cleanupResources.timerTreeProvider) {
    cleanupResources.timerTreeProvider.dispose();
  }
  if (cleanupResources.timerController) {
    cleanupResources.timerController.dispose();
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
