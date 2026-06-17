import { describe, it, expect } from "vitest";
import { formatIssueLabel } from "../../../src/utilities/issue-label";

describe("formatIssueLabel", () => {
  it("returns '#id subject' with defaults", () => {
    expect(formatIssueLabel({ id: 1, subject: "Foo" })).toBe("#1 Foo");
  });

  it("uses colon separator when specified", () => {
    expect(formatIssueLabel({ id: 1, subject: "Foo" }, { separator: ": " })).toBe("#1: Foo");
  });

  it("prepends $(icon) prefix when icon provided", () => {
    expect(formatIssueLabel({ id: 1, subject: "Foo" }, { icon: "archive" })).toBe("$(archive) #1 Foo");
  });
});
