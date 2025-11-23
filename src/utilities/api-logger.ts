import type * as vscode from "vscode";
import { redactSensitiveData } from "./redaction";

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
    const query = path.substring(queryIndex);

    if (query.length > 100) {
      return basePath + query.substring(0, 100) + "...";
    }

    return path;
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
