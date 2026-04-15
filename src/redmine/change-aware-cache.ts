/**
 * Change-Aware Cache
 *
 * Caches API responses and validates freshness via lightweight
 * `updated_on>=TIMESTAMP&limit=1` probes before refetching.
 */

/** TTL safety net — force refetch after this even without detected changes */
export const CHANGE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Minimum interval between hasChanges probes for same key */
export const MIN_PROBE_INTERVAL_MS = 10 * 1000; // 10 seconds

/** Max probe interval after repeated no-change results */
export const MAX_PROBE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry<T> {
  data: T;
  /** max(updated_on) from Redmine response — used as probe baseline */
  lastCheckedAt: string;
  /** Date.now() when data was stored — for TTL expiry */
  storedAt: number;
  /** Date.now() of last hasChanges probe — for probe cooldown */
  lastProbedAt: number;
  /** Consecutive no-change probe results — drives exponential backoff */
  noChangeCount: number;
}

export class ChangeAwareCache {
  private entries = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): CacheEntry<T> | undefined {
    return this.entries.get(key) as CacheEntry<T> | undefined;
  }

  set<T>(key: string, data: T, lastCheckedAt: string): void {
    const now = Date.now();
    this.entries.set(key, { data, lastCheckedAt, storedAt: now, lastProbedAt: now, noChangeCount: 0 });
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  /** Invalidate all keys starting with prefix (e.g. "time_entries:" or "issues:") */
  invalidatePrefix(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }

  /** True if entry is older than ttlMs */
  isExpired(key: string, ttlMs: number): boolean {
    const entry = this.entries.get(key);
    if (!entry) return true;
    return Date.now() - entry.storedAt >= ttlMs;
  }

  /** True if enough time has passed since last probe to warrant another.
   *  Uses exponential backoff: interval doubles with each consecutive no-change,
   *  capped at MAX_PROBE_INTERVAL_MS. Resets on data change (set()). */
  shouldProbe(key: string, minIntervalMs: number): boolean {
    const entry = this.entries.get(key);
    if (!entry) return true;
    const backoff = Math.min(minIntervalMs * Math.pow(2, entry.noChangeCount), MAX_PROBE_INTERVAL_MS);
    return Date.now() - entry.lastProbedAt >= backoff;
  }

  /** Update probe timestamp and increment no-change counter (drives backoff) */
  touch(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.lastProbedAt = Date.now();
      entry.noChangeCount++;
    }
  }
}

/**
 * Extract the latest updated_on from an array of items.
 * ISO 8601 strings sort lexicographically.
 * Falls back to current ISO timestamp if no items have updated_on.
 */
export function extractMaxUpdatedOn(items: Array<{ updated_on?: string }>): string {
  let max = "";
  for (const item of items) {
    if (item.updated_on && item.updated_on > max) {
      max = item.updated_on;
    }
  }
  return max || new Date().toISOString();
}
