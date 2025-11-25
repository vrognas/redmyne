import { describe, it, expect, vi } from "vitest";
import { RedmineServer } from "../../../src/redmine/redmine-server";
import { EventEmitter } from "events";

// Helper to create mock request with specific status code
const createErrorMockRequest = (statusCode: number, statusMessage: string) =>
  vi.fn((_options, callback) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = function () {
      const response = new EventEmitter() as EventEmitter & {
        statusCode: number;
        statusMessage: string;
        headers: Record<string, string>;
      };
      response.statusCode = statusCode;
      response.statusMessage = statusMessage;
      response.headers = { "content-type": "application/json" };
      callback(response);
      queueMicrotask(() => {
        response.emit("data", Buffer.from(JSON.stringify({ errors: ["Server error"] })));
        response.emit("end");
      });
    };
    return request;
  });

// Helper to create mock request that emits network error
const createNetworkErrorMockRequest = (errorCode: string, errorMessage: string) =>
  vi.fn((_options, _callback) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = function () {
      queueMicrotask(() => {
        const error = new Error(errorMessage) as Error & { code: string };
        error.code = errorCode;
        request.emit("error", error);
      });
    };
    return request;
  });

describe("RedmineServer Error Handling", () => {
  describe("5xx Server Errors", () => {
    it("should handle 500 Internal Server Error", async () => {
      const server = new RedmineServer({
        address: "http://localhost:3000",
        key: "test-key",
        requestFn: createErrorMockRequest(500, "Internal Server Error"),
      });

      await expect(server.getProjects()).rejects.toThrow(
        "Server error (500 Internal Server Error)"
      );
    });

    it("should handle 502 Bad Gateway", async () => {
      const server = new RedmineServer({
        address: "http://localhost:3000",
        key: "test-key",
        requestFn: createErrorMockRequest(502, "Bad Gateway"),
      });

      await expect(server.getProjects()).rejects.toThrow(
        "Server error (502 Bad Gateway)"
      );
    });

    it("should handle 503 Service Unavailable", async () => {
      const server = new RedmineServer({
        address: "http://localhost:3000",
        key: "test-key",
        requestFn: createErrorMockRequest(503, "Service Unavailable"),
      });

      await expect(server.getProjects()).rejects.toThrow(
        "Server error (503 Service Unavailable)"
      );
    });
  });

  describe("4xx Client Errors", () => {
    it("should handle 400 Bad Request with context", async () => {
      const server = new RedmineServer({
        address: "http://localhost:3000",
        key: "test-key",
        requestFn: createErrorMockRequest(400, "Bad Request"),
      });

      await expect(server.getProjects()).rejects.toThrow(
        "Bad request (400)"
      );
    });

    it("should handle 422 Unprocessable Entity", async () => {
      const server = new RedmineServer({
        address: "http://localhost:3000",
        key: "test-key",
        requestFn: createErrorMockRequest(422, "Unprocessable Entity"),
      });

      await expect(server.getProjects()).rejects.toThrow(
        "Validation failed (422)"
      );
    });
  });

  describe("Network Errors", () => {
    it("should handle connection refused", async () => {
      const server = new RedmineServer({
        address: "http://localhost:3000",
        key: "test-key",
        requestFn: createNetworkErrorMockRequest("ECONNREFUSED", "connect ECONNREFUSED"),
      });

      await expect(server.getProjects()).rejects.toThrow(
        "Connection refused - is the server running?"
      );
    });

    it("should handle DNS resolution failure", async () => {
      const server = new RedmineServer({
        address: "http://localhost:3000",
        key: "test-key",
        requestFn: createNetworkErrorMockRequest("ENOTFOUND", "getaddrinfo ENOTFOUND"),
      });

      await expect(server.getProjects()).rejects.toThrow(
        "Server not found - check the URL"
      );
    });

    it("should handle connection timeout", async () => {
      const server = new RedmineServer({
        address: "http://localhost:3000",
        key: "test-key",
        requestFn: createNetworkErrorMockRequest("ETIMEDOUT", "connect ETIMEDOUT"),
      });

      await expect(server.getProjects()).rejects.toThrow(
        "Connection timed out"
      );
    });

    it("should handle connection reset", async () => {
      const server = new RedmineServer({
        address: "http://localhost:3000",
        key: "test-key",
        requestFn: createNetworkErrorMockRequest("ECONNRESET", "read ECONNRESET"),
      });

      await expect(server.getProjects()).rejects.toThrow(
        "Connection reset by server"
      );
    });
  });
});
