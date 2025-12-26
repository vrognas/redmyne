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

export interface TimeEntryActivity extends NamedEntity {
  is_default?: boolean;
}

/**
 * Filter options for issue queries
 * Designed for common use cases - keeps UI simple
 */
export interface IssueFilter {
  assignee: "me" | "any";
  status: "open" | "closed" | "any";
}

/**
 * Default filter: my open issues
 */
export const DEFAULT_ISSUE_FILTER: IssueFilter = {
  assignee: "me",
  status: "open",
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
