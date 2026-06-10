/**
 * Pure functions for the windowed-SVG row renderer (row-window.js).
 * No DOM access — unit-testable in node. Rows are GanttRowPayload meta:
 * { key, parentKey, depth, type, hasChildren }. The visible list is in
 * document order; virtual Y of visible index i is i × barHeight (the layout
 * has uniform row heights and no gaps).
 */

/**
 * Rows visible under the given collapse state: roots always; any other row
 * iff every ancestor is expanded. Preserves document order.
 * @param {Array<{key: string, parentKey: string|null}>} rows
 * @param {Set<string>} expandedSet - keys currently expanded
 * @returns {Array} subset of rows
 */
export function computeVisibleList(rows, expandedSet) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const visibleByKey = new Map();
  const isVisible = (r) => {
    const cached = visibleByKey.get(r.key);
    if (cached !== undefined) return cached;
    let result = true;
    let p = r.parentKey ? byKey.get(r.parentKey) : undefined;
    let hops = 0; // malformed-cycle guard
    while (p && hops++ < 100) {
      if (!expandedSet.has(p.key)) {
        result = false;
        break;
      }
      p = p.parentKey ? byKey.get(p.parentKey) : undefined;
    }
    visibleByKey.set(r.key, result);
    return result;
  };
  return rows.filter(isVisible);
}

/**
 * Visible-list index range to keep mounted for the current scroll position.
 * @returns {{first: number, last: number}} inclusive range; last = -1 when empty
 */
export function computeMountRange(scrollTop, viewportHeight, barHeight, totalRows, buffer) {
  if (totalRows <= 0) return { first: 0, last: -1 };
  const first = Math.max(0, Math.floor(scrollTop / barHeight) - buffer);
  const last = Math.min(
    totalRows - 1,
    Math.ceil((scrollTop + viewportHeight) / barHeight) + buffer
  );
  return { first, last };
}

/**
 * Zebra bands over the visible list. Multi-root boards (useTopLevelGrouping)
 * band per depth-0 block; single-hierarchy boards band per top-level issue
 * family (minimum issue depth starts a new band) — same grouping rules the
 * extension used when it emitted stripes.
 * @returns {Array<{startIdx: number, endIdx: number, bandIdx: number}>}
 */
export function computeZebraBands(visibleList, useTopLevelGrouping) {
  if (visibleList.length === 0) return [];
  let isBoundary;
  if (useTopLevelGrouping) {
    isBoundary = (row) => row.depth === 0;
  } else {
    const issueDepths = visibleList.filter((r) => r.type === "issue").map((r) => r.depth);
    const minIssueDepth = issueDepths.length > 0 ? Math.min(...issueDepths) : Infinity;
    isBoundary = (row) => row.type === "issue" && row.depth === minIssueDepth;
  }
  const bands = [];
  let start = 0;
  for (let i = 1; i < visibleList.length; i++) {
    if (isBoundary(visibleList[i])) {
      bands.push({ startIdx: start, endIdx: i - 1, bandIdx: bands.length });
      start = i;
    }
  }
  bands.push({ startIdx: start, endIdx: visibleList.length - 1, bandIdx: bands.length });
  return bands;
}

/**
 * Indent-guide spans: for each visible parent whose subtree has visible rows,
 * the contiguous index range of those rows (document order makes subtrees
 * contiguous; a row belongs to the span while its depth exceeds the parent's).
 * @returns {Array<{parentKey: string, depth: number, startIdx: number, endIdx: number}>}
 */
export function computeIndentSpans(visibleList) {
  const spans = [];
  for (let i = 0; i < visibleList.length; i++) {
    const rowItem = visibleList[i];
    if (!rowItem.hasChildren) continue;
    let end = i;
    for (let j = i + 1; j < visibleList.length && visibleList[j].depth > rowItem.depth; j++) {
      end = j;
    }
    if (end > i) {
      spans.push({ parentKey: rowItem.key, depth: rowItem.depth, startIdx: i + 1, endIdx: end });
    }
  }
  return spans;
}
