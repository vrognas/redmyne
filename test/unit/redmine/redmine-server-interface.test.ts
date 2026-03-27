import { describe, it, expect } from "vitest";
import type { IRedmineServer } from "../../../src/redmine/redmine-server-interface";
import type { RedmineServer } from "../../../src/redmine/redmine-server";
import type { DraftModeServer } from "../../../src/draft-mode/draft-mode-server";

/**
 * Type-level tests: these verify at compile time that both classes
 * satisfy IRedmineServer. The runtime assertions are trivial —
 * the real check is that this file compiles without errors.
 */
describe("IRedmineServer interface", () => {
  it("RedmineServer satisfies IRedmineServer", () => {
    // Compile-time check: assignment must be valid
    const _check: (s: RedmineServer) => IRedmineServer = (s) => s;
    expect(_check).toBeDefined();
  });

  it("DraftModeServer satisfies IRedmineServer", () => {
    const _check: (s: DraftModeServer) => IRedmineServer = (s) => s;
    expect(_check).toBeDefined();
  });

  it("interface includes all key method groups", () => {
    // Runtime spot-check that the interface shape is importable
    const methodGroups: (keyof IRedmineServer)[] = [
      "getProjects",
      "getIssueById",
      "createIssue",
      "addTimeEntry",
      "getTimeEntries",
      "createVersion",
      "getIssueStatuses",
      "getCurrentUser",
      "getUserFte",
      "getUserFteBatch",
      "getMemberships",
      "compare",
      "createRelation",
      "post",
    ];
    expect(methodGroups).toHaveLength(14);
  });
});
