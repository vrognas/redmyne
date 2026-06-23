import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerKanbanTimerHandlers } from "../../../src/kanban/kanban-timer-handlers";
import { playCompletionSound } from "../../../src/utilities/completion-sound";
import { promptForRequiredCustomFields } from "../../../src/utilities/custom-field-picker";
import { confirmLogTimeOnClosedIssue } from "../../../src/utilities/closed-issue-guard";

vi.mock("../../../src/utilities/time-input", () => ({
  formatHoursAsHHMM: vi.fn(() => "00:45"),
}));

vi.mock("../../../src/utilities/completion-sound", () => ({
  playCompletionSound: vi.fn(),
}));

vi.mock("../../../src/utilities/status-bar", () => ({
  showStatusBarMessage: vi.fn(),
}));

vi.mock("../../../src/utilities/custom-field-picker", () => ({
  promptForRequiredCustomFields: vi.fn(),
}));

vi.mock("../../../src/utilities/closed-issue-guard", () => ({
  confirmLogTimeOnClosedIssue: vi.fn(),
}));

type TimerTask = {
  id: string;
  title: string;
  linkedIssueId: number;
  activityId?: number;
};

describe("registerKanbanTimerHandlers", () => {
  let timerHandler: ((task: TimerTask) => Promise<void> | void) | undefined;
  let breakHandler: (() => Promise<void> | void) | undefined;

  let controller: {
    onTimerComplete: ReturnType<typeof vi.fn>;
    onBreakComplete: ReturnType<typeof vi.fn>;
    getWorkDurationSeconds: ReturnType<typeof vi.fn>;
    getBreakDurationSeconds: ReturnType<typeof vi.fn>;
    getTaskById: ReturnType<typeof vi.fn>;
    accruePending: ReturnType<typeof vi.fn>;
    consumePending: ReturnType<typeof vi.fn>;
    keepWorking: ReturnType<typeof vi.fn>;
    addLoggedHours: ReturnType<typeof vi.fn>;
    markDone: ReturnType<typeof vi.fn>;
  };

  let server: {
    getTimeEntryCustomFields: ReturnType<typeof vi.fn>;
    addTimeEntry: ReturnType<typeof vi.fn>;
  };

  let globalState: vscode.Memento;
  let refreshAfterTimeLog: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    timerHandler = undefined;
    breakHandler = undefined;

    controller = {
      onTimerComplete: vi.fn((listener: (task: TimerTask) => Promise<void>) => {
        timerHandler = listener;
        return { dispose: vi.fn() } as unknown as vscode.Disposable;
      }),
      onBreakComplete: vi.fn((listener: () => Promise<void>) => {
        breakHandler = listener;
        return { dispose: vi.fn() } as unknown as vscode.Disposable;
      }),
      getWorkDurationSeconds: vi.fn(() => 45 * 60),
      getBreakDurationSeconds: vi.fn(() => 15 * 60),
      getTaskById: vi.fn(() => ({ id: "task-1", pendingSeconds: 45 * 60 })),
      accruePending: vi.fn().mockResolvedValue(undefined),
      consumePending: vi.fn().mockResolvedValue(45 * 60),
      keepWorking: vi.fn(),
      addLoggedHours: vi.fn().mockResolvedValue(undefined),
      markDone: vi.fn().mockResolvedValue(undefined),
    };

    server = {
      getTimeEntryCustomFields: vi.fn().mockResolvedValue([]),
      addTimeEntry: vi.fn().mockResolvedValue(undefined),
    };

    globalState = {
      get: vi.fn().mockReturnValue(true),
    } as unknown as vscode.Memento;

    refreshAfterTimeLog = vi.fn();

    vi.mocked(promptForRequiredCustomFields).mockResolvedValue({
      cancelled: false,
      values: [],
    });
    vi.mocked(confirmLogTimeOnClosedIssue).mockResolvedValue(true);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Log it");
  });

  it("registers timer-complete and break-complete listeners", () => {
    const disposables = registerKanbanTimerHandlers({
      controller,
      getServer: () => server as never,
      globalState,
      refreshAfterTimeLog,
    });

    expect(disposables).toHaveLength(2);
    expect(controller.onTimerComplete).toHaveBeenCalledTimes(1);
    expect(controller.onBreakComplete).toHaveBeenCalledTimes(1);
  });

  it("logs the accrued time plus a full break and marks done on 'Log it'", async () => {
    // Card has one 45-min work unit banked; Log it adds a full 15-min break.
    controller.getTaskById.mockReturnValue({ id: "task-1", pendingSeconds: 45 * 60 });

    registerKanbanTimerHandlers({
      controller,
      getServer: () => server as never,
      globalState,
      refreshAfterTimeLog,
    });

    await timerHandler?.({
      id: "task-1",
      title: "Finish docs",
      linkedIssueId: 123,
      activityId: 9,
    });

    // Banks the finished work unit before offering the modal.
    expect(controller.accruePending).toHaveBeenCalledWith("task-1", 45 * 60);
    // 45 work (pending) + 15 break = 60 min = 1h.
    expect(server.addTimeEntry).toHaveBeenCalledWith(
      123,
      9,
      "1",
      "Finish docs",
      undefined,
      []
    );
    expect(controller.addLoggedHours).toHaveBeenCalledWith("task-1", 1);
    expect(controller.consumePending).toHaveBeenCalledWith("task-1");
    expect(controller.markDone).toHaveBeenCalledWith("task-1");
    expect(controller.keepWorking).not.toHaveBeenCalled();
    expect(refreshAfterTimeLog).toHaveBeenCalledTimes(1);
  });

  it("defers via 'Keep working' — starts the cycle, no log", async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(
      "Keep working" as never
    );

    registerKanbanTimerHandlers({
      controller,
      getServer: () => server as never,
      globalState,
      refreshAfterTimeLog,
    });

    await timerHandler?.({
      id: "task-2",
      title: "Keep going",
      linkedIssueId: 321,
    });

    expect(controller.accruePending).toHaveBeenCalledWith("task-2", 45 * 60);
    expect(controller.keepWorking).toHaveBeenCalledWith("task-2");
    expect(server.addTimeEntry).not.toHaveBeenCalled();
    expect(controller.markDone).not.toHaveBeenCalled();
  });

  it("does nothing when no server is available", async () => {
    registerKanbanTimerHandlers({
      controller,
      getServer: () => undefined,
      globalState,
      refreshAfterTimeLog,
    });

    await timerHandler?.({
      id: "task-3",
      title: "No server",
      linkedIssueId: 77,
    });

    expect(promptForRequiredCustomFields).not.toHaveBeenCalled();
    expect(server.addTimeEntry).not.toHaveBeenCalled();
    expect(controller.addLoggedHours).not.toHaveBeenCalled();
  });

  it("plays break notification sound and shows message", async () => {
    registerKanbanTimerHandlers({
      controller,
      getServer: () => server as never,
      globalState,
      refreshAfterTimeLog,
    });

    await breakHandler?.();

    expect(playCompletionSound).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Break over! Back to work."
    );
  });
});
