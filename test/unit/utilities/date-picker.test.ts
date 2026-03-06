import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { pickDate, pickOptionalDate, validateDateInput } from "../../../src/utilities/date-picker";

describe("date-picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validates date input format and future constraints", () => {
    expect(validateDateInput("")).toBe("Date required");
    expect(validateDateInput("2026/01/01")).toBe("Use YYYY-MM-DD format");
    expect(validateDateInput("invalid-date")).toBe("Use YYYY-MM-DD format");

    const future = new Date();
    future.setDate(future.getDate() + 1);
    const futureStr = future.toISOString().slice(0, 10);
    expect(validateDateInput(futureStr)).toBe("Cannot log time in the future");
    expect(validateDateInput(futureStr, true)).toBeNull();
  });

  it("pickDate returns preset and custom values", async () => {
    vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items) => {
      const options = items as Array<{ action: string }>;
      return options.find((option) => option.action === "preset") as never;
    });
    const preset = await pickDate({ showYesterday: false });
    expect(preset).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(async (items) => {
      const options = items as Array<{ action: string }>;
      return options.find((option) => option.action === "pick") as never;
    });
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("2026-02-01");
    await expect(pickDate()).resolves.toBe("2026-02-01");
  });

  it("pickDate supports future presets and custom input validation callback", async () => {
    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(async (items) => {
      const options = items as Array<{ label: string; action: string; value: string }>;
      return options.find((option) => option.label.includes("Tomorrow")) as never;
    });
    const tomorrow = await pickDate({ showFutureDates: true });
    expect(tomorrow).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(async (items) => {
      const options = items as Array<{ action: string }>;
      return options.find((option) => option.action === "pick") as never;
    });
    vi.mocked(vscode.window.showInputBox).mockImplementationOnce(async (opts) => {
      expect(opts?.validateInput?.("bad")).toBe("Use YYYY-MM-DD format");
      return "2026-02-02";
    });
    await expect(pickDate({ allowFuture: true })).resolves.toBe("2026-02-02");
  });

  it("pickOptionalDate handles nochange, clear, set, and custom-cancel", async () => {
    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(async (items) => {
      const options = items as Array<{ action: string }>;
      return options.find((option) => option.action === "nochange") as never;
    });
    await expect(pickOptionalDate("Due Date", "2026-01-10", "Edit")).resolves.toEqual({
      changed: false,
      value: null,
    });

    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(async (items) => {
      const options = items as Array<{ action: string }>;
      return options.find((option) => option.action === "clear") as never;
    });
    await expect(pickOptionalDate("Due Date", "2026-01-10", "Edit")).resolves.toEqual({
      changed: true,
      value: null,
    });

    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(async (items) => {
      const options = items as Array<{ action: string }>;
      return options.find((option) => option.action === "set") as never;
    });
    const setResult = await pickOptionalDate("Start Date", undefined, "Edit");
    expect(setResult?.changed).toBe(true);
    expect(setResult?.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(async (items) => {
      const options = items as Array<{ action: string }>;
      return options.find((option) => option.action === "pick") as never;
    });
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
    await expect(pickOptionalDate("Start Date", "2026-01-01", "Edit")).resolves.toBeUndefined();

    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(async (items) => {
      const options = items as Array<{ action: string }>;
      return options.find((option) => option.action === "pick") as never;
    });
    vi.mocked(vscode.window.showInputBox).mockImplementationOnce(async (opts) => {
      expect(opts?.validateInput?.("")).toBe("Start Date required");
      expect(opts?.validateInput?.("bad")).toBe("Use YYYY-MM-DD format");
      return "2026-01-09";
    });
    await expect(pickOptionalDate("Start Date", "2026-01-01", "Edit")).resolves.toEqual({
      changed: true,
      value: "2026-01-09",
    });
  });
});
