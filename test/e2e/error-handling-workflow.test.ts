import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import * as http from "http";
import * as vscode from "vscode";
import { RedmineServer } from "../../src/redmine/redmine-server";
import { IssueController } from "../../src/controllers/issue-controller";
import listOpenIssues from "../../src/commands/list-open-issues-assigned-to-me";

vi.mock("vscode");

let mockHttpBehavior: "network-error" | "401" | "403" | "404" | "invalid-json" | "partial-update" | "success" = "success";

vi.mock("http", async () => {
  const actual = await vi.importActual<typeof http>("http");
  return {
    ...actual,
    request: vi.fn((options, callback) => {
      const request = new EventEmitter() as http.ClientRequest;

      type MockRequest = http.ClientRequest & { end: (data?: Buffer) => http.ClientRequest; write: () => boolean; abort: () => void };
      (request as MockRequest).end = function (this: http.ClientRequest) {
        if (mockHttpBehavior === "network-error") {
          const error = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
          error.code = "ECONNREFUSED";
          setTimeout(() => this.emit("error", error), 0);
          return this;
        }

        const response = new EventEmitter() as http.IncomingMessage;

        if (mockHttpBehavior === "401") {
          response.statusCode = 401;
          response.statusMessage = "Unauthorized";
        } else if (mockHttpBehavior === "403") {
          response.statusCode = 403;
          response.statusMessage = "Forbidden";
        } else if (mockHttpBehavior === "404") {
          response.statusCode = 404;
          response.statusMessage = "Not Found";
        } else if (mockHttpBehavior === "invalid-json") {
          response.statusCode = 200;
          response.statusMessage = "OK";
        } else if (mockHttpBehavior === "partial-update") {
          response.statusCode = 200;
          response.statusMessage = "OK";
        } else {
          response.statusCode = 200;
          response.statusMessage = "OK";
        }

        setTimeout(() => {
          if (mockHttpBehavior === "invalid-json") {
            response.emit("data", Buffer.from("invalid{json"));
          } else if (mockHttpBehavior === "partial-update") {
            const data = {
              issue: {
                id: 123,
                status: { id: 1, name: "New" },
                assigned_to: { id: 2, name: "NewUser" },
              },
            };
            response.emit("data", Buffer.from(JSON.stringify(data)));
          } else if (response.statusCode! < 400) {
            response.emit("data", Buffer.from(JSON.stringify({ issues: [] })));
          } else {
            response.emit("data", Buffer.from(JSON.stringify({ error: "Error" })));
          }
          response.emit("end");
        }, 0);

        if (callback) {
          callback(response);
        }
        return this;
      };

      (request as MockRequest).write = vi.fn().mockReturnValue(true);
      (request as MockRequest).abort = vi.fn();

      return request;
    }),
  };
});

describe("Error Handling Workflow E2E", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHttpBehavior = "success";
    vi.mocked(vscode.window.withProgress).mockImplementation(
      async (_options, callback) => callback({ report: vi.fn() } as vscode.Progress<{ message?: string; increment?: number }>)
    );
  });

  it("handles network errors (connection refused, timeout) across layers", async () => {
    mockHttpBehavior = "network-error";

    const server = new RedmineServer({
      address: "http://unreachable.local:3000",
      key: "testkey",
    });

    // Test server layer
    await expect(server.getIssuesAssignedToMe()).rejects.toThrow(
      "NodeJS Request Error (ECONNREFUSED): connect ECONNREFUSED"
    );

    // Test command → UI propagation
    await listOpenIssues({ server, config: {} });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "NodeJS Request Error (ECONNREFUSED): connect ECONNREFUSED"
    );
  });

  it("handles API errors (401/403/404) and invalid JSON responses", async () => {
    const testCases: Array<{ behavior: typeof mockHttpBehavior; expected: string }> = [
      {
        behavior: "401",
        expected:
          "Server returned 401 (perhaps your API Key is not valid, or your server has additional authentication methods?)",
      },
      { behavior: "403", expected: "Server returned 403" },
      { behavior: "404", expected: "Resource doesn't exist" },
    ];

    for (const { behavior, expected } of testCases) {
      mockHttpBehavior = behavior;

      const server = new RedmineServer({
        address: "http://localhost:3000",
        key: "testkey",
      });

      await expect(server.getIssuesAssignedToMe()).rejects.toThrow(expected);
    }

    // Test invalid JSON
    mockHttpBehavior = "invalid-json";

    const server = new RedmineServer({
      address: "http://localhost:3000",
      key: "testkey",
    });

    await expect(server.getIssuesAssignedToMe()).rejects.toThrow(
      "Couldn't parse Redmine response as JSON"
    );
  });

  it("handles user cancellations in multi-step workflows and partial failures", async () => {
    const mockIssue = {
      id: 123,
      subject: "Test",
      status: { id: 1, name: "New" },
      tracker: { id: 1, name: "Bug" },
      author: { id: 1, name: "Author" },
      project: { id: 1, name: "Project" },
      assigned_to: { id: 1, name: "User" },
    };

    // Test cancellation at action selection (top-level)
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

    const mockServer = {
      getIssueStatuses: vi.fn(),
      options: { address: "http://test", url: { hostname: "test" } },
    } as Partial<RedmineServer>;

    const controller = new IssueController(mockIssue as Parameters<typeof IssueController>[0], mockServer as RedmineServer);
    await controller.listActions();

    expect(mockServer.getIssueStatuses).not.toHaveBeenCalled();

    // Test partial failure in quick update
    mockHttpBehavior = "partial-update";

    const server2 = new RedmineServer({
      address: "http://localhost:3000",
      key: "testkey",
    });

    const result = await server2.applyQuickUpdate({
      issueId: 123,
      message: "test",
      assignee: { id: 2, name: "NewUser", isUser: true },
      status: { statusId: 2, name: "Resolved" },
    } as Parameters<typeof server2.applyQuickUpdate>[0]);

    expect(result.isSuccessful()).toBe(false);
    expect(result.differences.length).toBeGreaterThan(0);
  });
});
