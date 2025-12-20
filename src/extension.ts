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
import { RedmineConfig } from "./definitions/redmine-config";
import { ActionProperties } from "./commands/action-properties";
import { ProjectsTree, ProjectsViewStyle } from "./trees/projects-tree";
import { MyTimeEntriesTreeDataProvider } from "./trees/my-time-entries-tree";
import { RedmineSecretManager } from "./utilities/secret-manager";
import { setApiKey } from "./commands/set-api-key";
import { calculateWorkload } from "./utilities/workload-calculator";
import { WeeklySchedule } from "./utilities/flexibility-calculator";
import { GanttPanel } from "./webviews/gantt-panel";
import { disposeStatusBar, showStatusBarMessage } from "./utilities/status-bar";

// Constants
const CONFIG_DEBOUNCE_MS = 300;
const SERVER_CACHE_SIZE = 3;

// Module-level cleanup resources
let cleanupResources: {
  projectsTree?: ProjectsTree;
  myTimeEntriesTree?: MyTimeEntriesTreeDataProvider;
  projectsTreeView?: vscode.TreeView<unknown>;
  myTimeEntriesTreeView?: vscode.TreeView<unknown>;
  workloadStatusBar?: vscode.StatusBarItem;
  configChangeTimeout?: ReturnType<typeof setTimeout>;
  bucket?: {
    servers: RedmineServer[];
    projects: RedmineProject[];
  };
} = {};

export function activate(context: vscode.ExtensionContext): void {
  console.log("Redmyne: activate() called");

  const bucket = {
    servers: [] as RedmineServer[],
    projects: [] as RedmineProject[],
  };
  cleanupResources.bucket = bucket;

  const secretManager = new RedmineSecretManager(context);
  const outputChannel = vscode.window.createOutputChannel("Redmine API");

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

  // Initialize workload status bar (opt-in via config)
  const initializeWorkloadStatusBar = () => {
    const config = vscode.workspace.getConfiguration("redmine.statusBar");
    const showWorkload = config.get<boolean>("showWorkload", false);

    // Dispose existing if disabled
    if (!showWorkload && cleanupResources.workloadStatusBar) {
      cleanupResources.workloadStatusBar.dispose();
      cleanupResources.workloadStatusBar = undefined;
      return;
    }

    if (!showWorkload) return;

    // Create status bar if not exists
    if (!cleanupResources.workloadStatusBar) {
      cleanupResources.workloadStatusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        50 // Lower priority to not compete with core features
      );
      cleanupResources.workloadStatusBar.command = "redmine.listOpenIssuesAssignedToMe";
      context.subscriptions.push(cleanupResources.workloadStatusBar);
    }
  };

  // Update workload status bar content
  const updateWorkloadStatusBar = async () => {
    const statusBar = cleanupResources.workloadStatusBar;
    if (!statusBar) return;

    // Fetch issues if not cached (triggers initial load)
    const issues = await projectsTree.fetchIssuesIfNeeded();

    // Re-check after await - status bar might have been disposed
    if (!cleanupResources.workloadStatusBar) return;

    if (issues.length === 0) {
      statusBar.hide();
      return;
    }

    const scheduleConfig = vscode.workspace.getConfiguration("redmine.workingHours");
    const schedule = scheduleConfig.get<WeeklySchedule>("weeklySchedule", {
      Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8, Sat: 0, Sun: 0,
    });

    const workload = calculateWorkload(issues, schedule);

    // Text format: "25h left, +8h buffer"
    const bufferText = workload.buffer >= 0 ? `+${workload.buffer}h` : `${workload.buffer}h`;
    statusBar.text = `$(pulse) ${workload.remaining}h left, ${bufferText} buffer`;

    // Rich tooltip with top 3 urgent
    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = true;
    tooltip.appendMarkdown("**Workload Overview**\n\n");
    tooltip.appendMarkdown(`**Remaining work:** ${workload.remaining}h\n\n`);
    tooltip.appendMarkdown(`**Available this week:** ${workload.availableThisWeek}h\n\n`);
    tooltip.appendMarkdown(`**Buffer:** ${bufferText} ${workload.buffer >= 0 ? "(On Track)" : "(Overbooked)"}\n\n`);

    if (workload.topUrgent.length > 0) {
      tooltip.appendMarkdown("**Top Urgent:**\n");
      for (const issue of workload.topUrgent) {
        tooltip.appendMarkdown(`- #${issue.id}: ${issue.daysLeft}d, ${issue.hoursLeft}h left\n`);
      }
    }

    statusBar.tooltip = tooltip;
    statusBar.show();
  };

  // Initialize status bar and trigger initial load
  initializeWorkloadStatusBar();
  updateWorkloadStatusBar();

  // Update on tree refresh
  projectsTree.onDidChangeTreeData$.event(() => {
    if (cleanupResources.workloadStatusBar) {
      updateWorkloadStatusBar();
    }
  });

  // Listen for secret changes
  context.subscriptions.push(
    secretManager.onSecretChanged(() => {
      updateConfiguredContext();
    })
  );

  // Check if configured and update context
  const updateConfiguredContext = async () => {
    const folders = vscode.workspace.workspaceFolders || [];
    const folder = folders[0];

    if (!folder) {
      await vscode.commands.executeCommand(
        "setContext",
        "redmine:configured",
        false
      );
      return;
    }

    const config = vscode.workspace.getConfiguration("redmine", folder.uri);
    const hasUrl = !!config.get<string>("url");
    const apiKey = await secretManager.getApiKey(folder.uri);
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
        projectsTree.onDidChangeTreeData$.fire();
        myTimeEntriesTree.refresh();
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
          initializeWorkloadStatusBar();
          updateWorkloadStatusBar();
        }
        // Update status bar on schedule change
        if (event.affectsConfiguration("redmine.workingHours")) {
          updateWorkloadStatusBar();
        }
      }, CONFIG_DEBOUNCE_MS);
    })
  );

  // Register configure command
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.configure", async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage("Please open a workspace folder first");
        return;
      }

      const folder =
        folders.length === 1
          ? folders[0]
          : await vscode.window.showWorkspaceFolderPick();
      if (!folder) return;

      const config = vscode.workspace.getConfiguration("redmine", folder.uri);
      const existingUrl = config.get<string>("url");
      const existingApiKey = await secretManager.getApiKey(folder.uri);

      let url = existingUrl;
      let shouldUpdateApiKey = false;

      // Determine what needs to be configured
      if (existingUrl && existingApiKey) {
        // Both exist - ask what to update
        const choice = await vscode.window.showQuickPick(
          [
            {
              label: "$(link) Update Redmine URL",
              description: `Current: ${existingUrl}`,
              value: "url",
            },
            {
              label: "$(key) Update API Key",
              description: "Stored securely in secrets",
              value: "apiKey",
            },
            { label: "$(settings-gear) Reconfigure Both", value: "both" },
          ],
          {
            title: "Redmine Configuration",
            placeHolder: "What would you like to update?",
          }
        );

        if (!choice) return;

        if (choice.value === "url" || choice.value === "both") {
          url = await promptForUrl(existingUrl);
          if (!url) return;
          await config.update("url", url, vscode.ConfigurationTarget.Global);
        }

        shouldUpdateApiKey =
          choice.value === "apiKey" || choice.value === "both";
      } else if (existingUrl && !existingApiKey) {
        // URL exists, just need API key - but let them update URL too
        const choice = await vscode.window.showQuickPick(
          [
            {
              label: "$(check) Keep Current URL",
              description: existingUrl,
              value: "keep",
            },
            { label: "$(link) Change URL", value: "change" },
          ],
          {
            title: "Redmine Configuration",
            placeHolder:
              "Your Redmine URL is configured. Do you want to change it?",
          }
        );

        if (!choice) return;

        if (choice.value === "change") {
          url = await promptForUrl(existingUrl);
          if (!url) return;
          await config.update("url", url, vscode.ConfigurationTarget.Global);
        }

        shouldUpdateApiKey = true;
      } else if (!existingUrl && existingApiKey) {
        // Invalid state: API key exists but no URL - API key is server-specific
        const action = await vscode.window.showWarningMessage(
          "Invalid configuration detected",
          {
            modal: true,
            detail:
              "An API key exists but no Redmine URL is configured. API keys are specific to a Redmine server.\n\nWould you like to reconfigure from scratch?",
          },
          "Reconfigure",
          "Cancel"
        );

        if (action !== "Reconfigure") return;

        // Delete orphaned API key
        await secretManager.deleteApiKey(folder.uri);

        // Start fresh
        url = await promptForUrl();
        if (!url) return;
        await config.update("url", url, vscode.ConfigurationTarget.Global);
        shouldUpdateApiKey = true;
      } else {
        // Nothing configured - full flow, show security info
        const proceed = await vscode.window.showInformationMessage(
          "Secure Configuration",
          {
            modal: true,
            detail:
              "How your credentials are stored:\n\n• URL: User settings (settings.json)\n• API Key: Encrypted secrets storage\n  - Windows: Credential Manager\n  - macOS: Keychain\n  - Linux: libsecret\n\nAPI keys are machine-local and never synced to the cloud.",
          },
          "Continue",
          "Cancel"
        );

        if (proceed !== "Continue") return;

        url = await promptForUrl();
        if (!url) return;
        await config.update("url", url, vscode.ConfigurationTarget.Global);
        shouldUpdateApiKey = true;
      }

      // Prompt for API Key if needed
      if (shouldUpdateApiKey && url) {
        const success = await promptForApiKey(secretManager, folder.uri, url);
        if (!success) return;
      }

      // Update context and refresh trees
      await updateConfiguredContext();

      showStatusBarMessage("$(check) Redmine configured", 3000);
    })
  );

  async function promptForUrl(
    currentUrl?: string
  ): Promise<string | undefined> {
    const prompt = currentUrl
      ? "Update your Redmine server URL (changing URL will require new API key)"
      : "Step 1/2: Enter your Redmine server URL (HTTPS required)";

    return await vscode.window.showInputBox({
      prompt,
      value: currentUrl,
      placeHolder: "https://redmine.example.com",
      validateInput: (value) => {
        if (!value) return "URL cannot be empty";
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          return "Invalid URL format";
        }
        if (url.protocol !== "https:") {
          return "HTTPS required. URL must start with https://";
        }
        return null;
      },
    });
  }

  async function promptForApiKey(
    manager: RedmineSecretManager,
    folderUri: vscode.Uri,
    url: string
  ): Promise<boolean> {
    // Explain how to get API key
    const action = await vscode.window.showInformationMessage(
      "You need your Redmine API key",
      {
        modal: true,
        detail:
          'Your API key can be found in your Redmine account settings.\n\nClick "Open Redmine" to open your account page, then copy your API key and paste it in the next step.',
      },
      "Open Redmine Account",
      "I Have My Key"
    );

    if (!action) return false;

    if (action === "Open Redmine Account") {
      await vscode.env.openExternal(vscode.Uri.parse(`${url}/my/account`));
      await vscode.window.showInformationMessage(
        'Copy your API key from the "API access key" section on the right side of the page.',
        { modal: false },
        "Got It"
      );
    }

    // Prompt for API Key
    const apiKey = await vscode.window.showInputBox({
      prompt: "Paste your Redmine API key",
      placeHolder: "e.g., a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0",
      password: true,
      validateInput: (value) => {
        if (!value) return "API key cannot be empty";
        if (value.length < 20) return "API key appears too short";
        return null;
      },
    });

    if (!apiKey) return false;

    await manager.setApiKey(folderUri, apiKey);
    return true;
  }

  // Register set API key command
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.setApiKey", async () => {
      await setApiKey(context);
      await updateConfiguredContext();
    })
  );

  vscode.commands.executeCommand(
    "setContext",
    "redmine:hasSingleConfig",
    (vscode.workspace.workspaceFolders?.length ?? 0) <= 1
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

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showErrorMessage("Please open a workspace folder first");
      return Promise.resolve({ props: undefined, args: [] });
    }

    const pickedFolder =
      folders.length === 1
        ? folders[0]
        : await vscode.window.showWorkspaceFolderPick();

    if (!pickedFolder) {
      return Promise.resolve({ props: undefined, args: [] });
    }

    vscode.commands.executeCommand(
      "setContext",
      "redmine:hasSingleConfig",
      !pickedFolder
    );

    const config = vscode.workspace.getConfiguration(
      "redmine",
      pickedFolder.uri
    ) as RedmineConfig;

    // Get API key from secrets - NO auto-migration
    const apiKey = await secretManager.getApiKey(pickedFolder.uri);

    if (!apiKey) {
      vscode.window.showErrorMessage(
        'No API key configured. Run "Redmine: Set API Key"'
      );
      return Promise.resolve({ props: undefined, args: [] });
    }

    const redmineServer = createServer({
      address: config.url,
      key: apiKey,
      additionalHeaders: config.additionalHeaders,
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
        config,
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
  registerCommand("quickCreateIssue", async (props) => {
    const created = await quickCreateIssue(props);
    if (created) {
      // Refresh issues to show newly created issue
      projectsTree.clearProjects();
      projectsTree.onDidChangeTreeData$.fire();
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
      projectsTree.onDidChangeTreeData$.fire();
    }
  });
  registerCommand("changeDefaultServer", (conf) => {
    projectsTree.setServer(conf.server);
    myTimeEntriesTree.setServer(conf.server);

    projectsTree.onDidChangeTreeData$.fire();
    myTimeEntriesTree.refresh();
  });

  registerCommand("refreshTimeEntries", () => {
    myTimeEntriesTree.refresh();
  });

  registerCommand("openTimeEntryInBrowser", async (props: ActionProperties, ...args: unknown[]) => {
    let issueId: number | undefined;

    // Handle context menu (tree node with _entry)
    if (args[0] && typeof args[0] === 'object' && '_entry' in args[0]) {
      const node = args[0] as { _entry: { issue_id: number } };
      issueId = node._entry.issue_id;
    }
    // Handle command URI (VS Code passes parsed JSON as first arg)
    else if (args[0] && typeof args[0] === 'number') {
      issueId = args[0];
    }
    // Handle command URI with object (legacy/alternative format)
    else if (args[0] && typeof args[0] === 'object' && 'issue_id' in args[0]) {
      const params = args[0] as { issue_id: number };
      issueId = params.issue_id;
    }
    // Handle string that needs parsing
    else if (typeof args[0] === 'string') {
      const parsed = parseInt(args[0], 10);
      if (!isNaN(parsed)) {
        issueId = parsed;
      }
    }

    if (!issueId) {
      vscode.window.showErrorMessage('Could not determine issue ID');
      return;
    }

    await vscode.env.openExternal(vscode.Uri.parse(`${props.server.options.address}/issues/${issueId}`));
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
  // Debounce refresh to prevent rapid-fire API calls
  let refreshTimeout: ReturnType<typeof setTimeout> | null = null;

  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.refreshIssues", () => {
      if (refreshTimeout) {
        clearTimeout(refreshTimeout);
      }
      refreshTimeout = setTimeout(() => {
        projectsTree.clearProjects();
        projectsTree.onDidChangeTreeData$.fire();
      }, CONFIG_DEBOUNCE_MS);
    }),
    vscode.commands.registerCommand("redmine.toggleTreeView", () => {
      vscode.commands.executeCommand(
        "setContext",
        "redmine:treeViewStyle",
        ProjectsViewStyle.LIST
      );
      projectsTree.setViewStyle(ProjectsViewStyle.LIST);
    }),
    vscode.commands.registerCommand("redmine.toggleListView", () => {
      vscode.commands.executeCommand(
        "setContext",
        "redmine:treeViewStyle",
        ProjectsViewStyle.TREE
      );
      projectsTree.setViewStyle(ProjectsViewStyle.TREE);
    }),
    vscode.commands.registerCommand("redmine.showApiOutput", () => {
      outputChannel.show();
    }),
    vscode.commands.registerCommand("redmine.clearApiOutput", () => {
      outputChannel.clear();
      showStatusBarMessage("$(check) API output cleared", 2000);
    }),
    vscode.commands.registerCommand("redmine.toggleApiLogging", async () => {
      const config = vscode.workspace.getConfiguration("redmine");
      const currentValue = config.get<boolean>("logging.enabled") || false;
      await config.update(
        "logging.enabled",
        !currentValue,
        vscode.ConfigurationTarget.Global
      );
      showStatusBarMessage(
        `$(check) API logging ${!currentValue ? "enabled" : "disabled"}`,
        2000
      );
      // Refresh trees to use new server instances
      await updateConfiguredContext();
    }),

    // Create test issues command
    vscode.commands.registerCommand("redmine.createTestIssues", async () => {
      const server = projectsTree.server;
      if (!server) {
        vscode.window.showErrorMessage("Redmine not configured. Run 'Redmine: Configure' first.");
        return;
      }

      // Confirm with user
      const confirm = await vscode.window.showWarningMessage(
        "Create test issues for integration testing?",
        { modal: true, detail: "This will create 10 test issues in the Operations project." },
        "Create Issues",
        "Cancel"
      );
      if (confirm !== "Create Issues") return;

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Creating test issues",
        cancellable: false
      }, async (progress) => {
        try {
          // Fetch required data
          progress.report({ message: "Fetching metadata..." });
          const [projects, trackers, statuses, priorities] = await Promise.all([
            server.getProjects(),
            server.getTrackers(),
            server.getIssueStatuses(),
            server.getPriorities()
          ]);

          // Find Operations project
          const operationsProject = projects.find(p => {
            const pick = p.toQuickPickItem();
            return pick.label === "Operations" || pick.identifier === "operations";
          });
          if (!operationsProject) {
            vscode.window.showErrorMessage(
              `Operations project not found. Available: ${projects.map(p => p.toQuickPickItem().label).join(", ")}`
            );
            return;
          }

          // Find required IDs
          const taskTracker = trackers.find(t => t.name.toLowerCase().includes("task"));
          const inProgressStatus = statuses.issue_statuses.find(s => s.name.toLowerCase().includes("progress"));
          const newStatus = statuses.issue_statuses.find(s =>
            s.name.toLowerCase() === "new" || s.name.toLowerCase().includes("not yet")
          );
          const normalPriority = priorities.find(p => p.name.toLowerCase() === "normal");
          const highPriority = priorities.find(p => p.name.toLowerCase() === "high");
          const urgentPriority = priorities.find(p => p.name.toLowerCase() === "urgent");
          const lowPriority = priorities.find(p => p.name.toLowerCase() === "low");

          if (!taskTracker) {
            vscode.window.showErrorMessage("Task tracker not found");
            return;
          }

          // Date helpers
          const today = () => new Date().toISOString().split("T")[0];
          const addDays = (date: string, days: number) => {
            const d = new Date(date);
            d.setDate(d.getDate() + days);
            return d.toISOString().split("T")[0];
          };
          const nextFriday = () => {
            const d = new Date();
            const day = d.getDay();
            const daysUntilFriday = (5 - day + 7) % 7 || 7;
            d.setDate(d.getDate() + daysUntilFriday);
            return d.toISOString().split("T")[0];
          };

          const TEST_PREFIX = "[TEST]";
          const todayStr = today();

          // Define test issues
          const testIssues = [
            {
              subject: `${TEST_PREFIX} High intensity task`,
              start_date: todayStr,
              due_date: addDays(todayStr, 2),
              estimated_hours: 24,
              status_id: inProgressStatus?.id,
              priority_id: highPriority?.id,
              description: "Test issue: 24h over 3 days = 100% intensity (8h/day)",
            },
            {
              subject: `${TEST_PREFIX} Low intensity task`,
              start_date: todayStr,
              due_date: addDays(todayStr, 9),
              estimated_hours: 8,
              status_id: newStatus?.id,
              priority_id: normalPriority?.id,
              description: "Test issue: 8h over 10 days = ~10% intensity",
            },
            {
              subject: `${TEST_PREFIX} Overbooked urgent`,
              start_date: todayStr,
              due_date: addDays(todayStr, 1),
              estimated_hours: 24,
              status_id: inProgressStatus?.id,
              priority_id: urgentPriority?.id,
              description: "Test issue: 24h over 2 days = 150% intensity (overbooked)",
            },
            {
              subject: `${TEST_PREFIX} No estimate task`,
              start_date: todayStr,
              due_date: addDays(todayStr, 5),
              estimated_hours: undefined,
              status_id: newStatus?.id,
              priority_id: lowPriority?.id,
              description: "Test issue: No estimated hours - should show 0 intensity",
            },
            {
              subject: `${TEST_PREFIX} Weekend spanning`,
              start_date: nextFriday(),
              due_date: addDays(nextFriday(), 4),
              estimated_hours: 16,
              status_id: inProgressStatus?.id,
              priority_id: normalPriority?.id,
              description: "Test issue: Spans weekend - tests weeklySchedule (0h Sat/Sun)",
            },
            {
              subject: `${TEST_PREFIX} Parent task`,
              start_date: todayStr,
              due_date: addDays(todayStr, 14),
              estimated_hours: 40,
              status_id: newStatus?.id,
              priority_id: highPriority?.id,
              description: "Test issue: Parent task with children",
              isParent: true,
            },
            {
              subject: `${TEST_PREFIX} Child task A`,
              start_date: todayStr,
              due_date: addDays(todayStr, 6),
              estimated_hours: 16,
              status_id: inProgressStatus?.id,
              priority_id: normalPriority?.id,
              description: "Test issue: Child of parent task",
              parentSubject: `${TEST_PREFIX} Parent task`,
            },
            {
              subject: `${TEST_PREFIX} Child task B`,
              start_date: addDays(todayStr, 7),
              due_date: addDays(todayStr, 14),
              estimated_hours: 24,
              status_id: newStatus?.id,
              priority_id: normalPriority?.id,
              description: "Test issue: Child of parent task",
              parentSubject: `${TEST_PREFIX} Parent task`,
            },
            {
              subject: `${TEST_PREFIX} Blocking task`,
              start_date: todayStr,
              due_date: addDays(todayStr, 3),
              estimated_hours: 8,
              status_id: inProgressStatus?.id,
              priority_id: highPriority?.id,
              description: "Test issue: Blocks another task",
              blocksSubject: `${TEST_PREFIX} Blocked task`,
            },
            {
              subject: `${TEST_PREFIX} Blocked task`,
              start_date: addDays(todayStr, 4),
              due_date: addDays(todayStr, 7),
              estimated_hours: 16,
              status_id: newStatus?.id,
              priority_id: normalPriority?.id,
              description: "Test issue: Blocked by another task",
            },
          ];

          // Create issues
          const createdIssues = new Map<string, number>();
          let created = 0;
          let failed = 0;

          for (let i = 0; i < testIssues.length; i++) {
            const issue = testIssues[i];
            progress.report({
              message: `Creating ${i + 1}/${testIssues.length}: ${issue.subject}`,
              increment: 100 / testIssues.length
            });

            // Find parent ID if needed
            let parent_issue_id: number | undefined;
            if ("parentSubject" in issue && issue.parentSubject) {
              parent_issue_id = createdIssues.get(issue.parentSubject);
            }

            try {
              const result = await server.createIssue({
                project_id: operationsProject.id,
                tracker_id: taskTracker.id,
                subject: issue.subject,
                description: issue.description,
                status_id: issue.status_id,
                priority_id: issue.priority_id,
                start_date: issue.start_date,
                due_date: issue.due_date,
                estimated_hours: issue.estimated_hours,
                parent_issue_id,
              });
              createdIssues.set(issue.subject, result.issue.id);
              created++;
            } catch (_e) {
              failed++;
            }
          }

          // Create blocking relation
          const blockingId = createdIssues.get(`${TEST_PREFIX} Blocking task`);
          const blockedId = createdIssues.get(`${TEST_PREFIX} Blocked task`);
          if (blockingId && blockedId) {
            try {
              await server.createRelation(blockingId, blockedId, "blocks");
            } catch {
              // Relation creation failed - non-critical, continue
            }
          }

          // Refresh issues
          projectsTree.clearProjects();
          projectsTree.onDidChangeTreeData$.fire();

          vscode.window.showInformationMessage(
            `Created ${created} test issues${failed > 0 ? `, ${failed} failed` : ""}`
          );
        } catch (e) {
          vscode.window.showErrorMessage(`Failed to create test issues: ${e}`);
        }
      });
    }),

    // Gantt timeline command
    vscode.commands.registerCommand("redmine.showGantt", async () => {
      // Ensure issues are fetched
      const issues = await projectsTree.fetchIssuesIfNeeded();

      if (issues.length === 0) {
        vscode.window.showInformationMessage(
          "No issues to display. Configure Redmine and assign issues to yourself."
        );
        return;
      }

      // Get working hours schedule for intensity calculation
      const scheduleConfig = vscode.workspace.getConfiguration("redmine.workingHours");
      const schedule = scheduleConfig.get<WeeklySchedule>("weeklySchedule", {
        Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8, Sat: 0, Sun: 0,
      });

      const panel = GanttPanel.createOrShow(projectsTree.server);
      panel.updateIssues(issues, projectsTree.getFlexibilityCache(), schedule);
    }),

    // Refresh Gantt data without resetting view state
    vscode.commands.registerCommand("redmine.refreshGanttData", async () => {
      const panel = GanttPanel.currentPanel;
      if (!panel) return;

      // Clear cache and re-fetch
      projectsTree.clearProjects();
      const issues = await projectsTree.fetchIssuesIfNeeded();

      if (issues.length === 0) return;

      const scheduleConfig = vscode.workspace.getConfiguration("redmine.workingHours");
      const schedule = scheduleConfig.get<WeeklySchedule>("weeklySchedule", {
        Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8, Sat: 0, Sun: 0,
      });

      panel.updateIssues(issues, projectsTree.getFlexibilityCache(), schedule);
    })
  );

  console.log("Redmyne: activation complete");
}

export function deactivate(): void {
  // Clear pending config change timeout
  if (cleanupResources.configChangeTimeout) {
    clearTimeout(cleanupResources.configChangeTimeout);
  }

  // Dispose EventEmitters in tree providers
  if (cleanupResources.projectsTree) {
    cleanupResources.projectsTree.onDidChangeTreeData$.dispose();
  }

  // Dispose tree view instances
  if (cleanupResources.projectsTreeView) {
    cleanupResources.projectsTreeView.dispose();
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
