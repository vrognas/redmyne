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
 * DFS pre-order with early termination - doesn't traverse into collapsed
 * subtrees. O(visible descendants) with zero DOM queries.
 *
 * ORDER CONTRACT: returns DOCUMENT ORDER (pre-order DFS — each child is
 * followed by its own visible descendants before the next sibling). The
 * expand repositioning in toggleCollapseClientSide consumes this array as
 * the top-to-bottom visual sequence; BFS order corrupts nested layouts
 * (later sibling wedged between an expanded child and its children).
 * @param {string} parentKey - The key being expanded
 * @param {Map<string, Set<string>>} childrenCache - Map of parentKey → Set of child keys (insertion order = document order)
 * @param {Map<string, boolean>} expandedStateCache - Map of collapseKey → isExpanded
 * @returns {string[]} Array of visible descendant keys in document order
 */
export function findVisibleDescendants(parentKey, childrenCache, expandedStateCache) {
  const result = [];
  const stack = [];
  const pushChildren = (key) => {
    const children = childrenCache.get(key);
    if (!children) return;
    // Push reversed so the first child is popped (and emitted) first
    const arr = [...children];
    for (let i = arr.length - 1; i >= 0; i--) {
      stack.push(arr[i]);
    }
  };
  pushChildren(parentKey);
  while (stack.length > 0) {
    const current = stack.pop();
    result.push(current);
    if (expandedStateCache.get(current)) {
      pushChildren(current);
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
