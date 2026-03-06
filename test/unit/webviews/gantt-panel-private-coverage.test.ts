import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { GanttPanel } from "../../../src/webviews/gantt-panel";
import { adHocTracker } from "../../../src/utilities/adhoc-tracker";
import * as statusBar from "../../../src/utilities/status-bar";
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

function createIssue(overrides: Record<string, unknown> = {}): any {
  const id = (overrides.id as number | undefined) ?? 1;
  const projectId = (overrides.projectId as number | undefined) ?? 10;
  const assigneeId = (overrides.assigneeId as number | undefined) ?? 7;
  const assigneeName = (overrides.assigneeName as string | undefined) ?? "Alice";
  return {
    id,
    project: { id: projectId, name: `Project ${projectId}` },
    tracker: { id: 1, name: "Task" },
    status: { id: 1, name: "New" },
    priority: { id: 1, name: "Normal" },
    author: { id: 1, name: "Author" },
    assigned_to: { id: assigneeId, name: assigneeName },
    subject: `Issue ${id}`,
    description: "",
    start_date: "2025-12-01",
    due_date: "2025-12-10",
    done_ratio: 10,
    is_private: false,
    estimated_hours: 8,
    spent_hours: 2,
    created_on: "2025-12-01T00:00:00Z",
    updated_on: "2025-12-02T00:00:00Z",
    closed_on: null,
    relations: [],
    ...overrides,
  };
}

function createVersion(overrides: Record<string, unknown> = {}): any {
  return {
    id: (overrides.id as number | undefined) ?? 1,
    project: { id: 10, name: "Project 10" },
    name: (overrides.name as string | undefined) ?? "v1",
    description: "",
    status: (overrides.status as string | undefined) ?? "open",
    due_date: (overrides.due_date as string | undefined) ?? "2026-02-10",
    sharing: "none",
    created_on: "2026-01-01T00:00:00Z",
    updated_on: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("gantt panel private coverage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useRealTimers();
    GanttPanel.currentPanel = undefined;

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

  it("covers supplemental loaders and refresh branch gating", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-04T12:00:00Z"));

    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");
    const server = {
      options: { address: "https://redmine.example" },
      getTimeEntriesForIssues: vi.fn().mockResolvedValue([
        {
          issue_id: 2,
          issue: { id: 2 },
          activity_id: 1,
          hours: "2",
          comments: "#1 help",
          spent_on: "2026-02-02",
        },
      ]),
      getUserFteBatch: vi.fn().mockResolvedValue(new Map([[7, 0.5]])),
      getVersionsForProjects: vi.fn().mockResolvedValue(
        new Map([
          [10, [createVersion({ id: 101, name: "v1", due_date: "2026-02-15" }), createVersion({ id: 102, status: "closed" })]],
          [20, [createVersion({ id: 101, name: "v1 duplicate", due_date: "2026-02-15" }), createVersion({ id: 103, due_date: null })]],
        ])
      ),
    };
    const draftModeManager = {
      isEnabled: false,
      queue: {
        count: 0,
        getAll: vi.fn(() => []),
        onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      },
      onDidChangeEnabled: vi.fn(() => ({ dispose: vi.fn() })),
      onDidQueueChange: vi.fn(() => ({ dispose: vi.fn() })),
    };

    GanttPanel.restore(
      mock.panel,
      extensionUri,
      () => server as unknown as import("../../../src/redmine/redmine-server").RedmineServer,
      () => draftModeManager as unknown as import("../../../src/draft-mode/draft-mode-manager").DraftModeManager
    );
    const panel = GanttPanel.currentPanel as any;

    panel._issues = [
      createIssue({ id: 1, assigneeId: 7, assigneeName: "Alice", start_date: "2025-12-01", spent_hours: 3 }),
      createIssue({ id: 2, assigneeId: 8, assigneeName: "Bob", start_date: "2025-11-01", spent_hours: 4 }),
    ];
    panel._supplementalLoadId = 11;
    panel._lookbackYears = null;
    panel._viewFocus = "person";
    panel._selectedAssignee = "Alice";
    panel._currentUserId = 999;
    panel._cachedHierarchy = ["stale"];

    vi.spyOn(adHocTracker, "getAll").mockReturnValue([2]);
    vi.spyOn(adHocTracker, "isAdHoc").mockImplementation((issueId: number) => issueId === 2);

    const contributionsChanged = await panel._loadContributions(11);
    expect(contributionsChanged).toBe(true);
    expect(server.getTimeEntriesForIssues).toHaveBeenCalledWith(
      [2],
      expect.objectContaining({
        from: "2025-12-01",
        to: "2026-02-04",
        userId: 7,
      })
    );
    expect(server.getUserFteBatch).toHaveBeenCalled();
    expect(panel._contributionData).toBeDefined();
    expect(panel._contributionSources).toBeDefined();
    expect(panel._donationTargets).toBeDefined();
    expect(panel._flexibilityCache.has(1)).toBe(true);
    expect(panel._flexibilityCache.has(2)).toBe(true);
    expect(panel._cachedHierarchy).toBeUndefined();
    expect(panel._contributionsLoading).toBe(false);

    panel._contributionsLoading = true;
    expect(await panel._loadContributions(11)).toBe(false);
    panel._contributionsLoading = false;

    panel._projects = [{ id: 10 }, { id: 20 }];
    panel._supplementalLoadId = 12;
    const versionsChanged = await panel._loadVersions(12);
    expect(versionsChanged).toBe(true);
    expect(panel._versions).toHaveLength(1);
    expect(panel._versions[0].id).toBe(101);

    const versionsUnchanged = await panel._loadVersions(12);
    expect(versionsUnchanged).toBe(false);

    panel._supplementalLoadId = 13;
    expect(await panel._loadVersions(12)).toBe(false);

    panel._loadContributions = vi.fn().mockResolvedValue(true);
    panel._loadVersions = vi.fn().mockResolvedValue(false);
    panel._updateContent = vi.fn();
    panel._supplementalLoadId = 0;
    panel._viewFocus = "project";
    await panel._refreshSupplementalData();
    expect(panel._loadContributions).toHaveBeenCalledWith(1);
    expect(panel._loadVersions).toHaveBeenCalledWith(1);
    expect(panel._updateContent).toHaveBeenCalledTimes(1);

    panel._viewFocus = "person";
    panel._loadContributions.mockResolvedValue(false);
    panel._updateContent.mockClear();
    await panel._refreshSupplementalData();
    expect(panel._loadVersions).toHaveBeenCalledTimes(1);
    expect(panel._updateContent).not.toHaveBeenCalled();
  });

  it("covers relation and date mutation flows including undo redo", async () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");
    const server = {
      options: { address: "https://redmine.example" },
      updateIssueDates: vi.fn().mockResolvedValue(undefined),
      deleteRelation: vi.fn().mockResolvedValue(undefined),
      createRelation: vi.fn().mockResolvedValue({ relation: { id: 777 } }),
    };
    const draftModeManager = {
      isEnabled: true,
      queue: {
        count: 3,
        getAll: vi.fn(() => [
          {
            type: "setIssueDates",
            issueId: 1,
            http: { data: { issue: { start_date: "2026-01-01", due_date: "2026-01-05" } } },
          },
          {
            type: "setIssueDates",
            issueId: 3,
            http: { data: { issue: { start_date: "2026-02-01" } } },
          },
        ]),
        onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      },
      onDidChangeEnabled: vi.fn(() => ({ dispose: vi.fn() })),
      onDidQueueChange: vi.fn(() => ({ dispose: vi.fn() })),
    };

    GanttPanel.restore(
      mock.panel,
      extensionUri,
      () => server as unknown as import("../../../src/redmine/redmine-server").RedmineServer,
      () => draftModeManager as unknown as import("../../../src/draft-mode/draft-mode-manager").DraftModeManager
    );
    const panel = GanttPanel.currentPanel as any;

    const issue1 = createIssue({
      id: 1,
      due_date: "2026-01-09",
      relations: [{ id: 55, issue_id: 1, issue_to_id: 2, relation_type: "blocks" }],
    });
    const issue2 = createIssue({ id: 2, assigneeId: 8, assigneeName: "Bob" });
    const depIssue = createIssue({ id: 3, start_date: "2026-01-20", due_date: null });
    panel._issues = [issue1, issue2];
    panel._dependencyIssues = [depIssue];
    panel._issueById = new Map([
      [1, issue1],
      [2, issue2],
    ]);
    panel._updateContent = vi.fn();
    panel._bumpRevision = vi.fn();

    const statusSpy = vi.spyOn(statusBar, "showStatusBarMessage").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(vscode.window, "showErrorMessage");

    panel._addRelationLocally(1, 2, "precedes", 500);
    expect(issue1.relations.some((r: any) => r.id === 500)).toBe(true);
    panel._removeRelationLocally(500);
    expect(issue1.relations.some((r: any) => r.id === 500)).toBe(false);

    panel._applyDraftDateChanges();
    expect(issue1.start_date).toBe("2026-01-01");
    expect(issue1.due_date).toBe("2026-01-05");
    expect(depIssue.start_date).toBe("2026-02-01");

    await panel._updateIssueDates(1, "2026-01-10", "2026-01-11");
    expect(server.updateIssueDates).toHaveBeenCalledWith(1, "2026-01-10", "2026-01-11");
    expect(issue1.start_date).toBe("2026-01-10");
    expect(issue1.due_date).toBe("2026-01-11");
    expect(mock.webview.postMessage).toHaveBeenCalledWith({
      command: "setDraftQueueCount",
      count: 3,
    });
    expect(statusSpy).toHaveBeenCalledWith("$(check) #1 dates queued", 2000);

    server.updateIssueDates.mockRejectedValueOnce(new Error("boom"));
    await panel._updateIssueDates(1, "2026-01-12", "2026-01-13");
    expect(errorSpy).toHaveBeenCalledWith("Failed to update dates: boom");

    await panel._deleteRelation(55);
    expect(server.deleteRelation).toHaveBeenCalledWith(55);
    expect(issue1.relations).toEqual([]);
    expect(mock.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "pushUndoAction",
        action: expect.objectContaining({
          operation: "delete",
          relationId: 55,
          issueId: 1,
          targetIssueId: 2,
        }),
      })
    );

    issue1.relations = [{ id: 66, issue_id: 1, issue_to_id: 2, relation_type: "blocks" }];
    await panel._updateRelationDelay(66, "1", "2");
    expect(errorSpy).toHaveBeenCalledWith("Delay only applies to precedes/follows relations");

    issue1.relations = [{ id: 67, issue_id: 1, issue_to_id: 2, relation_type: "precedes", delay: 1 }];
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue({ label: "Custom...", value: "custom" } as any);
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("3");
    const removeLocalSpy = vi.spyOn(panel, "_removeRelationLocally");
    const addLocalSpy = vi.spyOn(panel, "_addRelationLocally");
    server.createRelation.mockResolvedValueOnce({ relation: { id: 778 } });
    await panel._updateRelationDelay(67, "1", "2");
    expect(server.createRelation).toHaveBeenCalledWith(1, 2, "precedes", 3);
    expect(removeLocalSpy).toHaveBeenCalledWith(67);
    expect(addLocalSpy).toHaveBeenCalledWith(1, 2, "precedes", 778);

    server.createRelation.mockResolvedValueOnce({ relation: { id: 888 } });
    await panel._createRelation(1, 2, "blocks", 1);
    expect(mock.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "pushUndoAction",
        action: expect.objectContaining({
          operation: "create",
          relationId: 888,
          issueId: 1,
          targetIssueId: 2,
          relationType: "blocks",
        }),
      })
    );
    expect(addLocalSpy).toHaveBeenCalledWith(1, 2, "blocks", 888);

    server.createRelation.mockRejectedValueOnce(new Error("already exists"));
    await panel._createRelation(1, 2, "blocks");
    expect(errorSpy).toHaveBeenCalledWith("Cannot create relation: This relation already exists");

    server.createRelation.mockResolvedValueOnce({ relation: { id: 901 } });
    await panel._handleUndoRelation({ operation: "delete", relationId: 901 });
    expect(removeLocalSpy).toHaveBeenCalledWith(901);

    server.createRelation.mockResolvedValueOnce({ relation: { id: 902 } });
    await panel._handleUndoRelation({ operation: "create", issueId: 1, targetIssueId: 2, relationType: "blocks" });
    expect(mock.webview.postMessage).toHaveBeenCalledWith({
      command: "updateRelationId",
      stack: "redo",
      newRelationId: 901,
    });

    server.createRelation.mockResolvedValueOnce({ relation: { id: 903 } });
    await panel._handleRedoRelation({ operation: "create", issueId: 1, targetIssueId: 2, relationType: "blocks" });
    expect(mock.webview.postMessage).toHaveBeenCalledWith({
      command: "updateRelationId",
      stack: "undo",
      newRelationId: 902,
    });

    await panel._handleRedoRelation({ operation: "delete", relationId: 903 });
    expect(removeLocalSpy).toHaveBeenCalledWith(903);

    server.deleteRelation.mockRejectedValueOnce(new Error("redo-fail"));
    await panel._handleRedoRelation({ operation: "delete", relationId: 999 });
    expect(errorSpy).toHaveBeenCalledWith("Failed to redo relation: redo-fail");
  });

  it("covers render payload and tooltip helper branches", () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");
    const server = {
      options: { address: "https://redmine.example" },
    };

    GanttPanel.restore(
      mock.panel,
      extensionUri,
      () => server as unknown as import("../../../src/redmine/redmine-server").RedmineServer
    );
    const panel = GanttPanel.currentPanel as any;

    panel._issues = [];
    const emptyPayload = panel._getRenderPayload();
    expect(emptyPayload.html).toContain("No issues with dates to display");
    expect(emptyPayload.state.timelineWidth).toBe(600);

    const issue = createIssue({
      id: 101,
      subject: "Render me",
      start_date: "2026-02-02",
      due_date: "2026-02-05",
      relations: [{ id: 44, issue_id: 101, issue_to_id: 102, relation_type: "blocks" }],
    });
    panel._issues = [issue];
    panel._issueById = new Map([[101, issue]]);
    panel._dependencyIssues = [];
    panel._projects = [];
    panel._viewFocus = "project";
    panel._currentFilter = { assignee: "any", status: "any" };
    const renderPayload = panel._getRenderPayload();
    expect(renderPayload.html).toContain("ganttTimeline");
    expect(renderPayload.state.totalDays).toBeGreaterThanOrEqual(1);
    expect(renderPayload.state.stickyLeftWidth).toBeGreaterThan(0);

    expect(panel.normalizeTooltipText(" **Hello__ ")).toBe("Hello");
    const customLines = panel.getProjectCustomFieldLines([
      { name: "**Owner**", value: "__Alex__" },
      { name: "Ignored", value: "" },
    ]);
    expect(customLines).toEqual(["cf:Owner: Alex"]);

    const baseTooltip = panel.formatProjectTooltip(" __Desc__ ", customLines);
    expect(baseTooltip).toContain("Desc");
    expect(baseTooltip).toContain("cf:Owner: Alex");

    const healthText = panel.formatHealthTooltip({
      progress: 40,
      counts: { open: 3, closed: 2, overdue: 1, blocked: 1, atRisk: 1 },
      hours: { spent: 6, estimated: 12 },
      status: "yellow",
    });
    expect(healthText).toContain("40% · 2/5 done");
    expect(healthText).toContain("6h / 12h");

    const tooltip = panel.buildProjectTooltip({
      type: "project",
      id: 10,
      label: "Project A",
      depth: 0,
      collapseKey: "project-10",
      parentKey: null,
      hasChildren: true,
      isVisible: true,
      isExpanded: true,
      description: "__Big desc__",
      identifier: "proj-a",
      customFields: [{ name: "**Owner**", value: "__Alex__" }],
      health: {
        progress: 50,
        counts: { open: 1, closed: 1, overdue: 0, blocked: 0, atRisk: 0 },
        hours: { spent: 4, estimated: 8 },
        status: "green",
      },
    });
    expect(tooltip).toContain("#10 Project A");
    expect(tooltip).toContain("cf:Owner: Alex");
    expect(tooltip).toContain("Open in Browser: https://redmine.example/projects/proj-a");
  });

  it("covers public methods plus render queue and update content branches", () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");
    const globalState = {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as vscode.Memento;
    GanttPanel.initialize(globalState);

    GanttPanel.restore(mock.panel, extensionUri, () => undefined);
    const panel = GanttPanel.currentPanel as any;

    const issue = createIssue({ id: 5, done_ratio: 0 });
    panel._issueById = new Map([[5, issue]]);
    panel._updateContent = vi.fn();
    const revisionBefore = panel._dataRevision;

    panel.updateIssueDoneRatio(5, 65);
    expect(issue.done_ratio).toBe(65);
    expect(panel._dataRevision).toBe(revisionBefore + 1);
    expect(panel._updateContent).toHaveBeenCalledTimes(1);

    panel._updateContent.mockClear();
    panel.updateIssueDoneRatio(999, 10);
    expect(panel._updateContent).not.toHaveBeenCalled();

    panel.showProject(77);
    expect(panel._viewFocus).toBe("project");
    expect(panel._selectedProjectId).toBe(77);
    expect(panel._expandAllOnNextRender).toBe(true);
    expect(globalState.update).toHaveBeenCalledWith("redmyne.gantt.viewFocus", "project");
    expect(globalState.update).toHaveBeenCalledWith("redmyne.gantt.selectedProject", 77);
    expect(panel._updateContent).toHaveBeenCalledTimes(1);

    panel.scrollToIssue(88);
    expect(mock.webview.postMessage).toHaveBeenCalledWith({
      command: "scrollToIssue",
      issueId: 88,
    });

    const callback = vi.fn();
    panel.setFilterChangeCallback(callback);
    expect(panel._filterChangeCallback).toBe(callback);

    panel._baseHtmlSet = false;
    panel._webviewReady = true;
    panel._ensureWebviewHtml();
    expect(mock.webview.html).toContain("ganttRoot");
    expect(panel._baseHtmlSet).toBe(true);
    expect(panel._webviewReady).toBe(false);
    const htmlAfterFirstEnsure = mock.webview.html;
    panel._ensureWebviewHtml();
    expect(mock.webview.html).toBe(htmlAfterFirstEnsure);

    const payloadA = { html: "<div>a</div>", state: panel._getFallbackState() };
    panel._disposed = true;
    panel._pendingRender = undefined;
    mock.webview.postMessage.mockClear();
    panel._queueRender(payloadA);
    expect(panel._pendingRender).toBeUndefined();
    expect(mock.webview.postMessage).not.toHaveBeenCalled();

    panel._disposed = false;
    panel._webviewReady = false;
    panel._queueRender(payloadA);
    expect(panel._pendingRender).toBe(payloadA);
    expect(mock.webview.postMessage).not.toHaveBeenCalled();

    const payloadB = { html: "<div>b</div>", state: panel._getFallbackState({ timelineWidth: 900 }) };
    panel._webviewReady = true;
    panel._pendingRender = payloadA;
    panel._queueRender(payloadB);
    expect(panel._pendingRender).toBeUndefined();
    expect(mock.webview.postMessage).toHaveBeenCalledWith({ command: "render", payload: payloadB });

    delete panel._updateContent;
    panel._getRenderPayload = vi.fn(() => payloadB);
    panel._queueRender = vi.fn();
    panel._renderKey = 0;
    panel._isRefreshing = true;
    panel._updateContent();
    expect(panel._renderKey).toBe(1);
    expect(panel._queueRender).toHaveBeenCalledWith(payloadB);
    expect(panel._isRefreshing).toBe(false);
  });

  it("covers loadVersions guard and error branches plus draft date merge/no-op", async () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");
    const server = {
      options: { address: "https://redmine.example" },
      getVersionsForProjects: vi.fn(),
    };

    GanttPanel.restore(
      mock.panel,
      extensionUri,
      () => server as unknown as import("../../../src/redmine/redmine-server").RedmineServer
    );
    const panel = GanttPanel.currentPanel as any;

    panel._supplementalLoadId = 9;
    panel._projects = [];
    expect(await panel._loadVersions(9)).toBe(false);

    panel._projects = [{ id: 10 }];
    panel._versionsLoading = true;
    expect(await panel._loadVersions(9)).toBe(false);
    panel._versionsLoading = false;

    server.getVersionsForProjects.mockRejectedValueOnce(new Error("versions-fail"));
    expect(await panel._loadVersions(9)).toBe(false);
    expect(panel._versionsLoading).toBe(false);

    server.getVersionsForProjects.mockResolvedValueOnce(
      new Map([
        [
          10,
          [
            createVersion({ id: 111, due_date: "2026-03-01" }),
            createVersion({ id: 112, due_date: null }),
            createVersion({ id: 113, status: "closed", due_date: "2026-03-10" }),
          ],
        ],
      ])
    );
    expect(await panel._loadVersions(9)).toBe(true);
    expect(panel._versions.map((v: any) => v.id)).toEqual([111]);

    const issue = createIssue({ id: 1, start_date: "2026-01-01", due_date: "2026-01-02" });
    const depIssue = createIssue({ id: 2, start_date: "2026-01-03", due_date: "2026-01-04" });
    panel._issues = [issue];
    panel._dependencyIssues = [depIssue];

    panel._getDraftModeManagerFn = () => undefined;
    panel._applyDraftDateChanges();
    expect(issue.start_date).toBe("2026-01-01");
    expect(depIssue.due_date).toBe("2026-01-04");

    panel._getDraftModeManagerFn = () =>
      ({
        queue: {
          getAll: () => [{ type: "noop", issueId: 1, http: { data: { issue: { start_date: "2099-01-01" } } } }],
        },
      }) as any;
    panel._applyDraftDateChanges();
    expect(issue.start_date).toBe("2026-01-01");

    panel._getDraftModeManagerFn = () =>
      ({
        queue: {
          getAll: () => [
            { type: "setIssueDates", issueId: 1, http: { data: { issue: { start_date: "2026-04-01" } } } },
            { type: "setIssueDates", issueId: 1, http: { data: { issue: { due_date: "2026-04-05" } } } },
            { type: "setIssueDates", issueId: 2, http: { data: { issue: { due_date: "2026-04-10" } } } },
          ],
        },
      }) as any;
    panel._applyDraftDateChanges();
    expect(issue.start_date).toBe("2026-04-01");
    expect(issue.due_date).toBe("2026-04-05");
    expect(depIssue.due_date).toBe("2026-04-10");
  });

  it("covers extra render payload sort branches and helper edge cases", () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");
    const server = {
      options: { address: "https://redmine.example" },
    };

    GanttPanel.restore(
      mock.panel,
      extensionUri,
      () => server as unknown as import("../../../src/redmine/redmine-server").RedmineServer
    );
    const panel = GanttPanel.currentPanel as any;

    const issueA = createIssue({
      id: 201,
      projectId: 10,
      assigneeId: 7,
      assigneeName: "Zed",
      start_date: "2026-02-01",
      due_date: "2026-02-03",
      status: { id: 2, name: "In Progress" },
      relations: [{ id: 501, issue_id: 201, issue_to_id: 202, relation_type: "blocked" }],
      closed_on: null,
    });
    const issueB = createIssue({
      id: 202,
      projectId: 10,
      assigneeId: 8,
      assigneeName: "Amy",
      start_date: "2026-02-02",
      due_date: "2026-02-04",
      status: { id: 1, name: "New" },
      relations: [{ id: 502, issue_id: 202, issue_to_id: 203, relation_type: "follows" }],
      closed_on: null,
    });
    const issueClosedBlocker = createIssue({
      id: 203,
      projectId: 10,
      assigneeId: 9,
      assigneeName: "Kai",
      start_date: "2026-02-01",
      due_date: "2026-02-02",
      closed_on: "2026-02-02T00:00:00Z",
      relations: [{ id: 503, issue_id: 203, issue_to_id: 201, relation_type: "blocked" }],
    });

    panel._issues = [issueA, issueB, issueClosedBlocker];
    panel._dependencyIssues = [];
    panel._projects = [{ id: 10, name: "Project 10", identifier: "project-10" }];
    panel._issueById = new Map([
      [201, issueA],
      [202, issueB],
      [203, issueClosedBlocker],
    ]);
    panel._viewFocus = "project";
    panel._selectedProjectId = 10;
    panel._currentFilter = { assignee: "any", status: "any" };

    for (const sortBy of ["id", "assignee", "start", "due", "status"]) {
      panel._sortBy = sortBy;
      panel._sortOrder = sortBy === "id" ? "desc" : "asc";
      const payload = panel._getRenderPayload();
      expect(payload.html).toContain("ganttTimeline");
      expect(payload.state.totalDays).toBeGreaterThan(0);
    }

    expect(panel.getHealthDot("red")).toBe("🔴 ");
    expect(panel.getHealthDot("grey")).toBe("⚪ ");
    expect(panel.getProjectCustomFieldLines()).toEqual([]);
    expect(panel.formatProjectTooltip(undefined, undefined)).toBe("");

    const compactHealthText = panel.formatHealthTooltip({
      progress: 0,
      counts: { open: 1, closed: 0, overdue: 0, blocked: 0, atRisk: 0 },
      hours: { spent: 0, estimated: 0 },
      status: "grey",
    });
    expect(compactHealthText).toBe("0% · 0/1 done");

    const blockedIds = panel.extractBlockedIds([issueA, issueB, issueClosedBlocker]);
    expect(blockedIds.has(201)).toBe(true);
    expect(blockedIds.has(202)).toBe(false);
    expect(blockedIds.has(203)).toBe(false);
  });

  it("covers constructor restore from global state and perf-debug render path", () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");
    const globalState = {
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "redmyne.gantt.viewMode") return "mywork";
        if (key === "redmyne.gantt.viewFocus") return "person";
        if (key === "redmyne.gantt.selectedProject") return 10;
        if (key === "redmyne.gantt.selectedAssignee") return "Alice";
        if (key === "redmyne.gantt.filterAssignee") return "me";
        if (key === "redmyne.gantt.filterStatus") return "open";
        if (key === "redmyne.gantt.lookbackYears") return 5;
        return fallback;
      }),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as vscode.Memento;
    GanttPanel.initialize(globalState);

    vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation((section?: string) => {
      if (section === "redmyne.gantt") {
        return {
          get: vi.fn((key: string, fallback?: unknown) => {
            if (key === "perfDebug") return true;
            if (key === "visibleRelationTypes") return ["blocks", "precedes"];
            return fallback;
          }),
          update: vi.fn(),
        } as unknown as vscode.WorkspaceConfiguration;
      }
      if (section === "redmyne") {
        return {
          get: vi.fn((key: string, fallback?: unknown) => {
            if (key === "serverUrl") return "https://redmine.example";
            return fallback;
          }),
          update: vi.fn(),
        } as unknown as vscode.WorkspaceConfiguration;
      }
      return {
        get: vi.fn((_key: string, fallback?: unknown) => fallback),
        update: vi.fn(),
      } as unknown as vscode.WorkspaceConfiguration;
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    GanttPanel.restore(mock.panel, extensionUri, () => ({ options: { address: "https://redmine.example" } }) as any);
    const panel = GanttPanel.currentPanel as any;
    panel._issues = [
      createIssue({
        id: 1,
        projectId: 10,
        assigneeId: 7,
        assigneeName: "Alice",
        start_date: "2026-02-01",
        due_date: "2026-02-05",
      }),
    ];
    panel._dependencyIssues = [];
    panel._projects = [{ id: 10, name: "Project 10", identifier: "project-10" }];
    panel._issueById = new Map([[1, panel._issues[0]]]);
    panel._closedStatusIds = new Set<number>();
    panel._currentUserId = 7;
    panel._currentUserName = "Alice";
    panel._selectedProjectId = 10;
    panel._selectedAssignee = "Alice";
    panel._cachedHierarchy = undefined;
    panel._viewFocus = "person";
    panel._sortBy = null;

    const payload = panel._getRenderPayload();
    expect(payload.html).toContain("ganttTimeline");
    expect(panel._viewMode).toBe("mywork");
    expect(panel._lookbackYears).toBe(5);
    expect(logSpy).toHaveBeenCalled();
  });

  it("covers draft-mode subscription callbacks and queue-source guards", async () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");
    let enabledHandler: (() => void) | undefined;
    let queueHandler: ((source?: string) => void) | undefined;
    const queue = {
      count: 4,
      onDidChange: vi.fn((handler: (source?: string) => void) => {
        queueHandler = handler;
        return { dispose: vi.fn() };
      }),
    };
    const draftModeManager = {
      isEnabled: true,
      queue,
      onDidChangeEnabled: vi.fn((handler: () => void) => {
        enabledHandler = handler;
        return { dispose: vi.fn() };
      }),
    };
    const executeSpy = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);

    GanttPanel.restore(
      mock.panel,
      extensionUri,
      () => ({ options: { address: "https://redmine.example" } }) as any,
      () => draftModeManager as any
    );
    const panel = GanttPanel.currentPanel as any;

    panel._setupDraftModeSubscriptions();
    expect(draftModeManager.onDidChangeEnabled).toHaveBeenCalledTimes(1);

    enabledHandler?.();
    expect(mock.webview.postMessage).toHaveBeenCalledWith({
      command: "setDraftModeState",
      enabled: true,
      queueCount: 4,
    });

    panel._isUpdatingDates = true;
    queueHandler?.("external");
    expect(executeSpy).not.toHaveBeenCalled();

    panel._isUpdatingDates = false;
    queueHandler?.(DRAFT_COMMAND_SOURCE);
    expect(executeSpy).not.toHaveBeenCalled();

    queueHandler?.("external");
    expect(mock.webview.postMessage).toHaveBeenCalledWith({
      command: "setDraftQueueCount",
      count: 4,
    });
    expect(executeSpy).toHaveBeenCalledWith("redmyne.refreshGanttData");
  });

  it("covers updateIssues branches for status/user/time-entry fetch success and failures", async () => {
    const mock = createMockPanel();
    const extensionUri = vscode.Uri.parse("file:///ext");
    const server = {
      options: { address: "https://redmine.example" },
      getIssueStatuses: vi.fn().mockResolvedValue({
        issue_statuses: [
          { id: 1, is_closed: false },
          { id: 5, is_closed: true },
        ],
      }),
      getCurrentUser: vi.fn().mockResolvedValue({ id: 7 }),
      getTimeEntries: vi.fn().mockResolvedValue({
        time_entries: [
          {
            issue: { id: 900 },
            spent_on: "2026-02-03",
            hours: "1.5",
            comments: "#100 supporting work",
          },
        ],
      }),
    };
    vi.spyOn(adHocTracker, "isAdHoc").mockImplementation((issueId: number) => issueId === 900);

    GanttPanel.restore(
      mock.panel,
      extensionUri,
      () => server as unknown as import("../../../src/redmine/redmine-server").RedmineServer
    );
    const panel = GanttPanel.currentPanel as any;
    panel._viewFocus = "person";
    panel._lookbackYears = 2;
    panel._refreshSupplementalData = vi.fn().mockResolvedValue(undefined);

    const issues = [
      createIssue({ id: 100, projectId: 10, assigneeId: 7, assigneeName: "Alice", start_date: "2026-02-01", due_date: "2026-02-04" }),
      createIssue({ id: 900, projectId: 10, assigneeId: 7, assigneeName: "Alice", start_date: "2026-02-01", due_date: "2026-02-04" }),
      createIssue({ id: 999, projectId: 10, start_date: null, due_date: null }),
    ];
    const dependencies = [
      createIssue({ id: 200, projectId: 10, assigneeId: 8, assigneeName: "Bob", start_date: "2026-02-01", due_date: "2026-02-06" }),
    ];

    await panel.updateIssues(issues, new Map(), [{ id: 10, name: "Project 10", identifier: "project-10" }], undefined, undefined, dependencies);
    expect(server.getIssueStatuses).toHaveBeenCalledTimes(1);
    expect(server.getCurrentUser).toHaveBeenCalledTimes(1);
    expect(server.getTimeEntries).toHaveBeenCalledTimes(1);
    expect(panel._actualTimeEntries.get(100)?.get("2026-02-03")).toBe(1.5);
    expect(panel._refreshSupplementalData).toHaveBeenCalledTimes(1);

    panel._closedStatusIds = new Set<number>();
    panel._currentUserId = null;
    server.getIssueStatuses.mockRejectedValueOnce(new Error("status-fail"));
    server.getCurrentUser.mockRejectedValueOnce(new Error("user-fail"));
    server.getTimeEntries.mockRejectedValueOnce(new Error("time-fail"));
    await panel.updateIssues(issues, new Map(), [{ id: 10, name: "Project 10", identifier: "project-10" }]);
    expect(panel._actualTimeEntries).toBeInstanceOf(Map);
  });
});
