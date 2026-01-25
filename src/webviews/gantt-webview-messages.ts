import { GanttViewMode } from "../redmine/models/common";

export type GanttZoomLevel = "day" | "week" | "month" | "quarter" | "year";

export type GanttWebviewMessage =
  | { command: "webviewReady" }
  | { command: "openIssue"; issueId: number }
  | { command: "updateDates"; issueId: number; startDate: string | null; dueDate: string | null }
  | { command: "removeDraft"; issueId: number; startDate?: string | null; dueDate?: string | null }
  | { command: "setZoom"; zoomLevel: GanttZoomLevel }
  | { command: "setLookback"; years?: string }
  | { command: "setViewMode"; viewMode: GanttViewMode }
  | { command: "setViewFocus"; focus: "project" | "person" }
  | { command: "setSelectedProject"; projectId?: number | null }
  | { command: "setSelectedAssignee"; assignee?: string | null }
  | { command: "deleteRelation"; relationId: number }
  | { command: "updateRelationDelay"; relationId: number; fromId: string; toId: string }
  | { command: "createRelation"; issueId: number; targetIssueId: number; relationType: string; delay?: number }
  | { command: "toggleDependencies" }
  | { command: "toggleBadges" }
  | { command: "toggleCapacityRibbon" }
  | { command: "toggleIntensity" }
  | { command: "refresh" }
  | { command: "openDraftReview" }
  | { command: "toggleDraftMode" }
  | { command: "toggleCollapse"; collapseKey: string; action?: "collapse" | "expand" }
  | { command: "expandAll"; keys?: string[] }
  | { command: "collapseAll" }
  | { command: "collapseStateSync"; collapseKey?: string; isExpanded?: boolean }
  | { command: "requestRerender" }
  | { command: "scrollPosition"; left?: number; top?: number }
  | { command: "undoRelation"; operation: string; relationId?: number; issueId?: number; targetIssueId?: number; relationType?: string }
  | { command: "redoRelation"; operation: string; relationId?: number; issueId?: number; targetIssueId?: number; relationType?: string }
  | { command: "openInBrowser"; issueId: number }
  | { command: "openProjectInBrowser"; projectId: number }
  | { command: "showInIssues"; issueId: number }
  | { command: "logTime"; issueId: number }
  | { command: "setDoneRatio"; issueId: number; value: number }
  | { command: "bulkSetDoneRatio"; issueIds: number[] }
  | { command: "setIssueStatus"; issueId: number; statusPattern: string }
  | { command: "setIssuePriority"; issueId: number; priorityPattern: string }
  | { command: "copyUrl"; issueId: number }
  | { command: "todayOutOfRange" }
  | { command: "setInternalEstimate"; issueId: number }
  | { command: "toggleAutoUpdate"; issueId: number }
  | { command: "toggleAdHoc"; issueId: number }
  | { command: "togglePrecedence"; issueId: number }
  | { command: "setFilter"; filter?: { assignee?: string; status?: string } }
  | { command: "setHealthFilter"; health?: string }
  | { command: "setSelectedKey"; collapseKey?: string | null }
  | { command: "setSort"; sortBy?: "id" | "assignee" | "start" | "due" | "status" | null; sortOrder?: "asc" | "desc" }
  | { command: "showStatus"; message?: string }
  | { command: "setAllProjectsVisibility"; projectIds?: number[]; visible?: boolean };

const LOOKBACK_VALUES = new Set(["2", "5", "10", ""]);

export function parseLookbackYears(
  value: string | undefined,
  fallback: 2 | 5 | 10 | null
): 2 | 5 | 10 | null {
  if (value === undefined) return fallback;
  if (!LOOKBACK_VALUES.has(value)) return fallback;
  if (value === "") return null;
  return parseInt(value, 10) as 2 | 5 | 10;
}
