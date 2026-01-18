/**
 * Formats custom field values for display in tooltips.
 * Handles various value types returned by Redmine API.
 */
export function formatCustomFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value
      .filter(v => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .map(v => String(v).trim())
      .filter(Boolean)
      .join(", ");
  }
  if (typeof value === "object") return ""; // Skip objects
  return String(value).trim();
}
