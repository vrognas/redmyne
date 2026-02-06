const AGGREGATED_ROW_ID_REGEX = /^agg-(.+?)::(.+?)::(.*)$/;
const TIMESHEET_DAY_COUNT = 7;

export interface AggregatedRowKey {
  issueId: number | null;
  activityId: number | null;
  comments: string | null;
}

export interface AggregatedTempId extends AggregatedRowKey {
  dayIndex: number;
}

export interface RowDayTempId {
  rowId: string;
  dayIndex: number;
}

interface AggregatedSegments {
  issueIdRaw: string;
  activityIdRaw: string;
  tail: string;
}

function parseNullableId(rawValue: string): number | null {
  return rawValue === "null" ? null : parseInt(rawValue, 10);
}

function parseAggregatedSegments(value: string): AggregatedSegments | null {
  const match = value.match(AGGREGATED_ROW_ID_REGEX);
  if (!match) {
    return null;
  }

  return {
    issueIdRaw: match[1],
    activityIdRaw: match[2],
    tail: match[3],
  };
}

/** Parse canonical aggregated row id: `agg-{issueId}::{activityId}::{comments}` */
export function parseAggregatedRowKey(value: string): AggregatedRowKey | null {
  const segments = parseAggregatedSegments(value);
  if (!segments) {
    return null;
  }

  const issueId = parseNullableId(segments.issueIdRaw);
  const activityId = parseNullableId(segments.activityIdRaw);
  const comments = segments.tail || null;

  return { issueId, activityId, comments };
}

/** Parse create temp id for aggregated rows: `agg-{issueId}::{activityId}::{comments}:{dayIndex}` */
export function parseAggregatedTempId(value: string): AggregatedTempId | null {
  const segments = parseAggregatedSegments(value);
  if (!segments) {
    return null;
  }

  const issueId = parseNullableId(segments.issueIdRaw);
  const activityId = parseNullableId(segments.activityIdRaw);
  const rest = segments.tail;

  const lastColonIndex = rest.lastIndexOf(":");
  const dayIndex = lastColonIndex >= 0 ? parseInt(rest.slice(lastColonIndex + 1), 10) : NaN;
  const comments = (lastColonIndex >= 0 ? rest.slice(0, lastColonIndex) : rest) || null;

  return { issueId, activityId, comments, dayIndex };
}

export function parseRowDayTempId(value: string): RowDayTempId | null {
  const lastColonIndex = value.lastIndexOf(":");
  if (lastColonIndex < 0) {
    return null;
  }

  return {
    rowId: value.slice(0, lastColonIndex),
    dayIndex: parseInt(value.slice(lastColonIndex + 1), 10),
  };
}

export function isValidTimesheetDayIndex(dayIndex: number): boolean {
  return !Number.isNaN(dayIndex) && dayIndex >= 0 && dayIndex < TIMESHEET_DAY_COUNT;
}
