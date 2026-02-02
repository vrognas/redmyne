/**
 * Pure utility functions for collapse logic - extracted for testability.
 * These functions operate on cache Maps, not DOM.
 */

/**
 * Find all descendants of a collapse key using BFS.
 * O(descendants) instead of O(all nodes).
 * @param {string} parentKey - The key to find descendants for
 * @param {Map<string, Set<string>>} childrenCache - Map of parentKey → Set of child keys
 * @returns {string[]} Array of all descendant keys
 */
export function findDescendants(parentKey, childrenCache) {
  const result = [];
  const queue = [parentKey];
  while (queue.length > 0) {
    const current = queue.shift();
    const children = childrenCache.get(current);
    if (children) {
      for (const child of children) {
        result.push(child);
        queue.push(child);
      }
    }
  }
  return result;
}

/**
 * Find descendants that should be VISIBLE when expanding parentKey.
 * Uses BFS with early termination - doesn't traverse into collapsed subtrees.
 * O(visible descendants) with zero DOM queries.
 * @param {string} parentKey - The key being expanded
 * @param {Map<string, Set<string>>} childrenCache - Map of parentKey → Set of child keys
 * @param {Map<string, boolean>} expandedStateCache - Map of collapseKey → isExpanded
 * @returns {string[]} Array of visible descendant keys
 */
export function findVisibleDescendants(parentKey, childrenCache, expandedStateCache) {
  const result = [];
  const queue = [parentKey];
  while (queue.length > 0) {
    const current = queue.shift();
    const children = childrenCache.get(current);
    if (children) {
      for (const child of children) {
        result.push(child);
        const isExpanded = expandedStateCache.get(child);
        if (isExpanded) {
          queue.push(child);
        }
      }
    }
  }
  return result;
}

/**
 * Build children cache from ancestor cache.
 * @param {Map<string, string[]>} ancestorCache - Map of key → [parentKey, grandparentKey, ...]
 * @returns {Map<string, Set<string>>} Map of parentKey → Set of direct child keys
 */
export function buildChildrenCache(ancestorCache) {
  const childrenCache = new Map();
  ancestorCache.forEach((ancestors, key) => {
    const immediateParent = ancestors[0];
    if (immediateParent) {
      if (!childrenCache.has(immediateParent)) {
        childrenCache.set(immediateParent, new Set());
      }
      childrenCache.get(immediateParent).add(key);
    }
  });
  return childrenCache;
}
