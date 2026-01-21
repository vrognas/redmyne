/**
 * Draft Mode Manager
 * Singleton managing draft mode on/off state with persistence and events
 */

export interface DraftModeManagerDeps {
  globalState: {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
  };
  setContext: (key: string, value: boolean) => Thenable<void>;
}

type EnabledChangeHandler = (enabled: boolean) => void;

const STORAGE_KEY = "redmyne.draftModeEnabled";
const CONTEXT_KEY = "redmyne:draftMode";

export class DraftModeManager {
  private enabled = false;
  private deps: DraftModeManagerDeps;
  private changeHandlers: Set<EnabledChangeHandler> = new Set();

  constructor(deps: DraftModeManagerDeps) {
    this.deps = deps;
  }

  async initialize(): Promise<void> {
    const stored = this.deps.globalState.get<boolean>(STORAGE_KEY);
    if (stored === true) {
      this.enabled = true;
      await this.deps.setContext(CONTEXT_KEY, true);
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  async enable(): Promise<void> {
    if (this.enabled) return;

    this.enabled = true;
    await this.deps.globalState.update(STORAGE_KEY, true);
    await this.deps.setContext(CONTEXT_KEY, true);
    this.emitChange(true);
  }

  async disable(): Promise<void> {
    if (!this.enabled) return;

    this.enabled = false;
    await this.deps.globalState.update(STORAGE_KEY, false);
    await this.deps.setContext(CONTEXT_KEY, false);
    this.emitChange(false);
  }

  async toggle(): Promise<boolean> {
    if (this.enabled) {
      await this.disable();
    } else {
      await this.enable();
    }
    return this.enabled;
  }

  onDidChangeEnabled(handler: EnabledChangeHandler): { dispose: () => void } {
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

  private emitChange(enabled: boolean): void {
    for (const handler of this.changeHandlers) {
      handler(enabled);
    }
  }
}
