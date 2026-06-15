import { describe, expect, it } from "vitest";
import {
  GANTT_LAYOUT,
  computeStickyLeftWidth,
} from "../../../src/webviews/gantt/gantt-layout-constants";

describe("GANTT_LAYOUT", () => {
  it("holds the fixed layout widths/heights shared by skeleton, fallback, and render payload", () => {
    expect(GANTT_LAYOUT).toEqual({
      labelWidth: 250,
      headerHeight: 40,
      barHeight: 22,
      idColumnWidth: 50,
      startDateColumnWidth: 58,
      statusColumnWidth: 50,
      dueDateColumnWidth: 58,
      assigneeColumnWidth: 40,
      resizeHandleWidth: 10,
    });
  });
});

describe("computeStickyLeftWidth", () => {
  it("derives extraColumnsWidth + stickyLeftWidth from the fixed idColumnWidth by default", () => {
    // extraColumnsWidth = 50 + 58 + 50 + 58 + 40 = 256
    // stickyLeftWidth   = 250 (label) + 10 (handle) + 256 = 516
    expect(computeStickyLeftWidth()).toEqual({
      extraColumnsWidth: 256,
      stickyLeftWidth: 516,
    });
  });

  it("parameterizes on idColumnWidth for the auto-fit render-payload case", () => {
    // idColumnWidth=40 → extraColumnsWidth = 40+58+50+58+40 = 246 → sticky = 250+10+246 = 506
    expect(computeStickyLeftWidth(40)).toEqual({
      extraColumnsWidth: 246,
      stickyLeftWidth: 506,
    });
  });
});
