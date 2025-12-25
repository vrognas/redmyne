/**
 * Collection Utilities
 * Generic helpers for working with arrays and maps
 */

/**
 * Group items by a key function
 */
export function groupBy<T, K>(
  items: T[],
  keyFn: (item: T) => K
): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!result.has(key)) {
      result.set(key, []);
    }
    result.get(key)!.push(item);
  }
  return result;
}
