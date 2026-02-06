import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerTimeEntryCommands } from "../../../src/commands/time-entry-commands";
import * as issuePicker from "../../../src/utilities/issue-picker";
import * as customFieldPicker from "../../../src/utilities/custom-field-picker";

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
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: "Comment",
      field: "comments",
    } as unknown as vscode.QuickPickItem);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("Updated comment");

    await handlers.get("redmyne.editTimeEntry")?.({
      _entry: {
        id: 31,
        hours: "1.5",
        comments: "Old comment",
        issue: { id: 9, subject: "Task" },
      },
    });

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
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: "Hours",
      field: "hours",
    } as unknown as vscode.QuickPickItem);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("1:30");

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
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: "Date",
      field: "date",
    } as unknown as vscode.QuickPickItem);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("2026-02-07");

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
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({
        label: "Activity",
        field: "activity",
      } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({
        label: "Development",
        activityId: 5,
      } as unknown as vscode.QuickPickItem);

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
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: "Issue",
      field: "issue",
    } as unknown as vscode.QuickPickItem);

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
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: "Custom Fields",
      field: "customFields",
    } as unknown as vscode.QuickPickItem);

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
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: "Comment",
      field: "comments",
    } as unknown as vscode.QuickPickItem);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("Updated comment");

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
});
