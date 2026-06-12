import { describe, it, expect } from "vitest";
import { buildArrowSvg, buildArrowsMarkup, computeArrowGeometry } from "../../../src/webviews/gantt/arrow-svg.js";

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

  it("near-aligned anchors land vertically on the target bar's edge", () => {
    // FS arrow where the target's start sits just right of the source's
    // end — side lanes graze the source or poke into the target, so the
    // path drops at the anchor x and lands on the bar top (y2 − bh/2 + 2)
    // with a downward arrowhead.
    const { svg } = buildArrowSvg(
      pos(0, 100, 11), pos(118, 200, 55),
      { relationId: 11, fromId: 1, toId: 2, type: "blocks" }, BAR
    );
    expect(svg).toContain("V 46"); // lands on bar top edge, not row center
    expect(svg).toContain(`L 116 46`); // arrowhead tip at the landing point
    expect(svg).not.toContain("H 116\""); // no horizontal approach stub
  });

  it("vertical arrival also covers anchors grazing the source exit", () => {
    const src = pos(0, 100, 11); // exit at 102
    const tgt = pos(112, 200, 55); // anchor at 110, 8px from the exit
    const { svg } = buildArrowSvg(
      src, tgt, { relationId: 12, fromId: 1, toId: 2, type: "blocks" }, BAR
    );
    expect(svg).toContain("V 46");
    expect(svg).toContain("L 110 46"); // downward head at the anchor x
  });

  it("computeArrowGeometry returns the exact path buildArrowSvg embeds", () => {
    // The drag updater calls computeArrowGeometry directly — parity with
    // the rendered markup is the whole point of the shared extraction.
    const source = pos(0, 100, 11);
    const target = pos(300, 400, 99);
    const { path, arrowHead, isScheduling } = computeArrowGeometry(source, target, "blocks", BAR);
    const { svg } = buildArrowSvg(
      source, target, { relationId: 1, fromId: 1, toId: 2, type: "blocks" }, BAR
    );
    expect(isScheduling).toBe(true);
    expect(svg).toContain(`d="${path}"`);
    expect(svg).toContain(`d="${arrowHead}"`);
  });

  it("computeArrowGeometry snaps relates midpoints to the gutter", () => {
    // Old drag-time router used the raw row midpoint (V 51 here); the
    // shared router snaps the long horizontal to a row boundary.
    const { path } = computeArrowGeometry(pos(0, 100, 11), pos(300, 400, 99), "relates", BAR);
    expect(path).toContain("V 62"); // gutter 66 (3 × 22) minus corner radius
    expect(path).not.toContain("V 51");
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
