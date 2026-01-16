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
import { disposeStatusBar, showStatusBarMessage } from "./utilities/status-bar";
import { playCompletionSound } from "./utilities/completion-sound";
import { KanbanController } from "./kanban/kanban-controller";
import { KanbanStatusBar } from "./kanban/kanban-status-bar";
import { KanbanTreeProvider } from "./kanban/kanban-tree-provider";
import { registerKanbanCommands } from "./kanban/kanban-commands";
import { getTaskStatus } from "./kanban/kanban-state";
import { registerTimeEntryCommands } from "./commands/time-entry-commands";
import { registerMonthlyScheduleCommands } from "./commands/monthly-schedule-commands";
import { registerGanttCommands } from "./commands/gantt-commands";
import { registerInternalEstimateCommands } from "./commands/internal-estimate-commands";
import { setInternalEstimate } from "./utilities/internal-estimates";
import { parseTimeInput } from "./utilities/time-input";
import { GanttPanel } from "./webviews/gantt-panel";
import { WeeklySchedule, DEFAULT_WEEKLY_SCHEDULE } from "./utilities/flexibility-calculator";
import { registerConfigureCommand } from "./commands/configure-command";
import { registerViewCommands } from "./commands/view-commands";
import { registerCreateTestIssuesCommand } from "./commands/create-test-issues";
import { WorkloadStatusBar } from "./status-bars/workload-status-bar";
import { autoUpdateTracker } from "./utilities/auto-update-tracker";
import { adHocTracker } from "./utilities/adhoc-tracker";
import { toggleAdHoc, contributeToIssue, removeContribution } from "./commands/adhoc-commands";
import { togglePrecedence, setPrecedence, clearPrecedence } from "./utilities/precedence-tracker";
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
    const config = vscode.workspace.getConfiguration("redmine");
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
  // Initialize Kanban
  const kanbanController = new KanbanController(context.globalState, {
    workDurationSeconds: workDuration * 60,
  });
  cleanupResources.kanbanController = kanbanController;

  // Kanban status bar (always shown)
  const kanbanStatusBar = new KanbanStatusBar(kanbanController);
  cleanupResources.kanbanStatusBar = kanbanStatusBar;
  context.subscriptions.push({ dispose: () => kanbanStatusBar.dispose() });

  // Handle kanban timer completion - show log dialog
  context.subscriptions.push(
    kanbanController.onTimerComplete(async (task) => {
      const server = projectsTree.server;
      if (!server) return;

      // Play sound if enabled
      const soundEnabled = context.globalState.get<boolean>("redmine.timer.soundEnabled", true);
      if (soundEnabled) {
        playCompletionSound();
      }

      // Calculate hours with deferred time
      const baseHours = workDuration / 60;
      const deferredMinutes = kanbanController.getDeferredMinutes();
      const deferredHours = deferredMinutes / 60;
      const totalHours = baseHours + deferredHours;
      const deferredInfo = deferredMinutes > 0 ? ` (+${deferredMinutes}min)` : "";

      // Show completion dialog to log time
      const action = await vscode.window.showWarningMessage(
        `Timer complete: ${task.title}${deferredInfo}`,
        { modal: true },
        `Log ${totalHours}h`,
        "Defer",
        "Skip"
      );

      if (action?.startsWith("Log")) {
        try {
          kanbanController.consumeDeferredMinutes(); // Clear deferred time
          await server.addTimeEntry(
            task.linkedIssueId,
            task.activityId ?? 0,
            totalHours.toString(),
            task.title // Comment
          );
          await kanbanController.addLoggedHours(task.id, totalHours);
          await kanbanController.stopTimer(task.id);
          showStatusBarMessage(`$(check) Logged ${totalHours}h to #${task.linkedIssueId}`, 2000);
          myTimeEntriesTree.refresh();
          // Refresh Gantt if open
          vscode.commands.executeCommand("redmine.refreshGanttData");
          // Start break timer
          kanbanController.startBreak();
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to log time: ${error}`);
        }
      } else if (action === "Defer") {
        // Add work duration to deferred pool
        kanbanController.addDeferredMinutes(workDuration);
        await kanbanController.stopTimer(task.id);
        showStatusBarMessage(`$(clock) Deferred ${workDuration}min to next task`, 2000);
        // Start break timer
        kanbanController.startBreak();
      } else {
        // Just stop the timer without logging
        await kanbanController.stopTimer(task.id);
      }
    })
  );

  // Handle break completion
  context.subscriptions.push(
    kanbanController.onBreakComplete(async () => {
      const soundEnabled = context.globalState.get<boolean>("redmine.timer.soundEnabled", true);
      if (soundEnabled) {
        playCompletionSound();
      }
      vscode.window.showInformationMessage("Break over! Ready to start next task.");
    })
  );

  const kanbanTreeProvider = new KanbanTreeProvider(kanbanController);
  cleanupResources.kanbanTreeProvider = kanbanTreeProvider;

  cleanupResources.kanbanTreeView = vscode.window.createTreeView("redmine-explorer-kanban", {
    treeDataProvider: kanbanTreeProvider,
    dragAndDropController: kanbanTreeProvider,
    canSelectMany: true,
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
      () => projectsTree.server
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

  // Register internal estimate commands
  registerInternalEstimateCommands(context);

  // Register Gantt panel serializer for window reload persistence
  vscode.window.registerWebviewPanelSerializer("redmineGantt", {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
      // Restore panel with loading skeleton
      const ganttPanel = GanttPanel.restore(panel, context.extensionUri, projectsTree.server);
      // Fetch and populate data
      const issues = await projectsTree.fetchIssuesIfNeeded();
      if (issues.length > 0) {
        const scheduleConfig = vscode.workspace.getConfiguration("redmine.workingHours");
        const schedule = scheduleConfig.get<WeeklySchedule>("weeklySchedule", DEFAULT_WEEKLY_SCHEDULE);
        await ganttPanel.updateIssues(
          issues,
          projectsTree.getFlexibilityCache(),
          projectsTree.getProjects(),
          schedule,
          projectsTree.getFilter(),
          projectsTree.getDependencyIssues(),
          projectsTree.server
        );
        ganttPanel.setFilterChangeCallback((filter) => projectsTree.setFilter(filter));
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

        // Fetch FTE from user's custom fields (non-critical, silent fail)
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
        }).catch(() => {
          // FTE fetch is non-critical - continue without it
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

  registerCommand("loadEarlierTimeEntries", () => {
    myTimeEntriesTree.loadEarlierMonths();
  });

  // Refresh after issue update (status change, etc.) - updates workload and trees
  registerCommand("refreshAfterIssueUpdate", () => {
    projectsTree.refresh();
    cleanupResources.workloadStatusBar?.update();
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

  // Copy issue ID to clipboard (sidebar context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.copyIssueId", async (issue: { id: number } | undefined) => {
      if (!issue?.id) {
        vscode.window.showErrorMessage('Could not determine issue ID');
        return;
      }
      await vscode.env.clipboard.writeText(`#${issue.id}`);
      showStatusBarMessage(`$(check) Copied #${issue.id}`, 2000);
    })
  );

  // Copy project ID to clipboard (sidebar context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.copyProjectId", async (project: { id: number } | undefined) => {
      if (!project?.id) {
        vscode.window.showErrorMessage('Could not determine project ID');
        return;
      }
      await vscode.env.clipboard.writeText(`#${project.id}`);
      showStatusBarMessage(`$(check) Copied project #${project.id}`, 2000);
    })
  );

  // Copy project URL to clipboard (sidebar context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.copyProjectUrl", async (project: { id: number; identifier?: string } | undefined) => {
      if (!project?.identifier) {
        vscode.window.showErrorMessage('Could not determine project identifier');
        return;
      }
      const url = vscode.workspace.getConfiguration("redmine").get<string>("url");
      if (!url) {
        vscode.window.showErrorMessage('No Redmine URL configured');
        return;
      }
      const projectUrl = `${url}/projects/${project.identifier}`;
      await vscode.env.clipboard.writeText(projectUrl);
      showStatusBarMessage(`$(check) Copied project URL`, 2000);
    })
  );

  // Set done ratio (% Done) for issue (context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "redmine.setDoneRatio",
      async (issue: { id: number; done_ratio?: number; percentage?: number } | undefined) => {
        if (!issue?.id) {
          vscode.window.showErrorMessage("Could not determine issue ID");
          return;
        }
        const server = projectsTree.server;
        if (!server) {
          vscode.window.showErrorMessage("No Redmine server configured");
          return;
        }

        let selectedValue: number;

        // If percentage provided directly, use it; otherwise show picker
        if (issue.percentage !== undefined) {
          selectedValue = issue.percentage;
        } else {
          const options = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((pct) => ({
            label: `${pct}%`,
            value: pct,
            picked: issue.done_ratio === pct,
          }));

          const selected = await vscode.window.showQuickPick(options, {
            placeHolder: `Set % Done for #${issue.id}`,
          });

          if (selected === undefined) return;
          selectedValue = selected.value;
        }

        try {
          await server.updateDoneRatio(issue.id, selectedValue);
          // Disable auto-update for this issue since user manually set %done
          autoUpdateTracker.disable(issue.id);

          // Prompt for internal estimate (time remaining until 100% done)
          const hoursInput = await vscode.window.showInputBox({
            title: `Internal Estimate: #${issue.id}`,
            prompt: `Hours remaining until 100% done (e.g., 5, 2.5, 1:30, 2h 30min)`,
            placeHolder: "Leave blank to skip",
            validateInput: (value) => {
              if (!value.trim()) return null; // Empty is OK (skip)
              const parsed = parseTimeInput(value);
              if (parsed === null) return "Invalid format. Use: 5, 2.5, 1:30, or 2h 30min";
              if (parsed < 0) return "Hours cannot be negative";
              return null;
            },
          });

          if (hoursInput && hoursInput.trim()) {
            const hours = parseTimeInput(hoursInput);
            if (hours !== null) {
              await setInternalEstimate(context.globalState, issue.id, hours);
              showStatusBarMessage(`$(check) #${issue.id} set to ${selectedValue}% with ${hours}h remaining`, 2000);
            }
          } else {
            showStatusBarMessage(`$(check) #${issue.id} set to ${selectedValue}%`, 2000);
          }

          // Update only the Gantt panel if open, avoid full tree refresh
          GanttPanel.currentPanel?.updateIssueDoneRatio(issue.id, selectedValue);
          // Refresh Gantt data to recalculate capacity
          vscode.commands.executeCommand("redmine.refreshGanttData");
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update: ${error}`);
        }
      }
    )
  );

  // Set status for issue (sidebar context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "redmine.setStatus",
      async (issue: { id: number; status?: { id: number; name: string } } | undefined) => {
        if (!issue?.id) {
          vscode.window.showErrorMessage("Could not determine issue ID");
          return;
        }
        const server = projectsTree.server;
        if (!server) {
          vscode.window.showErrorMessage("No Redmine server configured");
          return;
        }

        try {
          const statuses = await server.getIssueStatusesTyped();
          const options = statuses.map((s) => ({
            label: s.name,
            value: s.statusId,
            picked: issue.status?.id === s.statusId,
          }));

          const selected = await vscode.window.showQuickPick(options, {
            placeHolder: `Set status for #${issue.id}`,
          });

          if (selected === undefined) return;

          await server.setIssueStatus({ id: issue.id }, selected.value);
          showStatusBarMessage(`$(check) #${issue.id} set to ${selected.label}`, 2000);

          // Refresh trees and Gantt
          projectsTree.refresh();
          vscode.commands.executeCommand("redmine.refreshGanttData");
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update: ${error}`);
        }
      }
    )
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

        // Prompt for internal estimate (applies same value to all selected issues)
        const hoursInput = await vscode.window.showInputBox({
          title: `Internal Estimate for ${issueIds.length} issues`,
          prompt: `Hours remaining per issue until 100% done (e.g., 5, 2.5, 1:30)`,
          placeHolder: "Leave blank to skip",
          validateInput: (value) => {
            if (!value.trim()) return null; // Empty is OK (skip)
            const parsed = parseTimeInput(value);
            if (parsed === null) return "Invalid format. Use: 5, 2.5, 1:30, or 2h 30min";
            if (parsed < 0) return "Hours cannot be negative";
            return null;
          },
        });

        if (hoursInput && hoursInput.trim()) {
          const hours = parseTimeInput(hoursInput);
          if (hours !== null) {
            await Promise.all(issueIds.map(id => setInternalEstimate(context.globalState, id, hours)));
            showStatusBarMessage(`$(check) ${issueIds.length} issues set to ${selected.value}% with ${hours}h remaining each`, 2000);
          }
        } else {
          showStatusBarMessage(`$(check) ${issueIds.length} issues set to ${selected.value}%`, 2000);
        }

        // Update Gantt panel for each issue
        issueIds.forEach(id => GanttPanel.currentPanel?.updateIssueDoneRatio(id, selected.value));
        // Refresh Gantt data to recalculate capacity
        vscode.commands.executeCommand("redmine.refreshGanttData");
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to update: ${error}`);
      }
    })
  );

  // Set issue status (context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "redmine.setIssueStatus",
      async (issue: { id: number; statusPattern?: "new" | "in_progress" | "closed" } | undefined) => {
        if (!issue?.id) {
          vscode.window.showErrorMessage("Could not determine issue ID");
          return;
        }
        const server = projectsTree.server;
        if (!server) {
          vscode.window.showErrorMessage("No Redmine server configured");
          return;
        }

        try {
          const statuses = (await server.getIssueStatuses()).issue_statuses;
          let targetStatus: { id: number; name: string; is_closed: boolean } | undefined;

          if (issue.statusPattern) {
            // Find status by pattern - prefer exact name match, then heuristic
            if (issue.statusPattern === "new") {
              // Exact "new", then first non-closed
              targetStatus = statuses.find((s) => s.name.toLowerCase() === "new")
                ?? statuses.find((s) => !s.is_closed);
            } else if (issue.statusPattern === "in_progress") {
              // Exact "in progress", then contains "progress", then second non-closed
              targetStatus = statuses.find((s) => s.name.toLowerCase() === "in progress")
                ?? statuses.find((s) => !s.is_closed && s.name.toLowerCase().includes("progress"))
                ?? statuses.filter((s) => !s.is_closed)[1];
            } else if (issue.statusPattern === "closed") {
              // Exact "closed", then first is_closed
              targetStatus = statuses.find((s) => s.name.toLowerCase() === "closed")
                ?? statuses.find((s) => s.is_closed);
            }

            if (!targetStatus) {
              vscode.window.showErrorMessage(`No matching status found for pattern: ${issue.statusPattern}`);
              return;
            }
          } else {
            // Show picker with all statuses
            const options = statuses.map((s) => ({
              label: s.name,
              description: s.is_closed ? "(closed)" : "",
              status: s,
            }));

            const selected = await vscode.window.showQuickPick(options, {
              placeHolder: `Set status for #${issue.id}`,
            });

            if (!selected) return;
            targetStatus = selected.status;
          }

          await server.setIssueStatus({ id: issue.id }, targetStatus.id);
          showStatusBarMessage(`$(check) #${issue.id} set to ${targetStatus.name}`, 2000);
          vscode.commands.executeCommand("redmine.refreshGanttData");
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update status: ${error}`);
        }
      }
    )
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
    vscode.commands.registerCommand("redmine.showProjectInGantt", async (node: { project?: { id?: number }; id?: number } | undefined) => {
      const projectId = node?.project?.id ?? node?.id;
      if (!projectId) {
        vscode.window.showErrorMessage("Could not determine project ID");
        return;
      }
      // Open Gantt and switch to project view with this project selected
      await vscode.commands.executeCommand("redmine.showGantt");
      GanttPanel.currentPanel?.showProject(projectId);
    })
  );

  // Reveal issue in tree (from Gantt context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.revealIssueInTree", async (issueId: number) => {
      if (!issueId) return;
      // Find the issue in the tree data (search both assigned and dependency issues)
      const assignedIssues = projectsTree.getAssignedIssues();
      const dependencyIssues = projectsTree.getDependencyIssues();
      const issue = assignedIssues.find((i: Issue) => i.id === issueId)
        ?? dependencyIssues.find((i: Issue) => i.id === issueId);
      if (issue && cleanupResources.projectsTreeView) {
        // Focus the Issues view first, then reveal
        await vscode.commands.executeCommand("redmine-explorer-projects.focus");
        await cleanupResources.projectsTreeView.reveal(issue, { select: true, focus: true, expand: true });
      }
    })
  );

  // Reveal project in tree (from Gantt context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.revealProjectInTree", async (projectId: number) => {
      if (!projectId) return;
      // Find the project in the tree data
      const projects = projectsTree.getProjects();
      const project = projects.find((p) => p.id === projectId);
      if (project && cleanupResources.projectsTreeView) {
        // Focus the Issues view first, then reveal
        await vscode.commands.executeCommand("redmine-explorer-projects.focus");
        await cleanupResources.projectsTreeView.reveal(project, { select: true, focus: true, expand: true });
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
      contributeToIssue(item, myTimeEntriesTree.server, () => {
        myTimeEntriesTree.refresh();
        vscode.commands.executeCommand("redmine.refreshGanttData");
      })
    )
  );

  // Remove contribution from time entry
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.removeContribution", (item) =>
      removeContribution(item, myTimeEntriesTree.server, () => {
        myTimeEntriesTree.refresh();
        vscode.commands.executeCommand("redmine.refreshGanttData");
      })
    )
  );

  // Toggle precedence priority (for tree views)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.togglePrecedence", async (issue: { id: number } | undefined) => {
      if (!issue?.id) {
        vscode.window.showErrorMessage("Could not determine issue ID");
        return;
      }
      const isNow = await togglePrecedence(context.globalState, issue.id);
      showStatusBarMessage(
        isNow ? `$(check) #${issue.id} tagged with precedence` : `$(check) #${issue.id} precedence removed`,
        2000
      );
      vscode.commands.executeCommand("redmine.refreshGanttData");
    })
  );

  // Set issue priority (pattern-based or picker)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "redmine.setIssuePriority",
      async (issue: { id: number; priorityPattern?: string } | undefined) => {
        if (!issue?.id) {
          vscode.window.showErrorMessage("Could not determine issue ID");
          return;
        }
        const server = projectsTree.server;
        if (!server) {
          vscode.window.showErrorMessage("No Redmine server configured");
          return;
        }

        try {
          // Use cached priorities for performance
          const { issue_priorities: priorities } = await server.getIssuePriorities();
          let targetPriority: { id: number; name: string } | undefined;

          if (issue.priorityPattern) {
            // Find priority by pattern - prefer exact match, fallback to includes
            const pattern = issue.priorityPattern.toLowerCase();
            targetPriority = priorities.find((p) => p.name.toLowerCase() === pattern)
              ?? priorities.find((p) => p.name.toLowerCase().includes(pattern));

            if (!targetPriority) {
              vscode.window.showErrorMessage(`No matching priority found for: ${issue.priorityPattern}`);
              return;
            }
          } else {
            // Show picker
            const options = priorities.map((p) => ({ label: p.name, priority: p }));
            const selected = await vscode.window.showQuickPick(options, {
              placeHolder: `Set priority for #${issue.id}`,
            });
            if (!selected) return;
            targetPriority = selected.priority;
          }

          await server.setIssuePriority(issue.id, targetPriority.id);
          showStatusBarMessage(`$(check) #${issue.id} priority set to ${targetPriority.name}`, 2000);
          vscode.commands.executeCommand("redmine.refreshGanttData");
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update priority: ${error}`);
        }
      }
    )
  );

  // Set auto-update %done (explicit on/off)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "redmine.setAutoUpdateDoneRatio",
      async (issue: { id: number; value: boolean } | undefined) => {
        if (!issue?.id) {
          vscode.window.showErrorMessage("Could not determine issue ID");
          return;
        }
        if (issue.value) {
          autoUpdateTracker.enable(issue.id);
          showStatusBarMessage(`$(check) Auto-update %done enabled for #${issue.id}`, 2000);
        } else {
          autoUpdateTracker.disable(issue.id);
          showStatusBarMessage(`$(x) Auto-update %done disabled for #${issue.id}`, 2000);
        }
      }
    )
  );

  // Set ad-hoc budget (explicit on/off)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "redmine.setAdHoc",
      async (issue: { id: number; value: boolean } | undefined) => {
        if (!issue?.id) {
          vscode.window.showErrorMessage("Could not determine issue ID");
          return;
        }
        if (issue.value) {
          adHocTracker.tag(issue.id);
          showStatusBarMessage(`$(check) #${issue.id} tagged as ad-hoc budget`, 2000);
        } else {
          adHocTracker.untag(issue.id);
          showStatusBarMessage(`$(check) #${issue.id} ad-hoc budget removed`, 2000);
        }
        vscode.commands.executeCommand("redmine.refreshGanttData");
      }
    )
  );

  // Set precedence (explicit on/off)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "redmine.setPrecedence",
      async (issue: { id: number; value: boolean } | undefined) => {
        if (!issue?.id) {
          vscode.window.showErrorMessage("Could not determine issue ID");
          return;
        }
        if (issue.value) {
          await setPrecedence(context.globalState, issue.id);
          showStatusBarMessage(`$(check) #${issue.id} tagged with precedence`, 2000);
        } else {
          await clearPrecedence(context.globalState, issue.id);
          showStatusBarMessage(`$(check) #${issue.id} precedence removed`, 2000);
        }
        vscode.commands.executeCommand("redmine.refreshGanttData");
      }
    )
  );

  // Gantt webview context menu commands
  // These receive { webviewSection, issueId } from data-vscode-context
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.gantt.updateIssue", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.openActionsForIssue", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.openInBrowser", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.openIssueInBrowser", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.showInIssues", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.revealIssueInTree", ctx.issueId);
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.logTime", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.quickLogTime", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.setDoneRatio", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setDoneRatio", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.setStatus", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setStatus", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.setIssuePriority", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setIssuePriority", { id: ctx.issueId });
      }
    }),
    // Submenu commands for quick % Done selection
    ...[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((pct) =>
      vscode.commands.registerCommand(`redmine.gantt.setDoneRatio${pct}`, (ctx: { issueId: number }) => {
        if (ctx?.issueId) {
          vscode.commands.executeCommand("redmine.setDoneRatio", { id: ctx.issueId, percentage: pct });
        }
      })
    ),
    vscode.commands.registerCommand("redmine.gantt.setDoneRatioCustom", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setDoneRatio", { id: ctx.issueId });
      }
    }),
    // Submenu commands for quick status selection
    vscode.commands.registerCommand("redmine.gantt.setStatusNew", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setIssueStatus", { id: ctx.issueId, statusPattern: "new" });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.setStatusInProgress", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setIssueStatus", { id: ctx.issueId, statusPattern: "in_progress" });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.setStatusClosed", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setIssueStatus", { id: ctx.issueId, statusPattern: "closed" });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.setStatusOther", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setIssueStatus", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.toggleAutoUpdate", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.toggleAutoUpdateDoneRatio", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.toggleAdHoc", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.toggleAdHoc", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.togglePrecedence", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.togglePrecedence", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.copyUrl", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.copyIssueUrl", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.copyIssueId", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.env.clipboard.writeText(`#${ctx.issueId}`);
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.copyProjectId", (ctx: { projectId: number }) => {
      if (ctx?.projectId) {
        vscode.env.clipboard.writeText(`#${ctx.projectId}`);
      }
    }),
    vscode.commands.registerCommand(
      "redmine.gantt.copyProjectUrl",
      (ctx: { projectId: number; projectIdentifier: string }) => {
        if (ctx?.projectIdentifier) {
          const url = vscode.workspace.getConfiguration("redmine").get<string>("url");
          if (url) {
            const projectUrl = `${url}/projects/${ctx.projectIdentifier}`;
            vscode.env.clipboard.writeText(projectUrl);
            showStatusBarMessage("$(check) Copied project URL", 2000);
          }
        }
      }
    ),
    vscode.commands.registerCommand(
      "redmine.gantt.createSubIssue",
      (ctx: { issueId: number; projectId: number }) => {
        if (ctx?.issueId && ctx?.projectId) {
          vscode.commands.executeCommand("redmine.quickCreateSubIssue", {
            id: ctx.issueId,
            project: { id: ctx.projectId },
          });
        }
      }
    ),
    vscode.commands.registerCommand(
      "redmine.gantt.openProjectInBrowser",
      (ctx: { projectId: number; projectIdentifier: string }) => {
        if (ctx?.projectIdentifier) {
          vscode.commands.executeCommand("redmine.openProjectInBrowser", {
            project: { identifier: ctx.projectIdentifier },
          });
        }
      }
    ),
    vscode.commands.registerCommand(
      "redmine.gantt.showProjectInGantt",
      (ctx: { projectId: number; projectIdentifier: string }) => {
        if (ctx?.projectId) {
          vscode.commands.executeCommand("redmine.showProjectInGantt", {
            project: { id: ctx.projectId },
          });
        }
      }
    ),
    vscode.commands.registerCommand(
      "redmine.gantt.showProjectInIssues",
      (ctx: { projectId: number }) => {
        if (ctx?.projectId) {
          vscode.commands.executeCommand("redmine.revealProjectInTree", ctx.projectId);
        }
      }
    ),
    // Priority submenu commands for Gantt
    vscode.commands.registerCommand("redmine.gantt.setPriorityLow", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setIssuePriority", { id: ctx.issueId, priorityPattern: "low" });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.setPriorityNormal", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setIssuePriority", { id: ctx.issueId, priorityPattern: "normal" });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.setPriorityHigh", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setIssuePriority", { id: ctx.issueId, priorityPattern: "high" });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.setPriorityUrgent", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setIssuePriority", { id: ctx.issueId, priorityPattern: "urgent" });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.setPriorityImmediate", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setIssuePriority", { id: ctx.issueId, priorityPattern: "immediate" });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.setPriorityOther", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setIssuePriority", { id: ctx.issueId });
      }
    }),
    // Auto-update On/Off for Gantt
    vscode.commands.registerCommand("redmine.gantt.autoUpdateOn", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setAutoUpdateDoneRatio", { id: ctx.issueId, value: true });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.autoUpdateOff", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setAutoUpdateDoneRatio", { id: ctx.issueId, value: false });
      }
    }),
    // Ad-hoc On/Off for Gantt
    vscode.commands.registerCommand("redmine.gantt.adHocOn", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setAdHoc", { id: ctx.issueId, value: true });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.adHocOff", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setAdHoc", { id: ctx.issueId, value: false });
      }
    }),
    // Precedence On/Off for Gantt
    vscode.commands.registerCommand("redmine.gantt.precedenceOn", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setPrecedence", { id: ctx.issueId, value: true });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.precedenceOff", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setPrecedence", { id: ctx.issueId, value: false });
      }
    }),
    // Internal Estimate for Gantt
    vscode.commands.registerCommand("redmine.gantt.setInternalEstimate", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.setInternalEstimate", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmine.gantt.clearInternalEstimate", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.clearInternalEstimate", { id: ctx.issueId });
      }
    }),
    // Add to Kanban for Gantt
    vscode.commands.registerCommand("redmine.gantt.addToKanban", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmine.addIssueToKanban", { id: ctx.issueId });
      }
    }),
    // Create Issue for Gantt project context
    vscode.commands.registerCommand("redmine.gantt.createIssue", (ctx: { projectId: number }) => {
      if (ctx?.projectId) {
        vscode.commands.executeCommand("redmine.quickCreateIssue", { project: { id: ctx.projectId } });
      }
    }),
    // Create Version for Gantt project context
    vscode.commands.registerCommand("redmine.gantt.createVersion", (ctx: { projectId: number }) => {
      if (ctx?.projectId) {
        vscode.commands.executeCommand("redmine.quickCreateVersion", { project: { id: ctx.projectId } });
      }
    }),
    // Sidebar submenu commands for % Done
    ...[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((pct) =>
      vscode.commands.registerCommand(`redmine.setDoneRatio${pct}`, (issue: { id: number }) => {
        if (issue?.id) {
          vscode.commands.executeCommand("redmine.setDoneRatio", { id: issue.id, percentage: pct });
        }
      })
    ),
    vscode.commands.registerCommand("redmine.setDoneRatioCustom", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.setDoneRatio", { id: issue.id });
      }
    }),
    // Sidebar submenu commands for Status
    vscode.commands.registerCommand("redmine.setStatusNew", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.setIssueStatus", { id: issue.id, statusPattern: "new" });
      }
    }),
    vscode.commands.registerCommand("redmine.setStatusInProgress", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.setIssueStatus", { id: issue.id, statusPattern: "in_progress" });
      }
    }),
    vscode.commands.registerCommand("redmine.setStatusClosed", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.setIssueStatus", { id: issue.id, statusPattern: "closed" });
      }
    }),
    vscode.commands.registerCommand("redmine.setStatusOther", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.setIssueStatus", { id: issue.id });
      }
    }),
    // Sidebar submenu commands for Priority
    vscode.commands.registerCommand("redmine.setPriorityLow", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.setIssuePriority", { id: issue.id, priorityPattern: "low" });
      }
    }),
    vscode.commands.registerCommand("redmine.setPriorityNormal", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.setIssuePriority", { id: issue.id, priorityPattern: "normal" });
      }
    }),
    vscode.commands.registerCommand("redmine.setPriorityHigh", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.setIssuePriority", { id: issue.id, priorityPattern: "high" });
      }
    }),
    vscode.commands.registerCommand("redmine.setPriorityUrgent", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.setIssuePriority", { id: issue.id, priorityPattern: "urgent" });
      }
    }),
    vscode.commands.registerCommand("redmine.setPriorityImmediate", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.setIssuePriority", { id: issue.id, priorityPattern: "immediate" });
      }
    }),
    vscode.commands.registerCommand("redmine.setPriorityOther", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.setIssuePriority", { id: issue.id });
      }
    }),
    // Sidebar On/Off commands for Auto-update
    vscode.commands.registerCommand("redmine.autoUpdateOn", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.setAutoUpdateDoneRatio", { id: issue.id, value: true });
      }
    }),
    vscode.commands.registerCommand("redmine.autoUpdateOff", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.setAutoUpdateDoneRatio", { id: issue.id, value: false });
      }
    }),
    // Sidebar On/Off commands for Ad-hoc
    vscode.commands.registerCommand("redmine.adHocOn", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.setAdHoc", { id: issue.id, value: true });
      }
    }),
    vscode.commands.registerCommand("redmine.adHocOff", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.setAdHoc", { id: issue.id, value: false });
      }
    }),
    // Sidebar On/Off commands for Precedence
    vscode.commands.registerCommand("redmine.precedenceOn", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.setPrecedence", { id: issue.id, value: true });
      }
    }),
    vscode.commands.registerCommand("redmine.precedenceOff", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.setPrecedence", { id: issue.id, value: false });
      }
    }),
    // Update Issue for sidebar (opens issue controller)
    vscode.commands.registerCommand("redmine.updateIssue", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmine.issueActions", false, {}, `${issue.id}`);
      }
    })
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
