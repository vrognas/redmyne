import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { quickLogTime } from "../../../src/commands/quick-log-time";

describe("quickLogTime", () => {
  let mockContext: vscode.ExtensionContext;
  let mockServer: {
    getIssuesAssignedToMe: ReturnType<typeof vi.fn>;
    getTimeEntryActivities: ReturnType<typeof vi.fn>;
    addTimeEntry: ReturnType<typeof vi.fn>;
  };
  let props: { server: typeof mockServer; config: Record<string, unknown> };

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
        label: "$(history) Log to #123: Recent Issue [Development]",
        value: "recent",
      } as unknown as vscode.QuickPickItem);

    vi.spyOn(vscode.window, "showInputBox").mockResolvedValueOnce("2.5");

    await quickLogTime(props, mockContext);

    expect(showQuickPickSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          label: "$(history) Log to #123: Recent Issue [Development]",
        }),
      ]),
      expect.any(Object)
    );
  });

  it("validates hours input (0.1-24 range, multiple formats)", async () => {
    mockContext.globalState.get = vi.fn().mockReturnValue(undefined);

    const testIssue = {
      id: 123,
      subject: "Test Issue",
      project: { name: "Test Project" },
      status: { name: "In Progress" },
      due_date: "2025-12-01",
    };

    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({
        label: "#123 Test Issue",
        issue: testIssue,
      } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({
        label: "Development",
        activity: { id: 9, name: "Development" },
      } as unknown as vscode.QuickPickItem);

    const showInputBoxSpy = vi
      .spyOn(vscode.window, "showInputBox")
      .mockResolvedValueOnce("2.5");

    await quickLogTime(props, mockContext);

    const inputValidator = showInputBoxSpy.mock.calls[0][0]
      .validateInput as (value: string) => string | null;

    // Invalid: out of range or bad format
    expect(inputValidator("0")).toContain("Must be 0.1-24 hours");
    expect(inputValidator("-5")).toContain("Must be 0.1-24 hours");
    expect(inputValidator("25")).toContain("Must be 0.1-24 hours");
    expect(inputValidator("abc")).toContain("Must be 0.1-24 hours");
    expect(inputValidator("1:75")).toContain("Must be 0.1-24 hours"); // Invalid minutes

    // Valid: decimal format
    expect(inputValidator("2.5")).toBeNull();
    expect(inputValidator("1,5")).toBeNull(); // European format

    // Valid: HH:MM format
    expect(inputValidator("1:45")).toBeNull(); // 1.75 hours
    expect(inputValidator("0:30")).toBeNull(); // 0.5 hours

    // Valid: text with units
    expect(inputValidator("1h 45min")).toBeNull();
    expect(inputValidator("1h45min")).toBeNull();
    expect(inputValidator("1 h 45 min")).toBeNull();
    expect(inputValidator("45min")).toBeNull(); // 0.75 hours
    expect(inputValidator("2h")).toBeNull(); // 2 hours
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
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({
        label: "#123 Test Issue",
        issue: {
          id: 123,
          subject: "Test Issue",
          project: { name: "Test Project" },
          status: { name: "In Progress" },
        },
      } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({
        label: "Development",
        activity: { id: 9, name: "Development" },
      } as unknown as vscode.QuickPickItem);

    vi.spyOn(vscode.window, "showInputBox").mockResolvedValueOnce("2.5");

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
