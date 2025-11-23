const SENSITIVE_FIELDS = [
  "password",
  "api_key",
  "apiKey",
  "token",
  "secret",
  "auth",
  "authorization",
  "key",
];

/**
 * Redacts sensitive fields from a JSON string.
 * Replaces values of sensitive fields with "***".
 */
export function redactSensitiveData(data: string): string {
  try {
    const parsed = JSON.parse(data);
    const redacted = redactObject(parsed);
    return JSON.stringify(redacted);
  } catch {
    // If not valid JSON, return as-is
    return data;
  }
}

function redactObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(redactObject);
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isSensitiveField(key)) {
        result[key] = "***";
      } else {
        result[key] = redactObject(value);
      }
    }
    return result;
  }

  return obj;
}

function isSensitiveField(fieldName: string): boolean {
  const lowerField = fieldName.toLowerCase();
  return SENSITIVE_FIELDS.some((sensitive) =>
    lowerField.includes(sensitive.toLowerCase())
  );
}
