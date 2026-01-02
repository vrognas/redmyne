import { Issue } from "../redmine/models/issue";
import { RedmineProject } from "../redmine/redmine-project";
import { FlexibilityScore } from "./flexibility-calculator";
import { sortIssuesByRisk } from "./issue-sorting";
import { groupBy } from "./collection-utils";
import { formatLocalDate } from "./date-utils";
import { endOfISOWeek } from "date-fns";
import { calculateProjectHealth, ProjectHealth } from "./project-health";

/**
 * Generic node in the hierarchy tree
 */
export interface HierarchyNode {
  type: "project" | "issue" | "container" | "time-group";
  id: number;
  label: string;
  depth: number;
  issue?: Issue;
  children: HierarchyNode[];
  /** Unique key for collapse tracking */
  collapseKey: string;
  /** Parent's collapse key */
  parentKey: string | null;
  /** True if this is a container for children whose parent isn't in the list */
  isContainer?: boolean;
  /** Aggregated hours for containers */
  aggregatedHours?: { spent: number; estimated: number };
  /** Child count for containers */
  childCount?: number;
  /** Individual date ranges from all child issues (for non-continuous aggregate bars) */
  childDateRanges?: Array<{ startDate: string | null; dueDate: string | null; issueId: number }>;
  /** Project name for My Work view (flat list) */
  projectName?: string;
  /** True for external dependencies (blockers not assigned to me) */
  isExternal?: boolean;
  /** Time group category for My Work view */
  timeGroup?: "overdue" | "this-week" | "later" | "no-date";
  /** Icon/emoji for time group headers */
  icon?: string;
  /** Project health metrics (for project nodes) */
  health?: ProjectHealth;
  /** Project description (for project nodes) */
  description?: string;
}

export interface HierarchyOptions {
  /** Group issues by project (adds project header nodes) */
  groupByProject?: boolean;
  /** Include containers for missing parents */
  includeMissingParentContainers?: boolean;
  /** Async function to fetch missing parent issues */
  fetchMissingParents?: (ids: number[]) => Promise<Issue[]>;
}

/**
 * Build hierarchical tree from flat issue list
 * Groups by project (optionally), then organizes parent/child issues
 * Uses sortIssuesByRisk for consistent sorting
 */
export async function buildHierarchy(
  issues: Issue[],
  flexibilityCache: Map<number, FlexibilityScore | null>,
  options: HierarchyOptions = {}
): Promise<HierarchyNode[]> {
  const { groupByProject = true, includeMissingParentContainers = false, fetchMissingParents } = options;

  if (groupByProject) {
    return buildProjectHierarchy(issues, flexibilityCache);
  }

  return buildFlatHierarchy(issues, flexibilityCache, includeMissingParentContainers, fetchMissingParents);
}

/**
 * Build hierarchy grouped by project (for Gantt) - synchronous
 * Uses project hierarchy (parent/child) and shows all projects with issues
 * Projects sorted alphabetically, issues sorted by risk (unless preserveOrder is true)
 * @param preserveOrder If true, preserve incoming issue order within each group (for user sort)
 * @param blockedIds Set of issue IDs that are blocked (for health calculation)
 */
export function buildProjectHierarchy(
  issues: Issue[],
  flexibilityCache: Map<number, FlexibilityScore | null>,
  projects: RedmineProject[] = [],
  preserveOrder = false,
  blockedIds: Set<number> = new Set()
): HierarchyNode[] {
  // Group issues by project
  const issuesByProject = new Map<number, Issue[]>();
  for (const issue of issues) {
    const projectId = issue.project?.id ?? 0;
    if (!issuesByProject.has(projectId)) {
      issuesByProject.set(projectId, []);
    }
    issuesByProject.get(projectId)!.push(issue);
  }

  // Pre-compute project children map (O(n) once instead of O(n) per lookup)
  const projectChildrenMap = new Map<number, RedmineProject[]>();
  for (const p of projects) {
    if (p.parent?.id) {
      if (!projectChildrenMap.has(p.parent.id)) {
        projectChildrenMap.set(p.parent.id, []);
      }
      projectChildrenMap.get(p.parent.id)!.push(p);
    }
  }

  // Collect all child issue date ranges (recursive)
  const collectChildDateRanges = (node: HierarchyNode): Array<{ startDate: string | null; dueDate: string | null; issueId: number }> => {
    const ranges: Array<{ startDate: string | null; dueDate: string | null; issueId: number }> = [];

    // Add this node's issue dates if it has any
    if (node.issue && (node.issue.start_date || node.issue.due_date)) {
      ranges.push({
        startDate: node.issue.start_date ?? null,
        dueDate: node.issue.due_date ?? null,
        issueId: node.issue.id,
      });
    }

    // Recursively collect from children
    for (const child of node.children) {
      ranges.push(...collectChildDateRanges(child));
    }

    return ranges;
  };

  // Collect all issues from node and descendants (for health calculation)
  const collectAllIssues = (node: HierarchyNode): Issue[] => {
    const result: Issue[] = [];
    if (node.issue) {
      result.push(node.issue);
    }
    for (const child of node.children) {
      result.push(...collectAllIssues(child));
    }
    return result;
  };

  // Build project node recursively
  const buildProjectNode = (
    project: RedmineProject,
    parentKey: string | null,
    depth: number
  ): HierarchyNode => {
    const projectId = project.id;
    const projectKey = `project-${projectId}`;
    const projectIssues = issuesByProject.get(projectId) ?? [];

    // Get subprojects (from pre-computed map)
    const subprojects = (projectChildrenMap.get(projectId) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));

    // Build subproject nodes
    const subprojectNodes = subprojects
      .map((sub) => buildProjectNode(sub, projectKey, depth + 1));

    // Build issue tree for this project
    const issueNodes = buildIssueTree(projectIssues, flexibilityCache, projectKey, depth + 1, preserveOrder);

    // Combine: subprojects first, then issues
    const children = [...subprojectNodes, ...issueNodes];

    // Build node first, then calculate aggregate dates
    const node: HierarchyNode = {
      type: "project",
      id: projectId,
      label: project.name,
      depth,
      children,
      collapseKey: projectKey,
      parentKey,
      description: project.description,
    };

    // Collect child date ranges for aggregate bar rendering
    node.childDateRanges = collectChildDateRanges(node);

    // Calculate project health from all descendant issues
    const allIssues = collectAllIssues(node);
    node.health = calculateProjectHealth(allIssues, blockedIds);

    return node;
  };

  // If we have project hierarchy, use it
  if (projects.length > 0) {
    // Get root projects (no parent)
    const rootProjects = projects
      .filter((p) => !p.parent)
      .sort((a, b) => a.name.localeCompare(b.name));

    return rootProjects.map((p) => buildProjectNode(p, null, 0));
  }

  // Fallback: no project hierarchy, group by issue.project (old behavior)
  const projectsFromIssues = new Map<number, string>();
  for (const issue of issues) {
    if (issue.project?.id && issue.project?.name) {
      projectsFromIssues.set(issue.project.id, issue.project.name);
    }
  }

  const sortedProjects = [...projectsFromIssues.entries()].sort(
    (a, b) => a[1].localeCompare(b[1])
  );

  return sortedProjects.map(([projectId, name]) => {
    const projectKey = `project-${projectId}`;
    const projectIssues = issuesByProject.get(projectId) ?? [];
    const issueNodes = buildIssueTree(projectIssues, flexibilityCache, projectKey, 1, preserveOrder);

    const node: HierarchyNode = {
      type: "project" as const,
      id: projectId,
      label: name,
      depth: 0,
      children: issueNodes,
      collapseKey: projectKey,
      parentKey: null,
    };

    // Collect child date ranges for aggregate bar rendering
    node.childDateRanges = collectChildDateRanges(node);

    // Calculate project health
    const allIssues = collectAllIssues(node);
    node.health = calculateProjectHealth(allIssues, blockedIds);

    return node;
  });
}

/**
 * Build flat hierarchy without project grouping (for Issues pane)
 */
async function buildFlatHierarchy(
  issues: Issue[],
  flexibilityCache: Map<number, FlexibilityScore | null>,
  includeMissingParentContainers: boolean,
  fetchMissingParents?: (ids: number[]) => Promise<Issue[]>
): Promise<HierarchyNode[]> {
  const issueMap = new Map(issues.map((i) => [i.id, i]));
  const childrenByParent = groupBy(
    issues.filter((i) => i.parent?.id),
    (i) => i.parent!.id
  );

  // Find missing parent IDs
  const missingParentIds = new Set<number>();
  for (const parentId of childrenByParent.keys()) {
    if (!issueMap.has(parentId)) {
      missingParentIds.add(parentId);
    }
  }

  // Create containers for missing parents
  const containers = new Map<number, HierarchyNode>();
  if (includeMissingParentContainers && missingParentIds.size > 0 && fetchMissingParents) {
    try {
      const parentIssues = await fetchMissingParents(Array.from(missingParentIds));
      for (const parent of parentIssues) {
        const children = childrenByParent.get(parent.id) || [];
        const containerKey = `container-${parent.id}`;
        containers.set(parent.id, {
          type: "container",
          id: parent.id,
          label: parent.subject,
          depth: 0,
          children: [], // Will be filled below
          collapseKey: containerKey,
          parentKey: null,
          isContainer: true,
          childCount: children.length,
          aggregatedHours: {
            spent: children.reduce((s, c) => s + (c.spent_hours ?? 0), 0),
            estimated: children.reduce((s, c) => s + (c.estimated_hours ?? 0), 0),
          },
        });
      }
    } catch {
      // Parent fetch failed - children will be shown at root
    }
  }

  // Build top-level nodes
  const topLevel: HierarchyNode[] = [];

  for (const issue of issues) {
    if (!issue.parent?.id) {
      // Root issue
      const children = buildIssueTreeFromMap(issue.id, childrenByParent, issueMap, flexibilityCache, `issue-${issue.id}`, 1);
      topLevel.push({
        type: "issue",
        id: issue.id,
        label: issue.subject,
        depth: 0,
        issue,
        children,
        collapseKey: `issue-${issue.id}`,
        parentKey: null,
      });
    } else if (issueMap.has(issue.parent.id)) {
      // Parent in list - will be child, skip
      continue;
    } else if (containers.has(issue.parent.id)) {
      // Has container - add to container's children
      const container = containers.get(issue.parent.id)!;
      const children = buildIssueTreeFromMap(issue.id, childrenByParent, issueMap, flexibilityCache, `issue-${issue.id}`, 1);
      container.children.push({
        type: "issue",
        id: issue.id,
        label: issue.subject,
        depth: 1,
        issue,
        children,
        collapseKey: `issue-${issue.id}`,
        parentKey: container.collapseKey,
      });
    } else {
      // Orphan - show at root
      const children = buildIssueTreeFromMap(issue.id, childrenByParent, issueMap, flexibilityCache, `issue-${issue.id}`, 1);
      topLevel.push({
        type: "issue",
        id: issue.id,
        label: issue.subject,
        depth: 0,
        issue,
        children,
        collapseKey: `issue-${issue.id}`,
        parentKey: null,
      });
    }
  }

  // Sort container children
  for (const container of containers.values()) {
    container.children = sortNodesByRisk(container.children, flexibilityCache);
  }

  // Combine: sorted issues + sorted containers
  const sortedIssues = sortNodesByRisk(topLevel, flexibilityCache);
  const sortedContainers = [...containers.values()].sort((a, b) => a.label.localeCompare(b.label));

  return [...sortedIssues, ...sortedContainers];
}

/**
 * Build issue tree within a project/container
 * @param preserveOrder If true, preserve incoming issue order (for user sort)
 */
function buildIssueTree(
  projectIssues: Issue[],
  flexibilityCache: Map<number, FlexibilityScore | null>,
  parentKey: string,
  depth: number,
  preserveOrder = false
): HierarchyNode[] {
  const issueMap = new Map(projectIssues.map((i) => [i.id, i]));
  const childrenByParent = new Map<number | null, Issue[]>();

  // Group by parent (preserving input order)
  for (const issue of projectIssues) {
    const parentId = issue.parent?.id ?? null;
    // Only use parentId if parent is in this project's issues
    const effectiveParent = parentId && issueMap.has(parentId) ? parentId : null;
    if (!childrenByParent.has(effectiveParent)) {
      childrenByParent.set(effectiveParent, []);
    }
    childrenByParent.get(effectiveParent)!.push(issue);
  }

  // Recursively build tree
  function buildChildren(parentId: number | null, pKey: string, d: number): HierarchyNode[] {
    const rawChildren = childrenByParent.get(parentId) || [];
    // Only sort by risk if not preserving order
    const childIssues = preserveOrder ? rawChildren : sortIssuesByRisk(rawChildren, flexibilityCache);
    return childIssues.map((issue) => {
      const issueKey = `issue-${issue.id}`;
      const hasChildren = childrenByParent.has(issue.id) && childrenByParent.get(issue.id)!.length > 0;
      const children = hasChildren ? buildChildren(issue.id, issueKey, d + 1) : [];

      return {
        type: "issue" as const,
        id: issue.id,
        label: issue.subject,
        depth: d,
        issue,
        children,
        collapseKey: issueKey,
        parentKey: pKey,
      };
    });
  }

  return buildChildren(null, parentKey, depth);
}

/**
 * Build issue tree from pre-computed maps
 */
function buildIssueTreeFromMap(
  parentId: number,
  childrenByParent: Map<number, Issue[]>,
  issueMap: Map<number, Issue>,
  flexibilityCache: Map<number, FlexibilityScore | null>,
  parentKey: string,
  depth: number
): HierarchyNode[] {
  const childIssues = sortIssuesByRisk(childrenByParent.get(parentId) || [], flexibilityCache);
  return childIssues.map((issue) => {
    const issueKey = `issue-${issue.id}`;
    const children = buildIssueTreeFromMap(issue.id, childrenByParent, issueMap, flexibilityCache, issueKey, depth + 1);
    return {
      type: "issue" as const,
      id: issue.id,
      label: issue.subject,
      depth,
      issue,
      children,
      collapseKey: issueKey,
      parentKey,
    };
  });
}

/**
 * Sort nodes by risk (using underlying issues)
 */
function sortNodesByRisk(
  nodes: HierarchyNode[],
  flexibilityCache: Map<number, FlexibilityScore | null>
): HierarchyNode[] {
  const issueNodes = nodes.filter((n) => n.issue);
  const sortedIssues = sortIssuesByRisk(
    issueNodes.map((n) => n.issue!),
    flexibilityCache
  );
  const sortedIssueIds = new Set(sortedIssues.map((i) => i.id));

  // Map back to nodes in sorted order
  const result: HierarchyNode[] = [];
  for (const issue of sortedIssues) {
    const node = issueNodes.find((n) => n.issue!.id === issue.id);
    if (node) result.push(node);
  }
  // Add any non-issue nodes at the end
  for (const node of nodes) {
    if (!node.issue && !sortedIssueIds.has(node.id)) {
      result.push(node);
    }
  }
  return result;
}

/**
 * Time group definition for My Work view
 */
interface TimeGroupDef {
  key: "overdue" | "this-week" | "later" | "no-date";
  label: string;
  icon: string;
}

const TIME_GROUPS: TimeGroupDef[] = [
  { key: "overdue", label: "Overdue", icon: "🔴" },
  { key: "this-week", label: "Due This Week", icon: "🟡" },
  { key: "later", label: "Due Later", icon: "🟢" },
  { key: "no-date", label: "No Due Date", icon: "📋" },
];

/**
 * Classify issue into time group based on due_date
 */
function classifyIssueTimeGroup(
  issue: Issue,
  today: string,
  weekEnd: string
): TimeGroupDef["key"] {
  const dueDate = issue.due_date;
  if (!dueDate) return "no-date";
  if (dueDate < today) return "overdue";
  if (dueDate <= weekEnd) return "this-week";
  return "later";
}

/**
 * Build hierarchy for "My Work" view with time-based grouping
 * Groups: Overdue → Due This Week → Due Later → No Due Date
 * Within each group: sorted by due_date ascending, external deps last
 */
export function buildMyWorkHierarchy(
  issues: Issue[],
  _flexibilityCache: Map<number, FlexibilityScore | null>,
  externalIssues: Issue[] = []
): HierarchyNode[] {
  // Combine my issues and external dependencies
  const allIssues = [...issues, ...externalIssues];
  if (allIssues.length === 0) return [];

  // Track which are external
  const externalIds = new Set(externalIssues.map((i) => i.id));

  // Calculate date boundaries
  const today = formatLocalDate(new Date());
  const weekEnd = formatLocalDate(endOfISOWeek(new Date()));

  // Group issues by time category
  const grouped = new Map<TimeGroupDef["key"], Issue[]>();
  for (const group of TIME_GROUPS) {
    grouped.set(group.key, []);
  }

  for (const issue of allIssues) {
    const groupKey = classifyIssueTimeGroup(issue, today, weekEnd);
    grouped.get(groupKey)!.push(issue);
  }

  // Sort issues within each group: by due_date, external last
  const sortGroupIssues = (groupIssues: Issue[]): Issue[] => {
    return [...groupIssues].sort((a, b) => {
      const aExternal = externalIds.has(a.id);
      const bExternal = externalIds.has(b.id);

      // External issues go after my issues
      if (aExternal !== bExternal) return aExternal ? 1 : -1;

      // Sort by due_date (nulls last within group)
      const aDate = a.due_date ?? "9999-12-31";
      const bDate = b.due_date ?? "9999-12-31";
      return aDate.localeCompare(bDate);
    });
  };

  // Build hierarchy: time groups as parents, issues as children
  const result: HierarchyNode[] = [];

  for (const groupDef of TIME_GROUPS) {
    const groupIssues = grouped.get(groupDef.key)!;
    if (groupIssues.length === 0) continue; // Skip empty groups

    const sortedIssues = sortGroupIssues(groupIssues);
    const groupKey = `time-group-${groupDef.key}`;

    // Create child nodes
    const children: HierarchyNode[] = sortedIssues.map((issue): HierarchyNode => ({
      type: "issue",
      id: issue.id,
      label: issue.subject,
      depth: 1,
      issue,
      children: [],
      collapseKey: `issue-${issue.id}`,
      parentKey: groupKey,
      projectName: issue.project?.name ?? "Unknown",
      isExternal: externalIds.has(issue.id),
    }));

    // Collect child date ranges for aggregate bar
    const childDateRanges = sortedIssues
      .filter((i) => i.start_date || i.due_date)
      .map((i) => ({
        startDate: i.start_date ?? null,
        dueDate: i.due_date ?? null,
        issueId: i.id,
      }));

    // Calculate aggregated hours
    const aggregatedHours = {
      spent: sortedIssues.reduce((s, i) => s + (i.spent_hours ?? 0), 0),
      estimated: sortedIssues.reduce((s, i) => s + (i.estimated_hours ?? 0), 0),
    };

    // Create group node
    result.push({
      type: "time-group",
      id: TIME_GROUPS.indexOf(groupDef), // Use index as pseudo-ID
      label: groupDef.label,
      depth: 0,
      children,
      collapseKey: groupKey,
      parentKey: null,
      timeGroup: groupDef.key,
      icon: groupDef.icon,
      childCount: children.length,
      childDateRanges,
      aggregatedHours,
    });
  }

  return result;
}

/**
 * Flatten hierarchy tree to array (for rendering)
 * Shows children only if parent is EXPANDED (in expandedKeys set)
 * Default = collapsed (not in set)
 */
export function flattenHierarchy(
  nodes: HierarchyNode[],
  expandedKeys: Set<string> = new Set()
): HierarchyNode[] {
  const result: HierarchyNode[] = [];

  function traverse(nodeList: HierarchyNode[], parentExpanded: boolean) {
    for (const node of nodeList) {
      if (!parentExpanded) continue;
      result.push(node);

      const isExpanded = expandedKeys.has(node.collapseKey);
      if (node.children.length > 0) {
        traverse(node.children, isExpanded);
      }
    }
  }

  // Start with parentExpanded=true so top-level nodes are always visible
  traverse(nodes, true);
  return result;
}

/**
 * Node with visibility info for client-side collapse management
 */
export interface FlatNodeWithVisibility extends HierarchyNode {
  /** Whether this node is visible (based on parent expand state) */
  isVisible: boolean;
  /** Whether this node itself is expanded */
  isExpanded: boolean;
}

/**
 * Flatten hierarchy returning ALL nodes with visibility flags
 * Used for client-side collapse/expand to avoid full re-renders
 */
export function flattenHierarchyAll(
  nodes: HierarchyNode[],
  expandedKeys: Set<string> = new Set()
): FlatNodeWithVisibility[] {
  const result: FlatNodeWithVisibility[] = [];

  function traverse(nodeList: HierarchyNode[], parentVisible: boolean) {
    for (const node of nodeList) {
      const isExpanded = expandedKeys.has(node.collapseKey);
      result.push({
        ...node,
        isVisible: parentVisible,
        isExpanded,
      });

      if (node.children.length > 0) {
        // Children visible only if this node is visible AND expanded
        traverse(node.children, parentVisible && isExpanded);
      }
    }
  }

  // Top-level nodes are always visible
  traverse(nodes, true);
  return result;
}
