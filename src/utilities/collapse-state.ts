import * as vscode from "vscode";

/**
 * Shared collapse state manager for syncing tree collapse between views
 * Uses key format: "project-{id}" or "issue-{id}"
 *
 * Default behavior: everything is COLLAPSED
 * We track EXPANDED keys (not collapsed) so default = collapsed
 */
export class CollapseStateManager {
  private _expandedKeys = new Set<string>();
  private _onDidChange = new vscode.EventEmitter<{ key: string; collapsed: boolean }>();

  /** Event fired when collapse state changes */
  readonly onDidChange = this._onDidChange.event;

  /** Check if a key is collapsed (not in expanded set = collapsed) */
  isCollapsed(key: string): boolean {
    return !this._expandedKeys.has(key);
  }

  /** Check if a key is expanded */
  isExpanded(key: string): boolean {
    return this._expandedKeys.has(key);
  }

  /** Get all expanded keys (for filtering visible rows) */
  getExpandedKeys(): Set<string> {
    return new Set(this._expandedKeys);
  }

  /** Set collapse state for a key (fires event) */
  setCollapsed(key: string, collapsed: boolean): void {
    const wasCollapsed = !this._expandedKeys.has(key);
    if (collapsed === wasCollapsed) return;

    if (collapsed) {
      this._expandedKeys.delete(key);
    } else {
      this._expandedKeys.add(key);
    }
    this._onDidChange.fire({ key, collapsed });
  }

  /** Toggle collapse state (fires event) */
  toggle(key: string): void {
    this.setCollapsed(key, !this.isCollapsed(key));
  }

  /** Collapse a key */
  collapse(key: string): void {
    this.setCollapsed(key, true);
  }

  /** Expand a key */
  expand(key: string): void {
    this.setCollapsed(key, false);
  }

  /** Expand all given keys */
  expandAll(keys?: string[]): void {
    if (keys) {
      keys.forEach((key) => this._expandedKeys.add(key));
    }
    this._onDidChange.fire({ key: "*", collapsed: false });
  }

  /** Collapse all (clear expanded set) */
  collapseAll(): void {
    this._expandedKeys.clear();
    this._onDidChange.fire({ key: "*", collapsed: true });
  }

  /** Clear all expand state (everything becomes collapsed) */
  clear(): void {
    this._expandedKeys.clear();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/** Singleton instance for shared state (tree views) */
export const collapseState = new CollapseStateManager();
