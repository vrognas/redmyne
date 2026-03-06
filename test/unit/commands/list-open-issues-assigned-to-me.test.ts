import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import listOpenIssuesAssignedToMe from "../../../src/commands/list-open-issues-assigned-to-me";
import { IssueController } from "../../../src/controllers/issue-controller";

function createIssue(id: number) {
  return {
    id,
    subject: `Issue ${id}`,
    description: "Desc\nwith line break",
    tracker: { id: 1, name: "Task" },
    status: { id: 1, name: "New" },
    author: { id: 2, name: "Author" },
    assigned_to: { id: 3, name: "Assignee" },
    priority: { id: 1, name: "Normal" },
    project: { id: 1, name: "Project 1" },
    start_date: "2026-01-01",
    due_date: "2026-01-02",
    done_ratio: 0,
    is_private: false,
    created_on: "2026-01-01T00:00:00Z",
    updated_on: "2026-01-01T00:00:00Z",
  } as unknown as import("../../../src/redmine/models/issue").Issue;
}

describe("list-open-issues-assigned-to-me command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("shows picker and opens actions for selected issue", async () => {
    const server = {
      options: { url: { hostname: "redmine.example" } },
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [createIssue(10)] }),
    };
    vi.spyOn(vscode.window, "withProgress").mockImplementation(
      (_options, task) =>
        task(
          {
            report: vi.fn(),
          } as unknown as vscode.Progress<{ message?: string; increment?: number }>,
          {} as vscode.CancellationToken
        )
    );
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation(async (items) => {
      const first = (items as Array<{ fullIssue: unknown }>)[0];
      return first as unknown as vscode.QuickPickItem;
    });
    const listActionsSpy = vi.spyOn(IssueController.prototype, "listActions").mockResolvedValue(undefined);

    await listOpenIssuesAssignedToMe({ server } as unknown as import("../../../src/commands/action-properties").ActionProperties);

    expect(vscode.window.withProgress).toHaveBeenCalled();
    expect(listActionsSpy).toHaveBeenCalledTimes(1);
  });

  it("returns early when picker is cancelled", async () => {
    const server = {
      options: { url: { hostname: "redmine.example" } },
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [createIssue(11)] }),
    };
    vi.spyOn(vscode.window, "withProgress").mockImplementation(
      (_options, task) =>
        task(
          {
            report: vi.fn(),
          } as unknown as vscode.Progress<{ message?: string; increment?: number }>,
          {} as vscode.CancellationToken
        )
    );
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    const listActionsSpy = vi.spyOn(IssueController.prototype, "listActions").mockResolvedValue(undefined);

    await listOpenIssuesAssignedToMe({ server } as unknown as import("../../../src/commands/action-properties").ActionProperties);

    expect(listActionsSpy).not.toHaveBeenCalled();
  });

  it("renders unassigned issues with fallback text in picker detail", async () => {
    const issue = createIssue(12);
    (issue as { assigned_to?: unknown }).assigned_to = undefined;
    const server = {
      options: { url: { hostname: "redmine.example" } },
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [issue] }),
    };
    vi.spyOn(vscode.window, "withProgress").mockImplementation(
      (_options, task) =>
        task(
          {
            report: vi.fn(),
          } as unknown as vscode.Progress<{ message?: string; increment?: number }>,
          {} as vscode.CancellationToken
        )
    );
    const showQuickPickSpy = vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);

    await listOpenIssuesAssignedToMe({ server } as unknown as import("../../../src/commands/action-properties").ActionProperties);

    const pickerItems = showQuickPickSpy.mock.calls[0][0] as Array<{ detail: string }>;
    expect(pickerItems[0].detail).toContain("no one");
  });

  it("shows error when loading issues fails", async () => {
    const server = {
      options: { url: { hostname: "redmine.example" } },
      getIssuesAssignedToMe: vi.fn().mockRejectedValue(new Error("offline")),
    };
    vi.spyOn(vscode.window, "withProgress").mockImplementation(
      (_options, task) =>
        task(
          {
            report: vi.fn(),
          } as unknown as vscode.Progress<{ message?: string; increment?: number }>,
          {} as vscode.CancellationToken
        )
    );
    const errorSpy = vi.spyOn(vscode.window, "showErrorMessage");

    await listOpenIssuesAssignedToMe({ server } as unknown as import("../../../src/commands/action-properties").ActionProperties);

    expect(errorSpy).toHaveBeenCalledWith("offline");
  });
});
