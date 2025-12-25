import type * as vscode from "vscode";

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
 * Redacts sensitive fields from a JSON string or plain text.
 * Replaces values of sensitive fields with "***".
 */
export function redactSensitiveData(data: string): string {
  try {
    const parsed = JSON.parse(data);
    const redacted = redactObject(parsed);
    return JSON.stringify(redacted);
  } catch {
    // If not valid JSON, use text-based redaction
    return redactPlainText(data);
  }
}

function redactPlainText(text: string): string {
  let result = text;

  // Redact patterns like key=value, key: value, "key":"value"
  for (const field of SENSITIVE_FIELDS) {
    // Match key=value or key:value patterns (URL-encoded, form data, etc.)
    result = result.replace(
      new RegExp(`(${field})=([^&\\s]+)`, 'gi'),
      '$1=***'
    );
    result = result.replace(
      new RegExp(`(${field}):\\s*([^,\\s\\n}]+)`, 'gi'),
      '$1: ***'
    );
    // Match "key":"value" patterns
    result = result.replace(
      new RegExp(`("${field}"\\s*:\\s*")([^"]+)(")`, 'gi'),
      '$1***$3'
    );
  }

  return result;
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

export class ApiLogger {
  constructor(
    private channel: vscode.OutputChannel,
    private bodyTruncateLength = 200
  ) {}

  logRequest(
    counter: number,
    method: string,
    path: string,
    requestBody?: Buffer
  ): void {
    const timestamp = this.formatTimestamp();
    const truncatedPath = this.truncateQueryParams(path);
    this.channel.appendLine(
      `[${timestamp}] [${counter}] ${method} ${truncatedPath}`
    );

    if (requestBody && requestBody.length > 0) {
      const bodyString = requestBody.toString("utf8");
      const redacted = redactSensitiveData(bodyString);
      const bodyPreview = this.truncateString(redacted, this.bodyTruncateLength);
      this.channel.appendLine(`  Body: ${bodyPreview}`);
    }
  }

  logResponse(
    counter: number,
    status: number,
    duration: number,
    responseSize?: number,
    contentType?: string
  ): void {
    const timestamp = this.formatTimestamp();
    const size = responseSize !== undefined ? ` ${responseSize}B` : "";
    const binary = this.isBinary(contentType) ? " [binary]" : "";
    this.channel.appendLine(
      `[${timestamp}] [${counter}] → ${status} (${duration}ms)${size}${binary}`
    );
  }

  logError(
    counter: number,
    error: Error,
    duration: number,
    statusCode?: number,
    responseBody?: Buffer
  ): void {
    const timestamp = this.formatTimestamp();
    const status = statusCode ? `→ ${statusCode} ` : "";
    this.channel.appendLine(
      `[${timestamp}] [${counter}] ${status}ERROR: ${error.message} (${duration}ms)`
    );

    if (responseBody && responseBody.length > 0) {
      const bodyString = responseBody.toString("utf8");
      const redacted = redactSensitiveData(bodyString);
      this.channel.appendLine(`  Response: ${redacted}`);
    }
  }

  private truncateQueryParams(path: string): string {
    const queryIndex = path.indexOf("?");
    if (queryIndex === -1) return path;

    const basePath = path.substring(0, queryIndex);
    const query = path.substring(queryIndex + 1);

    const redactedQuery = this.redactQueryParams(query);

    if (redactedQuery.length > 100) {
      return basePath + "?" + redactedQuery.substring(0, 100) + "...";
    }

    return basePath + "?" + redactedQuery;
  }

  private redactQueryParams(query: string): string {
    const params = new URLSearchParams(query);
    const sensitiveFields = ["password", "api_key", "apikey", "token", "secret", "auth", "authorization", "key"];

    for (const key of params.keys()) {
      const lowerKey = key.toLowerCase();
      if (sensitiveFields.some(field => lowerKey.includes(field))) {
        params.set(key, "***");
      }
    }

    return params.toString();
  }

  private truncateString(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + "...";
  }

  private isBinary(contentType?: string): boolean {
    if (!contentType) return false;
    return (
      contentType.startsWith("image/") || contentType === "application/pdf"
    );
  }

  private formatTimestamp(): string {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    const ms = String(now.getMilliseconds()).padStart(3, "0");
    return `${hours}:${minutes}:${seconds}.${ms}`;
  }
}
