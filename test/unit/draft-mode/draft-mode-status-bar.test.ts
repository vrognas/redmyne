import { describe, it, expect, vi, beforeEach } from "vitest";
import { DraftModeStatusBar } from "../../../src/draft-mode/draft-mode-status-bar";
import type { DraftQueue } from "../../../src/draft-mode/draft-queue";
import type { DraftModeManager } from "../../../src/draft-mode/draft-mode-manager";
import type * as vscode from "vscode";

function createMockStatusBarItem() {
  return {
    text: "",
    tooltip: undefined as unknown,
    backgroundColor: undefined,
    color: undefined,
    command: undefined,
    name: undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
}

function createMockQueue(count: number): DraftQueue {
  const handlers: Set<() => void> = new Set();
  return {
    count,
    onDidChange: vi.fn().mockImplementation((handler: () => void) => {
      handlers.add(handler);
      return { dispose: () => handlers.delete(handler) };
    }),
    _triggerChange: () => handlers.forEach(h => h()),
  } as unknown as DraftQueue;
}

function createMockManager(enabled: boolean): DraftModeManager {
  const handlers: Set<() => void> = new Set();
  return {
    isEnabled: enabled,
    onDidChangeEnabled: vi.fn().mockImplementation((handler: () => void) => {
      handlers.add(handler);
      return { dispose: () => handlers.delete(handler) };
    }),
    _triggerChange: () => handlers.forEach(h => h()),
    _setEnabled: function(val: boolean) { (this as { isEnabled: boolean }).isEnabled = val; },
  } as unknown as DraftModeManager;
}

// Mock vscode.window.createStatusBarItem
vi.mock("vscode", () => {
  // Create a proper constructor function for ThemeColor
  function ThemeColor(this: { id: string }, id: string) {
    this.id = id;
  }
  // Create a proper constructor function for MarkdownString
  function MarkdownString(this: { value: string; supportThemeIcons: boolean }, str: string) {
    this.value = str;
    this.supportThemeIcons = false;
  }

  return {
    window: {
      createStatusBarItem: vi.fn(() => createMockStatusBarItem()),
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor,
    MarkdownString,
  };
});

describe("DraftModeStatusBar", () => {
  let mockStatusBarItem: ReturnType<typeof createMockStatusBarItem>;
  let queue: DraftQueue & { _triggerChange: () => void };
  let manager: DraftModeManager & { _triggerChange: () => void; _setEnabled: (val: boolean) => void };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockStatusBarItem = createMockStatusBarItem();
    const vscode = await import("vscode");
    vi.mocked(vscode.window.createStatusBarItem).mockReturnValue(mockStatusBarItem as unknown as vscode.StatusBarItem);
    queue = createMockQueue(0) as DraftQueue & { _triggerChange: () => void };
    manager = createMockManager(false) as DraftModeManager & { _triggerChange: () => void; _setEnabled: (val: boolean) => void };
  });

  describe("constructor", () => {
    it("creates status bar item with correct properties", () => {
      new DraftModeStatusBar(queue, manager);

      expect(mockStatusBarItem.command).toBe("redmyne.reviewDrafts");
      expect(mockStatusBarItem.name).toBe("Redmyne Draft Mode");
    });

    it("subscribes to queue changes", () => {
      new DraftModeStatusBar(queue, manager);
      expect(queue.onDidChange).toHaveBeenCalled();
    });

    it("subscribes to manager enabled changes", () => {
      new DraftModeStatusBar(queue, manager);
      expect(manager.onDidChangeEnabled).toHaveBeenCalled();
    });
  });

  describe("update", () => {
    it("hides status bar when draft mode disabled", () => {
      manager._setEnabled(false);
      new DraftModeStatusBar(queue, manager);

      expect(mockStatusBarItem.hide).toHaveBeenCalled();
      expect(mockStatusBarItem.show).not.toHaveBeenCalled();
    });

    it("shows status bar when draft mode enabled", () => {
      manager._setEnabled(true);
      new DraftModeStatusBar(queue, manager);

      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });

    it("updates when queue changes", () => {
      manager._setEnabled(true);
      new DraftModeStatusBar(queue, manager);

      mockStatusBarItem.show.mockClear();
      queue._triggerChange();

      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });

    it("updates when manager enabled state changes", () => {
      new DraftModeStatusBar(queue, manager);
      mockStatusBarItem.show.mockClear();
      mockStatusBarItem.hide.mockClear();

      manager._setEnabled(true);
      manager._triggerChange();

      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });
  });

  describe("dispose", () => {
    it("disposes status bar item", () => {
      const statusBar = new DraftModeStatusBar(queue, manager);
      statusBar.dispose();

      expect(mockStatusBarItem.dispose).toHaveBeenCalled();
    });
  });
});
