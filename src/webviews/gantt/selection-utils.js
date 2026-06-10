/**
 * Pure helpers for gantt drag geometry - extracted for testability.
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
