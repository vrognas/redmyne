import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { TimeSheetPanel } from "../../../src/webviews/timesheet-panel";
import { buildWeekInfo } from "../../../src/webviews/timesheet-webview-messages";
import * as clipboardUtil from "../../../src/utilities/time-entry-clipboard";
import * as statusBarUtil from "../../../src/utilities/status-bar";
import * as issuePicker from "../../../src/utilities/issue-picker";
import { DRAFT_COMMAND_SOURCE } from "../../../src/draft-mode/draft-change-sources";

type MessageHandler = (message: unknown) => void;

interface MockWebviewPanelBundle {
  panel: vscode.WebviewPanel;
  webview: {
    html: string;
    cspSource: string;
    postMessage: ReturnType<typeof vi.fn>;
    asWebviewUri: ReturnType<typeof vi.fn>;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
  };
}

function createMockPanel(): MockWebviewPanelBundle {
  let _messageHandler: MessageHandler | undefined;

  const webview = {
    html: "",
    cspSource: "vscode-resource:",
    postMessage: vi.fn().mockResolvedValue(true),
    asWebviewUri: vi.fn((uri: unknown) => String(uri)),
    onDidReceiveMessage: vi.fn(
      (handler: MessageHandler, _thisArg?: unknown, disposables?: Array<{ dispose: () => void }>) => {
        _messageHandler = handler;
        const disposable = { dispose: vi.fn() };
        if (Array.isArray(disposables)) disposables.push(disposable);
        return disposable;
      }
    ),
  };

  const panel = {
    webview,
    visible: true,
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidDispose: vi.fn(
      (_handler: () => void, _thisArg?: unknown, disposables?: Array<{ dispose: () => void }>) => {
        const disposable = { dispose: vi.fn() };
        if (Array.isArray(disposables)) disposables.push(disposable);
        return disposable;
      }
    ),
    onDidChangeViewState: vi.fn(
      (_handler: () => void, _thisArg?: unknown, disposables?: Array<{ dispose: () => void }>) => {
        const disposable = { dispose: vi.fn() };
        if (Array.isArray(disposables)) disposables.push(disposable);
        return disposable;
      }
    ),
  } as unknown as vscode.WebviewPanel;

  return { panel, webview };
}

function createContext(): vscode.ExtensionContext {
  return {
    globalState: {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as vscode.ExtensionContext;
}

function createQueue() {
  return {
    count: 0,
    getAll: vi.fn(() => []),
    getByKeyPrefix: vi.fn(() => []),
    add: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    removeByKey: vi.fn().mockResolvedValue(undefined),
    removeByTempIdPrefix: vi.fn().mockResolvedValue(undefined),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

function createDraftModeManager(enabled: boolean, queue: ReturnType<typeof createQueue>) {
  return {
    isEnabled: enabled,
    queue,
    onDidChangeEnabled: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

function createServer() {
  return {
    getTimeEntries: vi.fn(),
    getProjects: vi.fn(),
    getOpenIssuesForProject: vi.fn(),
    getProjectTimeEntryActivities: vi.fn(),
    getIssueById: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };
}

function setupPanel(options?: {
  server?: ReturnType<typeof createServer> | undefined;
  queue?: ReturnType<typeof createQueue>;
  draftEnabled?: boolean;
  cachedIssues?: Array<{ id: number; subject: string; project?: { id: number } }>;
}) {
  const mock = createMockPanel();
  const extensionUri = vscode.Uri.parse("file:///ext");
  const context = createContext();
  const queue = options?.queue ?? createQueue();
  const server = options?.server;
  const draftModeManager = createDraftModeManager(options?.draftEnabled ?? true, queue);

  TimeSheetPanel.restore(
    mock.panel,
    extensionUri,
    context,
    () =>
      server as unknown as import("../../../src/redmine/redmine-server").RedmineServer,
    () =>
      queue as unknown as import("../../../src/draft-mode/draft-queue").DraftQueue,
    () =>
      draftModeManager as unknown as import("../../../src/draft-mode/draft-mode-manager").DraftModeManager,
    options?.cachedIssues
      ? () => options.cachedIssues as unknown as import("../../../src/redmine/models/issue").Issue[]
      : undefined
  );

  return {
    mock,
    context,
    queue,
    server,
    panel: TimeSheetPanel.currentPanel as unknown as Record<string, any>,
  };
}

describe("timesheet panel private coverage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    TimeSheetPanel.currentPanel = undefined;

    vi.spyOn(statusBarUtil, "showStatusBarMessage").mockImplementation(
      () => undefined
    );

    vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(
      () =>
        ({
          get: vi.fn((_key: string, fallback?: unknown) => fallback),
          update: vi.fn(),
        }) as unknown as vscode.WorkspaceConfiguration
    );

    (vscode.Uri as unknown as { joinPath: (...parts: unknown[]) => string }).joinPath = vi.fn(
      (...parts: unknown[]) => parts.map((part) => String(part)).join("/")
    );
  });

  it("covers project loaders and loadWeek success/no-server/error branches", async () => {
    const noServerSetup = setupPanel({ server: undefined, draftEnabled: false });
    await noServerSetup.panel._loadWeek(noServerSetup.panel._currentWeek);
    expect(noServerSetup.mock.webview.postMessage).toHaveBeenCalledWith({
      type: "showError",
      message: "No server configured",
    });

    const server = createServer();
    server.getTimeEntries.mockRejectedValueOnce(new Error("offline"));
    const failSetup = setupPanel({ server, draftEnabled: false });
    await failSetup.panel._loadWeek(failSetup.panel._currentWeek);
    expect(failSetup.mock.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "showError",
        message: expect.stringContaining("Failed to load"),
      })
    );

    server.getTimeEntries.mockResolvedValueOnce({
      time_entries: [
        {
          id: 11,
          issue_id: 77,
          activity_id: 9,
          hours: "2.5",
          comments: "notes",
          spent_on: "2026-02-02",
          project: { id: 2, name: "Child" },
          issue: { id: 77, subject: "Cached issue subject" },
          activity: { id: 9, name: "Dev" },
        },
      ],
    });
    server.getProjects.mockResolvedValueOnce([
      { id: 1, name: "Parent", identifier: "parent", parent: undefined },
      { id: 2, name: "Child", identifier: "child", parent: { id: 1, name: "Parent" } },
      { id: 3, name: "Orphan", identifier: "orphan", parent: undefined },
    ]);
    server.getOpenIssuesForProject.mockResolvedValue({
      issues: [{ id: 77, subject: "Resolved issue", project: { id: 2 } }],
    });
    server.getProjectTimeEntryActivities.mockResolvedValue([
      { id: 9, name: "Dev", is_default: true },
    ]);
    server.getIssueById.mockResolvedValue({
      issue: {
        id: 77,
        subject: "Resolved issue",
        status: { name: "New" },
        priority: { name: "Normal" },
        tracker: { name: "Task" },
        assigned_to: { name: "Alice" },
        done_ratio: 10,
        estimated_hours: 8,
        spent_hours: 1,
        start_date: "2026-02-01",
        due_date: "2026-02-10",
        custom_fields: [{ name: "Team", value: "A" }],
      },
    });

    const okSetup = setupPanel({
      server,
      draftEnabled: false,
      cachedIssues: [{ id: 88, subject: "Sidebar cache", project: { id: 2 } }],
    });
    okSetup.panel._currentWeek = buildWeekInfo(new Date(2026, 1, 2));
    okSetup.panel._loadAllIssueDetails = vi.fn();

    await okSetup.panel._loadWeek(okSetup.panel._currentWeek);
    expect(okSetup.panel._rows.length).toBeGreaterThan(0);
    expect(okSetup.panel._parentProjects.some((p: { name: string }) => p.name === "Others")).toBe(true);
    expect(okSetup.panel._childrenByParent.get(1)).toHaveLength(1);

    await okSetup.panel._loadIssuesForProject(2);
    await okSetup.panel._loadIssuesForProject(2, true);
    await okSetup.panel._loadActivitiesForProject(2);
    await okSetup.panel._loadActivitiesForProject(2, true);
    await okSetup.panel._loadIssueDetails(77);
    await okSetup.panel._loadIssueDetails(77);

    expect(server.getOpenIssuesForProject).toHaveBeenCalled();
    expect(server.getProjectTimeEntryActivities).toHaveBeenCalled();
    expect(server.getIssueById).toHaveBeenCalledTimes(1);
  });

  it("covers queueCellOperation/updateCell/updateRowField branches", async () => {
    const queue = createQueue();
    const server = createServer();
    const setup = setupPanel({ server, queue, draftEnabled: true });
    const panel = setup.panel;

    const row = panel._createEmptyRow();
    row.id = "row-1";
    row.isNew = true;
    row.parentProjectId = 1;
    row.projectId = 2;
    row.issueId = 5;
    row.activityId = 9;
    row.comments = "old";
    row.originalComments = "old";
    row.days[0] = { hours: 1, originalHours: 1, entryId: 11, isDirty: false };
    row.days[1] = { hours: 0, originalHours: 0, entryId: null, isDirty: false };
    row.weekTotal = 1;

    panel._rows = [row];
    panel._parentProjects = [{ id: 1, name: "Parent" }];
    panel._projects = [{ id: 2, name: "Child" }];
    panel._issuesByProject = new Map([[2, [{ id: 5, subject: "Issue 5", projectId: 2 }]]]);
    panel._activitiesByProject = new Map([[2, [{ id: 9, name: "Dev" }]]]);
    panel._currentWeek = buildWeekInfo(new Date(2026, 1, 2));
    panel._loadProjectData = vi.fn().mockResolvedValue(undefined);
    panel._sendChildProjects = vi.fn();

    await panel._queueCellOperation(row, 0, 2, 11, true);
    await panel._queueCellOperation(row, 0, 0, 11, true);
    await panel._queueCellOperation(row, 1, 3, null, true);
    await panel._queueCellOperation(row, 1, 0, null, true);
    await panel._queueCellOperation(row, 1, 0, null, false);

    row.issueId = null;
    await panel._queueCellOperation(row, 1, 2, null, true);
    row.issueId = 5;

    await panel._updateCell("row-1", 0, 2);
    expect(row.days[0].hours).toBe(2);
    expect(setup.mock.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "updateRow" })
    );

    await panel._updateRowField("row-1", "parentProject", 1);
    await panel._updateRowField("row-1", "project", 2);
    await panel._updateRowField("row-1", "issue", 5);
    await panel._updateRowField("row-1", "activity", 9);
    await panel._updateRowField("row-1", "comments", "changed");
    await panel._updateRowField("row-1", "comments", "old");

    expect(panel._sendChildProjects).toHaveBeenCalledWith(1);
    expect(panel._loadProjectData).toHaveBeenCalledWith(2);
    expect(queue.add).toHaveBeenCalled();
    expect(queue.removeByKey).toHaveBeenCalled();
  });

  it("covers saveAll copy/paste undo and draft-mode requirements", async () => {
    const queue = createQueue();
    const server = createServer();
    const setup = setupPanel({ server, queue, draftEnabled: true });
    const panel = setup.panel;

    panel._loadWeek = vi.fn().mockResolvedValue(undefined);

    panel._getDraftModeManagerFn = () => ({ isEnabled: false, queue } as unknown as import("../../../src/draft-mode/draft-mode-manager").DraftModeManager);
    await panel._saveAll();
    expect(setup.mock.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "showError", message: "Draft mode not enabled" })
    );

    panel._getDraftModeManagerFn = () => ({ isEnabled: true, queue } as unknown as import("../../../src/draft-mode/draft-mode-manager").DraftModeManager);
    queue.getByKeyPrefix.mockReturnValueOnce([]);
    await panel._saveAll();
    expect(statusBarUtil.showStatusBarMessage).toHaveBeenCalledWith("$(info) No changes to save", 2000);

    queue.getByKeyPrefix.mockReturnValueOnce([
      { id: "a", description: "create", http: { method: "POST", path: "/time_entries.json", data: { time_entry: { hours: 1 } } } },
      { id: "b", description: "update", http: { method: "PUT", path: "/time_entries/1.json", data: { time_entry: { hours: 2 } } } },
      { id: "c", description: "delete", http: { method: "DELETE", path: "/time_entries/2.json" } },
    ]);
    server.post.mockResolvedValue(undefined);
    server.put.mockRejectedValueOnce(new Error("cannot put"));
    server.delete.mockResolvedValue(undefined);
    await panel._saveAll();
    expect(queue.remove).toHaveBeenCalledWith("a", "timesheet-panel");
    expect(queue.remove).toHaveBeenCalledWith("c", "timesheet-panel");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Failed: update - cannot put")
    );
    expect(panel._loadWeek).toHaveBeenCalled();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.refreshTimeEntries");

    panel._rows = [];
    panel._copyWeek();
    expect(statusBarUtil.showStatusBarMessage).toHaveBeenCalledWith("$(warning) No entries to copy", 2000);

    const row = panel._createEmptyRow();
    row.id = "row-copy";
    row.issueId = 5;
    row.activityId = 9;
    row.projectId = 2;
    row.comments = "note";
    row.days[0].hours = 2;
    row.weekTotal = 2;
    panel._rows = [row];

    const setClipboardSpy = vi.spyOn(clipboardUtil, "setClipboard");
    panel._copyWeek();
    expect(setClipboardSpy).toHaveBeenCalled();

    const getClipboardSpy = vi.spyOn(clipboardUtil, "getClipboard");
    getClipboardSpy.mockReturnValueOnce(null);
    await panel._pasteWeek();
    expect(statusBarUtil.showStatusBarMessage).toHaveBeenCalledWith("$(warning) No week data to paste", 2000);

    getClipboardSpy.mockReturnValueOnce({
      kind: "week",
      entries: [],
      weekMap: new Map([[0, [{ issue_id: 5, activity_id: 9, hours: "1", comments: "x", project_id: 2 }]]]),
      sourceWeekStart: panel._currentWeek.startDate,
    });
    panel._getDraftModeManagerFn = () => ({ isEnabled: false, queue } as unknown as import("../../../src/draft-mode/draft-mode-manager").DraftModeManager);
    await panel._pasteWeek();
    expect(statusBarUtil.showStatusBarMessage).toHaveBeenCalledWith("$(warning) Draft mode required", 2000);

    getClipboardSpy.mockReturnValueOnce({
      kind: "week",
      entries: [],
      weekMap: new Map([[0, [{ issue_id: 5, activity_id: 9, hours: "1", comments: "x", project_id: 2 }]]]),
      sourceWeekStart: panel._currentWeek.startDate,
    });
    panel._getDraftModeManagerFn = () => ({ isEnabled: true, queue } as unknown as import("../../../src/draft-mode/draft-mode-manager").DraftModeManager);
    await panel._pasteWeek();
    expect(queue.add).toHaveBeenCalled();
    expect(setup.mock.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "pasteComplete" })
    );

    await panel._undoPaste(["d1", "d2"]);
    expect(queue.remove).toHaveBeenCalledWith("d1", "timesheet-panel");
    expect(queue.remove).toHaveBeenCalledWith("d2", "timesheet-panel");
  });

  it("covers aggregated and expanded entry flows", async () => {
    const queue = createQueue();
    const server = createServer();
    const setup = setupPanel({ server, queue, draftEnabled: true });
    const panel = setup.panel;

    panel._loadWeek = vi.fn().mockResolvedValue(undefined);
    panel._updateAggregatedCellLocal = vi.fn();

    const aggRowId = "agg-5::9::notes";
    const sourceSaved = {
      rowId: "r1",
      entryId: 101,
      hours: 2,
      originalHours: 2,
      isDraft: false,
      issueId: 5,
      activityId: 9,
      comments: "notes",
    };
    const sourceDraft = {
      rowId: "r2",
      entryId: null,
      hours: 1,
      originalHours: 0,
      isDraft: true,
      issueId: 5,
      activityId: 9,
      comments: "notes",
    };

    await panel._updateAggregatedCell(aggRowId, 0, 3, [sourceSaved, sourceDraft], false);
    expect(setup.mock.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "requestAggregatedCellConfirm" })
    );

    await panel._updateAggregatedCell("bad-row-id", 0, 2, [], true);
    await panel._updateAggregatedCell(aggRowId, 0, 0, [], true);
    await panel._updateAggregatedCell(aggRowId, 0, 2, [], true);
    await panel._updateAggregatedCell(aggRowId, 0, 0, [sourceDraft], true);
    await panel._updateAggregatedCell(aggRowId, 0, 2, [sourceSaved], true);
    await panel._updateAggregatedCell(aggRowId, 0, 0, [sourceSaved], true);
    await panel._updateAggregatedCell(aggRowId, 0, 3, [sourceSaved], true);
    await panel._updateAggregatedCell(aggRowId, 0, 4, [sourceSaved, sourceDraft], true);
    expect(queue.add).toHaveBeenCalled();
    expect(queue.removeByKey).toHaveBeenCalled();
    expect(panel._updateAggregatedCellLocal).toHaveBeenCalled();

    panel._rows = [
      {
        ...panel._createEmptyRow(),
        id: "r1",
        issueId: 5,
        activityId: 9,
        comments: "a",
      },
      {
        ...panel._createEmptyRow(),
        id: "r2",
        issueId: 5,
        activityId: 9,
        comments: "a",
      },
    ];
    panel._updateRowField = vi.fn().mockResolvedValue(undefined);
    await panel._updateAggregatedField(aggRowId, "comments", "x", ["r1", "r2"], false);
    expect(setup.mock.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "requestAggregatedFieldConfirm" })
    );
    await panel._updateAggregatedField(aggRowId, "comments", "x", ["r1", "r2"], true);
    expect(panel._updateRowField).toHaveBeenCalledTimes(2);
    expect(setup.mock.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "showToast", message: "Updated 2 entries" })
    );

    await panel._restoreAggregatedEntries(
      [{ entryId: 101 }, { entryId: null }],
      aggRowId,
      0
    );
    expect(queue.removeByKey).toHaveBeenCalledWith("ts:timeentry:101", "timesheet-panel");
    expect(panel._loadWeek).toHaveBeenCalled();

    panel._rows = [{ ...panel._createEmptyRow(), id: "r1" }];
    await panel._updateExpandedEntry("r1", 201, 0, 2);
    await panel._updateExpandedEntry("r1", 201, 0, 0);
    await panel._deleteExpandedEntry("r1", 202, aggRowId, 0);
    expect(queue.add).toHaveBeenCalled();

    panel._getDraftModeManagerFn = () => ({ isEnabled: false, queue } as unknown as import("../../../src/draft-mode/draft-mode-manager").DraftModeManager);
    await panel._mergeEntries(aggRowId, 0, [
      { entryId: 1, hours: 1, rowId: "r1", issueId: 5, activityId: 9, comments: "", spentOn: "2026-02-02" },
      { entryId: 2, hours: 2, rowId: "r2", issueId: 5, activityId: 9, comments: "", spentOn: "2026-02-02" },
    ]);
    expect(setup.mock.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "showError", message: "Draft mode required for merge" })
    );

    panel._getDraftModeManagerFn = () => ({ isEnabled: true, queue } as unknown as import("../../../src/draft-mode/draft-mode-manager").DraftModeManager);
    await panel._mergeEntries(aggRowId, 0, [
      { entryId: 1, hours: 1, rowId: "r1", issueId: 5, activityId: 9, comments: "", spentOn: "2026-02-02" },
    ]);
    await panel._mergeEntries(aggRowId, 0, [
      { entryId: 1, hours: 1, rowId: "r1", issueId: 5, activityId: 9, comments: "", spentOn: "2026-02-02" },
      { entryId: 2, hours: 2, rowId: "r2", issueId: 5, activityId: 9, comments: "", spentOn: "2026-02-02" },
      { entryId: 3, hours: 3, rowId: "r3", issueId: 5, activityId: 9, comments: "", spentOn: "2026-02-02" },
    ]);
    expect(statusBarUtil.showStatusBarMessage).toHaveBeenCalledWith("$(git-merge) Merged 3 entries (6h)", 3000);
    expect(panel._loadWeek).toHaveBeenCalled();
  });

  it("covers _updateAggregatedCellLocal branch matrix end-to-end", () => {
    const setup = setupPanel({ server: createServer(), queue: createQueue(), draftEnabled: true });
    const panel = setup.panel;
    panel._postRenderMessage = vi.fn();
    panel._saveIncompleteRows = vi.fn();
    panel._clearCompletedRow = vi.fn();

    const existing = panel._createEmptyRow();
    existing.id = "existing";
    existing.issueId = 5;
    existing.activityId = 9;
    existing.projectId = 2;
    existing.projectName = "Child";
    existing.parentProjectId = 1;
    existing.parentProjectName = "Parent";
    existing.issueSubject = "Issue 5";
    existing.activityName = "Dev";

    // sourceEntries=0,newHours=0: undo-create path removes row
    const undoRow = panel._createEmptyRow();
    undoRow.id = "undo-row";
    undoRow.isNew = true;
    undoRow.issueId = 5;
    undoRow.activityId = 9;
    undoRow.days[0] = { hours: 2, originalHours: 0, entryId: null, isDirty: true };
    undoRow.weekTotal = 2;
    panel._rows = [existing, undoRow];
    panel._updateAggregatedCellLocal([], 0, 0, 5, 9, "note");
    expect(panel._rows.some((r: { id: string }) => r.id === "undo-row")).toBe(false);
    expect(panel._clearCompletedRow).toHaveBeenCalledWith("undo-row");

    // sourceEntries=0,newHours>0: create row path
    panel._rows = [existing];
    panel._updateAggregatedCellLocal([], 1, 3, 5, 9, "new note");
    expect(panel._rows.some((r: { isNew: boolean; days: Record<number, { hours: number }> }) => r.isNew && r.days[1]?.hours === 3)).toBe(true);
    expect(panel._saveIncompleteRows).toHaveBeenCalled();

    // sourceEntries=1: update single source row path
    const single = panel._createEmptyRow();
    single.id = "single";
    single.issueId = 5;
    single.activityId = 9;
    single.days[2] = { hours: 1, originalHours: 1, entryId: 101, isDirty: false };
    single.weekTotal = 1;
    panel._rows = [existing, single];
    panel._updateAggregatedCellLocal(
      [{ rowId: "single", entryId: 101, hours: 1 }],
      2,
      4,
      5,
      9,
      "single note"
    );
    expect(single.days[2].hours).toBe(4);
    expect(single.weekTotal).toBe(4);

    // sourceEntries>1,newHours=0: zero all sources
    const a = panel._createEmptyRow();
    a.id = "multi-a";
    a.issueId = 5;
    a.activityId = 9;
    a.days[3] = { hours: 2, originalHours: 2, entryId: 201, isDirty: false };
    a.weekTotal = 2;
    const b = panel._createEmptyRow();
    b.id = "multi-b";
    b.issueId = 5;
    b.activityId = 9;
    b.days[3] = { hours: 1, originalHours: 1, entryId: 202, isDirty: false };
    b.weekTotal = 1;
    panel._rows = [existing, a, b];
    panel._updateAggregatedCellLocal(
      [
        { rowId: "multi-a", entryId: 201, hours: 2 },
        { rowId: "multi-b", entryId: 202, hours: 1 },
      ],
      3,
      0,
      5,
      9,
      null
    );
    expect(a.days[3].hours).toBe(0);
    expect(b.days[3].hours).toBe(0);

    // sourceEntries>1,newHours>0: zero sources + create merged row
    panel._rows = [existing, a, b];
    panel._updateAggregatedCellLocal(
      [
        { rowId: "multi-a", entryId: 201, hours: 2 },
        { rowId: "multi-b", entryId: 202, hours: 1 },
      ],
      4,
      5,
      5,
      9,
      "merged"
    );
    expect(panel._rows.some((r: { isNew: boolean; comments: string; days: Record<number, { hours: number }> }) => r.isNew && r.comments === "merged" && r.days[4]?.hours === 5)).toBe(true);
    expect(panel._postRenderMessage).toHaveBeenCalled();
  });

  it("covers aggregated/expanded guard returns when draft mode unavailable", async () => {
    const setup = setupPanel({ server: createServer(), queue: createQueue(), draftEnabled: false });
    const panel = setup.panel;
    const postSpy = vi.spyOn(panel, "_postMessage");

    panel._getDraftModeManagerFn = () => undefined;
    await panel._updateAggregatedField("agg-1::2::x", "comments", "v", ["missing"], true);
    await panel._restoreAggregatedEntries([], "agg-1::2::x", 0);
    await panel._updateExpandedEntry("missing", 10, 0, 1);
    await panel._deleteExpandedEntry("missing", 10, "agg-1::2::x", 0);
    await panel._mergeEntries("agg-1::2::x", 0, []);

    expect(postSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "showToast" }));
  });

  it("covers pending draft restoration and incomplete-row storage paths", () => {
    const queue = createQueue();
    const server = createServer();
    const setup = setupPanel({ server, queue, draftEnabled: true });
    const panel = setup.panel;
    const globalState = (setup.context.globalState as unknown as {
      get: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    });

    panel._currentWeek = buildWeekInfo(new Date(2026, 1, 2));
    panel._projects = [{ id: 2, name: "Child", identifier: "child", path: "Child", parentId: 1 }];
    panel._parentProjects = [{ id: 1, name: "Parent", identifier: "parent", path: "Parent", parentId: null }];

    const rowUpdate = panel._createEmptyRow();
    rowUpdate.id = "row-update";
    rowUpdate.issueId = 5;
    rowUpdate.activityId = 9;
    rowUpdate.days[0] = { hours: 1, originalHours: 1, entryId: 100, isDirty: false };
    rowUpdate.weekTotal = 1;

    const rowAgg = panel._createEmptyRow();
    rowAgg.id = "row-agg";
    rowAgg.issueId = 5;
    rowAgg.activityId = 9;
    rowAgg.comments = "note";

    const rowNormal = panel._createEmptyRow();
    rowNormal.id = "row-normal";

    panel._rows = [rowUpdate, rowAgg, rowNormal];

    queue.getAll.mockReturnValue([
      {
        type: "updateTimeEntry",
        resourceId: 100,
        http: { data: { time_entry: { hours: 2 } } },
      },
      {
        type: "deleteTimeEntry",
        resourceId: 100,
        http: {},
      },
      {
        type: "createTimeEntry",
        tempId: "agg-5::9::note:0",
        http: { data: { time_entry: { hours: 3 } } },
      },
      {
        type: "createTimeEntry",
        tempId: "draft-timeentry-abc",
        http: {
          data: {
            time_entry: {
              issue_id: 5,
              activity_id: 9,
              project_id: 2,
              hours: 1.5,
              spent_on: panel._currentWeek.dayDates[1],
              comments: "note",
            },
          },
        },
      },
      {
        type: "createTimeEntry",
        tempId: "row-normal:2",
        http: { data: { time_entry: { hours: 4 } } },
      },
      {
        type: "createTimeEntry",
        tempId: "agg-5::9::note:99",
        http: { data: { time_entry: { hours: 5 } } },
      },
    ]);

    panel._applyPendingDraftChanges();
    expect(rowUpdate.days[0].isDirty).toBe(true);
    expect([rowUpdate.days[0].hours, rowAgg.days[0].hours]).toContain(3);
    expect(rowNormal.days[2].hours).toBe(4);
    expect(panel._rows.some((r: { isNew: boolean; issueId: number | null }) => r.isNew && r.issueId === 5)).toBe(true);

    const incompleteA = { ...panel._createEmptyRow(), id: "new-a", isNew: true, weekTotal: 0 };
    const incompleteB = { ...panel._createEmptyRow(), id: "new-b", isNew: true, weekTotal: 2 };
    globalState.get.mockImplementation((key: string, fallback?: unknown) => {
      if (key.includes("incompleteRows")) return [incompleteA, incompleteB];
      return fallback;
    });
    queue.getAll.mockReturnValue([
      { tempId: "new-b:0" },
      { tempId: "x:0" },
    ]);
    panel._rows = [incompleteB];
    panel._restoreIncompleteRows(panel._currentWeek.startDate);
    expect(panel._rows.some((r: { id: string }) => r.id === "new-a")).toBe(true);
    expect(panel._rows.some((r: { id: string }) => r.id === "new-b")).toBe(true);

    panel._rows = [incompleteB];
    panel._saveIncompleteRows();
    expect(globalState.update).toHaveBeenCalledWith(
      expect.stringContaining(panel._currentWeek.startDate),
      expect.any(Array)
    );
    panel._rows = [];
    panel._saveIncompleteRows();
    expect(globalState.update).toHaveBeenCalledWith(
      expect.stringContaining(panel._currentWeek.startDate),
      undefined
    );

    globalState.get.mockReturnValue([{ id: "new-a" }, { id: "new-b" }]);
    panel._clearCompletedRow("new-a");
    expect(globalState.update).toHaveBeenCalledWith(
      expect.stringContaining(panel._currentWeek.startDate),
      [{ id: "new-b" }]
    );
    globalState.get.mockReturnValue([{ id: "only-row" }]);
    panel._clearCompletedRow("only-row");
    expect(globalState.update).toHaveBeenCalledWith(
      expect.stringContaining(panel._currentWeek.startDate),
      undefined
    );
  });

  it("covers constructor listeners, source gating, view-state callbacks, and dispose", async () => {
    let queueChangeHandler: ((source?: string) => void) | undefined;
    let draftEnabledHandler: (() => void) | undefined;
    let viewStateHandler: (() => void) | undefined;
    let disposeHandler: (() => void) | undefined;

    const webview = {
      html: "",
      cspSource: "vscode-resource:",
      postMessage: vi.fn().mockResolvedValue(true),
      asWebviewUri: vi.fn((uri: unknown) => String(uri)),
      onDidReceiveMessage: vi.fn(
        (_handler: MessageHandler, _thisArg?: unknown, disposables?: Array<{ dispose: () => void }>) => {
          const disposable = { dispose: vi.fn() };
          if (Array.isArray(disposables)) disposables.push(disposable);
          return disposable;
        }
      ),
    };
    const panel = {
      webview,
      visible: true,
      reveal: vi.fn(),
      dispose: vi.fn(),
      onDidDispose: vi.fn(
        (handler: () => void, _thisArg?: unknown, disposables?: Array<{ dispose: () => void }>) => {
          disposeHandler = handler;
          const disposable = { dispose: vi.fn() };
          if (Array.isArray(disposables)) disposables.push(disposable);
          return disposable;
        }
      ),
      onDidChangeViewState: vi.fn(
        (handler: () => void, _thisArg?: unknown, disposables?: Array<{ dispose: () => void }>) => {
          viewStateHandler = handler;
          const disposable = { dispose: vi.fn() };
          if (Array.isArray(disposables)) disposables.push(disposable);
          return disposable;
        }
      ),
    } as unknown as vscode.WebviewPanel;

    const queue = {
      ...createQueue(),
      onDidChange: vi.fn((handler: (source?: string) => void) => {
        queueChangeHandler = handler;
        return { dispose: vi.fn() };
      }),
    };
    const draftModeManager = {
      isEnabled: true,
      queue,
      onDidChangeEnabled: vi.fn((handler: () => void) => {
        draftEnabledHandler = handler;
        return { dispose: vi.fn() };
      }),
    };
    const server = createServer();

    TimeSheetPanel.restore(
      panel,
      vscode.Uri.parse("file:///ext"),
      createContext(),
      () => server as unknown as import("../../../src/redmine/redmine-server").RedmineServer,
      () => queue as unknown as import("../../../src/draft-mode/draft-queue").DraftQueue,
      () =>
        draftModeManager as unknown as import("../../../src/draft-mode/draft-mode-manager").DraftModeManager
    );
    const instance = TimeSheetPanel.currentPanel as unknown as Record<string, any>;
    instance._loadWeek = vi.fn().mockResolvedValue(undefined);
    instance._saveIncompleteRows = vi.fn();

    draftEnabledHandler?.();
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: "draftModeChanged",
      isDraftMode: true,
    });

    queueChangeHandler?.("timesheet-panel");
    queueChangeHandler?.(DRAFT_COMMAND_SOURCE);
    expect(instance._loadWeek).not.toHaveBeenCalled();

    queueChangeHandler?.("external-change");
    await Promise.resolve();
    expect(instance._loadWeek).toHaveBeenCalledTimes(1);

    (panel as unknown as { visible: boolean }).visible = true;
    viewStateHandler?.();
    await Promise.resolve();
    expect(instance._loadWeek).toHaveBeenCalledTimes(2);

    (panel as unknown as { visible: boolean }).visible = false;
    viewStateHandler?.();
    expect(instance._saveIncompleteRows).toHaveBeenCalledTimes(1);

    disposeHandler?.();
    expect((panel as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalled();
    expect(TimeSheetPanel.currentPanel).toBeUndefined();
  });

  it("covers delete/restore/duplicate guard-heavy branches for normal and aggregated rows", async () => {
    const queue = createQueue();
    const server = createServer();
    const setup = setupPanel({ server, queue, draftEnabled: true });
    const panel = setup.panel;
    panel._loadWeek = vi.fn().mockResolvedValue(undefined);

    const savedRow = panel._createEmptyRow();
    savedRow.id = "saved-row";
    savedRow.isNew = false;
    savedRow.issueId = 5;
    savedRow.activityId = 9;
    savedRow.comments = "memo";
    savedRow.days[0] = { hours: 2, originalHours: 2, entryId: 101, isDirty: false };
    savedRow.weekTotal = 2;

    const newRow = panel._createEmptyRow();
    newRow.id = "new-row";
    newRow.isNew = true;
    newRow.issueId = 5;
    newRow.activityId = 9;
    newRow.comments = "memo";
    newRow.days[1] = { hours: 1, originalHours: 0, entryId: null, isDirty: true };
    newRow.weekTotal = 1;

    const aggRowA = panel._createEmptyRow();
    aggRowA.id = "agg-src-a";
    aggRowA.isNew = false;
    aggRowA.issueId = 5;
    aggRowA.activityId = 9;
    aggRowA.comments = "memo";
    aggRowA.days[0] = { hours: 1, originalHours: 1, entryId: 201, isDirty: false };
    aggRowA.weekTotal = 1;

    const aggRowB = panel._createEmptyRow();
    aggRowB.id = "agg-src-b";
    aggRowB.isNew = false;
    aggRowB.issueId = 5;
    aggRowB.activityId = 9;
    aggRowB.comments = "memo";
    aggRowB.days[0] = { hours: 2, originalHours: 2, entryId: 202, isDirty: false };
    aggRowB.weekTotal = 2;

    panel._rows = [savedRow, newRow, aggRowA, aggRowB];

    panel._duplicateRow("agg-5::9::memo");
    panel._duplicateRow("saved-row");
    panel._duplicateRow("missing-row");
    expect(setup.mock.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "rowDuplicated" })
    );

    await panel._deleteRow("missing-row");
    await panel._deleteRow("new-row");
    expect(queue.removeByTempIdPrefix).toHaveBeenCalledWith("new-row:", "timesheet-panel");

    await panel._deleteRow("saved-row");
    expect(queue.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: "deleteTimeEntry", resourceId: 101 }),
      "timesheet-panel"
    );
    expect(setup.mock.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "rowDeleted" })
    );

    await panel._deleteRow("agg-bad-row-id");
    await panel._deleteRow("agg-5::9::memo");
    expect(panel._loadWeek).toHaveBeenCalled();

    panel._restoreRow(savedRow);
    expect(queue.removeByKey).toHaveBeenCalledWith("ts:timeentry:101", "timesheet-panel");
  });

  it("covers issue picking and week navigation branch combinations", async () => {
    const queue = createQueue();
    const server = createServer();
    const setup = setupPanel({ server, queue, draftEnabled: true });
    const panel = setup.panel;
    panel._loadWeek = vi.fn().mockResolvedValue(undefined);
    panel._loadProjectData = vi.fn().mockResolvedValue(undefined);
    panel._sendChildProjects = vi.fn();

    panel._projects = [
      { id: 1, name: "Parent", identifier: "parent", path: "Parent", parentId: null },
      { id: 2, name: "Child", identifier: "child", path: "Parent/Child", parentId: 1 },
      { id: 3, name: "Orphan", identifier: "orphan", path: "Orphan", parentId: null },
    ];
    panel._parentProjects = [
      { id: 1, name: "Parent", identifier: "parent", path: "Parent", parentId: null },
      { id: -1, name: "Others", identifier: "", path: "Others", parentId: null },
    ];

    const row = panel._createEmptyRow();
    row.id = "pick-row";
    panel._rows = [row];

    const pickSpy = vi.spyOn(issuePicker, "pickIssue");

    await panel._pickIssueForRow("missing-row");
    expect(pickSpy).not.toHaveBeenCalled();

    pickSpy.mockResolvedValueOnce(undefined);
    await panel._pickIssueForRow("pick-row");

    pickSpy.mockResolvedValueOnce({
      id: 123,
      subject: "Picked child",
      project: { id: 2, name: "Child" },
    } as unknown as import("../../../src/redmine/models/issue").Issue);
    await panel._pickIssueForRow("pick-row");
    expect(panel._rows[0].parentProjectId).toBe(1);
    expect(panel._sendChildProjects).toHaveBeenCalledWith(1);
    expect(panel._loadProjectData).toHaveBeenCalledWith(2);

    pickSpy.mockResolvedValueOnce({
      id: 124,
      subject: "Picked orphan",
      project: { id: 3, name: "Orphan" },
    } as unknown as import("../../../src/redmine/models/issue").Issue);
    await panel._pickIssueForRow("pick-row");
    expect(panel._rows[0].parentProjectId).toBe(-1);

    await panel._navigateWeek("today");
    await panel._navigateWeek("date", "2026-03-01");
    await panel._navigateWeek("prev");
    await panel._navigateWeek("next");
    await panel._navigateWeek("date");
    expect(panel._loadWeek).toHaveBeenCalledTimes(5);
  });
});
