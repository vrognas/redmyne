import { describe, it, expect, beforeEach, vi } from "vitest";
import { RedmineServer } from "../../../src/redmine/redmine-server";
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
      address: "http://localhost:3000",
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

  it("should fetch open issues for project", async () => {
    const result = await server.getOpenIssuesForProject(1, true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].id).toBe(123);
  });

  it("should fetch open issues for project without subprojects", async () => {
    const result = await server.getOpenIssuesForProject(1, false);
    expect(result.issues).toHaveLength(1);
  });

  it("should compare servers correctly", () => {
    const server2 = new RedmineServer({
      address: "http://localhost:3000",
      key: "test-api-key",
    });
    expect(server.compare(server2)).toBe(true);

    const server3 = new RedmineServer({
      address: "http://localhost:3001",
      key: "test-api-key",
    });
    expect(server.compare(server3)).toBe(false);
  });
});
