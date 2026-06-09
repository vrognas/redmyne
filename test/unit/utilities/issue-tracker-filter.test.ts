import { describe, it, expect } from "vitest";
import {
  deriveTrackers,
  filterIssuesByTracker,
} from "../../../src/utilities/issue-tracker-filter";

const issue = (id: number, trackerId: number, trackerName: string) => ({
  id,
  tracker: { id: trackerId, name: trackerName },
});

describe("issue-tracker-filter", () => {
  it("deriveTrackers returns unique trackers sorted by name", () => {
    const issues = [
      issue(1, 3, "Task"),
      issue(2, 1, "Data Management"),
      issue(3, 3, "Task"),
      issue(4, 2, "Bug"),
    ];
    expect(deriveTrackers(issues)).toEqual([
      { id: 2, name: "Bug" },
      { id: 1, name: "Data Management" },
      { id: 3, name: "Task" },
    ]);
  });

  it("deriveTrackers skips issues with no tracker and handles empty", () => {
    expect(deriveTrackers([])).toEqual([]);
    expect(
      deriveTrackers([{ id: 1 }, { id: 2, tracker: { id: 5, name: "QC" } }])
    ).toEqual([{ id: 5, name: "QC" }]);
  });

  it("filterIssuesByTracker: 'any'/undefined passes through, id keeps matches", () => {
    const issues = [issue(1, 1, "Data Management"), issue(2, 3, "Task")];
    expect(filterIssuesByTracker(issues, "any")).toEqual(issues);
    expect(filterIssuesByTracker(issues, undefined)).toEqual(issues);
    expect(filterIssuesByTracker(issues, 1)).toEqual([issues[0]]);
  });
});
