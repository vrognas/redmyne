import { describe, it, expect } from "vitest";
import {
  computeVisibleList,
  computeMountRange,
  computeZebraBands,
  computeIndentSpans,
} from "../../../src/webviews/gantt/row-window-utils.js";

// Minimal row factory matching GanttRowPayload meta
function row(key: string, parentKey: string | null, depth: number, type = "issue", hasChildren = false) {
  return { key, parentKey, depth, type, hasChildren };
}

// Two clients, each with a project; project-2 has issues 100 (parent of 101) and 102
const ROWS = [
  row("project-1", null, 0, "project", true),
  row("project-2", "project-1", 1, "project", true),
  row("issue-100", "project-2", 2, "issue", true),
  row("issue-101", "issue-100", 3, "issue"),
  row("issue-102", "project-2", 2, "issue"),
  row("project-3", null, 0, "project", true),
  row("project-4", "project-3", 1, "project", true),
  row("issue-200", "project-4", 2, "issue"),
];

describe("computeVisibleList", () => {
  it("roots always visible; children only when every ancestor is expanded", () => {
    const visible = computeVisibleList(ROWS, new Set(["project-1", "project-2"]));
    expect(visible.map((r: any) => r.key)).toEqual([
      "project-1", "project-2", "issue-100", "issue-102", "project-3",
    ]); // issue-101 hidden (issue-100 collapsed); project-4 hidden (project-3 collapsed)
  });

  it("everything collapsed -> roots only; fully expanded -> document order", () => {
    expect(computeVisibleList(ROWS, new Set()).map((r: any) => r.key)).toEqual(["project-1", "project-3"]);
    const all = new Set(["project-1", "project-2", "project-3", "project-4", "issue-100"]);
    expect(computeVisibleList(ROWS, all).map((r: any) => r.key)).toEqual(ROWS.map(r => r.key));
  });
});

describe("computeMountRange", () => {
  it("buffers and clamps to list bounds", () => {
    // 22px rows, viewport 220px (10 rows), scrolled to row 50
    expect(computeMountRange(50 * 22, 220, 22, 200, 10)).toEqual({ first: 40, last: 70 });
    expect(computeMountRange(0, 220, 22, 200, 10)).toEqual({ first: 0, last: 20 });
    expect(computeMountRange(199 * 22, 220, 22, 200, 10)).toEqual({ first: 189, last: 199 });
  });

  it("short and empty lists", () => {
    expect(computeMountRange(0, 1000, 22, 5, 10)).toEqual({ first: 0, last: 4 });
    expect(computeMountRange(0, 1000, 22, 0, 10)).toEqual({ first: 0, last: -1 });
  });
});

describe("computeZebraBands", () => {
  it("multi-root: one band per depth-0 block", () => {
    const visible = computeVisibleList(ROWS, new Set(["project-1", "project-2"]));
    const bands = computeZebraBands(visible, true);
    expect(bands).toEqual([
      { startIdx: 0, endIdx: 3, bandIdx: 0 }, // project-1 block (4 visible rows)
      { startIdx: 4, endIdx: 4, bandIdx: 1 }, // project-3 block
    ]);
  });

  it("single hierarchy: bands per top-level issue family (min issue depth)", () => {
    // Selected project view: project rows skipped at top, issues at depth 0/1
    const visible = [
      row("issue-100", null, 0, "issue", true),
      row("issue-101", "issue-100", 1, "issue"),
      row("issue-102", null, 0, "issue"),
    ];
    const bands = computeZebraBands(visible, false);
    expect(bands).toEqual([
      { startIdx: 0, endIdx: 1, bandIdx: 0 },
      { startIdx: 2, endIdx: 2, bandIdx: 1 },
    ]);
  });

  it("empty list -> no bands", () => {
    expect(computeZebraBands([], true)).toEqual([]);
  });
});

describe("computeIndentSpans", () => {
  it("one contiguous span per expanded parent with visible children", () => {
    const all = new Set(["project-1", "project-2", "project-3", "project-4", "issue-100"]);
    const visible = computeVisibleList(ROWS, all);
    const spans = computeIndentSpans(visible);
    // parent -> [first child idx, last visible descendant idx]
    expect(spans).toContainEqual({ parentKey: "project-1", depth: 0, startIdx: 1, endIdx: 4 });
    expect(spans).toContainEqual({ parentKey: "project-2", depth: 1, startIdx: 2, endIdx: 4 });
    expect(spans).toContainEqual({ parentKey: "issue-100", depth: 2, startIdx: 3, endIdx: 3 });
    expect(spans).toContainEqual({ parentKey: "project-4", depth: 1, startIdx: 7, endIdx: 7 });
  });

  it("collapsed or childless rows produce no span", () => {
    const visible = computeVisibleList(ROWS, new Set()); // roots only, both collapsed
    expect(computeIndentSpans(visible)).toEqual([]);
  });
});
