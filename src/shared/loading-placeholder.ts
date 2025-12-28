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

/** Skeleton bar patterns (varying widths for visual variety) */
const SKELETON_PATTERNS = [
  "━━━━━━━━━━━━━━━━━━━━",
  "━━━━━━━━━━━━━━",
  "━━━━━━━━━━━━━━━━━━━━━━━━",
  "━━━━━━━━━━━━",
  "━━━━━━━━━━━━━━━━━━",
];

/**
 * Create skeleton placeholder items for loading state.
 * Returns array of placeholders that look like content loading.
 */
export function createSkeletonPlaceholders(count = 5): LoadingPlaceholder[] {
  return Array.from({ length: count }, (_, i) => ({
    isLoadingPlaceholder: true as const,
    skeletonIndex: i,
  }));
}

/**
 * Create a VS Code TreeItem for skeleton loading state.
 * Uses faded bar characters to simulate content loading.
 */
export function createSkeletonTreeItem(placeholder: LoadingPlaceholder): vscode.TreeItem {
  const index = placeholder.skeletonIndex ?? 0;
  const pattern = SKELETON_PATTERNS[index % SKELETON_PATTERNS.length];

  const item = new vscode.TreeItem(
    pattern,
    vscode.TreeItemCollapsibleState.None
  );
  // Use a faded/dimmed icon to reinforce loading state
  item.iconPath = new vscode.ThemeIcon(
    "circle-outline",
    new vscode.ThemeColor("disabledForeground")
  );
  // Make the label appear faded
  item.description = "";
  return item;
}
