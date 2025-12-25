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
