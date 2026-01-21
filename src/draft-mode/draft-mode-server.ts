/**
 * Draft Mode Server
 * Wraps RedmineServer to intercept write operations when draft mode is enabled
 */

import type { RedmineServer } from "../redmine/redmine-server";
import type { Issue } from "../redmine/models/issue";
import type { TimeEntry } from "../redmine/models/time-entry";
import type { Version } from "../redmine/models/version";
import type { QuickUpdate, QuickUpdateResult } from "../controllers/domain";
import type { DraftQueue } from "./draft-queue";
import type { DraftModeManager } from "./draft-mode-manager";
import type { DraftOperation, DraftOperationType, HttpMethod } from "./draft-operation";
import { generateDraftId, generateTempId, generateNumericTempId } from "./draft-operation";

export interface DraftBypassOptions {
  _bypassDraft?: boolean;
}


export class DraftModeServer {
  private inner: RedmineServer;
  private queue: DraftQueue;
  private manager: DraftModeManager;

  // Passthrough methods (assigned in constructor)
  getIssueById!: RedmineServer["getIssueById"];
  getIssueWithJournals!: RedmineServer["getIssueWithJournals"];
  getIssuesByIds!: RedmineServer["getIssuesByIds"];
  getFilteredIssues!: RedmineServer["getFilteredIssues"];
  getIssuesAssignedToMe!: RedmineServer["getIssuesAssignedToMe"];
  getAllOpenIssues!: RedmineServer["getAllOpenIssues"];
  getOpenIssuesForProject!: RedmineServer["getOpenIssuesForProject"];
  searchIssues!: RedmineServer["searchIssues"];
  getProjects!: RedmineServer["getProjects"];
  clearProjectsCache!: RedmineServer["clearProjectsCache"];
  getTimeEntries!: RedmineServer["getTimeEntries"];
  getProjectTimeEntries!: RedmineServer["getProjectTimeEntries"];
  getAllTimeEntries!: RedmineServer["getAllTimeEntries"];
  getTimeEntriesForIssues!: RedmineServer["getTimeEntriesForIssues"];
  getTimeEntryActivities!: RedmineServer["getTimeEntryActivities"];
  getProjectTimeEntryActivities!: RedmineServer["getProjectTimeEntryActivities"];
  getProjectVersions!: RedmineServer["getProjectVersions"];
  getVersionsForProjects!: RedmineServer["getVersionsForProjects"];
  getIssueStatuses!: RedmineServer["getIssueStatuses"];
  getIssueStatusesTyped!: RedmineServer["getIssueStatusesTyped"];
  getIssuePriorities!: RedmineServer["getIssuePriorities"];
  getPriorities!: RedmineServer["getPriorities"];
  getTrackers!: RedmineServer["getTrackers"];
  getCurrentUser!: RedmineServer["getCurrentUser"];
  getCustomFields!: RedmineServer["getCustomFields"];
  getMemberships!: RedmineServer["getMemberships"];
  isTimeTrackingEnabled!: RedmineServer["isTimeTrackingEnabled"];
  compare!: RedmineServer["compare"];

  constructor(
    inner: RedmineServer,
    queue: DraftQueue,
    manager: DraftModeManager
  ) {
    this.inner = inner;
    this.queue = queue;
    this.manager = manager;

    // Bind all passthrough methods
    this.getIssueById = inner.getIssueById.bind(inner);
    this.getIssueWithJournals = inner.getIssueWithJournals.bind(inner);
    this.getIssuesByIds = inner.getIssuesByIds.bind(inner);
    this.getFilteredIssues = inner.getFilteredIssues.bind(inner);
    this.getIssuesAssignedToMe = inner.getIssuesAssignedToMe.bind(inner);
    this.getAllOpenIssues = inner.getAllOpenIssues.bind(inner);
    this.getOpenIssuesForProject = inner.getOpenIssuesForProject.bind(inner);
    this.searchIssues = inner.searchIssues.bind(inner);
    this.getProjects = inner.getProjects.bind(inner);
    this.clearProjectsCache = inner.clearProjectsCache.bind(inner);
    this.getTimeEntries = inner.getTimeEntries.bind(inner);
    this.getProjectTimeEntries = inner.getProjectTimeEntries.bind(inner);
    this.getAllTimeEntries = inner.getAllTimeEntries.bind(inner);
    this.getTimeEntriesForIssues = inner.getTimeEntriesForIssues.bind(inner);
    this.getTimeEntryActivities = inner.getTimeEntryActivities.bind(inner);
    this.getProjectTimeEntryActivities = inner.getProjectTimeEntryActivities.bind(inner);
    this.getProjectVersions = inner.getProjectVersions.bind(inner);
    this.getVersionsForProjects = inner.getVersionsForProjects.bind(inner);
    this.getIssueStatuses = inner.getIssueStatuses.bind(inner);
    this.getIssueStatusesTyped = inner.getIssueStatusesTyped.bind(inner);
    this.getIssuePriorities = inner.getIssuePriorities.bind(inner);
    this.getPriorities = inner.getPriorities.bind(inner);
    this.getTrackers = inner.getTrackers.bind(inner);
    this.getCurrentUser = inner.getCurrentUser.bind(inner);
    this.getCustomFields = inner.getCustomFields.bind(inner);
    this.getMemberships = inner.getMemberships.bind(inner);
    this.isTimeTrackingEnabled = inner.isTimeTrackingEnabled.bind(inner);
    this.compare = inner.compare.bind(inner);
  }

  private shouldIntercept(options?: DraftBypassOptions): boolean {
    if (options?._bypassDraft) return false;
    return this.manager.isEnabled;
  }

  private createOperation(
    type: DraftOperationType,
    description: string,
    resourceKey: string,
    http: { method: HttpMethod; path: string; data?: Record<string, unknown> },
    extra: Partial<DraftOperation> = {}
  ): DraftOperation {
    return {
      id: generateDraftId(),
      type,
      timestamp: Date.now(),
      description,
      resourceKey,
      http,
      ...extra,
    };
  }

  // ============ Issue Methods ============

  async createIssue(
    issue: Parameters<RedmineServer["createIssue"]>[0],
    options?: DraftBypassOptions
  ): Promise<{ issue: Issue }> {
    if (!this.shouldIntercept(options)) {
      return this.inner.createIssue(issue);
    }

    const tempId = generateNumericTempId();
    const tempIdStr = generateTempId("issue");

    await this.queue.add(
      this.createOperation(
        "createIssue",
        `Create issue "${issue.subject}"`,
        `issue:create:${tempIdStr}`,
        {
          method: "POST",
          path: "/issues.json",
          data: { issue },
        },
        { tempId: tempIdStr }
      )
    );

    // Return stub issue with temp ID
    return {
      issue: {
        id: tempId,
        project: { id: issue.project_id, name: "" },
        tracker: { id: issue.tracker_id, name: "" },
        status: { id: issue.status_id ?? 1, name: "New", is_closed: false },
        priority: { id: issue.priority_id ?? 2, name: "Normal" },
        subject: issue.subject,
        description: issue.description ?? "",
        start_date: issue.start_date,
        due_date: issue.due_date,
        estimated_hours: issue.estimated_hours,
        done_ratio: 0,
        created_on: new Date().toISOString(),
        updated_on: new Date().toISOString(),
      } as Issue,
    };
  }

  async setIssueStatus(
    issue: Pick<Issue, "id">,
    statusId: number,
    options?: DraftBypassOptions
  ): Promise<unknown> {
    if (!this.shouldIntercept(options)) {
      return this.inner.setIssueStatus(issue, statusId);
    }

    await this.queue.add(
      this.createOperation(
        "setIssueStatus",
        `Set #${issue.id} status to ${statusId}`,
        `issue:${issue.id}:status`,
        {
          method: "PUT",
          path: `/issues/${issue.id}.json`,
          data: { issue: { status_id: statusId } },
        },
        { issueId: issue.id }
      )
    );

    return null;
  }

  async updateIssueDates(
    issueId: number,
    startDate: string | null,
    dueDate: string | null,
    options?: DraftBypassOptions
  ): Promise<unknown> {
    if (!this.shouldIntercept(options)) {
      return this.inner.updateIssueDates(issueId, startDate, dueDate);
    }

    const issueUpdate: Record<string, unknown> = {};
    if (startDate !== null) issueUpdate.start_date = startDate;
    if (dueDate !== null) issueUpdate.due_date = dueDate;

    await this.queue.add(
      this.createOperation(
        "setIssueDates",
        `Set #${issueId} dates: ${startDate || "?"} - ${dueDate || "?"}`,
        `issue:${issueId}:dates`,
        {
          method: "PUT",
          path: `/issues/${issueId}.json`,
          data: { issue: issueUpdate },
        },
        { issueId }
      )
    );

    return null;
  }

  async updateDoneRatio(
    issueId: number,
    doneRatio: number,
    options?: DraftBypassOptions
  ): Promise<unknown> {
    if (!this.shouldIntercept(options)) {
      return this.inner.updateDoneRatio(issueId, doneRatio);
    }

    await this.queue.add(
      this.createOperation(
        "setIssueDoneRatio",
        `Set #${issueId} progress to ${doneRatio}%`,
        `issue:${issueId}:done_ratio`,
        {
          method: "PUT",
          path: `/issues/${issueId}.json`,
          data: { issue: { done_ratio: doneRatio } },
        },
        { issueId }
      )
    );

    return null;
  }

  async setIssuePriority(
    issueId: number,
    priorityId: number,
    options?: DraftBypassOptions
  ): Promise<void> {
    if (!this.shouldIntercept(options)) {
      return this.inner.setIssuePriority(issueId, priorityId);
    }

    await this.queue.add(
      this.createOperation(
        "setIssuePriority",
        `Set #${issueId} priority to ${priorityId}`,
        `issue:${issueId}:priority`,
        {
          method: "PUT",
          path: `/issues/${issueId}.json`,
          data: { issue: { priority_id: priorityId } },
        },
        { issueId }
      )
    );
  }

  async applyQuickUpdate(
    quickUpdate: QuickUpdate,
    options?: DraftBypassOptions
  ): Promise<QuickUpdateResult> {
    if (!this.shouldIntercept(options)) {
      return this.inner.applyQuickUpdate(quickUpdate);
    }

    // Split into per-field operations for granular conflict resolution
    const ops: DraftOperation[] = [];

    ops.push(
      this.createOperation(
        "setIssueStatus",
        `Set #${quickUpdate.issueId} status to ${quickUpdate.status.name}`,
        `issue:${quickUpdate.issueId}:status`,
        {
          method: "PUT",
          path: `/issues/${quickUpdate.issueId}.json`,
          data: { issue: { status_id: quickUpdate.status.statusId } },
        },
        { issueId: quickUpdate.issueId }
      )
    );

    ops.push(
      this.createOperation(
        "setIssueAssignee",
        `Assign #${quickUpdate.issueId} to ${quickUpdate.assignee.name}`,
        `issue:${quickUpdate.issueId}:assigned_to`,
        {
          method: "PUT",
          path: `/issues/${quickUpdate.issueId}.json`,
          data: { issue: { assigned_to_id: quickUpdate.assignee.id } },
        },
        { issueId: quickUpdate.issueId }
      )
    );

    if (quickUpdate.message) {
      const noteId = generateDraftId();
      ops.push(
        this.createOperation(
          "addIssueNote",
          `Add note to #${quickUpdate.issueId}`,
          `issue:${quickUpdate.issueId}:note:${noteId}`,
          {
            method: "PUT",
            path: `/issues/${quickUpdate.issueId}.json`,
            data: { issue: { notes: quickUpdate.message } },
          },
          { issueId: quickUpdate.issueId }
        )
      );
    }

    if (quickUpdate.startDate !== undefined || quickUpdate.dueDate !== undefined) {
      const issueUpdate: Record<string, unknown> = {};
      if (quickUpdate.startDate !== undefined) issueUpdate.start_date = quickUpdate.startDate;
      if (quickUpdate.dueDate !== undefined) issueUpdate.due_date = quickUpdate.dueDate;

      ops.push(
        this.createOperation(
          "setIssueDates",
          `Set #${quickUpdate.issueId} dates`,
          `issue:${quickUpdate.issueId}:dates`,
          {
            method: "PUT",
            path: `/issues/${quickUpdate.issueId}.json`,
            data: { issue: issueUpdate },
          },
          { issueId: quickUpdate.issueId }
        )
      );
    }

    for (const op of ops) {
      await this.queue.add(op);
    }

    // Return success stub
    return { differences: [] } as unknown as QuickUpdateResult;
  }

  // ============ Time Entry Methods ============

  async addTimeEntry(
    issueId: number,
    activityId: number,
    hours: string,
    message: string,
    spentOn?: string,
    options?: DraftBypassOptions
  ): Promise<{ time_entry: TimeEntry }> {
    if (!this.shouldIntercept(options)) {
      return this.inner.addTimeEntry(issueId, activityId, hours, message, spentOn);
    }

    const tempId = generateNumericTempId();
    const tempIdStr = generateTempId("timeentry");

    // Default spentOn to today if not provided (needed for tree filtering)
    const effectiveSpentOn = spentOn ?? new Date().toISOString().split("T")[0];

    await this.queue.add(
      this.createOperation(
        "createTimeEntry",
        `Log ${hours}h to #${issueId}`,
        `timeentry:create:${tempIdStr}`,
        {
          method: "POST",
          path: "/time_entries.json",
          data: {
            time_entry: {
              issue_id: issueId,
              activity_id: activityId,
              hours,
              comments: message,
              spent_on: effectiveSpentOn,
            },
          },
        },
        { issueId, tempId: tempIdStr }
      )
    );

    // Return stub with temp ID
    return {
      time_entry: {
        id: tempId,
        issue_id: issueId,
        activity_id: activityId,
        hours,
        comments: message,
        spent_on: effectiveSpentOn,
        activity: { id: activityId, name: "" },
        issue: { id: issueId },
        created_on: new Date().toISOString(),
        updated_on: new Date().toISOString(),
      } as TimeEntry,
    };
  }

  async updateTimeEntry(
    id: number,
    updates: Parameters<RedmineServer["updateTimeEntry"]>[1],
    options?: DraftBypassOptions
  ): Promise<void> {
    if (!this.shouldIntercept(options)) {
      return this.inner.updateTimeEntry(id, updates);
    }

    await this.queue.add(
      this.createOperation(
        "updateTimeEntry",
        `Update time entry ${id}`,
        `timeentry:${id}:update`,
        {
          method: "PUT",
          path: `/time_entries/${id}.json`,
          data: { time_entry: updates },
        },
        { resourceId: id }
      )
    );
  }

  async deleteTimeEntry(id: number, options?: DraftBypassOptions): Promise<void> {
    if (!this.shouldIntercept(options)) {
      return this.inner.deleteTimeEntry(id);
    }

    await this.queue.add(
      this.createOperation(
        "deleteTimeEntry",
        `Delete time entry ${id}`,
        `timeentry:${id}:delete`,
        {
          method: "DELETE",
          path: `/time_entries/${id}.json`,
        },
        { resourceId: id }
      )
    );
  }

  // ============ Version Methods ============

  async createVersion(
    projectId: number | string,
    version: Parameters<RedmineServer["createVersion"]>[1],
    options?: DraftBypassOptions
  ): Promise<Version> {
    if (!this.shouldIntercept(options)) {
      return this.inner.createVersion(projectId, version);
    }

    const tempId = generateNumericTempId();
    const tempIdStr = generateTempId("version");

    await this.queue.add(
      this.createOperation(
        "createVersion",
        `Create version "${version.name}"`,
        `version:create:${tempIdStr}`,
        {
          method: "POST",
          path: `/projects/${projectId}/versions.json`,
          data: { version },
        },
        { tempId: tempIdStr }
      )
    );

    // Return stub with temp ID
    return {
      id: tempId,
      name: version.name,
      project: { id: typeof projectId === "number" ? projectId : 0, name: "" },
      status: version.status ?? "open",
      sharing: version.sharing ?? "none",
      description: version.description ?? "",
      due_date: version.due_date,
      created_on: new Date().toISOString(),
      updated_on: new Date().toISOString(),
    } as Version;
  }

  async updateVersion(
    versionId: number,
    version: Parameters<RedmineServer["updateVersion"]>[1],
    options?: DraftBypassOptions
  ): Promise<void> {
    if (!this.shouldIntercept(options)) {
      return this.inner.updateVersion(versionId, version);
    }

    await this.queue.add(
      this.createOperation(
        "updateVersion",
        `Update version ${versionId}`,
        `version:${versionId}:update`,
        {
          method: "PUT",
          path: `/versions/${versionId}.json`,
          data: { version },
        },
        { resourceId: versionId }
      )
    );
  }

  async deleteVersion(versionId: number, options?: DraftBypassOptions): Promise<void> {
    if (!this.shouldIntercept(options)) {
      return this.inner.deleteVersion(versionId);
    }

    await this.queue.add(
      this.createOperation(
        "deleteVersion",
        `Delete version ${versionId}`,
        `version:${versionId}:delete`,
        {
          method: "DELETE",
          path: `/versions/${versionId}.json`,
        },
        { resourceId: versionId }
      )
    );
  }

  // ============ Relation Methods ============

  async createRelation(
    issueId: number,
    targetIssueId: number,
    relationType: Parameters<RedmineServer["createRelation"]>[2],
    options?: DraftBypassOptions
  ): ReturnType<RedmineServer["createRelation"]> {
    if (!this.shouldIntercept(options)) {
      return this.inner.createRelation(issueId, targetIssueId, relationType);
    }

    const tempId = generateNumericTempId();
    const tempIdStr = generateTempId("relation");

    await this.queue.add(
      this.createOperation(
        "createRelation",
        `Create ${relationType} relation: #${issueId} → #${targetIssueId}`,
        `relation:create:${tempIdStr}`,
        {
          method: "POST",
          path: `/issues/${issueId}/relations.json`,
          data: {
            relation: {
              issue_to_id: targetIssueId,
              relation_type: relationType,
            },
          },
        },
        { issueId, tempId: tempIdStr }
      )
    );

    return {
      relation: {
        id: tempId,
        issue_id: issueId,
        issue_to_id: targetIssueId,
        relation_type: relationType,
      },
    };
  }

  async deleteRelation(relationId: number, options?: DraftBypassOptions): Promise<unknown> {
    if (!this.shouldIntercept(options)) {
      return this.inner.deleteRelation(relationId);
    }

    await this.queue.add(
      this.createOperation(
        "deleteRelation",
        `Delete relation ${relationId}`,
        `relation:${relationId}:delete`,
        {
          method: "DELETE",
          path: `/relations/${relationId}.json`,
        },
        { resourceId: relationId }
      )
    );

    return null;
  }

  get options() {
    return this.inner.options;
  }

  // ============ Generic HTTP Methods (passthrough) ============

  post<T = unknown>(path: string, data: Record<string, unknown>): Promise<T> {
    return this.inner.post<T>(path, data);
  }

  put<T = unknown>(path: string, data: Record<string, unknown>): Promise<T> {
    return this.inner.put<T>(path, data);
  }

  delete<T = unknown>(path: string): Promise<T> {
    return this.inner.delete<T>(path);
  }
}
