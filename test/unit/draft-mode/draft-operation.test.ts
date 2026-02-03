import { describe, it, expect } from "vitest";
import {
  generateDraftId,
  generateTempId,
  generateNumericTempId,
  hashString,
} from "../../../src/draft-mode/draft-operation";

describe("draft-operation", () => {
  describe("generateDraftId", () => {
    it("returns UUID format", () => {
      const id = generateDraftId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("returns unique IDs", () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateDraftId()));
      expect(ids.size).toBe(100);
    });
  });

  describe("generateTempId", () => {
    it("prefixes with draft-issue-", () => {
      expect(generateTempId("issue")).toMatch(/^draft-issue-[0-9a-f-]+$/);
    });

    it("prefixes with draft-version-", () => {
      expect(generateTempId("version")).toMatch(/^draft-version-[0-9a-f-]+$/);
    });

    it("prefixes with draft-relation-", () => {
      expect(generateTempId("relation")).toMatch(/^draft-relation-[0-9a-f-]+$/);
    });

    it("prefixes with draft-timeentry-", () => {
      expect(generateTempId("timeentry")).toMatch(/^draft-timeentry-[0-9a-f-]+$/);
    });
  });

  describe("generateNumericTempId", () => {
    it("returns negative number", () => {
      const id = generateNumericTempId();
      expect(id).toBeLessThan(0);
    });

    it("never returns -0", () => {
      // Run multiple times to increase confidence
      for (let i = 0; i < 100; i++) {
        const id = generateNumericTempId();
        expect(Object.is(id, -0)).toBe(false);
      }
    });

    it("returns unique values", () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateNumericTempId()));
      expect(ids.size).toBe(100);
    });
  });

  describe("hashString", () => {
    it("returns hex string", async () => {
      const hash = await hashString("test");
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    it("returns 64 characters (SHA-256)", async () => {
      const hash = await hashString("test");
      expect(hash.length).toBe(64);
    });

    it("produces consistent output", async () => {
      const hash1 = await hashString("test-input");
      const hash2 = await hashString("test-input");
      expect(hash1).toBe(hash2);
    });

    it("produces different output for different input", async () => {
      const hash1 = await hashString("input-a");
      const hash2 = await hashString("input-b");
      expect(hash1).not.toBe(hash2);
    });
  });
});
