/**
 * Custom field definition from Redmine /custom_fields.json endpoint
 * Requires admin permissions to access
 */
export interface CustomFieldDefinition {
  id: number;
  name: string;
  customized_type: "time_entry" | "issue" | "project" | "user" | "version" | "document" | "expense";
  field_format: "string" | "text" | "int" | "float" | "list" | "date" | "bool" | "link" | "user" | "version";
  is_required: boolean;
  multiple?: boolean;
  possible_values?: { value: string; label?: string }[];
  default_value?: string;
  min_length?: number;
  max_length?: number;
  regexp?: string;
}

/**
 * Custom field value for time entry creation/update
 */
export interface TimeEntryCustomFieldValue {
  id: number;
  value: string | string[];
}
