import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { quickCreateVersion } from "../../../src/commands/quick-create-version";

describe("quickCreateVersion", () => {
  let mockServer: {
    getProjects: ReturnType<typeof vi.fn>;
    createVersion: ReturnType<typeof vi.fn>;
  };
  let props: { server: typeof mockServer; config: Record<string, unknown> };

  beforeEach(() => {
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
});
