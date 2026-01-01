import { NamedEntity } from "./common";

/**
 * Redmine Version (Milestone)
 * Represents a target release/milestone that issues can be assigned to
 */
export interface Version {
  id: number;
  project: NamedEntity;
  name: string;
  description: string;
  /** open | locked | closed */
  status: "open" | "locked" | "closed";
  /** Target date for this version/milestone */
  due_date: string | null;
  /**
   * Sharing scope:
   * - none: Not shared
   * - descendants: Shared with subprojects
   * - hierarchy: Shared with project tree
   * - tree: Shared with project tree (root up)
   * - system: Shared with all projects
   */
  sharing: "none" | "descendants" | "hierarchy" | "tree" | "system";
  /** Wiki page linked to this version */
  wiki_page_title?: string;
  /** Aggregated estimated hours from issues */
  estimated_hours?: number;
  /** Aggregated spent hours from issues */
  spent_hours?: number;
  created_on: string;
  updated_on: string;
}

/**
 * Version reference on an Issue (fixed_version field)
 */
export interface VersionRef {
  id: number;
  name: string;
}
