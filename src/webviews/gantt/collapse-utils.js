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
 * Build ancestor + children caches from (key, parentKey) pairs WITHOUT any DOM
 * queries. Replaces an O(rows × depth × N) `document.querySelector`-per-ancestor
 * walk (which scanned the whole ~75K-node tree for every ancestor of every row)
 * with an O(rows × depth) Map walk. Duplicate pairs (a logical row appears in
 * several column SVGs, each carrying the same data-collapse-key) are deduped.
 * @param {Array<{key: string, parentKey: string}>} pairs - one per keyed element
 * @returns {{ancestorCache: Map<string, string[]>, childrenCache: Map<string, Set<string>>}}
 *   ancestorCache: key → [immediateParent, grandparent, ...]; childrenCache: parent → Set of direct children
 */
export function buildAncestorChains(pairs) {
  const parentOf = new Map(); // key → immediate parentKey (first occurrence wins)
  const childrenCache = new Map();
  for (const { key, parentKey } of pairs) {
    if (!key || !parentKey) continue;
    if (!parentOf.has(key)) parentOf.set(key, parentKey);
    let children = childrenCache.get(parentKey);
    if (!children) {
      children = new Set();
      childrenCache.set(parentKey, children);
    }
    children.add(key);
  }

  const ancestorCache = new Map();
  for (const key of parentOf.keys()) {
    const ancestors = [];
    const seen = new Set(); // guard against malformed parent cycles
    let p = parentOf.get(key);
    while (p && !seen.has(p)) {
      seen.add(p);
      ancestors.push(p);
      p = parentOf.get(p);
    }
    ancestorCache.set(key, ancestors);
  }

  return { ancestorCache, childrenCache };
}

/**
 * Sum the contributions of a zebra stripe's currently-VISIBLE rows. A row is
 * visible iff none of its ancestors is collapsed. Filtering per-key (instead
 * of by the in-flight toggle's descendant set) keeps rows hidden under OTHER
 * collapsed parents out of the band height — counting them left the band too
 * tall (e.g. collapsing P after sibling Q kept Q's hidden children counted).
 * @param {Record<string, number|string>} contributions - collapseKey → px height
 * @param {Set<string>} collapsedKeys - keys currently collapsed (post-toggle)
 * @param {Map<string, string[]>} ancestorCache - key → [parent, grandparent, ...]
 * @returns {number} total height of the band's visible rows
 */
export function computeVisibleStripeHeight(contributions, collapsedKeys, ancestorCache) {
  let height = 0;
  for (const [key, contribution] of Object.entries(contributions)) {
    const ancestors = ancestorCache.get(key) || [];
    if (!ancestors.some((a) => collapsedKeys.has(a))) {
      height += parseFloat(contribution);
    }
  }
  return height;
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
