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

export interface DraftQueueLoadOptions {
  /** If true, discard conflicting drafts without confirmation */
  force?: boolean;
}

/** Error thrown when server identity changes and drafts would be lost */
export class ServerConflictError extends Error {
  readonly code = "SERVER_CONFLICT";
  constructor(public readonly draftCount: number) {
    super(`Server changed - ${draftCount} drafts would be lost`);
    this.name = "ServerConflictError";
  }
}

/** Handler receives optional source identifier of who made the change */
type ChangeHandler = (source?: string) => void;

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
   * Check if loading with given server identity would discard existing drafts
   * @param serverIdentity Hash of server URL + API key
   * @returns Info about potential conflict, or null if no conflict
   *
   * Note: TOCTOU race between checkServerConflict() and load() is acceptable:
   * - Worst case: user confirms discard, file changes, load() sees different data
   * - Impact: benign - either fewer drafts discarded or conflict re-detected
   * - Atomic operation not worth complexity for this advisory check
   */
  async checkServerConflict(serverIdentity: string): Promise<{ count: number } | null> {
    try {
      const data = await this.fs.readFile(this.storagePath);
      const text = new TextDecoder().decode(data);
      const state = JSON.parse(text) as DraftQueueState;

      if (state.version !== 1) return null;
      if (state.serverIdentity === serverIdentity) return null;
      if (state.operations.length === 0) return null;

      return { count: state.operations.length };
    } catch {
      return null; // No file or parse error - no conflict
    }
  }

  /**
   * Load queue from storage, validating server identity
   * @param serverIdentity Hash of server URL + API key
   * @param options Load options
   */
  async load(serverIdentity: string, options: DraftQueueLoadOptions = {}): Promise<void> {
    const { force = false } = options;
    this.loadedServerIdentity = serverIdentity;
    try {
      const data = await this.fs.readFile(this.storagePath);
      const text = new TextDecoder().decode(data);
      const state = JSON.parse(text) as DraftQueueState;

      if (state.version !== 1) return;

      // Reject if server identity changed
      if (state.serverIdentity !== serverIdentity) {
        if (!force && state.operations.length > 0) {
          // Caller should have checked for conflict first
          throw new ServerConflictError(state.operations.length);
        }
        // Clear persisted data from different server
        this.operations = [];
        await this.persist();
        return;
      }

      this.operations = state.operations;
      this.emitChange();
    } catch (e) {
      // Re-throw server conflict errors
      if (e instanceof ServerConflictError) {
        throw e;
      }
      // File doesn't exist or parse error - start fresh
      this.operations = [];
    }
  }

  /**
   * Add operation to queue
   * @param op Operation to add
   * @param source Optional identifier of the caller (for filtering change events)
   * @throws Error if queue hasn't been loaded yet
   */
  async add(op: DraftOperation, source?: string): Promise<void> {
    if (!this.loadedServerIdentity) {
      throw new Error("DraftQueue not loaded - call load() first");
    }

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
    this.emitChange(source);
  }

  async remove(id: string, source?: string): Promise<void> {
    const initialLength = this.operations.length;
    this.operations = this.operations.filter(op => op.id !== id);

    if (this.operations.length !== initialLength) {
      await this.persist();
      this.emitChange(source);
    }
  }

  async removeMany(ids: string[], source?: string): Promise<void> {
    if (ids.length === 0) return;

    const idSet = new Set(ids);
    const initialLength = this.operations.length;
    this.operations = this.operations.filter(op => !idSet.has(op.id));

    if (this.operations.length !== initialLength) {
      await this.persist();
      this.emitChange(source);
    }
  }

  async removeByKey(resourceKey: string, source?: string): Promise<void> {
    const initialLength = this.operations.length;
    this.operations = this.operations.filter(op => op.resourceKey !== resourceKey);

    if (this.operations.length !== initialLength) {
      await this.persist();
      this.emitChange(source);
    }
  }

  /** Remove all operations where tempId starts with a given prefix */
  async removeByTempIdPrefix(prefix: string, source?: string): Promise<void> {
    const initialLength = this.operations.length;
    this.operations = this.operations.filter(op => !op.tempId?.startsWith(prefix));

    if (this.operations.length !== initialLength) {
      await this.persist();
      this.emitChange(source);
    }
  }

  async clear(source?: string): Promise<void> {
    this.operations = [];
    await this.persist();
    this.emitChange(source);
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

  /**
   * Dispose all change handlers to prevent memory leaks
   */
  dispose(): void {
    this.changeHandlers.clear();
  }

  private emitChange(source?: string): void {
    for (const handler of this.changeHandlers) {
      try {
        handler(source);
      } catch {
        // Ignore handler errors to prevent one bad handler from breaking others
      }
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
    this.persistLock = writePromise.catch(() => {
      // Persist errors are non-fatal - queue still works in memory
    });

    // Return the actual write promise so callers see errors
    return writePromise;
  }
}
