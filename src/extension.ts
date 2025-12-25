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
import { quickLogTime } from "./commands/quick-log-time";
import { quickCreateIssue, quickCreateSubIssue } from "./commands/quick-create-issue";
import { ActionProperties } from "./commands/action-properties";
import { ProjectsTree, ProjectsViewStyle } from "./trees/projects-tree";
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
import { PersonalTaskController } from "./personal-tasks/personal-task-controller";
import { PersonalTasksTreeProvider } from "./personal-tasks/personal-tasks-tree-provider";
import { registerPersonalTaskCommands } from "./personal-tasks/personal-task-commands";
import { getTaskStatus } from "./personal-tasks/personal-task-state";
import { registerTimeEntryCommands } from "./commands/time-entry-commands";
import { registerMonthlyScheduleCommands } from "./commands/monthly-schedule-commands";
import { registerGanttCommands } from "./commands/gantt-commands";
import { registerConfigureCommand } from "./commands/configure-command";
import { registerViewCommands } from "./commands/view-commands";
import { registerCreateTestIssuesCommand } from "./commands/create-test-issues";
import { WorkloadStatusBar } from "./status-bars/workload-status-bar";

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
  personalTasksTreeView?: vscode.TreeView<unknown>;
  workloadStatusBar?: WorkloadStatusBar;
  configChangeTimeout?: ReturnType<typeof setTimeout>;
  timerController?: TimerController;
  timerStatusBar?: TimerStatusBar;
  timerTreeProvider?: TimerTreeProvider;
  personalTaskController?: PersonalTaskController;
  personalTasksTreeProvider?: PersonalTasksTreeProvider;
  bucket?: {
    servers: RedmineServer[];
    projects: RedmineProject[];
  };
  userFte?: number;
  monthlySchedules?: MonthlyScheduleOverrides;
} = {};

export function activate(context: vscode.ExtensionContext): void {

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

  const projectsTree = new ProjectsTree();
  const myTimeEntriesTree = new MyTimeEntriesTreeDataProvider();
  cleanupResources.projectsTree = projectsTree;
  cleanupResources.myTimeEntriesTree = myTimeEntriesTree;

  cleanupResources.projectsTreeView = vscode.window.createTreeView("redmine-explorer-projects", {
    treeDataProvider: projectsTree,
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

  // Initialize Personal Tasks (before timer commands so we can pass the callback)
  const personalTaskController = new PersonalTaskController(context.globalState);
  cleanupResources.personalTaskController = personalTaskController;

  // Register timer commands (needs server access and tree view for selection)
  registerTimerCommands(
    context,
    timerController,
    () => projectsTree.server,
    cleanupResources.timerTreeView as vscode.TreeView<{ type?: string; index?: number }>,
    {
      onTimeLogged: async (personalTaskId, hours) => {
        await personalTaskController.addLoggedHours(personalTaskId, hours);
      },
    }
  );

  const personalTasksTreeProvider = new PersonalTasksTreeProvider(personalTaskController);
  cleanupResources.personalTasksTreeProvider = personalTasksTreeProvider;

  cleanupResources.personalTasksTreeView = vscode.window.createTreeView("redmine-explorer-personal-tasks", {
    treeDataProvider: personalTasksTreeProvider,
  });
  context.subscriptions.push(cleanupResources.personalTasksTreeView);

  // Update context for "Clear Done" button visibility
  const updatePersonalTasksContext = () => {
    const tasks = personalTaskController.getTasks();
    const hasDone = tasks.some((t) => getTaskStatus(t) === "done");
    vscode.commands.executeCommand("setContext", "redmine:hasPersonalDoneTasks", hasDone);
  };
  updatePersonalTasksContext();
  context.subscriptions.push(
    personalTaskController.onTasksChange(() => updatePersonalTasksContext())
  );

  // Register personal task commands
  context.subscriptions.push(
    ...registerPersonalTaskCommands(
      context,
      personalTaskController,
      () => projectsTree.server,
      () => timerController,
      () => workDuration * 60
    )
  );

  // Register time entry commands
  registerTimeEntryCommands(context, {
    getServer: () => projectsTree.server,
    refreshTree: () => myTimeEntriesTree.refresh(),
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
    getFlexibilityCache: () => projectsTree.getFlexibilityCache(),
    clearProjects: () => projectsTree.clearProjects(),
  });

  // Initialize workload status bar
  cleanupResources.workloadStatusBar = new WorkloadStatusBar({
    fetchIssuesIfNeeded: () => projectsTree.fetchIssuesIfNeeded(),
    getMonthlySchedules: () => cleanupResources.monthlySchedules,
    getUserFte: () => cleanupResources.userFte,
  });
  cleanupResources.workloadStatusBar.update();

  // Update on tree refresh
  projectsTree.onDidChangeTreeData(() => {
    cleanupResources.workloadStatusBar?.update();
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

    await vscode.commands.executeCommand(
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

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("redmine")) return;

      // Clear pending timeout
      if (cleanupResources.configChangeTimeout) {
        clearTimeout(cleanupResources.configChangeTimeout);
      }

      cleanupResources.configChangeTimeout = setTimeout(async () => {
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
      }, CONFIG_DEBOUNCE_MS);
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
  registerCommand("addTimeEntryForDate", (props, ...args) => {
    // Extract date from day-group node
    const node = args[0] as { _date?: string } | undefined;
    const date = node?._date;
    return quickLogTime(props, context, date);
  });
  registerCommand("quickCreateIssue", async (props) => {
    const created = await quickCreateIssue(props);
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
  registerCommand("changeDefaultServer", (conf) => {
    projectsTree.setServer(conf.server);
    myTimeEntriesTree.setServer(conf.server);

    projectsTree.refresh();
    myTimeEntriesTree.refresh();
  });

  registerCommand("refreshTimeEntries", () => {
    myTimeEntriesTree.refresh();
  });

  // Open issue in browser (context menu for my-issues tree)
  registerCommand("openIssueInBrowser", async (props: ActionProperties, ...args: unknown[]) => {
    // Tree item passes the Issue object
    const issue = args[0] as { id: number } | undefined;
    if (!issue?.id) {
      vscode.window.showErrorMessage('Could not determine issue ID');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(`${props.server.options.address}/issues/${issue.id}`));
  });

  // Copy issue URL to clipboard (context menu for my-issues tree)
  registerCommand("copyIssueUrl", async (props: ActionProperties, ...args: unknown[]) => {
    const issue = args[0] as { id: number } | undefined;
    if (!issue?.id) {
      vscode.window.showErrorMessage('Could not determine issue ID');
      return;
    }
    const url = `${props.server.options.address}/issues/${issue.id}`;
    await vscode.env.clipboard.writeText(url);
    showStatusBarMessage(`$(check) Copied #${issue.id} URL`, 2000);
  });
  // Register view commands
  registerViewCommands(context, {
    projectsTree,
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
  // Clear pending config change timeout
  if (cleanupResources.configChangeTimeout) {
    clearTimeout(cleanupResources.configChangeTimeout);
  }

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

  // Dispose personal tasks resources
  if (cleanupResources.personalTasksTreeView) {
    cleanupResources.personalTasksTreeView.dispose();
  }
  if (cleanupResources.personalTasksTreeProvider) {
    cleanupResources.personalTasksTreeProvider.dispose();
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
