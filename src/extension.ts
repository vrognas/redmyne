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
import { RedmineConfig } from "./definitions/redmine-config";
import { ActionProperties } from "./commands/action-properties";
import { MyIssuesTree } from "./trees/my-issues-tree";
import { ProjectsTree, ProjectsViewStyle } from "./trees/projects-tree";
import { MyTimeEntriesTreeDataProvider } from "./trees/my-time-entries-tree";
import { RedmineSecretManager } from "./utilities/secret-manager";
import { setApiKey } from "./commands/set-api-key";

// Module-level cleanup resources
let cleanupResources: {
  myIssuesTree?: MyIssuesTree;
  projectsTree?: ProjectsTree;
  myTimeEntriesTree?: MyTimeEntriesTreeDataProvider;
  myIssuesTreeView?: vscode.TreeView<unknown>;
  projectsTreeView?: vscode.TreeView<unknown>;
  myTimeEntriesTreeView?: vscode.TreeView<unknown>;
  bucket?: {
    servers: RedmineServer[];
    projects: RedmineProject[];
  };
} = {};

export function activate(context: vscode.ExtensionContext): void {
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

  const myIssuesTree = new MyIssuesTree();
  const projectsTree = new ProjectsTree();
  const myTimeEntriesTree = new MyTimeEntriesTreeDataProvider();
  cleanupResources.myIssuesTree = myIssuesTree;
  cleanupResources.projectsTree = projectsTree;
  cleanupResources.myTimeEntriesTree = myTimeEntriesTree;

  cleanupResources.myIssuesTreeView = vscode.window.createTreeView("redmine-explorer-my-issues", {
    treeDataProvider: myIssuesTree,
  });
  cleanupResources.projectsTreeView = vscode.window.createTreeView("redmine-explorer-projects", {
    treeDataProvider: projectsTree,
  });
  cleanupResources.myTimeEntriesTreeView = vscode.window.createTreeView("redmine-explorer-my-time-entries", {
    treeDataProvider: myTimeEntriesTree,
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
    const hasApiKey = !!(await secretManager.getApiKey(folder.uri));
    const isConfigured = hasUrl && hasApiKey;

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
          key: (await secretManager.getApiKey(folder.uri))!,
          additionalHeaders: config.get("additionalHeaders"),
          rejectUnauthorized: config.get("rejectUnauthorized"),
        });

        myIssuesTree.setServer(server);
        projectsTree.setServer(server);
        myTimeEntriesTree.setServer(server);
        projectsTree.onDidChangeTreeData$.fire();
        myIssuesTree.onDidChangeTreeData$.fire();
        myTimeEntriesTree.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to initialize Redmine server: ${error}`
        );
      }
    } else {
      // Clear servers when not configured (don't refresh - let welcome view show)
      myIssuesTree.setServer(undefined);
      projectsTree.setServer(undefined);
      myTimeEntriesTree.setServer(undefined);
    }
  };

  // Initial check
  updateConfiguredContext();

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("redmine")) {
        await updateConfiguredContext();
      }
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

      vscode.window.showInformationMessage(
        "Redmine configured successfully! 🎉"
      );
    })
  );

  async function promptForUrl(
    currentUrl?: string
  ): Promise<string | undefined> {
    const prompt = currentUrl
      ? "Update your Redmine server URL (changing URL will require new API key)"
      : "Step 1/2: Enter your Redmine server URL";

    return await vscode.window.showInputBox({
      prompt,
      value: currentUrl,
      placeHolder: "https://redmine.example.com",
      validateInput: (value) => {
        if (!value) return "URL cannot be empty";
        try {
          new URL(value);
          return null;
        } catch {
          return "Invalid URL format";
        }
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
    ProjectsViewStyle.LIST
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
      rejectUnauthorized: config.rejectUnauthorized,
    });

    const fromBucket = bucket.servers.find((s) => s.compare(redmineServer));
    const server = fromBucket || redmineServer;

    if (!fromBucket) {
      // LRU cache: max 3 servers
      if (bucket.servers.length >= 3) {
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

  const currentConfig = vscode.workspace.getConfiguration("redmine");

  if (currentConfig.has("serverUrl")) {
    const panel = vscode.window.createWebviewPanel(
      "redmineConfigurationUpdate",
      "vscode-redmine: New configuration arrived!",
      vscode.ViewColumn.One,
      {}
    );

    panel.webview.html = `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="X-UA-Compatible" content="ie=edge">
        <title>vscode-redmine: New configuration arrived!</title>
        <style>html, body { font-size: 16px; } p, li { line-height: 1.5; }</style>
    </head>
    <body>
        <h1>vscode-redmine: New configuration arrived!</h1>
        <p>Thanks for using <code>vscode-redmine</code>! From version 1.0.0, an old configuration schema has changed. We've detected, that you still use old format, so please update it to the new one.</p>
        <p>
            Following changed:
            <ul>
                <li><code>redmine.serverUrl</code>, <code>redmine.serverPort</code> and <code>redmine.serverIsSsl</code> became single setting: <code>redmine.url</code>.<br />
                If you had <code>serverUrl = 'example.com/test'</code>, <code>serverPort = 8080</code> and <code>serverIsSsl = true</code>, then new <code>url</code> will be <code>https://example.com:8080/test</code>.</li>
                <li><code>redmine.projectName</code> became <code>redmine.identifier</code>. Behavior remains the same</li>
                <li><code>redmine.authorization</code> is deprecated. If you want to add <code>Authorization</code> header to every request sent to redmine, provide <code>redmine.additionalHeaders</code>, eg.:
                    <pre>{"redmine.additionalHeaders": {"Authorization": "Basic 123qwe"}}</pre>
                </li>
            </ul>
        </p>
    </body>
    </html>`;
  }

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
  registerCommand("changeDefaultServer", (conf) => {
    myIssuesTree.setServer(conf.server);
    projectsTree.setServer(conf.server);
    myTimeEntriesTree.setServer(conf.server);

    projectsTree.onDidChangeTreeData$.fire();
    myIssuesTree.onDidChangeTreeData$.fire();
    myTimeEntriesTree.refresh();
  });

  registerCommand("refreshTimeEntries", () => {
    myTimeEntriesTree.refresh();
  });

  registerCommand("openTimeEntryInBrowser", async (props: ActionProperties, ...args: unknown[]) => {
    const node = args[0] as { _entry: { issue_id: number } };
    const issueId = node._entry.issue_id;
    await vscode.env.openExternal(vscode.Uri.parse(`${props.server.options.address}/issues/${issueId}`));
  });
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.refreshIssues", () => {
      projectsTree.clearProjects();
      projectsTree.onDidChangeTreeData$.fire();
      myIssuesTree.onDidChangeTreeData$.fire();
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
      vscode.window.showInformationMessage("Redmine API output cleared");
    }),
    vscode.commands.registerCommand("redmine.toggleApiLogging", async () => {
      const config = vscode.workspace.getConfiguration("redmine");
      const currentValue = config.get<boolean>("logging.enabled") || false;
      await config.update(
        "logging.enabled",
        !currentValue,
        vscode.ConfigurationTarget.Global
      );
      vscode.window.showInformationMessage(
        `Redmine API logging ${!currentValue ? "enabled" : "disabled"}`
      );
      // Refresh trees to use new server instances
      await updateConfiguredContext();
    })
  );
}

export function deactivate(): void {
  // Dispose EventEmitters in tree providers
  if (cleanupResources.myIssuesTree) {
    cleanupResources.myIssuesTree.onDidChangeTreeData$.dispose();
  }
  if (cleanupResources.projectsTree) {
    cleanupResources.projectsTree.onDidChangeTreeData$.dispose();
  }

  // Dispose tree view instances
  if (cleanupResources.myIssuesTreeView) {
    cleanupResources.myIssuesTreeView.dispose();
  }
  if (cleanupResources.projectsTreeView) {
    cleanupResources.projectsTreeView.dispose();
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
