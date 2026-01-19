/**
 * Timesheet Webview Message Types
 * Defines communication protocol between extension and webview
 */

// Day cell data
export interface DayCell {
  hours: number;
  entryId: number | null;
  isDirty: boolean;
}

// Row data model
export interface TimeSheetRow {
  id: string; // Entry ID or temp UUID
  projectId: number | null;
  projectName: string | null;
  issueId: number | null;
  issueSubject: string | null;
  activityId: number | null;
  activityName: string | null;
  days: Record<number, DayCell>; // 0=Mon...6=Sun
  isNew: boolean;
  weekTotal: number;
}

// Project option
export interface ProjectOption {
  id: number;
  name: string;
  path: string;
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

export interface RenderMessage {
  type: "render";
  rows: TimeSheetRow[];
  week: WeekInfo;
  totals: DailyTotals;
  projects: ProjectOption[];
  isDraftMode: boolean;
}

export interface UpdateRowMessage {
  type: "updateRow";
  row: TimeSheetRow;
  totals: DailyTotals;
}

export interface UpdateIssuesMessage {
  type: "updateIssues";
  issues: IssueOption[];
  forProjectId: number | null;
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

export type ExtensionToWebviewMessage =
  | RenderMessage
  | UpdateRowMessage
  | UpdateIssuesMessage
  | UpdateActivitiesMessage
  | SetLoadingMessage
  | WeekChangedMessage
  | ShowErrorMessage;

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
  field: "project" | "issue" | "activity";
  value: number | null;
}

export interface RequestIssuesMessage {
  type: "requestIssues";
  projectId: number | null;
  query?: string;
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

export type WebviewToExtensionMessage =
  | WebviewReadyMessage
  | NavigateWeekMessage
  | AddRowMessage
  | DeleteRowMessage
  | DuplicateRowMessage
  | UpdateCellMessage
  | UpdateRowFieldMessage
  | RequestIssuesMessage
  | RequestActivitiesMessage
  | SaveAllMessage
  | PickIssueMessage;

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
