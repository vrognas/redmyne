import * as http from "http";
import * as https from "https";
import { RedmineProject } from "./redmine-project";
import {
  IssueStatus,
  Membership,
  QuickUpdate,
  QuickUpdateResult,
} from "../controllers/domain";
import { TimeEntryActivity } from "./models/time-entry-activity";
import { Project } from "./models/project";
import { TimeEntry } from "./models/time-entry";
import { Issue } from "./models/issue";
import { IssueStatus as RedmineIssueStatus } from "./models/issue-status";
import { Membership as RedmineMembership } from "./models/membership";

type HttpMethods = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

const REDMINE_API_KEY_HEADER_NAME = "X-Redmine-API-Key";

export interface RedmineServerConnectionOptions {
  /**
   * @example https://example.com
   * @example http://example.com:8080
   * @example https://example.com:8443/redmine
   * @example http://example.com/redmine
   */
  address: string;
  /**
   * @example 7215ee9c7d9dc229d2921a40e899ec5f
   */
  key: string;
  /**
   * @default false
   */
  rejectUnauthorized?: boolean;
  /**
   * @example { "Authorization": "Basic YTph" }
   */
  additionalHeaders?: { [key: string]: string };
}

interface RedmineServerOptions extends RedmineServerConnectionOptions {
  url: URL;
}

export class RedmineOptionsError extends Error {
  name = "RedmineOptionsError";
}

export class RedmineServer {
  options: RedmineServerOptions = {} as RedmineServerOptions;

  private timeEntryActivities: TimeEntryActivity[] | null = null;

  get request() {
    return this.options.url.protocol === "https:"
      ? https.request
      : http.request;
  }

  private validateOptions(options: RedmineServerConnectionOptions): void {
    if (!options.address) {
      throw new RedmineOptionsError("Address cannot be empty!");
    }
    if (!options.key) {
      throw new RedmineOptionsError("Key cannot be empty!");
    }
    let url: URL;
    try {
      url = new URL(options.address);
    } catch {
      throw new RedmineOptionsError(`Invalid URL: ${options.address}`);
    }
    if (!["https:", "http:"].includes(url.protocol)) {
      throw new RedmineOptionsError("Protocol must be http/https");
    }
  }

  private setOptions(options: RedmineServerConnectionOptions) {
    this.options = {
      ...options,
      url: new URL(options.address),
    };
    if (
      this.options.additionalHeaders === null ||
      this.options.additionalHeaders === undefined
    ) {
      this.options.additionalHeaders = {};
    }
  }

  constructor(options: RedmineServerConnectionOptions) {
    this.validateOptions(options);
    this.setOptions(options);
  }

  /**
   * Hook called before successful response resolution.
   * Override in subclasses to capture response metadata for logging.
   */
  protected onResponseSuccess(
    _statusCode: number | undefined,
    _statusMessage: string | undefined,
    _path: string,
    _method: HttpMethods,
    _requestBody?: Buffer,
    _responseBody?: Buffer,
    _contentType?: string
  ): void {
    // No-op by default, child classes can override
  }

  /**
   * Hook called before error rejection.
   * Override in subclasses to capture error metadata for logging.
   */
  protected onResponseError(
    _statusCode: number | undefined,
    _statusMessage: string | undefined,
    _error: Error,
    _path: string,
    _method: HttpMethods,
    _requestBody?: Buffer,
    _responseBody?: Buffer,
    _contentType?: string
  ): void {
    // No-op by default, child classes can override
  }

  doRequest<T>(path: string, method: HttpMethods, data?: Buffer): Promise<T> {
    const { url, key, additionalHeaders, rejectUnauthorized } = this.options;
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port ? parseInt(url.port, 10) : undefined,
      headers: {
        [REDMINE_API_KEY_HEADER_NAME]: key,
        ...additionalHeaders,
      },
      rejectUnauthorized: rejectUnauthorized,
      path: `${url.pathname}${path}`,
      method,
    };
    if (data) {
      const headers = options.headers as http.OutgoingHttpHeaders;
      headers["Content-Length"] = data.length;
      headers["Content-Type"] = "application/json";
    }

    return new Promise((resolve, reject) => {
      let incomingBuffer = Buffer.from("");
      const handleData = (_: http.IncomingMessage) => (incoming: Buffer) => {
        incomingBuffer = Buffer.concat([incomingBuffer, incoming]);
      };

      const handleEnd = (clientResponse: http.IncomingMessage) => () => {
        const { statusCode, statusMessage } = clientResponse;
        const contentType = clientResponse.headers?.["content-type"];

        if (statusCode === 401) {
          const error = new Error(
            "Server returned 401 (perhaps your API Key is not valid, or your server has additional authentication methods?)"
          );
          this.onResponseError(statusCode, statusMessage, error, path, method, data, incomingBuffer, contentType);
          reject(error);
          return;
        }
        if (statusCode === 403) {
          const error = new Error(
            "Server returned 403 (perhaps you haven't got permissions?)"
          );
          this.onResponseError(statusCode, statusMessage, error, path, method, data, incomingBuffer, contentType);
          reject(error);
          return;
        }
        if (statusCode === 404) {
          const error = new Error("Resource doesn't exist");
          this.onResponseError(statusCode, statusMessage, error, path, method, data, incomingBuffer, contentType);
          reject(error);
          return;
        }

        // TODO: Other errors handle
        if (statusCode && statusCode >= 400) {
          const error = new Error(`Server returned ${statusMessage}`);
          this.onResponseError(statusCode, statusMessage, error, path, method, data, incomingBuffer, contentType);
          reject(error);
          return;
        }

        if (incomingBuffer.length > 0) {
          try {
            const object = JSON.parse(incomingBuffer.toString("utf8"));
            this.onResponseSuccess(statusCode, statusMessage, path, method, data, incomingBuffer, contentType);
            resolve(object);
          } catch (_e) {
            const error = new Error("Couldn't parse Redmine response as JSON...");
            this.onResponseError(statusCode, statusMessage, error, path, method, data, incomingBuffer, contentType);
            reject(error);
          }
          return;
        }

        // Using `doRequest` on the endpoints that return 204 should type as void/null
        this.onResponseSuccess(statusCode, statusMessage, path, method, data, incomingBuffer, contentType);
        resolve(null as unknown as T);
      };

      const clientRequest = this.request(options, (incoming) => {
        incoming.on("data", handleData(incoming));
        incoming.on("end", handleEnd(incoming));
      });

      const handleError = (error: Error) => {
        const wrappedError = new Error(
          `NodeJS Request Error (${error.name}): ${error.message}`
        );
        this.onResponseError(undefined, undefined, wrappedError, path, method, data);
        reject(wrappedError);
      };

      clientRequest.on("error", handleError);

      clientRequest.end(data);
    });
  }

  async getProjects(): Promise<RedmineProject[]> {
    const req = async (
      offset = 0,
      limit = 50,
      count: number | null = null,
      accumulator: RedmineProject[] = []
    ): Promise<RedmineProject[]> => {
      if (count && count <= offset) {
        return accumulator;
      }

      const response = await this.doRequest<{
        projects: Project[];
        total_count: number;
      }>(`/projects.json?limit=${limit}&offset=${offset}`, "GET");

      const [totalCount, result]: [number, RedmineProject[]] = [
        response.total_count,
        response.projects.map(
          (proj) =>
            new RedmineProject({
              ...proj,
            })
        ),
      ];

      return req(offset + limit, limit, totalCount, accumulator.concat(result));
    };

    return req();
  }

  async getTimeEntryActivities(): Promise<{
    time_entry_activities: TimeEntryActivity[];
  }> {
    if (this.timeEntryActivities) {
      return {
        time_entry_activities: this.timeEntryActivities,
      };
    }
    const response = await this.doRequest<{
      time_entry_activities: TimeEntryActivity[];
    }>(`/enumerations/time_entry_activities.json`, "GET");

    if (response) {
      this.timeEntryActivities = response.time_entry_activities;
    }

    return response;
  }

  addTimeEntry(
    issueId: number,
    activityId: number,
    hours: string,
    message: string
  ): Promise<unknown> {
    return this.doRequest<{ time_entry: TimeEntry }>(
      `/time_entries.json`,
      "POST",
      Buffer.from(
        JSON.stringify({
          time_entry: <TimeEntry>{
            issue_id: issueId,
            activity_id: activityId,
            hours,
            comments: message,
          },
        })
      )
    );
  }

  /**
   * Returns promise, that resolves to an issue
   * @param issueId ID of issue
   */
  getIssueById(issueId: number): Promise<{ issue: Issue }> {
    return this.doRequest(`/issues/${issueId}.json`, "GET");
  }

  /**
   * Returns promise, that resolves, when issue status is set
   */
  setIssueStatus(issue: Issue, statusId: number): Promise<unknown> {
    return this.doRequest<{ issue: Issue }>(
      `/issues/${issue.id}.json`,
      "PUT",
      Buffer.from(
        JSON.stringify({
          issue: {
            status_id: statusId,
          },
        }),
        "utf8"
      )
    );
  }

  issueStatuses: { issue_statuses: RedmineIssueStatus[] } | null = null;

  /**
   * Returns promise, that resolves to list of issue statuses in provided redmine server
   */
  async getIssueStatuses(): Promise<{ issue_statuses: RedmineIssueStatus[] }> {
    if (this.issueStatuses === null || this.issueStatuses === undefined) {
      const obj = await this.doRequest<{ issue_statuses: RedmineIssueStatus[] }>(
        "/issue_statuses.json",
        "GET"
      );

      if (obj) {
        // Shouldn't change much; cache it.
        this.issueStatuses = obj;
      }

      return obj;
    } else {
      return this.issueStatuses;
    }
  }

  async getIssueStatusesTyped(): Promise<IssueStatus[]> {
    const statuses = await this.getIssueStatuses();
    return statuses.issue_statuses.map((s) => new IssueStatus(s.id, s.name));
  }
  async getMemberships(projectId: number): Promise<Membership[]> {
    const membershipsResponse = await this.doRequest<{
      memberships: RedmineMembership[];
    }>(`/projects/${projectId}/memberships.json`, "GET");

    return membershipsResponse.memberships.map((m) =>
      "user" in m
        ? new Membership(m.user.id, m.user.name)
        : new Membership(m.group.id, m.group.name, false)
    );
  }
  async applyQuickUpdate(quickUpdate: QuickUpdate): Promise<QuickUpdateResult> {
    await this.doRequest<void>(
      `/issues/${quickUpdate.issueId}.json`,
      "PUT",
      Buffer.from(
        JSON.stringify({
          issue: {
            status_id: quickUpdate.status.statusId,
            assigned_to_id: quickUpdate.assignee.id,
            notes: quickUpdate.message,
          },
        }),
        "utf8"
      )
    );
    const issueRequest = await this.getIssueById(quickUpdate.issueId);
    const issue = issueRequest.issue;
    const updateResult = new QuickUpdateResult();
    if (issue.assigned_to.id !== quickUpdate.assignee.id) {
      updateResult.addDifference("Couldn't assign user");
    }
    if (issue.status.id !== quickUpdate.status.statusId) {
      updateResult.addDifference("Couldn't update status");
    }
    return updateResult;
  }

  /**
   * Returns promise, that resolves to list of issues assigned to api key owner
   */
  getIssuesAssignedToMe(): Promise<{ issues: Issue[] }> {
    return this.doRequest<{ issues: Issue[] }>(
      "/issues.json?status_id=open&assigned_to_id=me",
      "GET"
    );
  }

  /**
   * Returns promise, that resolves to list of open issues for project
   */
  getOpenIssuesForProject(
    project_id: number | string,
    include_subproject = true
  ): Promise<{ issues: Issue[] }> {
    if (include_subproject) {
      return this.doRequest<{ issues: Issue[] }>(
        `/issues.json?status_id=open&project_id=${project_id}&subproject_id=!*`,
        "GET"
      );
    } else {
      return this.doRequest<{ issues: Issue[] }>(
        `/issues.json?status_id=open&project_id=${project_id}`,
        "GET"
      );
    }
  }

  compare(other: RedmineServer) {
    return (
      this.options.address === other.options.address &&
      this.options.key === other.options.key &&
      this.options.rejectUnauthorized === other.options.rejectUnauthorized &&
      JSON.stringify(this.options.additionalHeaders) ===
        JSON.stringify(other.options.additionalHeaders)
    );
  }
}
