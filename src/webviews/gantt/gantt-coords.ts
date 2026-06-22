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
 * Return a copy of `date` shifted by `days` UTC days (negative = backward).
 * Does NOT mutate the input. Whole-day UTC arithmetic, no DST drift — the
 * shared idiom behind the axis padding, lookback horizon, and end-exclusive
 * bar edges.
 */
export function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
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
  return dateToX(addUtcDays(endDate, 1).getTime(), minDateMs, maxDateMs, timelineWidth);
}

/**
 * Resolve a bar's (startX, endX) pixel range from a start/due date pair,
 * capturing the shared null-fallback + parse + dateToX + endExclusiveX logic
 * that every bar generator re-derived. Returns null when BOTH dates are
 * absent (caller emits an empty group); width clamps stay at the call site.
 *
 * Fallbacks:
 *  - start absent → use the due date (single-day bar anchored on due).
 *  - due absent, start present → use `openEndedMax` when supplied (bars that
 *    render to the timeline's right edge, e.g. ctx.maxDate), else fall back
 *    to the start date (single-day bar). This keeps the start-without-due
 *    open-ended behaviour intact for the issue/payload sites while child
 *    aggregate ranges (no openEndedMax) collapse to a one-day strip.
 *
 * Dates are parsed with `new Date(str)` (UTC) to match the UTC-anchored axis.
 *
 * @param startDate     ISO date string or null
 * @param dueDate       ISO date string or null
 * @param minDateMs     Timeline start timestamp (ms)
 * @param maxDateMs     Timeline end timestamp (ms)
 * @param timelineWidth Total SVG width in pixels
 * @param openEndedMax  ISO date for the due fallback when only a start exists
 */
export function barXRange(
  startDate: string | null,
  dueDate: string | null,
  minDateMs: number,
  maxDateMs: number,
  timelineWidth: number,
  openEndedMax?: string
): { startX: number; endX: number } | null {
  if (!startDate && !dueDate) return null;
  const effStart = startDate ?? dueDate!;
  const effDue = dueDate ?? (startDate && openEndedMax ? openEndedMax : effStart);
  const startX = dateToX(new Date(effStart).getTime(), minDateMs, maxDateMs, timelineWidth);
  const endX = endExclusiveX(new Date(effDue), minDateMs, maxDateMs, timelineWidth);
  return { startX, endX };
}

/**
 * Clamp the timeline's left edge to the lookback horizon (today minus
 * lookbackDays). One ancient still-open issue must not stretch the axis
 * years into the past — bars starting before the horizon simply render
 * clipped at the left edge. No-ops when lookback is unlimited (null) or
 * when the whole board lies before the horizon (clamping would invert
 * the range). Inputs are not mutated.
 */
export function clampMinDateToLookback(
  minDate: Date,
  maxDate: Date,
  todayUTC: Date,
  lookbackDays: number | null
): Date {
  if (lookbackDays === null) return minDate;
  const horizon = addUtcDays(todayUTC, -lookbackDays);
  return minDate < horizon && horizon < maxDate ? horizon : minDate;
}
