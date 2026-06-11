/**
 * Dependency-arrow SVG builder for the windowed row renderer. MOVED verbatim
 * from gantt-panel.ts's _getRenderPayload arrow block (routing cases, corner
 * radius, arrowheads, hit areas) — only the inputs changed: positions come
 * from the row-window's virtual Ys + per-row bar X ranges, and there are no
 * hidden-row markers (an arrow whose rows are collapsed simply isn't mounted).
 * Pure string building — no DOM.
 */

// Canonical escaper (the deleted extension arrow block used the same one) —
// a local copy with the same name but weaker escaping invited divergence.
import { escapeAttr } from '../gantt-html-escape';

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
  // Long horizontal runs travel in the GUTTER between rows (row boundaries
  // fall on multiples of barHeight; bar content has vertical padding, so a
  // line on the boundary crosses no bars, badges or labels).
  const snapGutter = (y) => Math.round(y / barHeight) * barHeight;

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
      const midY = snapGutter((source.y + target.y) / 2);
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
  const jogDir = fromStart ? -1 : 1;
  const approachDir = toEnd ? 1 : -1;
  // Horizontal direction of the FINAL segment into the target anchor —
  // the arrowhead must point the way the path actually arrives. A
  // vertical arrival (near-aligned anchors land on the bar's top/bottom
  // edge) sets verticalArrivalY instead.
  let arrivalX = -approachDir;
  let verticalArrival = false;
  let verticalArrivalY = 0;

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
  } else {
    // Cross-row scheduling arrows: gutter routing. Exit the source with a
    // short stub, dive to the row boundary adjacent to the TARGET row,
    // travel the long horizontal there (between rows, crossing no
    // content), then a short final descent and approach stub.
    const jogX = 8;
    const goingDown = y2 > y1;
    const vdir = goingDown ? 1 : -1;
    const gutterY = y2 - vdir * (barHeight / 2);
    const ex = x1 + jogDir * jogX; // source exit stub end
    const ax = x2 + approachDir * jogX; // target approach stub start

    if (Math.abs(ax - ex) < 2 * r + 2) {
      // Anchors nearly aligned horizontally: any side-lane either grazes
      // the source, pokes into the target bar, or leaves a sub-radius
      // final stub. Drop a single vertical at the anchor x and land ON
      // the target bar's edge with a vertical arrowhead.
      verticalArrival = true;
      verticalArrivalY = y2 - vdir * (barHeight / 2 - 2);
      if (Math.abs(x2 - x1) < r + 2) {
        path = `M ${x2} ${y1} V ${verticalArrivalY}`;
      } else {
        const dH1 = x2 > x1 ? 1 : -1;
        path = `M ${x1} ${y1} H ${x2 - dH1 * r}` +
          ` q ${dH1 * r} 0 ${dH1 * r} ${vdir * r}` +
          ` V ${verticalArrivalY}`;
      }
    } else {
      const hdir = ax > ex ? 1 : -1;
      path = `M ${x1} ${y1} H ${ex - jogDir * r}` +
        ` q ${jogDir * r} 0 ${jogDir * r} ${vdir * r}` +
        ` V ${gutterY - vdir * r}` +
        ` q 0 ${vdir * r} ${hdir * r} ${vdir * r}` +
        ` H ${ax - hdir * r}` +
        ` q ${hdir * r} 0 ${hdir * r} ${vdir * r}` +
        ` V ${y2 - vdir * r}` +
        ` q 0 ${vdir * r} ${-approachDir * r} ${vdir * r}` +
        ` H ${x2}`;
    }
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
    // Scheduling: wings sit on the side the path arrives FROM.
    if (verticalArrival) {
      const goingDown = target.y > source.y;
      arrowHead = goingDown
        ? `M ${x2 - arrowSize * 0.6} ${verticalArrivalY - arrowSize} L ${x2} ${verticalArrivalY} L ${x2 + arrowSize * 0.6} ${verticalArrivalY - arrowSize}`
        : `M ${x2 - arrowSize * 0.6} ${verticalArrivalY + arrowSize} L ${x2} ${verticalArrivalY} L ${x2 + arrowSize * 0.6} ${verticalArrivalY + arrowSize}`;
    } else {
      arrowHead = arrivalX > 0
        ? `M ${x2 - arrowSize} ${y2 - arrowSize * 0.6} L ${x2} ${y2} L ${x2 - arrowSize} ${y2 + arrowSize * 0.6}`
        : `M ${x2 + arrowSize} ${y2 - arrowSize * 0.6} L ${x2} ${y2} L ${x2 + arrowSize} ${y2 + arrowSize * 0.6}`;
    }
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
