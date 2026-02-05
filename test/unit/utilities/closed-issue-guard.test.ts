import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import {
  confirmLogTimeOnClosedIssue,
  confirmLogTimeOnClosedIssues,
} from "../../../src/utilities/closed-issue-guard";

describe("confirmLogTimeOnClosedIssue", () => {
  let mockServer: {
    getIssueById: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = {
      getIssueById: vi.fn(),
    };
  });

  it("returns true for open issue without dialog", async () => {
    mockServer.getIssueById.mockResolvedValue({
      issue: {
        id: 123,
        subject: "Open Issue",
        status: { id: 1, name: "In Progress", is_closed: false },
      },
    });

    const result = await confirmLogTimeOnClosedIssue(mockServer as never, 123);

    expect(result).toBe(true);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("shows dialog for closed issue and returns true on confirm", async () => {
    mockServer.getIssueById.mockResolvedValue({
      issue: {
        id: 456,
        subject: "Closed Issue",
        status: { id: 5, name: "Closed", is_closed: true },
      },
    });

    (vscode.window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValue("Log Time");

    const result = await confirmLogTimeOnClosedIssue(mockServer as never, 456);

    expect(result).toBe(true);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("#456"),
      expect.objectContaining({ modal: true }),
      "Log Time"
    );
  });

  it("shows dialog for closed issue and returns false on cancel", async () => {
    mockServer.getIssueById.mockResolvedValue({
      issue: {
        id: 789,
        subject: "Another Closed",
        status: { id: 5, name: "Closed", is_closed: true },
      },
    });

    (vscode.window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const result = await confirmLogTimeOnClosedIssue(mockServer as never, 789);

    expect(result).toBe(false);
  });

  it("skips fetch if issue already provided", async () => {
    const issue = {
      id: 123,
      status: { id: 5, name: "Closed", is_closed: true },
    };

    (vscode.window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValue("Log Time");

    const result = await confirmLogTimeOnClosedIssue(mockServer as never, 123, issue as never);

    expect(result).toBe(true);
    expect(mockServer.getIssueById).not.toHaveBeenCalled();
  });
});

describe("confirmLogTimeOnClosedIssues (batch)", () => {
  let mockServer: {
    getIssueById: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = {
      getIssueById: vi.fn(),
    };
  });

  it("returns true for all open issues without dialog", async () => {
    mockServer.getIssueById
      .mockResolvedValueOnce({
        issue: { id: 1, status: { is_closed: false } },
      })
      .mockResolvedValueOnce({
        issue: { id: 2, status: { is_closed: false } },
      });

    const result = await confirmLogTimeOnClosedIssues(mockServer as never, [1, 2]);

    expect(result).toBe(true);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("shows single dialog for multiple closed issues", async () => {
    mockServer.getIssueById
      .mockResolvedValueOnce({
        issue: { id: 1, status: { is_closed: true } },
      })
      .mockResolvedValueOnce({
        issue: { id: 2, status: { is_closed: true } },
      })
      .mockResolvedValueOnce({
        issue: { id: 3, status: { is_closed: false } },
      });

    (vscode.window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValue("Log Time");

    const result = await confirmLogTimeOnClosedIssues(mockServer as never, [1, 2, 3]);

    expect(result).toBe(true);
    // Should mention count of closed issues
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringMatching(/2.*closed/i),
      expect.objectContaining({ modal: true }),
      "Log Time"
    );
  });

  it("returns false if user cancels batch dialog", async () => {
    mockServer.getIssueById.mockResolvedValue({
      issue: { id: 1, status: { is_closed: true } },
    });

    (vscode.window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const result = await confirmLogTimeOnClosedIssues(mockServer as never, [1]);

    expect(result).toBe(false);
  });

  it("returns true for empty batch without fetch", async () => {
    const result = await confirmLogTimeOnClosedIssues(mockServer as never, []);

    expect(result).toBe(true);
    expect(mockServer.getIssueById).not.toHaveBeenCalled();
  });

  it("deduplicates issue IDs", async () => {
    mockServer.getIssueById.mockResolvedValue({
      issue: { id: 1, status: { is_closed: false } },
    });

    await confirmLogTimeOnClosedIssues(mockServer as never, [1, 1, 1]);

    expect(mockServer.getIssueById).toHaveBeenCalledTimes(1);
  });
});
