/**
 * Shared date-to-pixel coordinate helpers for the Gantt timeline geometry.
 *
 * Degenerate range (minDateMs === maxDateMs): returns 0 to match the
 * existing inline behaviour (0/0 → NaN → treated as 0 in SVG attribute
 * positioning, but the layout is meaningless anyway — document explicitly).
 */

/**
 * Map an absolute timestamp to an SVG x-coordinate on the timeline.
 *
 * @param timeMs       The timestamp to convert (ms since epoch)
 * @param minDateMs    Timeline start timestamp (ms)
 * @param maxDateMs    Timeline end timestamp (ms)
 * @param timelineWidth Total SVG width in pixels
 * @returns x pixel value; 0 when minDateMs === maxDateMs (degenerate range)
 */
export function dateToX(
  timeMs: number,
  minDateMs: number,
  maxDateMs: number,
  timelineWidth: number
): number {
  const range = maxDateMs - minDateMs;
  if (range === 0) return 0;
  return ((timeMs - minDateMs) / range) * timelineWidth;
}

/**
 * Like dateToX but adds 1 UTC day to the input date first (exclusive end),
 * matching the `endPlusOne = new Date(end); endPlusOne.setUTCDate(+1)` pattern.
 * The input Date is NOT mutated.
 *
 * @param endDate      The inclusive end date (not mutated)
 * @param minDateMs    Timeline start timestamp (ms)
 * @param maxDateMs    Timeline end timestamp (ms)
 * @param timelineWidth Total SVG width in pixels
 */
export function endExclusiveX(
  endDate: Date,
  minDateMs: number,
  maxDateMs: number,
  timelineWidth: number
): number {
  const clone = new Date(endDate);
  clone.setUTCDate(clone.getUTCDate() + 1);
  return dateToX(clone.getTime(), minDateMs, maxDateMs, timelineWidth);
}

/**
 * Clamp the timeline's left edge to the lookback horizon (today minus
 * lookbackYears). One ancient still-open issue must not stretch the axis
 * years into the past — bars starting before the horizon simply render
 * clipped at the left edge. No-ops when lookback is unlimited (null) or
 * when the whole board lies before the horizon (clamping would invert
 * the range). Inputs are not mutated.
 */
export function clampMinDateToLookback(
  minDate: Date,
  maxDate: Date,
  todayUTC: Date,
  lookbackYears: number | null
): Date {
  if (lookbackYears === null) return minDate;
  const horizon = new Date(todayUTC);
  horizon.setUTCFullYear(horizon.getUTCFullYear() - lookbackYears);
  return minDate < horizon && horizon < maxDate ? horizon : minDate;
}
