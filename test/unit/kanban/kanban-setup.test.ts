import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

const hoisted = vi.hoisted(() => ({
  controllerCtor: vi.fn(),
  statusBarCtor: vi.fn(),
  registerTimerHandlers: vi.fn(),
  registerDoneTasksContext: vi.fn(),
  registerCommands: vi.fn(),
  createTreeSetup: vi.fn(),
  controller: { id: "controller" },
  statusBar: { dispose: vi.fn() },
  treeProvider: { id: "provider" },
  treeView: { dispose: vi.fn() } as unknown as vscode.TreeView<unknown>,
  timerDisposableA: { dispose: vi.fn() } as unknown as vscode.Disposable,
  timerDisposableB: { dispose: vi.fn() } as unknown as vscode.Disposable,
  doneTasksDisposable: { dispose: vi.fn() } as unknown as vscode.Disposable,
  commandDisposable: { dispose: vi.fn() } as unknown as vscode.Disposable,
}));

vi.mock("../../../src/kanban/kanban-controller", () => ({
  KanbanController: class {
    constructor(globalState: unknown, options: unknown) {
      hoisted.controllerCtor(globalState, options);
      return hoisted.controller;
    }
  },
}));

vi.mock("../../../src/kanban/kanban-status-bar", () => ({
  KanbanStatusBar: class {
    constructor(controller: unknown, globalState: unknown) {
      hoisted.statusBarCtor(controller, globalState);
      return hoisted.statusBar;
    }
  },
}));

vi.mock("../../../src/kanban/kanban-timer-handlers", () => ({
  registerKanbanTimerHandlers: hoisted.registerTimerHandlers,
}));

vi.mock("../../../src/kanban/kanban-context-sync", () => ({
  registerKanbanDoneTasksContext: hoisted.registerDoneTasksContext,
}));

vi.mock("../../../src/kanban/kanban-commands", () => ({
  registerKanbanCommands: hoisted.registerCommands,
}));

vi.mock("../../../src/kanban/kanban-tree-setup", () => ({
  createKanbanTreeSetup: hoisted.createTreeSetup,
}));

import { setupKanban } from "../../../src/kanban/kanban-setup";

function createContext(
  settings: Partial<Record<string, number>> = {}
): vscode.ExtensionContext {
  return {
    globalState: {
      get: vi.fn((key: string, fallback: number) =>
        settings[key] !== undefined ? settings[key] : fallback
      ),
    },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

describe("setupKanban", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    hoisted.registerTimerHandlers.mockReturnValue([
      hoisted.timerDisposableA,
      hoisted.timerDisposableB,
    ]);
    hoisted.registerDoneTasksContext.mockReturnValue([
      hoisted.doneTasksDisposable,
    ]);
    hoisted.registerCommands.mockReturnValue([hoisted.commandDisposable]);
    hoisted.createTreeSetup.mockReturnValue({
      provider: hoisted.treeProvider,
      treeView: hoisted.treeView,
    });
  });

  it("wires kanban resources and subscriptions with existing handlers", () => {
    const context = createContext({
      "redmyne.timer.unitDuration": 60,
      "redmyne.timer.workDuration": 45,
    });
    const getServer = vi.fn(() => undefined);
    const refreshAfterTimeLog = vi.fn();

    const result = setupKanban({
      context,
      getServer,
      refreshAfterTimeLog,
    });

    expect(hoisted.controllerCtor).toHaveBeenCalledWith(context.globalState, {
      workDurationSeconds: 2700,
    });
    expect(hoisted.statusBarCtor).toHaveBeenCalledWith(
      hoisted.controller,
      context.globalState
    );
    expect(hoisted.registerTimerHandlers).toHaveBeenCalledWith({
      controller: hoisted.controller,
      getServer,
      globalState: context.globalState,
      refreshAfterTimeLog,
    });
    expect(hoisted.createTreeSetup).toHaveBeenCalledWith({
      controller: hoisted.controller,
      globalState: context.globalState,
    });
    expect(hoisted.registerDoneTasksContext).toHaveBeenCalledWith({
      controller: hoisted.controller,
    });
    expect(hoisted.registerCommands).toHaveBeenCalledWith(
      context,
      hoisted.controller,
      getServer,
      hoisted.treeProvider
    );

    expect(result).toEqual({
      controller: hoisted.controller,
      statusBar: hoisted.statusBar,
      treeProvider: hoisted.treeProvider,
      treeView: hoisted.treeView,
    });

    expect(context.subscriptions).toEqual([
      expect.objectContaining({ dispose: expect.any(Function) }),
      hoisted.timerDisposableA,
      hoisted.timerDisposableB,
      hoisted.treeView,
      hoisted.doneTasksDisposable,
      hoisted.commandDisposable,
    ]);
  });

  it("clamps work duration to valid bounds before creating controller", () => {
    const context = createContext({
      "redmyne.timer.unitDuration": 30,
      "redmyne.timer.workDuration": 0,
    });

    setupKanban({
      context,
      getServer: () => undefined,
      refreshAfterTimeLog: vi.fn(),
    });

    expect(hoisted.controllerCtor).toHaveBeenCalledWith(context.globalState, {
      workDurationSeconds: 60,
    });
  });
});
