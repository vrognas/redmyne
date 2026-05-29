import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerTimeEntryCommands, buildPasteConfirmLines, buildPasteWorkItems, resolvePasteTarget } from "../../../src/commands/time-entry-commands";
import { getWeekStart } from "../../../src/utilities/date-utils";

/** Calendar-day span between two YYYY-MM-DD strings. */
function daySpan(from: string, to: string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
}
import * as issuePicker from "../../../src/utilities/issue-picker";
import * as customFieldPicker from "../../../src/utilities/custom-field-picker";
import * as clipboard from "../../../src/utilities/time-entry-clipboard";
import * as quickLogTimeModule from "../../../src/commands/quick-log-time";
import * as closedIssueGuard from "../../../src/utilities/closed-issue-guard";
import * as statusBar from "../../../src/utilities/status-bar";

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
    getSelectedNode?: () => unknown;
    isDraftMode?: () => boolean;
  }): { refreshTree: ReturnType<typeof vi.fn> } {
    const context = {
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
    const refreshTree = options?.refreshTree ?? vi.fn();
    const getServer = options?.getServer ?? vi.fn(() => undefined);

    registerTimeEntryCommands(context, {
      getServer: getServer as () => never,
      refreshTree,
      getSelectedNode: options?.getSelectedNode as never,
      isDraftMode: options?.isDraftMode,
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

  it("copies a single entry into an entry clipboard payload", async () => {
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

    expect(setClipboardSpy).toHaveBeenCalledWith(
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
  });

  it("copying an empty day does not clobber an existing clipboard", async () => {
    const setClipboardSpy = vi.spyOn(clipboard, "setClipboard");
    registerCommands();

    await handlers.get("redmyne.copyDayTimeEntries")?.({
      _date: "2026-02-04",
      _cachedEntries: [],
    });

    expect(setClipboardSpy).not.toHaveBeenCalled();
  });

  it("copying an empty week does not clobber an existing clipboard", async () => {
    const setClipboardSpy = vi.spyOn(clipboard, "setClipboard");
    registerCommands();

    await handlers.get("redmyne.copyWeekTimeEntries")?.({
      _weekStart: "2026-02-02",
      _cachedEntries: [],
    });

    expect(setClipboardSpy).not.toHaveBeenCalled();
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

  it("falls back to tree selection when copy commands are invoked without args (keybinding)", async () => {
    const setClipboardSpy = vi.spyOn(clipboard, "setClipboard");
    const selectedEntry = {
      _entry: {
        id: 5,
        issue_id: 99,
        activity: { id: 7, name: "Dev" },
        hours: "2.0",
        comments: "kb",
        spent_on: "2026-02-04",
      },
    };
    registerCommands({ getSelectedNode: () => selectedEntry });

    await handlers.get("redmyne.copyTimeEntry")?.();

    expect(setClipboardSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "entry",
        entries: [expect.objectContaining({ issue_id: 99, hours: "2.0" })],
      })
    );
  });

  it("falls back to tree selection for copyDayTimeEntries when invoked without args", async () => {
    const setClipboardSpy = vi.spyOn(clipboard, "setClipboard");
    const selectedDay = {
      _date: "2026-02-04",
      _cachedEntries: [
        { id: 11, issue_id: 4, activity_id: 2, hours: "1.0", comments: "x", spent_on: "2026-02-04" },
      ],
    };
    registerCommands({ getSelectedNode: () => selectedDay });

    await handlers.get("redmyne.copyDayTimeEntries")?.();

    expect(setClipboardSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "day",
        sourceDate: "2026-02-04",
        entries: [expect.objectContaining({ issue_id: 4 })],
      })
    );
  });

  it("falls back to tree selection for copyWeekTimeEntries when invoked without args", async () => {
    const setClipboardSpy = vi.spyOn(clipboard, "setClipboard");
    const selectedWeek = {
      _weekStart: "2026-02-02",
      _cachedEntries: [
        { id: 20, issue_id: 7, activity_id: 1, hours: "3.0", comments: "wk", spent_on: "2026-02-03" },
      ],
    };
    registerCommands({ getSelectedNode: () => selectedWeek });

    await handlers.get("redmyne.copyWeekTimeEntries")?.();

    const payload = setClipboardSpy.mock.calls[0][0] as { kind: string; sourceWeekStart?: string };
    expect(payload.kind).toBe("week");
    expect(payload.sourceWeekStart).toBe("2026-02-02");
  });

  it("copy dispatcher routes by contextValue to the matching copy command", async () => {
    const executeSpy = vi.spyOn(vscode.commands, "executeCommand");

    // entry
    registerCommands({ getSelectedNode: () => ({ contextValue: "time-entry", _entry: {} }) });
    await handlers.get("redmyne.copyFromTimeEntriesPane")?.();
    expect(executeSpy).toHaveBeenLastCalledWith("redmyne.copyTimeEntry", expect.objectContaining({ contextValue: "time-entry" }));

    // adhoc variant (still time-entry*)
    registerCommands({ getSelectedNode: () => ({ contextValue: "time-entry-adhoc-linked" }) });
    await handlers.get("redmyne.copyFromTimeEntriesPane")?.();
    expect(executeSpy).toHaveBeenLastCalledWith("redmyne.copyTimeEntry", expect.objectContaining({ contextValue: "time-entry-adhoc-linked" }));

    // day-group
    registerCommands({ getSelectedNode: () => ({ contextValue: "day-group", _date: "2026-02-04" }) });
    await handlers.get("redmyne.copyFromTimeEntriesPane")?.();
    expect(executeSpy).toHaveBeenLastCalledWith("redmyne.copyDayTimeEntries", expect.objectContaining({ _date: "2026-02-04" }));

    // week-group
    registerCommands({ getSelectedNode: () => ({ contextValue: "week-group", _weekStart: "2026-02-02" }) });
    await handlers.get("redmyne.copyFromTimeEntriesPane")?.();
    expect(executeSpy).toHaveBeenLastCalledWith("redmyne.copyWeekTimeEntries", expect.objectContaining({ _weekStart: "2026-02-02" }));
  });

  it("copy dispatcher noops for drafts and unknown contextValues", async () => {
    const executeSpy = vi.spyOn(vscode.commands, "executeCommand");

    // draft — excluded
    registerCommands({ getSelectedNode: () => ({ contextValue: "time-entry-draft" }) });
    await handlers.get("redmyne.copyFromTimeEntriesPane")?.();
    const draftCalls = executeSpy.mock.calls.filter(c => /^redmyne\.copy/.test(String(c[0])));
    expect(draftCalls).toHaveLength(0);

    // load-earlier — not a copy target
    executeSpy.mockClear();
    registerCommands({ getSelectedNode: () => ({ contextValue: "load-earlier" }) });
    await handlers.get("redmyne.copyFromTimeEntriesPane")?.();
    expect(executeSpy.mock.calls.filter(c => /^redmyne\.copy/.test(String(c[0])))).toHaveLength(0);

    // no selection
    executeSpy.mockClear();
    registerCommands({ getSelectedNode: () => undefined });
    await handlers.get("redmyne.copyFromTimeEntriesPane")?.();
    expect(executeSpy.mock.calls.filter(c => /^redmyne\.copy/.test(String(c[0])))).toHaveLength(0);
  });

  it("shows fetch error when toolbar week copy cannot load entries", async () => {
    const mockServer = {
      getTimeEntries: vi.fn().mockRejectedValue(new Error("fetch fail")),
    };
    registerCommands({ getServer: () => mockServer });

    await handlers.get("redmyne.copyWeekTimeEntries")?.();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to fetch time entries");
  });

  it("toolbar week copy fetches the full Mon–Sun week, not capped at today", async () => {
    const getTimeEntries = vi.fn().mockResolvedValue({ time_entries: [] });
    registerCommands({ getServer: () => ({ getTimeEntries }) });

    await handlers.get("redmyne.copyWeekTimeEntries")?.();

    expect(getTimeEntries).toHaveBeenCalledTimes(1);
    const { from, to } = getTimeEntries.mock.calls[0][0] as { from: string; to: string };
    expect(from).toBe(getWeekStart());
    expect(daySpan(from, to)).toBe(6); // Monday → Sunday, full week
  });

  it("current-week node copy refetches the full week instead of the today-capped cache", async () => {
    const cur = getWeekStart();
    const getTimeEntries = vi.fn().mockResolvedValue({ time_entries: [] });
    // Node carries a today-capped cache; copy must ignore it and refetch the full week.
    registerCommands({
      getServer: () => ({ getTimeEntries }),
      getSelectedNode: () => ({
        _weekStart: cur,
        _cachedEntries: [{ id: 1, issue_id: 4, activity_id: 2, hours: "1", comments: "", spent_on: cur }],
      }),
    });

    await handlers.get("redmyne.copyWeekTimeEntries")?.();

    expect(getTimeEntries).toHaveBeenCalledTimes(1);
    const { from, to } = getTimeEntries.mock.calls[0][0] as { from: string; to: string };
    expect(daySpan(from, to)).toBe(6);
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

  it("reports 'queued to draft' instead of 'created' when draft mode is active", async () => {
    const mockServer = { addTimeEntry: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(clipboard, "getClipboard").mockReturnValue({
      kind: "day",
      entries: [{ issue_id: 1, activity_id: 2, hours: "1", comments: "" }],
      sourceDate: "2026-02-03",
    });
    vi.spyOn(clipboard, "calculatePasteTargetDates").mockReturnValue(["2026-02-05"]);
    vi.spyOn(closedIssueGuard, "confirmLogTimeOnClosedIssues").mockResolvedValue(true);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue("Create" as never);
    const statusSpy = vi.spyOn(statusBar, "showStatusBarMessage");

    registerCommands({ getServer: () => mockServer, isDraftMode: () => true });
    await handlers.get("redmyne.pasteTimeEntries")?.({ _date: "2026-02-05" });

    expect(statusSpy).toHaveBeenCalledWith(
      expect.stringContaining("Queued 1 entry to draft"),
      expect.any(Number)
    );
  });

  it("defers closed-issue check until after the paste is confirmed", async () => {
    const mockServer = { addTimeEntry: vi.fn() };
    vi.spyOn(clipboard, "getClipboard").mockReturnValue({
      kind: "day",
      entries: [{ issue_id: 1, activity_id: 2, hours: "1", comments: "" }],
      sourceDate: "2026-02-03",
    });
    vi.spyOn(clipboard, "calculatePasteTargetDates").mockReturnValue(["2026-02-05"]);
    const closedSpy = vi.spyOn(closedIssueGuard, "confirmLogTimeOnClosedIssues").mockResolvedValue(true);
    // User dismisses the confirm dialog
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as never);

    registerCommands({ getServer: () => mockServer });
    await handlers.get("redmyne.pasteTimeEntries")?.({ _date: "2026-02-05" });

    expect(closedSpy).not.toHaveBeenCalled();
    expect(mockServer.addTimeEntry).not.toHaveBeenCalled();
  });

  it("offers a retry of only the failed entries after a partial failure", async () => {
    const addTimeEntry = vi
      .fn()
      .mockResolvedValueOnce(undefined) // entry 1 ok
      .mockRejectedValueOnce(new Error("boom")) // entry 2 fails
      .mockResolvedValueOnce(undefined); // retry of entry 2 ok
    vi.spyOn(clipboard, "getClipboard").mockReturnValue({
      kind: "day",
      entries: [
        { issue_id: 1, activity_id: 2, hours: "1", comments: "a" },
        { issue_id: 2, activity_id: 2, hours: "1", comments: "b" },
      ],
      sourceDate: "2026-02-03",
    });
    vi.spyOn(clipboard, "calculatePasteTargetDates").mockReturnValue(["2026-02-05"]);
    vi.spyOn(closedIssueGuard, "confirmLogTimeOnClosedIssues").mockResolvedValue(true);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue("Create" as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Retry Failed" as never);
    const statusSpy = vi.spyOn(statusBar, "showStatusBarMessage");

    registerCommands({ getServer: () => ({ addTimeEntry }) });
    await handlers.get("redmyne.pasteTimeEntries")?.({ _date: "2026-02-05" });

    // 2 first attempt + 1 retry of only the failed item
    expect(addTimeEntry).toHaveBeenCalledTimes(3);
    // retry call targets the failed entry (#2), not the already-created #1
    expect(addTimeEntry).toHaveBeenNthCalledWith(3, 2, 2, "1", "b", "2026-02-05", undefined);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(statusSpy).toHaveBeenCalledWith(
      expect.stringContaining("Created 2 entries"),
      expect.any(Number)
    );
  });

  it("does not retry when the user dismisses the failure warning", async () => {
    const addTimeEntry = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(clipboard, "getClipboard").mockReturnValue({
      kind: "day",
      entries: [
        { issue_id: 1, activity_id: 2, hours: "1", comments: "a" },
        { issue_id: 2, activity_id: 2, hours: "1", comments: "b" },
      ],
      sourceDate: "2026-02-03",
    });
    vi.spyOn(clipboard, "calculatePasteTargetDates").mockReturnValue(["2026-02-05"]);
    vi.spyOn(closedIssueGuard, "confirmLogTimeOnClosedIssues").mockResolvedValue(true);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue("Create" as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);

    registerCommands({ getServer: () => ({ addTimeEntry }) });
    await handlers.get("redmyne.pasteTimeEntries")?.({ _date: "2026-02-05" });

    expect(addTimeEntry).toHaveBeenCalledTimes(2); // no retry
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it("pasting to the current week fetches the full week for the duplicate summary", async () => {
    const cur = getWeekStart();
    const getTimeEntries = vi.fn().mockResolvedValue({ time_entries: [] });
    const addTimeEntry = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(clipboard, "getClipboard").mockReturnValue({
      kind: "day",
      entries: [{ issue_id: 1, activity_id: 2, hours: "1", comments: "" }],
      sourceDate: "2026-02-03",
    });
    vi.spyOn(clipboard, "calculatePasteTargetDates").mockReturnValue([cur]);
    vi.spyOn(closedIssueGuard, "confirmLogTimeOnClosedIssues").mockResolvedValue(true);
    // Cancel at the confirm dialog — the existing-entries fetch happens before it.
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as never);

    registerCommands({ getServer: () => ({ getTimeEntries, addTimeEntry }) });
    await handlers.get("redmyne.pasteTimeEntries")?.({ _weekStart: cur });

    expect(getTimeEntries).toHaveBeenCalledTimes(1);
    const { from, to } = getTimeEntries.mock.calls[0][0] as { from: string; to: string };
    expect(from).toBe(cur);
    expect(daySpan(from, to)).toBe(6);
    expect(addTimeEntry).not.toHaveBeenCalled(); // cancelled at confirm
  });
});

describe("buildPasteWorkItems", () => {
  const entryA = { issue_id: 1, activity_id: 2, hours: "1", comments: "a" };
  const entryB = { issue_id: 3, activity_id: 2, hours: "2", comments: "b" };

  it("applies every entry to every target date for day/entry paste", () => {
    const items = buildPasteWorkItems(
      { kind: "day", entries: [entryA, entryB], sourceDate: "2026-03-10" },
      ["2026-03-16", "2026-03-17"],
      false,
      ""
    );
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.date)).toEqual([
      "2026-03-16",
      "2026-03-16",
      "2026-03-17",
      "2026-03-17",
    ]);
  });

  it("maps each target day to its source-day entries for week→week paste", () => {
    const weekMap = new Map([
      [0, [entryA]],
      [1, [entryB]],
    ]);
    const items = buildPasteWorkItems(
      { kind: "week", entries: [entryA, entryB], weekMap, sourceWeekStart: "2026-03-09" },
      ["2026-03-16", "2026-03-17"],
      true,
      "2026-03-16"
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ date: "2026-03-16", entry: entryA });
    expect(items[1]).toEqual({ date: "2026-03-17", entry: entryB });
  });
});

describe("buildPasteConfirmLines", () => {
  const entryFoo = { issue_id: 1, activity_id: 2, hours: "2", comments: "", issueSubject: "Foo", activityName: "Dev" };
  const entryBar = { issue_id: 3, activity_id: 2, hours: "1", comments: "", issueSubject: "Bar" };

  it("Entry/Day → Day: lists entries and existing-on-day with total", () => {
    const lines = buildPasteConfirmLines({
      clipboard: { kind: "day", entries: [entryFoo, entryBar], sourceDate: "2026-03-10" },
      targetKind: "day",
      targetDate: "2026-03-16",
      targetDates: ["2026-03-16"],
      isWeekToWeekPaste: false,
      targetWeekStartForPaste: "",
      existingEntries: [
        { id: 50, issue_id: 9, issue: { id: 9, subject: "Old" }, hours: "3", comments: "", spent_on: "2026-03-16" },
      ],
    });
    const text = lines.join("\n");
    expect(text).toContain("Paste to Mon, Mar 16:");
    expect(text).toContain("#1 Foo [Dev] — 2:00");
    expect(text).toContain("Already on this day (3:00):");
    expect(text).toContain("#9 Old — 3:00");
  });

  it("Entry/Day → Week: notes the per-day multiplier and total count", () => {
    const lines = buildPasteConfirmLines({
      clipboard: { kind: "day", entries: [entryFoo, entryBar], sourceDate: "2026-03-10" },
      targetKind: "week",
      targetWeekStart: "2026-03-16",
      targetDates: ["2026-03-16", "2026-03-17", "2026-03-18"],
      isWeekToWeekPaste: false,
      targetWeekStartForPaste: "",
      existingEntries: [],
    });
    const text = lines.join("\n");
    expect(text).toMatch(/Paste to Week \d+ — on each of 3 working days:/);
    expect(text).toContain("= 6 entries total");
  });

  it("Week → Week: breaks entries down per target day", () => {
    const weekMap = new Map([
      [0, [entryFoo]],
      [1, [entryBar]],
    ]);
    const lines = buildPasteConfirmLines({
      clipboard: { kind: "week", entries: [entryFoo, entryBar], weekMap, sourceWeekStart: "2026-03-09" },
      targetKind: "week",
      targetWeekStart: "2026-03-16",
      targetDates: ["2026-03-16", "2026-03-17"],
      isWeekToWeekPaste: true,
      targetWeekStartForPaste: "2026-03-16",
      existingEntries: [],
    });
    const text = lines.join("\n");
    expect(text).toContain("Mon, Mar 16:");
    expect(text).toContain("#1 Foo [Dev] — 2:00");
    expect(text).toContain("Tue, Mar 17:");
    expect(text).toContain("#3 Bar — 1:00");
  });

  it("Week target: summarises existing entries per day", () => {
    const lines = buildPasteConfirmLines({
      clipboard: { kind: "day", entries: [entryFoo], sourceDate: "2026-03-10" },
      targetKind: "week",
      targetWeekStart: "2026-03-16",
      targetDates: ["2026-03-16"],
      isWeekToWeekPaste: false,
      targetWeekStartForPaste: "",
      existingEntries: [
        { id: 60, issue_id: 9, hours: "2", comments: "", spent_on: "2026-03-16" },
        { id: 61, issue_id: 9, hours: "1.5", comments: "", spent_on: "2026-03-16" },
        { id: 62, issue_id: 8, hours: "4", comments: "", spent_on: "2026-03-18" },
      ],
    });
    const text = lines.join("\n");
    expect(text).toContain("Already in target week:");
    expect(text).toContain("Mon, Mar 16 — 2 entries, 3:30");
    expect(text).toContain("Wed, Mar 18 — 1 entry, 4:00");
  });

  it("excludes draft entries (negative id) from the existing summary", () => {
    const lines = buildPasteConfirmLines({
      clipboard: { kind: "day", entries: [entryFoo], sourceDate: "2026-03-10" },
      targetKind: "day",
      targetDate: "2026-03-16",
      targetDates: ["2026-03-16"],
      isWeekToWeekPaste: false,
      targetWeekStartForPaste: "",
      existingEntries: [
        { id: -5, issue_id: 9, hours: "3", comments: "", spent_on: "2026-03-16" },
      ],
    });
    expect(lines.join("\n")).not.toContain("Already on this day");
  });
});

describe("resolvePasteTarget", () => {
  it("resolves a day node to a day target", () => {
    expect(resolvePasteTarget({ _date: "2026-03-16" }, "2026-03-16")).toEqual({
      targetKind: "day",
      targetDate: "2026-03-16",
    });
  });

  it("resolves a week node to a week target", () => {
    expect(resolvePasteTarget({ _weekStart: "2026-03-16" }, "2026-03-09")).toEqual({
      targetKind: "week",
      targetWeekStart: "2026-03-16",
    });
  });

  it("falls back to the supplied week when no node is focused (toolbar)", () => {
    expect(resolvePasteTarget(undefined, "2026-03-09")).toEqual({
      targetKind: "week",
      targetWeekStart: "2026-03-09",
    });
  });
});
