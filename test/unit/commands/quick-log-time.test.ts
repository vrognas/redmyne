import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { quickLogTime } from "../../../src/commands/quick-log-time";
import { validateTimeInput } from "../../../src/utilities/time-input";

describe("quickLogTime", () => {
  let mockContext: vscode.ExtensionContext;
  let mockServer: {
    getIssuesAssignedToMe: ReturnType<typeof vi.fn>;
    getTimeEntryActivities: ReturnType<typeof vi.fn>;
    getProjectTimeEntryActivities: ReturnType<typeof vi.fn>;
    getTimeEntries: ReturnType<typeof vi.fn>;
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
            project: { id: 1, name: "Test Project" },
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
      getProjectTimeEntryActivities: vi.fn().mockResolvedValue([
        { id: 9, name: "Development", is_default: true },
      ]),
      getTimeEntries: vi.fn().mockResolvedValue({
        time_entries: [], // Default: no existing entries
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

    (vscode.window.showInputBox as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("2.5") // hours
      .mockResolvedValueOnce("Test comment"); // comment

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

  it("validates hours input (0.1-24 range, multiple formats)", () => {
    // Invalid: out of range or bad format
    expect(validateTimeInput("0")).toContain("Must be 0.1-24 hours");
    expect(validateTimeInput("-5")).toContain("Must be 0.1-24 hours");
    expect(validateTimeInput("25")).toContain("Must be 0.1-24 hours");
    expect(validateTimeInput("abc")).toContain("Must be 0.1-24 hours");
    expect(validateTimeInput("1:75")).toContain("Must be 0.1-24 hours"); // Invalid minutes

    // Valid: decimal format
    expect(validateTimeInput("2.5")).toBeNull();
    expect(validateTimeInput("1,5")).toBeNull(); // European format

    // Valid: HH:MM format
    expect(validateTimeInput("1:45")).toBeNull(); // 1.75 hours
    expect(validateTimeInput("0:30")).toBeNull(); // 0.5 hours

    // Valid: text with units
    expect(validateTimeInput("1h 45min")).toBeNull();
    expect(validateTimeInput("1h45min")).toBeNull();
    expect(validateTimeInput("1 h 45 min")).toBeNull();
    expect(validateTimeInput("45min")).toBeNull(); // 0.75 hours
    expect(validateTimeInput("2h")).toBeNull(); // 2 hours
  });

  it.skip("prevents logging >24h per day", async () => {
    mockContext.globalState.get = vi.fn().mockReturnValue(undefined);

    // Mock existing entries totaling 20h today
    mockServer.getTimeEntries = vi.fn().mockResolvedValue({
      time_entries: [
        { hours: "10.0" },
        { hours: "8.0" },
        { hours: "2.0" },
      ],
    });
    props.server.getTimeEntries = mockServer.getTimeEntries;

    const testIssue = {
      id: 123,
      subject: "Test Issue",
      project: { id: 1, name: "Test Project" },
      status: { name: "In Progress" },
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

    (vscode.window.showInputBox as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("3") // Log valid 3h (total would be 23h)
      .mockResolvedValueOnce(""); // comment

    await quickLogTime(props, mockContext);

    // Verify getTimeEntries was called to fetch today's total
    expect(mockServer.getTimeEntries).toHaveBeenCalledWith({
      from: expect.any(String),
      to: expect.any(String),
    });

    // Verify the input prompt shows today's total
    const showInputBoxMock = vscode.window.showInputBox as ReturnType<
      typeof vi.fn
    >;
    const promptText = showInputBoxMock.mock.calls[0][0].prompt as string;
    expect(promptText).toContain("20"); // Should show "Today: 20h logged"
  });

  it("calls API and updates cache after logging", async () => {
    // Reset mock before setting up new return values
    (vscode.window.showInputBox as ReturnType<typeof vi.fn>).mockReset();

    // Mock globalState: undefined for lastTimeLog, empty array for recentIssueIds
    mockContext.globalState.get = vi.fn((key: string) => {
      if (key === "recentIssueIds") return [];
      return undefined; // lastTimeLog
    });
    mockContext.globalState.update = vi.fn().mockResolvedValue(undefined);

    // Mock flow: pickIssueAndActivity needs 2 QuickPick calls + date picker
    // Call 1: Pick issue from list
    // Call 2: Pick activity type
    // Call 3: Pick date
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({
        label: "#123 Test Issue",
        issue: {
          id: 123,
          subject: "Test Issue",
          project: { id: 1, name: "Test Project" },
          status: { name: "In Progress" },
        },
      } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({
        label: "Development",
        activity: { id: 9, name: "Development" },
      } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({
        label: "$(calendar) Today",
        value: "today",
        date: new Date().toISOString().split("T")[0],
      } as unknown as vscode.QuickPickItem);

    (vscode.window.showInputBox as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("2.5") // hours
      .mockResolvedValueOnce(""); // comment (user leaves empty)

    await quickLogTime(props, mockContext);

    // Verify API called with correct params (comment is empty, no spentOn for today)
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

  it("logs time to yesterday when selected", async () => {
    (vscode.window.showInputBox as ReturnType<typeof vi.fn>).mockReset();

    mockContext.globalState.get = vi.fn((key: string) => {
      if (key === "recentIssueIds") return [];
      return undefined;
    });
    mockContext.globalState.update = vi.fn().mockResolvedValue(undefined);

    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({
        label: "#123 Test Issue",
        issue: {
          id: 123,
          subject: "Test Issue",
          project: { id: 1, name: "Test Project" },
          status: { name: "In Progress" },
        },
      } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({
        label: "Development",
        activity: { id: 9, name: "Development" },
      } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({
        label: "$(history) Yesterday",
        value: "yesterday",
        date: (() => {
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          return yesterday.toISOString().split("T")[0];
        })(),
      } as unknown as vscode.QuickPickItem);

    (vscode.window.showInputBox as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("8") // hours
      .mockResolvedValueOnce("Worked late"); // comment

    await quickLogTime(props, mockContext);

    // Calculate expected yesterday date
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const expectedDate = yesterday.toISOString().split("T")[0];

    // Verify API called with spentOn for yesterday
    expect(mockServer.addTimeEntry).toHaveBeenCalledWith(
      123,
      9,
      "8",
      "Worked late",
      expectedDate
    );
  });

  it("allows custom date selection", async () => {
    (vscode.window.showInputBox as ReturnType<typeof vi.fn>).mockReset();

    mockContext.globalState.get = vi.fn((key: string) => {
      if (key === "recentIssueIds") return [];
      return undefined;
    });
    mockContext.globalState.update = vi.fn().mockResolvedValue(undefined);

    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({
        label: "#123 Test Issue",
        issue: {
          id: 123,
          subject: "Test Issue",
          project: { id: 1, name: "Test Project" },
          status: { name: "In Progress" },
        },
      } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({
        label: "Development",
        activity: { id: 9, name: "Development" },
      } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({
        label: "$(edit) Pick date...",
        value: "pick",
      } as unknown as vscode.QuickPickItem);

    (vscode.window.showInputBox as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("2025-12-15") // custom date
      .mockResolvedValueOnce("4") // hours
      .mockResolvedValueOnce("Custom date work"); // comment

    await quickLogTime(props, mockContext);

    // Verify API called with custom spentOn date
    expect(mockServer.addTimeEntry).toHaveBeenCalledWith(
      123,
      9,
      "4",
      "Custom date work",
      "2025-12-15"
    );
  });
});
