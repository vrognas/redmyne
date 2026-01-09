import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { contributeToIssue } from "../../../src/commands/adhoc-commands";
import { TimeEntryNode } from "../../../src/trees/my-time-entries-tree";
import { adHocTracker } from "../../../src/utilities/adhoc-tracker";
import * as issuePicker from "../../../src/utilities/issue-picker";

vi.mock("../../../src/utilities/adhoc-tracker", () => ({
  adHocTracker: {
    isAdHoc: vi.fn(),
  },
}));

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
    vi.clearAllMocks();

    mockServer = {
      getIssueById: vi.fn(),
      updateTimeEntry: vi.fn().mockResolvedValue({}),
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [] }),
      isTimeTrackingEnabled: vi.fn().mockResolvedValue(true),
      searchIssues: vi.fn().mockResolvedValue([]),
    };

    refreshCallback = vi.fn();
    (adHocTracker.isAdHoc as ReturnType<typeof vi.fn>).mockReturnValue(true);
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
});
