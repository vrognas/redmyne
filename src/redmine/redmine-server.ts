import { RedmineProject } from "./redmine-project";
import {
  Membership,
  QuickUpdate,
  QuickUpdateResult,
} from "../controllers/domain";
import { TimeEntryActivity } from "./models/common";
import { Project } from "./models/project";
import { TimeEntry, TimeEntryWrite } from "./models/time-entry";
import { Issue } from "./models/issue";
import { Version } from "./models/version";
import { IssueStatus as RedmineIssueStatus, IssuePriority } from "./models/common";
import { Membership as RedmineMembership } from "./models/membership";
import { CustomFieldDefinition, TimeEntryCustomFieldValue } from "./models/custom-field-definition";
import type {
  IRedmineServer,
  RedmineUser,
  RedmineCustomFieldValue,
} from "./redmine-server-interface";
import { RedmineHttpClient } from "./redmine-http-client";
import { ChangeAwareCache, CHANGE_CACHE_TTL_MS, MIN_PROBE_INTERVAL_MS, extractMaxUpdatedOn } from "./change-aware-cache";

// HTTP transport (validation, TLS, concurrency queue, doRequest, paginate,
// encodeJson) lives in RedmineHttpClient — this class adds the domain endpoints
// and caches. RedmineServerConnectionOptions lives in the interface (the
// dependency seam); both are re-exported here for back-compat with existing
// `from "./redmine-server"` importers.
export type { RedmineServerConnectionOptions } from "./redmine-server-interface";
export { RedmineOptionsError } from "./redmine-http-client";

/** Issue cache entry with timestamp for TTL */
interface IssueCacheEntry {
  issue: Issue;
  timestamp: number;
}

/** Default issue cache TTL in milliseconds (60 seconds) */
const ISSUE_CACHE_TTL = 60_000;
const ISSUE_CACHE_PRUNE_INTERVAL_MS = 60_000;
const USER_FTE_CACHE_MAX_ENTRIES = 1000;

export class RedmineServer extends RedmineHttpClient implements IRedmineServer {
  private timeEntryActivities: TimeEntryActivity[] | null = null;
  private timeEntryCustomFieldsCache: CustomFieldDefinition[] | null = null;
  private cachedProjects: RedmineProject[] | null = null;
  private cachedCurrentUser: RedmineUser | null = null;
  private issueCache = new Map<number, IssueCacheEntry>();
  private lastIssueCachePruneMs = 0;
  private changeCache = new ChangeAwareCache();

  /**
   * Lightweight probe: has anything changed since `since` timestamp?
   * Uses updated_on>=TIMESTAMP with limit=1 — Redmine's filter grammar has
   * no bare ">" for dates (it answers 422, which silently disabled change
   * detection). Returns true (changed), false (no change), null (failed).
   */
  private async hasChanges(endpoint: string, since: string): Promise<boolean | null> {
    try {
      const separator = endpoint.includes("?") ? "&" : "?";
      const probeUrl = `${endpoint}${separator}updated_on=${encodeURIComponent(`>=${since}`)}&limit=1&offset=0`;
      const response = await this.doRequest<{ total_count: number }>(probeUrl, "GET");
      return (response?.total_count ?? 0) > 0;
    } catch {
      return null; // Probe failed — caller decides whether to refetch or use cache
    }
  }

  /**
   * Shared change-aware cache ritual: serve a still-fresh cached value, probe
   * the server for changes when the cooldown allows, and refetch only when the
   * probe reports a change (or the cooldown/TTL forces it). Factored out of
   * getProjects/getTimeEntries/getFilteredIssues so the probe semantics — incl.
   * the `changed === null || !changed` "use cache on no-change-or-probe-failure"
   * rule and the `>=` probe operator — live in exactly one place.
   *
   * @param readCached serve-value for a non-expired entry, or null to force refetch
   *                   (lets getProjects gate on its separate cachedProjects mirror)
   * @param refetch    fetches fresh data, returning the serve-value, the cache
   *                   payload to store, and the probe baseline (max updated_on)
   * @param onStale    optional hook run when a change IS detected, before refetch
   *                   (e.g. clearing an external mirror)
   */
  private async getChangeAwareCached<TServe, TStore>(opts: {
    key: string;
    probeEndpoint: string;
    readCached: (entry: { data: TStore; lastCheckedAt: string }) => TServe | null;
    refetch: () => Promise<{ serve: TServe; store: TStore; maxUpdatedOn: string }>;
    onStale?: () => void;
  }): Promise<TServe> {
    const { key, probeEndpoint, readCached, refetch, onStale } = opts;
    const cached = this.changeCache.get<TStore>(key);
    if (cached && !this.changeCache.isExpired(key, CHANGE_CACHE_TTL_MS)) {
      const servable = readCached(cached);
      if (servable !== null) {
        if (!this.changeCache.shouldProbe(key, MIN_PROBE_INTERVAL_MS)) {
          return servable;
        }
        const changed = await this.hasChanges(probeEndpoint, cached.lastCheckedAt);
        if (changed === null || !changed) {
          // null = probe failed (use cache, apply backoff); false = no changes
          this.changeCache.touch(key);
          return servable;
        }
        onStale?.();
      }
    }

    const { serve, store, maxUpdatedOn } = await refetch();
    this.changeCache.set(key, store, maxUpdatedOn);
    return serve;
  }

  /**
   * PUT a partial issue update and invalidate that issue's cache. Single owner
   * of the `/issues/{id}.json` PUT + cache-invalidate shape — every field-update
   * method delegates here so the endpoint and invalidation live in one place.
   */
  private async patchIssue(
    issueId: number,
    fields: Record<string, unknown>
  ): Promise<unknown> {
    const result = await this.doRequest(
      `/issues/${issueId}.json`,
      "PUT",
      this.encodeJson({ issue: fields })
    );
    this.invalidateIssueCache(issueId);
    return result;
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
    // Stores a `true` sentinel in the change cache; the actual list lives in the
    // cachedProjects mirror, so readCached gates on it (null => force refetch)
    // and onStale clears it when a change is detected.
    return this.getChangeAwareCached<RedmineProject[], true>({
      key: "projects",
      probeEndpoint: "/projects.json",
      // Probe via updated_on so renames/parent/identifier changes are caught
      // (count-only probes missed in-place edits).
      readCached: () => this.cachedProjects,
      onStale: () => {
        this.cachedProjects = null;
      },
      refetch: async () => {
        // Baseline the change probe on the SERVER's max updated_on (consistent
        // with getTimeEntries/getFilteredIssues) — client wall-clock skew vs the
        // server makes `updated_on=>{baseline}` probes miss or over-report changes.
        let maxUpdatedOn = "";
        this.cachedProjects = await this.paginate<Project, RedmineProject>(
          "/projects.json",
          "projects",
          (projects) => {
            for (const p of projects as Array<Project & { updated_on?: string }>) {
              if (p.updated_on && p.updated_on > maxUpdatedOn) {
                maxUpdatedOn = p.updated_on;
              }
            }
            return projects.map((proj) => new RedmineProject({ ...proj }));
          }
        );
        return {
          serve: this.cachedProjects,
          store: true,
          maxUpdatedOn: maxUpdatedOn || new Date().toISOString(),
        };
      },
    });
  }

  /**
   * Clear cached projects (call on refresh)
   */
  clearProjectsCache(): void {
    this.cachedProjects = null;
    this.membershipsCache.clear();
    this.versionsCache.clear();
    this.changeCache.invalidate("projects");
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
   * Get custom field definitions for time entries
   * Requires admin permissions - returns empty array if not accessible
   * Results are cached per server instance
   */
  async getTimeEntryCustomFields(): Promise<CustomFieldDefinition[]> {
    if (this.timeEntryCustomFieldsCache !== null) {
      return this.timeEntryCustomFieldsCache;
    }
    try {
      const response = await this.doRequest<{ custom_fields: CustomFieldDefinition[] }>(
        "/custom_fields.json",
        "GET"
      );
      this.timeEntryCustomFieldsCache = (response?.custom_fields || [])
        .filter((f) => f.customized_type === "time_entry");
      return this.timeEntryCustomFieldsCache;
    } catch {
      // Admin-only endpoint - return empty, user will see validation error if fields required
      this.timeEntryCustomFieldsCache = [];
      return [];
    }
  }

  private versionsCache = new Map<string, Version[]>();

  /** Invalidate only the project cache that contains the given versionId. */
  private invalidateVersionCacheFor(versionId: number): void {
    for (const [projectKey, versions] of this.versionsCache) {
      if (versions.some((v) => v.id === versionId)) {
        this.versionsCache.delete(projectKey);
        return; // a version belongs to exactly one project
      }
    }
  }

  /**
   * Get versions (milestones) for a project (cached)
   */
  async getProjectVersions(projectId: number | string): Promise<Version[]> {
    const key = String(projectId);
    const cached = this.versionsCache.get(key);
    if (cached) return cached;

    const response = await this.doRequest<{ versions: Version[] }>(
      `/projects/${projectId}/versions.json`,
      "GET"
    );
    const versions = response?.versions || [];
    this.versionsCache.set(key, versions);
    return versions;
  }

  /**
   * Get versions for multiple projects (batched, 5 concurrent)
   */
  async getVersionsForProjects(projectIds: (number | string)[]): Promise<Map<number | string, Version[]>> {
    const result = new Map<number | string, Version[]>();
    const batchSize = 5;
    for (let i = 0; i < projectIds.length; i += batchSize) {
      const batch = projectIds.slice(i, i + batchSize);
      await Promise.allSettled(batch.map(async (id) => {
        try {
          const versions = await this.getProjectVersions(id);
          result.set(id, versions);
        } catch {
          result.set(id, []);
        }
      }));
    }
    return result;
  }

  /**
   * Create a new version (milestone) for a project
   */
  async createVersion(
    projectId: number | string,
    version: {
      name: string;
      description?: string;
      status?: "open" | "locked" | "closed";
      sharing?: "none" | "descendants" | "hierarchy" | "tree" | "system";
      due_date?: string;
      wiki_page_title?: string;
    }
  ): Promise<Version> {
    const response = await this.doRequest<{ version: Version }>(
      `/projects/${projectId}/versions.json`,
      "POST",
      this.encodeJson({ version })
    );
    if (!response?.version) {
      throw new Error("Failed to create version");
    }
    this.versionsCache.delete(String(projectId));
    return response.version;
  }

  /**
   * Update an existing version
   */
  async updateVersion(
    versionId: number,
    version: {
      name?: string;
      description?: string;
      status?: "open" | "locked" | "closed";
      sharing?: "none" | "descendants" | "hierarchy" | "tree" | "system";
      due_date?: string | null;
      wiki_page_title?: string;
    }
  ): Promise<void> {
    await this.doRequest(`/versions/${versionId}.json`, "PUT", this.encodeJson({ version }));
    this.invalidateVersionCacheFor(versionId);
  }

  /**
   * Delete a version
   */
  async deleteVersion(versionId: number): Promise<void> {
    await this.doRequest(`/versions/${versionId}.json`, "DELETE");
    this.invalidateVersionCacheFor(versionId);
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
    hours: string | number,
    message: string,
    spentOn?: string, // YYYY-MM-DD format, defaults to today
    customFields?: TimeEntryCustomFieldValue[]
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
    if (customFields && customFields.length > 0) {
      entry.custom_fields = customFields;
    }
    const result = await this.doRequest<{ time_entry: TimeEntry }>(
      `/time_entries.json`,
      "POST",
      this.encodeJson({ time_entry: entry })
    );

    // Invalidate caches (spent_hours changed)
    this.invalidateIssueCache(issueId);
    this.changeCache.invalidatePrefix("time_entries:");

    // Auto-update %done based on spent/estimated hours
    await this.autoUpdateDonePercent(issueId);

    return result;
  }

  /**
   * Auto-update done_ratio based on spent/estimated hours
   * Rules: 0% if no estimate, cap at 99% (100% must be manual),
   * skip if already 100%, skip if over budget (spent > estimated),
   * skip if issue not opted-in
   */
  private async autoUpdateDonePercent(issueId: number): Promise<void> {
    try {
      // Check if auto-update is enabled globally
      const config = await import("vscode").then(vscode =>
        vscode.workspace.getConfiguration("redmyne")
      );
      if (!config.get<boolean>("autoUpdateDonePercent", false)) return;

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

    const endpoint = `/time_entries.json?${queryParams.toString()}`;
    const user = params?.allUsers ? "all" : "me";
    const cacheKey = `time_entries:${user}:${params?.from ?? ""}:${params?.to ?? ""}`;

    const time_entries = await this.getChangeAwareCached<TimeEntry[], TimeEntry[]>({
      key: cacheKey,
      probeEndpoint: endpoint,
      readCached: (entry) => entry.data,
      refetch: async () => {
        const data = await this.paginate<TimeEntry>(endpoint, "time_entries");
        return { serve: data, store: data, maxUpdatedOn: extractMaxUpdatedOn(data) };
      },
    });
    return { time_entries };
  }

  /**
   * Returns a single time entry by ID
   * @param id Time entry ID
   */
  async getTimeEntryById(id: number): Promise<{ time_entry: TimeEntry }> {
    const result = await this.doRequest<{ time_entry: TimeEntry }>(
      `/time_entries/${id}.json`,
      "GET"
    );
    if (!result) {
      throw new Error(`Time entry ${id} not found`);
    }
    return result;
  }

  /**
   * Returns time entries for specific issues
   * Used for ad-hoc contribution calculation (only fetch ad-hoc issue entries)
   * @param issueIds Issue IDs to fetch entries for
   * @param options Optional filters: userId, from/to date range (YYYY-MM-DD)
   */
  async getTimeEntriesForIssues(
    issueIds: number[],
    options?: { userId?: number; from?: string; to?: string }
  ): Promise<TimeEntry[]> {
    if (issueIds.length === 0) return [];

    // Build filter params from options
    const filters: string[] = [];
    if (options?.userId) filters.push(`user_id=${options.userId}`);
    if (options?.from) filters.push(`from=${options.from}`);
    if (options?.to) filters.push(`to=${options.to}`);
    const filterStr = filters.length > 0 ? `&${filters.join("&")}` : "";

    // Redmine supports comma-separated issue_id filter.
    // Batch by URL length (~1800 chars safe) rather than per-issue.
    const MAX_URL_LEN = 1800;
    const baseUrl = `/time_entries.json?`;
    const allEntries: TimeEntry[] = [];
    let currentBatch: number[] = [];

    const fetchBatch = async (batch: number[]) => {
      const url = `${baseUrl}issue_id=${batch.join(",")}${filterStr}`;
      if (url.length > MAX_URL_LEN && batch.length === 1) {
        // Single ID exceeds limit (extremely long filterStr) — fetch without filters as fallback
        const fallbackUrl = `${baseUrl}issue_id=${batch[0]}`;
        const entries = await this.paginate<TimeEntry>(fallbackUrl, "time_entries");
        allEntries.push(...entries);
        return;
      }
      const entries = await this.paginate<TimeEntry>(url, "time_entries");
      allEntries.push(...entries);
    };

    for (const id of issueIds) {
      currentBatch.push(id);
      const testUrl = `${baseUrl}issue_id=${currentBatch.join(",")}${filterStr}`;
      if (testUrl.length > MAX_URL_LEN) {
        currentBatch.pop();
        if (currentBatch.length > 0) await fetchBatch(currentBatch);
        currentBatch = [id];
      }
    }
    if (currentBatch.length > 0) await fetchBatch(currentBatch);

    return allEntries;
  }

  /**
   * Update an existing time entry
   * @param id Time entry ID
   * @param updates Fields to update (hours, comments, activity_id, spent_on, issue_id, custom_fields)
   */
  async updateTimeEntry(
    id: number,
    updates: TimeEntryWrite
  ): Promise<void> {
    await this.doRequest(
      `/time_entries/${id}.json`,
      "PUT",
      this.encodeJson({ time_entry: updates })
    );
    this.changeCache.invalidatePrefix("time_entries:");
  }

  /**
   * Delete a time entry
   * @param id Time entry ID
   */
  async deleteTimeEntry(id: number): Promise<void> {
    await this.doRequest(`/time_entries/${id}.json`, "DELETE");
    this.changeCache.invalidatePrefix("time_entries:");
  }

  /**
   * Returns promise, that resolves to an issue
   * Cached with 60s TTL to avoid redundant fetches
   * @param issueId ID of issue
   */
  async getIssueById(issueId: number): Promise<{ issue: Issue }> {
    this.maybePruneIssueCache();

    // Check cache with TTL
    const now = Date.now();
    const cached = this.issueCache.get(issueId);
    if (cached && now - cached.timestamp < ISSUE_CACHE_TTL) {
      return { issue: cached.issue };
    }

    const result = await this.doRequest<{ issue: Issue }>(`/issues/${issueId}.json`, "GET");

    // Cache the result
    if (result?.issue) {
      this.issueCache.set(issueId, {
        issue: result.issue,
        timestamp: Date.now(),
      });
    }

    return result;
  }

  private maybePruneIssueCache(now: number = Date.now()): void {
    if (now - this.lastIssueCachePruneMs < ISSUE_CACHE_PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastIssueCachePruneMs = now;

    for (const [id, entry] of this.issueCache.entries()) {
      if (now - entry.timestamp >= ISSUE_CACHE_TTL) {
        this.issueCache.delete(id);
      }
    }
  }

  /**
   * Fetch issue with full journal history (updates/comments)
   */
  getIssueWithJournals(issueId: number): Promise<{ issue: Issue }> {
    return this.doRequest(`/issues/${issueId}.json?include=journals`, "GET");
  }

  /**
   * Invalidate cached issue (call after updates)
   */
  private invalidateIssueCache(issueId: number): void {
    this.issueCache.delete(issueId);
    this.changeCache.invalidatePrefix("issues:");
  }

  /**
   * Returns promise, that resolves, when issue status is set
   */
  async setIssueStatus(issue: Pick<Issue, "id">, statusId: number): Promise<unknown> {
    return this.patchIssue(issue.id, { status_id: statusId });
  }

  /**
   * Update issue start_date and/or due_date
   */
  async updateIssueDates(
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
    return this.patchIssue(issueId, issueUpdate);
  }

  /**
   * Update done_ratio (% Done) for an issue
   */
  async updateDoneRatio(issueId: number, doneRatio: number): Promise<unknown> {
    return this.patchIssue(issueId, { done_ratio: doneRatio });
  }

  /**
   * Create a relation between two issues
   * @param relationType One of: relates, duplicates, blocks, precedes, follows, copied_to
   * @param delay Optional delay in days for precedes/follows (default: 0 means +1 day, -1 means same day)
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
      | "copied_to",
    delay?: number
  ): Promise<{ relation: { id: number; issue_id: number; issue_to_id: number; relation_type: string; delay?: number } }> {
    const relationData: { issue_to_id: number; relation_type: string; delay?: number } = {
      issue_to_id: targetIssueId,
      relation_type: relationType,
    };
    // Only include delay for precedes/follows relations
    if (delay !== undefined && (relationType === "precedes" || relationType === "follows")) {
      relationData.delay = delay;
    }
    const response = await this.doRequest<{
      relation: { id: number; issue_id: number; issue_to_id: number; relation_type: string; delay?: number };
    }>(
      `/issues/${issueId}/relations.json`,
      "POST",
      this.encodeJson({ relation: relationData })
    );
    this.invalidateIssueCache(issueId);
    this.invalidateIssueCache(targetIssueId);
    return response!;
  }

  /**
   * Delete a relation by ID
   */
  async deleteRelation(relationId: number): Promise<unknown> {
    const result = await this.doRequest(`/relations/${relationId}.json`, "DELETE");
    this.changeCache.invalidatePrefix("issues:");
    return result;
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
   * Get available issue priorities.
   * Delegates to getIssuePriorities so results are cached per server instance
   * (static enumeration data) instead of re-fetched on every call.
   */
  async getPriorities(): Promise<{ id: number; name: string }[]> {
    return (await this.getIssuePriorities()).issue_priorities;
  }

  /**
   * Get current user info including custom fields (e.g., FTE)
   * Cached for session duration (user doesn't change)
   */
  async getCurrentUser(): Promise<RedmineUser | undefined> {
    // Return cached user if available
    if (this.cachedCurrentUser) {
      return this.cachedCurrentUser;
    }

    try {
      const response = await this.doRequest<{ user: RedmineUser }>(
        "/users/current.json",
        "GET"
      );
      this.cachedCurrentUser = response?.user ?? null;
      return response?.user;
    } catch {
      return undefined;
    }
  }

  /** Cache for user FTE percentages */
  private userFteCache = new Map<number, number>();

  private setUserFteCache(userId: number, fte: number): void {
    // Maintain recency ordering for deterministic eviction.
    if (this.userFteCache.has(userId)) {
      this.userFteCache.delete(userId);
    }
    this.userFteCache.set(userId, fte);

    if (this.userFteCache.size > USER_FTE_CACHE_MAX_ENTRIES) {
      const oldestKey = this.userFteCache.keys().next().value as number | undefined;
      if (oldestKey !== undefined) {
        this.userFteCache.delete(oldestKey);
      }
    }
  }

  /**
   * Get FTE percentage for a user (100 = full-time, 80 = 80%, etc.)
   * Returns 100 if not found or on error
   */
  async getUserFte(userId: number): Promise<number> {
    // Check cache first
    const cachedFte = this.userFteCache.get(userId);
    if (cachedFte !== undefined) {
      // Refresh recency order for LRU-like eviction.
      this.setUserFteCache(userId, cachedFte);
      return cachedFte;
    }

    try {
      const response = await this.doRequest<{
        user: { id: number; custom_fields?: RedmineCustomFieldValue[] };
      }>(`/users/${userId}.json`, "GET");

      const fteField = response?.user?.custom_fields?.find(
        (f) => f.name === "FTE percent" || f.id === 18
      );
      const fte = fteField?.value ? parseInt(fteField.value, 10) : 100;
      const validFte = isNaN(fte) || fte <= 0 ? 100 : fte;

      this.setUserFteCache(userId, validFte);
      return validFte;
    } catch {
      // Default to 100% FTE on error
      this.setUserFteCache(userId, 100);
      return 100;
    }
  }

  /**
   * Get FTE percentages for multiple users (batched for efficiency)
   */
  async getUserFteBatch(userIds: number[]): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    const uncached = userIds.filter((id) => !this.userFteCache.has(id));

    // Get cached values
    for (const id of userIds) {
      if (this.userFteCache.has(id)) {
        result.set(id, this.userFteCache.get(id)!);
      }
    }

    // Fetch uncached values in parallel batches (10 at a time — lightweight GETs)
    const batchSize = 10;
    for (let i = 0; i < uncached.length; i += batchSize) {
      const batch = uncached.slice(i, i + batchSize);
      await Promise.allSettled(batch.map((id) => this.getUserFte(id)));
    }

    // Add newly fetched values
    for (const id of uncached) {
      result.set(id, this.userFteCache.get(id) ?? 100);
    }

    return result;
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
    const result = await this.doRequest<{ issue: Issue }>(
      "/issues.json",
      "POST",
      this.encodeJson({ issue })
    );
    this.changeCache.invalidatePrefix("issues:");
    return result;
  }

  issueStatuses: { issue_statuses: RedmineIssueStatus[] } | null = null;
  issuePriorities: { issue_priorities: IssuePriority[] } | null = null;

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

  /**
   * Returns issue priorities (cached per server instance)
   */
  async getIssuePriorities(): Promise<{ issue_priorities: IssuePriority[] }> {
    if (this.issuePriorities) return this.issuePriorities;
    const obj = await this.doRequest<{ issue_priorities: IssuePriority[] }>(
      "/enumerations/issue_priorities.json",
      "GET"
    );
    if (obj?.issue_priorities) {
      this.issuePriorities = obj;
    }
    return { issue_priorities: obj?.issue_priorities || [] };
  }

  /**
   * Set issue priority
   */
  async setIssuePriority(issueId: number, priorityId: number): Promise<void> {
    await this.patchIssue(issueId, { priority_id: priorityId });
  }

  private membershipsCache = new Map<number, Membership[]>();
  private membershipsFetchMap = new Map<number, Promise<Membership[]>>();

  getCachedMemberships(projectId: number): Membership[] | undefined {
    return this.membershipsCache.get(projectId);
  }

  async getMemberships(projectId: number): Promise<Membership[]> {
    const cached = this.membershipsCache.get(projectId);
    if (cached) return cached;

    // Deduplicate in-flight requests
    const inFlight = this.membershipsFetchMap.get(projectId);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const membershipsResponse = await this.doRequest<{
        memberships: RedmineMembership[];
      }>(`/projects/${projectId}/memberships.json`, "GET");

      const members = (membershipsResponse?.memberships || []).map((m) => {
        const roles = m.roles.map((r) => r.name);
        return "user" in m
          ? new Membership(m.user.id, m.user.name, true, roles)
          : new Membership(m.group.id, m.group.name, false, roles);
      });
      this.membershipsCache.set(projectId, members);
      return members;
    })();

    this.membershipsFetchMap.set(projectId, promise);
    try {
      return await promise;
    } finally {
      this.membershipsFetchMap.delete(projectId);
    }
  }
  async applyQuickUpdate(quickUpdate: QuickUpdate): Promise<QuickUpdateResult> {
    // Build issue payload with optional date fields
    const issuePayload: Record<string, unknown> = {
      status_id: quickUpdate.status.id,
      notes: quickUpdate.message,
    };

    // id 0 means "keep unassigned" (no Redmine user has id 0): sending
    // assigned_to_id: 0 is rejected or clears, and the verification below
    // would always report a spurious "Couldn't assign user".
    if (quickUpdate.assignee.id !== 0) {
      issuePayload.assigned_to_id = quickUpdate.assignee.id;
    }

    // Only include dates if they were explicitly set (not undefined)
    if (quickUpdate.startDate !== undefined) {
      issuePayload.start_date = quickUpdate.startDate; // null clears, string sets
    }
    if (quickUpdate.dueDate !== undefined) {
      issuePayload.due_date = quickUpdate.dueDate; // null clears, string sets
    }

    // PUT returns 204 No Content on success (null response)
    await this.patchIssue(quickUpdate.issueId, issuePayload);

    // Fetch updated issue to verify changes
    const { issue } = await this.getIssueById(quickUpdate.issueId);
    const updateResult = new QuickUpdateResult();
    if (
      quickUpdate.assignee.id !== 0 &&
      issue.assigned_to?.id !== quickUpdate.assignee.id
    ) {
      updateResult.addDifference("Couldn't assign user");
    }
    if (issue.status.id !== quickUpdate.status.id) {
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

    // Redmine supports a comma-separated issue_id filter, but a large ID set
    // joined into one query param blows past server/proxy URL length limits
    // (~414). Batch by URL length, mirroring getTimeEntriesForIssues, and
    // concat the per-batch paginate results (batches are disjoint ID slices,
    // so no de-dup is needed).
    const MAX_URL_LEN = 1800;
    const suffix = `&include=relations&status_id=${skipClosed ? "open" : "*"}`;
    const baseUrl = `/issues.json?issue_id=`;

    const fetchBatch = (batch: number[]) =>
      this.paginate<Issue>(`${baseUrl}${batch.join(",")}${suffix}`, "issues");

    const allIssues: Issue[] = [];
    let currentBatch: number[] = [];
    for (const id of ids) {
      currentBatch.push(id);
      const testUrl = `${baseUrl}${currentBatch.join(",")}${suffix}`;
      if (testUrl.length > MAX_URL_LEN && currentBatch.length > 1) {
        currentBatch.pop();
        allIssues.push(...(await fetchBatch(currentBatch)));
        currentBatch = [id];
      }
    }
    if (currentBatch.length > 0) {
      allIssues.push(...(await fetchBatch(currentBatch)));
    }
    return allIssues;
  }

  /**
   * Get issues with flexible filtering
   * Consolidates assignee and status filters into single method
   */
  async getFilteredIssues(
    filter: {
      assignee: "me" | "any";
      status: "open" | "closed" | "any";
      priority?: number | "any";
    },
    onProgress?: (issuesSoFar: Issue[]) => void
  ): Promise<{ issues: Issue[] }> {
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

    // Priority filter
    if (filter.priority && filter.priority !== "any") {
      params.set("priority_id", String(filter.priority));
    }

    const endpoint = `/issues.json?${params.toString()}`;
    const cacheKey = `issues:${filter.assignee}:${filter.status}:${filter.priority ?? "any"}`;

    const issues = await this.getChangeAwareCached<Issue[], Issue[]>({
      key: cacheKey,
      probeEndpoint: endpoint,
      readCached: (entry) => entry.data,
      refetch: async () => {
        // Stream pages into onProgress as they arrive (only on refetch, never on
        // a cache hit). Only accumulate when the caller cares (avoids ~1500-ref
        // array work on every plain fetch); pass a snapshot so callers can't
        // observe later mutations through the reference.
        let onPage: ((page: Issue[]) => void) | undefined;
        if (onProgress) {
          const accumulated: Issue[] = [];
          onPage = (page) => {
            accumulated.push(...page);
            onProgress([...accumulated]);
          };
        }
        const data = await this.paginate<Issue>(endpoint, "issues", undefined, onPage);
        return { serve: data, store: data, maxUpdatedOn: extractMaxUpdatedOn(data) };
      },
    });
    return { issues };
  }

  /**
   * Returns promise, that resolves to list of issues assigned to api key owner.
   * Supported convenience wrapper over getFilteredIssues({ assignee: 'me', status: 'open' }).
   */
  async getIssuesAssignedToMe(): Promise<{ issues: Issue[] }> {
    return this.getFilteredIssues({ assignee: "me", status: "open" });
  }

  /**
   * Get all open issues (not filtered by assignee).
   * Supported convenience wrapper over getFilteredIssues({ assignee: 'any', status: 'open' }).
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

    // Fast path: subject filter (1 HTTP call, returns full Issue objects)
    const subjectResults = await this.searchViaSubjectFilter(query, limit);
    if (subjectResults.length >= limit) {
      return subjectResults;
    }

    // Supplement with search API if subject filter returned fewer than limit
    const searchApiResults = await this.searchViaSearchApi(query, limit);
    const merged = this.deduplicateById([...subjectResults, ...searchApiResults]);
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
      return this.getIssuesByIds(issueIds, false);
    } catch {
      return []; // Fail silently, other method may work
    }
  }

  /**
   * Search using subject contains filter (~).
   * Client-side sort prioritizes exact/starts-with matches.
   */
  private async searchViaSubjectFilter(query: string, limit: number): Promise<Issue[]> {
    try {
      const lowerQuery = query.toLowerCase();

      const containsParams = new URLSearchParams();
      containsParams.append("set_filter", "1");
      containsParams.append("f[]", "subject");
      containsParams.append("op[subject]", "~"); // Contains
      containsParams.append("v[subject][]", query);
      containsParams.append("status_id", "*");
      containsParams.append("limit", "100");

      const result = await this.doRequest<{ issues: Issue[] }>(
        `/issues.json?${containsParams.toString()}`,
        "GET"
      ).catch(() => ({ issues: [] }));

      const issues = result?.issues || [];

      // Rank by relevance
      issues.sort((a, b) => {
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

      return issues.slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * Returns promise, that resolves to list of open issues for project
   * @param limit - Max issues to return (default: all). Use for search previews.
   */
  async getOpenIssuesForProject(
    project_id: number | string,
    include_subproject = true,
    limit?: number,
    openOnly = true
  ): Promise<{ issues: Issue[] }> {
    const statusFilter = openOnly ? "status_id=open" : "status_id=*";
    const baseEndpoint = include_subproject
      ? `/issues.json?${statusFilter}&project_id=${project_id}&subproject_id=*`
      : `/issues.json?${statusFilter}&project_id=${project_id}&subproject_id=!*`;

    if (limit !== undefined) {
      // Direct fetch with limit (no pagination needed)
      const response = await this.doRequest<{ issues: Issue[] }>(
        `${baseEndpoint}&limit=${limit}`,
        "GET"
      );
      return { issues: response?.issues || [] };
    }

    const issues = await this.paginate<Issue>(baseEndpoint, "issues");
    return { issues };
  }

  compare(other: IRedmineServer) {
    return (
      this.options.address === other.options.address &&
      this.options.key === other.options.key &&
      JSON.stringify(this.options.additionalHeaders) ===
        JSON.stringify(other.options.additionalHeaders)
    );
  }

  // ============ Generic HTTP Methods ============

  /**
   * Generic POST request
   */
  async post<T = unknown>(path: string, data: Record<string, unknown>): Promise<T> {
    return this.doRequest<T>(path, "POST", this.encodeJson(data));
  }

  /**
   * Generic PUT request
   */
  async put<T = unknown>(path: string, data: Record<string, unknown>): Promise<T> {
    return this.doRequest<T>(path, "PUT", this.encodeJson(data));
  }

  /**
   * Generic DELETE request
   */
  async delete<T = unknown>(path: string): Promise<T> {
    return this.doRequest<T>(path, "DELETE");
  }
}
