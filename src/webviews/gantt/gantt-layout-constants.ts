/**
 * Single source of truth for the Gantt panel's fixed layout geometry.
 *
 * These widths/heights are consumed identically by three render paths that
 * MUST stay visually in sync:
 *   1. GanttPanel._showLoadingSkeleton (the immediate placeholder)
 *   2. GanttPanel._getFallbackState     (empty/error state)
 *   3. GanttPanel._getRenderPayload     (the live board)
 *
 * The live payload auto-fits idColumnWidth to the widest "#ID", so the
 * extraColumnsWidth/stickyLeftWidth derivation is parameterized on it via
 * computeStickyLeftWidth(); the skeleton/fallback paths pass the fixed
 * GANTT_LAYOUT.idColumnWidth.
 */

export const GANTT_LAYOUT = {
  labelWidth: 250,
  headerHeight: 40,
  barHeight: 22, // VS Code native tree row height
  idColumnWidth: 50,
  startDateColumnWidth: 58, // Fixed: "MMM DD" format
  statusColumnWidth: 50, // Colored dot + header text
  dueDateColumnWidth: 58, // Fixed: "MMM DD" format
  assigneeColumnWidth: 40, // Fixed for avatar circles
  resizeHandleWidth: 10,
} as const;

/**
 * Derive extraColumnsWidth (sum of the five right-hand columns) and the total
 * stickyLeftWidth (label + resize handle + extra columns).
 *
 * @param idColumnWidth Override for the auto-fit live-payload case. Defaults to
 *                      the fixed GANTT_LAYOUT.idColumnWidth (skeleton/fallback).
 */
export function computeStickyLeftWidth(
  idColumnWidth: number = GANTT_LAYOUT.idColumnWidth
): { extraColumnsWidth: number; stickyLeftWidth: number } {
  const extraColumnsWidth =
    idColumnWidth +
    GANTT_LAYOUT.startDateColumnWidth +
    GANTT_LAYOUT.statusColumnWidth +
    GANTT_LAYOUT.dueDateColumnWidth +
    GANTT_LAYOUT.assigneeColumnWidth;
  const stickyLeftWidth =
    GANTT_LAYOUT.labelWidth + GANTT_LAYOUT.resizeHandleWidth + extraColumnsWidth;
  return { extraColumnsWidth, stickyLeftWidth };
}
