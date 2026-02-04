/**
 * Custom Field Picker
 * UI utilities for prompting users to enter custom field values
 */

import * as vscode from "vscode";

// Re-export types for convenience
export type {
  CustomFieldDefinition,
  TimeEntryCustomFieldValue,
} from "../redmine/models/custom-field-definition";

import type {
  CustomFieldDefinition,
  TimeEntryCustomFieldValue,
} from "../redmine/models/custom-field-definition";

export interface PickCustomFieldsResult {
  values: TimeEntryCustomFieldValue[];
  cancelled: boolean;
}

/**
 * Prompt user for required custom field values only
 * Skips optional fields
 */
export async function pickRequiredCustomFields(
  fields: CustomFieldDefinition[]
): Promise<PickCustomFieldsResult> {
  const required = fields.filter((f) => f.is_required);
  if (required.length === 0) {
    return { values: [], cancelled: false };
  }
  return pickCustomFieldsInternal(required);
}

/**
 * Prompt user for all custom field values (required and optional)
 * Uses existing values as defaults if provided
 */
export async function pickCustomFields(
  fields: CustomFieldDefinition[],
  existing?: TimeEntryCustomFieldValue[]
): Promise<PickCustomFieldsResult> {
  return pickCustomFieldsInternal(fields, existing);
}

async function pickCustomFieldsInternal(
  fields: CustomFieldDefinition[],
  existing?: TimeEntryCustomFieldValue[]
): Promise<PickCustomFieldsResult> {
  const values: TimeEntryCustomFieldValue[] = [];

  for (const field of fields) {
    const existingValue = existing?.find((e) => e.id === field.id);
    const defaultValue = existingValue
      ? (Array.isArray(existingValue.value) ? existingValue.value.join(", ") : String(existingValue.value))
      : field.default_value;

    const result = await pickFieldValue(field, defaultValue);
    if (result === undefined) {
      return { values: [], cancelled: true };
    }
    values.push({ id: field.id, value: result });
  }

  return { values, cancelled: false };
}

async function pickFieldValue(
  field: CustomFieldDefinition,
  defaultValue?: string
): Promise<string | string[] | undefined> {
  const requiredLabel = field.is_required ? " (required)" : "";

  switch (field.field_format) {
    case "list":
      return pickListField(field, requiredLabel);

    case "bool":
      return pickBoolField(field, requiredLabel, defaultValue);

    case "int":
      return pickIntField(field, requiredLabel, defaultValue);

    case "float":
      return pickFloatField(field, requiredLabel, defaultValue);

    case "date":
      return pickDateField(field, requiredLabel, defaultValue);

    case "string":
    case "text":
    case "link":
    default:
      return pickStringField(field, requiredLabel, defaultValue);
  }
}

async function pickListField(
  field: CustomFieldDefinition,
  requiredLabel: string
): Promise<string | string[] | undefined> {
  const options = (field.possible_values || []).map((pv) => ({
    label: pv.label || pv.value,
    value: pv.value,
  }));

  if (field.multiple) {
    const selected = await vscode.window.showQuickPick(options, {
      title: `${field.name}${requiredLabel}`,
      placeHolder: `Select one or more values for ${field.name}`,
      canPickMany: true,
    });
    if (!selected) return undefined;
    return (selected as Array<{ value: string }>).map((s) => s.value);
  } else {
    const selected = await vscode.window.showQuickPick(options, {
      title: `${field.name}${requiredLabel}`,
      placeHolder: `Select value for ${field.name}`,
    });
    if (!selected) return undefined;
    return (selected as { value: string }).value;
  }
}

async function pickBoolField(
  field: CustomFieldDefinition,
  requiredLabel: string,
  defaultValue?: string
): Promise<string | undefined> {
  const options = [
    { label: "Yes", value: "1" },
    { label: "No", value: "0" },
  ];

  // Pre-select based on default
  if (defaultValue === "1" || defaultValue === "true") {
    options[0] = { ...options[0], picked: true } as typeof options[0] & { picked: boolean };
  } else if (defaultValue === "0" || defaultValue === "false") {
    options[1] = { ...options[1], picked: true } as typeof options[1] & { picked: boolean };
  }

  const selected = await vscode.window.showQuickPick(options, {
    title: `${field.name}${requiredLabel}`,
    placeHolder: `Select Yes/No for ${field.name}`,
  });
  if (!selected) return undefined;
  return (selected as { value: string }).value;
}

async function pickIntField(
  field: CustomFieldDefinition,
  requiredLabel: string,
  defaultValue?: string
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `${field.name}${requiredLabel}`,
    prompt: `Enter integer value for ${field.name}`,
    value: defaultValue,
    validateInput: (value) => {
      if (!value.trim() && !field.is_required) return null;
      if (!/^-?\d+$/.test(value.trim())) return "Must be an integer";
      return null;
    },
  });
}

async function pickFloatField(
  field: CustomFieldDefinition,
  requiredLabel: string,
  defaultValue?: string
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `${field.name}${requiredLabel}`,
    prompt: `Enter numeric value for ${field.name}`,
    value: defaultValue,
    validateInput: (value) => {
      if (!value.trim() && !field.is_required) return null;
      if (isNaN(parseFloat(value.trim()))) return "Must be a number";
      return null;
    },
  });
}

async function pickDateField(
  field: CustomFieldDefinition,
  requiredLabel: string,
  defaultValue?: string
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `${field.name}${requiredLabel}`,
    prompt: `Enter date for ${field.name} (YYYY-MM-DD)`,
    value: defaultValue,
    placeHolder: "YYYY-MM-DD",
    validateInput: (value) => {
      if (!value.trim() && !field.is_required) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return "Format: YYYY-MM-DD";
      return null;
    },
  });
}

async function pickStringField(
  field: CustomFieldDefinition,
  requiredLabel: string,
  defaultValue?: string
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `${field.name}${requiredLabel}`,
    prompt: `Enter value for ${field.name}`,
    value: defaultValue,
    validateInput: (value) => {
      if (!value.trim() && field.is_required) return `${field.name} is required`;
      if (field.min_length && value.length < field.min_length) {
        return `Minimum ${field.min_length} characters`;
      }
      if (field.max_length && value.length > field.max_length) {
        return `Maximum ${field.max_length} characters`;
      }
      if (field.regexp) {
        const regex = new RegExp(field.regexp);
        if (!regex.test(value)) return `Must match pattern: ${field.regexp}`;
      }
      return null;
    },
  });
}

/**
 * Result from promptForRequiredCustomFields
 */
export interface CustomFieldPromptResult {
  values: TimeEntryCustomFieldValue[] | undefined;
  cancelled: boolean;
  prompted: boolean; // True if user was prompted (for error handling)
}

/**
 * High-level utility to fetch and prompt for required custom fields.
 * Handles API errors gracefully (non-admin users).
 *
 * @param getCustomFields - Function to fetch custom field definitions (e.g., server.getTimeEntryCustomFields)
 * @returns values (undefined if no required fields), cancelled flag, and prompted flag
 */
export async function promptForRequiredCustomFields(
  getCustomFields: () => Promise<CustomFieldDefinition[]>
): Promise<CustomFieldPromptResult> {
  try {
    const customFieldDefs = await getCustomFields();
    const required = customFieldDefs.filter((f) => f.is_required);
    if (required.length === 0) {
      return { values: undefined, cancelled: false, prompted: false };
    }
    const { values, cancelled } = await pickRequiredCustomFields(required);
    if (cancelled) {
      return { values: undefined, cancelled: true, prompted: true };
    }
    return { values, cancelled: false, prompted: true };
  } catch {
    // Custom fields API not accessible (non-admin) - continue without
    return { values: undefined, cancelled: false, prompted: false };
  }
}
