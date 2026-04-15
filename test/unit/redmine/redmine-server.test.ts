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
                memberships: [{ user: { id: 1, name: "John Doe" }, roles: [{ id: 1, name: "Analyst" }] }],
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

interface RouteMockResult {
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  noBody?: boolean;
  error?: Error & { code?: string };
  triggerTimeout?: boolean;
}

const createRouteMockRequest = (
  resolveRoute: (
    options: { path?: string; method?: string },
    requestBody?: Buffer
  ) => RouteMockResult
) =>
  vi.fn(
    (
      options: { path?: string; method?: string },
      callback: (
        response: NodeJS.EventEmitter & {
          statusCode: number;
          statusMessage: string;
          headers: Record<string, string>;
        }
      ) => void
    ) => {
      const request = new EventEmitter() as NodeJS.EventEmitter & {
        end: (data?: Buffer) => void;
        on: (event: string, handler: (...args: unknown[]) => void) => unknown;
        setTimeout: (ms: number, cb: () => void) => void;
        destroy: () => void;
      };

      let timeoutHandler: (() => void) | undefined;
      let errorHandler: ((error: Error & { code?: string }) => void) | undefined;

      request.on = function (event: string, handler: (...args: unknown[]) => void) {
        if (event === "error") {
          errorHandler = handler as (error: Error & { code?: string }) => void;
        }
        EventEmitter.prototype.on.call(this, event, handler);
        return this;
      };

      request.setTimeout = (_ms: number, cb: () => void) => {
        timeoutHandler = cb;
      };

      request.destroy = () => {
        // No-op in tests.
      };

      request.end = (data?: Buffer) => {
        const result = resolveRoute(options, data);

        if (result.triggerTimeout) {
          queueMicrotask(() => {
            timeoutHandler?.();
          });
          return;
        }

        if (result.error) {
          queueMicrotask(() => {
            errorHandler?.(result.error as Error & { code?: string });
          });
          return;
        }

        const response = new EventEmitter() as NodeJS.EventEmitter & {
          statusCode: number;
          statusMessage: string;
          headers: Record<string, string>;
        };
        response.statusCode = result.statusCode ?? 200;
        response.statusMessage = result.statusMessage ?? "OK";
        response.headers = result.headers ?? { "content-type": "application/json" };

        callback(response);

        queueMicrotask(() => {
          if (!result.noBody) {
            const raw = result.rawBody ?? JSON.stringify(result.body ?? {});
            if (raw.length > 0) {
              response.emit("data", Buffer.from(raw, "utf8"));
            }
          }
          response.emit("end");
        });
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

  it("should fetch memberships with roles", async () => {
    const memberships = await server.getMemberships(1);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].name).toBe("John Doe");
    expect(memberships[0].isUser).toBe(true);
    expect(memberships[0].roles).toEqual(["Analyst"]);
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

  describe("Request Queue", () => {
    it("should limit concurrent requests to maxConcurrentRequests", async () => {
      const requestOrder: number[] = [];
      const requestCompletions: Array<() => void> = [];

      // Create mock that tracks request order and allows manual completion
      const mockRequest = vi.fn(
        (
          _options: unknown,
          callback: (response: NodeJS.EventEmitter & { statusCode: number; statusMessage: string; headers: Record<string, string> }) => void
        ) => {
          const requestNum = requestOrder.length + 1;
          requestOrder.push(requestNum);

          const request = new EventEmitter() as NodeJS.EventEmitter & { end: () => void };
          request.end = () => {
            // Store completion callback for manual triggering
            requestCompletions.push(() => {
              const response = new EventEmitter() as NodeJS.EventEmitter & { statusCode: number; statusMessage: string; headers: Record<string, string> };
              response.statusCode = 200;
              response.statusMessage = "OK";
              response.headers = {};
              callback(response);
              queueMicrotask(() => {
                response.emit("data", Buffer.from(JSON.stringify({ ok: true })));
                response.emit("end");
              });
            });
          };
          return request;
        }
      );

      const server = new RedmineServer({
        address: "https://redmine.example.com",
        key: "test-api-key",
        requestFn: mockRequest as unknown as typeof http.request,
        maxConcurrentRequests: 2,
      });

      // Start 4 requests simultaneously
      const promises = [
        server.doRequest("/test1.json", "GET"),
        server.doRequest("/test2.json", "GET"),
        server.doRequest("/test3.json", "GET"),
        server.doRequest("/test4.json", "GET"),
      ];

      // Wait for requests to be initiated
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Only 2 requests should have started (due to maxConcurrentRequests=2)
      expect(requestOrder).toEqual([1, 2]);
      expect(requestCompletions).toHaveLength(2);

      // Complete first request - should trigger third
      requestCompletions[0]();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(requestOrder).toEqual([1, 2, 3]);

      // Complete second request - should trigger fourth
      requestCompletions[1]();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(requestOrder).toEqual([1, 2, 3, 4]);

      // Complete remaining requests
      requestCompletions[2]();
      requestCompletions[3]();

      await Promise.all(promises);
    });

    it("should use default maxConcurrentRequests of 2", async () => {
      const server = new RedmineServer({
        address: "https://redmine.example.com",
        key: "test-api-key",
        requestFn: createMockRequest(),
      });

      // Access private field for testing (not ideal but verifies default)
      expect((server as unknown as { maxConcurrentRequests: number }).maxConcurrentRequests).toBe(2);
    });

    it("should allow configuring maxConcurrentRequests", async () => {
      const server = new RedmineServer({
        address: "https://redmine.example.com",
        key: "test-api-key",
        requestFn: createMockRequest(),
        maxConcurrentRequests: 5,
      });

      expect((server as unknown as { maxConcurrentRequests: number }).maxConcurrentRequests).toBe(5);
    });
  });

  describe("additional redmine-server branch coverage", () => {
    it("covers pagination batches, filters, limits and generic wrappers", async () => {
      const capturedRequests: { method: string; path: string; body?: string }[] = [];

      const requestFn = createRouteMockRequest((options, requestBody) => {
        const path = options.path || "/";
        const method = options.method || "GET";
        capturedRequests.push({
          method,
          path,
          body: requestBody?.toString("utf8"),
        });

        if (method === "GET" && path.includes("/projects.json")) {
          const parsed = new URL(`https://redmine.local${path}`);
          const offset = Number(parsed.searchParams.get("offset") || "0");
          const count = offset === 200 ? 5 : 100;
          return {
            body: {
              projects: Array.from({ length: count }, (_, i) => {
                const id = offset + i + 1;
                return {
                  id,
                  name: `Project ${id}`,
                  identifier: `project-${id}`,
                };
              }),
              total_count: 205,
            },
          };
        }

        if (method === "GET" && path.includes("/time_entries.json")) {
          const parsed = new URL(`https://redmine.local${path}`);
          const issueId = parsed.searchParams.get("issue_id");
          // Support comma-separated issue IDs (combined batch query)
          const ids = issueId ? issueId.split(",").map(Number) : [1];
          const entries = ids.map(id => ({ id: isNaN(id) ? null : id, comments: "entry" }));
          return {
            body: {
              time_entries: entries,
              total_count: entries.length,
            },
          };
        }

        if (method === "GET" && path.includes("/issues.json")) {
          return {
            body: {
              issues: [
                {
                  id: 900,
                  subject: "Filtered issue",
                  status: { id: 1, name: "New" },
                  tracker: { id: 1, name: "Bug" },
                  author: { id: 1, name: "John Doe" },
                  project: { id: 1, name: "Test Project" },
                },
              ],
              total_count: 1,
            },
          };
        }

        if (method === "POST" && path.endsWith("/post.json")) {
          return { body: { ok: "post" } };
        }
        if (method === "PUT" && path.endsWith("/put.json")) {
          return { body: { ok: "put" } };
        }
        if (method === "DELETE" && path.endsWith("/delete.json")) {
          return { statusCode: 204, statusMessage: "No Content", noBody: true };
        }

        return { body: { ok: true } };
      });

      const serverWithRoutes = new RedmineServer({
        address: "https://localhost:3000",
        key: "test-api-key",
        requestFn,
        maxConcurrentRequests: 2,
      });

      const projects = await serverWithRoutes.getProjects();
      expect(projects).toHaveLength(205);
      expect(capturedRequests.some((r) => r.path.includes("offset=100"))).toBe(true);
      expect(capturedRequests.some((r) => r.path.includes("offset=200"))).toBe(true);

      const beforeAllUsersCall = capturedRequests.length;
      await serverWithRoutes.getTimeEntries({ allUsers: true });
      const allUsersPath = capturedRequests
        .slice(beforeAllUsersCall)
        .find((r) => r.path.includes("/time_entries.json"))?.path;
      expect(allUsersPath?.includes("user_id=me")).toBe(false);

      await serverWithRoutes.getTimeEntries({ from: "2026-01-01", to: "2026-01-31" });
      expect(
        capturedRequests.some(
          (r) =>
            r.path.includes("user_id=me") &&
            r.path.includes("from=2026-01-01") &&
            r.path.includes("to=2026-01-31")
        )
      ).toBe(true);

      expect(await serverWithRoutes.getTimeEntriesForIssues([])).toEqual([]);
      const issueEntries = await serverWithRoutes.getTimeEntriesForIssues(
        [11, 12, 13],
        {
          userId: 7,
          from: "2026-02-01",
          to: "2026-02-28",
        }
      );
      expect(issueEntries).toHaveLength(3);
      const issueRequestPaths = capturedRequests
        .filter((r) => r.path.includes("issue_id="))
        .map((r) => decodeURIComponent(r.path));
      expect(issueRequestPaths.every((p) => p.includes("user_id=7"))).toBe(true);
      expect(issueRequestPaths.every((p) => p.includes("from=2026-02-01"))).toBe(true);
      expect(issueRequestPaths.every((p) => p.includes("to=2026-02-28"))).toBe(true);

      await serverWithRoutes.getFilteredIssues({
        assignee: "any",
        status: "closed",
        priority: 3,
      });
      const closedPath = decodeURIComponent(
        capturedRequests[capturedRequests.length - 1].path
      );
      expect(closedPath.includes("status_id=closed")).toBe(true);
      expect(closedPath.includes("priority_id=3")).toBe(true);

      await serverWithRoutes.getFilteredIssues({
        assignee: "any",
        status: "any",
      });
      const anyPath = decodeURIComponent(
        capturedRequests[capturedRequests.length - 1].path
      );
      expect(anyPath.includes("status_id=*")).toBe(true);
      expect(anyPath.includes("assigned_to_id=me")).toBe(false);

      await serverWithRoutes.getAllOpenIssues();
      await serverWithRoutes.getOpenIssuesForProject(7, false, 2, false);
      const limitPath = decodeURIComponent(
        capturedRequests[capturedRequests.length - 1].path
      );
      expect(limitPath.includes("status_id=*")).toBe(true);
      expect(limitPath.includes("subproject_id=!*")).toBe(true);
      expect(limitPath.includes("limit=2")).toBe(true);

      await expect(serverWithRoutes.post("/post.json", { foo: "bar" })).resolves.toEqual({
        ok: "post",
      });
      await expect(serverWithRoutes.put("/put.json", { foo: "bar" })).resolves.toEqual({
        ok: "put",
      });
      await expect(serverWithRoutes.delete("/delete.json")).resolves.toBeNull();
    });

    it("covers fallback/cache branches for custom fields, modules, activities and versions", async () => {
      let customFieldCalls = 0;

      const requestFn = createRouteMockRequest((options) => {
        const path = options.path || "/";
        const method = options.method || "GET";

        if (method === "GET" && path.includes("/custom_fields.json")) {
          customFieldCalls++;
          return {
            body: {
              custom_fields: [
                {
                  id: 1,
                  name: "Time CF",
                  customized_type: "time_entry",
                  field_format: "string",
                },
                {
                  id: 2,
                  name: "Issue CF",
                  customized_type: "issue",
                  field_format: "string",
                },
              ],
            },
          };
        }

        if (method === "GET" && path.includes("/projects/1.json?include=enabled_modules")) {
          return { body: { project: { enabled_modules: [{ name: "time_tracking" }] } } };
        }
        if (method === "GET" && path.includes("/projects/2.json?include=enabled_modules")) {
          return { body: { project: { enabled_modules: [{ name: "wiki" }] } } };
        }
        if (method === "GET" && path.includes("/projects/3.json?include=enabled_modules")) {
          const error = new Error("modules unavailable") as Error & { code?: string };
          error.code = "ECONNRESET";
          return { error };
        }

        if (method === "GET" && path.includes("/projects/10.json?include=time_entry_activities")) {
          return {
            body: { project: { time_entry_activities: [{ id: 2, name: "Project Activity" }] } },
          };
        }
        if (method === "GET" && path.includes("/projects/11.json?include=time_entry_activities")) {
          return { body: { project: { time_entry_activities: [] } } };
        }
        if (method === "GET" && path.includes("/projects/12.json?include=time_entry_activities")) {
          const error = new Error("activities unavailable") as Error & { code?: string };
          error.code = "ECONNREFUSED";
          return { error };
        }
        if (method === "GET" && path.includes("/enumerations/time_entry_activities.json")) {
          return { body: { time_entry_activities: [{ id: 99, name: "Global Activity" }] } };
        }

        if (method === "GET" && path.includes("/projects/5/versions.json")) {
          return {
            body: {
              versions: [{ id: 5, name: "v5", project: { id: 1, name: "P" } }],
            },
          };
        }
        if (method === "GET" && path.includes("/projects/6/versions.json")) {
          const error = new Error("version fetch failed") as Error & { code?: string };
          error.code = "ENOTFOUND";
          return { error };
        }
        if (method === "POST" && path.includes("/projects/5/versions.json")) {
          return { body: {} };
        }

        return { body: {} };
      });

      const serverWithRoutes = new RedmineServer({
        address: "https://localhost:3000",
        key: "test-api-key",
        requestFn,
      });

      const customFieldsFirst = await serverWithRoutes.getTimeEntryCustomFields();
      expect(customFieldsFirst).toHaveLength(1);
      expect(customFieldsFirst[0].customized_type).toBe("time_entry");

      const customFieldsSecond = await serverWithRoutes.getTimeEntryCustomFields();
      expect(customFieldsSecond).toHaveLength(1);
      expect(customFieldCalls).toBe(1);

      await expect(serverWithRoutes.isTimeTrackingEnabled(1)).resolves.toBe(true);
      await expect(serverWithRoutes.isTimeTrackingEnabled(2)).resolves.toBe(false);
      await expect(serverWithRoutes.isTimeTrackingEnabled(3)).resolves.toBe(true);

      const projectActivities = await serverWithRoutes.getProjectTimeEntryActivities(10);
      expect(projectActivities).toEqual([{ id: 2, name: "Project Activity" }]);

      const fallbackActivities = await serverWithRoutes.getProjectTimeEntryActivities(11);
      expect(fallbackActivities).toEqual([{ id: 99, name: "Global Activity" }]);

      const fallbackAfterError = await serverWithRoutes.getProjectTimeEntryActivities(12);
      expect(fallbackAfterError).toEqual([{ id: 99, name: "Global Activity" }]);

      const versionsByProject = await serverWithRoutes.getVersionsForProjects([5, 6]);
      expect(versionsByProject.get(5)?.length).toBe(1);
      expect(versionsByProject.get(6)).toEqual([]);

      await expect(serverWithRoutes.createVersion(5, { name: "Release X" })).rejects.toThrow(
        "Failed to create version"
      );

      const failingFieldsServer = new RedmineServer({
        address: "https://localhost:3000",
        key: "test-api-key",
        requestFn: createRouteMockRequest((options) => {
          if ((options.path || "").includes("/custom_fields.json")) {
            const error = new Error("forbidden") as Error & { code?: string };
            error.code = "ECONNREFUSED";
            return { error };
          }
          return { body: {} };
        }),
      });
      await expect(failingFieldsServer.getTimeEntryCustomFields()).resolves.toEqual([]);
    });

    it("covers remaining executeRequest branches (parse/client/network/timeout)", async () => {
      const createServer = (result: RouteMockResult) =>
        new RedmineServer({
          address: "https://localhost:3000",
          key: "test-api-key",
          requestFn: createRouteMockRequest(() => result),
        });

      await expect(
        createServer({ statusCode: 204, statusMessage: "No Content", noBody: true }).doRequest(
          "/empty.json",
          "DELETE"
        )
      ).resolves.toBeNull();

      await expect(
        createServer({ rawBody: "not-json", statusCode: 200, statusMessage: "OK" }).doRequest(
          "/bad-json.json",
          "GET"
        )
      ).rejects.toThrow("Couldn't parse Redmine response as JSON...");

      await expect(
        createServer({
          rawBody: "invalid-json",
          statusCode: 422,
          statusMessage: "Unprocessable Entity",
        }).doRequest("/validation.json", "POST")
      ).rejects.toThrow("Validation failed (422)");

      await expect(
        createServer({
          body: { errors: ["conflict"] },
          statusCode: 409,
          statusMessage: "Conflict",
        }).doRequest("/conflict.json", "GET")
      ).rejects.toThrow("Client error (409 Conflict)");

      const certError = new Error("certificate expired") as Error & { code?: string };
      certError.code = "CERT_HAS_EXPIRED";
      await expect(createServer({ error: certError }).doRequest("/ssl.json", "GET")).rejects.toThrow(
        "TLS certificate validation failed. The machine or container may not trust the issuing CA."
      );

      const unknownNetworkError = new Error("socket hang up") as Error & { code?: string };
      unknownNetworkError.code = "EPIPE";
      await expect(
        createServer({ error: unknownNetworkError }).doRequest("/network.json", "GET")
      ).rejects.toThrow("Network error: socket hang up");

      await expect(
        createServer({ triggerTimeout: true }).doRequest("/timeout.json", "GET")
      ).rejects.toThrow("Request timeout after 30 seconds");
    });

    it("passes ca from caFile to request options", async () => {
      const fs = await import("fs");
      const os = await import("os");
      const path = await import("path");
      const tmpFile = path.join(os.tmpdir(), `redmyne-test-ca-${Date.now()}.pem`);
      const fakePem = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----";
      fs.writeFileSync(tmpFile, fakePem);

      let capturedOptions: Record<string, unknown> | undefined;
      const mockRequestFn = vi.fn(
        (options: Record<string, unknown>, callback: (response: NodeJS.EventEmitter & { statusCode: number; statusMessage: string }) => void) => {
          capturedOptions = options;
          const req = new EventEmitter() as NodeJS.EventEmitter & { end: () => void; setTimeout: (ms: number, cb: () => void) => void };
          req.end = () => {
            const resp = new EventEmitter() as NodeJS.EventEmitter & { statusCode: number; statusMessage: string };
            resp.statusCode = 200;
            resp.statusMessage = "OK";
            callback(resp);
            queueMicrotask(() => {
              resp.emit("data", Buffer.from(JSON.stringify({ ok: true })));
              resp.emit("end");
            });
          };
          req.setTimeout = () => {};
          return req;
        }
      ) as unknown as typeof http.request;

      try {
        const server = new RedmineServer({
          address: "https://localhost:3000",
          key: "test-api-key",
          requestFn: mockRequestFn,
          caFile: tmpFile,
        });

        await server.doRequest("/test.json", "GET");
        expect(Buffer.isBuffer(capturedOptions?.ca)).toBe(true);
        expect((capturedOptions?.ca as Buffer).toString()).toBe(fakePem);
        expect(capturedOptions?.rejectUnauthorized).toBe(true);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it("omits ca when caFile not set", async () => {
      let capturedOptions: Record<string, unknown> | undefined;
      const mockRequestFn = vi.fn(
        (options: Record<string, unknown>, callback: (response: NodeJS.EventEmitter & { statusCode: number; statusMessage: string }) => void) => {
          capturedOptions = options;
          const req = new EventEmitter() as NodeJS.EventEmitter & { end: () => void; setTimeout: (ms: number, cb: () => void) => void };
          req.end = () => {
            const resp = new EventEmitter() as NodeJS.EventEmitter & { statusCode: number; statusMessage: string };
            resp.statusCode = 200;
            resp.statusMessage = "OK";
            callback(resp);
            queueMicrotask(() => {
              resp.emit("data", Buffer.from(JSON.stringify({ ok: true })));
              resp.emit("end");
            });
          };
          req.setTimeout = () => {};
          return req;
        }
      ) as unknown as typeof http.request;

      const server = new RedmineServer({
        address: "https://localhost:3000",
        key: "test-api-key",
        requestFn: mockRequestFn,
      });

      await server.doRequest("/test.json", "GET");
      expect(capturedOptions?.ca).toBeUndefined();
      expect(capturedOptions?.rejectUnauthorized).toBe(true);
    });

    it("throws clear error when caFile is unreadable", async () => {
      const mockRequestFn = vi.fn() as unknown as typeof http.request;

      const server = new RedmineServer({
        address: "https://localhost:3000",
        key: "test-api-key",
        requestFn: mockRequestFn,
        caFile: "/nonexistent/path/ca.pem",
      });

      await expect(server.doRequest("/test.json", "GET")).rejects.toThrow(
        'redmyne.caFile: cannot read "/nonexistent/path/ca.pem"'
      );
    });
  });
});
