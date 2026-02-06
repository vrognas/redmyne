import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { ActionProperties } from "../../../src/commands/action-properties";
import { registerQuickIssueCommands } from "../../../src/commands/quick-issue-commands";
import { quickLogTime } from "../../../src/commands/quick-log-time";
import {
  quickCreateIssue,
  quickCreateSubIssue,
} from "../../../src/commands/quick-create-issue";
import { quickCreateVersion } from "../../../src/commands/quick-create-version";

vi.mock("../../../src/commands/quick-log-time", () => ({
  quickLogTime: vi.fn(),
}));

vi.mock("../../../src/commands/quick-create-issue", () => ({
  quickCreateIssue: vi.fn(),
  quickCreateSubIssue: vi.fn(),
}));

vi.mock("../../../src/commands/quick-create-version", () => ({
  quickCreateVersion: vi.fn(),
}));

type RegisteredAction = (
  props: ActionProperties,
  ...args: unknown[]
) => void | Promise<void>;

describe("registerQuickIssueCommands", () => {
  let handlers: Map<string, RegisteredAction>;
  let props: ActionProperties;
  let context: vscode.ExtensionContext;
  let projectsTree: {
    clearProjects: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
  };
  let timeEntriesTree: {
    refresh: ReturnType<typeof vi.fn>;
    loadEarlierMonths: ReturnType<typeof vi.fn>;
  };
  let workloadStatusBar: { update: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    handlers = new Map<string, RegisteredAction>();
    props = {} as ActionProperties;
    context = {} as vscode.ExtensionContext;

    projectsTree = {
      clearProjects: vi.fn(),
      refresh: vi.fn(),
    };

    timeEntriesTree = {
      refresh: vi.fn(),
      loadEarlierMonths: vi.fn(),
    };

    workloadStatusBar = {
      update: vi.fn(),
    };

    vi.mocked(quickLogTime).mockResolvedValue(undefined);
    vi.mocked(quickCreateIssue).mockResolvedValue(undefined);
    vi.mocked(quickCreateSubIssue).mockResolvedValue(undefined);
    vi.mocked(quickCreateVersion).mockResolvedValue(undefined);
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

    registerQuickIssueCommands({
      registerConfiguredCommand: (name, action) => {
        handlers.set(name, action);
      },
      context,
      projectsTree: projectsTree as never,
      timeEntriesTree: timeEntriesTree as never,
      getWorkloadStatusBar: () => workloadStatusBar as never,
    });
  });

  it("registers quick issue command surface", () => {
    expect([...handlers.keys()].sort()).toEqual(
      [
        "quickLogTime",
        "quickCreateIssue",
        "quickCreateSubIssue",
        "quickCreateVersion",
        "refreshTimeEntries",
        "loadEarlierTimeEntries",
        "refreshAfterIssueUpdate",
      ].sort()
    );
  });

  it("forwards issue id from tree context into quick log time", async () => {
    const action = handlers.get("quickLogTime");
    expect(action).toBeDefined();

    await action?.(props, { id: 42 });

    expect(quickLogTime).toHaveBeenCalledWith(props, context, undefined, 42);
  });

  it("refreshes projects after successful quick issue creation", async () => {
    const action = handlers.get("quickCreateIssue");
    expect(action).toBeDefined();
    vi.mocked(quickCreateIssue).mockResolvedValueOnce({
      id: 1001,
      subject: "Created",
    } as never);

    await action?.(props, { project: { id: 77 } });

    expect(quickCreateIssue).toHaveBeenCalledWith(props, 77);
    expect(projectsTree.clearProjects).toHaveBeenCalledTimes(1);
    expect(projectsTree.refresh).toHaveBeenCalledTimes(1);
  });

  it("prompts for parent issue id when creating sub issue without args", async () => {
    const action = handlers.get("quickCreateSubIssue");
    expect(action).toBeDefined();
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("123");
    vi.mocked(quickCreateSubIssue).mockResolvedValueOnce({
      id: 1002,
      subject: "Sub-issue",
    } as never);

    await action?.(props);

    expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
    expect(quickCreateSubIssue).toHaveBeenCalledWith(props, 123);
    expect(projectsTree.clearProjects).toHaveBeenCalledTimes(1);
    expect(projectsTree.refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes gantt after quick version creation", async () => {
    const action = handlers.get("quickCreateVersion");
    expect(action).toBeDefined();
    vi.mocked(quickCreateVersion).mockResolvedValueOnce({
      id: 2001,
      name: "Sprint 1",
    } as never);

    await action?.(props, 91);

    expect(quickCreateVersion).toHaveBeenCalledWith(props, 91);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "redmyne.refreshGantt"
    );
  });

  it("registers tree refresh wrappers", async () => {
    const refreshTimeEntries = handlers.get("refreshTimeEntries");
    const loadEarlierTimeEntries = handlers.get("loadEarlierTimeEntries");
    const refreshAfterIssueUpdate = handlers.get("refreshAfterIssueUpdate");

    await refreshTimeEntries?.(props);
    await loadEarlierTimeEntries?.(props);
    await refreshAfterIssueUpdate?.(props);

    expect(timeEntriesTree.refresh).toHaveBeenCalledTimes(1);
    expect(timeEntriesTree.loadEarlierMonths).toHaveBeenCalledTimes(1);
    expect(projectsTree.refresh).toHaveBeenCalledTimes(1);
    expect(workloadStatusBar.update).toHaveBeenCalledTimes(1);
  });
});
