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
