import * as vscode from "vscode";
import type { ActionProperties } from "./action-properties";
import type {
  RedmineServer,
  RedmineServerConnectionOptions,
} from "../redmine/redmine-server";

export interface RegisterConfiguredCommandDeps {
  context: vscode.ExtensionContext;
  secretManager: {
    getApiKey: () => Promise<string | undefined>;
  };
  createServer: (options: RedmineServerConnectionOptions) => RedmineServer;
  bucket: {
    servers: RedmineServer[];
  };
  maxServerCacheSize: number;
  disposeServer: (server: RedmineServer) => void;
}

export type ConfiguredCommandAction = (
  props: ActionProperties,
  ...args: unknown[]
) => void | Promise<void>;

export type RegisterConfiguredCommand = (
  name: string,
  action: ConfiguredCommandAction
) => void;

export function createConfiguredCommandRegistrar(
  deps: RegisterConfiguredCommandDeps
): RegisterConfiguredCommand {
  const parseConfiguration = async (
    withPick: unknown = true,
    props?: ActionProperties,
    ...args: unknown[]
  ): Promise<{
    props?: ActionProperties;
    args: unknown[];
  }> => {
    // When invoked from context menu, tree element is passed as first arg.
    // Preserve it in args if it's an object (not a boolean).
    let contextArgs: unknown[] = [];
    if (typeof withPick === "object" && withPick !== null) {
      contextArgs = [withPick, props, ...args];
    }

    if (withPick === false) {
      return {
        props,
        args,
      };
    }

    const config = vscode.workspace.getConfiguration("redmyne");
    const url = config.get<string>("serverUrl");

    if (!url) {
      vscode.window.showErrorMessage(
        'No Redmine URL configured. Run "Configure Redmine Server"'
      );
      return { props: undefined, args: [] };
    }

    const apiKey = await deps.secretManager.getApiKey();

    if (!apiKey) {
      vscode.window.showErrorMessage(
        'No API key configured. Run "Configure Redmine Server"'
      );
      return { props: undefined, args: [] };
    }

    const redmineServer = deps.createServer({
      address: url,
      key: apiKey,
      additionalHeaders: config.get("additionalHeaders"),
    });

    const fromBucket = deps.bucket.servers.find((server) =>
      server.compare(redmineServer)
    );
    const server = fromBucket || redmineServer;

    if (!fromBucket) {
      // LRU cache: evict oldest when at capacity.
      if (deps.bucket.servers.length >= deps.maxServerCacheSize) {
        const removed = deps.bucket.servers.shift();
        if (removed) {
          deps.disposeServer(removed);
        }
      }
      deps.bucket.servers.push(server);
    } else {
      // Move to end (most recently used).
      const index = deps.bucket.servers.indexOf(fromBucket);
      if (index > -1) {
        deps.bucket.servers.splice(index, 1);
        deps.bucket.servers.push(fromBucket);
      }
    }

    return {
      props: {
        server,
        config: {
          ...config,
          serverUrl: url,
        },
      },
      args: contextArgs,
    };
  };

  return (name: string, action: ConfiguredCommandAction) => {
    deps.context.subscriptions.push(
      vscode.commands.registerCommand(
        `redmyne.${name}`,
        (withPick?: boolean, props?: ActionProperties, ...args: unknown[]) => {
          parseConfiguration(withPick, props, ...args).then(
            ({ props: parsedProps, args: parsedArgs }) => {
              // `props` should be set when `withPick` is `false`.
              // Otherwise `parseConfiguration` will take care of getting ActionProperties.
              // It's used mainly by trees that always pass props argument.
              if (parsedProps) {
                action(parsedProps, ...parsedArgs);
              }
            }
          );
        }
      )
    );
  };
}
