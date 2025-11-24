import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { quickLogTime } from "../../../src/commands/quick-log-time";

describe("quickLogTime", () => {
  let mockContext: vscode.ExtensionContext;
  let mockServer: any;
  let props: any;

  beforeEach(() => {
    mockContext = {
      globalState: {
        get: vi.fn(),
        update: vi.fn(),
      },
    } as unknown as vscode.ExtensionContext;

    mockServer = {
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({
        issues: [
          {
            id: 123,
            subject: "Test Issue",
            project: { name: "Test Project" },
            status: { name: "In Progress" },
            due_date: "2025-12-01",
          },
        ],
      }),
      getTimeEntryActivities: vi.fn().mockResolvedValue({
        time_entry_activities: [
          { id: 9, name: "Development", is_default: true },
        ],
      }),
      addTimeEntry: vi.fn().mockResolvedValue({}),
    };

    props = { server: mockServer, config: {} };
  });

  it("shows recent issue if logged <24h ago", async () => {
    const recentLog = {
      issueId: 123,
      issueSubject: "Recent Issue",
      lastActivityId: 9,
      lastActivityName: "Development",
      lastLogged: new Date(Date.now() - 3600000), // 1h ago
    };

    mockContext.globalState.get = vi
      .fn()
      .mockReturnValueOnce(recentLog) // lastTimeLog
      .mockReturnValueOnce([123]); // recentIssueIds

    const showQuickPickSpy = vi
      .spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({
        label: "$(history) Log to #123: Recent Issue",
        value: "recent",
      } as any);

    vi.spyOn(vscode.window, "showInputBox").mockResolvedValueOnce("2.5");

    await quickLogTime(props, mockContext);

    expect(showQuickPickSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          label: expect.stringContaining("$(history) Log to #123"),
        }),
      ]),
      expect.any(Object)
    );
  });

  it("validates hours input (0.1-24 range)", async () => {
    mockContext.globalState.get = vi.fn().mockReturnValue(undefined);

    const testIssue = {
      id: 123,
      subject: "Test Issue",
      project: { name: "Test Project" },
      status: { name: "In Progress" },
      due_date: "2025-12-01",
    };

    const showQuickPickSpy = vi
      .spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({
        label: "#123 Test Issue",
        issue: testIssue,
      } as any)
      .mockResolvedValueOnce({
        label: "Development",
        activity: { id: 9, name: "Development" },
      } as any);

    const showInputBoxSpy = vi
      .spyOn(vscode.window, "showInputBox")
      .mockResolvedValueOnce("2.5");

    await quickLogTime(props, mockContext);

    const inputValidator = showInputBoxSpy.mock.calls[0][0].validateInput;

    expect(inputValidator("0")).toBe("Must be 0.1-24 hours");
    expect(inputValidator("-5")).toBe("Must be 0.1-24 hours");
    expect(inputValidator("25")).toBe("Must be 0.1-24 hours");
    expect(inputValidator("abc")).toBe("Must be 0.1-24 hours");
    expect(inputValidator("2.5")).toBeNull();
  });

  it("calls API and updates cache after logging", async () => {
    // Mock globalState: undefined for lastTimeLog, empty array for recentIssueIds
    mockContext.globalState.get = vi.fn((key: string) => {
      if (key === "recentIssueIds") return [];
      return undefined; // lastTimeLog
    });
    mockContext.globalState.update = vi.fn().mockResolvedValue(undefined);

    // Mock flow: pickIssueAndActivity needs 2 QuickPick calls
    // Call 1: Pick issue from list
    // Call 2: Pick activity type
    const showQuickPickSpy = vi
      .spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({
        label: "#123 Test Issue",
        issue: {
          id: 123,
          subject: "Test Issue",
          project: { name: "Test Project" },
          status: { name: "In Progress" },
        },
      } as any)
      .mockResolvedValueOnce({
        label: "Development",
        activity: { id: 9, name: "Development" },
      } as any);

    const showInputBoxSpy = vi
      .spyOn(vscode.window, "showInputBox")
      .mockResolvedValueOnce("2.5");

    await quickLogTime(props, mockContext);

    // Verify API called with correct params
    expect(mockServer.addTimeEntry).toHaveBeenCalledWith(123, 9, "2.5", "");

    // Verify cache updated
    expect(mockContext.globalState.update).toHaveBeenCalledWith(
      "lastTimeLog",
      expect.objectContaining({
        issueId: 123,
        lastActivityId: 9,
      })
    );

    expect(mockContext.globalState.update).toHaveBeenCalledWith(
      "recentIssueIds",
      expect.arrayContaining([123])
    );
  });
});
