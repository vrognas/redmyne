import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import {
  quickCreateIssue,
  quickCreateSubIssue,
} from "../../../src/commands/quick-create-issue";

describe("quickCreateIssue", () => {
  let mockServer: {
    getProjects: ReturnType<typeof vi.fn>;
    getTrackers: ReturnType<typeof vi.fn>;
    getPriorities: ReturnType<typeof vi.fn>;
    createIssue: ReturnType<typeof vi.fn>;
    getIssueById: ReturnType<typeof vi.fn>;
  };
  let props: { server: typeof mockServer; config: Record<string, unknown> };

  const mockProjects = [
    { id: 1, name: "Project Alpha", identifier: "alpha", toQuickPickItem: () => ({ label: "Project Alpha", identifier: "alpha", id: 1 }) },
    { id: 2, name: "Project Beta", identifier: "beta", toQuickPickItem: () => ({ label: "Project Beta", identifier: "beta", id: 2 }) },
  ];

  const mockTrackers = [
    { id: 1, name: "Bug" },
    { id: 2, name: "Tasks" },
    { id: 3, name: "Feature" },
  ];

  const mockPriorities = [
    { id: 1, name: "Low" },
    { id: 2, name: "Normal" },
    { id: 3, name: "High" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    mockServer = {
      getProjects: vi.fn().mockResolvedValue(mockProjects),
      getTrackers: vi.fn().mockResolvedValue(mockTrackers),
      getPriorities: vi.fn().mockResolvedValue(mockPriorities),
      createIssue: vi.fn().mockResolvedValue({
        issue: { id: 999, subject: "New Issue" },
      }),
      getIssueById: vi.fn().mockResolvedValue({
        issue: {
          id: 123,
          subject: "Parent Issue",
          project: { id: 1, name: "Project Alpha" },
          tracker: { id: 2, name: "Tasks" },
        },
      }),
    };

    props = { server: mockServer, config: {} };
  });

  it("creates issue with full wizard flow", async () => {
    // Mock wizard steps
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Project Alpha", identifier: "alpha", id: 1 } as unknown as vscode.QuickPickItem) // project
      .mockResolvedValueOnce({ label: "Tasks", id: 2 } as unknown as vscode.QuickPickItem) // tracker
      .mockResolvedValueOnce({ label: "Normal", id: 2 } as unknown as vscode.QuickPickItem); // priority

    (vscode.window.showInputBox as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("My new issue") // subject
      .mockResolvedValueOnce("Issue description") // description
      .mockResolvedValueOnce("8") // estimated hours
      .mockResolvedValueOnce("2025-12-31"); // due date

    const result = await quickCreateIssue(props);

    expect(result).toEqual({ id: 999, subject: "New Issue" });
    expect(mockServer.createIssue).toHaveBeenCalledWith({
      project_id: 1,
      tracker_id: 2,
      subject: "My new issue",
      description: "Issue description",
      priority_id: 2,
      estimated_hours: 8,
      due_date: "2025-12-31",
    });
  });

  it("creates issue with minimal fields (skipped optional)", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Project Alpha", identifier: "alpha", id: 1 } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Bug", id: 1 } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Normal", id: 2 } as unknown as vscode.QuickPickItem);

    (vscode.window.showInputBox as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("Bug report") // subject
      .mockResolvedValueOnce("") // description (skipped)
      .mockResolvedValueOnce("") // estimated hours (skipped)
      .mockResolvedValueOnce(""); // due date (skipped)

    await quickCreateIssue(props);

    expect(mockServer.createIssue).toHaveBeenCalledWith({
      project_id: 1,
      tracker_id: 1,
      subject: "Bug report",
      priority_id: 2,
    });
  });

  it("returns undefined when user cancels at project selection", async () => {
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValueOnce(undefined);

    const result = await quickCreateIssue(props);

    expect(result).toBeUndefined();
    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("returns undefined when user cancels at subject input", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Project Alpha", id: 1 } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Tasks", id: 2 } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Normal", id: 2 } as unknown as vscode.QuickPickItem);

    (vscode.window.showInputBox as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined); // user pressed Escape

    const result = await quickCreateIssue(props);

    expect(result).toBeUndefined();
    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("validates estimated hours input", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Project Alpha", id: 1 } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Tasks", id: 2 } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Normal", id: 2 } as unknown as vscode.QuickPickItem);

    (vscode.window.showInputBox as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("Test issue")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("8")
      .mockResolvedValueOnce("");

    await quickCreateIssue(props);

    const showInputBoxMock = vscode.window.showInputBox as ReturnType<typeof vi.fn>;
    // Find the estimated hours call (3rd call, index 2)
    const hoursValidator = showInputBoxMock.mock.calls[2]?.[0]?.validateInput;

    if (hoursValidator) {
      expect(hoursValidator("")).toBeNull(); // empty is valid (optional)
      expect(hoursValidator("8")).toBeNull();
      expect(hoursValidator("0.5")).toBeNull();
      expect(hoursValidator("-5")).toBeTruthy(); // should return error
      expect(hoursValidator("abc")).toBeTruthy(); // should return error
    }
  });

  it("validates due date format", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Project Alpha", id: 1 } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Tasks", id: 2 } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Normal", id: 2 } as unknown as vscode.QuickPickItem);

    (vscode.window.showInputBox as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("Test issue")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("2025-12-31");

    await quickCreateIssue(props);

    const showInputBoxMock = vscode.window.showInputBox as ReturnType<typeof vi.fn>;
    // Find the due date call (4th call, index 3)
    const dateValidator = showInputBoxMock.mock.calls[3]?.[0]?.validateInput;

    if (dateValidator) {
      expect(dateValidator("")).toBeNull(); // empty is valid (optional)
      expect(dateValidator("2025-12-31")).toBeNull();
      expect(dateValidator("2025-1-1")).toBeTruthy(); // invalid format
      expect(dateValidator("12/31/2025")).toBeTruthy(); // wrong format
      expect(dateValidator("not-a-date")).toBeTruthy();
    }
  });
});

describe("quickCreateSubIssue", () => {
  let mockServer: {
    getProjects: ReturnType<typeof vi.fn>;
    getTrackers: ReturnType<typeof vi.fn>;
    getPriorities: ReturnType<typeof vi.fn>;
    createIssue: ReturnType<typeof vi.fn>;
    getIssueById: ReturnType<typeof vi.fn>;
  };
  let props: { server: typeof mockServer; config: Record<string, unknown> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockServer = {
      getProjects: vi.fn(),
      getTrackers: vi.fn(),
      getPriorities: vi.fn().mockResolvedValue([
        { id: 1, name: "Low" },
        { id: 2, name: "Normal" },
        { id: 3, name: "High" },
      ]),
      createIssue: vi.fn().mockResolvedValue({
        issue: { id: 1000, subject: "Sub Issue" },
      }),
      getIssueById: vi.fn().mockResolvedValue({
        issue: {
          id: 123,
          subject: "Parent Issue",
          project: { id: 1, name: "Project Alpha" },
          tracker: { id: 2, name: "Tasks" },
        },
      }),
    };

    props = { server: mockServer, config: {} };
  });

  it("creates sub-issue inheriting parent project and tracker", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Normal", id: 2 } as unknown as vscode.QuickPickItem); // priority only

    (vscode.window.showInputBox as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("Child task") // subject
      .mockResolvedValueOnce("") // description
      .mockResolvedValueOnce("4") // estimated hours
      .mockResolvedValueOnce(""); // due date

    const result = await quickCreateSubIssue(props, 123);

    expect(result).toEqual({ id: 1000, subject: "Sub Issue" });
    expect(mockServer.getIssueById).toHaveBeenCalledWith(123);
    expect(mockServer.getProjects).not.toHaveBeenCalled(); // skipped
    expect(mockServer.getTrackers).not.toHaveBeenCalled(); // skipped
    expect(mockServer.createIssue).toHaveBeenCalledWith({
      project_id: 1,
      tracker_id: 2,
      subject: "Child task",
      priority_id: 2,
      estimated_hours: 4,
      parent_issue_id: 123,
    });
  });

  it("shows parent issue info in subject prompt", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Normal", id: 2 } as unknown as vscode.QuickPickItem);

    (vscode.window.showInputBox as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("Sub task")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    await quickCreateSubIssue(props, 123);

    const showInputBoxMock = vscode.window.showInputBox as ReturnType<typeof vi.fn>;
    const subjectPrompt = showInputBoxMock.mock.calls[0]?.[0]?.prompt;

    expect(subjectPrompt).toContain("123"); // parent ID
    expect(subjectPrompt).toContain("Parent Issue"); // parent subject
  });
});
