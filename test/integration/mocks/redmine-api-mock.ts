import { vi } from "vitest";
import { EventEmitter } from "events";
import * as http from "http";

/**
 * Stateful mock for Redmine API that simulates realistic server behavior
 * Tracks created issues, time entries, and supports full CRUD workflows
 */
export interface MockRedmineState {
  issues: Map<number, MockIssue>;
  timeEntries: Map<number, MockTimeEntry>;
  projects: MockProject[];
  nextIssueId: number;
  nextTimeEntryId: number;
}

export interface MockIssue {
  id: number;
  subject: string;
  description?: string;
  project: { id: number; name: string };
  tracker: { id: number; name: string };
  status: { id: number; name: string };
  priority: { id: number; name: string };
  author: { id: number; name: string };
  assigned_to?: { id: number; name: string };
  start_date?: string;
  due_date?: string;
  done_ratio: number;
  estimated_hours?: number;
  spent_hours: number;
  created_on: string;
  updated_on: string;
}

export interface MockTimeEntry {
  id: number;
  issue: { id: number };
  user: { id: number; name: string };
  activity: { id: number; name: string };
  hours: string;
  comments: string;
  spent_on: string;
  created_on: string;
}

export interface MockProject {
  id: number;
  name: string;
  identifier: string;
  description?: string;
}

export function createMockState(): MockRedmineState {
  return {
    issues: new Map(),
    timeEntries: new Map(),
    projects: [
      { id: 1, name: "Project Alpha", identifier: "alpha" },
      { id: 2, name: "Project Beta", identifier: "beta" },
    ],
    nextIssueId: 1000,
    nextTimeEntryId: 100,
  };
}

/**
 * Creates a stateful mock request function for e2e testing
 * Maintains state across requests to simulate real API behavior
 */
export function createStatefulMockRequest(state: MockRedmineState) {
  return vi.fn(
    (
      options: { path?: string; method?: string },
      callback: (
        response: NodeJS.EventEmitter & {
          statusCode: number;
          statusMessage: string;
          headers?: Record<string, string>;
        }
      ) => void
    ) => {
      const request = new EventEmitter() as NodeJS.EventEmitter & {
        end: (data?: Buffer) => void;
        on: (event: string, handler: (...args: unknown[]) => void) => unknown;
      };

      let requestBody = Buffer.from("");

      request.end = function (data?: Buffer) {
        if (data) requestBody = data;

        const path = options.path || "/";
        const method = options.method || "GET";
        const response = new EventEmitter() as NodeJS.EventEmitter & {
          statusCode: number;
          statusMessage: string;
          headers?: Record<string, string>;
        };
        response.statusCode = 200;
        response.statusMessage = "OK";
        response.headers = { "content-type": "application/json" };

        callback(response);

        queueMicrotask(() => {
          const result = handleRequest(state, method, path, requestBody);
          if (result.statusCode !== 200 && result.statusCode !== 201) {
            response.statusCode = result.statusCode;
            response.statusMessage = result.statusMessage || "Error";
          }
          if (result.data !== null) {
            response.emit("data", Buffer.from(JSON.stringify(result.data)));
          }
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
}

interface MockResponse {
  statusCode: number;
  statusMessage?: string;
  data: unknown;
}

function handleRequest(
  state: MockRedmineState,
  method: string,
  path: string,
  body: Buffer
): MockResponse {
  // Parse body for POST/PUT
  let bodyData: Record<string, unknown> = {};
  if (body.length > 0) {
    try {
      bodyData = JSON.parse(body.toString("utf8"));
    } catch {
      return { statusCode: 400, statusMessage: "Bad Request", data: { errors: ["Invalid JSON"] } };
    }
  }

  // Route handling
  // GET /projects.json
  if (method === "GET" && path.includes("/projects.json")) {
    return {
      statusCode: 200,
      data: { projects: state.projects, total_count: state.projects.length },
    };
  }

  // GET /issues.json (list)
  if (method === "GET" && path.match(/\/issues\.json\?/)) {
    const issues = Array.from(state.issues.values());
    return {
      statusCode: 200,
      data: { issues, total_count: issues.length },
    };
  }

  // GET /issues/:id.json
  const issueIdMatch = path.match(/\/issues\/(\d+)\.json/);
  if (issueIdMatch && method === "GET") {
    const id = parseInt(issueIdMatch[1], 10);
    const issue = state.issues.get(id);
    if (!issue) {
      return { statusCode: 404, statusMessage: "Not Found", data: null };
    }
    return { statusCode: 200, data: { issue } };
  }

  // POST /issues.json (create)
  if (method === "POST" && path.includes("/issues.json")) {
    const issueData = bodyData.issue as Record<string, unknown>;
    if (!issueData?.subject) {
      return { statusCode: 422, data: { errors: ["Subject cannot be blank"] } };
    }

    const newIssue: MockIssue = {
      id: state.nextIssueId++,
      subject: issueData.subject as string,
      description: issueData.description as string | undefined,
      project: { id: (issueData.project_id as number) || 1, name: "Project Alpha" },
      tracker: { id: (issueData.tracker_id as number) || 1, name: "Task" },
      status: { id: 1, name: "New" },
      priority: { id: (issueData.priority_id as number) || 2, name: "Normal" },
      author: { id: 1, name: "Test User" },
      done_ratio: 0,
      spent_hours: 0,
      estimated_hours: issueData.estimated_hours as number | undefined,
      start_date: issueData.start_date as string | undefined,
      due_date: issueData.due_date as string | undefined,
      created_on: new Date().toISOString(),
      updated_on: new Date().toISOString(),
    };

    state.issues.set(newIssue.id, newIssue);
    return { statusCode: 201, data: { issue: newIssue } };
  }

  // PUT /issues/:id.json (update)
  if (issueIdMatch && method === "PUT") {
    const id = parseInt(issueIdMatch[1], 10);
    const issue = state.issues.get(id);
    if (!issue) {
      return { statusCode: 404, statusMessage: "Not Found", data: null };
    }

    const updates = bodyData.issue as Record<string, unknown>;
    if (updates.status_id) {
      const statusId = updates.status_id as number;
      issue.status = {
        id: statusId,
        name: statusId === 2 ? "In Progress" : statusId === 5 ? "Closed" : "New",
      };
    }
    if (updates.done_ratio !== undefined) {
      issue.done_ratio = updates.done_ratio as number;
    }
    if (updates.start_date !== undefined) {
      issue.start_date = updates.start_date as string;
    }
    if (updates.due_date !== undefined) {
      issue.due_date = updates.due_date as string;
    }
    issue.updated_on = new Date().toISOString();

    return { statusCode: 200, data: null }; // PUT returns 204 in real API
  }

  // POST /time_entries.json
  if (method === "POST" && path.includes("/time_entries.json")) {
    const entryData = bodyData.time_entry as Record<string, unknown>;
    const issueId = entryData.issue_id as number;
    const issue = state.issues.get(issueId);

    const newEntry: MockTimeEntry = {
      id: state.nextTimeEntryId++,
      issue: { id: issueId },
      user: { id: 1, name: "Test User" },
      activity: { id: (entryData.activity_id as number) || 9, name: "Development" },
      hours: entryData.hours as string,
      comments: (entryData.comments as string) || "",
      spent_on: (entryData.spent_on as string) || new Date().toISOString().split("T")[0],
      created_on: new Date().toISOString(),
    };

    state.timeEntries.set(newEntry.id, newEntry);

    // Update issue spent_hours
    if (issue) {
      issue.spent_hours += parseFloat(newEntry.hours);
    }

    return { statusCode: 201, data: { time_entry: newEntry } };
  }

  // GET /time_entries.json
  if (method === "GET" && path.includes("/time_entries.json")) {
    const entries = Array.from(state.timeEntries.values());
    return {
      statusCode: 200,
      data: { time_entries: entries },
    };
  }

  // PUT /time_entries/:id.json
  const timeEntryIdMatch = path.match(/\/time_entries\/(\d+)\.json/);
  if (timeEntryIdMatch && method === "PUT") {
    const id = parseInt(timeEntryIdMatch[1], 10);
    const entry = state.timeEntries.get(id);
    if (!entry) {
      return { statusCode: 404, statusMessage: "Not Found", data: null };
    }

    const updates = bodyData.time_entry as Record<string, unknown>;
    if (updates.hours) entry.hours = updates.hours as string;
    if (updates.comments) entry.comments = updates.comments as string;

    return { statusCode: 200, data: null };
  }

  // DELETE /time_entries/:id.json
  if (timeEntryIdMatch && method === "DELETE") {
    const id = parseInt(timeEntryIdMatch[1], 10);
    if (!state.timeEntries.has(id)) {
      return { statusCode: 404, statusMessage: "Not Found", data: null };
    }
    state.timeEntries.delete(id);
    return { statusCode: 200, data: null };
  }

  // GET /issue_statuses.json
  if (method === "GET" && path.includes("/issue_statuses.json")) {
    return {
      statusCode: 200,
      data: {
        issue_statuses: [
          { id: 1, name: "New" },
          { id: 2, name: "In Progress" },
          { id: 3, name: "Resolved" },
          { id: 4, name: "Feedback" },
          { id: 5, name: "Closed" },
        ],
      },
    };
  }

  // GET /enumerations/time_entry_activities.json
  if (method === "GET" && path.includes("/time_entry_activities.json")) {
    return {
      statusCode: 200,
      data: {
        time_entry_activities: [
          { id: 8, name: "Design" },
          { id: 9, name: "Development" },
          { id: 10, name: "Testing" },
        ],
      },
    };
  }

  // GET /trackers.json
  if (method === "GET" && path.includes("/trackers.json")) {
    return {
      statusCode: 200,
      data: {
        trackers: [
          { id: 1, name: "Bug" },
          { id: 2, name: "Feature" },
          { id: 3, name: "Task" },
        ],
      },
    };
  }

  // GET /enumerations/issue_priorities.json
  if (method === "GET" && path.includes("/issue_priorities.json")) {
    return {
      statusCode: 200,
      data: {
        issue_priorities: [
          { id: 1, name: "Low" },
          { id: 2, name: "Normal" },
          { id: 3, name: "High" },
          { id: 4, name: "Urgent" },
        ],
      },
    };
  }

  // GET /users/current.json
  if (method === "GET" && path.includes("/users/current.json")) {
    return {
      statusCode: 200,
      data: {
        user: {
          id: 1,
          login: "testuser",
          firstname: "Test",
          lastname: "User",
          mail: "test@example.com",
          created_on: "2020-01-01T00:00:00Z",
        },
      },
    };
  }

  // Default: 404
  return { statusCode: 404, statusMessage: "Not Found", data: null };
}
