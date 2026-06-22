import { GanttViewMode } from "../redmine/models/common";

export type GanttZoomLevel = "day" | "week" | "month" | "quarter" | "year";

export type GanttWebviewMessage =
  | { command: "webviewReady" }
  | { command: "openIssue"; issueId: number }
  | { command: "updateDates"; issueId: number; startDate: string | null; dueDate: string | null }
  | { command: "removeDraft"; issueId: number; startDate?: string | null; dueDate?: string | null }
  | { command: "setZoom"; zoomLevel: GanttZoomLevel }
  | { command: "setLookback"; years?: string }
  | { command: "setTaskTypeFilter"; taskType?: string }
  | { command: "toggleLateFilter" }
  | { command: "toggleEmptyProjects" }
  | { command: "toggleMyIssuesHighlight" }
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
  | { command: "collapseStateSync"; collapseKey?: string; isExpanded?: boolean }
  | { command: "collapseStateSyncBulk"; expandedKeys?: string[] }
  | { command: "undoRelation"; operation: string; relationId?: number; issueId?: number; targetIssueId?: number; relationType?: string; delay?: number }
  | { command: "redoRelation"; operation: string; relationId?: number; issueId?: number; targetIssueId?: number; relationType?: string; delay?: number }
  | { command: "openInBrowser"; issueId: number }
  | { command: "showInIssues"; issueId: number }
  | { command: "logTime"; issueId: number }
  | { command: "setDoneRatio"; issueId: number }
  | { command: "bulkSetDoneRatio"; issueIds: number[] }
  | { command: "copyUrl"; issueId: number }
  | { command: "todayOutOfRange" }
  | { command: "setInternalEstimate"; issueId: number }
  | { command: "toggleAutoUpdate"; issueId: number }
  | { command: "togglePrecedence"; issueId: number }
  | { command: "setFilter"; filter?: { assignee?: string; status?: string } }
  | { command: "setSelectedKey"; collapseKey?: string | null }
  | { command: "setSort"; sortBy?: "id" | "assignee" | "start" | "due" | "status" | null; sortOrder?: "asc" | "desc" }
  | { command: "showStatus"; message?: string }
  | { command: "requestProjectMembers"; projectId?: number };

// Fractional years express sub-year ranges: 0.25 = 3 months, 0.5 = 6 months.
const LOOKBACK_VALUES = new Set(["0.25", "0.5", "2", "5", "10", ""]);

export function parseLookbackYears(
  value: string | undefined,
  fallback: number | null
): number | null {
  if (value === undefined) return fallback;
  if (!LOOKBACK_VALUES.has(value)) return fallback;
  if (value === "") return null;
  return parseFloat(value);
}
