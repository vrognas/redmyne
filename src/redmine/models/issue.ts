import { NamedEntity } from "./named-entity";

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
    | "copied_from";
  delay?: number; // days, for precedes/follows
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
  status: NamedEntity;
  priority: NamedEntity;
  author: NamedEntity;
  assigned_to: NamedEntity;
  subject: string;
  description: string;
  start_date: string;
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
}
