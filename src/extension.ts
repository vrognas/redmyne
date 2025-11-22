import * as vscode from "vscode";
import { RedmineServer } from "./redmine/redmine-server";
import { RedmineProject } from "./redmine/redmine-project";
import openActionsForIssue from "./commands/open-actions-for-issue";
import openActionsForIssueUnderCursor from "./commands/open-actions-for-issue-under-cursor";
import listOpenIssuesAssignedToMe from "./commands/list-open-issues-assigned-to-me";
import newIssue from "./commands/new-issue";
import { RedmineConfig } from "./definitions/redmine-config";
import { ActionProperties } from "./commands/action-properties";
import { MyIssuesTree } from "./trees/my-issues-tree";
import { ProjectsTree, ProjectsViewStyle } from "./trees/projects-tree";
import { RedmineSecretManager } from "./utilities/secret-manager";
import { setApiKey } from "./commands/set-api-key";

export function activate(context: vscode.ExtensionContext): void {
  const bucket = {
    servers: [] as RedmineServer[],
    projects: [] as RedmineProject[],
  };

  const secretManager = new RedmineSecretManager(context);

  const myIssuesTree = new MyIssuesTree();
  const projectsTree = new ProjectsTree();

  vscode.window.createTreeView("redmine-explorer-my-issues", {
    treeDataProvider: myIssuesTree,
  });
  vscode.window.createTreeView("redmine-explorer-projects", {
    treeDataProvider: projectsTree,
  });

  // Listen for secret changes
  context.subscriptions.push(
    secretManager.onSecretChanged(() => {
      projectsTree.onDidChangeTreeData$.fire();
      myIssuesTree.onDidChangeTreeData$.fire();
    })
  );

  // Check if configured and update context
  const updateConfiguredContext = async () => {
    const folders = vscode.workspace.workspaceFolders || [];
    const folder = folders[0];

    if (!folder) {
      await vscode.commands.executeCommand("setContext", "redmine:configured", false);
      return;
    }

    const config = vscode.workspace.getConfiguration("redmine", folder.uri);
    const hasUrl = !!config.get<string>("url");
    const hasApiKey = !!(await secretManager.getApiKey(folder.uri));

    await vscode.commands.executeCommand("setContext", "redmine:configured", hasUrl && hasApiKey);
  };

  // Initial check
  updateConfiguredContext();

  // Register configure command
  context.subscriptions.push(
    vscode.commands.registerCommand('redmine.configure', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage('Please open a workspace folder first');
        return;
      }

      const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
      if (!folder) return;

      // Step 1: Set Redmine URL
      const url = await vscode.window.showInputBox({
        prompt: 'Step 1/2: Enter your Redmine server URL',
        placeHolder: 'https://redmine.example.com',
        validateInput: (value) => {
          if (!value) return 'URL cannot be empty';
          try {
            new URL(value);
            return null;
          } catch {
            return 'Invalid URL format';
          }
        }
      });

      if (!url) return;

      // Save URL to workspace config
      const config = vscode.workspace.getConfiguration("redmine", folder.uri);
      await config.update("url", url, vscode.ConfigurationTarget.WorkspaceFolder);

      // Step 2: Explain how to get API key
      const action = await vscode.window.showInformationMessage(
        'Step 2/2: You need your Redmine API key',
        { modal: true, detail: 'Your API key can be found in your Redmine account settings.\n\nClick "Open Redmine" to open your account page, then copy your API key and paste it in the next step.' },
        'Open Redmine Account',
        'I Have My Key'
      );

      if (!action) return;

      if (action === 'Open Redmine Account') {
        // Open user's Redmine account page
        await vscode.env.openExternal(vscode.Uri.parse(`${url}/my/account`));

        // Give them time to get the key
        await vscode.window.showInformationMessage(
          'Copy your API key from the "API access key" section on the right side of the page.',
          { modal: false },
          'Got It'
        );
      }

      // Prompt for API Key
      const apiKey = await vscode.window.showInputBox({
        prompt: 'Paste your Redmine API key',
        placeHolder: 'e.g., a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0',
        password: true,
        validateInput: (value) => {
          if (!value) return 'API key cannot be empty';
          if (value.length < 20) return 'API key appears too short';
          return null;
        }
      });

      if (!apiKey) return;

      // Save API key to secrets
      await secretManager.setApiKey(folder.uri, apiKey);

      // Update context and refresh trees
      await updateConfiguredContext();
      projectsTree.onDidChangeTreeData$.fire();
      myIssuesTree.onDidChangeTreeData$.fire();

      vscode.window.showInformationMessage('Redmine configured successfully! 🎉');
    })
  );

  // Register set API key command
  context.subscriptions.push(
    vscode.commands.registerCommand('redmine.setApiKey', async () => {
      await setApiKey(context);
      await updateConfiguredContext();
      projectsTree.onDidChangeTreeData$.fire();
      myIssuesTree.onDidChangeTreeData$.fire();
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

    const pickedFolder = await vscode.window.showWorkspaceFolderPick();

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
      vscode.window.showErrorMessage('No API key configured. Run "Redmine: Set API Key"');
      return Promise.resolve({ props: undefined, args: [] });
    }

    const redmineServer = new RedmineServer({
      address: config.url,
      key: apiKey,
      additionalHeaders: config.additionalHeaders,
      rejectUnauthorized: config.rejectUnauthorized,
    });

    const fromBucket = bucket.servers.find((s) => s.compare(redmineServer));
    const server = fromBucket || redmineServer;

    if (!fromBucket) {
      bucket.servers.push(server);
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
    action: (props: ActionProperties, ...args: any[]) => void | Promise<void>
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
  registerCommand("changeDefaultServer", (conf) => {
    myIssuesTree.setServer(conf.server);
    projectsTree.setServer(conf.server);

    projectsTree.onDidChangeTreeData$.fire();
    myIssuesTree.onDidChangeTreeData$.fire();
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
    })
  );
}

export function deactivate(): void {
  // Cleanup resources
}
