import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { GanttPanel } from "../../../src/webviews/gantt-panel";
import { TimeSheetPanel } from "../../../src/webviews/timesheet-panel";
import { adHocTracker } from "../../../src/utilities/adhoc-tracker";
import * as precedenceTracker from "../../../src/utilities/precedence-tracker";
import * as statusBar from "../../../src/utilities/status-bar";

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
  getMessageHandler: () => MessageHandler | undefined;
}

function createDraftModeManager(enabled: boolean): import("../../../src/draft-mode/draft-mode-manager").DraftModeManager {
  return {
    isEnabled: enabled,
    onDidChangeEnabled: vi.fn(() => ({ dispose: vi.fn() })),
  } as unknown as import("../../../src/draft-mode/draft-mode-manager").DraftModeManager;
}

function createMockPanel(): MockWebviewPanelBundle {
  let messageHandler: MessageHandler | undefined;

  const webview = {
    html: "",
    cspSource: "vscode-resource:",
    postMessage: vi.fn().mockResolvedValue(true),
    asWebviewUri: vi.fn((uri: unknown) => String(uri)),
    onDidReceiveMessage: vi.fn(
      (handler: MessageHandler, _thisArg?: unknown, disposables?: Array<{ dispose: () => void }>) => {
        messageHandler = handler;
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

  return { panel, webview, getMessageHandler: () => messageHandler };
}

describe("webview panel public flows", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    GanttPanel.currentPanel = undefined;
    TimeSheetPanel.currentPanel = undefined;

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
    (vscode as unknown as { ViewColumn: { One: number } }).ViewColumn = { One: 1 };
    (vscode.window as unknown as { createWebviewPanel: ReturnType<typeof vi.fn> }).createWebviewPanel = vi.fn();
  });

  it("restores gantt panel and emits deferred render on webviewReady", () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");

    GanttPanel.restore(mock.panel, extensionUri, () => undefined);

    expect(mock.webview.html).toContain("ganttRoot");
    expect(mock.webview.postMessage).not.toHaveBeenCalled();

    const handler = mock.getMessageHandler();
    expect(handler).toBeDefined();
    handler?.({ command: "webviewReady" });

    expect(mock.webview.postMessage).toHaveBeenCalledTimes(1);
    expect(mock.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "render",
        payload: expect.objectContaining({
          html: expect.stringContaining("Loading issues"),
        }),
      })
    );
  });

  it("reuses existing gantt panel and dispatches draft mode state", () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");
    const createWebviewPanel = (vscode.window as unknown as { createWebviewPanel: ReturnType<typeof vi.fn> }).createWebviewPanel;
    createWebviewPanel.mockReturnValue(mock.panel);

    GanttPanel.createOrShow(extensionUri, () => undefined);
    GanttPanel.createOrShow(
      extensionUri,
      () => undefined,
      () =>
        ({
          isEnabled: true,
        }) as unknown as import("../../../src/draft-mode/draft-mode-manager").DraftModeManager
    );

    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    expect((mock.panel as unknown as { reveal: ReturnType<typeof vi.fn> }).reveal).toHaveBeenCalledTimes(1);
    expect(mock.webview.postMessage).toHaveBeenCalledWith({
      command: "setDraftModeState",
      enabled: true,
      queueCount: 0,
    });
  });

  it("routes timesheet webviewReady and createOrShow re-open through public flow", async () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");
    const context = {
      globalState: {
        get: vi.fn((_key: string, fallback?: unknown) => fallback),
        update: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as vscode.ExtensionContext;

    const createWebviewPanel = (vscode.window as unknown as { createWebviewPanel: ReturnType<typeof vi.fn> }).createWebviewPanel;
    createWebviewPanel.mockReturnValue(mock.panel);
    const loadWeekSpy = vi
      .spyOn(TimeSheetPanel.prototype as unknown as { _loadWeek: (week: unknown) => Promise<void> }, "_loadWeek")
      .mockResolvedValue(undefined);

    TimeSheetPanel.createOrShow(
      extensionUri,
      context,
      () => undefined,
      () => undefined,
      () => createDraftModeManager(false)
    );

    const handler = mock.getMessageHandler();
    expect(handler).toBeDefined();
    await handler?.({ type: "webviewReady" });
    expect(loadWeekSpy).toHaveBeenCalledTimes(1);

    TimeSheetPanel.createOrShow(
      extensionUri,
      context,
      () => undefined,
      () => undefined,
      () => createDraftModeManager(true)
    );

    expect((mock.panel as unknown as { reveal: ReturnType<typeof vi.fn> }).reveal).toHaveBeenCalledTimes(1);
    expect(mock.webview.postMessage).toHaveBeenCalledWith({
      type: "draftModeChanged",
      isDraftMode: true,
    });
  });

  it("routes gantt webview commands through handlers", async () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");
    const queue = {
      count: 2,
      removeByKey: vi.fn().mockResolvedValue(undefined),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const draftModeManager = {
      isEnabled: true,
      queue,
      onDidChangeEnabled: vi.fn(() => ({ dispose: vi.fn() })),
      onDidQueueChange: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as import("../../../src/draft-mode/draft-mode-manager").DraftModeManager;
    const server = {
      options: { address: "https://redmine.example" },
    } as unknown as import("../../../src/redmine/redmine-server").RedmineServer;
    const executeSpy = vi
      .spyOn(vscode.commands, "executeCommand")
      .mockResolvedValue(undefined);
    const infoSpy = vi.spyOn(vscode.window, "showInformationMessage");
    const statusSpy = vi
      .spyOn(statusBar, "showStatusBarMessage")
      .mockImplementation(() => undefined);
    const toggleAdHocSpy = vi
      .spyOn(adHocTracker, "toggle")
      .mockReturnValue(true);
    const togglePrecedenceSpy = vi
      .spyOn(precedenceTracker, "togglePrecedence")
      .mockResolvedValue(true);

    GanttPanel.initialize({
      get: vi.fn((_: string, fallback?: unknown) => fallback),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as vscode.Memento);
    GanttPanel.restore(mock.panel, extensionUri, () => server, () => draftModeManager);
    const panel = GanttPanel.currentPanel as unknown as Record<string, unknown>;
    panel._projects = [{ id: 9, identifier: "proj-9" }];
    panel._issueById = new Map([[101, { id: 101 }]]);
    panel._updateIssueDates = vi.fn();
    panel._deleteRelation = vi.fn();
    panel._updateRelationDelay = vi.fn();
    panel._createRelation = vi.fn();
    panel._handleUndoRelation = vi.fn();
    panel._handleRedoRelation = vi.fn();
    panel._updateContent = vi.fn();
    panel._collapseState = {
      collapse: vi.fn(),
      expand: vi.fn(),
      toggle: vi.fn(),
      expandAll: vi.fn(),
      collapseAll: vi.fn(),
    };

    const handler = mock.getMessageHandler();
    expect(handler).toBeDefined();
    handler?.({ command: "openIssue", issueId: 7 });
    handler?.({ command: "updateDates", issueId: 7, startDate: "2026-02-01", dueDate: "2026-02-02" });
    handler?.({ command: "removeDraft", issueId: 101, startDate: "2026-01-01", dueDate: "2026-01-05" });
    handler?.({ command: "setZoom", zoomLevel: "week" });
    handler?.({ command: "setLookback", years: "5" });
    handler?.({ command: "setViewMode", viewMode: "mywork" });
    handler?.({ command: "setViewFocus", focus: "person" });
    handler?.({ command: "setSelectedProject", projectId: 9 });
    handler?.({ command: "setSelectedAssignee", assignee: "Me" });
    handler?.({ command: "deleteRelation", relationId: 5 });
    handler?.({ command: "updateRelationDelay", relationId: 5, fromId: "1", toId: "2" });
    handler?.({ command: "createRelation", issueId: 1, targetIssueId: 2, relationType: "blocks", delay: 1 });
    handler?.({ command: "toggleDependencies" });
    handler?.({ command: "toggleBadges" });
    handler?.({ command: "toggleCapacityRibbon" });
    handler?.({ command: "toggleIntensity" });
    handler?.({ command: "refresh" });
    handler?.({ command: "openDraftReview" });
    handler?.({ command: "toggleDraftMode" });
    handler?.({ command: "toggleCollapse", collapseKey: "issue-1", action: "collapse" });
    handler?.({ command: "expandAll", keys: ["issue-1"] });
    handler?.({ command: "collapseAll" });
    handler?.({ command: "collapseStateSync", collapseKey: "issue-1", isExpanded: true });
    handler?.({ command: "requestRerender" });
    handler?.({ command: "scrollPosition", left: 10, top: 20 });
    handler?.({ command: "undoRelation", operation: "delete", relationId: 1 });
    handler?.({ command: "redoRelation", operation: "create", issueId: 1, targetIssueId: 2, relationType: "blocks" });
    handler?.({ command: "openInBrowser", issueId: 7 });
    handler?.({ command: "openProjectInBrowser", projectId: 9 });
    handler?.({ command: "showInIssues", issueId: 7 });
    handler?.({ command: "logTime", issueId: 7 });
    handler?.({ command: "setDoneRatio", issueId: 7, value: 50 });
    handler?.({ command: "bulkSetDoneRatio", issueIds: [1, 2] });
    handler?.({ command: "copyUrl", issueId: 7 });
    handler?.({ command: "showStatus", message: "ok" });
    handler?.({ command: "todayOutOfRange" });
    handler?.({ command: "setInternalEstimate", issueId: 7 });
    handler?.({ command: "toggleAutoUpdate", issueId: 7 });
    handler?.({ command: "toggleAdHoc", issueId: 7 });
    handler?.({ command: "togglePrecedence", issueId: 7 });
    handler?.({ command: "setFilter", filter: { assignee: "me", status: "open" } });
    handler?.({ command: "setSelectedKey", collapseKey: "issue-1" });
    handler?.({ command: "setSort", sortBy: "id", sortOrder: "asc" });

    await Promise.resolve();

    expect(executeSpy).toHaveBeenCalled();
    expect((panel._updateIssueDates as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((panel._deleteRelation as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(5);
    expect((panel._createRelation as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((panel._handleUndoRelation as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((panel._handleRedoRelation as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((panel._updateContent as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(toggleAdHocSpy).toHaveBeenCalledWith(7);
    expect(togglePrecedenceSpy).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      "Today is outside the current timeline range",
      { modal: true }
    );
    expect(statusSpy).toHaveBeenCalled();
  });

  it("routes timesheet webview commands through handlers", async () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");
    const context = {
      globalState: {
        get: vi.fn((_key: string, fallback?: unknown) => fallback),
        update: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as vscode.ExtensionContext;
    const executeSpy = vi
      .spyOn(vscode.commands, "executeCommand")
      .mockResolvedValue(undefined);

    TimeSheetPanel.restore(
      mock.panel,
      extensionUri,
      context,
      () => undefined,
      () => undefined,
      () => createDraftModeManager(false)
    );
    const panel = TimeSheetPanel.currentPanel as unknown as Record<string, unknown>;
    panel._currentWeek = {
      startDate: "2026-02-02",
      endDate: "2026-02-08",
      weekNumber: 6,
      year: 2026,
      dayDates: [
        "2026-02-02",
        "2026-02-03",
        "2026-02-04",
        "2026-02-05",
        "2026-02-06",
        "2026-02-07",
        "2026-02-08",
      ],
    };
    panel._loadWeek = vi.fn().mockResolvedValue(undefined);
    panel._navigateWeek = vi.fn().mockResolvedValue(undefined);
    panel._addRow = vi.fn().mockResolvedValue(undefined);
    panel._deleteRow = vi.fn().mockResolvedValue(undefined);
    panel._restoreRow = vi.fn();
    panel._duplicateRow = vi.fn().mockResolvedValue(undefined);
    panel._updateCell = vi.fn().mockResolvedValue(undefined);
    panel._updateRowField = vi.fn().mockResolvedValue(undefined);
    panel._sendChildProjects = vi.fn();
    panel._loadIssuesForProject = vi.fn().mockResolvedValue(undefined);
    panel._loadActivitiesForProject = vi.fn().mockResolvedValue(undefined);
    panel._saveAll = vi.fn().mockResolvedValue(undefined);
    panel._pickIssueForRow = vi.fn().mockResolvedValue(undefined);
    panel._postRenderMessage = vi.fn();
    panel._copyWeek = vi.fn().mockResolvedValue(undefined);
    panel._pasteWeek = vi.fn().mockResolvedValue(undefined);
    panel._loadIssueDetails = vi.fn().mockResolvedValue(undefined);
    panel._updateAggregatedCell = vi.fn().mockResolvedValue(undefined);
    panel._updateAggregatedField = vi.fn().mockResolvedValue(undefined);
    panel._restoreAggregatedEntries = vi.fn().mockResolvedValue(undefined);
    panel._updateExpandedEntry = vi.fn().mockResolvedValue(undefined);
    panel._deleteExpandedEntry = vi.fn().mockResolvedValue(undefined);
    panel._mergeEntries = vi.fn().mockResolvedValue(undefined);
    panel._undoPaste = vi.fn().mockResolvedValue(undefined);

    const handler = mock.getMessageHandler();
    expect(handler).toBeDefined();
    await handler?.({ type: "webviewReady" });
    await handler?.({ type: "navigateWeek", direction: 1 });
    await handler?.({ type: "addRow" });
    await handler?.({ type: "deleteRow", rowId: "r1" });
    await handler?.({ type: "restoreRow", row: { id: "r1" } });
    await handler?.({ type: "duplicateRow", rowId: "r1" });
    await handler?.({ type: "updateCell", rowId: "r1", dayIndex: 0, hours: 1 });
    await handler?.({ type: "updateRowField", rowId: "r1", field: "comments", value: "note" });
    await handler?.({ type: "requestChildProjects", parentId: -1 });
    await handler?.({ type: "requestIssues", rowId: "r1", projectId: 1 });
    await handler?.({ type: "requestActivities", rowId: "r1", projectId: 1 });
    await handler?.({ type: "saveAll" });
    await handler?.({ type: "pickIssue", rowId: "r1" });
    await handler?.({ type: "sortChanged", sortColumn: "project", sortDirection: "asc" });
    await handler?.({ type: "setGroupBy", groupBy: "project" });
    await handler?.({ type: "setAggregateRows", aggregateRows: true });
    await handler?.({ type: "toggleGroup", groupKey: "g1" });
    await handler?.({ type: "copyWeek" });
    await handler?.({ type: "pasteWeek" });
    await handler?.({ type: "enableDraftMode" });
    await handler?.({ type: "requestIssueDetails", issueId: 1 });
    await handler?.({ type: "updateAggregatedCell", aggRowId: "agg-1", dayIndex: 0, hours: 2 });
    await handler?.({ type: "updateAggregatedField", aggRowId: "agg-1", field: "comments", value: "v" });
    await handler?.({ type: "restoreAggregatedEntries", entries: [], aggRowId: "agg-1", dayIndex: 0 });
    await handler?.({ type: "updateExpandedEntry", rowId: "r1", sourceRowId: "s1", dayIndex: 0, hours: 3 });
    await handler?.({ type: "deleteExpandedEntry", rowId: "r1", sourceRowId: "s1", dayIndex: 0 });
    await handler?.({
      type: "mergeEntries",
      aggRowId: "agg-1",
      dayIndex: 0,
      sourceEntries: [],
    });
    await handler?.({ type: "undoPaste", draftIds: ["d1"] });

    expect((panel._loadWeek as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((panel._navigateWeek as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(1, undefined);
    expect((panel._addRow as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((panel._deleteRow as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("r1");
    expect((panel._saveAll as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledWith("redmyne.toggleDraftMode");
  });
});
