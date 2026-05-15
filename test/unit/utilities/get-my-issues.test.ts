import { describe, it, expect, vi } from "vitest";
import { fetchMyOpenAndClosedIssues } from "../../../src/utilities/get-my-issues";
import { Issue } from "../../../src/redmine/models/issue";

function makeIssue(id: number): Issue {
  return {
    id,
    subject: `Issue ${id}`,
    tracker: { id: 1, name: "Task" },
    status: { id: 1, name: "New" },
    author: { id: 1, name: "A" },
    project: { id: 1, name: "P" },
    description: "",
    created_on: "2024-01-01",
    updated_on: "2024-01-01",
  };
}

describe("fetchMyOpenAndClosedIssues", () => {
  it("calls getFilteredIssues for me/open and me/closed in parallel and returns both sets", async () => {
    const openIssues = [makeIssue(1), makeIssue(2)];
    const closedIssues = [makeIssue(3)];
    const getFilteredIssues = vi.fn(async (filter: { status: "open" | "closed" | "any" }) => ({
      issues: filter.status === "open" ? openIssues : closedIssues,
    }));

    const server = { getFilteredIssues } as never;
    const result = await fetchMyOpenAndClosedIssues(server);

    expect(result).toEqual({ open: openIssues, closed: closedIssues });
    expect(getFilteredIssues).toHaveBeenCalledTimes(2);
    expect(getFilteredIssues).toHaveBeenNthCalledWith(1, { assignee: "me", status: "open" });
    expect(getFilteredIssues).toHaveBeenNthCalledWith(2, { assignee: "me", status: "closed" });
  });

  it("propagates server errors", async () => {
    const server = {
      getFilteredIssues: vi.fn().mockRejectedValue(new Error("server down")),
    } as never;

    await expect(fetchMyOpenAndClosedIssues(server)).rejects.toThrow("server down");
  });
});
