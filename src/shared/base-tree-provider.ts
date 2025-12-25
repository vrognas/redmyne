import * as vscode from "vscode";

/**
 * Abstract base class for tree data providers.
 * Provides common EventEmitter setup, refresh(), and dispose() patterns.
 */
export abstract class BaseTreeProvider<T>
  implements vscode.TreeDataProvider<T>, vscode.Disposable
{
  protected _onDidChangeTreeData = new vscode.EventEmitter<
    T | undefined | null
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  protected disposables: vscode.Disposable[] = [];

  /**
   * Trigger a full tree refresh by firing undefined.
   */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Clean up EventEmitter and any registered disposables.
   */
  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onDidChangeTreeData.dispose();
  }

  abstract getTreeItem(
    element: T
  ): vscode.TreeItem | Thenable<vscode.TreeItem>;

  abstract getChildren(element?: T): vscode.ProviderResult<T[]>;
}
