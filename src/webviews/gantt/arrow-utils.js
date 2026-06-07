/**
 * Pure helpers for dependency-arrow geometry (node-testable, no DOM).
 */

const SCHEDULING_TYPES = ['blocks', 'precedes', 'finish_to_start', 'start_to_start', 'finish_to_finish', 'start_to_finish'];

/**
 * Whether a relation type participates in scheduling (start/end anchored arrows).
 * @param {string} relType
 * @returns {boolean}
 */
export function isSchedulingRelation(relType) {
  return SCHEDULING_TYPES.includes(relType);
}

/**
 * Compute arrow endpoint coordinates from bar geometry and relation type.
 * Scheduling relations anchor at bar start/end edges (with 2px clearance);
 * non-scheduling relations connect bar centers via top/bottom borders.
 * @param {{fromStartX: number, fromEndX: number, fromY: number, toStartX: number, toEndX: number, toY: number, relType: string, barHeight: number}} geo
 *   fromY/toY are bar CENTER y coordinates.
 * @returns {{x1: number, y1: number, x2: number, y2: number, isScheduling: boolean, fromStart: boolean, toEnd: boolean}}
 */
export function computeArrowEndpoints({ fromStartX, fromEndX, fromY, toStartX, toEndX, toY, relType, barHeight }) {
  const isScheduling = isSchedulingRelation(relType);
  // Anchor positions based on relation type
  const fromStart = relType === 'start_to_start' || relType === 'start_to_finish';
  const toEnd = relType === 'finish_to_finish' || relType === 'start_to_finish';

  let x1, y1, x2, y2;
  if (isScheduling) {
    x1 = fromStart ? fromStartX - 2 : fromEndX + 2;
    y1 = fromY;
    x2 = toEnd ? toEndX + 2 : toStartX - 2;
    y2 = toY;
  } else {
    // Non-scheduling: center x, border y
    x1 = (fromStartX + fromEndX) / 2;
    x2 = (toStartX + toEndX) / 2;
    const goingDown = toY > fromY;
    const sameRowCenter = Math.abs(fromY - toY) < 5;
    if (sameRowCenter) {
      // Same row: both use top border
      y1 = fromY - barHeight / 2;
      y2 = toY - barHeight / 2;
    } else {
      // Different rows: use bottom/top borders based on direction
      y1 = goingDown ? fromY + barHeight / 2 : fromY - barHeight / 2;
      y2 = goingDown ? toY - barHeight / 2 : toY + barHeight / 2;
    }
  }
  return { x1, y1, x2, y2, isScheduling, fromStart, toEnd };
}
