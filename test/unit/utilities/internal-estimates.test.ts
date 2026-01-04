import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getInternalEstimates,
  setInternalEstimate,
  clearInternalEstimate,
  STORAGE_KEY,
} from "../../../src/utilities/internal-estimates";

function createMockGlobalState() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => store.get(key)),
    update: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    _store: store,
  };
}

describe("internal-estimates", () => {
  describe("getInternalEstimates", () => {
    it("returns empty map when no estimates stored", () => {
      const globalState = createMockGlobalState();
      const result = getInternalEstimates(globalState);

      expect(result.size).toBe(0);
    });

    it("returns stored estimates as Map", () => {
      const globalState = createMockGlobalState();
      globalState._store.set(STORAGE_KEY, {
        123: { hoursRemaining: 10, updatedAt: "2025-01-06T10:00:00Z" },
        456: { hoursRemaining: 5, updatedAt: "2025-01-06T11:00:00Z" },
      });

      const result = getInternalEstimates(globalState);

      expect(result.size).toBe(2);
      expect(result.get(123)?.hoursRemaining).toBe(10);
      expect(result.get(456)?.hoursRemaining).toBe(5);
    });
  });

  describe("setInternalEstimate", () => {
    it("stores new estimate", async () => {
      const globalState = createMockGlobalState();

      await setInternalEstimate(globalState, 123, 15);

      expect(globalState.update).toHaveBeenCalled();
      const stored = globalState._store.get(STORAGE_KEY) as Record<string, unknown>;
      expect(stored["123"]).toBeDefined();
      expect((stored["123"] as { hoursRemaining: number }).hoursRemaining).toBe(15);
    });

    it("updates existing estimate", async () => {
      const globalState = createMockGlobalState();
      globalState._store.set(STORAGE_KEY, {
        123: { hoursRemaining: 10, updatedAt: "2025-01-06T10:00:00Z" },
      });

      await setInternalEstimate(globalState, 123, 20);

      const stored = globalState._store.get(STORAGE_KEY) as Record<string, unknown>;
      expect((stored["123"] as { hoursRemaining: number }).hoursRemaining).toBe(20);
    });

    it("preserves other estimates when updating", async () => {
      const globalState = createMockGlobalState();
      globalState._store.set(STORAGE_KEY, {
        123: { hoursRemaining: 10, updatedAt: "2025-01-06T10:00:00Z" },
        456: { hoursRemaining: 5, updatedAt: "2025-01-06T11:00:00Z" },
      });

      await setInternalEstimate(globalState, 123, 20);

      const stored = globalState._store.get(STORAGE_KEY) as Record<string, unknown>;
      expect((stored["456"] as { hoursRemaining: number }).hoursRemaining).toBe(5);
    });
  });

  describe("clearInternalEstimate", () => {
    it("removes estimate for issue", async () => {
      const globalState = createMockGlobalState();
      globalState._store.set(STORAGE_KEY, {
        123: { hoursRemaining: 10, updatedAt: "2025-01-06T10:00:00Z" },
        456: { hoursRemaining: 5, updatedAt: "2025-01-06T11:00:00Z" },
      });

      await clearInternalEstimate(globalState, 123);

      const stored = globalState._store.get(STORAGE_KEY) as Record<string, unknown>;
      expect(stored["123"]).toBeUndefined();
      expect(stored["456"]).toBeDefined();
    });

    it("does nothing if estimate not found", async () => {
      const globalState = createMockGlobalState();
      globalState._store.set(STORAGE_KEY, {
        456: { hoursRemaining: 5, updatedAt: "2025-01-06T11:00:00Z" },
      });

      await clearInternalEstimate(globalState, 123);

      const stored = globalState._store.get(STORAGE_KEY) as Record<string, unknown>;
      expect(stored["456"]).toBeDefined();
    });
  });
});
