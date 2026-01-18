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

/**
 * Checks if a custom field value is meaningful (not empty, "0", or whitespace).
 * Use this to filter out noise from tooltips.
 */
export function isCustomFieldMeaningful(value: unknown): boolean {
  const formatted = formatCustomFieldValue(value);
  if (!formatted) return false;
  // Skip pure zero values (0, 0.0, 0.00, etc.)
  if (/^0(\.0+)?$/.test(formatted)) return false;
  return true;
}
