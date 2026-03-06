import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerMonthlyScheduleCommands } from "../../../src/commands/monthly-schedule-commands";
import { WeeklySchedule } from "../../../src/utilities/flexibility-calculator";
import { MONTHLY_SCHEDULES_KEY } from "../../../src/utilities/monthly-schedule";
import * as statusBarUtil from "../../../src/utilities/status-bar";

type Handler = (...args: unknown[]) => unknown;

const DEFAULT_SCHEDULE: WeeklySchedule = {
  Mon: 8,
  Tue: 8,
  Wed: 8,
  Thu: 8,
  Fri: 8,
  Sat: 0,
  Sun: 0,
};

describe("registerMonthlyScheduleCommands", () => {
  let handlers: Map<string, Handler>;
  let context: vscode.ExtensionContext;
  let globalStateUpdate: ReturnType<typeof vi.fn>;
  let setOverrides: ReturnType<typeof vi.fn>;
  let refreshTree: ReturnType<typeof vi.fn>;
  let setTreeSchedules: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(statusBarUtil, "showStatusBarMessage").mockImplementation(() => undefined);

    handlers = new Map<string, Handler>();
    globalStateUpdate = vi.fn().mockResolvedValue(undefined);
    context = {
      subscriptions: [],
      globalState: {
        update: globalStateUpdate,
      },
    } as unknown as vscode.ExtensionContext;

    setOverrides = vi.fn();
    refreshTree = vi.fn();
    setTreeSchedules = vi.fn();

    vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
      handlers.set(command as string, callback as Handler);
      return { dispose: vi.fn() } as unknown as vscode.Disposable;
    });

    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, fallback: WeeklySchedule) => fallback),
      update: vi.fn(),
    } as unknown as vscode.WorkspaceConfiguration);
  });

  function registerAndGetHandler(overrides: Record<string, WeeklySchedule>) {
    registerMonthlyScheduleCommands(context, {
      getOverrides: () => overrides,
      setOverrides,
      refreshTree,
      setTreeSchedules,
    });
    return handlers.get("redmyne.workingHours.editMonth") as () => Promise<void>;
  }

  it("clears an override and persists changes", async () => {
    const overrides: Record<string, WeeklySchedule> = {
      "2026-02": { Mon: 4, Tue: 4, Wed: 4, Thu: 4, Fri: 4, Sat: 0, Sun: 0 },
    };
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ key: "2026-02", hasOverride: true } as never)
      .mockResolvedValueOnce({ action: "clear" } as never);

    const handler = registerAndGetHandler(overrides);
    await handler();

    expect(overrides["2026-02"]).toBeUndefined();
    expect(setOverrides).toHaveBeenCalledWith(overrides);
    expect(globalStateUpdate).toHaveBeenCalledWith(MONTHLY_SCHEDULES_KEY, overrides);
    expect(setTreeSchedules).toHaveBeenCalledWith(overrides);
    expect(refreshTree).toHaveBeenCalledTimes(1);
  });

  it("copies default schedule into selected month and persists", async () => {
    const overrides: Record<string, WeeklySchedule> = {};
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ key: "2026-03", hasOverride: false } as never)
      .mockResolvedValueOnce({ action: "copy" } as never);

    const handler = registerAndGetHandler(overrides);
    await handler();

    expect(overrides["2026-03"]).toEqual(DEFAULT_SCHEDULE);
    expect(setOverrides).toHaveBeenCalledWith(overrides);
    expect(globalStateUpdate).toHaveBeenCalledWith(MONTHLY_SCHEDULES_KEY, overrides);
    expect(setTreeSchedules).toHaveBeenCalledWith(overrides);
    expect(refreshTree).toHaveBeenCalledTimes(1);
  });

  it("saves partial edit when user cancels and confirms save", async () => {
    const overrides: Record<string, WeeklySchedule> = {};
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ key: "2026-04", hasOverride: false } as never)
      .mockResolvedValueOnce({ action: "edit" } as never);
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce("7")
      .mockResolvedValueOnce(undefined);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Save" as never);

    const handler = registerAndGetHandler(overrides);
    await handler();

    expect(overrides["2026-04"]).toEqual({
      Mon: 7,
      Tue: 8,
      Wed: 8,
      Thu: 8,
      Fri: 8,
      Sat: 0,
      Sun: 0,
    });
    expect(globalStateUpdate).toHaveBeenCalledWith(MONTHLY_SCHEDULES_KEY, overrides);
    expect(setTreeSchedules).toHaveBeenCalledWith(overrides);
    expect(refreshTree).toHaveBeenCalledTimes(1);
  });
});
