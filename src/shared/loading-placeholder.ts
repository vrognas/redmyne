import * as vscode from "vscode";

/**
 * Interface for loading placeholder items in tree views.
 */
export interface LoadingPlaceholder {
  isLoadingPlaceholder: true;
  message?: string;
}

/**
 * Type guard for LoadingPlaceholder.
 * Works with union types like `T | LoadingPlaceholder`.
 */
export function isLoadingPlaceholder<T>(
  item: T | LoadingPlaceholder
): item is LoadingPlaceholder {
  return (
    typeof item === "object" &&
    item !== null &&
    "isLoadingPlaceholder" in item &&
    (item as LoadingPlaceholder).isLoadingPlaceholder === true
  );
}

/**
 * Create a VS Code TreeItem for loading state.
 */
export function createLoadingTreeItem(message = "Loading..."): vscode.TreeItem {
  const item = new vscode.TreeItem(
    message,
    vscode.TreeItemCollapsibleState.None
  );
  item.iconPath = new vscode.ThemeIcon("loading~spin");
  return item;
}
