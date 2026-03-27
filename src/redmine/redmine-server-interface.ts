/**
 * Interface for Redmine server operations.
 * Implemented by RedmineServer (real HTTP) and DraftModeServer (offline queueing).
 * Consumers should depend on this interface, not the concrete class.
 */

import type { RedmineProject } from "./redmine-project";
import type { RedmineServerConnectionOptions } from "./redmine-server";
import type {
  IssueStatus,
  Membership,
  QuickUpdate,
  QuickUpdateResult,
} from "../controllers/domain";
import type { TimeEntryActivity } from "./models/common";
import type { IssueStatus as RedmineIssueStatus, IssuePriority } from "./models/common";
import type { TimeEntry } from "./models/time-entry";
import type { Issue } from "./models/issue";
import type { Version } from "./models/version";
import type { CustomFieldDefinition, TimeEntryCustomFieldValue } from "./models/custom-field-definition";

export interface IRedmineServer {
  readonly options: RedmineServerConnectionOptions & { url: URL };

  // ============ Projects ============

  getProjects(): Promise<RedmineProject[]>;
  clearProjectsCache(): void;

  // ============ Issues — read ============

  getIssueById(issueId: number): Promise<{ issue: Issue }>;
  getIssueWithJournals(issueId: number): Promise<{ issue: Issue }>;
  getIssuesByIds(ids: number[], skipClosed?: boolean): Promise<Issue[]>;
  getFilteredIssues(filter: {
    assignee: "me" | "any";
    status: "open" | "closed" | "any";
    priority?: number | "any";
  }): Promise<{ issues: Issue[] }>;
  getIssuesAssignedToMe(): Promise<{ issues: Issue[] }>;
  getAllOpenIssues(): Promise<{ issues: Issue[] }>;
  getOpenIssuesForProject(
    project_id: number | string,
    include_subproject?: boolean,
    limit?: number,
    openOnly?: boolean
  ): Promise<{ issues: Issue[] }>;
  searchIssues(query: string, limit?: number): Promise<Issue[]>;

  // ============ Issues — write ============

  createIssue(issue: {
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
  }): Promise<{ issue: Issue }>;
  setIssueStatus(issue: Pick<Issue, "id">, statusId: number): Promise<unknown>;
  updateIssueDates(
    issueId: number,
    startDate: string | null,
    dueDate: string | null
  ): Promise<unknown>;
  updateDoneRatio(issueId: number, doneRatio: number): Promise<unknown>;
  setIssuePriority(issueId: number, priorityId: number): Promise<void>;
  applyQuickUpdate(quickUpdate: QuickUpdate): Promise<QuickUpdateResult>;

  // ============ Time entries — read ============

  getTimeEntries(params?: {
    from?: string;
    to?: string;
    allUsers?: boolean;
  }): Promise<{ time_entries: TimeEntry[] }>;
  getProjectTimeEntries(projectId: number | string): Promise<TimeEntry[]>;
  getAllTimeEntries(): Promise<TimeEntry[]>;
  getTimeEntriesForIssues(
    issueIds: number[],
    options?: { userId?: number; from?: string; to?: string }
  ): Promise<TimeEntry[]>;
  getTimeEntryActivities(): Promise<{
    time_entry_activities: TimeEntryActivity[];
  }>;
  getProjectTimeEntryActivities(
    projectId: number | string
  ): Promise<TimeEntryActivity[]>;
  getTimeEntryCustomFields(): Promise<CustomFieldDefinition[]>;
  getTimeEntryById(id: number): Promise<{ time_entry: TimeEntry }>;

  // ============ Time entries — write ============

  addTimeEntry(
    issueId: number,
    activityId: number,
    hours: string,
    message: string,
    spentOn?: string,
    customFields?: TimeEntryCustomFieldValue[]
  ): Promise<{ time_entry: TimeEntry }>;
  updateTimeEntry(
    id: number,
    updates: {
      hours?: string;
      comments?: string;
      activity_id?: number;
      spent_on?: string;
      issue_id?: number;
      custom_fields?: TimeEntryCustomFieldValue[];
    }
  ): Promise<void>;
  deleteTimeEntry(id: number): Promise<void>;

  // ============ Versions ============

  getProjectVersions(projectId: number | string): Promise<Version[]>;
  getVersionsForProjects(
    projectIds: (number | string)[]
  ): Promise<Map<number | string, Version[]>>;
  createVersion(
    projectId: number | string,
    version: {
      name: string;
      description?: string;
      status?: "open" | "locked" | "closed";
      sharing?: "none" | "descendants" | "hierarchy" | "tree" | "system";
      due_date?: string;
      wiki_page_title?: string;
    }
  ): Promise<Version>;
  updateVersion(
    versionId: number,
    version: {
      name?: string;
      description?: string;
      status?: "open" | "locked" | "closed";
      sharing?: "none" | "descendants" | "hierarchy" | "tree" | "system";
      due_date?: string | null;
      wiki_page_title?: string;
    }
  ): Promise<void>;
  deleteVersion(versionId: number): Promise<void>;

  // ============ Statuses & priorities ============

  getIssueStatuses(): Promise<{ issue_statuses: RedmineIssueStatus[] }>;
  getIssueStatusesTyped(): Promise<IssueStatus[]>;
  getIssuePriorities(): Promise<{ issue_priorities: IssuePriority[] }>;
  getPriorities(): Promise<{ id: number; name: string }[]>;
  getTrackers(): Promise<{ id: number; name: string }[]>;

  // ============ Users ============

  getCurrentUser(): Promise<
    | {
        id: number;
        login: string;
        firstname: string;
        lastname: string;
        mail: string;
        created_on: string;
        last_login_on?: string;
        custom_fields?: { id: number; name: string; value: string }[];
      }
    | undefined
  >;
  getUserFte(userId: number): Promise<number>;
  getUserFteBatch(userIds: number[]): Promise<Map<number, number>>;

  // ============ Custom fields & memberships ============

  getCustomFields(): Promise<
    {
      id: number;
      name: string;
      customized_type: string;
      field_format: string;
      possible_values?: { value: string; label?: string }[];
    }[]
  >;
  getMemberships(projectId: number): Promise<Membership[]>;

  // ============ Misc ============

  isTimeTrackingEnabled(projectId: number | string): Promise<boolean>;
  compare(other: IRedmineServer): boolean;

  // ============ Relations ============

  createRelation(
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
  ): Promise<{
    relation: {
      id: number;
      issue_id: number;
      issue_to_id: number;
      relation_type: string;
      delay?: number;
    };
  }>;
  deleteRelation(relationId: number): Promise<unknown>;

  // ============ Generic HTTP ============

  post<T = unknown>(path: string, data: Record<string, unknown>): Promise<T>;
  put<T = unknown>(path: string, data: Record<string, unknown>): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
}
