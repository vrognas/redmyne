import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { ActionProperties } from "../../../src/commands/action-properties";
import { createConfiguredCommandRegistrar } from "../../../src/commands/configured-command-registrar";
import type { RedmineServer } from "../../../src/redmine/redmine-server";

function makeConfig(values: Record<string, unknown>): vscode.WorkspaceConfiguration {
  return {
    get: vi.fn((key: string) => values[key]),
  } as unknown as vscode.WorkspaceConfiguration;
}

function makeServer(compareResult = false): RedmineServer {
  return {
    compare: vi.fn(() => compareResult),
  } as unknown as RedmineServer;
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createConfiguredCommandRegistrar", () => {
  let registeredHandler: ((...args: unknown[]) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandler = undefined;

    vi.mocked(vscode.commands.registerCommand).mockImplementation(
      (_command, callback) => {
        registeredHandler = callback as (...args: unknown[]) => void;
        return { dispose: vi.fn() } as unknown as vscode.Disposable;
      }
    );
  });

  it("invokes action with provided props when withPick is false", async () => {
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const action = vi.fn();
    const createServer = vi.fn();
    const disposeServer = vi.fn();
    const bucket = { servers: [] as RedmineServer[] };
    const providedProps = { server: {}, config: {} } as ActionProperties;

    const register = createConfiguredCommandRegistrar({
      context,
      secretManager: { getApiKey: vi.fn() },
      createServer,
      bucket,
      maxServerCacheSize: 3,
      disposeServer,
    });

    register("sample", action);
    registeredHandler?.(false, providedProps, "arg1", 2);
    await flushAsyncWork();

    expect(action).toHaveBeenCalledWith(providedProps, "arg1", 2);
    expect(createServer).not.toHaveBeenCalled();
    expect(context.subscriptions).toHaveLength(1);
  });

  it("shows error and skips action when server URL is missing", async () => {
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const action = vi.fn();
    const createServer = vi.fn();
    const disposeServer = vi.fn();
    const bucket = { servers: [] as RedmineServer[] };

    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      makeConfig({ serverUrl: undefined })
    );

    const register = createConfiguredCommandRegistrar({
      context,
      secretManager: { getApiKey: vi.fn().mockResolvedValue("apikey") },
      createServer,
      bucket,
      maxServerCacheSize: 3,
      disposeServer,
    });

    register("sample", action);
    registeredHandler?.();
    await flushAsyncWork();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'No Redmine URL configured. Run "Configure Redmine Server"'
    );
    expect(action).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
  });

  it("evicts oldest cached server when capacity is reached", async () => {
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const action = vi.fn();
    const oldServer = makeServer(false);
    const newServer = makeServer(false);
    const disposeServer = vi.fn();
    const bucket = { servers: [oldServer] };

    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      makeConfig({
        serverUrl: "https://redmine.example.com",
        additionalHeaders: { "X-Test": "1" },
      })
    );

    const register = createConfiguredCommandRegistrar({
      context,
      secretManager: { getApiKey: vi.fn().mockResolvedValue("apikey") },
      createServer: vi.fn().mockReturnValue(newServer),
      bucket,
      maxServerCacheSize: 1,
      disposeServer,
    });

    register("sample", action);
    registeredHandler?.();
    await flushAsyncWork();

    expect(disposeServer).toHaveBeenCalledWith(oldServer);
    expect(bucket.servers).toEqual([newServer]);
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({
        server: newServer,
      })
    );
  });

  it("reuses matching server and keeps it as most recently used", async () => {
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const action = vi.fn();
    const matchingServer = makeServer(true);
    const otherServer = makeServer(false);
    const candidateServer = makeServer(false);
    const bucket = { servers: [matchingServer, otherServer] };

    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      makeConfig({
        serverUrl: "https://redmine.example.com",
        additionalHeaders: undefined,
      })
    );

    const register = createConfiguredCommandRegistrar({
      context,
      secretManager: { getApiKey: vi.fn().mockResolvedValue("apikey") },
      createServer: vi.fn().mockReturnValue(candidateServer),
      bucket,
      maxServerCacheSize: 3,
      disposeServer: vi.fn(),
    });

    register("sample", action);
    registeredHandler?.({ id: 42 });
    await flushAsyncWork();

    expect(bucket.servers).toEqual([otherServer, matchingServer]);
    expect(action).toHaveBeenCalledTimes(1);

    const [calledProps, contextArg, trailingArg] = action.mock.calls[0];
    expect(calledProps).toEqual(
      expect.objectContaining({
        server: matchingServer,
      })
    );
    expect(contextArg).toEqual({ id: 42 });
    expect(trailingArg).toBeUndefined();
  });
});
