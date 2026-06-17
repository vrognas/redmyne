import * as vscode from "vscode";
import type { ActionProperties } from "./action-properties";
import type { RedmineServerConnectionOptions } from "../redmine/redmine-server";
import type { IRedmineServer } from "../redmine/redmine-server-interface";
import { getConfiguredServerUrlOrShowError } from "./command-guards";
import { errorToString } from "../utilities/error-feedback";

export interface RegisterConfiguredCommandDeps {
  context: vscode.ExtensionContext;
  secretManager: {
    getApiKey: () => Promise<string | undefined>;
  };
  createServer: (options: RedmineServerConnectionOptions) => IRedmineServer;
  bucket: {
    servers: IRedmineServer[];
  };
  maxServerCacheSize: number;
  disposeServer: (server: IRedmineServer) => void;
}

export type ConfiguredCommandAction = (
  props: ActionProperties,
  ...args: unknown[]
) => void | Promise<void>;

export type RegisterConfiguredCommand = (
  name: string,
  action: ConfiguredCommandAction
) => void;

/**
 * Decodes the 3-way overloaded first-argument convention used by configured commands.
 *
 * Shapes:
 *   withPick === false  → pre-configured path: return props + remaining args unchanged
 *   withPick is object  → context-menu path: reassemble all args as forwardedArgs
 *   anything else       → pick/config path: no preconfigured props, no forwarded args
 *                         (primitive non-boolean first args are silently dropped — by design)
 */
export function decodeInvocation(
  withPick: unknown,
  props: ActionProperties | undefined,
  args: unknown[]
): { preconfigured?: ActionProperties; forwardedArgs: unknown[] } {
  if (withPick === false) {
    return { preconfigured: props, forwardedArgs: args };
  }
  if (typeof withPick === "object" && withPick !== null) {
    return {
      forwardedArgs: [withPick, ...(props === undefined ? [] : [props]), ...args],
    };
  }
  // withPick === true | undefined | any primitive: pick/config path, drop withPick
  return { forwardedArgs: [] };
}

/**
 * Produces the command arguments array for a configured command invocation,
 * for use in `vscode.TreeItem.command.arguments` (deferred execution).
 */
export function configuredCommandArgs(
  props: ActionProperties,
  ...args: unknown[]
): [false, ActionProperties, ...unknown[]] {
  return [false, props, ...args];
}

/**
 * Directly execute a configured command, bypassing the pick flow.
 * Equivalent to `vscode.commands.executeCommand(name, false, props, ...args)`.
 */
export function invokeConfigured(
  name: string,
  props: ActionProperties,
  ...args: unknown[]
): Thenable<unknown> {
  return vscode.commands.executeCommand(name, false, props, ...args);
}

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
    const { preconfigured, forwardedArgs } = decodeInvocation(withPick, props, args);

    if (withPick === false) {
      return {
        props: preconfigured,
        args: forwardedArgs,
      };
    }

    // Context-menu or config/pick path
    const contextArgs = forwardedArgs;

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
      caFile: config.get<string>("caFile"),
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
      // Discard the freshly-built duplicate so any background timers it
      // holds (e.g. LoggingRedmineServer's cleanup interval) get released.
      deps.disposeServer(redmineServer);
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
            const msg = errorToString(error);
            vscode.window.showErrorMessage(`Command failed: ${msg}`);
          }
        }
      )
    );
  };
}
