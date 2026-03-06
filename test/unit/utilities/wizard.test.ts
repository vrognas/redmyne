import { describe, it, expect, vi, beforeEach } from "vitest";
import { wizardPick, wizardInput, WIZARD_BACK, isBack, WizardPickItem } from "../../../src/utilities/wizard";
import * as vscode from "vscode";

describe("wizard utilities", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();

    vi.mocked(vscode.window.showQuickPick).mockReset();
    vi.mocked(vscode.window.showInputBox).mockReset();
    vi.mocked(vscode.window.createQuickPick).mockReset();
  });

  describe("wizardPick", () => {
    it("returns selected item's data", async () => {
      const mockShowQuickPick = vi.mocked(vscode.window.showQuickPick);
      const items: WizardPickItem<number>[] = [
        { label: "Option 1", data: 1 },
        { label: "Option 2", data: 2 },
      ];

      mockShowQuickPick.mockResolvedValue(items[1]);

      const result = await wizardPick(items, { title: "Test" });

      expect(result).toBe(2);
    });

    it("returns undefined when cancelled", async () => {
      const mockShowQuickPick = vi.mocked(vscode.window.showQuickPick);
      mockShowQuickPick.mockResolvedValue(undefined);

      const result = await wizardPick([], { title: "Test" });

      expect(result).toBeUndefined();
    });

    it("includes back option when showBack is true", async () => {
      const mockShowQuickPick = vi.mocked(vscode.window.showQuickPick);
      mockShowQuickPick.mockResolvedValue(undefined);

      const items: WizardPickItem<string>[] = [{ label: "Option", data: "opt" }];

      await wizardPick(items, { title: "Test" }, true);

      // Verify back item was included
      const calledItems = mockShowQuickPick.mock.calls[0][0] as WizardPickItem[];
      expect(calledItems[0].label).toContain("Back");
    });

    it("returns WIZARD_BACK when back is selected", async () => {
      const mockShowQuickPick = vi.mocked(vscode.window.showQuickPick);

      // Simulate selecting the back item
      mockShowQuickPick.mockResolvedValue({
        label: "$(arrow-left) Back",
        data: WIZARD_BACK,
      } as WizardPickItem<typeof WIZARD_BACK>);

      const result = await wizardPick([], { title: "Test" }, true);

      expect(result).toBe(WIZARD_BACK);
    });

    it("returns undefined when selected item has no data", async () => {
      const mockShowQuickPick = vi.mocked(vscode.window.showQuickPick);
      mockShowQuickPick.mockResolvedValue({ label: "Plain item" } as vscode.QuickPickItem);

      const result = await wizardPick([], { title: "Test" }, false);

      expect(result).toBeUndefined();
    });

    it("does not include back option when showBack is false", async () => {
      const mockShowQuickPick = vi.mocked(vscode.window.showQuickPick);
      mockShowQuickPick.mockResolvedValue(undefined);

      const items: WizardPickItem<string>[] = [{ label: "Option", data: "opt" }];

      await wizardPick(items, { title: "Test" }, false);

      const calledItems = mockShowQuickPick.mock.calls[0][0] as WizardPickItem[];
      expect(calledItems.some((i) => i.label?.includes("Back"))).toBe(false);
    });
  });

  describe("isBack", () => {
    it("returns true for WIZARD_BACK", () => {
      expect(isBack(WIZARD_BACK)).toBe(true);
    });

    it("returns false for other values", () => {
      expect(isBack(undefined)).toBe(false);
      expect(isBack(null)).toBe(false);
      expect(isBack("back")).toBe(false);
      expect(isBack(123)).toBe(false);
    });
  });

  describe("wizardInput", () => {
    it("uses InputBox directly when showBack is false", async () => {
      vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("typed-value");

      const result = await wizardInput({ title: "Input step", prompt: "Value" }, false);

      expect(result).toBe("typed-value");
    });

    it("returns WIZARD_BACK when back item is accepted", async () => {
      let onAccept: (() => void) | undefined;
      let onHide: (() => void) | undefined;
      const quickPick = {
        title: "",
        placeholder: "",
        items: [] as vscode.QuickPickItem[],
        selectedItems: [{ label: "$(arrow-left) Back" }] as vscode.QuickPickItem[],
        canSelectMany: false,
        value: "",
        onDidChangeValue: vi.fn(() => ({ dispose: vi.fn() })),
        onDidAccept: vi.fn((handler: () => void) => {
          onAccept = handler;
          return { dispose: vi.fn() };
        }),
        onDidHide: vi.fn((handler: () => void) => {
          onHide = handler;
          return { dispose: vi.fn() };
        }),
        show: vi.fn(() => onAccept?.()),
        hide: vi.fn(() => onHide?.()),
        dispose: vi.fn(),
      } as unknown as vscode.QuickPick<vscode.QuickPickItem>;
      vi.spyOn(vscode.window, "createQuickPick").mockReturnValue(quickPick);

      const result = await wizardInput({ title: "Input step", prompt: "Value" }, true);

      expect(result).toBe(WIZARD_BACK);
    });

    it("handles validation error and success paths in back-enabled mode", async () => {
      let onAccept: (() => void) | undefined;
      let onHide: (() => void) | undefined;
      let onChange: ((value: string) => void) | undefined;
      const quickPick = {
        title: "",
        placeholder: "",
        items: [] as vscode.QuickPickItem[],
        selectedItems: [] as vscode.QuickPickItem[],
        canSelectMany: false,
        value: "",
        onDidChangeValue: vi.fn((handler: (value: string) => void) => {
          onChange = handler;
          return { dispose: vi.fn() };
        }),
        onDidAccept: vi.fn((handler: () => void) => {
          onAccept = handler;
          return { dispose: vi.fn() };
        }),
        onDidHide: vi.fn((handler: () => void) => {
          onHide = handler;
          return { dispose: vi.fn() };
        }),
        show: vi.fn(() => {
          quickPick.value = "bad";
          quickPick.selectedItems = [{ label: '$(check) Accept: "bad"' } as vscode.QuickPickItem];
          onChange?.("bad");
          onAccept?.();
          quickPick.hide();
        }),
        hide: vi.fn(() => onHide?.()),
        dispose: vi.fn(),
      } as unknown as vscode.QuickPick<vscode.QuickPickItem>;
      vi.spyOn(vscode.window, "createQuickPick").mockReturnValue(quickPick);

      const badResult = await wizardInput(
        {
          title: "Input step",
          validateInput: (value) => (value === "bad" ? "Bad value" : null),
        },
        true
      );
      expect(badResult).toBeUndefined();
      expect(quickPick.items[0]?.label).toContain("Bad value");

      quickPick.show = vi.fn(() => {
        quickPick.value = "good";
        quickPick.selectedItems = [{ label: '$(check) Accept: "good"' } as vscode.QuickPickItem];
        onChange?.("good");
        onAccept?.();
      });
      const goodResult = await wizardInput(
        {
          title: "Input step",
          validateInput: (value) => (value.trim() ? null : "Required"),
        },
        true
      );
      expect(goodResult).toBe("good");
    });

    it("handles empty value required validation branch", async () => {
      let onAccept: (() => void) | undefined;
      let onHide: (() => void) | undefined;
      let onChange: ((value: string) => void) | undefined;
      const quickPick = {
        title: "",
        placeholder: "",
        items: [] as vscode.QuickPickItem[],
        selectedItems: [] as vscode.QuickPickItem[],
        canSelectMany: false,
        value: "",
        onDidChangeValue: vi.fn((handler: (value: string) => void) => {
          onChange = handler;
          return { dispose: vi.fn() };
        }),
        onDidAccept: vi.fn((handler: () => void) => {
          onAccept = handler;
          return { dispose: vi.fn() };
        }),
        onDidHide: vi.fn((handler: () => void) => {
          onHide = handler;
          return { dispose: vi.fn() };
        }),
        show: vi.fn(() => {
          quickPick.value = "";
          onChange?.("");
          onAccept?.();
          quickPick.hide();
        }),
        hide: vi.fn(() => onHide?.()),
        dispose: vi.fn(),
      } as unknown as vscode.QuickPick<vscode.QuickPickItem>;
      vi.spyOn(vscode.window, "createQuickPick").mockReturnValue(quickPick);

      const result = await wizardInput(
        {
          title: "Input step",
          validateInput: (value) => (value.trim() ? null : "Required"),
        },
        true
      );

      expect(result).toBeUndefined();
      expect(quickPick.items[0]?.label).toContain("Required");
    });
  });
});
