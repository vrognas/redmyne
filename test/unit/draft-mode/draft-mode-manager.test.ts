import { describe, it, expect, vi, beforeEach } from "vitest";
import { DraftModeManager } from "../../../src/draft-mode/draft-mode-manager";

describe("DraftModeManager", () => {
  let manager: DraftModeManager;
  let mockStorage: Map<string, unknown>;
  let mockSetContext: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockStorage = new Map();
    mockSetContext = vi.fn();
    manager = new DraftModeManager({
      globalState: {
        get: (key: string) => mockStorage.get(key),
        update: (key: string, value: unknown) => {
          mockStorage.set(key, value);
          return Promise.resolve();
        },
      },
      setContext: mockSetContext,
    });
  });

  describe("isEnabled", () => {
    it("returns false by default", () => {
      expect(manager.isEnabled).toBe(false);
    });

    it("returns true after enable", async () => {
      await manager.enable();
      expect(manager.isEnabled).toBe(true);
    });

    it("returns false after disable", async () => {
      await manager.enable();
      await manager.disable();
      expect(manager.isEnabled).toBe(false);
    });
  });

  describe("enable", () => {
    it("persists enabled state", async () => {
      await manager.enable();
      expect(mockStorage.get("redmyne.draftModeEnabled")).toBe(true);
    });

    it("sets context variable", async () => {
      await manager.enable();
      expect(mockSetContext).toHaveBeenCalledWith("redmyne:draftMode", true);
    });

    it("emits change event", async () => {
      const handler = vi.fn();
      manager.onDidChangeEnabled(handler);

      await manager.enable();

      expect(handler).toHaveBeenCalledWith(true);
    });

    it("does not emit if already enabled", async () => {
      await manager.enable();

      const handler = vi.fn();
      manager.onDidChangeEnabled(handler);
      await manager.enable();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("disable", () => {
    it("persists disabled state", async () => {
      await manager.enable();
      await manager.disable();
      expect(mockStorage.get("redmyne.draftModeEnabled")).toBe(false);
    });

    it("sets context variable", async () => {
      await manager.enable();
      await manager.disable();
      expect(mockSetContext).toHaveBeenCalledWith("redmyne:draftMode", false);
    });

    it("emits change event", async () => {
      await manager.enable();

      const handler = vi.fn();
      manager.onDidChangeEnabled(handler);
      await manager.disable();

      expect(handler).toHaveBeenCalledWith(false);
    });
  });

  describe("toggle", () => {
    it("enables when disabled", async () => {
      const result = await manager.toggle();
      expect(result).toBe(true);
      expect(manager.isEnabled).toBe(true);
    });

    it("disables when enabled", async () => {
      await manager.enable();
      const result = await manager.toggle();
      expect(result).toBe(false);
      expect(manager.isEnabled).toBe(false);
    });
  });

  describe("initialize", () => {
    it("restores enabled state from storage", async () => {
      mockStorage.set("redmyne.draftModeEnabled", true);
      await manager.initialize();
      expect(manager.isEnabled).toBe(true);
    });

    it("sets context variable on restore", async () => {
      mockStorage.set("redmyne.draftModeEnabled", true);
      await manager.initialize();
      expect(mockSetContext).toHaveBeenCalledWith("redmyne:draftMode", true);
    });

    it("defaults to false if not stored", async () => {
      await manager.initialize();
      expect(manager.isEnabled).toBe(false);
    });
  });

  describe("dispose", () => {
    it("cleans up listeners via subscription", async () => {
      const handler = vi.fn();
      const subscription = manager.onDidChangeEnabled(handler);

      subscription.dispose();
      await manager.enable();

      expect(handler).not.toHaveBeenCalled();
    });

    it("clears all handlers when dispose called on manager", async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      manager.onDidChangeEnabled(handler1);
      manager.onDidChangeEnabled(handler2);

      manager.dispose();
      await manager.enable();

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });
  });

  describe("queue management", () => {
    it("returns undefined queue initially", () => {
      expect(manager.queue).toBeUndefined();
    });

    it("stores queue via setQueue", () => {
      const mockQueue = { count: 5 } as unknown as import("../../../src/draft-mode/draft-queue").DraftQueue;
      manager.setQueue(mockQueue);
      expect(manager.queue).toBe(mockQueue);
    });
  });
});
