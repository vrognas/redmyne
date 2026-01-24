import { NamedEntity, IssueStatus, CustomField } from "./common";
import { VersionRef } from "./version";

/**
 * Single field change in a journal entry
 */
export interface JournalDetail {
  property: "attr" | "cf" | "attachment" | "relation";
  name: string;
  old_value?: string;
  new_value?: string;
}

/**
 * Journal entry = a single update/comment on an issue
 * Captures who changed what, when, and optional notes
 */
export interface Journal {
  id: number;
  user: NamedEntity;
  notes: string;
  created_on: string;
  private_notes: boolean;
  details: JournalDetail[];
}

/**
 * Redmine issue relation (from include=relations)
 * Relations are DIRECTIONAL - blocked != blocks
 */
export interface IssueRelation {
  id: number;
  issue_id: number;
  issue_to_id: number;
  relation_type:
    | "relates"
    | "duplicates"
    | "duplicated"
    | "blocks"
    | "blocked"
    | "precedes"
    | "follows"
    | "copied_to"
    | "copied_from"
    // Extended scheduling types (requires Gantt plugin)
    | "finish_to_start"
    | "start_to_start"
    | "finish_to_finish"
    | "start_to_finish";
  delay?: number; // days, for scheduling types
}

/**
 * Child issue summary (from include=children)
 * Contains subset of Issue fields
 */
export interface ChildIssue {
  id: number;
  subject: string;
  tracker?: NamedEntity;
}

export interface Issue {
  id: number;
  project: NamedEntity;
  tracker: NamedEntity;
  status: IssueStatus;
  priority: NamedEntity;
  author: NamedEntity;
  assigned_to: NamedEntity;
  subject: string;
  description: string;
  start_date: string | null;
  due_date: string | null;
  done_ratio: number;
  is_private: boolean;
  estimated_hours: number | null;
  /** Hours spent on this issue directly (Redmine API returns this) */
  spent_hours?: number;
  /** Total hours including subtasks (Redmine API returns this) */
  total_spent_hours?: number;
  created_on: string;
  updated_on: string;
  closed_on: string | null;

  /** Parent issue reference (from API - only id) */
  parent?: { id: number };
  /** Child issues (from include=children) */
  children?: ChildIssue[];
  /** Issue relations (from include=relations) */
  relations?: IssueRelation[];
  /** Journal entries (from include=journals) - updates/comments history */
  journals?: Journal[];
  /** Target version/milestone for this issue */
  fixed_version?: VersionRef;
  /** Custom fields (from API - requires custom fields to be enabled) */
  custom_fields?: CustomField[];
}
