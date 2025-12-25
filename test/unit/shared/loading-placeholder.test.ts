import { describe, it, expect } from "vitest";
import {
  isLoadingPlaceholder,
  createLoadingPlaceholder,
  createLoadingTreeItem,
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

  describe("createLoadingPlaceholder", () => {
    it("creates placeholder without message", () => {
      const placeholder = createLoadingPlaceholder();
      expect(placeholder).toEqual({ isLoadingPlaceholder: true });
    });

    it("creates placeholder with message", () => {
      const placeholder = createLoadingPlaceholder("Loading...");
      expect(placeholder).toEqual({
        isLoadingPlaceholder: true,
        message: "Loading...",
      });
    });
  });

  describe("createLoadingTreeItem", () => {
    it("creates TreeItem with default message", () => {
      const item = createLoadingTreeItem();
      expect(item.label).toBe("Loading...");
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    });

    it("creates TreeItem with custom message", () => {
      const item = createLoadingTreeItem("Fetching data...");
      expect(item.label).toBe("Fetching data...");
    });

    it("sets loading spinner icon", () => {
      const item = createLoadingTreeItem();
      expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe("loading~spin");
    });
  });
});
