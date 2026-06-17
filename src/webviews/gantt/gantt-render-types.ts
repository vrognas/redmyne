/**
 * Types for Gantt HTML generation
 * Stateless rendering - all data passed explicitly
 */

import type { GanttRow } from "../gantt-model";
import type { WeeklySchedule } from "../../utilities/flexibility-calculator";

/** Render context passed to all generator functions */
export interface GanttRenderContext {
  // Layout dimensions
  barHeight: number;
  barPadding: number;
  barContentHeight: number;
  indentSize: number;
  chevronWidth: number;
  timelineWidth: number;

  // Column widths
  idColumnWidth: number;
  statusColumnWidth: number;
  assigneeColumnWidth: number;

  // Date range
  minDate: Date;
  maxDate: Date;
  today: Date;

  // View settings
  viewFocus: "project" | "person";
  currentUserId: number | null;

  // Schedule
  schedule: WeeklySchedule;
  issueScheduleMap: Map<number, Map<string, number>>;

  // Contribution tracking
  contributionSources?: Map<number, { fromIssueId: number; hours: number }[]>;

  // Callbacks for tooltips/status (injected from panel)
  getStatusColor: (status: string) => string;
  getStatusTextColor: (status: string) => string;
  getStatusOpacity: (status: string) => number;
  getStatusDescription: (status: string) => string;
  buildProjectTooltip: (row: GanttRow) => string;

  // Internal estimates and precedence
  getInternalEstimate: (issueId: number) => { hoursRemaining: number } | null;
  hasPrecedence: (issueId: number) => boolean;
  isAutoUpdateEnabled: (issueId: number) => boolean;
}

/**
 * Per-row SVG fragments + meta for the webview row-window. One entry per
 * hierarchy row (rows hidden under collapsed parents included). Fragments are
 * complete row markup for each of the 7 panel SVGs.
 */
export interface GanttRowPayload {
  key: string;
  parentKey: string | null;
  depth: number;
  type: GanttRow["type"];
  hasChildren: boolean;
  issueId: number | null;
  /** Timeline bar x-range (issue rows) — arrow geometry anchors */
  barStartX: number | null;
  barEndX: number | null;
  /** Issue dates (issue rows) — bulk drag commits collapse-hidden selected
   *  issues from data, since they have no DOM element to read from */
  startDate: string | null;
  dueDate: string | null;
  panels: {
    status: string;
    id: string;
    labels: string;
    start: string;
    due: string;
    assignee: string;
    timeline: string;
  };
}

/** Relation shipped as data — the webview builds arrow SVG at virtual Ys */
export interface GanttArrowPayload {
  relationId: number;
  fromId: number;
  toId: number;
  type: string;
  /** Source task late or projected late (remaining flexibility < 0) —
   *  the arrow renders red instead of green. */
  risk: boolean;
}

/** Avatar color indices */
export interface AvatarColors {
  fill: number;
  stroke: number;
}
