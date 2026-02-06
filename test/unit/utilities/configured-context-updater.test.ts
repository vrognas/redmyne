import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { RedmineServer } from "../../../src/redmine/redmine-server";

const hoisted = vi.hoisted(() => ({
  hashString: vi.fn(),
  getCurrentUser: vi.fn(),
  draftCtor: vi.fn(),
}));

vi.mock("../../../src/draft-mode/draft-operation", () => ({
  hashString: hoisted.hashString,
}));

vi.mock("../../../src/draft-mode/draft-mode-server", () => ({
  DraftModeServer: class {
    getCurrentUser = hoisted.getCurrentUser;

    constructor(inner: unknown, queue: unknown, manager: unknown) {
      hoisted.draftCtor(inner, queue, manager);
    }
  },
}));

import { createConfiguredContextUpdater } from "../../../src/utilities/configured-context-updater";

function makeConfig(values: Record<string, unknown>): vscode.WorkspaceConfiguration {
  return {
    get: vi.fn((key: string) => values[key]),
  } as unknown as vscode.WorkspaceConfiguration;
}

function flushPromises(times = 3): Promise<void> {
  const tasks = Array.from({ length: times }, () => Promise.resolve());
  return tasks.reduce(
    (acc, current) => acc.then(() => current).then(() => undefined),
    Promise.resolve()
  );
}

function createDeps() {
  const createServer = vi.fn(
    () => ({ getCurrentUser: vi.fn() }) as unknown as RedmineServer
  );
  const projectsTree = {
    setServer: vi.fn(),
    refresh: vi.fn(),
  };
  const timeEntriesTree = {
    setServer: vi.fn(),
    refresh: vi.fn(),
  };
  const draftQueue = {
    checkServerConflict: vi.fn().mockResolvedValue(null),
    load: vi.fn().mockResolvedValue(undefined),
  };
  const deps = {
    secretManager: {
      getApiKey: vi.fn().mockResolvedValue("apikey"),
    },
    createServer,
    draftQueue,
    draftModeManager: {} as never,
    projectsTree: projectsTree as never,
    timeEntriesTree: timeEntriesTree as never,
    setDraftModeServer: vi.fn(),
    setUserFte: vi.fn(),
    updateWorkloadStatusBar: vi.fn(),
  };
  return {
    deps,
    createServer,
    projectsTree,
    timeEntriesTree,
    draftQueue,
  };
}

describe("createConfiguredContextUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    hoisted.hashString.mockResolvedValue("server-identity");
    hoisted.getCurrentUser.mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      makeConfig({ serverUrl: undefined })
    );
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined);
  });

  it("clears tree servers when extension is not configured", async () => {
    const { deps, createServer, projectsTree, timeEntriesTree } = createDeps();
    deps.secretManager.getApiKey = vi.fn().mockResolvedValue(undefined);

    const updateConfiguredContext = createConfiguredContextUpdater(deps);
    await updateConfiguredContext();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "redmyne:configured",
      false
    );
    expect(projectsTree.setServer).toHaveBeenCalledWith(undefined);
    expect(timeEntriesTree.setServer).toHaveBeenCalledWith(undefined);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("initializes draft-mode server and loads queue when configured", async () => {
    const { deps, createServer, projectsTree, timeEntriesTree, draftQueue } =
      createDeps();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      makeConfig({
        serverUrl: "https://redmine.example.com",
        additionalHeaders: { "X-Test": "1" },
      })
    );
    hoisted.getCurrentUser.mockResolvedValue({
      custom_fields: [{ name: "FTE", value: "0.8" }],
    });

    const updateConfiguredContext = createConfiguredContextUpdater(deps);
    await updateConfiguredContext();
    await flushPromises();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "redmyne:configured",
      true
    );
    expect(createServer).toHaveBeenCalledWith({
      address: "https://redmine.example.com",
      key: "apikey",
      additionalHeaders: { "X-Test": "1" },
    });
    expect(deps.setDraftModeServer).toHaveBeenCalledTimes(1);
    expect(projectsTree.setServer).toHaveBeenCalledTimes(1);
    expect(timeEntriesTree.setServer).toHaveBeenCalledTimes(1);
    expect(projectsTree.refresh).toHaveBeenCalledTimes(1);
    expect(timeEntriesTree.refresh).toHaveBeenCalledTimes(1);
    expect(hoisted.hashString).toHaveBeenCalledWith(
      "https://redmine.example.comapikey"
    );
    expect(draftQueue.checkServerConflict).toHaveBeenCalledWith(
      "server-identity"
    );
    expect(draftQueue.load).toHaveBeenCalledWith("server-identity", {
      force: true,
    });
    expect(deps.setUserFte).toHaveBeenCalledWith(0.8);
    expect(deps.updateWorkloadStatusBar).toHaveBeenCalledTimes(1);
  });

  it("skips queue load when draft conflict is not confirmed", async () => {
    const { deps, draftQueue } = createDeps();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      makeConfig({
        serverUrl: "https://redmine.example.com",
      })
    );
    draftQueue.checkServerConflict.mockResolvedValue({ count: 2 });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Cancel");

    const updateConfiguredContext = createConfiguredContextUpdater(deps);
    await updateConfiguredContext();
    await flushPromises();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(draftQueue.load).not.toHaveBeenCalled();
  });
});
