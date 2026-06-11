import { describe, it, expect } from "vitest";
import { buildArrowSvg, buildArrowsMarkup } from "../../../src/webviews/gantt/arrow-svg.js";

const BAR = 22;
const pos = (startX: number, endX: number, y: number) => ({ startX, endX, y });

describe("arrow-svg", () => {
  it("scheduling relation on the same row going right is a straight line", () => {
    const { svg, hasDash } = buildArrowSvg(
      pos(0, 100, 11), pos(150, 200, 11),
      { relationId: 5, fromId: 1, toId: 2, type: "blocks" }, BAR
    );
    expect(svg).toContain('data-relation-id="5"');
    expect(svg).toContain("rel-blocks");
    expect(svg).toContain("M 102 11 H 148"); // endX+2 → startX-2
    expect(hasDash).toBe(false);
  });

  it("non-scheduling relation routes center-to-center and is dashed", () => {
    const { svg, hasDash } = buildArrowSvg(
      pos(0, 100, 11), pos(0, 100, 55),
      { relationId: 6, fromId: 1, toId: 2, type: "relates" }, BAR
    );
    expect(hasDash).toBe(true);
    expect(svg).toContain('stroke-dasharray="4,3"');
    expect(svg).toContain("M 50 22 V 44"); // aligned centers: straight vertical border-to-border
  });

  it("cross-row scheduling arrows run their long horizontal in the gutter", () => {
    // source row center y=11 (row 0), target row center y=99 (row 4):
    // the gutter above the target row sits on the boundary 88 (4 × 22).
    const { svg } = buildArrowSvg(
      pos(0, 100, 11), pos(300, 400, 99),
      { relationId: 10, fromId: 1, toId: 2, type: "blocks" }, BAR
    );
    expect(svg).toContain("V 84"); // dive to gutter (88 − corner radius)
    expect(svg).toContain("H 286"); // long run AT the gutter, not a row center
    expect(svg).toContain("V 95"); // short final descent into the target row
    expect(svg).toContain("H 298"); // approach stub to target.startX − 2
  });

  it("near-aligned stubs route one clean vertical (no doubling back)", () => {
    // FS arrow where the target's start sits just right of the source's
    // end: exit stub (endX+2+8) and approach stub (startX-2-8) nearly
    // coincide — the old fallback curled here.
    const { svg } = buildArrowSvg(
      pos(0, 100, 11), pos(118, 200, 55),
      { relationId: 11, fromId: 1, toId: 2, type: "blocks" }, BAR
    );
    // single vertical at the approach x (116-8=108), direction-aware corners
    expect(svg).toContain("V 51");
    expect(svg).toContain("H 116");
    // no segment may travel right then immediately back left past its origin
    expect(svg).not.toMatch(/q -?\d+ 0 -?\d+ -?\d+ q/); // no back-to-back corners
  });

  it("flips lane and arrowhead when the vertical would graze the source", () => {
    // FS where target.startX - 2 - 8 lands within a corner radius of the
    // source exit: lane must flip to the far side of the target and the
    // head must point the way the path arrives (leftward here).
    const src = pos(0, 100, 11); // exit at 102
    const tgt = pos(112, 200, 55); // default lane 102 → collides
    const { svg } = buildArrowSvg(
      src, tgt, { relationId: 12, fromId: 1, toId: 2, type: "blocks" }, BAR
    );
    expect(svg).toContain("H 114"); // corner start before vx = 110+4+... lane right of target start
    // head points LEFT (wings at x2 + size): M 114 ... L 110 55
    expect(svg).toContain(`M 114 ${55 - 2.4} L 110 55`);
  });

  it("buildArrowsMarkup skips null endpoints and sorts solid before dashed", () => {
    const positions = new Map([
      [1, pos(0, 100, 11)],
      [2, pos(150, 200, 11)],
    ]);
    const markup = buildArrowsMarkup(
      [
        { relationId: 7, fromId: 1, toId: 2, type: "relates" },  // dashed
        { relationId: 8, fromId: 1, toId: 2, type: "blocks" },   // solid
        { relationId: 9, fromId: 1, toId: 99, type: "blocks" },  // missing endpoint -> skipped
      ],
      (id: number) => positions.get(id) ?? null,
      BAR
    );
    expect(markup).not.toContain('data-relation-id="9"');
    const solidIdx = markup.indexOf('data-relation-id="8"');
    const dashedIdx = markup.indexOf('data-relation-id="7"');
    expect(solidIdx).toBeGreaterThanOrEqual(0);
    expect(dashedIdx).toBeGreaterThan(solidIdx); // solid first
  });
});
