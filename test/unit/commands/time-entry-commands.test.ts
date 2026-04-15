import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerTimeEntryCommands } from "../../../src/commands/time-entry-commands";
import * as issuePicker from "../../../src/utilities/issue-picker";
import * as customFieldPicker from "../../../src/utilities/custom-field-picker";
import * as clipboard from "../../../src/utilities/time-entry-clipboard";
import * as quickLogTimeModule from "../../../src/commands/quick-log-time";
import * as closedIssueGuard from "../../../src/utilities/closed-issue-guard";

type RegisteredHandler = (...args: unknown[]) => unknown;

describe("registerTimeEntryCommands", () => {
  let handlers: Map<string, RegisteredHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map<string, RegisteredHandler>();
    vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
      handlers.set(command as string, callback as RegisteredHandler);
      return { dispose: vi.fn() } as unknown as vscode.Disposable;
    });
  });

  function setServerUrl(url: string | undefined): void {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn().mockReturnValue(url),
      update: vi.fn(),
    } as unknown as vscode.WorkspaceConfiguration);
  }

  function registerCommands(options?: {
    getServer?: () => unknown;
    refreshTree?: ReturnType<typeof vi.fn>;
  }): { refreshTree: ReturnType<typeof vi.fn> } {
    const context = {
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
    const refreshTree = options?.refreshTree ?? vi.fn();
    const getServer = options?.getServer ?? vi.fn(() => undefined);

    registerTimeEntryCommands(context, {
      getServer: getServer as () => never,
      refreshTree,
    } as never);

    return { refreshTree };
  }

  it("registers open-time-entry browser command", () => {
    registerCommands();
    expect(handlers.has("redmyne.openTimeEntryInBrowser")).toBe(true);
  });

  it("opens issue URL from numeric command argument", async () => {
    setServerUrl("https://redmine.example.test");
    registerCommands();

    await handlers.get("redmyne.openTimeEntryInBrowser")?.(123);

    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
    const [uri] = vi.mocked(vscode.env.openExternal).mock.calls[0];
    expect((uri as { toString(): string }).toString()).toBe(
      "https://redmine.example.test/issues/123"
    );
  });

  it("opens issue URL from time entry node context", async () => {
    setServerUrl("https://redmine.example.test");
    registerCommands();

    await handlers.get("redmyne.openTimeEntryInBrowser")?.({
      _entry: {
        issue_id: 55,
        hours: "1.0",
        comments: "test",
      },
    });

    const [uri] = vi.mocked(vscode.env.openExternal).mock.calls[0];
    expect((uri as { toString(): string }).toString()).toBe(
      "https://redmine.example.test/issues/55"
    );
  });

  it("shows issue ID error when argument does not contain issue context", async () => {
    setServerUrl("https://redmine.example.test");
    registerCommands();

    await handlers.get("redmyne.openTimeEntryInBrowser")?.({});

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Could not determine issue ID"
    );
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });

  it("shows URL error when server URL is not configured", async () => {
    setServerUrl(undefined);
    registerCommands();

    await handlers.get("redmyne.openTimeEntryInBrowser")?.(77);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Redmine URL not configured"
    );
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });

  it("shows no-time-entry error when editing without entry node", async () => {
    registerCommands();

    await handlers.get("redmyne.editTimeEntry")?.(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "No time entry selected"
    );
  });

  it("shows server error when editing with no configured server", async () => {
    registerCommands();

    await handlers.get("redmyne.editTimeEntry")?.({
      _entry: {
        id: 11,
        hours: "1.0",
        comments: "test",
      },
    });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "No Redmine server configured"
    );
  });

  it("shows no-time-entry error when deleting without entry node", async () => {
    registerCommands();

    await handlers.get("redmyne.deleteTimeEntry")?.(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "No time entry selected"
    );
  });

  it("deletes time entry when confirmed and refreshes tree", async () => {
    const mockServer = {
      deleteTimeEntry: vi.fn().mockResolvedValue(undefined),
    };
    const { refreshTree } = registerCommands({
      getServer: () => mockServer,
    });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Delete" as never);

    await handlers.get("redmyne.deleteTimeEntry")?.({
      _entry: {
        id: 22,
        hours: "1.0",
        comments: "work",
        spent_on: "2026-02-06",
        issue: { id: 7, subject: "Task" },
        activity: { id: 1, name: "Development" },
      },
    });

    expect(mockServer.deleteTimeEntry).toHaveBeenCalledWith(22);
    expect(refreshTree).toHaveBeenCalled();
  });

  it("edits time entry comments and refreshes tree", async () => {
    const mockServer = {
      getTimeEntryCustomFields: vi.fn().mockResolvedValue([]),
      updateTimeEntry: vi.fn().mockResolvedValue(undefined),
    };
    const { refreshTree } = registerCommands({
      getServer: () => mockServer,
    });
    const pickSpy = vi.spyOn(vscode.window, "showQuickPick").mockImplementation(async (items: unknown) => {
      const arr = items as Array<{ label: string; field: string }>;
      return arr.find((i) => i.field === "comments") as never;
    });
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("Updated comment");

    await handlers.get("redmyne.editTimeEntry")?.({
      _entry: {
        id: 31,
        hours: "1.5",
        comments: "Old comment",
        issue: { id: 9, subject: "Task" },
      },
    });

    expect(pickSpy).toHaveBeenCalled();
    expect(mockServer.getTimeEntryCustomFields).toHaveBeenCalled();
    expect(mockServer.updateTimeEntry).toHaveBeenCalledWith(31, {
      comments: "Updated comment",
    });
    expect(refreshTree).toHaveBeenCalled();
  });

  it("edits time entry hours and refreshes tree", async () => {
    const mockServer = {
      getTimeEntryCustomFields: vi.fn().mockResolvedValue([]),
      updateTimeEntry: vi.fn().mockResolvedValue(undefined),
    };
    const { refreshTree } = registerCommands({
      getServer: () => mockServer,
    });
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation(async (items: unknown) => {
      const arr = items as Array<{ label: string; field: string }>;
      return arr.find((i) => i.field === "hours") as never;
    });
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("1:30");

    await handlers.get("redmyne.editTimeEntry")?.({
      _entry: {
        id: 41,
        hours: "1.0",
        comments: "Old comment",
        issue: { id: 9, subject: "Task" },
      },
    });

    expect(mockServer.updateTimeEntry).toHaveBeenCalledWith(41, {
      hours: "1.5",
    });
    expect(refreshTree).toHaveBeenCalled();
  });

  it("edits time entry date and refreshes tree", async () => {
    const mockServer = {
      getTimeEntryCustomFields: vi.fn().mockResolvedValue([]),
      updateTimeEntry: vi.fn().mockResolvedValue(undefined),
    };
    const { refreshTree } = registerCommands({
      getServer: () => mockServer,
    });
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation(async (items: unknown) => {
      const arr = items as Array<{ label: string; field: string }>;
      return arr.find((i) => i.field === "date") as never;
    });
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("2026-02-07");

    await handlers.get("redmyne.editTimeEntry")?.({
      _entry: {
        id: 51,
        hours: "1.0",
        comments: "Old comment",
        issue: { id: 9, subject: "Task" },
      },
    });

    expect(mockServer.updateTimeEntry).toHaveBeenCalledWith(51, {
      spent_on: "2026-02-07",
    });
    expect(refreshTree).toHaveBeenCalled();
  });

  it("edits time entry activity and refreshes tree", async () => {
    const mockServer = {
      getTimeEntryCustomFields: vi.fn().mockResolvedValue([]),
      getIssueById: vi.fn().mockResolvedValue({
        issue: { project: { id: 77 } },
      }),
      getProjectTimeEntryActivities: vi.fn().mockResolvedValue([
        { id: 5, name: "Development" },
      ]),
      updateTimeEntry: vi.fn().mockResolvedValue(undefined),
    };
    const { refreshTree } = registerCommands({
      getServer: () => mockServer,
    });
    vi.spyOn(vscode.window, "showQuickPick")
      .mockImplementationOnce(async (items: unknown) => {
        const arr = items as Array<{ label: string; field: string }>;
        return arr.find((i) => i.field === "activity") as never;
      })
      .mockImplementationOnce(async (items: unknown) => {
        const arr = items as Array<{ label: string; activityId: number }>;
        return arr.find((i) => i.activityId === 5) as never;
      });

    await handlers.get("redmyne.editTimeEntry")?.({
      _entry: {
        id: 61,
        hours: "1.0",
        comments: "Old comment",
        issue: { id: 9, subject: "Task" },
      },
    });

    expect(mockServer.getIssueById).toHaveBeenCalledWith(9);
    expect(mockServer.getProjectTimeEntryActivities).toHaveBeenCalledWith(77);
    expect(mockServer.updateTimeEntry).toHaveBeenCalledWith(61, {
      activity_id: 5,
    });
    expect(refreshTree).toHaveBeenCalled();
  });

  it("edits time entry issue via issue picker and refreshes tree", async () => {
    const mockServer = {
      getTimeEntryCustomFields: vi.fn().mockResolvedValue([]),
      updateTimeEntry: vi.fn().mockResolvedValue(undefined),
    };
    const { refreshTree } = registerCommands({
      getServer: () => mockServer,
    });
    vi.spyOn(issuePicker, "pickIssue").mockResolvedValueOnce({
      id: 88,
      subject: "Other issue",
      project: { id: 7, name: "Project" },
    } as never);
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation(async (items: unknown) => {
      const arr = items as Array<{ label: string; field: string }>;
      return arr.find((i) => i.field === "issue") as never;
    });

    await handlers.get("redmyne.editTimeEntry")?.({
      _entry: {
        id: 71,
        hours: "1.0",
        comments: "work",
        issue: { id: 9, subject: "Current issue" },
      },
    });

    expect(mockServer.updateTimeEntry).toHaveBeenCalledWith(71, {
      issue_id: 88,
    });
    expect(refreshTree).toHaveBeenCalled();
  });

  it("edits time entry custom fields and refreshes tree", async () => {
    const customFieldDefs = [
      {
        id: 101,
        name: "Category",
        field_format: "string",
        required: false,
      },
    ];
    const mockServer = {
      getTimeEntryCustomFields: vi.fn().mockResolvedValue(customFieldDefs),
      getTimeEntryById: vi.fn().mockResolvedValue({
        time_entry: {
          custom_fields: [{ id: 101, value: "old" }],
        },
      }),
      updateTimeEntry: vi.fn().mockResolvedValue(undefined),
    };
    const { refreshTree } = registerCommands({
      getServer: () => mockServer,
    });
    vi.spyOn(customFieldPicker, "pickCustomFields").mockResolvedValueOnce({
      values: [{ id: 101, value: "new" }],
      cancelled: false,
    });
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation(async (items: unknown) => {
      const arr = items as Array<{ label: string; field: string }>;
      return arr.find((i) => i.field === "customFields") as never;
    });

    await handlers.get("redmyne.editTimeEntry")?.({
      _entry: {
        id: 81,
        hours: "1.0",
        comments: "work",
        issue: { id: 9, subject: "Task" },
      },
    });

    expect(mockServer.getTimeEntryById).toHaveBeenCalledWith(81);
    expect(mockServer.updateTimeEntry).toHaveBeenCalledWith(81, {
      custom_fields: [{ id: 101, value: "new" }],
    });
    expect(refreshTree).toHaveBeenCalled();
  });

  it("shows update error when edit update fails", async () => {
    const mockServer = {
      getTimeEntryCustomFields: vi.fn().mockResolvedValue([]),
      updateTimeEntry: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const { refreshTree } = registerCommands({
      getServer: () => mockServer,
    });
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation(async (items: unknown) => {
      const arr = items as Array<{ label: string; field: string }>;
      return arr.find((i) => i.field === "comments") as never;
    });
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("Updated comment");

    await handlers.get("redmyne.editTimeEntry")?.({
      _entry: {
        id: 91,
        hours: "1.0",
        comments: "Old comment",
        issue: { id: 9, subject: "Task" },
      },
    });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Failed to update:")
    );
    expect(refreshTree).not.toHaveBeenCalled();
  });

  it("adds time entry for specific date without redundant refresh", async () => {
    const mockServer = {};
    const quickLogSpy = vi.spyOn(quickLogTimeModule, "quickLogTime").mockResolvedValue(undefined);
    const { refreshTree } = registerCommands({
      getServer: () => mockServer,
    });

    await handlers.get("redmyne.addTimeEntryForDate")?.({
      _date: "2026-02-06",
    });

    expect(quickLogSpy).toHaveBeenCalledWith(
      expect.objectContaining({ server: mockServer }),
      "2026-02-06"
    );
    // quickLogTime handles refresh internally — no redundant refreshTree call
    expect(refreshTree).not.toHaveBeenCalled();
  });

  it("copies single and day entries into clipboard payloads", async () => {
    const setClipboardSpy = vi.spyOn(clipboard, "setClipboard");
    registerCommands();

    await handlers.get("redmyne.copyTimeEntry")?.({
      _entry: {
        id: 1,
        issue_id: 42,
        activity: { id: 3, name: "Dev" },
        hours: "1.5",
        comments: "Work",
        spent_on: "2026-02-04",
        custom_fields: [{ id: 9, name: "CF", value: "A" }],
      },
    });
    await handlers.get("redmyne.copyDayTimeEntries")?.({
      _date: "2026-02-04",
      _cachedEntries: [],
    });

    expect(setClipboardSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: "entry",
        entries: [
          expect.objectContaining({
            issue_id: 42,
            activity_id: 3,
            hours: "1.5",
          }),
        ],
      })
    );
    expect(setClipboardSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "day",
        entries: [],
        sourceDate: "2026-02-04",
      })
    );
  });

  it("copies week entries, filtering drafts and grouping by day", async () => {
    const setClipboardSpy = vi.spyOn(clipboard, "setClipboard");
    registerCommands();

    await handlers.get("redmyne.copyWeekTimeEntries")?.({
      _weekStart: "2026-02-02",
      _cachedEntries: [
        {
          id: 10,
          issue_id: 1,
          activity_id: 2,
          hours: "2.0",
          comments: "ok",
          spent_on: "2026-02-03",
        },
        {
          id: -1,
          issue_id: 9,
          activity_id: 2,
          hours: "1.0",
          comments: "draft",
          spent_on: "2026-02-04",
        },
      ],
    });

    const payload = setClipboardSpy.mock.calls[0][0] as {
      kind: string;
      entries: Array<{ issue_id: number }>;
      weekMap: Map<number, Array<{ issue_id: number }>>;
    };
    expect(payload.kind).toBe("week");
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0].issue_id).toBe(1);
    expect(payload.weekMap.get(1)).toHaveLength(1);
  });

  it("shows fetch error when toolbar week copy cannot load entries", async () => {
    const mockServer = {
      getTimeEntries: vi.fn().mockRejectedValue(new Error("fetch fail")),
    };
    registerCommands({ getServer: () => mockServer });

    await handlers.get("redmyne.copyWeekTimeEntries")?.();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to fetch time entries");
  });

  it("stops paste flow for empty clipboard and invalid target dates", async () => {
    const getClipboardSpy = vi.spyOn(clipboard, "getClipboard");
    const calculateDatesSpy = vi.spyOn(clipboard, "calculatePasteTargetDates");
    const mockServer = {
      addTimeEntry: vi.fn().mockResolvedValue(undefined),
    };
    registerCommands({ getServer: () => mockServer });

    getClipboardSpy.mockReturnValueOnce(undefined);
    await handlers.get("redmyne.pasteTimeEntries")?.();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Clipboard is empty");

    getClipboardSpy.mockReturnValueOnce({
      kind: "week",
      entries: [{ issue_id: 1, activity_id: 2, hours: "1", comments: "" }],
      weekMap: new Map(),
      sourceWeekStart: "2026-02-02",
    });
    calculateDatesSpy.mockReturnValueOnce(null);
    await handlers.get("redmyne.pasteTimeEntries")?.({ _date: "2026-02-03" });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Cannot paste week to a single day");
  });

  it("pastes entries, refreshes tree, and refreshes gantt", async () => {
    const mockServer = {
      addTimeEntry: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(clipboard, "getClipboard").mockReturnValue({
      kind: "day",
      entries: [
        { issue_id: 1, activity_id: 2, hours: "1.5", comments: "a" },
        { issue_id: 2, activity_id: 2, hours: "0.5", comments: "b" },
      ],
      sourceDate: "2026-02-03",
    });
    vi.spyOn(clipboard, "calculatePasteTargetDates").mockReturnValue(["2026-02-05"]);
    vi.spyOn(closedIssueGuard, "confirmLogTimeOnClosedIssues").mockResolvedValue(true);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue("Create" as never);

    const { refreshTree } = registerCommands({ getServer: () => mockServer });
    await handlers.get("redmyne.pasteTimeEntries")?.({ _date: "2026-02-05" });

    expect(mockServer.addTimeEntry).toHaveBeenCalledTimes(2);
    expect(refreshTree).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.refreshGanttData");
  });
});
