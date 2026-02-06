import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { createKanbanTreeSetup } from "../../../src/kanban/kanban-tree-setup";

describe("createKanbanTreeSetup", () => {
  let treeView: vscode.TreeView<unknown>;

  beforeEach(() => {
    vi.clearAllMocks();

    treeView = {
      dispose: vi.fn(),
    } as unknown as vscode.TreeView<unknown>;

    vi.mocked(vscode.window.createTreeView).mockReturnValue(treeView);
  });

  it("creates kanban provider and tree view with drag-and-drop enabled", () => {
    const controller = {
      onTasksChange: vi.fn(() => ({ dispose: vi.fn() } as vscode.Disposable)),
      getTasks: vi.fn(() => []),
      isOnBreak: vi.fn(() => false),
      getBreakSecondsLeft: vi.fn(() => 0),
    };

    const globalState = {
      get: vi.fn((_: string, fallback: unknown) => fallback),
      update: vi.fn(),
    } as unknown as vscode.Memento;

    const setup = createKanbanTreeSetup({
      controller: controller as never,
      globalState,
    });

    expect(vscode.window.createTreeView).toHaveBeenCalledTimes(1);
    expect(vscode.window.createTreeView).toHaveBeenCalledWith(
      "redmyne-explorer-kanban",
      {
        treeDataProvider: setup.provider,
        dragAndDropController: setup.provider,
        canSelectMany: true,
      }
    );
    expect(setup.treeView).toBe(treeView);
    expect(controller.onTasksChange).toHaveBeenCalledTimes(1);
  });
});
