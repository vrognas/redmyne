import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as vscode from "vscode";
import { LoggingRedmineServer } from "../../../src/redmine/logging-redmine-server";
import * as http from "http";
import { EventEmitter } from "events";

// Mock http.request
vi.mock("http", async () => {
  const actual = await vi.importActual<typeof http>("http");
  return {
    ...actual,
    request: vi.fn(
      (
        options: { path?: string; method?: string },
        callback: (
          response: NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          }
        ) => void
      ) => {
        const request = new EventEmitter() as NodeJS.EventEmitter & {
          end: () => void;
          on: (event: string, handler: (...args: unknown[]) => void) => unknown;
        };
        request.end = function () {
          const response = new EventEmitter() as NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          };
          response.statusCode = 200;
          response.statusMessage = "OK";

          setTimeout(() => {
            const data = { issues: [], total_count: 0 };
            response.emit("data", Buffer.from(JSON.stringify(data)));
            response.emit("end");
          }, 10);

          callback(response);
        };
        request.on = function () {
          return this;
        };
        return request;
      }
    ),
  };
});

describe("LoggingRedmineServer", () => {
  let mockChannel: { appendLine: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockChannel = { appendLine: vi.fn() };
  });

  it("logs when enabled", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: false }
    );

    await server.getIssuesAssignedToMe();

    expect(mockChannel.appendLine).not.toHaveBeenCalled();

    server.dispose();
  });

  it("logs network errors", async () => {
    vi.mocked(http.request).mockImplementationOnce(
      (
        _options: unknown,
        _callback: (response: NodeJS.EventEmitter) => void
      ): http.ClientRequest => {
        const request = new EventEmitter() as http.ClientRequest & {
          end: () => void;
          on: (event: string, handler: (...args: unknown[]) => void) => unknown;
        };
        let errorHandler: ((error: Error) => void) | null = null;
        request.end = () => {
          setTimeout(() => {
            if (errorHandler) {
              errorHandler(new Error("Network error"));
            }
          }, 10);
        };
        request.on = function (event: string, handler: (...args: unknown[]) => void) {
          if (event === "error") {
            errorHandler = handler as (error: Error) => void;
          }
          return this;
        };
        return request;
      }
    );

    const server = new LoggingRedmineServer(
      {
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
    vi.mocked(http.request).mockImplementationOnce(
      (
        _options: unknown,
        callback: (
          response: NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          }
        ) => void
      ) => {
        const request = new EventEmitter() as http.ClientRequest & {
          end: () => void;
          on: (event: string, handler: (...args: unknown[]) => void) => unknown;
        };
        request.end = function () {
          const response = new EventEmitter() as NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          };
          response.statusCode = 201;
          response.statusMessage = "Created";

          setTimeout(() => {
            response.emit("data", Buffer.from('{"issue":{"id":123}}'));
            response.emit("end");
          }, 10);

          callback(response);
        };
        request.on = function () {
          return this;
        };
        return request;
      }
    );

    const server = new LoggingRedmineServer(
      {
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
    vi.mocked(http.request).mockImplementationOnce(
      (
        _options: unknown,
        callback: (
          response: NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          }
        ) => void
      ) => {
        const request = new EventEmitter() as http.ClientRequest & {
          end: () => void;
          on: (event: string, handler: (...args: unknown[]) => void) => unknown;
        };
        request.end = function () {
          const response = new EventEmitter() as NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          };
          response.statusCode = 204;
          response.statusMessage = "No Content";

          setTimeout(() => {
            response.emit("end");
          }, 10);

          callback(response);
        };
        request.on = function () {
          return this;
        };
        return request;
      }
    );

    const server = new LoggingRedmineServer(
      {
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
    vi.mocked(http.request).mockImplementationOnce(
      (
        _options: unknown,
        callback: (
          response: NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          }
        ) => void
      ) => {
        const request = new EventEmitter() as http.ClientRequest & {
          end: () => void;
          on: (event: string, handler: (...args: unknown[]) => void) => unknown;
        };
        request.end = function () {
          const response = new EventEmitter() as NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          };
          response.statusCode = 401;
          response.statusMessage = "Unauthorized";

          setTimeout(() => {
            response.emit("end");
          }, 10);

          callback(response);
        };
        request.on = function () {
          return this;
        };
        return request;
      }
    );

    const server = new LoggingRedmineServer(
      {
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
    vi.mocked(http.request).mockImplementationOnce(
      (
        _options: unknown,
        callback: (
          response: NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          }
        ) => void
      ) => {
        const request = new EventEmitter() as http.ClientRequest & {
          end: () => void;
          on: (event: string, handler: (...args: unknown[]) => void) => unknown;
        };
        request.end = function () {
          const response = new EventEmitter() as NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          };
          response.statusCode = 403;
          response.statusMessage = "Forbidden";

          setTimeout(() => {
            response.emit("end");
          }, 10);

          callback(response);
        };
        request.on = function () {
          return this;
        };
        return request;
      }
    );

    const server = new LoggingRedmineServer(
      {
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
    vi.mocked(http.request).mockImplementationOnce(
      (
        _options: unknown,
        callback: (
          response: NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          }
        ) => void
      ) => {
        const request = new EventEmitter() as http.ClientRequest & {
          end: () => void;
          on: (event: string, handler: (...args: unknown[]) => void) => unknown;
        };
        request.end = function () {
          const response = new EventEmitter() as NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          };
          response.statusCode = 404;
          response.statusMessage = "Not Found";

          setTimeout(() => {
            response.emit("end");
          }, 10);

          callback(response);
        };
        request.on = function () {
          return this;
        };
        return request;
      }
    );

    const server = new LoggingRedmineServer(
      {
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
    vi.mocked(http.request).mockImplementationOnce(
      (
        _options: unknown,
        callback: (
          response: NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          }
        ) => void
      ) => {
        const request = new EventEmitter() as http.ClientRequest & {
          end: () => void;
          on: (event: string, handler: (...args: unknown[]) => void) => unknown;
        };
        request.end = function () {
          const response = new EventEmitter() as NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          };
          response.statusCode = 500;
          response.statusMessage = "Internal Server Error";

          setTimeout(() => {
            response.emit("end");
          }, 10);

          callback(response);
        };
        request.on = function () {
          return this;
        };
        return request;
      }
    );

    const server = new LoggingRedmineServer(
      {
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
    vi.mocked(http.request).mockImplementationOnce(
      (
        _options: unknown,
        callback: (
          response: NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
            headers: { "content-type"?: string };
          }
        ) => void
      ) => {
        const request = new EventEmitter() as http.ClientRequest & {
          end: () => void;
          on: (event: string, handler: (...args: unknown[]) => void) => unknown;
        };
        request.end = function () {
          const response = new EventEmitter() as NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
            headers: { "content-type"?: string };
          };
          response.statusCode = 200;
          response.statusMessage = "OK";
          response.headers = { "content-type": "image/png" };

          setTimeout(() => {
            response.emit("data", Buffer.from("{}"));
            response.emit("end");
          }, 10);

          callback(response);
        };
        request.on = function () {
          return this;
        };
        return request;
      }
    );

    const server = new LoggingRedmineServer(
      {
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
    vi.mocked(http.request).mockImplementationOnce(
      (
        _options: unknown,
        callback: (
          response: NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          }
        ) => void
      ) => {
        const request = new EventEmitter() as http.ClientRequest & {
          end: () => void;
          on: (event: string, handler: (...args: unknown[]) => void) => unknown;
        };
        request.end = function () {
          const response = new EventEmitter() as NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          };
          response.statusCode = 400;
          response.statusMessage = "Bad Request";

          setTimeout(() => {
            response.emit(
              "data",
              Buffer.from('{"errors":["Invalid field"]}')
            );
            response.emit("end");
          }, 10);

          callback(response);
        };
        request.on = function () {
          return this;
        };
        return request;
      }
    );

    const server = new LoggingRedmineServer(
      {
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
    vi.mocked(http.request).mockImplementationOnce(
      (
        _options: unknown,
        callback: (
          response: NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          }
        ) => void
      ) => {
        const request = new EventEmitter() as http.ClientRequest & {
          end: () => void;
          on: (event: string, handler: (...args: unknown[]) => void) => unknown;
        };
        request.end = function () {
          const response = new EventEmitter() as NodeJS.EventEmitter & {
            statusCode: number;
            statusMessage: string;
          };
          response.statusCode = 400;
          response.statusMessage = "Bad Request";

          setTimeout(() => {
            response.emit(
              "data",
              Buffer.from('{"user":{"password":"leaked123"}}')
            );
            response.emit("end");
          }, 10);

          callback(response);
        };
        request.on = function () {
          return this;
        };
        return request;
      }
    );

    const server = new LoggingRedmineServer(
      {
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    await server.doRequest("/users.json?api_key=secret&password=pass123&id=5", "GET");

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
      expect.stringContaining("secret")
    );
    expect(mockChannel.appendLine).not.toHaveBeenCalledWith(
      expect.stringContaining("pass123")
    );

    server.dispose();
  });

  it("preserves non-sensitive query params", async () => {
    const server = new LoggingRedmineServer(
      {
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
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
        address: "http://localhost",
        key: "test-key",
        rejectUnauthorized: false,
        additionalHeaders: {},
      },
      mockChannel as unknown as vscode.OutputChannel,
      { enabled: true }
    );

    // Make 3 concurrent requests to different endpoints
    const promises = [
      server.doRequest("/projects.json", "GET"),
      server.doRequest("/issues.json", "GET"),
      server.doRequest("/users.json", "GET")
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
