import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import { normalizeServerUrl } from "../utilities/server-url";
import { errorToString } from "../utilities/error-feedback";
import type { RedmineServerConnectionOptions } from "./redmine-server-interface";

export type HttpMethods = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

const REDMINE_API_KEY_HEADER_NAME = "X-Redmine-API-Key";
const REQUEST_TIMEOUT_MS = 30000;

/** Default max concurrent API requests */
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;

export class RedmineOptionsError extends Error {
  name = "RedmineOptionsError";
}

export interface RedmineServerOptions extends RedmineServerConnectionOptions {
  url: URL;
}

/**
 * HTTP transport core for the Redmine REST API: option validation/normalization,
 * TLS + custom-CA handling, a bounded concurrency queue, the request/response
 * lifecycle (status-code mapping, timeout, JSON parse), generic pagination, and
 * JSON body encoding.
 *
 * Domain endpoints + caches live in RedmineServer (the subclass). The three
 * on*Response/onRequestStart hooks are protected no-ops here, overridden by
 * LoggingRedmineServer for API logging. doRequest/paginate/encodeJson are the
 * surface the subclass builds on.
 */
export class RedmineHttpClient {
  options: RedmineServerOptions = {} as RedmineServerOptions;

  private cachedCaBuffer: Buffer | undefined;

  // Request queue to prevent server overload
  private activeRequests = 0;
  private readonly maxConcurrentRequests: number;
  private readonly requestQueue: Array<() => void> = [];

  get request() {
    if (this.options.requestFn) {
      return this.options.requestFn;
    }
    return this.options.url.protocol === "https:"
      ? https.request
      : http.request;
  }

  private validateOptions(options: RedmineServerConnectionOptions): void {
    if (!options.address) {
      throw new RedmineOptionsError("Address cannot be empty!");
    }
    if (!options.key) {
      throw new RedmineOptionsError("Key cannot be empty!");
    }
    let url: URL;
    try {
      url = new URL(options.address);
    } catch {
      throw new RedmineOptionsError(`Invalid URL: ${options.address}`);
    }
    if (url.protocol !== "https:") {
      throw new RedmineOptionsError(
        "HTTPS required. Redmine URL must start with https://"
      );
    }
  }

  private setOptions(options: RedmineServerConnectionOptions) {
    // Normalize once at the source so every consumer of options.address (URL
    // builders, the Gantt links, the HTTP transport) is free of trailing
    // slashes — appending "/issues/123" can't then produce "//issues/123".
    const address = normalizeServerUrl(options.address);
    this.options = {
      ...options,
      address,
      url: new URL(address),
    };
    if (
      this.options.additionalHeaders === null ||
      this.options.additionalHeaders === undefined
    ) {
      this.options.additionalHeaders = {};
    }
  }

  private loadCa(): Buffer | undefined {
    if (this.cachedCaBuffer !== undefined) return this.cachedCaBuffer;
    const caFile = this.options.caFile;
    if (!caFile) return undefined;
    try {
      this.cachedCaBuffer = fs.readFileSync(caFile);
      return this.cachedCaBuffer;
    } catch (err) {
      const msg = errorToString(err);
      throw new Error(`redmyne.caFile: cannot read "${caFile}" — ${msg}`);
    }
  }

  constructor(options: RedmineServerConnectionOptions) {
    this.validateOptions(options);
    this.setOptions(options);
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
  }

  /**
   * Acquire a request slot, waiting if at max concurrency
   */
  private acquireSlot(): Promise<void> {
    if (this.activeRequests < this.maxConcurrentRequests) {
      this.activeRequests++;
      return Promise.resolve();
    }
    // Queue this request until a slot is available
    return new Promise((resolve) => {
      this.requestQueue.push(resolve);
    });
  }

  /**
   * Release a request slot and process next queued request
   */
  private releaseSlot(): void {
    const next = this.requestQueue.shift();
    if (next) {
      // Don't decrement - slot transfers to next request
      next();
    } else {
      this.activeRequests--;
    }
  }

  /**
   * Hook called when request starts (after slot acquired).
   * Override in subclasses to log request start.
   */
  protected onRequestStart(
    _path: string,
    _method: HttpMethods,
    _requestBody?: Buffer,
    _requestId?: unknown
  ): void {
    // No-op by default, child classes can override
  }

  /**
   * Hook called before successful response resolution.
   * Override in subclasses to capture response metadata for logging.
   */
  protected onResponseSuccess(
    _statusCode: number | undefined,
    _statusMessage: string | undefined,
    _path: string,
    _method: HttpMethods,
    _requestBody?: Buffer,
    _responseBody?: Buffer,
    _contentType?: string,
    _requestId?: unknown
  ): void {
    // No-op by default, child classes can override
  }

  /**
   * Hook called before error rejection.
   * Override in subclasses to capture error metadata for logging.
   */
  protected onResponseError(
    _statusCode: number | undefined,
    _statusMessage: string | undefined,
    _error: Error,
    _path: string,
    _method: HttpMethods,
    _requestBody?: Buffer,
    _responseBody?: Buffer,
    _contentType?: string,
    _requestId?: unknown
  ): void {
    // No-op by default, child classes can override
  }

  async doRequest<T>(path: string, method: HttpMethods, data?: Buffer): Promise<T> {
    await this.acquireSlot();
    try {
      return await this.executeRequest<T>(path, method, data);
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * Execute HTTP request (internal - use doRequest for queue management)
   */
  private executeRequest<T>(path: string, method: HttpMethods, data?: Buffer): Promise<T> {
    const { url, key, additionalHeaders } = this.options;
    const requestId = Symbol("request"); // Unique ID for hook correlation

    // Call hook after slot acquired, before HTTP request
    this.onRequestStart(path, method, data, requestId);

    const ca = this.loadCa();
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port ? parseInt(url.port, 10) : undefined,
      headers: {
        [REDMINE_API_KEY_HEADER_NAME]: key,
        ...additionalHeaders,
      },
      rejectUnauthorized: true, // Always validate TLS certificates
      ...(ca ? { ca } : {}),
      path: `${url.pathname}${path}`,
      method,
    };
    if (data) {
      const headers = options.headers as http.OutgoingHttpHeaders;
      headers["Content-Length"] = data.length;
      headers["Content-Type"] = "application/json";
    }

    return new Promise((resolve, reject) => {
      const incomingChunks: Buffer[] = [];
      // Guard terminal callbacks: the timeout handler destroys the request,
      // which re-emits 'error', so handleError would otherwise fire a second
      // time with the same requestId and corrupt logging correlation.
      let settled = false;
      const handleData = (_: http.IncomingMessage) => (incoming: Buffer) => {
        incomingChunks.push(incoming);
      };

      const handleEnd = (clientResponse: http.IncomingMessage) => () => {
        const incomingBuffer = incomingChunks.length > 0
          ? Buffer.concat(incomingChunks)
          : Buffer.alloc(0);
        const { statusCode, statusMessage } = clientResponse;
        const contentType = clientResponse.headers?.["content-type"];

        if (statusCode === 401) {
          const error = new Error(
            "Server returned 401 (perhaps your API Key is not valid, or your server has additional authentication methods?)"
          );
          this.onResponseError(statusCode, statusMessage, error, path, method, data, incomingBuffer, contentType, requestId);
          reject(error);
          return;
        }
        if (statusCode === 403) {
          const error = new Error(
            "Server returned 403 (perhaps you haven't got permissions?)"
          );
          this.onResponseError(statusCode, statusMessage, error, path, method, data, incomingBuffer, contentType, requestId);
          reject(error);
          return;
        }
        if (statusCode === 404) {
          const error = new Error("Resource doesn't exist");
          this.onResponseError(statusCode, statusMessage, error, path, method, data, incomingBuffer, contentType, requestId);
          reject(error);
          return;
        }

        // Handle remaining 4xx client errors
        if (statusCode && statusCode >= 400 && statusCode < 500) {
          let message: string;
          if (statusCode === 400) {
            message = "Bad request (400)";
          } else if (statusCode === 422) {
            // Try to extract Redmine's error details from response body
            try {
              const body = JSON.parse(incomingBuffer.toString("utf8"));
              if (body.errors && Array.isArray(body.errors) && body.errors.length > 0) {
                message = `Validation failed: ${body.errors.join(", ")}`;
              } else {
                message = "Validation failed (422)";
              }
            } catch {
              message = "Validation failed (422)";
            }
          } else {
            message = `Client error (${statusCode} ${statusMessage})`;
          }
          const error = new Error(message);
          this.onResponseError(statusCode, statusMessage, error, path, method, data, incomingBuffer, contentType, requestId);
          reject(error);
          return;
        }

        // Handle 5xx server errors
        if (statusCode && statusCode >= 500) {
          const error = new Error(`Server error (${statusCode} ${statusMessage})`);
          this.onResponseError(statusCode, statusMessage, error, path, method, data, incomingBuffer, contentType, requestId);
          reject(error);
          return;
        }

        if (incomingBuffer.length > 0) {
          try {
            const object = JSON.parse(incomingBuffer.toString("utf8"));
            this.onResponseSuccess(statusCode, statusMessage, path, method, data, incomingBuffer, contentType, requestId);
            resolve(object);
          } catch (_e) {
            const error = new Error("Couldn't parse Redmine response as JSON...");
            this.onResponseError(statusCode, statusMessage, error, path, method, data, incomingBuffer, contentType, requestId);
            reject(error);
          }
          return;
        }

        // Using `doRequest` on the endpoints that return 204 should type as void/null
        this.onResponseSuccess(statusCode, statusMessage, path, method, data, incomingBuffer, contentType, requestId);
        resolve(null as unknown as T);
      };

      const clientRequest = this.request(options, (incoming) => {
        incoming.on("data", handleData(incoming));
        incoming.on("end", handleEnd(incoming));
      });

      const handleError = (error: Error & { code?: string }) => {
        if (settled) return; // Ignore destroy()-induced re-emission after timeout
        settled = true;
        // Map common network error codes to user-friendly messages
        let message: string;
        switch (error.code) {
          case "ECONNREFUSED":
            message = "Connection refused - is the server running?";
            break;
          case "ENOTFOUND":
            message = "Server not found - check the URL";
            break;
          case "ETIMEDOUT":
            message = "Connection timed out";
            break;
          case "ECONNRESET":
            message = "Connection reset by server";
            break;
          case "CERT_HAS_EXPIRED":
          case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
          case "DEPTH_ZERO_SELF_SIGNED_CERT":
            message = "TLS certificate validation failed. The machine or container may not trust the issuing CA.";
            break;
          default:
            message = `Network error: ${error.message}`;
        }
        const wrappedError = new Error(message);
        this.onResponseError(undefined, undefined, wrappedError, path, method, data, undefined, undefined, requestId);
        reject(wrappedError);
      };

      clientRequest.on("error", handleError);

      // Timeout to prevent indefinite hangs
      if (typeof clientRequest.setTimeout === "function") {
        clientRequest.setTimeout(REQUEST_TIMEOUT_MS, () => {
          if (settled) return;
          settled = true;
          // destroy() re-emits 'error'; handleError is no-op now (settled).
          clientRequest.destroy();
          const error = new Error(`Request timeout after ${REQUEST_TIMEOUT_MS / 1000} seconds`);
          this.onResponseError(undefined, undefined, error, path, method, data, undefined, undefined, requestId);
          reject(error);
        });
      }

      clientRequest.end(data);
    });
  }

  /**
   * Generic pagination helper for Redmine API endpoints
   * Fetches first page to get total_count, then remaining pages in parallel
   */
  protected async paginate<TRaw, TResult = TRaw>(
    endpoint: string,
    responseKey: string,
    transform?: (items: TRaw[]) => TResult[],
    onPage?: (pageItems: TResult[]) => void
  ): Promise<TResult[]> {
    const limit = 100; // Redmine max is 100
    const separator = endpoint.includes("?") ? "&" : "?";
    const pageUrl = (offset: number) =>
      `${endpoint}${separator}limit=${limit}&offset=${offset}`;

    const fetchPage = async (offset: number): Promise<TResult[]> => {
      const response = await this.doRequest<Record<string, unknown>>(pageUrl(offset), "GET");
      const rawItems = (response?.[responseKey] || []) as TRaw[];
      const page = transform ? transform(rawItems) : (rawItems as unknown as TResult[]);
      if (onPage) onPage(page);
      return page;
    };

    // First request also needs total_count, so fetch it directly (not via
    // fetchPage which discards the envelope).
    const firstResponse = await this.doRequest<Record<string, unknown> & { total_count: number }>(
      pageUrl(0),
      "GET"
    );
    const totalCount = firstResponse?.total_count || 0;
    const rawFirstPage = (firstResponse?.[responseKey] || []) as TRaw[];
    const firstPage = transform ? transform(rawFirstPage) : (rawFirstPage as unknown as TResult[]);
    if (onPage) onPage(firstPage);

    if (totalCount <= limit) {
      return firstPage;
    }

    // Calculate remaining offsets
    const remainingOffsets: number[] = [];
    for (let offset = limit; offset < totalCount; offset += limit) {
      remainingOffsets.push(offset);
    }

    // Fetch remaining pages in batches to avoid overwhelming the server
    const paginationBatchSize = this.maxConcurrentRequests;
    const remainingPages: TResult[][] = [];

    for (let i = 0; i < remainingOffsets.length; i += paginationBatchSize) {
      const batch = remainingOffsets.slice(i, i + paginationBatchSize);
      const batchResults = await Promise.all(batch.map(fetchPage));
      remainingPages.push(...batchResults);
    }

    // Combine: first page + all remaining pages (flattened)
    return firstPage.concat(...remainingPages);
  }

  /**
   * Encode data as JSON buffer for POST/PUT requests
   */
  protected encodeJson<T>(data: T): Buffer {
    return Buffer.from(JSON.stringify(data), "utf8");
  }
}
