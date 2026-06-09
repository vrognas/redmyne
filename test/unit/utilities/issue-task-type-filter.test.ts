import { describe, it, expect } from "vitest";
import {
  deriveTaskTypes,
  filterIssuesByTaskType,
} from "../../../src/utilities/issue-task-type-filter";

const FIELD = "Task Type";
const issue = (id: number, taskType?: string) => ({
  id,
  custom_fields: [
    { id: 9, name: "Other", value: "x" },
    ...(taskType !== undefined ? [{ id: 5, name: FIELD, value: taskType }] : []),
  ],
});

describe("issue-task-type-filter", () => {
  it("deriveTaskTypes returns distinct field values sorted by name", () => {
    const issues = [
      issue(1, "Task Design"),
      issue(2, "Data Management"),
      issue(3, "Task Design"),
      issue(4, "Analysis"),
    ];
    expect(deriveTaskTypes(issues, FIELD)).toEqual([
      "Analysis",
      "Data Management",
      "Task Design",
    ]);
  });

  it("deriveTaskTypes ignores issues lacking the field or with empty value", () => {
    expect(deriveTaskTypes([], FIELD)).toEqual([]);
    expect(
      deriveTaskTypes([issue(1), issue(2, ""), issue(3, "QC")], FIELD)
    ).toEqual(["QC"]);
  });

  it("filterIssuesByTaskType: 'any'/undefined passes through, value keeps matches", () => {
    const issues = [issue(1, "Data Management"), issue(2, "Analysis")];
    expect(filterIssuesByTaskType(issues, FIELD, "any")).toEqual(issues);
    expect(filterIssuesByTaskType(issues, FIELD, undefined)).toEqual(issues);
    expect(filterIssuesByTaskType(issues, FIELD, "Data Management")).toEqual([
      issues[0],
    ]);
  });
});
