import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  RedmineServer,
  RedmineOptionsError,
} from "../../../src/redmine/redmine-server";
import * as http from "http";
import { EventEmitter } from "events";

// Create mock request function
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

        // Call callback first (synchronous)
        callback(response);

        // Then emit data and end events asynchronously
        queueMicrotask(() => {
          let data: unknown;

          if (options.method === "GET" && path.includes("/issues.json")) {
              // Check if fetching by specific IDs (from searchIssues)
              const issueIdMatch = path.match(/issue_id=([0-9,]+)/);
              // Check if subject filter search
              const isSubjectFilter = path.includes("f%5B%5D=subject") || path.includes("f[]=subject");
              if (issueIdMatch) {
                const ids = issueIdMatch[1].split(",").map(Number);
                data = {
                  issues: ids.map(id => ({
                    id,
                    subject: `Issue ${id}`,
                    status: { id: 1, name: "New" },
                    tracker: { id: 1, name: "Bug" },
                    author: { id: 1, name: "John Doe" },
                    project: { id: 1, name: "Test Project" },
                  })),
                  total_count: ids.length,
                };
              } else if (isSubjectFilter) {
                // Subject filter returns same issues as search API for test consistency
                data = {
                  issues: [
                    { id: 456, subject: "Issue 456", status: { id: 1, name: "New" }, tracker: { id: 1, name: "Bug" }, author: { id: 1, name: "John Doe" }, project: { id: 1, name: "Test Project" } },
                    { id: 789, subject: "Issue 789", status: { id: 1, name: "New" }, tracker: { id: 1, name: "Bug" }, author: { id: 1, name: "John Doe" }, project: { id: 1, name: "Test Project" } },
                  ],
                  total_count: 2,
                };
              } else {
                data = {
                  issues: [
                    {
                      id: 123,
                      subject: "Test issue",
                      status: { id: 1, name: "New" },
                      tracker: { id: 1, name: "Bug" },
                      author: { id: 1, name: "John Doe" },
                      project: { id: 1, name: "Test Project" },
                      assigned_to: { id: 1, name: "John Doe" },
                    },
                  ],
                  total_count: 1,
                };
              }
            } else if (path.match(/\/issues\/\d+\.json/)) {
              if (options.method === "GET") {
                data = {
                  issue: {
                    id: 123,
                    subject: "Test issue",
                    status: { id: 1, name: "New" },
                    tracker: { id: 1, name: "Bug" },
                    author: { id: 1, name: "John Doe" },
                    project: { id: 1, name: "Test Project" },
                    assigned_to: { id: 1, name: "John Doe" },
                  },
                };
              } else if (options.method === "PUT") {
                data = { success: true };
              }
            } else if (
              options.method === "GET" &&
              path.includes("/projects.json")
            ) {
              data = {
                projects: [{ id: 1, name: "Test Project", identifier: "test" }],
                total_count: 1,
              };
            } else if (
              options.method === "GET" &&
              path.includes("/issue_statuses.json")
            ) {
              data = {
                issue_statuses: [
                  { id: 1, name: "New" },
                  { id: 2, name: "In Progress" },
                ],
              };
            } else if (
              options.method === "GET" &&
              path.includes("/enumerations/time_entry_activities.json")
            ) {
              data = {
                time_entry_activities: [{ id: 9, name: "Development" }],
              };
            } else if (
              options.method === "GET" &&
              path.match(/\/projects\/\d+\/memberships\.json/)
            ) {
              data = {
                memberships: [{ user: { id: 1, name: "John Doe" } }],
              };
            } else if (
              options.method === "POST" &&
              path.includes("/time_entries.json")
            ) {
              data = { time_entry: { id: 1 } };
            } else if (
              options.method === "GET" &&
              path.includes("/search.json")
            ) {
              // Return search results with issue type
              data = {
                results: [
                  { id: 456, title: "Issue #456: Search result", type: "issue", url: "/issues/456" },
                  { id: 789, title: "Issue #789: Another result", type: "issue", url: "/issues/789" },
                ],
              };
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

describe("RedmineServer", () => {
  let server: RedmineServer;

  beforeEach(() => {
    server = new RedmineServer({
      address: "https://localhost:3000",
      key: "test-api-key",
      requestFn: createMockRequest(),
    });
  });

  it("should fetch issues assigned to me", async () => {
    const result = await server.getIssuesAssignedToMe();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].subject).toBe("Test issue");
  });

  it("should update issue status", async () => {
    const issue = { id: 123 } as { id: number };
    await expect(server.setIssueStatus(issue, 2)).resolves.not.toThrow();
  });

  it("should add time entry", async () => {
    await expect(
      server.addTimeEntry(123, 9, "1.5", "Test work")
    ).resolves.not.toThrow();
  });

  it("should fetch projects", async () => {
    const projects = await server.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].toQuickPickItem().label).toBe("Test Project");
  });

  it("should fetch issue by id", async () => {
    const result = await server.getIssueById(123);
    expect(result.issue.id).toBe(123);
    expect(result.issue.subject).toBe("Test issue");
  });

  it("should fetch issue statuses", async () => {
    const result = await server.getIssueStatuses();
    expect(result.issue_statuses).toHaveLength(2);
    expect(result.issue_statuses[0].name).toBe("New");
  });

  it("should cache issue statuses", async () => {
    await server.getIssueStatuses();
    const result = await server.getIssueStatuses();
    expect(result.issue_statuses).toHaveLength(2);
  });

  it("should fetch time entry activities", async () => {
    const result = await server.getTimeEntryActivities();
    expect(result.time_entry_activities).toHaveLength(1);
    expect(result.time_entry_activities[0].name).toBe("Development");
  });

  it("should cache time entry activities", async () => {
    await server.getTimeEntryActivities();
    const result = await server.getTimeEntryActivities();
    expect(result.time_entry_activities).toHaveLength(1);
  });

  it("should fetch memberships", async () => {
    const memberships = await server.getMemberships(1);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].name).toBe("John Doe");
    expect(memberships[0].isUser).toBe(true);
  });

  it("should fetch typed issue statuses", async () => {
    const statuses = await server.getIssueStatusesTyped();
    expect(statuses).toHaveLength(2);
    expect(statuses[0].name).toBe("New");
  });

  describe("getOpenIssuesForProject", () => {
    it("should include subprojects by default (no subproject_id filter)", async () => {
      const capturedPaths: string[] = [];
      const baseMock = createMockRequest();
      const mockRequest = vi.fn((options: { path?: string }, callback: unknown) => {
        capturedPaths.push(options.path || "");
        return baseMock(options, callback as Parameters<typeof baseMock>[1]);
      }) as unknown as typeof http.request;

      const serverWithCapture = new RedmineServer({
        address: "https://localhost:3000",
        key: "test-api-key",
        requestFn: mockRequest,
      });

      await serverWithCapture.getOpenIssuesForProject(1, true);

      // When include_subproject=true, should NOT have subproject_id filter
      expect(capturedPaths.some(p => p.includes("subproject_id=!*"))).toBe(false);
    });

    it("should exclude subprojects when include_subproject=false", async () => {
      const capturedPaths: string[] = [];
      const baseMock = createMockRequest();
      const mockRequest = vi.fn((options: { path?: string }, callback: unknown) => {
        capturedPaths.push(options.path || "");
        return baseMock(options, callback as Parameters<typeof baseMock>[1]);
      }) as unknown as typeof http.request;

      const serverWithCapture = new RedmineServer({
        address: "https://localhost:3000",
        key: "test-api-key",
        requestFn: mockRequest,
      });

      await serverWithCapture.getOpenIssuesForProject(1, false);

      // When include_subproject=false, should have subproject_id=!* filter
      expect(capturedPaths.some(p => p.includes("subproject_id=!*"))).toBe(true);
    });
  });

  it("should compare servers correctly", () => {
    const server2 = new RedmineServer({
      address: "https://localhost:3000",
      key: "test-api-key",
      requestFn: createMockRequest(),
    });
    expect(server.compare(server2)).toBe(true);

    const server3 = new RedmineServer({
      address: "https://localhost:3001",
      key: "test-api-key",
      requestFn: createMockRequest(),
    });
    expect(server.compare(server3)).toBe(false);
  });

  describe("searchIssues", () => {
    it("should search issues by text", async () => {
      const results = await server.searchIssues("test query");
      expect(results).toHaveLength(2);
      // Results are sorted by relevance (newer IDs first when equal relevance)
      const ids = results.map(r => r.id).sort((a, b) => a - b);
      expect(ids).toEqual([456, 789]);
    });

    it("should return empty array for empty query", async () => {
      const results = await server.searchIssues("");
      expect(results).toHaveLength(0);
    });

    it("should return empty array for whitespace query", async () => {
      const results = await server.searchIssues("   ");
      expect(results).toHaveLength(0);
    });
  });

  describe("security validation", () => {
    it("should reject HTTP URLs", () => {
      expect(
        () =>
          new RedmineServer({
            address: "http://redmine.example.com",
            key: "test-api-key",
          })
      ).toThrow(RedmineOptionsError);
      expect(
        () =>
          new RedmineServer({
            address: "http://redmine.example.com",
            key: "test-api-key",
          })
      ).toThrow("HTTPS required");
    });

    it("should accept HTTPS URLs", () => {
      expect(
        () =>
          new RedmineServer({
            address: "https://redmine.example.com",
            key: "test-api-key",
            requestFn: createMockRequest(),
          })
      ).not.toThrow();
    });

    it("should reject empty address", () => {
      expect(
        () =>
          new RedmineServer({
            address: "",
            key: "test-api-key",
          })
      ).toThrow(RedmineOptionsError);
    });

    it("should reject empty API key", () => {
      expect(
        () =>
          new RedmineServer({
            address: "https://redmine.example.com",
            key: "",
          })
      ).toThrow(RedmineOptionsError);
    });
  });
});
