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
 * Create `count` loading placeholders for tree views (skeleton rows).
 */
export function createSkeletonPlaceholders(count = 1): LoadingPlaceholder[] {
  return Array.from({ length: Math.max(1, count) }, () => ({
    isLoadingPlaceholder: true as const,
    message: "Loading...",
  }));
}

/**
 * Create a VS Code TreeItem for loading state.
 * Shows spinning disc with "Loading..." text.
 */
export function createSkeletonTreeItem(placeholder: LoadingPlaceholder): vscode.TreeItem {
  const item = new vscode.TreeItem(
    placeholder.message ?? "Loading...",
    vscode.TreeItemCollapsibleState.None
  );
  item.iconPath = new vscode.ThemeIcon("loading~spin");
  return item;
}
