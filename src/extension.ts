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
import { runMigration } from "./utilities/migration";

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
  // Run migration from redmine.* to redmyne.* namespace (one-time on upgrade)
  runMigration(context);

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

  // Initialize timer controller with settings from globalState
  const unitDuration = context.globalState.get<number>("redmyne.timer.unitDuration", 60);
  const workDuration = Math.max(1, Math.min(
    context.globalState.get<number>("redmyne.timer.workDuration", 45),
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
      const soundEnabled = context.globalState.get<boolean>("redmyne.timer.soundEnabled", true);
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
          vscode.commands.executeCommand("redmyne.refreshGanttData");
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
      const soundEnabled = context.globalState.get<boolean>("redmyne.timer.soundEnabled", true);
      if (soundEnabled) {
        playCompletionSound();
      }
      vscode.window.showInformationMessage("Break over! Ready to start next task.");
    })
  );

  const kanbanTreeProvider = new KanbanTreeProvider(kanbanController, context.globalState);
  cleanupResources.kanbanTreeProvider = kanbanTreeProvider;

  cleanupResources.kanbanTreeView = vscode.window.createTreeView("redmyne-explorer-kanban", {
    treeDataProvider: kanbanTreeProvider,
    dragAndDropController: kanbanTreeProvider,
    canSelectMany: true,
  });
  context.subscriptions.push(cleanupResources.kanbanTreeView);

  // Update context for "Clear Done" button visibility
  const updateKanbanContext = () => {
    const tasks = kanbanController.getTasks();
    const hasDone = tasks.some((t) => getTaskStatus(t) === "done");
    vscode.commands.executeCommand("setContext", "redmyne:hasKanbanDoneTasks", hasDone);
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
      kanbanTreeProvider
    )
  );

  // Register time entry commands
  registerTimeEntryCommands(context, {
    getServer: () => projectsTree.server,
    refreshTree: () => {
      myTimeEntriesTree.refresh();
      // Also refresh Gantt if open (time entries affect contribution data)
      vscode.commands.executeCommand("redmyne.refreshGanttData");
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
  vscode.window.registerWebviewPanelSerializer("redmyneGantt", {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
      // Restore panel with loading skeleton
      const ganttPanel = GanttPanel.restore(panel, context.extensionUri, projectsTree.server);
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
    vscode.commands.executeCommand("redmyne.refreshGanttData");
  });

  // Listen for secret changes
  context.subscriptions.push(
    secretManager.onSecretChanged(() => {
      updateConfiguredContext();
    })
  );

  // Check if configured and update context
  const updateConfiguredContext = async () => {
    const config = vscode.workspace.getConfiguration("redmyne");
    const hasUrl = !!config.get<string>("url");
    const apiKey = await secretManager.getApiKey();
    const isConfigured = hasUrl && !!apiKey;

    // Set context in parallel with server init (no await needed)
    vscode.commands.executeCommand(
      "setContext",
      "redmyne:configured",
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

    const config = vscode.workspace.getConfiguration("redmyne");
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
        `redmyne.${name}`,
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
      vscode.commands.executeCommand("redmyne.refreshGantt");
    }
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
    vscode.commands.registerCommand("redmyne.openIssueInBrowser", async (issue: { id: number } | undefined) => {
      if (!issue?.id) {
        vscode.window.showErrorMessage('Could not determine issue ID');
        return;
      }
      const url = vscode.workspace.getConfiguration("redmyne").get<string>("url");
      if (!url) {
        vscode.window.showErrorMessage('No Redmine URL configured');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(`${url}/issues/${issue.id}`));
    })
  );

  // Copy issue URL to clipboard (context menu - receives tree element directly)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.copyIssueUrl", async (issue: { id: number } | undefined) => {
      if (!issue?.id) {
        vscode.window.showErrorMessage('Could not determine issue ID');
        return;
      }
      const url = vscode.workspace.getConfiguration("redmyne").get<string>("url");
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
    vscode.commands.registerCommand("redmyne.copyIssueId", async (issue: { id: number } | undefined) => {
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
    vscode.commands.registerCommand("redmyne.copyProjectId", async (project: { id: number } | undefined) => {
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
    vscode.commands.registerCommand("redmyne.copyProjectUrl", async (project: { id: number; identifier?: string } | undefined) => {
      if (!project?.identifier) {
        vscode.window.showErrorMessage('Could not determine project identifier');
        return;
      }
      const url = vscode.workspace.getConfiguration("redmyne").get<string>("url");
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
      "redmyne.setDoneRatio",
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
          vscode.commands.executeCommand("redmyne.refreshGanttData");
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update: ${error}`);
        }
      }
    )
  );

  // Set status for issue (sidebar context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "redmyne.setStatus",
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
          vscode.commands.executeCommand("redmyne.refreshGanttData");
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update: ${error}`);
        }
      }
    )
  );

  // Bulk set done ratio for multiple issues (Gantt multi-select)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.bulkSetDoneRatio", async (issueIds: number[]) => {
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
        vscode.commands.executeCommand("redmyne.refreshGanttData");
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to update: ${error}`);
      }
    })
  );

  // Set issue status (context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "redmyne.setIssueStatus",
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
          vscode.commands.executeCommand("redmyne.refreshGanttData");
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update status: ${error}`);
        }
      }
    )
  );

  // Open project in browser (context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.openProjectInBrowser", async (node: { project?: { identifier?: string } } | undefined) => {
      const identifier = node?.project?.identifier;
      if (!identifier) {
        vscode.window.showErrorMessage("Could not determine project identifier");
        return;
      }
      const url = vscode.workspace.getConfiguration("redmyne").get<string>("url");
      if (!url) {
        vscode.window.showErrorMessage("No Redmine URL configured");
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(`${url}/projects/${identifier}`));
    })
  );

  // Show project in Gantt (context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.showProjectInGantt", async (node: { project?: { id?: number }; id?: number } | undefined) => {
      const projectId = node?.project?.id ?? node?.id;
      if (!projectId) {
        vscode.window.showErrorMessage("Could not determine project ID");
        return;
      }
      // Open Gantt and switch to project view with this project selected
      await vscode.commands.executeCommand("redmyne.showGantt");
      GanttPanel.currentPanel?.showProject(projectId);
    })
  );

  // Reveal issue in tree (from Gantt context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.revealIssueInTree", async (issueId: number) => {
      if (!issueId) return;
      // Find the issue in the tree data (search both assigned and dependency issues)
      const assignedIssues = projectsTree.getAssignedIssues();
      const dependencyIssues = projectsTree.getDependencyIssues();
      const issue = assignedIssues.find((i: Issue) => i.id === issueId)
        ?? dependencyIssues.find((i: Issue) => i.id === issueId);
      if (issue && cleanupResources.projectsTreeView) {
        // Focus the Issues view first, then reveal
        await vscode.commands.executeCommand("redmyne-explorer-projects.focus");
        await cleanupResources.projectsTreeView.reveal(issue, { select: true, focus: true, expand: true });
      }
    })
  );

  // Reveal project in tree (from Gantt context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.revealProjectInTree", async (projectId: number) => {
      if (!projectId) return;
      // Find the project in the tree data
      const projects = projectsTree.getProjects();
      const project = projects.find((p) => p.id === projectId);
      if (project && cleanupResources.projectsTreeView) {
        // Focus the Issues view first, then reveal
        await vscode.commands.executeCommand("redmyne-explorer-projects.focus");
        await cleanupResources.projectsTreeView.reveal(project, { select: true, focus: true, expand: true });
      }
    })
  );

  // Toggle auto-update %done for issue (opt-in per issue)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.toggleAutoUpdateDoneRatio", async (issue: { id: number } | undefined) => {
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
    vscode.commands.registerCommand("redmyne.toggleAdHoc", toggleAdHoc)
  );

  // Contribute time entry hours to another issue
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.contributeToIssue", (item) =>
      contributeToIssue(item, myTimeEntriesTree.server, () => {
        myTimeEntriesTree.refresh();
        vscode.commands.executeCommand("redmyne.refreshGanttData");
      })
    )
  );

  // Remove contribution from time entry
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.removeContribution", (item) =>
      removeContribution(item, myTimeEntriesTree.server, () => {
        myTimeEntriesTree.refresh();
        vscode.commands.executeCommand("redmyne.refreshGanttData");
      })
    )
  );

  // Toggle precedence priority (for tree views)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.togglePrecedence", async (issue: { id: number } | undefined) => {
      if (!issue?.id) {
        vscode.window.showErrorMessage("Could not determine issue ID");
        return;
      }
      const isNow = await togglePrecedence(context.globalState, issue.id);
      showStatusBarMessage(
        isNow ? `$(check) #${issue.id} tagged with precedence` : `$(check) #${issue.id} precedence removed`,
        2000
      );
      vscode.commands.executeCommand("redmyne.refreshGanttData");
    })
  );

  // Set issue priority (pattern-based or picker)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "redmyne.setIssuePriority",
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
          vscode.commands.executeCommand("redmyne.refreshGanttData");
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update priority: ${error}`);
        }
      }
    )
  );

  // Set auto-update %done (explicit on/off)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "redmyne.setAutoUpdateDoneRatio",
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
      "redmyne.setAdHoc",
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
        vscode.commands.executeCommand("redmyne.refreshGanttData");
      }
    )
  );

  // Set precedence (explicit on/off)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "redmyne.setPrecedence",
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
        vscode.commands.executeCommand("redmyne.refreshGanttData");
      }
    )
  );

  // Gantt webview context menu commands
  // These receive { webviewSection, issueId } from data-vscode-context
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.gantt.updateIssue", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.openActionsForIssue", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.openInBrowser", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.openIssueInBrowser", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.showInIssues", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.revealIssueInTree", ctx.issueId);
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.logTime", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.quickLogTime", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setDoneRatio", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setDoneRatio", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setStatus", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setStatus", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setIssuePriority", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: ctx.issueId });
      }
    }),
    // Submenu commands for quick % Done selection
    ...[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((pct) =>
      vscode.commands.registerCommand(`redmyne.gantt.setDoneRatio${pct}`, (ctx: { issueId: number }) => {
        if (ctx?.issueId) {
          vscode.commands.executeCommand("redmyne.setDoneRatio", { id: ctx.issueId, percentage: pct });
        }
      })
    ),
    vscode.commands.registerCommand("redmyne.gantt.setDoneRatioCustom", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setDoneRatio", { id: ctx.issueId });
      }
    }),
    // Submenu commands for quick status selection
    vscode.commands.registerCommand("redmyne.gantt.setStatusNew", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssueStatus", { id: ctx.issueId, statusPattern: "new" });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setStatusInProgress", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssueStatus", { id: ctx.issueId, statusPattern: "in_progress" });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setStatusClosed", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssueStatus", { id: ctx.issueId, statusPattern: "closed" });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setStatusOther", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssueStatus", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.toggleAutoUpdate", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.toggleAutoUpdateDoneRatio", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.toggleAdHoc", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.toggleAdHoc", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.togglePrecedence", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.togglePrecedence", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.copyUrl", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.copyIssueUrl", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.copyIssueId", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.env.clipboard.writeText(`#${ctx.issueId}`);
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.copyProjectId", (ctx: { projectId: number }) => {
      if (ctx?.projectId) {
        vscode.env.clipboard.writeText(`#${ctx.projectId}`);
      }
    }),
    vscode.commands.registerCommand(
      "redmyne.gantt.copyProjectUrl",
      (ctx: { projectId: number; projectIdentifier: string }) => {
        if (ctx?.projectIdentifier) {
          const url = vscode.workspace.getConfiguration("redmyne").get<string>("url");
          if (url) {
            const projectUrl = `${url}/projects/${ctx.projectIdentifier}`;
            vscode.env.clipboard.writeText(projectUrl);
            showStatusBarMessage("$(check) Copied project URL", 2000);
          }
        }
      }
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.createSubIssue",
      (ctx: { issueId: number; projectId: number }) => {
        if (ctx?.issueId && ctx?.projectId) {
          vscode.commands.executeCommand("redmyne.quickCreateSubIssue", {
            id: ctx.issueId,
            project: { id: ctx.projectId },
          });
        }
      }
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.openProjectInBrowser",
      (ctx: { projectId: number; projectIdentifier: string }) => {
        if (ctx?.projectIdentifier) {
          vscode.commands.executeCommand("redmyne.openProjectInBrowser", {
            project: { identifier: ctx.projectIdentifier },
          });
        }
      }
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.showProjectInGantt",
      (ctx: { projectId: number; projectIdentifier: string }) => {
        if (ctx?.projectId) {
          vscode.commands.executeCommand("redmyne.showProjectInGantt", {
            project: { id: ctx.projectId },
          });
        }
      }
    ),
    vscode.commands.registerCommand(
      "redmyne.gantt.showProjectInIssues",
      (ctx: { projectId: number }) => {
        if (ctx?.projectId) {
          vscode.commands.executeCommand("redmyne.revealProjectInTree", ctx.projectId);
        }
      }
    ),
    // Priority submenu commands for Gantt
    vscode.commands.registerCommand("redmyne.gantt.setPriorityLow", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: ctx.issueId, priorityPattern: "low" });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setPriorityNormal", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: ctx.issueId, priorityPattern: "normal" });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setPriorityHigh", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: ctx.issueId, priorityPattern: "high" });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setPriorityUrgent", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: ctx.issueId, priorityPattern: "urgent" });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setPriorityImmediate", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: ctx.issueId, priorityPattern: "immediate" });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.setPriorityOther", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: ctx.issueId });
      }
    }),
    // Auto-update On/Off for Gantt
    vscode.commands.registerCommand("redmyne.gantt.autoUpdateOn", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setAutoUpdateDoneRatio", { id: ctx.issueId, value: true });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.autoUpdateOff", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setAutoUpdateDoneRatio", { id: ctx.issueId, value: false });
      }
    }),
    // Ad-hoc On/Off for Gantt
    vscode.commands.registerCommand("redmyne.gantt.adHocOn", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setAdHoc", { id: ctx.issueId, value: true });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.adHocOff", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setAdHoc", { id: ctx.issueId, value: false });
      }
    }),
    // Precedence On/Off for Gantt
    vscode.commands.registerCommand("redmyne.gantt.precedenceOn", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setPrecedence", { id: ctx.issueId, value: true });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.precedenceOff", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setPrecedence", { id: ctx.issueId, value: false });
      }
    }),
    // Internal Estimate for Gantt
    vscode.commands.registerCommand("redmyne.gantt.setInternalEstimate", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.setInternalEstimate", { id: ctx.issueId });
      }
    }),
    vscode.commands.registerCommand("redmyne.gantt.clearInternalEstimate", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.clearInternalEstimate", { id: ctx.issueId });
      }
    }),
    // Add to Kanban for Gantt
    vscode.commands.registerCommand("redmyne.gantt.addToKanban", (ctx: { issueId: number }) => {
      if (ctx?.issueId) {
        vscode.commands.executeCommand("redmyne.addIssueToKanban", { id: ctx.issueId });
      }
    }),
    // Create Issue for Gantt project context
    vscode.commands.registerCommand("redmyne.gantt.createIssue", (ctx: { projectId: number }) => {
      if (ctx?.projectId) {
        vscode.commands.executeCommand("redmyne.quickCreateIssue", { project: { id: ctx.projectId } });
      }
    }),
    // Create Version for Gantt project context
    vscode.commands.registerCommand("redmyne.gantt.createVersion", (ctx: { projectId: number }) => {
      if (ctx?.projectId) {
        vscode.commands.executeCommand("redmyne.quickCreateVersion", { project: { id: ctx.projectId } });
      }
    }),
    // Sidebar submenu commands for % Done
    ...[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((pct) =>
      vscode.commands.registerCommand(`redmyne.setDoneRatio${pct}`, (issue: { id: number }) => {
        if (issue?.id) {
          vscode.commands.executeCommand("redmyne.setDoneRatio", { id: issue.id, percentage: pct });
        }
      })
    ),
    vscode.commands.registerCommand("redmyne.setDoneRatioCustom", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setDoneRatio", { id: issue.id });
      }
    }),
    // Sidebar submenu commands for Status
    vscode.commands.registerCommand("redmyne.setStatusNew", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssueStatus", { id: issue.id, statusPattern: "new" });
      }
    }),
    vscode.commands.registerCommand("redmyne.setStatusInProgress", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssueStatus", { id: issue.id, statusPattern: "in_progress" });
      }
    }),
    vscode.commands.registerCommand("redmyne.setStatusClosed", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssueStatus", { id: issue.id, statusPattern: "closed" });
      }
    }),
    vscode.commands.registerCommand("redmyne.setStatusOther", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssueStatus", { id: issue.id });
      }
    }),
    // Sidebar submenu commands for Priority
    vscode.commands.registerCommand("redmyne.setPriorityLow", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: issue.id, priorityPattern: "low" });
      }
    }),
    vscode.commands.registerCommand("redmyne.setPriorityNormal", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: issue.id, priorityPattern: "normal" });
      }
    }),
    vscode.commands.registerCommand("redmyne.setPriorityHigh", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: issue.id, priorityPattern: "high" });
      }
    }),
    vscode.commands.registerCommand("redmyne.setPriorityUrgent", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: issue.id, priorityPattern: "urgent" });
      }
    }),
    vscode.commands.registerCommand("redmyne.setPriorityImmediate", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: issue.id, priorityPattern: "immediate" });
      }
    }),
    vscode.commands.registerCommand("redmyne.setPriorityOther", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setIssuePriority", { id: issue.id });
      }
    }),
    // Sidebar On/Off commands for Auto-update
    vscode.commands.registerCommand("redmyne.autoUpdateOn", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setAutoUpdateDoneRatio", { id: issue.id, value: true });
      }
    }),
    vscode.commands.registerCommand("redmyne.autoUpdateOff", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setAutoUpdateDoneRatio", { id: issue.id, value: false });
      }
    }),
    // Sidebar On/Off commands for Ad-hoc
    vscode.commands.registerCommand("redmyne.adHocOn", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setAdHoc", { id: issue.id, value: true });
      }
    }),
    vscode.commands.registerCommand("redmyne.adHocOff", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setAdHoc", { id: issue.id, value: false });
      }
    }),
    // Sidebar On/Off commands for Precedence
    vscode.commands.registerCommand("redmyne.precedenceOn", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setPrecedence", { id: issue.id, value: true });
      }
    }),
    vscode.commands.registerCommand("redmyne.precedenceOff", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.setPrecedence", { id: issue.id, value: false });
      }
    }),
    // Update Issue for sidebar (opens issue controller)
    vscode.commands.registerCommand("redmyne.updateIssue", (issue: { id: number }) => {
      if (issue?.id) {
        vscode.commands.executeCommand("redmyne.issueActions", false, {}, `${issue.id}`);
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
