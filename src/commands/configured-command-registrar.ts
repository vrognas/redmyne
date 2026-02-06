import * as vscode from "vscode";
import type { ActionProperties } from "./action-properties";
import type {
  RedmineServer,
  RedmineServerConnectionOptions,
} from "../redmine/redmine-server";
import { getConfiguredServerUrlOrShowError } from "./command-guards";

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
  const configureServerHint = 'Run "Configure Redmine Server"';

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
      contextArgs = [withPick, ...(props === undefined ? [] : [props]), ...args];
    }

    if (withPick === false) {
      return {
        props,
        args,
      };
    }

    const config = vscode.workspace.getConfiguration("redmyne");
    const url = getConfiguredServerUrlOrShowError(
      `No Redmine URL configured. ${configureServerHint}`
    );
    if (!url) {
      return { props: undefined, args: [] };
    }

    const apiKey = await deps.secretManager.getApiKey();

    if (!apiKey) {
      vscode.window.showErrorMessage(
        `No API key configured. ${configureServerHint}`
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
        async (withPick?: boolean, props?: ActionProperties, ...args: unknown[]) => {
          try {
            const { props: parsedProps, args: parsedArgs } = await parseConfiguration(
              withPick,
              props,
              ...args
            );
            // `props` should be set when `withPick` is `false`.
            // Otherwise `parseConfiguration` will take care of getting ActionProperties.
            // It's used mainly by trees that always pass props argument.
            if (parsedProps) {
              await action(parsedProps, ...parsedArgs);
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Command failed: ${msg}`);
          }
        }
      )
    );
  };
}
