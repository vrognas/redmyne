import { describe, expect, it } from "vitest";
import { buildIssueUrl, buildProjectUrl } from "../../../src/commands/command-urls";

describe("command-urls", () => {
  it("builds issue URL", () => {
    expect(buildIssueUrl("https://redmine.example.test", 42)).toBe(
      "https://redmine.example.test/issues/42"
    );
  });

  it("builds project URL", () => {
    expect(buildProjectUrl("https://redmine.example.test", "operations")).toBe(
      "https://redmine.example.test/projects/operations"
    );
  });
});
