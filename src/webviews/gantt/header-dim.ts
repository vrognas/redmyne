import { dateToX } from "./gantt-coords";

const DAY_MS = 86400000;

export interface DimRect {
  x: number;
  width: number;
}

/**
 * Past/future dimming rectangles for the timeline header — used to make the
 * active development window stand out. `past` covers everything left of the
 * current period's start; `future` covers everything right of the active
 * window end (windowEndMs). Either is null when it would be empty: the
 * current period sits at/left of the axis start (no past), or windowEndMs is
 * null / at-or-past the axis end (no future). A degenerate axis (max <= min)
 * yields no dim.
 *
 * Coordinates are clamped to [0, svgWidth] so callers render them directly
 * as header overlay rects.
 */
export function computeHeaderDimRects(
  periodStartMs: number,
  windowEndMs: number | null,
  minDateMs: number,
  maxDateMs: number,
  svgWidth: number
): { past: DimRect | null; future: DimRect | null } {
  if (maxDateMs <= minDateMs) return { past: null, future: null };
  const clampX = (x: number): number => Math.max(0, Math.min(svgWidth, x));

  const pastEnd = clampX(dateToX(periodStartMs, minDateMs, maxDateMs, svgWidth));
  const past = pastEnd > 0 ? { x: 0, width: pastEnd } : null;

  let future: DimRect | null = null;
  if (windowEndMs !== null) {
    const futureStart = clampX(dateToX(windowEndMs, minDateMs, maxDateMs, svgWidth));
    if (futureStart < svgWidth) {
      future = { x: futureStart, width: svgWidth - futureStart };
    }
  }

  return { past, future };
}

/**
 * Where the header "future" dim should start (ms) so that today's period AND
 * the last scheduled task's own day cell stay bright. The active window ends
 * at the later of today's period end and the day AFTER the last task
 * (windowEndMs = the last task's date at UTC midnight; bars are
 * end-exclusive). Returns null (no future dim) when there are no dated tasks.
 */
export function computeFutureDimStartMs(
  windowEndMs: number | null,
  periodStartMs: number,
  periodDays: number
): number | null {
  if (windowEndMs === null) return null;
  const periodEndMs = periodStartMs + periodDays * DAY_MS;
  return Math.max(periodEndMs, windowEndMs + DAY_MS);
}
