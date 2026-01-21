/**
 * Draft Queue
 * Stores draft operations with conflict resolution and persistence
 */

import * as vscode from "vscode";
import type { DraftOperation, DraftQueueState } from "./draft-operation";

export interface DraftQueueOptions {
  storagePath: vscode.Uri;
  fs: vscode.FileSystem;
}

type ChangeHandler = () => void;

export class DraftQueue {
  private operations: DraftOperation[] = [];
  private storagePath: vscode.Uri;
  private fs: vscode.FileSystem;
  private changeHandlers: Set<ChangeHandler> = new Set();
  private loadedServerIdentity: string | null = null;
  /** Write lock to prevent concurrent persist() calls from racing */
  private persistLock: Promise<void> = Promise.resolve();

  constructor(options: DraftQueueOptions) {
    this.storagePath = options.storagePath;
    this.fs = options.fs;
  }

  /**
   * Load queue from storage, validating server identity
   * @param serverIdentity Hash of server URL + API key
   */
  async load(serverIdentity: string): Promise<void> {
    this.loadedServerIdentity = serverIdentity;
    try {
      const data = await this.fs.readFile(this.storagePath);
      const text = new TextDecoder().decode(data);
      const state = JSON.parse(text) as DraftQueueState;

      if (state.version !== 1) return;

      // Reject if server identity changed
      if (state.serverIdentity !== serverIdentity) {
        // Clear persisted data from different server
        this.operations = [];
        await this.persist();
        return;
      }

      this.operations = state.operations;
      this.emitChange();
    } catch {
      // File doesn't exist or parse error - start fresh
      this.operations = [];
    }
  }

  async add(op: DraftOperation): Promise<void> {
    // Conflict resolution: replace existing operation with same resourceKey
    const existingIndex = this.operations.findIndex(
      existing => existing.resourceKey === op.resourceKey
    );

    if (existingIndex !== -1) {
      this.operations[existingIndex] = op;
    } else {
      this.operations.push(op);
    }

    await this.persist();
    this.emitChange();
  }

  async remove(id: string): Promise<void> {
    const initialLength = this.operations.length;
    this.operations = this.operations.filter(op => op.id !== id);

    if (this.operations.length !== initialLength) {
      await this.persist();
      this.emitChange();
    }
  }

  async removeByKey(resourceKey: string): Promise<void> {
    const initialLength = this.operations.length;
    this.operations = this.operations.filter(op => op.resourceKey !== resourceKey);

    if (this.operations.length !== initialLength) {
      await this.persist();
      this.emitChange();
    }
  }

  /** Remove all operations where tempId starts with a given prefix */
  async removeByTempIdPrefix(prefix: string): Promise<void> {
    const initialLength = this.operations.length;
    this.operations = this.operations.filter(op => !op.tempId?.startsWith(prefix));

    if (this.operations.length !== initialLength) {
      await this.persist();
      this.emitChange();
    }
  }

  async clear(): Promise<void> {
    this.operations = [];
    await this.persist();
    this.emitChange();
  }

  getAll(): DraftOperation[] {
    return [...this.operations];
  }

  getByIssueId(issueId: number): DraftOperation[] {
    return this.operations.filter(op => op.issueId === issueId);
  }

  getByKeyPrefix(prefix: string): DraftOperation[] {
    return this.operations.filter(op => op.resourceKey.startsWith(prefix));
  }

  get count(): number {
    return this.operations.length;
  }

  onDidChange(handler: ChangeHandler): { dispose: () => void } {
    this.changeHandlers.add(handler);
    return {
      dispose: () => this.changeHandlers.delete(handler),
    };
  }

  private emitChange(): void {
    for (const handler of this.changeHandlers) {
      handler();
    }
  }

  private createState(): DraftQueueState {
    return {
      version: 1,
      serverIdentity: this.loadedServerIdentity ?? "",
      operations: this.operations,
    };
  }

  private persist(): Promise<void> {
    if (!this.loadedServerIdentity) return Promise.resolve(); // Don't persist until loaded

    // Chain onto the lock to serialize writes and prevent race conditions.
    // Each persist() waits for prior writes to complete before starting.
    const writePromise = this.persistLock.then(async () => {
      const state = this.createState();
      const data = new TextEncoder().encode(JSON.stringify(state, null, 2));
      await this.fs.writeFile(this.storagePath, data);
    });

    // Update lock to include this write (ignore errors to keep chain alive)
    this.persistLock = writePromise.catch(() => {});

    // Return the actual write promise so callers see errors
    return writePromise;
  }
}
