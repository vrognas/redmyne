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
  labelWidth: number;

  // Column widths
  idColumnWidth: number;
  startDateColumnWidth: number;
  statusColumnWidth: number;
  dueDateColumnWidth: number;
  assigneeColumnWidth: number;

  // Date range
  minDate: Date;
  maxDate: Date;
  today: Date;
  todayStr: string;

  // Data
  rows: GanttRow[];
  filteredRows: GanttRow[];
  visibleRows: GanttRow[];
  initialYPositions: number[];
  filteredRowYPositions: number[];
  rowYPositions: number[];
  rowHeights: number[];

  // View settings
  viewFocus: "project" | "person";
  showIntensity: boolean;
  showDependencies: boolean;
  showBadges: boolean;
  currentUserId: number | null;

  // Schedule
  schedule: WeeklySchedule;
  issueScheduleMap: Map<number, Map<string, number>>;

  // Contribution tracking
  contributionSources?: Map<number, { fromIssueId: number; hours: number }[]>;
  donationTargets?: Map<number, { toIssueId: number; hours: number }[]>;
  adHocIssues?: Set<number>;

  // Callbacks for tooltips/status (injected from panel)
  getStatusColor: (status: string) => string;
  getStatusTextColor: (status: string) => string;
  getStatusOpacity: (status: string) => number;
  getStatusDescription: (status: string) => string;
  buildProjectTooltip: (row: GanttRow) => string;
  getHealthDot: (status: string) => string;

  // Internal estimates and precedence
  getInternalEstimate: (issueId: number) => { hoursRemaining: number } | null;
  hasPrecedence: (issueId: number) => boolean;
  isAutoUpdateEnabled: (issueId: number) => boolean;
}

/** Position data for dependency arrows */
export interface IssuePosition {
  startX: number;
  endX: number;
  y: number;
}

/** Group range for zebra stripes */
export interface GroupRange {
  startIdx: number;
  endIdx: number;
  groupIdx: number;
}

/** Relation style definition */
export interface RelationStyle {
  dash: string;
  label: string;
  tip: string;
}

/** Avatar color indices */
export interface AvatarColors {
  fill: number;
  stroke: number;
}
