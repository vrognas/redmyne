import { Issue } from "../redmine/models/issue";
import { IssueFilter } from "../redmine/models/common";
import { RedmineProject } from "../redmine/redmine-project";
import { isIssueClosed } from "../utilities/issue-status";
import { remainingHours } from "../utilities/remaining-work";
import type { InternalEstimates } from "../utilities/internal-estimates";
import { filterIssuesByTaskType } from "../utilities/issue-task-type-filter";

/**
 * Whether an issue counts as LATE: past due, open, unfinished, with real
 * work remaining. Mirrors the bar badge/ghost rule exactly — internal
 * estimate first, else budget heuristic where a consumed budget with an
 * unmaintained done_ratio (0) counts as done. No estimate at all still
 * counts late (past due and open is all we know).
 */
export function isLateIssue(
  issue: Issue,
  internalEstimates: InternalEstimates,
  todayStr: string,
  contributedHours = 0
): boolean {
  if (!issue.due_date || issue.due_date >= todayStr) return false;
  if (isIssueClosed(issue)) return false;
  if ((issue.done_ratio ?? 0) >= 100) return false;

  const remaining = remainingHours({
    estimatedHours: issue.estimated_hours,
    spentHours: (issue.spent_hours ?? 0) + contributedHours,
    doneRatio: issue.done_ratio,
    internalHoursRemaining: internalEstimates.get(issue.id)?.hoursRemaining,
  });
  if (remaining === null) return true; // past due and open is all we know
  return remaining > 0;
}

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
    const filteredIssues = effectiveAssignee
      ? options.issues.filter((issue) => issue.assigned_to?.name === effectiveAssignee)
      : options.issues;
    return {
      filteredIssues,
      selectedAssignee: effectiveAssignee,
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

/** The gantt-local view filters that decide whether an issue is on screen. */
export interface GanttViewFilterState {
  viewFocus: "project" | "person";
  selectedAssignee: string | null;
  selectedProjectId: number | null;
  taskTypeField: string | null;
  taskTypeFilter: string;
  lateOnly: boolean;
  currentFilter: IssueFilter;
}

/**
 * Whether `issueId` would render under the current Gantt view filters (view
 * focus, selected project/assignee, task-type, late-only). Mirrors the render
 * pipeline's filter chain so "Show in Gantt" can decide whether to reveal in
 * place or reset to the broad view first.
 */
export function isIssueVisibleInGanttView(args: {
  issueId: number;
  issues: Issue[];
  projects: RedmineProject[];
  state: GanttViewFilterState;
  currentUserId: number | null;
  currentUserName: string | null;
  internalEstimates: InternalEstimates;
  todayStr: string;
  contributedHoursFor: (id: number) => number;
}): boolean {
  const { state } = args;
  const assignee = deriveAssigneeState(args.issues, args.currentUserId, args.currentUserName);
  const view = filterIssuesForView({
    issues: args.issues,
    projects: args.projects,
    viewFocus: state.viewFocus,
    selectedAssignee: state.selectedAssignee,
    currentUserName: assignee.currentUserName,
    uniqueAssignees: assignee.uniqueAssignees,
    selectedProjectId: state.selectedProjectId,
    currentFilter: state.currentFilter,
    currentUserId: args.currentUserId,
  });
  let candidates = view.filteredIssues;
  if (state.taskTypeField && state.taskTypeFilter !== "any") {
    candidates = filterIssuesByTaskType(candidates, state.taskTypeField, state.taskTypeFilter);
  }
  const target = candidates.find((i) => i.id === args.issueId);
  if (!target) return false;
  if (state.lateOnly && !isLateIssue(target, args.internalEstimates, args.todayStr, args.contributedHoursFor(args.issueId))) {
    return false;
  }
  return true;
}

// Parent→children lookup is identical across renders for the same projects
// array. Cache by reference so we don't rebuild a 50-entry Map per render.
const projectChildrenCache = new WeakMap<RedmineProject[], Map<number, number[]>>();
function getProjectChildrenMap(projects: RedmineProject[]): Map<number, number[]> {
  let map = projectChildrenCache.get(projects);
  if (map !== undefined) return map;
  map = new Map<number, number[]>();
  for (const project of projects) {
    const parentId = project.parent?.id;
    if (parentId !== undefined) {
      const children = map.get(parentId);
      if (children) {
        children.push(project.id);
      } else {
        map.set(parentId, [project.id]);
      }
    }
  }
  projectChildrenCache.set(projects, map);
  return map;
}

function collectProjectIds(projects: RedmineProject[], rootId: number): Set<number> {
  const childrenMap = getProjectChildrenMap(projects);
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
