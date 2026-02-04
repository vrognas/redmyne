/**
 * Common type definitions used across Redmine models
 */

export interface NamedEntity {
  id: number;
  name: string;
}

export interface IssueStatus extends NamedEntity {
  is_closed: boolean;
}

export interface IssuePriority extends NamedEntity {
  is_default?: boolean;
}

export interface TimeEntryActivity extends NamedEntity {
  is_default?: boolean;
}

/**
 * Custom field from Redmine API
 */
export interface CustomField {
  id: number;
  name: string;
  multiple?: boolean;
  value: unknown; // API can return string, string[], number, boolean, null
}

/**
 * Filter options for issue queries
 * Designed for common use cases - keeps UI simple
 */
export interface IssueFilter {
  assignee: "me" | "any";
  status: "open" | "closed" | "any";
  priority?: number | "any";
  showEmptyProjects?: boolean;
}

/**
 * Default filter: no filter (show all projects including empty)
 */
export const DEFAULT_ISSUE_FILTER: IssueFilter = {
  assignee: "any",
  status: "any",
  showEmptyProjects: true,
};

/**
 * Sort configuration
 */
export interface SortConfig<T extends string = string> {
  field: T;
  direction: "asc" | "desc";
}

/**
 * Sort fields for Issues view
 */
export type IssueSortField = "id" | "subject" | "assignee";

/**
 * Sort fields for Time Entries view
 */
export type TimeEntrySortField = "id" | "subject" | "comment" | "user";

/**
 * Gantt view mode
 * - projects: Group by project hierarchy (default)
 * - mywork: Flat list sorted by date (personal capacity view)
 */
export type GanttViewMode = "projects" | "mywork";
