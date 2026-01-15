import { Issue } from "../redmine/models/issue";
import { FlexibilityScore } from "../utilities/flexibility-calculator";
import { adHocTracker } from "../utilities/adhoc-tracker";
import { ProjectHealth } from "../utilities/project-health";
import {
  DependencyGraph,
  countDownstream,
  getDownstream,
  getBlockers,
} from "../utilities/dependency-graph";
import { FlatNodeWithVisibility } from "../utilities/hierarchy-builder";

// Redmine relation types (creatable via API)
export type CreatableRelationType =
  | "relates"
  | "duplicates"
  | "blocks"
  | "precedes"
  | "follows"
  | "copied_to";
// All relation types (including inverse types returned by API)
export type RelationType = CreatableRelationType | "blocked";

export interface GanttRelation {
  id: number;
  targetId: number;
  type: RelationType;
}

export interface GanttIssue {
  id: number;
  subject: string;
  start_date: string | null;
  due_date: string | null;
  status: FlexibilityScore["status"] | null;
  /** Redmine status name (e.g., "New", "In Progress", "Closed") */
  statusName: string;
  /** Flexibility slack in days (positive = buffer, 0/negative = critical) */
  flexibilitySlack: number | null;
  isClosed: boolean;
  project: string;
  projectId: number;
  parentId: number | null;
  estimated_hours: number | null;
  spent_hours: number | null;
  done_ratio: number;
  relations: GanttRelation[];
  assignee: string | null;
  assigneeId: number | null;
  /** True for external dependencies (blockers not assigned to me) */
  isExternal?: boolean;
  /** Count of issues that depend on this (transitively) */
  downstreamCount: number;
  /** Open issues blocked by this one (direct) */
  blocks: Array<{ id: number; subject: string; assignee: string | null }>;
  /** Open issues blocking this one */
  blockedBy: Array<{ id: number; subject: string; assignee: string | null }>;
  /** True if this issue is tagged as an ad-hoc budget pool */
  isAdHoc?: boolean;
  /** Priority name from Redmine */
  priorityName: string;
  /** Priority ID for filtering/sorting */
  priorityId: number;
}

export interface GanttRow {
  type: "project" | "issue" | "time-group";
  id: number;
  label: string;
  depth: number;
  issue?: GanttIssue;
  /** True if this issue has subtasks (dates/hours are derived) */
  isParent?: boolean;
  /** Unique key for collapse tracking (project-{id} or issue-{id}) */
  collapseKey: string;
  /** Parent's collapse key (for filtering hidden rows) */
  parentKey: string | null;
  /** True if has children (can be collapsed) */
  hasChildren: boolean;
  /** Child issue date ranges for aggregate bar rendering (projects only) */
  childDateRanges?: Array<{ startDate: string | null; dueDate: string | null; issueId: number }>;
  /** Whether this row is visible (based on parent collapse state) - for client-side collapse */
  isVisible: boolean;
  /** Whether this row is expanded (if it has children) - for client-side collapse */
  isExpanded: boolean;
  /** Project name for My Work view (shown as badge) */
  projectName?: string;
  /** Time group category for My Work view */
  timeGroup?: "overdue" | "this-week" | "later" | "no-date";
  /** Icon for time-group headers */
  icon?: string;
  /** Child count for group headers */
  childCount?: number;
  /** Project health metrics (for project rows) */
  health?: ProjectHealth;
  /** Project description (for project rows) */
  description?: string;
  /** Project identifier (for project rows) */
  identifier?: string;
}

/**
 * Convert Issue to GanttIssue for SVG rendering.
 */
export function toGanttIssue(
  issue: Issue,
  flexibilityCache: Map<number, FlexibilityScore | null>,
  closedStatusIds: Set<number>,
  depGraph: DependencyGraph | null,
  issueMap: Map<number, Issue> | null,
  isExternal = false
): GanttIssue {
  // Check if closed via status ID, or fallback to status name containing "closed"
  const isClosedById = closedStatusIds.has(issue.status?.id ?? 0);
  const isClosedByName = issue.status?.name?.toLowerCase().includes("closed") ?? false;
  const flexibility = flexibilityCache.get(issue.id);

  // Calculate downstream impact and blockers if graph available
  const downstreamCount = depGraph ? countDownstream(issue.id, depGraph) : 0;
  const blockedIssues = depGraph && issueMap
    ? getDownstream(issue.id, depGraph, issueMap).map(b => ({
        id: b.id,
        subject: b.subject,
        assignee: b.assignee,
      }))
    : [];
  const blockers = depGraph && issueMap
    ? getBlockers(issue.id, depGraph, issueMap).map(b => ({
        id: b.id,
        subject: b.subject,
        assignee: b.assignee,
      }))
    : [];

  return {
    id: issue.id,
    subject: issue.subject,
    start_date: issue.start_date || null,
    due_date: issue.due_date || null,
    status: flexibility?.status ?? null,
    statusName: issue.status?.name ?? "Unknown",
    // Calculate days of slack: daysRemaining - (hoursRemaining / 8)
    // This gives actual buffer in working days, not percentage
    flexibilitySlack: flexibility
      ? Math.round(flexibility.daysRemaining - flexibility.hoursRemaining / 8)
      : null,
    isClosed: isClosedById || isClosedByName,
    project: issue.project?.name ?? "Unknown",
    projectId: issue.project?.id ?? 0,
    parentId: issue.parent?.id ?? null,
    estimated_hours: issue.estimated_hours ?? null,
    spent_hours: issue.spent_hours ?? null,
    done_ratio: issue.done_ratio ?? 0,
    relations: (issue.relations || [])
      .filter((r) => {
        // Combined filter: exclude reverse relation types AND self-references
        const type = r.relation_type;
        return type !== "blocked" && type !== "duplicated" &&
               type !== "copied_from" && type !== "follows" &&
               r.issue_to_id !== issue.id && r.issue_id !== r.issue_to_id;
      })
      .map((r) => ({
        id: r.id,
        targetId: r.issue_to_id,
        type: r.relation_type as RelationType,
      })),
    assignee: issue.assigned_to?.name ?? null,
    assigneeId: issue.assigned_to?.id ?? null,
    isExternal,
    downstreamCount,
    blocks: blockedIssues,
    blockedBy: blockers,
    isAdHoc: adHocTracker.isAdHoc(issue.id),
    priorityName: issue.priority?.name ?? "Unknown",
    priorityId: issue.priority?.id ?? 0,
  };
}

/**
 * Convert FlatNodeWithVisibility to GanttRow for SVG rendering.
 */
export function nodeToGanttRow(
  node: FlatNodeWithVisibility,
  flexibilityCache: Map<number, FlexibilityScore | null>,
  closedStatusIds: Set<number>,
  depGraph: DependencyGraph | null,
  issueMap: Map<number, Issue> | null
): GanttRow {
  if (node.type === "project") {
    return {
      type: "project",
      id: node.id,
      label: node.label,
      depth: node.depth,
      collapseKey: node.collapseKey,
      parentKey: node.parentKey,
      hasChildren: node.children.length > 0,
      childDateRanges: node.childDateRanges,
      isVisible: node.isVisible,
      isExpanded: node.isExpanded,
      health: node.health,
      description: node.description,
      identifier: node.identifier,
    };
  }

  if (node.type === "time-group") {
    return {
      type: "time-group",
      id: node.id,
      label: node.label,
      depth: node.depth,
      collapseKey: node.collapseKey,
      parentKey: node.parentKey,
      hasChildren: node.children.length > 0,
      isVisible: node.isVisible,
      isExpanded: node.isExpanded,
      timeGroup: node.timeGroup,
      icon: node.icon,
      childCount: node.childCount,
    };
  }

  // Container nodes (orphan issue placeholders) render like projects
  if (node.type === "container") {
    return {
      type: "project",
      id: node.id,
      label: node.label,
      depth: node.depth,
      collapseKey: node.collapseKey,
      parentKey: node.parentKey,
      hasChildren: node.children.length > 0,
      childDateRanges: node.childDateRanges,
      isVisible: node.isVisible,
      isExpanded: node.isExpanded,
    };
  }

  const issue = node.issue!;
  return {
    type: "issue",
    id: node.id,
    label: node.label,
    depth: node.depth,
    issue: toGanttIssue(issue, flexibilityCache, closedStatusIds, depGraph, issueMap, node.isExternal),
    isParent: node.children.length > 0,
    collapseKey: node.collapseKey,
    parentKey: node.parentKey,
    hasChildren: node.children.length > 0,
    isVisible: node.isVisible,
    isExpanded: node.isExpanded,
    projectName: node.projectName,
  };
}
