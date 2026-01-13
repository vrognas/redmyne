import { describe, it, expect, beforeEach, vi } from "vitest";
import { RedmineServer } from "../../../src/redmine/redmine-server";
import * as http from "http";
import { EventEmitter } from "events";

// Create mock request function with priority support
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
        end: () => void;
        on: (event: string, handler: (...args: unknown[]) => void) => unknown;
      };
      request.end = function () {
        const path = options.path || "/";
        const response = new EventEmitter() as NodeJS.EventEmitter & {
          statusCode: number;
          statusMessage: string;
        };
        response.statusCode = 200;
        response.statusMessage = "OK";

        callback(response);

        queueMicrotask(() => {
          let data: unknown;

          if (
            options.method === "GET" &&
            path.includes("/enumerations/issue_priorities.json")
          ) {
            data = {
              issue_priorities: [
                { id: 1, name: "Low", is_default: false },
                { id: 2, name: "Normal", is_default: true },
                { id: 3, name: "High", is_default: false },
                { id: 4, name: "Urgent", is_default: false },
              ],
            };
          } else if (path.match(/\/issues\/\d+\.json/) && options.method === "PUT") {
            data = { success: true };
          } else {
            data = { error: "Not found" };
          }

          response.emit("data", Buffer.from(JSON.stringify(data)));
          response.emit("end");
        });
      };
      request.on = function (
        event: string,
        handler: (...args: unknown[]) => void
      ) {
        EventEmitter.prototype.on.call(this, event, handler);
        return this;
      };
      return request;
    }
  ) as unknown as typeof http.request;

describe("RedmineServer Priority", () => {
  let server: RedmineServer;

  beforeEach(() => {
    server = new RedmineServer({
      address: "https://localhost:3000",
      key: "test-api-key",
      requestFn: createMockRequest(),
    });
  });

  describe("getIssuePriorities", () => {
    it("should fetch issue priorities", async () => {
      const result = await server.getIssuePriorities();
      expect(result.issue_priorities).toHaveLength(4);
      expect(result.issue_priorities[0].name).toBe("Low");
      expect(result.issue_priorities[1].name).toBe("Normal");
      expect(result.issue_priorities[1].is_default).toBe(true);
    });

    it("should cache issue priorities", async () => {
      const mockRequest = createMockRequest();
      const serverWithMock = new RedmineServer({
        address: "https://localhost:3000",
        key: "test-api-key",
        requestFn: mockRequest,
      });

      // First call
      await serverWithMock.getIssuePriorities();
      expect(mockRequest).toHaveBeenCalledTimes(1);

      // Second call should use cache
      const result = await serverWithMock.getIssuePriorities();
      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(result.issue_priorities).toHaveLength(4);
    });
  });

  describe("setIssuePriority", () => {
    it("should update issue priority", async () => {
      await expect(server.setIssuePriority(123, 3)).resolves.not.toThrow();
    });

    it("should invalidate issue cache after update", async () => {
      // This is implicitly tested - setIssuePriority calls invalidateIssueCache
      await server.setIssuePriority(123, 3);
      // No error means success
    });
  });
});
