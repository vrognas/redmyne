import { describe, it, expect, vi, beforeEach } from "vitest";
import { wizardPick, WIZARD_BACK, isBack, WizardPickItem } from "../../../src/utilities/wizard";
import * as vscode from "vscode";

describe("wizard utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
