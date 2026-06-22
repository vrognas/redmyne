import { GanttViewMode } from "../redmine/models/common";

export type GanttZoomLevel = "day" | "week" | "month" | "quarter" | "year";

export type GanttWebviewMessage =
  | { command: "webviewReady" }
  | { command: "openIssue"; issueId: number }
  | { command: "updateDates"; issueId: number; startDate: string | null; dueDate: string | null }
  | { command: "removeDraft"; issueId: number; startDate?: string | null; dueDate?: string | null }
  | { command: "setZoom"; zoomLevel: GanttZoomLevel }
  | { command: "setLookback"; days?: string }
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

/**
 * The lookback selector's options — the single source of truth shared by the
 * toolbar dropdown and parseLookbackDays validation. Days as strings; "" =
 * All Time (null). Add an entry here and both the menu and the validator stay
 * in sync. 14/28 = 2/4 weeks, 90/180 = 3/6 months, 730/1825/3650 = 2/5/10y.
 */
export interface LookbackOption {
  value: string;
  label: string;
}

export const LOOKBACK_OPTIONS: readonly LookbackOption[] = [
  { value: "14", label: "2 Weeks" },
  { value: "28", label: "4 Weeks" },
  { value: "90", label: "3 Months" },
  { value: "180", label: "6 Months" },
  { value: "730", label: "2 Years" },
  { value: "1825", label: "5 Years" },
  { value: "3650", label: "10 Years" },
  { value: "", label: "All Time" },
];

const LOOKBACK_VALUES = new Set(LOOKBACK_OPTIONS.map((o) => o.value));

export function parseLookbackDays(
  value: string | undefined,
  fallback: number | null
): number | null {
  if (value === undefined) return fallback;
  if (!LOOKBACK_VALUES.has(value)) return fallback;
  if (value === "") return null;
  return parseInt(value, 10);
}

/**
 * Resolve the lookback in days, migrating the pre-4.37 years-based setting.
 * Uses the stored days value when set; otherwise converts the old years
 * value (x365) so an existing non-default lookback survives the units switch,
 * or falls back to defaultDays when neither is stored.
 */
export function resolveLookbackDays(
  storedDays: number | null | undefined,
  storedYears: number | null | undefined,
  defaultDays: number
): number | null {
  if (storedDays !== undefined) return storedDays;
  if (storedYears === undefined) return defaultDays;
  return storedYears === null ? null : Math.round(storedYears * 365);
}
