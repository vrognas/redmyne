import { dateToX } from "./gantt-coords";

export interface DimRect {
  x: number;
  width: number;
}

/**
 * Past/future dimming rectangles for the timeline header — used to make the
 * active development window stand out. `past` covers everything left of the
 * current period's start; `future` covers everything right of the last
 * scheduled task (windowEndMs). Either is null when it would be empty: the
 * current period sits at/left of the axis start (no past), or there are no
 * dated tasks / the last task is at/past the axis end (no future).
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
