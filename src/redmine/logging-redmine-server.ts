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
  private pendingRequests = new Map<number, { startTime: number; requestBody?: Buffer }>(); // requestId -> metadata

  constructor(
    options: RedmineServerConnectionOptions,
    outputChannel: vscode.OutputChannel,
    loggingConfig: LoggingConfig
  ) {
    super(options);
    this.logger = new ApiLogger(outputChannel);
    this.loggingConfig = loggingConfig;
  }

  override doRequest<T>(
    path: string,
    method: HttpMethods,
    data?: Buffer
  ): Promise<T> {
    if (!this.loggingConfig.enabled) {
      return super.doRequest<T>(path, method, data);
    }

    const requestId = ++this.counter;
    const startTime = Date.now();
    this.pendingRequests.set(requestId, { startTime, requestBody: data });

    this.logger.logRequest(requestId, method, path, data);

    return super.doRequest<T>(path, method, data).finally(() => {
      this.pendingRequests.delete(requestId);
    });
  }

  protected override onResponseSuccess(
    statusCode: number | undefined,
    _statusMessage: string | undefined,
    _path: string,
    _method: HttpMethods,
    _requestBody?: Buffer,
    responseBody?: Buffer,
    contentType?: string
  ): void {
    if (!this.loggingConfig.enabled) return;

    const requestId = this.counter;
    const metadata = this.pendingRequests.get(requestId);
    if (metadata) {
      const duration = Date.now() - metadata.startTime;
      const responseSize = responseBody?.length;
      this.logger.logResponse(requestId, statusCode ?? 200, duration, responseSize, contentType);
    }
  }

  protected override onResponseError(
    statusCode: number | undefined,
    _statusMessage: string | undefined,
    error: Error,
    _path: string,
    _method: HttpMethods,
    _requestBody?: Buffer,
    responseBody?: Buffer,
    _contentType?: string
  ): void {
    if (!this.loggingConfig.enabled) return;

    const requestId = this.counter;
    const metadata = this.pendingRequests.get(requestId);
    if (metadata) {
      const duration = Date.now() - metadata.startTime;
      this.logger.logError(requestId, error, duration, statusCode, responseBody);
    }
  }
}
