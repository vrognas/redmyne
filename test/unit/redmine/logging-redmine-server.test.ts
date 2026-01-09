import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as vscode from "vscode";
import { LoggingRedmineServer } from "../../../src/redmine/logging-redmine-server";
import * as http from "http";
import { EventEmitter } from "events";

// Helper to create mock request function with configurable response
interface MockResponseConfig {
  statusCode?: number;
  statusMessage?: string;
  data?: string | Buffer;
  headers?: Record<string, string>;
  error?: Error;
  delay?: number;
}

const createMockRequestFn = (config: MockResponseConfig = {}) => {
  const {
    statusCode = 200,
    statusMessage = "OK",
    data = JSON.stringify({ issues: [], total_count: 0 }),
    headers = {},
    error,
    delay = 10,
  } = config;

  return vi.fn(
    (
      _options: unknown,
      callback: (
        response: NodeJS.EventEmitter & {
          statusCode: number;
          statusMessage: string;
          headers: Record<string, string>;
        }
      ) => void
    ) => {
      const request = new EventEmitter() as http.ClientRequest & {
        end: () => void;
        on: (event: string, handler: (...args: unknown[]) => void) => http.ClientRequest;
        setTimeout: (ms: number, cb: () => void) => http.ClientRequest;
      };

      let errorHandler: ((error: Error) => void) | null = null;

      request.on = function (
        event: string,
        handler: (...args: unknown[]) => void
      ) {
        if (event === "error") {
          errorHandler = handler as (error: Error) => void;
        }
        return this;
      };

      request.setTimeout = function () {
        return this;
      };

      request.end = function () {
        if (error) {
          setTimeout(() => {
            if (errorHandler) errorHandler(error);
          }, delay);
          return;
        }

        const response = new EventEmitter() as NodeJS.EventEmitter & {
          statusCode: number;
          statusMessage: string;
          headers: Record<string, string>;
        };
        response.statusCode = statusCode;
        response.statusMessage = statusMessage;
        response.headers = { "content-type": "application/json", ...headers };

        callback(response);

        setTimeout(() => {
          if (data) {
            response.emit(
              "data",
              Buffer.isBuffer(data) ? data : Buffer.from(data)
            );
          }
          response.emit("end");
        }, delay);
      };

      return request;
    }
  ) as unknown as typeof http.request;
};

describe("LoggingRedmineServer", () => {
  let mockChannel: { appendLine: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockChannel = { appendLine: vi.fn() };
  });

  it("logs when enabled", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn(),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await server.getIssuesAssignedToMe();

    expect(mockChannel.appendLine).toHaveBeenCalled();
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("GET")
    );
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("200")
    );

    server.dispose();
  });

  it("silent when disabled", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn(),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: false }
    );

    await server.getIssuesAssignedToMe();

    expect(mockChannel.appendLine).not.toHaveBeenCalled();

    server.dispose();
  });

  it("logs network errors", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn({ error: new Error("Network error") }),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await expect(server.doRequest("/test.json", "GET")).rejects.toThrow(
      "Network error"
    );

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("GET")
    );
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("ERROR")
    );

    server.dispose();
  });

  // Phase 1: Status Code Tests
  it("logs 201 Created status", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn({
          statusCode: 201,
          statusMessage: "Created",
          data: '{"issue":{"id":123}}',
        }),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await server.doRequest("/issues.json", "POST", Buffer.from("{}"));

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("201")
    );

    server.dispose();
  });

  it("logs 204 No Content status", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn({
          statusCode: 204,
          statusMessage: "No Content",
          data: "",
        }),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await server.doRequest("/issues/123.json", "DELETE");

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("204")
    );

    server.dispose();
  });

  it("logs 401 Unauthorized status", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn({
          statusCode: 401,
          statusMessage: "Unauthorized",
          data: "",
        }),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await expect(server.getIssuesAssignedToMe()).rejects.toThrow();

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("401")
    );

    server.dispose();
  });

  it("logs 403 Forbidden status", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn({
          statusCode: 403,
          statusMessage: "Forbidden",
          data: "",
        }),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await expect(server.getIssuesAssignedToMe()).rejects.toThrow();

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("403")
    );

    server.dispose();
  });

  it("logs 404 Not Found status", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn({
          statusCode: 404,
          statusMessage: "Not Found",
          data: "",
        }),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await expect(server.getIssuesAssignedToMe()).rejects.toThrow();

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("404")
    );

    server.dispose();
  });

  it("logs 500 Internal Server Error status", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn({
          statusCode: 500,
          statusMessage: "Internal Server Error",
          data: "",
        }),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await expect(server.getIssuesAssignedToMe()).rejects.toThrow();

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("500")
    );

    server.dispose();
  });

  // Phase 2: Request/Response Detail Tests
  it("logs request body truncated at 200 chars", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn(),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    const longBody = "x".repeat(300);
    await server.doRequest("/issues.json", "POST", Buffer.from(longBody));

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringMatching(/Body: .{200}\.\.\.$/)
    );

    server.dispose();
  });

  it("logs response size in bytes", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn(),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await server.getIssuesAssignedToMe();

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringMatching(/\d+B/)
    );

    server.dispose();
  });

  it("logs query parameters", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn(),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await server.doRequest("/issues.json?status_id=open&limit=25", "GET");

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("?status_id=open&limit=25")
    );

    server.dispose();
  });

  it("logs truncated query params when >100 chars", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn(),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    const longQuery = "a".repeat(150);
    await server.doRequest(`/issues.json?${longQuery}`, "GET");

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("aaaaaaaaa...")
    );

    server.dispose();
  });

  it("skips binary content (image/png)", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn({
          headers: { "content-type": "image/png" },
          data: "{}",
        }),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await server.doRequest("/avatar.png", "GET");

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("[binary]")
    );

    server.dispose();
  });

  it("logs response body on error", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn({
          statusCode: 400,
          statusMessage: "Bad Request",
          data: '{"errors":["Invalid field"]}',
        }),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await expect(server.doRequest("/issues.json", "POST")).rejects.toThrow();

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('{"errors":["Invalid field"]}')
    );

    server.dispose();
  });

  // Phase 3: Redaction Tests
  it("redacts password in request body", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn(),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    const sensitiveBody = JSON.stringify({
      user: { login: "admin", password: "secret123" },
    });
    await server.doRequest("/users.json", "POST", Buffer.from(sensitiveBody));

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('"password":"***"')
    );
    expect(mockChannel.appendLine).not.toHaveBeenCalledWith(
      expect.stringContaining("secret123")
    );

    server.dispose();
  });

  it("redacts api_key in request body", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn(),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    const sensitiveBody = JSON.stringify({ api_key: "abc123xyz" });
    await server.doRequest("/settings.json", "PUT", Buffer.from(sensitiveBody));

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('"api_key":"***"')
    );
    expect(mockChannel.appendLine).not.toHaveBeenCalledWith(
      expect.stringContaining("abc123xyz")
    );

    server.dispose();
  });

  it("redacts token in request body", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn(),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    const sensitiveBody = JSON.stringify({ token: "bearer-token-123" });
    await server.doRequest("/auth.json", "POST", Buffer.from(sensitiveBody));

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('"token":"***"')
    );
    expect(mockChannel.appendLine).not.toHaveBeenCalledWith(
      expect.stringContaining("bearer-token-123")
    );

    server.dispose();
  });

  it("redacts password in error response body", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn({
          statusCode: 400,
          statusMessage: "Bad Request",
          data: '{"user":{"password":"leaked123"}}',
        }),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await expect(server.doRequest("/users.json", "POST")).rejects.toThrow();

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('"password":"***"')
    );
    expect(mockChannel.appendLine).not.toHaveBeenCalledWith(
      expect.stringContaining("leaked123")
    );

    server.dispose();
  });

  it("preserves non-sensitive fields", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn(),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    const body = JSON.stringify({
      user: { login: "admin", email: "admin@example.com" },
    });
    await server.doRequest("/users.json", "POST", Buffer.from(body));

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("admin")
    );
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("admin@example.com")
    );

    server.dispose();
  });

  it("redacts api_key in query params", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn(),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await server.doRequest("/users.json?api_key=secret123", "GET");

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("api_key=***")
    );
    expect(mockChannel.appendLine).not.toHaveBeenCalledWith(
      expect.stringContaining("secret123")
    );

    server.dispose();
  });

  it("redacts token in query params", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn(),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await server.doRequest("/issues.json?token=bearer-abc123", "GET");

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("token=***")
    );
    expect(mockChannel.appendLine).not.toHaveBeenCalledWith(
      expect.stringContaining("bearer-abc123")
    );

    server.dispose();
  });

  it("redacts multiple sensitive query params", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn(),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await server.doRequest(
      "/users.json?api_key=secret&password=pass123&id=5",
      "GET"
    );

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("api_key=***")
    );
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("password=***")
    );
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("id=5")
    );
    expect(mockChannel.appendLine).not.toHaveBeenCalledWith(
      expect.stringContaining("=secret")
    );
    expect(mockChannel.appendLine).not.toHaveBeenCalledWith(
      expect.stringContaining("pass123")
    );

    server.dispose();
  });

  it("preserves non-sensitive query params", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn(),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await server.doRequest("/issues.json?status_id=open&project_id=42", "GET");

    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("status_id=open")
    );
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("project_id=42")
    );

    server.dispose();
  });

  it("handles concurrent requests correctly", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "https://localhost",
        key: "test-key",
        additionalHeaders: {},
        requestFn: createMockRequestFn(),
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    // Make 3 concurrent requests to different endpoints
    const promises = [
      server.doRequest("/projects.json", "GET"),
      server.doRequest("/issues.json", "GET"),
      server.doRequest("/users.json", "GET"),
    ];

    await Promise.all(promises);

    // Verify all requests were logged
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("[1] GET /projects.json")
    );
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("[2] GET /issues.json")
    );
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("[3] GET /users.json")
    );

    // Verify all responses were logged with correct counter
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("[1] → 200")
    );
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("[2] → 200")
    );
    expect(mockChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("[3] → 200")
    );

    server.dispose();
  });
});
