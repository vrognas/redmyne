/**
 * Dependency-arrow SVG builder for the windowed row renderer. MOVED verbatim
 * from gantt-panel.ts's _getRenderPayload arrow block (routing cases, corner
 * radius, arrowheads, hit areas) — only the inputs changed: positions come
 * from the row-window's virtual Ys + per-row bar X ranges, and there are no
 * hidden-row markers (an arrow whose rows are collapsed simply isn't mounted).
 * Pure string building — no DOM.
 */

const escapeAttr = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Relation type styling - only forward types (reverse types are filtered out)
// blocks/precedes/relates/duplicates/copied_to are shown
// blocked/follows/duplicated/copied_from are auto-generated reverses, filtered
// Colors use CSS classes for VS Code theming; dash patterns differentiate within color groups
export const RELATION_STYLES = {
  blocks: { dash: "", label: "blocks",
    tip: "Target cannot be closed until source is closed" },
  precedes: { dash: "", label: "precedes",
    tip: "Source must complete before target can start" },
  relates: { dash: "4,3", label: "relates to",
    tip: "Simple link (no constraints)" },
  duplicates: { dash: "2,2", label: "duplicates",
    tip: "Closing target auto-closes source" },
  copied_to: { dash: "6,2", label: "copied to",
    tip: "Source was copied to create target" },
  // Extended scheduling types (requires Gantt plugin)
  finish_to_start: { dash: "4,2", label: "FS",
    tip: "Finish-to-Start: Target starts after source finishes" },
  start_to_start: { dash: "4,2", label: "SS",
    tip: "Start-to-Start: Target starts when source starts" },
  finish_to_finish: { dash: "4,2", label: "FF",
    tip: "Finish-to-Finish: Target finishes when source finishes" },
  start_to_finish: { dash: "2,4", label: "SF",
    tip: "Start-to-Finish: Target finishes when source starts" },
};

const SCHEDULING_TYPES = ["blocks", "precedes", "finish_to_start", "start_to_start", "finish_to_finish", "start_to_finish"];

/**
 * Build one dependency arrow.
 * @param {{startX: number, endX: number, y: number}} source - bar x-range + row-center y
 * @param {{startX: number, endX: number, y: number}} target
 * @param {{relationId: number, fromId: number, toId: number, type: string}} rel
 * @param {number} barHeight
 * @returns {{svg: string, hasDash: boolean}}
 */
export function buildArrowSvg(source, target, rel, barHeight) {
  const style = RELATION_STYLES[rel.type] || RELATION_STYLES.relates;
  const arrowSize = 4;
  const sameRow = Math.abs(source.y - target.y) < 5;

  // Temporal relations: end → start (or based on type for extended)
  // Non-temporal relations (relates, duplicates, copied_to): center → center
  const isScheduling = SCHEDULING_TYPES.includes(rel.type);

  // Arrow anchor points: fromStart/toEnd determine which side of bars to connect
  // SS = start→start, SF = start→finish, FS = finish→start, FF = finish→finish
  const fromStart = rel.type === "start_to_start" || rel.type === "start_to_finish";
  const toEnd = rel.type === "finish_to_finish" || rel.type === "start_to_finish";

  let x1, y1, x2, y2;
  let path = "";
  const r = 4; // corner radius for rounded turns

  if (!isScheduling) {
    // Non-scheduling (relates, duplicates, copied_to): center-to-center with border anchors
    const centerX1 = (source.startX + source.endX) / 2;
    const centerX2 = (target.startX + target.endX) / 2;
    const goingDown = target.y > source.y;
    const sameRowCenter = Math.abs(source.y - target.y) < 5;

    const centersAligned = Math.abs(centerX1 - centerX2) < 5;

    if (sameRowCenter) {
      // Same row: route above the bars
      x1 = centerX1;
      y1 = source.y - barHeight / 2; // top border
      x2 = centerX2;
      y2 = target.y - barHeight / 2; // top border
      const routeY = y1 - 8; // above bars
      path = `M ${x1} ${y1} V ${routeY + r}` +
        ` q 0 ${-r} ${x2 > x1 ? r : -r} ${-r}` +
        ` H ${x2 + (x2 > x1 ? -r : r)}` +
        ` q ${x2 > x1 ? r : -r} 0 ${x2 > x1 ? r : -r} ${r}` +
        ` V ${y2}`;
    } else if (centersAligned) {
      // Centers aligned: straight vertical line
      x1 = centerX1;
      y1 = goingDown ? source.y + barHeight / 2 : source.y - barHeight / 2;
      x2 = centerX1; // use same x for straight line
      y2 = goingDown ? target.y - barHeight / 2 : target.y + barHeight / 2;
      path = `M ${x1} ${y1} V ${y2}`;
    } else {
      // Different rows: vertical first, then horizontal, then vertical
      x1 = centerX1;
      y1 = goingDown ? source.y + barHeight / 2 : source.y - barHeight / 2; // bottom or top border
      x2 = centerX2;
      y2 = goingDown ? target.y - barHeight / 2 : target.y + barHeight / 2; // top or bottom border
      const midY = (source.y + target.y) / 2;
      path = `M ${x1} ${y1} V ${midY + (goingDown ? -r : r)}` +
        ` q 0 ${goingDown ? r : -r} ${x2 > x1 ? r : -r} ${goingDown ? r : -r}` +
        ` H ${x2 + (x2 > x1 ? -r : r)}` +
        ` q ${x2 > x1 ? r : -r} 0 ${x2 > x1 ? r : -r} ${goingDown ? r : -r}` +
        ` V ${y2}`;
    }
  } else {
    // Scheduling relations: edge-to-edge anchors
    x1 = fromStart ? source.startX - 2 : source.endX + 2;
    y1 = source.y;
    x2 = toEnd ? target.endX + 2 : target.startX - 2;
    y2 = target.y;
  }

  // Variables for scheduling arrow routing
  const goingRight = x2 > x1;
  const horizontalDist = Math.abs(x2 - x1);
  const nearlyVertical = horizontalDist < 30;
  const jogDir = fromStart ? -1 : 1;
  const approachDir = toEnd ? 1 : -1;
  const minJogRoom = 8 + r; // jogX + r = minimum room for simple jog path

  if (!isScheduling) {
    // Path already computed above
  } else if (sameRow && goingRight) {
    // Same row, target to right: straight horizontal line
    path = `M ${x1} ${y1} H ${x2}`;
  } else if (sameRow && !goingRight) {
    // Same row, target to left: route above with rounded corners
    const routeY = y1 - barHeight;
    path = `M ${x1} ${y1} V ${routeY + r}` +
      ` q 0 ${-r} ${jogDir * -r} ${-r}` +
      ` H ${x2 + approachDir * 12 - approachDir * r}` +
      ` q ${approachDir * -r} 0 ${approachDir * -r} ${r}` +
      ` V ${y2} H ${x2}`;
  } else if (!sameRow && nearlyVertical && (fromStart === goingRight || horizontalDist < minJogRoom)) {
    // Nearly vertical: S-curve with 90° turns when:
    // 1. Direction conflict (jog opposite to target direction), OR
    // 2. Not enough horizontal room for simple jog path (< 12px)
    // jogDir: which way to jog from source (-1=left, +1=right)
    // approachDir: which side to approach target from (-1=left, +1=right)
    const jogX = 8;
    const midY = (y1 + y2) / 2;
    const goingDown = y2 > y1;
    path = `M ${x1} ${y1} H ${x1 + jogDir * jogX - jogDir * r}` +
      ` q ${jogDir * r} 0 ${jogDir * r} ${goingDown ? r : -r}` +
      ` V ${midY + (goingDown ? -r : r)}` +
      ` q 0 ${goingDown ? r : -r} ${-jogDir * r} ${goingDown ? r : -r}` +
      ` H ${x2 + approachDir * jogX - approachDir * r}` +
      ` q ${approachDir * r} 0 ${approachDir * r} ${goingDown ? r : -r}` +
      ` V ${y2 + (goingDown ? -r : r)}` +
      ` q 0 ${goingDown ? r : -r} ${-approachDir * r} ${goingDown ? r : -r}` +
      ` H ${x2}`;
  } else if (goingRight && !fromStart) {
    // FS/FF with target to right: small jog, vertical to target level, horizontal approach
    const jogX = 8;
    const goingDown = y2 > y1;
    // Second curve turns toward target (right), not back toward source
    path = `M ${x1} ${y1} H ${x1 + jogDir * jogX - jogDir * r}` +
      ` q ${jogDir * r} 0 ${jogDir * r} ${goingDown ? r : -r}` +
      ` V ${y2 + (goingDown ? -r : r)}` +
      ` q 0 ${goingDown ? r : -r} ${r} ${goingDown ? r : -r}` +
      ` H ${x2}`;
  } else if (goingRight) {
    // SS/SF with target to right: horizontal at source level, then down, then approach
    const jogX = 8;
    const goingDown = y2 > y1;
    path = `M ${x1} ${y1} H ${x2 + approachDir * jogX - approachDir * r}` +
      ` q ${approachDir * r} 0 ${approachDir * r} ${goingDown ? r : -r}` +
      ` V ${y2 + (goingDown ? -r : r)}` +
      ` q 0 ${goingDown ? r : -r} ${-approachDir * r} ${goingDown ? r : -r}` +
      ` H ${x2}`;
  } else if (fromStart) {
    // SS/SF going left: horizontal at source level, then down, then approach
    const jogX = 8;
    const goingDown = y2 > y1;
    path = `M ${x1} ${y1} H ${x2 + approachDir * jogX + r}` +
      ` q ${-r} 0 ${-r} ${goingDown ? r : -r}` +
      ` V ${y2 + (goingDown ? -r : r)}` +
      ` q 0 ${goingDown ? r : -r} ${r} ${goingDown ? r : -r}` +
      ` H ${x2}`;
  } else {
    // FS/FF going left: S-curve with horizontal between rows
    const jogX = 8;
    const midY = (y1 + y2) / 2;
    const goingDown = y2 > y1;
    path = `M ${x1} ${y1} H ${x1 + jogDir * jogX - jogDir * r}` +
      ` q ${jogDir * r} 0 ${jogDir * r} ${goingDown ? r : -r}` +
      ` V ${midY + (goingDown ? -r : r)}` +
      ` q 0 ${goingDown ? r : -r} ${-r} ${goingDown ? r : -r}` +
      ` H ${x2 + approachDir * jogX + r}` +
      ` q ${-r} 0 ${-r} ${goingDown ? r : -r}` +
      ` V ${y2 + (goingDown ? -r : r)}` +
      ` q 0 ${goingDown ? r : -r} ${r} ${goingDown ? r : -r}` +
      ` H ${x2}`;
  }

  // Chevron arrowhead - direction depends on approach
  let arrowHead;
  if (!isScheduling) {
    // Non-scheduling: vertical approach, arrowhead points down or up
    const goingDown = target.y > source.y;
    const sameRowCenter = Math.abs(source.y - target.y) < 5;
    if (sameRowCenter) {
      // Same row routed above: arrowhead points down
      arrowHead = `M ${x2 - arrowSize * 0.6} ${y2 - arrowSize} L ${x2} ${y2} L ${x2 + arrowSize * 0.6} ${y2 - arrowSize}`;
    } else {
      arrowHead = goingDown
        ? `M ${x2 - arrowSize * 0.6} ${y2 - arrowSize} L ${x2} ${y2} L ${x2 + arrowSize * 0.6} ${y2 - arrowSize}`
        : `M ${x2 - arrowSize * 0.6} ${y2 + arrowSize} L ${x2} ${y2} L ${x2 + arrowSize * 0.6} ${y2 + arrowSize}`;
    }
  } else {
    // Scheduling: horizontal approach
    // toStart: arrow comes from left, points right (wings at x2-size)
    // toEnd: arrow comes from right, points left (wings at x2+size)
    arrowHead = toEnd
      ? `M ${x2 + arrowSize} ${y2 - arrowSize * 0.6} L ${x2} ${y2} L ${x2 + arrowSize} ${y2 + arrowSize * 0.6}`
      : `M ${x2 - arrowSize} ${y2 - arrowSize * 0.6} L ${x2} ${y2} L ${x2 - arrowSize} ${y2 + arrowSize * 0.6}`;
  }

  const dashAttr = style.dash ? `stroke-dasharray="${style.dash}"` : "";

  const arrowTooltip = `#${rel.fromId} ${style.label} #${rel.toId}\n${style.tip}\n(right-click to delete)`;
  return {
    svg: `
            <g class="dependency-arrow rel-${rel.type} cursor-pointer" data-relation-id="${rel.relationId}" data-from="${rel.fromId}" data-to="${rel.toId}">
              <title>${escapeAttr(arrowTooltip)}</title>
              <!-- Wide invisible hit area for easier clicking -->
              <path class="arrow-hit-area" d="${path}" stroke="transparent" stroke-width="24" fill="none"/>
              <path class="arrow-line" d="${path}" stroke-width="2" fill="none" ${dashAttr}/>
              <path class="arrow-head" d="${arrowHead}" fill="none"/>
            </g>
          `,
    hasDash: !!style.dash,
  };
}

/**
 * Build the dependency-layer markup for a set of relations. `getPosition(id)`
 * returns `{startX, endX, y} | null` — null endpoints (row filtered out or
 * outside the mounted window) skip the arrow. Solid arrows render before
 * dashed ones (same z-order the extension emitted).
 * @returns {string}
 */
export function buildArrowsMarkup(arrows, getPosition, barHeight) {
  return arrows
    .map((rel) => {
      const source = getPosition(rel.fromId);
      const target = getPosition(rel.toId);
      if (!source || !target) return null;
      return buildArrowSvg(source, target, rel, barHeight);
    })
    .filter((item) => item !== null)
    .sort((a, b) => (a.hasDash === b.hasDash ? 0 : a.hasDash ? 1 : -1))
    .map((item) => item.svg)
    .join("");
}
