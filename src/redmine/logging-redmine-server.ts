import type * as vscode from "vscode";
import {
  RedmineServer,
  RedmineServerConnectionOptions,
} from "./redmine-server";
import { ApiLogger } from "../utilities/api-logger";

type HttpMethods = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface LoggingConfig {
  enabled: boolean;
}

export class LoggingRedmineServer extends RedmineServer {
  private logger: ApiLogger;
  private counter = 0;
  private loggingConfig: LoggingConfig;
  private pendingByPath = new Map<string, Array<{ startTime: number; displayId: number }>>();
  private pendingBySymbol = new Map<symbol, { startTime: number; displayId: number }>();
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    options: RedmineServerConnectionOptions,
    outputChannel: vscode.OutputChannel,
    loggingConfig: LoggingConfig
  ) {
    super(options);
    this.logger = new ApiLogger(outputChannel);
    this.loggingConfig = loggingConfig;

    // Start periodic cleanup of stale entries (every 30s)
    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleRequests();
    }, 30000);
  }

  private cleanupStaleRequests(): void {
    const now = Date.now();
    const timeout = 60000; // 60s timeout

    // Clean up stale entries in pendingByPath
    for (const [key, queue] of this.pendingByPath.entries()) {
      const filtered = queue.filter(entry => now - entry.startTime < timeout);
      if (filtered.length === 0) {
        this.pendingByPath.delete(key);
      } else if (filtered.length !== queue.length) {
        this.pendingByPath.set(key, filtered);
      }
    }

    // Clean up stale entries in pendingBySymbol
    for (const [symbol, metadata] of this.pendingBySymbol.entries()) {
      if (now - metadata.startTime >= timeout) {
        this.pendingBySymbol.delete(symbol);
      }
    }
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.pendingByPath.clear();
    this.pendingBySymbol.clear();
  }

  override doRequest<T>(
    path: string,
    method: HttpMethods,
    data?: Buffer
  ): Promise<T> {
    if (!this.loggingConfig.enabled) {
      return super.doRequest<T>(path, method, data);
    }

    const displayId = ++this.counter;
    const startTime = Date.now();

    this.logger.logRequest(displayId, method, path, data);

    const pathKey = `${method}:${path}`;
    if (!this.pendingByPath.has(pathKey)) {
      this.pendingByPath.set(pathKey, []);
    }
    this.pendingByPath.get(pathKey)!.push({ startTime, displayId });

    return super.doRequest<T>(path, method, data);
  }

  protected override onResponseSuccess(
    statusCode: number | undefined,
    _statusMessage: string | undefined,
    path: string,
    method: HttpMethods,
    _requestBody?: Buffer,
    responseBody?: Buffer,
    contentType?: string,
    requestId?: unknown
  ): void {
    if (!this.loggingConfig.enabled || typeof requestId !== 'symbol') return;

    if (!this.pendingBySymbol.has(requestId)) {
      const pathKey = `${method}:${path}`;
      const queue = this.pendingByPath.get(pathKey);
      if (queue && queue.length > 0) {
        const metadata = queue.shift()!;
        this.pendingBySymbol.set(requestId, metadata);
        if (queue.length === 0) {
          this.pendingByPath.delete(pathKey);
        }
      }
    }

    const metadata = this.pendingBySymbol.get(requestId);
    if (metadata) {
      const duration = Date.now() - metadata.startTime;
      const responseSize = responseBody?.length;
      this.logger.logResponse(metadata.displayId, statusCode ?? 200, duration, responseSize, contentType);
      this.pendingBySymbol.delete(requestId);
    }
  }

  protected override onResponseError(
    statusCode: number | undefined,
    _statusMessage: string | undefined,
    error: Error,
    path: string,
    method: HttpMethods,
    _requestBody?: Buffer,
    responseBody?: Buffer,
    _contentType?: string,
    requestId?: unknown
  ): void {
    if (!this.loggingConfig.enabled || typeof requestId !== 'symbol') return;

    if (!this.pendingBySymbol.has(requestId)) {
      const pathKey = `${method}:${path}`;
      const queue = this.pendingByPath.get(pathKey);
      if (queue && queue.length > 0) {
        const metadata = queue.shift()!;
        this.pendingBySymbol.set(requestId, metadata);
        if (queue.length === 0) {
          this.pendingByPath.delete(pathKey);
        }
      }
    }

    const metadata = this.pendingBySymbol.get(requestId);
    if (metadata) {
      const duration = Date.now() - metadata.startTime;
      this.logger.logError(metadata.displayId, error, duration, statusCode, responseBody);
      this.pendingBySymbol.delete(requestId);
    }
  }
}
