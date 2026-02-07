import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { quickCreateVersion } from "../../../src/commands/quick-create-version";
import { WIZARD_BACK } from "../../../src/utilities/wizard";

describe("quickCreateVersion", () => {
  let mockServer: {
    getProjects: ReturnType<typeof vi.fn>;
    createVersion: ReturnType<typeof vi.fn>;
  };
  let props: { server: typeof mockServer; config: Record<string, unknown> };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();

    mockServer = {
      getProjects: vi.fn().mockResolvedValue([
        {
          id: 1,
          name: "Project Alpha",
          toQuickPickItem: () => ({ label: "Project Alpha", description: "Alpha" }),
        },
      ]),
      createVersion: vi.fn().mockResolvedValue({
        id: 77,
        name: "Sprint 1",
      }),
    };

    props = { server: mockServer, config: {} };
  });

  function mockWizardInputs(values: string[]): void {
    let createQuickPickCallCount = 0;
    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() => {
      const value = values[createQuickPickCallCount++];
      let onAcceptHandler: (() => void) | undefined;
      const qp = {
        title: "",
        placeholder: "",
        items: [],
        selectedItems: [] as { label: string }[],
        canSelectMany: false,
        value: "",
        onDidChangeValue: () => ({ dispose: vi.fn() }),
        onDidAccept: (handler: () => void) => { onAcceptHandler = handler; return { dispose: vi.fn() }; },
        onDidHide: () => ({ dispose: vi.fn() }),
        show: vi.fn(() => {
          qp.value = value;
          qp.selectedItems = [{ label: `$(check) Accept: "${value}"` }];
          if (onAcceptHandler) onAcceptHandler();
        }),
        hide: vi.fn(),
        dispose: vi.fn(),
      };
      return qp as unknown as vscode.QuickPick<vscode.QuickPickItem>;
    });
  }

  function mockWizardInputActions(actions: Array<{ type: "value" | "back" | "cancel"; value?: string }>): void {
    let createQuickPickCallCount = 0;
    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() => {
      const action = actions[createQuickPickCallCount++] ?? { type: "cancel" as const };
      let onAcceptHandler: (() => void) | undefined;
      let onHideHandler: (() => void) | undefined;
      const qp = {
        title: "",
        placeholder: "",
        items: [] as vscode.QuickPickItem[],
        selectedItems: [] as vscode.QuickPickItem[],
        canSelectMany: false,
        value: "",
        onDidChangeValue: () => ({ dispose: vi.fn() }),
        onDidAccept: (handler: () => void) => {
          onAcceptHandler = handler;
          return { dispose: vi.fn() };
        },
        onDidHide: (handler: () => void) => {
          onHideHandler = handler;
          return { dispose: vi.fn() };
        },
        show: vi.fn(() => {
          if (action.type === "cancel") {
            if (onHideHandler) onHideHandler();
            return;
          }
          if (action.type === "back") {
            qp.selectedItems = [{ label: "$(arrow-left) Back" }];
          } else {
            qp.value = action.value ?? "";
            qp.selectedItems = [{ label: `$(check) Accept: "${qp.value}"` }];
          }
          if (onAcceptHandler) onAcceptHandler();
        }),
        hide: vi.fn(() => {
          if (onHideHandler) onHideHandler();
        }),
        dispose: vi.fn(),
      };
      return qp as unknown as vscode.QuickPick<vscode.QuickPickItem>;
    });
  }

  it("creates version from wizard inputs", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({
        label: "Project Alpha",
        data: { label: "Project Alpha", id: 1 },
      } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({
        label: "Open",
        data: "open",
      } as unknown as vscode.QuickPickItem);

    mockWizardInputs(["Sprint 1", "2026-12-31", "Release notes"]);

    const result = await quickCreateVersion(props as never);

    expect(result).toEqual({ id: 77, name: "Sprint 1" });
    expect(mockServer.createVersion).toHaveBeenCalledWith(1, {
      name: "Sprint 1",
      description: "Release notes",
      due_date: "2026-12-31",
      status: "open",
    });
  });

  it("returns undefined when user cancels project selection", async () => {
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValueOnce(undefined);

    const result = await quickCreateVersion(props as never);

    expect(result).toBeUndefined();
    expect(mockServer.createVersion).not.toHaveBeenCalled();
  });

  it("uses preselected project and skips project picker", async () => {
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValueOnce({
      label: "Open",
      data: "open",
    } as unknown as vscode.QuickPickItem);
    mockWizardInputs(["Sprint preselected", "2026-12-01", "Desc"]);

    const result = await quickCreateVersion(props as never, 1);

    expect(result).toEqual({ id: 77, name: "Sprint 1" });
    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(mockServer.createVersion).toHaveBeenCalledWith(1, {
      name: "Sprint preselected",
      description: "Desc",
      due_date: "2026-12-01",
      status: "open",
    });
  });

  it("falls back to project picker when preselected project is not found", async () => {
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValueOnce(undefined);

    const result = await quickCreateVersion(props as never, 999);

    expect(result).toBeUndefined();
    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when unexpected back is selected at project step", async () => {
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValueOnce({
      label: "$(arrow-left) Back",
      data: WIZARD_BACK,
    } as unknown as vscode.QuickPickItem);

    const result = await quickCreateVersion(props as never);

    expect(result).toBeUndefined();
    expect(mockServer.createVersion).not.toHaveBeenCalled();
  });

  it("supports back navigation from step 2 and eventual cancel", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({
        label: "Project Alpha",
        data: { label: "Project Alpha", id: 1 },
      } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce(undefined);

    // Step 2 -> value, Step 3 -> back, Step 2 again -> back, Step 1 cancel
    mockWizardInputActions([
      { type: "value", value: "Sprint BackFlow" },
      { type: "back" },
      { type: "back" },
    ]);

    const result = await quickCreateVersion(props as never);

    expect(result).toBeUndefined();
    expect(mockServer.createVersion).not.toHaveBeenCalled();
  });

  it("returns undefined when user cancels on name step", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({
        label: "Project Alpha",
        data: { label: "Project Alpha", id: 1 },
      } as unknown as vscode.QuickPickItem);
    mockWizardInputActions([{ type: "cancel" }]);
    expect(await quickCreateVersion(props as never)).toBeUndefined();
  });

  it("returns undefined when user cancels on due-date step", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({
        label: "Project Alpha",
        data: { label: "Project Alpha", id: 1 },
      } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({
        label: "Open",
        data: "open",
      } as unknown as vscode.QuickPickItem);
    mockWizardInputActions([
      { type: "value", value: "Sprint A" },
      { type: "cancel" },
    ]);
    expect(await quickCreateVersion(props as never)).toBeUndefined();
  });

  it("returns undefined when user cancels on description step", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({
        label: "Project Alpha",
        data: { label: "Project Alpha", id: 1 },
      } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({
        label: "Open",
        data: "open",
      } as unknown as vscode.QuickPickItem);
    mockWizardInputActions([
      { type: "value", value: "Sprint B" },
      { type: "value", value: "2026-12-01" },
      { type: "cancel" },
    ]);
    expect(await quickCreateVersion(props as never)).toBeUndefined();
  });

  it("shows error message when createVersion throws", async () => {
    mockServer.createVersion.mockRejectedValue(new Error("cannot create"));
    const errorSpy = vi.spyOn(vscode.window, "showErrorMessage");

    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({
        label: "Project Alpha",
        data: { label: "Project Alpha", id: 1 },
      } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({
        label: "Open",
        data: "open",
      } as unknown as vscode.QuickPickItem);

    mockWizardInputs(["Sprint fail", "2026-12-31", "Desc"]);

    const result = await quickCreateVersion(props as never);

    expect(result).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith("Failed to create version: cannot create");
  });
});
