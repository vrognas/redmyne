import { describe, it, expect, vi, beforeEach } from "vitest";
import { BaseTreeProvider } from "../../../src/shared/base-tree-provider";
import * as vscode from "vscode";

// Concrete implementation for testing
class TestTreeProvider extends BaseTreeProvider<string> {
  items: string[] = ["item1", "item2"];

  getTreeItem(element: string): vscode.TreeItem {
    return new vscode.TreeItem(element);
  }

  getChildren(): string[] {
    return this.items;
  }
}

describe("BaseTreeProvider", () => {
  let provider: TestTreeProvider;

  beforeEach(() => {
    provider = new TestTreeProvider();
  });

  it("fires onDidChangeTreeData when refresh() called", () => {
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);

    provider.refresh();

    expect(listener).toHaveBeenCalledWith(undefined);
  });

  it("disposes EventEmitter and disposables on dispose()", () => {
    const mockDisposable = { dispose: vi.fn() };
    provider["disposables"].push(mockDisposable);

    provider.dispose();

    expect(mockDisposable.dispose).toHaveBeenCalled();
    expect(provider["_onDidChangeTreeData"].dispose).toHaveBeenCalled();
  });

  it("allows subclass to implement getTreeItem and getChildren", () => {
    const treeItem = provider.getTreeItem("test");
    const children = provider.getChildren();

    expect(treeItem).toBeInstanceOf(vscode.TreeItem);
    expect(children).toEqual(["item1", "item2"]);
  });
});
