import * as vscode from "vscode";

/**
 * Interface for loading placeholder items in tree views.
 */
export interface LoadingPlaceholder {
  isLoadingPlaceholder: true;
  message?: string;
  /** Index for skeleton placeholders (0-based) */
  skeletonIndex?: number;
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
 * Create a VS Code TreeItem for loading state (spinner style).
 * @deprecated Use createSkeletonTreeItem for better UX
 */
export function createLoadingTreeItem(message = "Loading..."): vscode.TreeItem {
  const item = new vscode.TreeItem(
    message,
    vscode.TreeItemCollapsibleState.None
  );
  item.iconPath = new vscode.ThemeIcon("loading~spin");
  return item;
}

/**
 * Create a single loading placeholder for tree views.
 * @param _count Ignored - always returns single placeholder for simplicity
 */
export function createSkeletonPlaceholders(_count = 1): LoadingPlaceholder[] {
  return [{ isLoadingPlaceholder: true as const, message: "Loading..." }];
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
