import * as http from "http";
import * as https from "https";
import { RedmineProject } from "./redmine-project";
import {
  IssueStatus,
  Membership,
  QuickUpdate,
  QuickUpdateResult,
} from "../controllers/domain";
import { TimeEntryActivity } from "./models/common";
import { Project } from "./models/project";
import { TimeEntry } from "./models/time-entry";
import { Issue } from "./models/issue";
import { Version } from "./models/version";
import { IssueStatus as RedmineIssueStatus } from "./models/common";
import { Membership as RedmineMembership } from "./models/membership";

type HttpMethods = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

const REDMINE_API_KEY_HEADER_NAME = "X-Redmine-API-Key";
const REQUEST_TIMEOUT_MS = 30000;

export interface RedmineServerConnectionOptions {
  /**
   * HTTPS URL to Redmine server. HTTP is not allowed.
   * @example https://example.com
   * @example https://example.com:8443/redmine
   */
  address: string;
  /**
   * @example 7215ee9c7d9dc229d2921a40e899ec5f
   */
  key: string;
  /**
   * @example { "Authorization": "Basic YTph" }
   */
  additionalHeaders?: { [key: string]: string };
  /**
   * Optional custom request function for testing
   * @internal
   */
  requestFn?: typeof http.request;
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
  private cachedProjects: RedmineProject[] | null = null;

  get request() {
    if (this.options.requestFn) {
      return this.options.requestFn;
    }
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
    if (url.protocol !== "https:") {
      throw new RedmineOptionsError(
        "HTTPS required. Redmine URL must start with https://"
      );
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
    _contentType?: string,
    _requestId?: unknown
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
    _contentType?: string,
    _requestId?: unknown
  ): void {
    // No-op by default, child classes can override
  }

  doRequest<T>(path: string, method: HttpMethods, data?: Buffer): Promise<T> {
    const { url, key, additionalHeaders } = this.options;
    const requestId = Symbol("request"); // Unique ID for hook correlation
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port ? parseInt(url.port, 10) : undefined,
      headers: {
        [REDMINE_API_KEY_HEADER_NAME]: key,
        ...additionalHeaders,
      },
      rejectUnauthorized: true, // Always validate TLS certificates
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
          this.onResponseError(statusCode, statusMessage, error, path, method, data, incomingBuffer, contentType, requestId);
          reject(error);
          return;
        }
        if (statusCode === 403) {
          const error = new Error(
            "Server returned 403 (perhaps you haven't got permissions?)"
          );
          this.onResponseError(statusCode, statusMessage, error, path, method, data, incomingBuffer, contentType, requestId);
          reject(error);
          return;
        }
        if (statusCode === 404) {
          const error = new Error("Resource doesn't exist");
          this.onResponseError(statusCode, statusMessage, error, path, method, data, incomingBuffer, contentType, requestId);
          reject(error);
          return;
        }

        // Handle remaining 4xx client errors
        if (statusCode && statusCode >= 400 && statusCode < 500) {
          let message: string;
          if (statusCode === 400) {
            message = "Bad request (400)";
          } else if (statusCode === 422) {
            // Try to extract Redmine's error details from response body
            try {
              const body = JSON.parse(incomingBuffer.toString("utf8"));
              if (body.errors && Array.isArray(body.errors) && body.errors.length > 0) {
                message = `Validation failed: ${body.errors.join(", ")}`;
              } else {
                message = "Validation failed (422)";
              }
            } catch {
              message = "Validation failed (422)";
            }
          } else {
            message = `Client error (${statusCode} ${statusMessage})`;
          }
          const error = new Error(message);
          this.onResponseError(statusCode, statusMessage, error, path, method, data, incomingBuffer, contentType, requestId);
          reject(error);
          return;
        }

        // Handle 5xx server errors
        if (statusCode && statusCode >= 500) {
          const error = new Error(`Server error (${statusCode} ${statusMessage})`);
          this.onResponseError(statusCode, statusMessage, error, path, method, data, incomingBuffer, contentType, requestId);
          reject(error);
          return;
        }

        if (incomingBuffer.length > 0) {
          try {
            const object = JSON.parse(incomingBuffer.toString("utf8"));
            this.onResponseSuccess(statusCode, statusMessage, path, method, data, incomingBuffer, contentType, requestId);
            resolve(object);
          } catch (_e) {
            const error = new Error("Couldn't parse Redmine response as JSON...");
            this.onResponseError(statusCode, statusMessage, error, path, method, data, incomingBuffer, contentType, requestId);
            reject(error);
          }
          return;
        }

        // Using `doRequest` on the endpoints that return 204 should type as void/null
        this.onResponseSuccess(statusCode, statusMessage, path, method, data, incomingBuffer, contentType, requestId);
        resolve(null as unknown as T);
      };

      const clientRequest = this.request(options, (incoming) => {
        incoming.on("data", handleData(incoming));
        incoming.on("end", handleEnd(incoming));
      });

      const handleError = (error: Error & { code?: string }) => {
        // Map common network error codes to user-friendly messages
        let message: string;
        switch (error.code) {
          case "ECONNREFUSED":
            message = "Connection refused - is the server running?";
            break;
          case "ENOTFOUND":
            message = "Server not found - check the URL";
            break;
          case "ETIMEDOUT":
            message = "Connection timed out";
            break;
          case "ECONNRESET":
            message = "Connection reset by server";
            break;
          case "CERT_HAS_EXPIRED":
          case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
          case "DEPTH_ZERO_SELF_SIGNED_CERT":
            message = "SSL certificate error - check rejectUnauthorized setting";
            break;
          default:
            message = `Network error: ${error.message}`;
        }
        const wrappedError = new Error(message);
        this.onResponseError(undefined, undefined, wrappedError, path, method, data, undefined, undefined, requestId);
        reject(wrappedError);
      };

      clientRequest.on("error", handleError);

      // Timeout to prevent indefinite hangs
      if (typeof clientRequest.setTimeout === "function") {
        clientRequest.setTimeout(REQUEST_TIMEOUT_MS, () => {
          clientRequest.destroy();
          const error = new Error(`Request timeout after ${REQUEST_TIMEOUT_MS / 1000} seconds`);
          this.onResponseError(undefined, undefined, error, path, method, data, undefined, undefined, requestId);
          reject(error);
        });
      }

      clientRequest.end(data);
    });
  }

  /**
   * Generic pagination helper for Redmine API endpoints
   * Fetches first page to get total_count, then remaining pages in parallel
   */
  private async paginate<TRaw, TResult = TRaw>(
    endpoint: string,
    responseKey: string,
    transform?: (items: TRaw[]) => TResult[]
  ): Promise<TResult[]> {
    const limit = 100; // Redmine max is 100

    // First request to get total_count
    const firstUrl = `${endpoint}${endpoint.includes("?") ? "&" : "?"}limit=${limit}&offset=0`;
    const firstResponse = await this.doRequest<Record<string, unknown> & { total_count: number }>(
      firstUrl,
      "GET"
    );

    const totalCount = firstResponse?.total_count || 0;
    const rawFirstPage = (firstResponse?.[responseKey] || []) as TRaw[];
    const firstPage = transform ? transform(rawFirstPage) : (rawFirstPage as unknown as TResult[]);

    // If all items fit in first page, we're done
    if (totalCount <= limit) {
      return firstPage;
    }

    // Calculate remaining offsets and fetch in parallel
    const remainingOffsets: number[] = [];
    for (let offset = limit; offset < totalCount; offset += limit) {
      remainingOffsets.push(offset);
    }

    const remainingPages = await Promise.all(
      remainingOffsets.map(async (offset) => {
        const pageUrl = `${endpoint}${endpoint.includes("?") ? "&" : "?"}limit=${limit}&offset=${offset}`;
        const response = await this.doRequest<Record<string, unknown>>(pageUrl, "GET");
        const rawItems = (response?.[responseKey] || []) as TRaw[];
        return transform ? transform(rawItems) : (rawItems as unknown as TResult[]);
      })
    );

    // Combine: first page + all remaining pages (flattened)
    return firstPage.concat(...remainingPages);
  }

  /**
   * Encode data as JSON buffer for POST/PUT requests
   */
  private encodeJson<T>(data: T): Buffer {
    return Buffer.from(JSON.stringify(data), "utf8");
  }

  /**
   * Deduplicate items by ID, preserving order
   */
  private deduplicateById<T extends { id: number }>(items: T[]): T[] {
    const seen = new Set<number>();
    return items.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  async getProjects(): Promise<RedmineProject[]> {
    if (this.cachedProjects) {
      return this.cachedProjects;
    }

    this.cachedProjects = await this.paginate<Project, RedmineProject>(
      "/projects.json",
      "projects",
      (projects) => projects.map((proj) => new RedmineProject({ ...proj }))
    );
    return this.cachedProjects;
  }

  /**
   * Clear cached projects (call on refresh)
   */
  clearProjectsCache(): void {
    this.cachedProjects = null;
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

    if (response && response.time_entry_activities) {
      this.timeEntryActivities = response.time_entry_activities;
    }

    return {
      time_entry_activities: response?.time_entry_activities || [],
    };
  }

  /**
   * Get versions (milestones) for a project
   * Includes shared versions from parent/related projects
   */
  async getProjectVersions(projectId: number | string): Promise<Version[]> {
    const response = await this.doRequest<{ versions: Version[] }>(
      `/projects/${projectId}/versions.json`,
      "GET"
    );
    return response?.versions || [];
  }

  /**
   * Get versions for multiple projects (batched)
   */
  async getVersionsForProjects(projectIds: (number | string)[]): Promise<Map<number | string, Version[]>> {
    const result = new Map<number | string, Version[]>();
    // Fetch in parallel with concurrency limit
    const batchSize = 5;
    for (let i = 0; i < projectIds.length; i += batchSize) {
      const batch = projectIds.slice(i, i + batchSize);
      const promises = batch.map(async (id) => {
        try {
          const versions = await this.getProjectVersions(id);
          result.set(id, versions);
        } catch {
          result.set(id, []);
        }
      });
      await Promise.all(promises);
    }
    return result;
  }

  /**
   * Check if a project has time_tracking module enabled
   */
  async isTimeTrackingEnabled(projectId: number | string): Promise<boolean> {
    try {
      const response = await this.doRequest<{
        project: {
          enabled_modules?: { name: string }[];
        };
      }>(`/projects/${projectId}.json?include=enabled_modules`, "GET");

      const modules = response?.project?.enabled_modules || [];
      const hasTimeTracking = modules.some(m => m.name === "time_tracking");
      return hasTimeTracking;
    } catch {
      // Assume enabled if we can't check (fail open)
      return true;
    }
  }

  /**
   * Get activities for a specific project (Redmine 3.4.0+)
   * Projects can restrict which activities are available
   * Falls back to global activities if project has no restrictions
   */
  async getProjectTimeEntryActivities(
    projectId: number | string
  ): Promise<TimeEntryActivity[]> {
    try {
      const response = await this.doRequest<{
        project: {
          time_entry_activities?: TimeEntryActivity[];
        };
      }>(`/projects/${projectId}.json?include=time_entry_activities`, "GET");

      const projectActivities = response?.project?.time_entry_activities;
      if (projectActivities && projectActivities.length > 0) {
        return projectActivities;
      }
    } catch {
      // Project-specific activities not available, fall through to global
    }

    // Fallback to global activities
    const global = await this.getTimeEntryActivities();
    return global.time_entry_activities;
  }

  async addTimeEntry(
    issueId: number,
    activityId: number,
    hours: string,
    message: string,
    spentOn?: string // YYYY-MM-DD format, defaults to today
  ): Promise<{ time_entry: TimeEntry }> {
    const entry: Record<string, unknown> = {
      issue_id: issueId,
      activity_id: activityId,
      hours,
      comments: message,
    };
    if (spentOn) {
      entry.spent_on = spentOn;
    }
    const result = await this.doRequest<{ time_entry: TimeEntry }>(
      `/time_entries.json`,
      "POST",
      this.encodeJson({ time_entry: entry })
    );

    // Auto-update %done based on spent/estimated hours
    await this.autoUpdateDoneRatio(issueId);

    return result;
  }

  /**
   * Auto-update done_ratio based on spent/estimated hours
   * Rules: 0% if no estimate, cap at 99% (100% must be manual),
   * skip if already 100%, skip if over budget (spent > estimated),
   * skip if issue not opted-in
   */
  private async autoUpdateDoneRatio(issueId: number): Promise<void> {
    try {
      // Check if auto-update is enabled globally
      const config = await import("vscode").then(vscode =>
        vscode.workspace.getConfiguration("redmine")
      );
      if (!config.get<boolean>("autoUpdateDoneRatio", true)) return;

      // Check if this specific issue is opted-in
      const { autoUpdateTracker } = await import("../utilities/auto-update-tracker");
      if (!autoUpdateTracker.isEnabled(issueId)) return;

      const { issue } = await this.getIssueById(issueId);
      const estimated = issue.estimated_hours ?? 0;
      const spent = issue.spent_hours ?? 0;
      const current = issue.done_ratio ?? 0;

      // Skip if already 100% (manual completion)
      if (current === 100) return;

      // Skip if no estimate
      if (estimated <= 0) return;

      // Skip if over budget (spent > estimated) - user must manually manage
      if (spent > estimated) return;

      // Calculate new %done, cap at 99%
      const calculated = Math.round((spent / estimated) * 100);
      const newRatio = Math.min(calculated, 99);

      // Only update if different
      if (newRatio !== current) {
        await this.updateDoneRatio(issueId, newRatio);
      }
    } catch {
      // Silent fail - don't break time entry if auto-update fails
    }
  }

  /**
   * Returns promise that resolves to time entries for current user
   * @param params Query parameters { from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' }
   */
  async getTimeEntries(params?: {
    from?: string;
    to?: string;
    allUsers?: boolean;
  }): Promise<{ time_entries: TimeEntry[] }> {
    const queryParams = new URLSearchParams({ include: "issue" });

    // Filter by current user unless allUsers is set
    if (!params?.allUsers) {
      queryParams.set("user_id", "me");
    }

    if (params?.from) {
      queryParams.set("from", params.from);
    }
    if (params?.to) {
      queryParams.set("to", params.to);
    }

    return this.doRequest<{ time_entries: TimeEntry[] }>(
      `/time_entries.json?${queryParams.toString()}`,
      "GET"
    );
  }

  /**
   * Returns all time entries for a project (all users, all time)
   * Used for ad-hoc budget contribution calculation
   * @param projectId Project ID or identifier
   */
  async getProjectTimeEntries(projectId: number | string): Promise<TimeEntry[]> {
    return this.paginate<TimeEntry>(
      `/time_entries.json?project_id=${projectId}`,
      "time_entries"
    );
  }

  /**
   * Update an existing time entry
   * @param id Time entry ID
   * @param updates Fields to update (hours, comments, activity_id, spent_on, issue_id)
   */
  async updateTimeEntry(
    id: number,
    updates: {
      hours?: string;
      comments?: string;
      activity_id?: number;
      spent_on?: string;
      issue_id?: number;
    }
  ): Promise<void> {
    await this.doRequest(
      `/time_entries/${id}.json`,
      "PUT",
      this.encodeJson({ time_entry: updates })
    );
  }

  /**
   * Delete a time entry
   * @param id Time entry ID
   */
  async deleteTimeEntry(id: number): Promise<void> {
    await this.doRequest(`/time_entries/${id}.json`, "DELETE");
  }

  /**
   * Returns promise, that resolves to an issue
   * @param issueId ID of issue
   */
  getIssueById(issueId: number): Promise<{ issue: Issue }> {
    return this.doRequest(`/issues/${issueId}.json`, "GET");
  }

  /**
   * Fetch issue with full journal history (updates/comments)
   */
  getIssueWithJournals(issueId: number): Promise<{ issue: Issue }> {
    return this.doRequest(`/issues/${issueId}.json?include=journals`, "GET");
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

  /**
   * Update issue start_date and/or due_date
   */
  updateIssueDates(
    issueId: number,
    startDate: string | null,
    dueDate: string | null
  ): Promise<unknown> {
    const issueUpdate: { start_date?: string; due_date?: string } = {};
    if (startDate !== null) {
      issueUpdate.start_date = startDate;
    }
    if (dueDate !== null) {
      issueUpdate.due_date = dueDate;
    }
    return this.doRequest(
      `/issues/${issueId}.json`,
      "PUT",
      this.encodeJson({ issue: issueUpdate })
    );
  }

  /**
   * Update done_ratio (% Done) for an issue
   */
  updateDoneRatio(issueId: number, doneRatio: number): Promise<unknown> {
    return this.doRequest(
      `/issues/${issueId}.json`,
      "PUT",
      this.encodeJson({ issue: { done_ratio: doneRatio } })
    );
  }

  /**
   * Create a relation between two issues
   * @param relationType One of: relates, duplicates, blocks, precedes, follows, copied_to
   * @returns The created relation with its ID
   */
  async createRelation(
    issueId: number,
    targetIssueId: number,
    relationType:
      | "relates"
      | "duplicates"
      | "blocks"
      | "precedes"
      | "follows"
      | "copied_to"
  ): Promise<{ relation: { id: number; issue_id: number; issue_to_id: number; relation_type: string } }> {
    const response = await this.doRequest<{
      relation: { id: number; issue_id: number; issue_to_id: number; relation_type: string };
    }>(
      `/issues/${issueId}/relations.json`,
      "POST",
      Buffer.from(
        JSON.stringify({
          relation: {
            issue_to_id: targetIssueId,
            relation_type: relationType,
          },
        }),
        "utf8"
      )
    );
    return response!;
  }

  /**
   * Delete a relation by ID
   */
  deleteRelation(relationId: number): Promise<unknown> {
    return this.doRequest(`/relations/${relationId}.json`, "DELETE");
  }

  /**
   * Get available trackers
   */
  async getTrackers(): Promise<{ id: number; name: string }[]> {
    const response = await this.doRequest<{
      trackers: { id: number; name: string }[];
    }>("/trackers.json", "GET");
    return response?.trackers || [];
  }

  /**
   * Get available issue priorities
   */
  async getPriorities(): Promise<{ id: number; name: string }[]> {
    const response = await this.doRequest<{
      issue_priorities: { id: number; name: string }[];
    }>("/enumerations/issue_priorities.json", "GET");
    return response?.issue_priorities || [];
  }

  /**
   * Get current user info including custom fields (e.g., FTE)
   */
  async getCurrentUser(): Promise<{
    id: number;
    login: string;
    firstname: string;
    lastname: string;
    mail: string;
    created_on: string;
    last_login_on?: string;
    custom_fields?: { id: number; name: string; value: string }[];
  } | undefined> {
    try {
      const response = await this.doRequest<{
        user: {
          id: number;
          login: string;
          firstname: string;
          lastname: string;
          mail: string;
          created_on: string;
          last_login_on?: string;
          custom_fields?: { id: number; name: string; value: string }[];
        };
      }>("/users/current.json", "GET");
      return response?.user;
    } catch {
      return undefined;
    }
  }

  /**
   * Get custom fields (requires admin or appropriate permissions)
   */
  async getCustomFields(): Promise<{
    id: number;
    name: string;
    customized_type: string;
    field_format: string;
    possible_values?: { value: string; label?: string }[];
  }[]> {
    try {
      const response = await this.doRequest<{
        custom_fields: {
          id: number;
          name: string;
          customized_type: string;
          field_format: string;
          possible_values?: { value: string; label?: string }[];
        }[];
      }>("/custom_fields.json", "GET");
      return (response?.custom_fields || []).filter(f => f.customized_type === "issue");
    } catch {
      // Custom fields API requires admin - return empty if not accessible
      return [];
    }
  }

  /**
   * Create a new issue
   */
  async createIssue(issue: {
    project_id: number;
    tracker_id: number;
    subject: string;
    description?: string;
    status_id?: number;
    priority_id?: number;
    start_date?: string;
    due_date?: string;
    estimated_hours?: number;
    parent_issue_id?: number;
    custom_fields?: { id: number; value: string }[];
  }): Promise<{ issue: Issue }> {
    return this.doRequest(
      "/issues.json",
      "POST",
      this.encodeJson({ issue })
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

      if (obj && obj.issue_statuses) {
        // Shouldn't change much; cache it.
        this.issueStatuses = obj;
      }

      return {
        issue_statuses: obj?.issue_statuses || [],
      };
    } else {
      return this.issueStatuses;
    }
  }

  async getIssueStatusesTyped(): Promise<IssueStatus[]> {
    const statuses = await this.getIssueStatuses();
    return (statuses?.issue_statuses || []).map((s) => new IssueStatus(s.id, s.name));
  }
  async getMemberships(projectId: number): Promise<Membership[]> {
    const membershipsResponse = await this.doRequest<{
      memberships: RedmineMembership[];
    }>(`/projects/${projectId}/memberships.json`, "GET");

    return (membershipsResponse?.memberships || []).map((m) =>
      "user" in m
        ? new Membership(m.user.id, m.user.name)
        : new Membership(m.group.id, m.group.name, false)
    );
  }
  async applyQuickUpdate(quickUpdate: QuickUpdate): Promise<QuickUpdateResult> {
    // Build issue payload with optional date fields
    const issuePayload: Record<string, unknown> = {
      status_id: quickUpdate.status.statusId,
      assigned_to_id: quickUpdate.assignee.id,
      notes: quickUpdate.message,
    };

    // Only include dates if they were explicitly set (not undefined)
    if (quickUpdate.startDate !== undefined) {
      issuePayload.start_date = quickUpdate.startDate; // null clears, string sets
    }
    if (quickUpdate.dueDate !== undefined) {
      issuePayload.due_date = quickUpdate.dueDate; // null clears, string sets
    }

    // PUT returns 204 No Content on success (null response)
    await this.doRequest<null>(
      `/issues/${quickUpdate.issueId}.json`,
      "PUT",
      this.encodeJson({ issue: issuePayload })
    );

    // Fetch updated issue to verify changes
    const { issue } = await this.getIssueById(quickUpdate.issueId);
    const updateResult = new QuickUpdateResult();
    if (issue.assigned_to?.id !== quickUpdate.assignee.id) {
      updateResult.addDifference("Couldn't assign user");
    }
    if (issue.status.id !== quickUpdate.status.statusId) {
      updateResult.addDifference("Couldn't update status");
    }
    return updateResult;
  }

  /**
   * Batch fetch issues by IDs (for parent containers and dependencies)
   * @param ids Array of issue IDs to fetch
   * @param skipClosed Skip closed issues (default: true for dependencies)
   */
  async getIssuesByIds(ids: number[], skipClosed = true): Promise<Issue[]> {
    if (ids.length === 0) return [];

    const params = new URLSearchParams();
    params.set("issue_id", ids.join(","));
    params.set("include", "relations");
    params.set("status_id", skipClosed ? "open" : "*");

    const issues = await this.paginate<Issue>(
      `/issues.json?${params.toString()}`,
      "issues"
    );
    return issues;
  }

  /**
   * Get issues with flexible filtering
   * Consolidates assignee and status filters into single method
   */
  async getFilteredIssues(filter: {
    assignee: "me" | "any";
    status: "open" | "closed" | "any";
  }): Promise<{ issues: Issue[] }> {
    const params = new URLSearchParams();
    params.set("include", "children,relations");

    // Status filter
    if (filter.status === "open") {
      params.set("status_id", "open");
    } else if (filter.status === "closed") {
      params.set("status_id", "closed");
    } else {
      params.set("status_id", "*"); // Any status
    }

    // Assignee filter
    if (filter.assignee === "me") {
      params.set("assigned_to_id", "me");
    }
    // 'any' = no assigned_to_id param

    const issues = await this.paginate<Issue>(
      `/issues.json?${params.toString()}`,
      "issues"
    );
    return { issues };
  }

  /**
   * Returns promise, that resolves to list of issues assigned to api key owner
   * @deprecated Use getFilteredIssues({ assignee: 'me', status: 'open' })
   */
  async getIssuesAssignedToMe(): Promise<{ issues: Issue[] }> {
    return this.getFilteredIssues({ assignee: "me", status: "open" });
  }

  /**
   * Get all open issues (not filtered by assignee)
   * @deprecated Use getFilteredIssues({ assignee: 'any', status: 'open' })
   */
  async getAllOpenIssues(): Promise<{ issues: Issue[] }> {
    return this.getFilteredIssues({ assignee: "any", status: "open" });
  }

  /**
   * Search issues by text query using multiple methods for better results
   * @param query Search text (searches subject, description, ID)
   * @param limit Max results (default 10)
   * @returns Full Issue objects matching query
   */
  async searchIssues(query: string, limit = 10): Promise<Issue[]> {
    if (!query.trim()) return [];

    // Use both search methods in parallel for better coverage
    const [searchApiResults, subjectFilterResults] = await Promise.all([
      // Method 1: Redmine search API (searches indexed content)
      this.searchViaSearchApi(query, limit),
      // Method 2: Subject filter (searches subject field directly - more reliable)
      this.searchViaSubjectFilter(query, limit),
    ]);

    // Merge results: subject filter first (more reliable), then search API
    const merged = this.deduplicateById([...subjectFilterResults, ...searchApiResults]);
    return merged.slice(0, limit);
  }

  /**
   * Search using Redmine's /search API (searches indexed content)
   */
  private async searchViaSearchApi(query: string, limit: number): Promise<Issue[]> {
    try {
      const response = await this.doRequest<{
        results: { id: number; title: string; type: string; url: string }[];
      }>(`/search.json?q=${encodeURIComponent(query)}&scope=all&issues=1&limit=${limit}`, "GET");

      const issueIds = (response?.results || [])
        .filter((r) => r.type === "issue")
        .map((r) => r.id);

      if (issueIds.length === 0) return [];
      return this.getIssuesByIds(issueIds);
    } catch {
      return []; // Fail silently, other method may work
    }
  }

  /**
   * Search using subject filter with two strategies:
   * 1. Starts-with (^): Focused prefix matches like "Vacation" for "vac"
   * 2. Contains (~) sorted by created_on:asc: Old important issues first
   * Redmine API caps at 100 results, so we use smart queries instead of pagination.
   */
  private async searchViaSubjectFilter(query: string, limit: number): Promise<Issue[]> {
    try {
      const lowerQuery = query.toLowerCase();

      // Two parallel searches with different strategies
      const startsWithParams = new URLSearchParams();
      startsWithParams.append("set_filter", "1");
      startsWithParams.append("f[]", "subject");
      startsWithParams.append("op[subject]", "^"); // Starts with
      startsWithParams.append("v[subject][]", query);
      startsWithParams.append("status_id", "*");
      startsWithParams.append("limit", "100");

      const containsParams = new URLSearchParams();
      containsParams.append("set_filter", "1");
      containsParams.append("f[]", "subject");
      containsParams.append("op[subject]", "~"); // Contains
      containsParams.append("v[subject][]", query);
      containsParams.append("status_id", "*");
      containsParams.append("sort", "created_on:asc"); // Oldest first - catches old important issues
      containsParams.append("limit", "100");

      const [startsWithResult, containsResult] = await Promise.all([
        this.doRequest<{ issues: Issue[] }>(
          `/issues.json?${startsWithParams.toString()}`,
          "GET"
        ).catch(() => ({ issues: [] })),
        this.doRequest<{ issues: Issue[] }>(
          `/issues.json?${containsParams.toString()}`,
          "GET"
        ).catch(() => ({ issues: [] })),
      ]);

      // Merge: starts-with first (more focused), then contains
      const merged = this.deduplicateById([
        ...(startsWithResult?.issues || []),
        ...(containsResult?.issues || []),
      ]);

      // Rank by relevance
      merged.sort((a, b) => {
        const aSubject = a.subject?.toLowerCase() || "";
        const bSubject = b.subject?.toLowerCase() || "";

        // Exact match first
        const aExact = aSubject === lowerQuery;
        const bExact = bSubject === lowerQuery;
        if (aExact && !bExact) return -1;
        if (!aExact && bExact) return 1;

        // Starts with query second
        const aStarts = aSubject.startsWith(lowerQuery);
        const bStarts = bSubject.startsWith(lowerQuery);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;

        // Shorter subjects third (more focused)
        const lenDiff = aSubject.length - bSubject.length;
        if (lenDiff !== 0) return lenDiff;

        // By ID (newer first)
        return b.id - a.id;
      });

      return merged.slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * Returns promise, that resolves to list of open issues for project
   */
  async getOpenIssuesForProject(
    project_id: number | string,
    include_subproject = true
  ): Promise<{ issues: Issue[] }> {
    const endpoint = include_subproject
      ? `/issues.json?status_id=open&project_id=${project_id}`
      : `/issues.json?status_id=open&project_id=${project_id}&subproject_id=!*`;

    const issues = await this.paginate<Issue>(endpoint, "issues");
    return { issues };
  }

  compare(other: RedmineServer) {
    return (
      this.options.address === other.options.address &&
      this.options.key === other.options.key &&
      JSON.stringify(this.options.additionalHeaders) ===
        JSON.stringify(other.options.additionalHeaders)
    );
  }
}
