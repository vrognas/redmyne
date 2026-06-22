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
      startDateColumnWidth: 68,
      statusColumnWidth: 58,
      dueDateColumnWidth: 68,
      assigneeColumnWidth: 50,
      resizeHandleWidth: 10,
    });
  });
});

describe("computeStickyLeftWidth", () => {
  it("derives extraColumnsWidth + stickyLeftWidth from the fixed idColumnWidth by default", () => {
    // extraColumnsWidth = 50 + 68 + 58 + 68 + 50 = 294
    // stickyLeftWidth   = 250 (label) + 10 (handle) + 294 = 554
    expect(computeStickyLeftWidth()).toEqual({
      extraColumnsWidth: 294,
      stickyLeftWidth: 554,
    });
  });

  it("parameterizes on idColumnWidth for the auto-fit render-payload case", () => {
    // idColumnWidth=40 → extraColumnsWidth = 40+68+58+68+50 = 284 → sticky = 250+10+284 = 544
    expect(computeStickyLeftWidth(40)).toEqual({
      extraColumnsWidth: 284,
      stickyLeftWidth: 544,
    });
  });
});
