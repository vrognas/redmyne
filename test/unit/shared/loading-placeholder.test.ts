import { describe, it, expect } from "vitest";
import {
  isLoadingPlaceholder,
  createSkeletonPlaceholders,
  createSkeletonTreeItem,
  LoadingPlaceholder,
} from "../../../src/shared/loading-placeholder";
import * as vscode from "vscode";

describe("loading-placeholder", () => {
  describe("isLoadingPlaceholder", () => {
    it("returns true for LoadingPlaceholder objects", () => {
      const placeholder: LoadingPlaceholder = { isLoadingPlaceholder: true };
      expect(isLoadingPlaceholder(placeholder)).toBe(true);
    });

    it("returns true for LoadingPlaceholder with message", () => {
      const placeholder: LoadingPlaceholder = {
        isLoadingPlaceholder: true,
        message: "Loading projects...",
      };
      expect(isLoadingPlaceholder(placeholder)).toBe(true);
    });

    it("returns false for regular objects", () => {
      expect(isLoadingPlaceholder({ id: 1, name: "test" })).toBe(false);
      expect(isLoadingPlaceholder({ isLoadingPlaceholder: false })).toBe(false);
    });

    it("returns false for primitives and null", () => {
      expect(isLoadingPlaceholder(null as unknown)).toBe(false);
      expect(isLoadingPlaceholder(undefined as unknown)).toBe(false);
      expect(isLoadingPlaceholder("string" as unknown)).toBe(false);
      expect(isLoadingPlaceholder(123 as unknown)).toBe(false);
    });
  });

  describe("skeleton helpers", () => {
    it("createSkeletonPlaceholders returns the requested number of rows", () => {
      expect(createSkeletonPlaceholders(5)).toHaveLength(5);
      expect(createSkeletonPlaceholders(5).every(isLoadingPlaceholder)).toBe(true);
      expect(createSkeletonPlaceholders()).toEqual([
        { isLoadingPlaceholder: true, message: "Loading..." },
      ]);
    });

    it("createSkeletonTreeItem uses placeholder message fallback", () => {
      const explicit = createSkeletonTreeItem({ isLoadingPlaceholder: true, message: "Please wait" });
      expect(explicit.label).toBe("Please wait");

      const fallback = createSkeletonTreeItem({ isLoadingPlaceholder: true });
      expect(fallback.label).toBe("Loading...");
      expect((fallback.iconPath as vscode.ThemeIcon).id).toBe("loading~spin");
    });
  });
});
