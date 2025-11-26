import { describe, it, expect, vi } from "vitest";
import { RedmineServer } from "../../../src/redmine/redmine-server";
import * as http from "http";
import { EventEmitter } from "events";

// Track request body for assertions
let capturedBody: string = "";

const createMockRequest = () =>
  vi.fn(
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
        end: (data?: Buffer) => void;
        setTimeout: (ms: number, cb: () => void) => void;
        on: (event: string, handler: (...args: unknown[]) => void) => unknown;
      };
      request.setTimeout = () => {};
      request.end = function (data?: Buffer) {
        // Capture body data passed to end()
        if (data) {
          capturedBody = data.toString("utf8");
        }
        const response = new EventEmitter() as NodeJS.EventEmitter & {
          statusCode: number;
          statusMessage: string;
        };
        response.statusCode = 200;
        response.statusMessage = "OK";
        callback(response);

        queueMicrotask(() => {
          if (options.method === "PUT" && options.path?.match(/\/issues\/\d+\.json/)) {
            response.emit("data", Buffer.from(JSON.stringify({ success: true })));
          }
          response.emit("end");
        });
      };
      request.on = function (event: string, handler: (...args: unknown[]) => void) {
        EventEmitter.prototype.on.call(this, event, handler);
        return this;
      };
      return request;
    }
  ) as unknown as typeof http.request;

describe("RedmineServer.updateIssueDates", () => {
  it("should send PUT request with start_date only", async () => {
    capturedBody = "";
    const server = new RedmineServer({
      address: "https://redmine.example.com",
      key: "test-key",
      requestFn: createMockRequest(),
    });

    await server.updateIssueDates(123, "2025-01-15", null);

    const body = JSON.parse(capturedBody);
    expect(body.issue.start_date).toBe("2025-01-15");
    expect(body.issue.due_date).toBeUndefined();
  });

  it("should send PUT request with due_date only", async () => {
    capturedBody = "";
    const server = new RedmineServer({
      address: "https://redmine.example.com",
      key: "test-key",
      requestFn: createMockRequest(),
    });

    await server.updateIssueDates(123, null, "2025-01-20");

    const body = JSON.parse(capturedBody);
    expect(body.issue.due_date).toBe("2025-01-20");
    expect(body.issue.start_date).toBeUndefined();
  });

  it("should send PUT request with both dates", async () => {
    capturedBody = "";
    const server = new RedmineServer({
      address: "https://redmine.example.com",
      key: "test-key",
      requestFn: createMockRequest(),
    });

    await server.updateIssueDates(123, "2025-01-15", "2025-01-20");

    const body = JSON.parse(capturedBody);
    expect(body.issue.start_date).toBe("2025-01-15");
    expect(body.issue.due_date).toBe("2025-01-20");
  });
});
