/**
 * Timesheet Webview Message Types
 * Defines communication protocol between extension and webview
 */

// Sentinel value for orphan projects (no parent)
export const OTHERS_PARENT_ID = -1;

// Source entry for aggregated cells
export interface SourceEntry {
  rowId: string;
  entryId: number;
  hours: number;
  issueId: number;
  activityId: number;
  comments: string | null;
  spentOn: string;
}

// Day cell data
export interface DayCell {
  hours: number;
  originalHours: number; // Value when loaded from server (for dirty detection)
  entryId: number | null;
  isDirty: boolean;
  sourceEntries?: SourceEntry[]; // For aggregated cells: all contributing entries
}

// Row data model
export interface TimeSheetRow {
  id: string; // Entry ID or temp UUID
  parentProjectId: number | null; // Client/parent project (-1 = "Others" group)
  parentProjectName: string | null;
  projectId: number | null;
  projectName: string | null;
  issueId: number | null;
  issueSubject: string | null;
  activityId: number | null;
  activityName: string | null;
  comments: string | null;
  originalComments?: string | null; // Server value for dirty detection
  days: Record<number, DayCell>; // 0=Mon...6=Sun
  isNew: boolean;
  weekTotal: number;
}

// Project option
export interface ProjectOption {
  id: number;
  name: string;
  identifier: string;
  path: string;
  parentId: number | null; // null = root project
}

// Issue option
export interface IssueOption {
  id: number;
  subject: string;
  projectId: number;
}

// Activity option
export interface ActivityOption {
  id: number;
  name: string;
  isDefault: boolean;
}

// Issue details for tooltip display
export interface IssueDetails {
  id: number;
  subject: string;
  status: string;
  priority: string;
  tracker: string;
  assignedTo: string | null;
  doneRatio: number;
  estimatedHours: number | null;
  spentHours: number | null;
  startDate: string | null;
  dueDate: string | null;
  customFields: { name: string; value: string }[];
}

// Week info
export interface WeekInfo {
  weekNumber: number;
  year: number;
  startDate: string; // YYYY-MM-DD (Monday)
  endDate: string; // YYYY-MM-DD (Sunday)
  dayDates: string[]; // Array of 7 dates
}

// Daily totals
export interface DailyTotals {
  days: number[]; // 7 values
  weekTotal: number;
  targetHours: number[]; // 7 values from schedule
  weekTargetTotal: number;
}

// --- Extension -> Webview Messages ---

// Sort state
export type SortColumn = "client" | "project" | "task" | "activity" | "comments" | "total" | null;
export type SortDirection = "asc" | "desc";

// Grouping state
export type GroupBy = "none" | "client" | "project" | "issue" | "activity";

export interface RenderMessage {
  type: "render";
  rows: TimeSheetRow[];
  week: WeekInfo;
  totals: DailyTotals;
  projects: ProjectOption[]; // All projects flat
  parentProjects: ProjectOption[]; // Parents only (includes synthetic "Others")
  isDraftMode: boolean;
  sortColumn: SortColumn;
  sortDirection: SortDirection;
  groupBy: GroupBy;
  collapsedGroups: string[]; // Group keys that are collapsed
  aggregateRows: boolean; // Merge identical rows (same issue+activity+comment)
  // Cascade data (stateless webview - all dropdown data in one message)
  childProjectsByParent: Record<string, ProjectOption[]>; // parentId -> children
  issuesByProject: Record<string, IssueOption[]>; // projectId -> issues
  activitiesByProject: Record<string, ActivityOption[]>; // projectId -> activities
}

// Row-specific cascade data for efficient single-row updates
export interface RowCascadeData {
  childProjects?: ProjectOption[];
  issues?: IssueOption[];
  activities?: ActivityOption[];
}

export interface UpdateRowMessage {
  type: "updateRow";
  row: TimeSheetRow;
  totals: DailyTotals;
  rowCascadeData?: RowCascadeData; // Include cascade data for this specific row
}

export interface UpdateChildProjectsMessage {
  type: "updateChildProjects";
  projects: ProjectOption[];
  forParentId: number; // -1 = "Others" group (never null)
}

export interface UpdateIssuesMessage {
  type: "updateIssues";
  issues: IssueOption[];
  forProjectId: number; // required, not nullable
}

export interface UpdateActivitiesMessage {
  type: "updateActivities";
  activities: ActivityOption[];
  forProjectId: number;
}

export interface SetLoadingMessage {
  type: "setLoading";
  loading: boolean;
}

export interface WeekChangedMessage {
  type: "weekChanged";
  week: WeekInfo;
}

export interface ShowErrorMessage {
  type: "showError";
  message: string;
}

export interface DraftModeChangedMessage {
  type: "draftModeChanged";
  isDraftMode: boolean;
}

export interface UpdateIssueDetailsMessage {
  type: "updateIssueDetails";
  issueId: number;
  details: IssueDetails;
}

export interface RowDuplicatedMessage {
  type: "rowDuplicated";
  sourceRowId: string;
  newRowId: string;
}

export interface RowDeletedMessage {
  type: "rowDeleted";
  deletedRow: TimeSheetRow; // Full row data for undo
}

export interface ShowToastMessage {
  type: "showToast";
  message: string;
  undoAction?: {
    type: "restoreAggregatedEntries";
    entries: SourceEntry[];
    aggRowId: string;
    dayIndex: number;
  };
  duration?: number;
}

export interface RequestAggregatedCellConfirmMessage {
  type: "requestAggregatedCellConfirm";
  aggRowId: string;
  dayIndex: number;
  newHours: number;
  oldHours: number;
  sourceEntryCount: number;
  sourceEntries: SourceEntry[];
}

export interface RequestAggregatedFieldConfirmMessage {
  type: "requestAggregatedFieldConfirm";
  aggRowId: string;
  field: "parentProject" | "project" | "issue" | "activity" | "comments";
  value: number | string | null;
  oldValue: number | string | null;
  sourceRowIds: string[];
  sourceEntryCount: number;
}

export type ExtensionToWebviewMessage =
  | RenderMessage
  | UpdateRowMessage
  | UpdateChildProjectsMessage
  | UpdateIssuesMessage
  | UpdateActivitiesMessage
  | SetLoadingMessage
  | WeekChangedMessage
  | ShowErrorMessage
  | DraftModeChangedMessage
  | UpdateIssueDetailsMessage
  | RowDuplicatedMessage
  | RowDeletedMessage
  | ShowToastMessage
  | RequestAggregatedCellConfirmMessage
  | RequestAggregatedFieldConfirmMessage;

// --- Webview -> Extension Messages ---

export interface WebviewReadyMessage {
  type: "webviewReady";
}

export interface NavigateWeekMessage {
  type: "navigateWeek";
  direction: "prev" | "next" | "today" | "date";
  targetDate?: string; // For "date" direction
}

export interface AddRowMessage {
  type: "addRow";
}

export interface DeleteRowMessage {
  type: "deleteRow";
  rowId: string;
}

export interface RestoreRowMessage {
  type: "restoreRow";
  row: TimeSheetRow; // Full row data to restore
}

export interface DuplicateRowMessage {
  type: "duplicateRow";
  rowId: string;
}

export interface UpdateCellMessage {
  type: "updateCell";
  rowId: string;
  dayIndex: number;
  hours: number;
}

export interface UpdateRowFieldMessage {
  type: "updateRowField";
  rowId: string;
  field: "parentProject" | "project" | "issue" | "activity" | "comments";
  value: number | string | null;
}

export interface RequestChildProjectsMessage {
  type: "requestChildProjects";
  parentId: number; // -1 = "Others"
}

export interface RequestIssuesMessage {
  type: "requestIssues";
  projectId: number;
}

export interface RequestActivitiesMessage {
  type: "requestActivities";
  projectId: number;
}

export interface SaveAllMessage {
  type: "saveAll";
}

export interface PickIssueMessage {
  type: "pickIssue";
  rowId: string;
}

export interface SortChangedMessage {
  type: "sortChanged";
  sortColumn: SortColumn;
  sortDirection: SortDirection;
}

export interface SetGroupByMessage {
  type: "setGroupBy";
  groupBy: GroupBy;
}

export interface ToggleGroupMessage {
  type: "toggleGroup";
  groupKey: string;
}

export interface CopyWeekMessage {
  type: "copyWeek";
}

export interface PasteWeekMessage {
  type: "pasteWeek";
}

export interface EnableDraftModeMessage {
  type: "enableDraftMode";
}

export interface RequestIssueDetailsMessage {
  type: "requestIssueDetails";
  issueId: number;
}

export interface SetAggregateRowsMessage {
  type: "setAggregateRows";
  aggregateRows: boolean;
}

export interface UpdateAggregatedCellMessage {
  type: "updateAggregatedCell";
  aggRowId: string;
  dayIndex: number;
  newHours: number;
  sourceEntries: SourceEntry[];
  confirmed: boolean;
}

export interface UpdateAggregatedFieldMessage {
  type: "updateAggregatedField";
  aggRowId: string;
  field: "parentProject" | "project" | "issue" | "activity" | "comments";
  value: number | string | null;
  sourceRowIds: string[];
  confirmed: boolean;
}

export interface RestoreAggregatedEntriesMessage {
  type: "restoreAggregatedEntries";
  entries: SourceEntry[];
  aggRowId: string;
  dayIndex: number;
}

export interface UpdateExpandedEntryMessage {
  type: "updateExpandedEntry";
  rowId: string;
  entryId: number;
  dayIndex: number;
  newHours: number;
  oldHours: number;
}

export interface DeleteExpandedEntryMessage {
  type: "deleteExpandedEntry";
  rowId: string;
  entryId: number;
  aggRowId: string;
  dayIndex: number;
}

export type WebviewToExtensionMessage =
  | WebviewReadyMessage
  | NavigateWeekMessage
  | AddRowMessage
  | DeleteRowMessage
  | RestoreRowMessage
  | DuplicateRowMessage
  | UpdateCellMessage
  | UpdateRowFieldMessage
  | RequestChildProjectsMessage
  | RequestIssuesMessage
  | RequestActivitiesMessage
  | SaveAllMessage
  | PickIssueMessage
  | SortChangedMessage
  | SetGroupByMessage
  | ToggleGroupMessage
  | CopyWeekMessage
  | PasteWeekMessage
  | EnableDraftModeMessage
  | RequestIssueDetailsMessage
  | SetAggregateRowsMessage
  | UpdateAggregatedCellMessage
  | UpdateAggregatedFieldMessage
  | RestoreAggregatedEntriesMessage
  | UpdateExpandedEntryMessage
  | DeleteExpandedEntryMessage;

// Combined type for message handling
export type TimeSheetMessage = ExtensionToWebviewMessage | WebviewToExtensionMessage;

/**
 * Get Monday of the week containing the given date
 */
export function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust if Sunday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Format date as YYYY-MM-DD
 */
export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Get ISO week number
 */
export function getISOWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/**
 * Build WeekInfo from a Monday date
 */
export function buildWeekInfo(monday: Date): WeekInfo {
  const dayDates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    dayDates.push(formatDate(d));
  }
  return {
    weekNumber: getISOWeekNumber(monday),
    year: monday.getFullYear(),
    startDate: dayDates[0],
    endDate: dayDates[6],
    dayDates,
  };
}
