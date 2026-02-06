import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerKanbanTimerHandlers } from "../../../src/kanban/kanban-timer-handlers";
import { formatHoursAsHHMM } from "../../../src/utilities/time-input";
import { playCompletionSound } from "../../../src/utilities/completion-sound";
import { showStatusBarMessage } from "../../../src/utilities/status-bar";
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
    addLoggedHours: ReturnType<typeof vi.fn>;
    markDone: ReturnType<typeof vi.fn>;
    resetTimer: ReturnType<typeof vi.fn>;
    startBreak: ReturnType<typeof vi.fn>;
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
      addLoggedHours: vi.fn().mockResolvedValue(undefined),
      markDone: vi.fn().mockResolvedValue(undefined),
      resetTimer: vi.fn().mockResolvedValue(undefined),
      startBreak: vi.fn(),
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
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Log & complete");
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

  it("logs and marks done when user chooses 'Log & complete'", async () => {
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

    expect(playCompletionSound).toHaveBeenCalledTimes(1);
    expect(formatHoursAsHHMM).toHaveBeenCalledWith(0.75);
    expect(promptForRequiredCustomFields).toHaveBeenCalledTimes(1);
    expect(confirmLogTimeOnClosedIssue).toHaveBeenCalledWith(
      server,
      123
    );
    expect(server.addTimeEntry).toHaveBeenCalledWith(
      123,
      9,
      "0.75",
      "Finish docs",
      undefined,
      []
    );
    expect(controller.addLoggedHours).toHaveBeenCalledWith("task-1", 0.75);
    expect(controller.markDone).toHaveBeenCalledWith("task-1");
    expect(controller.resetTimer).not.toHaveBeenCalled();
    expect(showStatusBarMessage).toHaveBeenCalledWith(
      "$(check) Logged 00:45 to #123",
      2000
    );
    expect(refreshAfterTimeLog).toHaveBeenCalledTimes(1);
    expect(controller.startBreak).toHaveBeenCalledTimes(1);
  });

  it("logs and resets timer when user chooses 'Log & continue'", async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(
      "Log & continue"
    );

    registerKanbanTimerHandlers({
      controller,
      getServer: () => server as never,
      globalState,
      refreshAfterTimeLog,
    });

    await timerHandler?.({
      id: "task-2",
      title: "Continue work",
      linkedIssueId: 321,
    });

    expect(server.addTimeEntry).toHaveBeenCalledWith(
      321,
      0,
      "0.75",
      "Continue work",
      undefined,
      []
    );
    expect(controller.addLoggedHours).toHaveBeenCalledWith("task-2", 0.75);
    expect(controller.resetTimer).toHaveBeenCalledWith("task-2");
    expect(controller.markDone).not.toHaveBeenCalled();
    expect(showStatusBarMessage).toHaveBeenCalledWith(
      "$(check) Logged 00:45, timer reset",
      2000
    );
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
      "Break over! Ready to start next task."
    );
  });
});
