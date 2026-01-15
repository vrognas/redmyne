/**
 * Escape HTML/SVG special characters to prevent XSS.
 * User data (issue subjects, project names) must be escaped before SVG insertion.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\\/g, "&#92;")
    .replace(/`/g, "&#96;")
    .replace(/\$/g, "&#36;");
}

/** Escape string for use in HTML attribute (also escapes newlines). */
export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/\n/g, "&#10;");
}
