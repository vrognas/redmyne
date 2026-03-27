import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerKanbanCommands } from "../../../src/kanban/kanban-commands";
import type { KanbanController } from "../../../src/kanban/kanban-controller";
import type { KanbanTask } from "../../../src/kanban/kanban-state";
import type { IRedmineServer } from "../../../src/redmine/redmine-server-interface";
import * as kanbanDialogs from "../../../src/kanban/kanban-dialogs";
import * as issuePicker from "../../../src/utilities/issue-picker";
import * as errorFeedback from "../../../src/utilities/error-feedback";
import * as customFieldPicker from "../../../src/utilities/custom-field-picker";
import * as closedIssueGuard from "../../../src/utilities/closed-issue-guard";
import * as statusBar from "../../../src/utilities/status-bar";

type RegisteredHandler = (...args: unknown[]) => unknown;
type ControllerMock = ReturnType<typeof createController>;

function createTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "task-1",
    title: "Task title",
    priority: "medium",
    linkedIssueId: 101,
    linkedIssueSubject: "Issue 101",
    linkedProjectId: 7,
    linkedProjectName: "Platform",
    loggedHours: 0,
    createdAt: "2026-02-07T00:00:00.000Z",
    updatedAt: "2026-02-07T00:00:00.000Z",
    ...overrides,
  };
}

function createController(tasks: KanbanTask[] = []) {
  return {
    addTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    markDone: vi.fn(),
    reopen: vi.fn(),
    clearDone: vi.fn(),
    updateParentProject: vi.fn(),
    getTasks: vi.fn(() => tasks),
    getTaskById: vi.fn((id: string) => tasks.find((task) => task.id === id)),
    startTimer: vi.fn(),
    pauseTimer: vi.fn(),
    resumeTimer: vi.fn(),
    stopTimer: vi.fn(),
    moveToTodo: vi.fn(),
    getActiveTask: vi.fn(),
    isOnBreak: vi.fn(),
    skipBreak: vi.fn(),
    getWorkDurationSeconds: vi.fn(() => 3600),
    addLoggedHours: vi.fn(),
    addDeferredMinutes: vi.fn(),
    setWorkDurationSeconds: vi.fn(),
    moveUp: vi.fn(),
    moveDown: vi.fn(),
  };
}

function createServer(
  overrides: Partial<{
    getIssueById: ReturnType<typeof vi.fn>;
    getProjects: ReturnType<typeof vi.fn>;
    getTimeEntryCustomFields: ReturnType<typeof vi.fn>;
    addTimeEntry: ReturnType<typeof vi.fn>;
  }> = {}
): IRedmineServer {
  return {
    options: { address: "https://redmine.example.test" },
    getIssueById: vi.fn(),
    getProjects: vi.fn(),
    getTimeEntryCustomFields: vi.fn(),
    addTimeEntry: vi.fn(),
    ...overrides,
  } as unknown as IRedmineServer;
}

function createContext(
  values: Partial<Record<string, unknown>> = {}
): vscode.ExtensionContext {
  return {
    globalState: {
      get: vi.fn((key: string, fallback: unknown) =>
        values[key] !== undefined ? values[key] : fallback
      ),
      update: vi.fn().mockResolvedValue(undefined),
    },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

describe("registerKanbanCommands", () => {
  let handlers: Map<string, RegisteredHandler>;
  let showCreateTaskDialogSpy: ReturnType<typeof vi.spyOn>;
  let pickActivityForProjectSpy: ReturnType<typeof vi.spyOn>;
  let showActionableErrorSpy: ReturnType<typeof vi.spyOn>;
  let promptForRequiredCustomFieldsSpy: ReturnType<typeof vi.spyOn>;
  let confirmLogTimeOnClosedIssueSpy: ReturnType<typeof vi.spyOn>;
  let showStatusBarMessageSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map<string, RegisteredHandler>();
    vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
      handlers.set(command as string, callback as RegisteredHandler);
      return { dispose: vi.fn() } as unknown as vscode.Disposable;
    });

    showCreateTaskDialogSpy = vi.spyOn(kanbanDialogs, "showCreateTaskDialog");
    pickActivityForProjectSpy = vi.spyOn(issuePicker, "pickActivityForProject");
    showActionableErrorSpy = vi.spyOn(errorFeedback, "showActionableError");
    promptForRequiredCustomFieldsSpy = vi.spyOn(
      customFieldPicker,
      "promptForRequiredCustomFields"
    );
    confirmLogTimeOnClosedIssueSpy = vi.spyOn(
      closedIssueGuard,
      "confirmLogTimeOnClosedIssue"
    );
    showStatusBarMessageSpy = vi.spyOn(statusBar, "showStatusBarMessage");

    showCreateTaskDialogSpy.mockResolvedValue(undefined);
    pickActivityForProjectSpy.mockResolvedValue(undefined);
    showActionableErrorSpy.mockResolvedValue(undefined);
    promptForRequiredCustomFieldsSpy.mockResolvedValue({
      values: undefined,
      cancelled: false,
      prompted: false,
    });
    confirmLogTimeOnClosedIssueSpy.mockResolvedValue(true);
    showStatusBarMessageSpy.mockImplementation(() => undefined);
  });

  function registerCommands(options?: {
    server?: IRedmineServer | undefined;
    tasks?: KanbanTask[];
    contextValues?: Partial<Record<string, unknown>>;
    treeProvider?: {
      setFilter: ReturnType<typeof vi.fn>;
      setSort: ReturnType<typeof vi.fn>;
      getSort: ReturnType<typeof vi.fn>;
    };
  }): {
    controller: ControllerMock;
    context: vscode.ExtensionContext;
  } {
    const controller = createController(options?.tasks);
    const context = createContext(options?.contextValues);

    registerKanbanCommands(
      context,
      controller as unknown as KanbanController,
      () => options?.server,
      options?.treeProvider as never
    );

    return { controller, context };
  }

  it("registers key kanban command surface", () => {
    registerCommands();

    expect(Array.from(handlers.keys())).toEqual(
      expect.arrayContaining([
        "redmyne.kanban.add",
        "redmyne.kanban.openInBrowser",
        "redmyne.addIssueToKanban",
        "redmyne.kanban.startTimer",
        "redmyne.kanban.logEarly",
        "redmyne.kanban.configureTimer",
      ])
    );
  });

  it("shows actionable config error when adding task without server", async () => {
    const { controller } = registerCommands({ server: undefined });

    await handlers.get("redmyne.kanban.add")?.();

    expect(showActionableErrorSpy).toHaveBeenCalledWith("Redmyne not configured", [
      { title: "Configure", command: "redmyne.configure" },
    ]);
    expect(controller.addTask).not.toHaveBeenCalled();
  });

  it("adds task from create dialog result", async () => {
    const server = createServer();
    const { controller } = registerCommands({ server });
    showCreateTaskDialogSpy.mockResolvedValue({
      title: "Write tests",
      linkedIssueId: 42,
      linkedIssueSubject: "Improve coverage",
      linkedProjectId: 10,
      linkedProjectName: "Core",
      linkedParentProjectId: 5,
      linkedParentProjectName: "Platform",
      priority: "high",
      estimatedHours: 2.5,
    });

    await handlers.get("redmyne.kanban.add")?.();

    expect(controller.addTask).toHaveBeenCalledWith(
      "Write tests",
      42,
      "Improve coverage",
      10,
      "Core",
      {
        priority: "high",
        estimatedHours: 2.5,
        linkedParentProjectId: 5,
        linkedParentProjectName: "Platform",
      }
    );
  });

  it("opens linked issue in browser with configured server", async () => {
    const server = createServer();
    registerCommands({ server });

    await handlers
      .get("redmyne.kanban.openInBrowser")
      ?.({ task: createTask({ linkedIssueId: 77 }) });

    const [uri] = vi.mocked(vscode.env.openExternal).mock.calls[0];
    expect((uri as { toString(): string }).toString()).toBe(
      "https://redmine.example.test/issues/77"
    );
  });

  it("shows missing issue error when adding issue without ID", async () => {
    registerCommands({ server: createServer() });

    await handlers.get("redmyne.addIssueToKanban")?.({});

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("No issue selected");
  });

  it("adds issue to kanban after fetching missing details and parent project", async () => {
    const server = createServer({
      getIssueById: vi.fn().mockResolvedValue({
        issue: {
          id: 90,
          subject: "Fetched issue",
          project: { id: 11, name: "Delivery" },
        },
      }),
      getProjects: vi.fn().mockResolvedValue([
        { id: 11, parent: { id: 3, name: "Programs" } },
      ]),
    });
    const { controller } = registerCommands({ server });

    await handlers.get("redmyne.addIssueToKanban")?.({ id: 90 });

    expect(controller.addTask).toHaveBeenCalledWith(
      "Fetched issue",
      90,
      "Fetched issue",
      11,
      "Delivery",
      {
        linkedParentProjectId: 3,
        linkedParentProjectName: "Programs",
      }
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Added #90 to Kanban");
  });

  it("shows fetch error when addIssueToKanban cannot load issue details", async () => {
    const server = createServer({
      getIssueById: vi.fn().mockRejectedValue(new Error("network down")),
    });
    const { controller } = registerCommands({ server });

    await handlers.get("redmyne.addIssueToKanban")?.({ id: 88 });

    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(controller.addTask).not.toHaveBeenCalled();
  });

  it("blocks timer start for done tasks", async () => {
    const task = createTask({ completedAt: "2026-02-07T01:00:00.000Z" });
    const server = createServer();
    const { controller } = registerCommands({ server, tasks: [task] });

    await handlers.get("redmyne.kanban.startTimer")?.({ task });

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Cannot start timer on done tasks"
    );
    expect(controller.startTimer).not.toHaveBeenCalled();
    expect(pickActivityForProjectSpy).not.toHaveBeenCalled();
  });

  it("starts timer after activity pick when task is valid", async () => {
    const task = createTask();
    const server = createServer();
    const { controller } = registerCommands({ server, tasks: [task] });
    pickActivityForProjectSpy.mockResolvedValue({
      activityId: 4,
      activityName: "Development",
    });

    await handlers.get("redmyne.kanban.startTimer")?.(task.id);

    expect(controller.startTimer).toHaveBeenCalledWith(task.id, 4, "Development");
  });

  it("routes simple task utility commands to controller and vscode services", async () => {
    const task = createTask({ id: "task-routes", linkedIssueId: 555, title: "Route me" });
    const { controller } = registerCommands({ tasks: [task] });

    await handlers.get("redmyne.kanban.pauseTimer")?.({ task });
    await handlers.get("redmyne.kanban.resumeTimer")?.(task.id);
    await handlers.get("redmyne.kanban.stopTimer")?.({ task });
    await handlers.get("redmyne.kanban.moveToTodo")?.({ task });
    await handlers.get("redmyne.kanban.moveUp")?.({ task });
    await handlers.get("redmyne.kanban.moveDown")?.({ task });
    await handlers.get("redmyne.kanban.copySubject")?.({ task });
    await handlers.get("redmyne.kanban.revealTimeEntry")?.({ task });

    expect(controller.pauseTimer).toHaveBeenCalledWith("task-routes");
    expect(controller.resumeTimer).toHaveBeenCalledWith("task-routes");
    expect(controller.stopTimer).toHaveBeenCalledWith("task-routes");
    expect(controller.moveToTodo).toHaveBeenCalledWith("task-routes");
    expect(controller.moveUp).toHaveBeenCalledWith("task-routes");
    expect(controller.moveDown).toHaveBeenCalledWith("task-routes");
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("Route me");
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(
      1,
      "redmyne-explorer-my-time-entries.focus"
    );
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(
      2,
      "redmyne.refreshTimeEntries"
    );
  });

  it("refreshes parent project metadata, clears done tasks, and cleans corrupted tasks", async () => {
    const doneTask = createTask({
      id: "done-1",
      completedAt: "2026-02-07T04:00:00.000Z",
    });
    const needsParentRefresh = createTask({
      id: "refresh-1",
      linkedIssueId: 31,
      linkedProjectId: 11,
      linkedProjectName: "Client A",
      linkedParentProjectId: undefined,
      linkedParentProjectName: undefined,
    });
    const alreadySynced = createTask({
      id: "refresh-2",
      linkedIssueId: 32,
      linkedProjectId: 12,
      linkedProjectName: "Client B",
      linkedParentProjectId: undefined,
      linkedParentProjectName: undefined,
    });
    const corruptedNoTitle = createTask({
      id: "corrupt-title",
      title: "",
      linkedIssueId: 41,
    });
    const corruptedNoIssueId = createTask({
      id: "corrupt-id",
      linkedIssueId: 0,
    });
    const tasks = [
      doneTask,
      needsParentRefresh,
      alreadySynced,
      corruptedNoTitle,
      corruptedNoIssueId,
    ];

    const server = createServer({
      getProjects: vi.fn().mockResolvedValue([
        { id: 11, parent: { id: 2, name: "Portfolio" } },
        { id: 12 },
      ]),
    });
    const { controller } = registerCommands({ server, tasks });
    vi.mocked(vscode.window.showWarningMessage)
      .mockResolvedValueOnce("Clear" as never)
      .mockResolvedValueOnce("Delete" as never);

    await handlers.get("redmyne.kanban.refreshParentProjects")?.();
    await handlers.get("redmyne.kanban.clearDone")?.();
    await handlers.get("redmyne.kanban.cleanup")?.();

    expect(controller.updateParentProject).toHaveBeenCalledTimes(1);
    expect(controller.updateParentProject).toHaveBeenCalledWith("refresh-1", 2, "Portfolio");
    expect(controller.clearDone).toHaveBeenCalledTimes(1);
    expect(controller.deleteTask).toHaveBeenCalledTimes(2);
    expect(controller.deleteTask).toHaveBeenCalledWith("corrupt-title");
    expect(controller.deleteTask).toHaveBeenCalledWith("corrupt-id");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Updated 1 task(s) with parent project info"
    );
  });

  it("shows active timer guard for logEarly when task has no timer", async () => {
    registerCommands({ tasks: [createTask()] });

    await handlers.get("redmyne.kanban.logEarly")?.({ task: createTask() });

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("No active timer to log");
  });

  it("logs elapsed time early and stops timer on success", async () => {
    const task = createTask({
      id: "task-log",
      title: "Implement parser",
      linkedIssueId: 66,
      timerPhase: "working",
      timerSecondsLeft: 900,
      activityId: 12,
    });
    const server = createServer({
      addTimeEntry: vi.fn().mockResolvedValue(undefined),
      getTimeEntryCustomFields: vi.fn().mockResolvedValue([]),
    });
    const { controller } = registerCommands({ server, tasks: [task] });
    controller.getWorkDurationSeconds.mockReturnValue(3600);
    promptForRequiredCustomFieldsSpy.mockResolvedValue({
      values: [{ id: 1, value: "A" }],
      cancelled: false,
      prompted: true,
    });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Log" as never);

    await handlers.get("redmyne.kanban.logEarly")?.({ task });

    expect(server.addTimeEntry).toHaveBeenCalledWith(
      66,
      12,
      "0.75",
      "Implement parser",
      undefined,
      [{ id: 1, value: "A" }]
    );
    expect(controller.addLoggedHours).toHaveBeenCalledWith("task-log", 0.75);
    expect(controller.stopTimer).toHaveBeenCalledWith("task-log");
  });

  it("shows admin hint when logEarly fails with custom-field error and no prompt", async () => {
    const task = createTask({
      id: "task-cf",
      linkedIssueId: 70,
      timerPhase: "working",
      timerSecondsLeft: 300,
    });
    const server = createServer({
      addTimeEntry: vi.fn().mockRejectedValue(new Error("Custom field required")),
      getTimeEntryCustomFields: vi.fn().mockResolvedValue([]),
    });
    registerCommands({ server, tasks: [task] });
    promptForRequiredCustomFieldsSpy.mockResolvedValue({
      values: undefined,
      cancelled: false,
      prompted: false,
    });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Log" as never);

    await handlers.get("redmyne.kanban.logEarly")?.({ task });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Custom fields API requires admin access.")
    );
  });

  it("logs and continues with timer restart on success", async () => {
    const task = createTask({
      id: "task-continue",
      title: "Ship feature",
      linkedIssueId: 71,
      timerPhase: "working",
      activityId: 13,
      activityName: "Development",
    });
    const server = createServer({
      addTimeEntry: vi.fn().mockResolvedValue(undefined),
      getTimeEntryCustomFields: vi.fn().mockResolvedValue([]),
    });
    const { controller } = registerCommands({ server, tasks: [task] });
    controller.getWorkDurationSeconds.mockReturnValue(1800);
    promptForRequiredCustomFieldsSpy.mockResolvedValue({
      values: [{ id: 2, value: "B" }],
      cancelled: false,
      prompted: true,
    });

    await handlers.get("redmyne.kanban.logAndContinue")?.({ task });

    expect(server.addTimeEntry).toHaveBeenCalledWith(
      71,
      13,
      "0.5",
      "Ship feature",
      undefined,
      [{ id: 2, value: "B" }]
    );
    expect(controller.addLoggedHours).toHaveBeenCalledWith("task-continue", 0.5);
    expect(controller.startTimer).toHaveBeenCalledWith("task-continue", 13, "Development");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Logged 0.5h, timer restarted"
    );
  });

  it("toggles timer sound setting from configure timer command", async () => {
    const { context } = registerCommands({
      contextValues: {
        "redmyne.timer.unitDuration": 60,
        "redmyne.timer.workDuration": 45,
        "redmyne.timer.soundEnabled": true,
        "redmyne.timer.progressBarWidth": 45,
      },
    });
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      setting: "sound",
    } as unknown as vscode.QuickPickItem);

    await handlers.get("redmyne.kanban.configureTimer")?.();

    expect(context.globalState.update).toHaveBeenCalledWith(
      "redmyne.timer.soundEnabled",
      false
    );
    expect(showStatusBarMessageSpy).toHaveBeenCalledWith(
      expect.stringContaining("Sound disabled"),
      2000
    );
  });

  it("updates break duration from configure timer command", async () => {
    const { context, controller } = registerCommands({
      contextValues: {
        "redmyne.timer.unitDuration": 60,
        "redmyne.timer.workDuration": 45,
        "redmyne.timer.soundEnabled": true,
        "redmyne.timer.progressBarWidth": 45,
      },
    });
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      setting: "break",
    } as unknown as vscode.QuickPickItem);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("20");

    await handlers.get("redmyne.kanban.configureTimer")?.();

    expect(context.globalState.update).toHaveBeenCalledWith("redmyne.timer.workDuration", 40);
    expect(controller.setWorkDurationSeconds).toHaveBeenCalledWith(2400);
    expect(showStatusBarMessageSpy).toHaveBeenCalledWith(
      expect.stringContaining("Break set to 20min"),
      2000
    );
  });

  it("handles toggleTimer and skipBreak edge states", async () => {
    const activeTask = createTask({ id: "active-1", timerPhase: "working" });
    const pausedTask = createTask({ id: "paused-1", timerPhase: "paused" });
    const { controller } = registerCommands({ tasks: [activeTask, pausedTask] });

    controller.getActiveTask.mockReturnValue(activeTask);
    await handlers.get("redmyne.kanban.toggleTimer")?.();
    expect(controller.pauseTimer).toHaveBeenCalledWith("active-1");

    controller.getActiveTask.mockReturnValue(undefined);
    await handlers.get("redmyne.kanban.toggleTimer")?.();
    expect(controller.resumeTimer).toHaveBeenCalledWith("paused-1");

    controller.getTasks.mockReturnValue([]);
    await handlers.get("redmyne.kanban.toggleTimer")?.();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "No active or paused timer to toggle"
    );

    controller.isOnBreak.mockReturnValue(false);
    await handlers.get("redmyne.kanban.skipBreak")?.();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("No break in progress");

    controller.isOnBreak.mockReturnValue(true);
    await handlers.get("redmyne.kanban.skipBreak")?.();
    expect(controller.skipBreak).toHaveBeenCalledTimes(1);
  });

  it("handles deferTime guard, cancel, and success flows", async () => {
    const task = createTask({
      id: "defer-1",
      timerPhase: "working",
      timerSecondsLeft: 3590,
    });
    const { controller } = registerCommands({ tasks: [task] });
    controller.getWorkDurationSeconds.mockReturnValue(3600);

    await handlers.get("redmyne.kanban.deferTime")?.({ task: createTask() });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("No active timer to defer");

    await handlers.get("redmyne.kanban.deferTime")?.({ task });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Not enough time elapsed to defer"
    );

    controller.getWorkDurationSeconds.mockReturnValue(7200);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce("Cancel" as never);
    await handlers.get("redmyne.kanban.deferTime")?.({ task: { ...task, timerSecondsLeft: 6600 } });
    expect(controller.addDeferredMinutes).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce("Defer" as never);
    await handlers.get("redmyne.kanban.deferTime")?.({ task: { ...task, timerSecondsLeft: 6600 } });
    expect(controller.addDeferredMinutes).toHaveBeenCalledWith(10);
    expect(controller.stopTimer).toHaveBeenCalledWith("defer-1");
  });

  it("covers configure timer progress bar and unit duration branches", async () => {
    const { context, controller } = registerCommands({
      contextValues: {
        "redmyne.timer.unitDuration": 60,
        "redmyne.timer.workDuration": 50,
        "redmyne.timer.soundEnabled": true,
        "redmyne.timer.progressBarWidth": 45,
      },
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      setting: "progressBar",
    } as unknown as vscode.QuickPickItem);
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("60");
    await handlers.get("redmyne.kanban.configureTimer")?.();
    expect(context.globalState.update).toHaveBeenCalledWith("redmyne.timer.progressBarWidth", 60);

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      setting: "unitDuration",
    } as unknown as vscode.QuickPickItem);
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("30");
    await handlers.get("redmyne.kanban.configureTimer")?.();
    expect(context.globalState.update).toHaveBeenCalledWith("redmyne.timer.unitDuration", 30);
    expect(context.globalState.update).toHaveBeenCalledWith("redmyne.timer.workDuration", 30);
    expect(controller.setWorkDurationSeconds).toHaveBeenCalledWith(1800);
  });

  it("registers and executes tree filter/sort commands when tree provider exists", async () => {
    const treeProvider = {
      setFilter: vi.fn(),
      setSort: vi.fn(),
      getSort: vi.fn().mockReturnValue({ direction: "asc" }),
    };
    registerCommands({ treeProvider });

    await handlers.get("redmyne.kanban.filterAll")?.();
    await handlers.get("redmyne.kanban.filterHigh")?.();
    await handlers.get("redmyne.kanban.filterMedium")?.();
    await handlers.get("redmyne.kanban.filterLow")?.();
    await handlers.get("redmyne.kanban.sortPriority")?.();
    treeProvider.getSort.mockReturnValue({ direction: "desc" });
    await handlers.get("redmyne.kanban.sortIssueId")?.();

    expect(treeProvider.setFilter).toHaveBeenCalledWith("all");
    expect(treeProvider.setFilter).toHaveBeenCalledWith("high");
    expect(treeProvider.setFilter).toHaveBeenCalledWith("medium");
    expect(treeProvider.setFilter).toHaveBeenCalledWith("low");
    expect(treeProvider.setSort).toHaveBeenCalledWith("priority");
    expect(treeProvider.setSort).toHaveBeenCalledWith("issueId");
  });
});
