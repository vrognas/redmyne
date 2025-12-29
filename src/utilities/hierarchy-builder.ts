import { Issue } from "../redmine/models/issue";
import { RedmineProject } from "../redmine/redmine-project";
import { FlexibilityScore } from "./flexibility-calculator";
import { sortIssuesByRisk } from "./issue-sorting";
import { groupBy } from "./collection-utils";

/**
 * Generic node in the hierarchy tree
 */
export interface HierarchyNode {
  type: "project" | "issue" | "container";
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
 * Projects sorted alphabetically, issues sorted by risk
 */
export function buildProjectHierarchy(
  issues: Issue[],
  flexibilityCache: Map<number, FlexibilityScore | null>,
  projects: RedmineProject[] = []
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

  // Count issues including subprojects (for showing parent projects)
  const countIssuesWithSubprojects = (projectId: number): number => {
    const direct = issuesByProject.get(projectId)?.length ?? 0;
    const subprojects = projectChildrenMap.get(projectId) ?? [];
    const subCount = subprojects.reduce(
      (sum, sub) => sum + countIssuesWithSubprojects(sub.id),
      0
    );
    return direct + subCount;
  };

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

  // Build project node recursively
  const buildProjectNode = (
    project: RedmineProject,
    parentKey: string | null,
    depth: number
  ): HierarchyNode | null => {
    const projectId = project.id;
    const projectKey = `project-${projectId}`;
    const projectIssues = issuesByProject.get(projectId) ?? [];
    const totalIssues = countIssuesWithSubprojects(projectId);

    // Skip projects with no issues (direct or in subprojects)
    if (totalIssues === 0) return null;

    // Get subprojects (from pre-computed map)
    const subprojects = (projectChildrenMap.get(projectId) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));

    // Build subproject nodes
    const subprojectNodes = subprojects
      .map((sub) => buildProjectNode(sub, projectKey, depth + 1))
      .filter((n): n is HierarchyNode => n !== null);

    // Build issue tree for this project
    const issueNodes = buildIssueTree(projectIssues, flexibilityCache, projectKey, depth + 1);

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
    };

    // Collect child date ranges for aggregate bar rendering
    node.childDateRanges = collectChildDateRanges(node);

    return node;
  };

  // If we have project hierarchy, use it
  if (projects.length > 0) {
    // Get root projects (no parent)
    const rootProjects = projects
      .filter((p) => !p.parent)
      .sort((a, b) => a.name.localeCompare(b.name));

    const nodes = rootProjects
      .map((p) => buildProjectNode(p, null, 0))
      .filter((n): n is HierarchyNode => n !== null);

    // Also add projects from issues that aren't in the projects list
    // (e.g., closed/archived projects that still have issues)
    const projectIdsInList = new Set(projects.map((p) => p.id));
    const orphanProjects = new Map<number, string>();
    for (const issue of issues) {
      if (issue.project?.id && !projectIdsInList.has(issue.project.id)) {
        orphanProjects.set(issue.project.id, issue.project.name);
      }
    }

    // Add orphan projects as root nodes
    const orphanNodes = [...orphanProjects.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([projectId, name]) => {
        const projectKey = `project-${projectId}`;
        const projectIssues = issuesByProject.get(projectId) ?? [];
        const issueNodes = buildIssueTree(projectIssues, flexibilityCache, projectKey, 1);

        const node: HierarchyNode = {
          type: "project" as const,
          id: projectId,
          label: name,
          depth: 0,
          children: issueNodes,
          collapseKey: projectKey,
          parentKey: null,
        };

        node.childDateRanges = collectChildDateRanges(node);
        return node;
      });

    return [...nodes, ...orphanNodes].sort((a, b) => a.label.localeCompare(b.label));
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
    const issueNodes = buildIssueTree(projectIssues, flexibilityCache, projectKey, 1);

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
 */
function buildIssueTree(
  projectIssues: Issue[],
  flexibilityCache: Map<number, FlexibilityScore | null>,
  parentKey: string,
  depth: number
): HierarchyNode[] {
  const issueMap = new Map(projectIssues.map((i) => [i.id, i]));
  const childrenByParent = new Map<number | null, Issue[]>();

  // Group by parent
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
    const childIssues = sortIssuesByRisk(childrenByParent.get(parentId) || [], flexibilityCache);
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
