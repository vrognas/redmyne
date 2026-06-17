import * as vscode from "vscode";

/**
 * Shared implementation for the config-backed issue-id-set trackers
 * (ad-hoc, precedence, auto-update). Each is a `number[]` value under a
 * `redmyne.<settingKey>` Global setting with serialized add/remove/toggle.
 *
 * Public-facing modules wrap this factory, keeping their own exported
 * names/methods so callers do not change.
 */
export interface ConfigIdSetTracker {
  /** True when `issueId` is present in the stored set. */
  has(issueId: number): boolean;
  /** Stored ids as an array (deduped). */
  getAllArray(): number[];
  /** Stored ids as a Set. */
  getAllSet(): Set<number>;
  /** Add `issueId` (no-op if already present). Serialized. */
  add(issueId: number): Promise<void>;
  /** Remove `issueId` (no-op if absent). Serialized. */
  remove(issueId: number): Promise<void>;
  /** Toggle `issueId`; resolves to its new membership state. Serialized. */
  toggle(issueId: number): Promise<boolean>;
  /**
   * Only present when created with `lazyCache: true`.
   * Registers the `onDidChangeConfiguration` cache-invalidation listener
   * and returns its Disposable. Push to `context.subscriptions`.
   */
  registerCacheListener?(): vscode.Disposable;
}

export interface ConfigIdSetTrackerOptions {
  /**
   * When true, the read set is cached and only invalidated on
   * `onDidChangeConfiguration` for this key. Use for keys read inside hot
   * loops (per-row Gantt render, per-time-entry contribution calc).
   *
   * Caching does NOT auto-register the config-change listener: the caller
   * must call `registerCacheListener()` on the returned tracker and push the
   * Disposable to `context.subscriptions` so it is disposed on deactivation.
   */
  lazyCache?: boolean;
}

export function createConfigIdSetTracker(
  settingKey: string,
  options: ConfigIdSetTrackerOptions = {},
): ConfigIdSetTracker {
  const fullSettingKey = `redmyne.${settingKey}`;

  function loadSet(): Set<number> {
    const arr = vscode.workspace
      .getConfiguration("redmyne")
      .get<number[]>(settingKey, []);
    return new Set(arr);
  }

  // Optional read cache. Reading vscode config is non-trivial and `has()` may
  // be called from inside hot loops; cache and invalidate on config change.
  const useCache = options.lazyCache === true;
  let cachedSet: Set<number> | undefined;

  function getSet(): Set<number> {
    if (!useCache) return loadSet();
    if (!cachedSet) cachedSet = loadSet();
    return cachedSet;
  }

  function getArray(): number[] {
    return [...getSet()];
  }

  async function setIds(ids: number[]): Promise<void> {
    await vscode.workspace
      .getConfiguration("redmyne")
      .update(settingKey, ids, vscode.ConfigurationTarget.Global);
    if (useCache) cachedSet = new Set(ids);
  }

  function makeCacheListener(): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(fullSettingKey)) {
        cachedSet = undefined;
      }
    });
  }

  // Serialize mutations so concurrent add/remove/toggle calls do not race on
  // the read-modify-write against the single config value.
  let queue: Promise<void> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn);
    queue = result.then(() => {}, () => {});
    return result;
  }

  function has(issueId: number): boolean {
    return getSet().has(issueId);
  }

  return {
    has,
    getAllArray: getArray,
    getAllSet: getSet,
    ...(options.lazyCache ? { registerCacheListener: makeCacheListener } : {}),
    add(issueId: number): Promise<void> {
      return enqueue(async () => {
        const ids = getArray();
        if (!ids.includes(issueId)) await setIds([...ids, issueId]);
      });
    },
    remove(issueId: number): Promise<void> {
      return enqueue(async () => {
        await setIds(getArray().filter((id) => id !== issueId));
      });
    },
    toggle(issueId: number): Promise<boolean> {
      return enqueue(async () => {
        if (has(issueId)) {
          await setIds(getArray().filter((id) => id !== issueId));
          return false;
        }
        await setIds([...getArray(), issueId]);
        return true;
      });
    },
  };
}
