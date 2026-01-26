import { Issue } from "../redmine/models/issue";
import { IssueFilter } from "../redmine/models/common";
import { RedmineProject } from "../redmine/redmine-project";

export interface AssigneeState {
  uniqueAssignees: string[];
  currentUserName: string | null;
}

export function deriveAssigneeState(
  issues: Issue[],
  currentUserId: number | null,
  currentUserName: string | null
): AssigneeState {
  const assigneeSet = new Set<string>();
  let resolvedCurrentUserName = currentUserName;

  for (const issue of issues) {
    const assigneeName = issue.assigned_to?.name;
    if (!assigneeName) continue;
    assigneeSet.add(assigneeName);
    if (resolvedCurrentUserName === null && currentUserId !== null && issue.assigned_to?.id === currentUserId) {
      resolvedCurrentUserName = assigneeName;
    }
  }

  const uniqueAssignees = [...assigneeSet].sort((a, b) => {
    if (a === resolvedCurrentUserName) return -1;
    if (b === resolvedCurrentUserName) return 1;
    return a.localeCompare(b);
  });

  return { uniqueAssignees, currentUserName: resolvedCurrentUserName };
}

export interface ViewFilterResult {
  filteredIssues: Issue[];
  selectedAssignee: string | null;
  selectedProjectId: number | null;
}

export function filterIssuesForView(options: {
  issues: Issue[];
  projects: RedmineProject[];
  viewFocus: "person" | "project";
  selectedAssignee: string | null;
  currentUserName: string | null;
  uniqueAssignees: string[];
  selectedProjectId: number | null;
  currentFilter: IssueFilter;
  currentUserId: number | null;
}): ViewFilterResult {
  if (options.viewFocus === "person") {
    const effectiveAssignee = options.selectedAssignee
      ?? options.currentUserName
      ?? options.uniqueAssignees[0]
      ?? null;
    const nextSelectedAssignee = effectiveAssignee && effectiveAssignee !== options.selectedAssignee
      ? effectiveAssignee
      : options.selectedAssignee;
    const filteredIssues = effectiveAssignee
      ? options.issues.filter((issue) => issue.assigned_to?.name === effectiveAssignee)
      : options.issues;
    return {
      filteredIssues,
      selectedAssignee: nextSelectedAssignee,
      selectedProjectId: options.selectedProjectId,
    };
  }

  // null = "All Projects" - don't force a specific project
  // Only validate if a specific project is selected
  const effectiveProjectId = options.selectedProjectId === null
    ? null
    : options.projects.some(p => p.id === options.selectedProjectId)
      ? options.selectedProjectId
      : (options.projects[0]?.id ?? null);
  const nextSelectedProjectId = effectiveProjectId;

  let filteredIssues = options.issues;
  if (effectiveProjectId !== null) {
    const projectIdsToInclude = collectProjectIds(options.projects, effectiveProjectId);
    if (projectIdsToInclude.size > 0) {
      filteredIssues = options.issues.filter((issue) =>
        issue.project?.id !== undefined && projectIdsToInclude.has(issue.project.id)
      );
    }
  }

  if (options.currentFilter.assignee === "me" && options.currentUserId !== null) {
    filteredIssues = filteredIssues.filter((issue) => issue.assigned_to?.id === options.currentUserId);
  }

  return {
    filteredIssues,
    selectedAssignee: options.selectedAssignee,
    selectedProjectId: nextSelectedProjectId,
  };
}

function collectProjectIds(projects: RedmineProject[], rootId: number): Set<number> {
  // Build parent-to-children map once: O(n)
  const childrenMap = new Map<number, number[]>();
  for (const project of projects) {
    const parentId = project.parent?.id;
    if (parentId !== undefined) {
      const children = childrenMap.get(parentId);
      if (children) {
        children.push(project.id);
      } else {
        childrenMap.set(parentId, [project.id]);
      }
    }
  }

  // Traverse using map: O(n) total
  const projectIds = new Set<number>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (projectIds.has(id)) continue;
    projectIds.add(id);
    const children = childrenMap.get(id);
    if (children) {
      stack.push(...children);
    }
  }

  return projectIds;
}
