/**
 * Pure helpers for gantt row click-to-select - extracted for testability.
 * These functions operate on plain values, not DOM.
 */

/**
 * Parse the Y component of an SVG transform="translate(x, y)" string.
 * @param {string|null|undefined} transform - The SVG transform attribute value
 * @param {number} fallback - Returned when transform absent or malformed
 * @returns {number} The parsed y offset, or fallback
 */
export function parseTranslateY(transform, fallback) {
  const match = /translate\([^,]+,\s*([-\d.]+)/.exec(transform || '');
  return match ? parseFloat(match[1]) : fallback;
}

/**
 * Find the row whose vertical band [y, y+height) contains y.
 * @param {Array<{key: string, y: number, height: number}>} rows - Row bands
 * @param {number} y - The vertical position to test
 * @returns {string|null} The matching row key, or null if none contains y
 */
export function pickRowKeyByY(rows, y) {
  for (const row of rows) {
    if (y >= row.y && y < row.y + row.height) return row.key;
  }
  return null;
}
