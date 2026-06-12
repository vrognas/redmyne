/**
 * Single owner of the "how much work is left" heuristic. Every surface
 * that judges lateness or projects remaining effort — flexibility scores,
 * the gantt late chip/filter, bar ghosts/badges, arrow health — goes
 * through here. Four hand-mirrored copies of this rule had already
 * drifted before it was extracted.
 *
 * Rules:
 * - An internal estimate, when present, wins outright (clamped at 0).
 * - done_ratio 100 → nothing left.
 * - Budget consumed (spent >= estimate): a maintained done_ratio scales
 *   the estimate; an unmaintained one (0) counts the work as done — the
 *   same heuristic the visual ~100% progress fallback uses.
 * - No estimate of any kind → null (unknowable). Callers decide: the
 *   late chip treats past-due-unknown as late; ghosts simply don't draw.
 */
export function remainingHours(input: {
  estimatedHours: number | null | undefined;
  spentHours: number | null | undefined;
  doneRatio: number | null | undefined;
  /** undefined = no internal estimate recorded */
  internalHoursRemaining?: number;
}): number | null {
  if (input.internalHoursRemaining !== undefined) {
    return Math.max(0, input.internalHoursRemaining);
  }
  const est = input.estimatedHours ?? 0;
  if (est <= 0) return null;
  const done = input.doneRatio ?? 0;
  if (done >= 100) return 0;
  const spent = input.spentHours ?? 0;
  if (spent >= est) {
    return done > 0 ? est * (1 - done / 100) : 0;
  }
  return est - spent;
}
