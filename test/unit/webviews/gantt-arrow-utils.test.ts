import { describe, it, expect } from "vitest";
import { computeArrowEndpoints } from "../../../src/webviews/gantt/arrow-utils.js";

const geo = {
  fromStartX: 100, fromEndX: 200, fromY: 36,
  toStartX: 300, toEndX: 400, toY: 84,
  barHeight: 24,
};

describe("computeArrowEndpoints", () => {
  it("scheduling default anchors: from end -> to start", () => {
    const r = computeArrowEndpoints({ ...geo, relType: "precedes" });
    expect(r).toEqual({
      x1: 202, y1: 36, x2: 298, y2: 84,
      isScheduling: true, fromStart: false, toEnd: false,
    });
  });

  it("start_to_finish anchors: from start -> to end", () => {
    const r = computeArrowEndpoints({ ...geo, relType: "start_to_finish" });
    expect(r).toEqual({
      x1: 98, y1: 36, x2: 402, y2: 84,
      isScheduling: true, fromStart: true, toEnd: true,
    });
  });

  it("non-scheduling: center x, border y by direction; same-row uses top borders", () => {
    const down = computeArrowEndpoints({ ...geo, relType: "relates" });
    expect(down).toMatchObject({
      x1: 150, y1: 48, x2: 350, y2: 72, isScheduling: false,
    });
    const same = computeArrowEndpoints({ ...geo, toY: 38, relType: "relates" });
    expect(same).toMatchObject({ y1: 24, y2: 26 }); // both top borders (|dy| < 5)
  });
});
