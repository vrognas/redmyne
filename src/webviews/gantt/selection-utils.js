// Pure helpers for gantt row click-to-select (node-testable, no DOM).

// Parse the Y component of an SVG transform="translate(x, y)" string.
export function parseTranslateY(transform, fallback) {
  const match = /translate\([^,]+,\s*([-\d.]+)/.exec(transform || '');
  return match ? parseFloat(match[1]) : fallback;
}

// Find the row whose vertical band [y, y+height) contains y.
// rows: [{ key, y, height }]; returns key or null.
export function pickRowKeyByY(rows, y) {
  for (const row of rows) {
    if (y >= row.y && y < row.y + row.height) return row.key;
  }
  return null;
}
