import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { contributeToIssue, removeContribution, toggleAdHoc } from "../../../src/commands/adhoc-commands";
import { TimeEntryNode } from "../../../src/trees/my-time-entries-tree";
import { adHocTracker } from "../../../src/utilities/adhoc-tracker";
import * as issuePicker from "../../../src/utilities/issue-picker";

describe("contributeToIssue", () => {
  let mockServer: {
    getIssueById: ReturnType<typeof vi.fn>;
    updateTimeEntry: ReturnType<typeof vi.fn>;
    getIssuesAssignedToMe: ReturnType<typeof vi.fn>;
    isTimeTrackingEnabled: ReturnType<typeof vi.fn>;
    searchIssues: ReturnType<typeof vi.fn>;
  };
  let refreshCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();

    mockServer = {
      getIssueById: vi.fn(),
      updateTimeEntry: vi.fn().mockResolvedValue({}),
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [] }),
      isTimeTrackingEnabled: vi.fn().mockResolvedValue(true),
      searchIssues: vi.fn().mockResolvedValue([]),
    };

    refreshCallback = vi.fn();
    vi.spyOn(adHocTracker, "isAdHoc").mockReturnValue(true);
  });

  it("uses pickIssue to select target issue", async () => {
    const item = {
      _entry: { id: 1, issue: { id: 100 }, issue_id: 100, comments: "" },
    } as unknown as TimeEntryNode;

    mockServer.getIssueById
      .mockResolvedValueOnce({ issue: { id: 100, project: { id: 1 } } }) // source issue
      .mockResolvedValueOnce({ issue: { id: 200, project: { id: 1, name: "Proj" }, subject: "Target" } }); // target issue

    const pickIssueSpy = vi.spyOn(issuePicker, "pickIssue").mockResolvedValue({
      id: 200,
      subject: "Target Issue",
      project: { id: 1, name: "Test Project" },
    });

    await contributeToIssue(item, mockServer as any, refreshCallback);

    expect(pickIssueSpy).toHaveBeenCalledWith(
      mockServer,
      "Contribute Time To...",
      { skipTimeTrackingCheck: true }
    );
    expect(mockServer.updateTimeEntry).toHaveBeenCalledWith(1, {
      comments: "#200 Target Issue",
    });
    expect(refreshCallback).toHaveBeenCalled();
  });

  it("prevents contributing to self", async () => {
    const item = {
      _entry: { id: 1, issue: { id: 100 }, issue_id: 100, comments: "" },
    } as unknown as TimeEntryNode;

    mockServer.getIssueById.mockResolvedValueOnce({
      issue: { id: 100, project: { id: 1 } },
    });

    vi.spyOn(issuePicker, "pickIssue").mockResolvedValue({
      id: 100, // Same as source
      subject: "Same Issue",
      project: { id: 1, name: "Test" },
    });

    const showErrorSpy = vi.spyOn(vscode.window, "showErrorMessage");

    await contributeToIssue(item, mockServer as any, refreshCallback);

    expect(showErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cannot contribute to self")
    );
    expect(mockServer.updateTimeEntry).not.toHaveBeenCalled();
  });

  it("warns on cross-project contribution and proceeds on confirm", async () => {
    const item = {
      _entry: { id: 1, issue: { id: 100 }, issue_id: 100, comments: "" },
    } as unknown as TimeEntryNode;

    mockServer.getIssueById.mockResolvedValueOnce({
      issue: { id: 100, project: { id: 1 } },
    });

    vi.spyOn(issuePicker, "pickIssue").mockResolvedValue({
      id: 200,
      subject: "Other Project Issue",
      project: { id: 2, name: "Other Project" },
    });

    const showWarningSpy = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValue("Yes" as any);

    await contributeToIssue(item, mockServer as any, refreshCallback);

    expect(showWarningSpy).toHaveBeenCalledWith(
      expect.stringContaining("different project"),
      "Yes",
      "Cancel"
    );
    expect(mockServer.updateTimeEntry).toHaveBeenCalled();
  });

  it("shows error when time entry id is missing", async () => {
    const item = {
      _entry: { issue: { id: 100 }, issue_id: 100, comments: "" },
    } as unknown as TimeEntryNode;

    await contributeToIssue(item, mockServer as any, refreshCallback);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Could not determine time entry ID"
    );
    expect(mockServer.updateTimeEntry).not.toHaveBeenCalled();
  });
});

describe("removeContribution", () => {
  it("shows error when time entry id is missing", async () => {
    const item = {
      _entry: { issue: { id: 100 }, issue_id: 100, comments: "#123 Target" },
    } as unknown as TimeEntryNode;

    const mockServer = {
      updateTimeEntry: vi.fn().mockResolvedValue({}),
    };

    await removeContribution(item, mockServer as any, vi.fn());

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Could not determine time entry ID"
    );
    expect(mockServer.updateTimeEntry).not.toHaveBeenCalled();
  });
});

describe("toggleAdHoc", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows error when issue context missing", async () => {
    await toggleAdHoc(undefined);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("No issue selected");
  });

  it("shows add/remove messages based on tracker state", async () => {
    vi.spyOn(adHocTracker, "toggle")
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await toggleAdHoc({ id: 42 });
    await toggleAdHoc({ id: 42 });

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Issue #42 tagged as ad-hoc budget"
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Issue #42 ad-hoc tag removed"
    );
  });
});

describe("contributeToIssue additional branches", () => {
  function createEntry(overrides: Record<string, unknown> = {}): TimeEntryNode {
    return {
      _entry: {
        id: 1,
        issue: { id: 100 },
        issue_id: 100,
        comments: "",
        ...overrides,
      },
    } as unknown as TimeEntryNode;
  }

  it("shows error when no entry selected or server missing", async () => {
    const refresh = vi.fn();
    const server = { updateTimeEntry: vi.fn(), getIssueById: vi.fn() };

    await contributeToIssue({ _entry: undefined } as unknown as TimeEntryNode, server as any, refresh);
    await contributeToIssue(createEntry(), undefined, refresh);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("No time entry selected");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Not connected to Redmyne");
  });

  it("stops when source issue is not ad-hoc", async () => {
    const refresh = vi.fn();
    const server = { updateTimeEntry: vi.fn(), getIssueById: vi.fn() };
    vi.spyOn(adHocTracker, "isAdHoc").mockReturnValue(false);

    await contributeToIssue(createEntry(), server as any, refresh);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Time entry is not on an ad-hoc issue");
    expect(server.getIssueById).not.toHaveBeenCalled();
  });

  it("handles source issue fetch failure and missing project", async () => {
    const refresh = vi.fn();
    const server = {
      updateTimeEntry: vi.fn(),
      getIssueById: vi.fn(),
    };
    vi.spyOn(adHocTracker, "isAdHoc").mockReturnValue(true);

    server.getIssueById.mockRejectedValueOnce(new Error("boom"));
    await contributeToIssue(createEntry(), server as any, refresh);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Could not fetch issue details");

    server.getIssueById.mockResolvedValueOnce({ issue: { id: 100, project: undefined } });
    await contributeToIssue(createEntry(), server as any, refresh);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Could not determine project");
  });

  it("returns when picker cancelled or cross-project warning rejected", async () => {
    const refresh = vi.fn();
    const server = {
      updateTimeEntry: vi.fn().mockResolvedValue({}),
      getIssueById: vi.fn().mockResolvedValue({ issue: { id: 100, project: { id: 1 } } }),
    };
    vi.spyOn(adHocTracker, "isAdHoc").mockReturnValue(true);

    vi.spyOn(issuePicker, "pickIssue").mockResolvedValueOnce(undefined);
    await contributeToIssue(createEntry(), server as any, refresh);
    expect(server.updateTimeEntry).not.toHaveBeenCalled();

    vi.spyOn(issuePicker, "pickIssue").mockResolvedValueOnce({
      id: 200,
      subject: "Different",
      project: { id: 2, name: "Other" },
    });
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValueOnce("Cancel" as any);
    await contributeToIssue(createEntry(), server as any, refresh);
    expect(server.updateTimeEntry).not.toHaveBeenCalled();
  });

  it("replaces existing target and handles update failures", async () => {
    const refresh = vi.fn();
    const server = {
      updateTimeEntry: vi.fn().mockRejectedValueOnce(new Error("denied")),
      getIssueById: vi.fn().mockResolvedValue({ issue: { id: 100, project: { id: 1 } } }),
    };
    vi.spyOn(adHocTracker, "isAdHoc").mockReturnValue(true);
    vi.spyOn(issuePicker, "pickIssue").mockResolvedValue({
      id: 250,
      subject: "Target",
      project: { id: 1, name: "Same" },
    });

    await contributeToIssue(createEntry({ comments: "Work #123 Old Target" }), server as any, refresh);

    expect(server.updateTimeEntry).toHaveBeenCalledWith(1, {
      comments: "Work #250 Target",
    });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to update time entry: denied"
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("removeContribution branches", () => {
  it("removes target text and refreshes on success", async () => {
    const refresh = vi.fn();
    const server = { updateTimeEntry: vi.fn().mockResolvedValue({}) };
    const entry = {
      _entry: { id: 10, issue: { id: 1 }, issue_id: 1, comments: "Worked on #222 Feature" },
    } as unknown as TimeEntryNode;

    await removeContribution(entry, server as any, refresh);

    expect(server.updateTimeEntry).toHaveBeenCalledWith(10, { comments: "Worked on" });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Removed contribution to issue #222"
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows error when target missing and handles update failure", async () => {
    const refresh = vi.fn();
    const server = { updateTimeEntry: vi.fn().mockRejectedValue(new Error("save failed")) };
    const noTarget = {
      _entry: { id: 11, issue: { id: 1 }, issue_id: 1, comments: "no target here" },
    } as unknown as TimeEntryNode;
    const withTarget = {
      _entry: { id: 12, issue: { id: 1 }, issue_id: 1, comments: "ref #333 Target" },
    } as unknown as TimeEntryNode;

    await removeContribution(noTarget, server as any, refresh);
    await removeContribution(withTarget, server as any, refresh);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Time entry has no contribution target");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to update time entry: save failed"
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
