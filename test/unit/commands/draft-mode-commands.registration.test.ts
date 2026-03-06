import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerDraftModeCommands } from "../../../src/commands/draft-mode-commands";
import { DRAFT_COMMAND_SOURCE } from "../../../src/draft-mode/draft-change-sources";

type Handler = (...args: unknown[]) => unknown;

describe("registerDraftModeCommands", () => {
  let handlers: Map<string, Handler>;
  let queue: {
    count: number;
    getAll: ReturnType<typeof vi.fn>;
    onDidChange: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    removeMany: ReturnType<typeof vi.fn>;
  };
  let manager: {
    isEnabled: boolean;
    toggle: ReturnType<typeof vi.fn>;
    onDidChangeEnabled: ReturnType<typeof vi.fn>;
  };
  let refreshTrees: ReturnType<typeof vi.fn>;
  let showReviewPanel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map<string, Handler>();
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined);
    vi.mocked(vscode.window.withProgress).mockImplementation(
      (_options, task) =>
        task(
          { report: vi.fn() } as unknown as vscode.Progress<{ message?: string; increment?: number }>,
          {} as never
        )
    );

    vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
      handlers.set(command as string, callback as Handler);
      return { dispose: vi.fn() } as unknown as vscode.Disposable;
    });

    queue = {
      count: 0,
      getAll: vi.fn(() => []),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      clear: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      removeMany: vi.fn().mockResolvedValue(undefined),
    };
    manager = {
      isEnabled: false,
      toggle: vi.fn().mockResolvedValue(false),
      onDidChangeEnabled: vi.fn(() => ({ dispose: vi.fn() })),
    };
    refreshTrees = vi.fn();
    showReviewPanel = vi.fn();
  });

  function register(options?: { getServer?: () => unknown }) {
    return registerDraftModeCommands({
      queue: queue as never,
      manager: manager as never,
      getServer: (options?.getServer ?? (() => undefined)) as never,
      refreshTrees,
      showReviewPanel,
    });
  }

  it("registers commands and sets initial draft mode contexts", () => {
    manager.isEnabled = true;
    queue.count = 2;

    const disposables = register();

    expect(disposables).toHaveLength(8);
    expect(handlers.has("redmyne.toggleDraftMode")).toBe(true);
    expect(handlers.has("redmyne.reviewDrafts")).toBe(true);
    expect(handlers.has("redmyne.removeDraft")).toBe(true);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "redmyne:draftMode",
      true
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "redmyne:hasDrafts",
      true
    );
  });

  it("toggle command can route to apply-all flow before toggling manager", async () => {
    manager.isEnabled = true;
    queue.count = 2;
    register();

    vi.clearAllMocks();
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Apply All" as never);

    await (handlers.get("redmyne.toggleDraftMode") as () => Promise<void>)();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.applyDrafts");
    expect(manager.toggle).toHaveBeenCalledTimes(1);
  });

  it("review/remove commands call their deps", async () => {
    register();
    vi.clearAllMocks();

    (handlers.get("redmyne.reviewDrafts") as () => void)();
    await (handlers.get("redmyne.removeDraft") as (id: string) => Promise<void>)("draft-1");

    expect(showReviewPanel).toHaveBeenCalledTimes(1);
    expect(queue.remove).toHaveBeenCalledWith("draft-1", DRAFT_COMMAND_SOURCE);
    expect(refreshTrees).toHaveBeenCalledTimes(1);
  });

  it("apply command shows empty-state info when queue has no operations", async () => {
    const server = {};
    queue.getAll.mockReturnValue([]);
    register({ getServer: () => server });

    await (handlers.get("redmyne.applyDrafts") as () => Promise<void>)();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("No drafts to apply");
  });

  it("apply command exits when user does not confirm apply-all", async () => {
    const server = { setIssueStatus: vi.fn() };
    queue.getAll.mockReturnValue([{
      id: "op-1",
      type: "setIssueStatus",
      timestamp: Date.now(),
      issueId: 123,
      description: "Set status",
      resourceKey: "issue:123:status",
      http: { method: "PUT", path: "/issues/123.json", data: { issue: { status_id: 2 } } },
    }]);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Cancel" as never);
    register({ getServer: () => server });

    await (handlers.get("redmyne.applyDrafts") as () => Promise<void>)();

    expect(vscode.window.withProgress).not.toHaveBeenCalled();
    expect(refreshTrees).not.toHaveBeenCalled();
  });

  it("apply command handles failures/skips and can show detail report", async () => {
    const server = {
      setIssueStatus: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("apply failed")),
    };
    queue.getAll.mockReturnValue([
      {
        id: "ok-1",
        type: "setIssueStatus",
        timestamp: Date.now(),
        issueId: 101,
        description: "Set status ok",
        resourceKey: "issue:101:status",
        http: { method: "PUT", path: "/issues/101.json", data: { issue: { status_id: 2 } } },
      },
      {
        id: "fail-2",
        type: "setIssueStatus",
        timestamp: Date.now(),
        issueId: 102,
        description: "Set status fail",
        resourceKey: "issue:102:status",
        http: { method: "PUT", path: "/issues/102.json", data: { issue: { status_id: 3 } } },
      },
      {
        id: "skip-3",
        type: "setIssueStatus",
        timestamp: Date.now(),
        issueId: 103,
        description: "Set status skipped",
        resourceKey: "issue:103:status",
        http: { method: "PUT", path: "/issues/103.json", data: { issue: { status_id: 4 } } },
      },
    ]);
    vi.mocked(vscode.window.showWarningMessage)
      .mockResolvedValueOnce("Apply All" as never)
      .mockResolvedValueOnce("Show Details" as never);
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValue("Stop" as never);

    register({ getServer: () => server });

    await (handlers.get("redmyne.applyDrafts") as () => Promise<void>)();

    expect(queue.removeMany).toHaveBeenCalledWith(["ok-1"], DRAFT_COMMAND_SOURCE);
    expect(refreshTrees).toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("Drafts: 1 applied, 1 failed, 1 skipped"),
      "Show Details"
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("Failed operations:"),
      { modal: true }
    );
  });

  it("apply command reports full-success path", async () => {
    const server = { setIssueStatus: vi.fn().mockResolvedValue(undefined) };
    queue.getAll.mockReturnValue([
      {
        id: "ok-1",
        type: "setIssueStatus",
        timestamp: Date.now(),
        issueId: 321,
        description: "Set status ok",
        resourceKey: "issue:321:status",
        http: { method: "PUT", path: "/issues/321.json", data: { issue: { status_id: 2 } } },
      },
    ]);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Apply All" as never);
    register({ getServer: () => server });

    await (handlers.get("redmyne.applyDrafts") as () => Promise<void>)();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Successfully applied 1 draft");
  });

  it("discard command handles empty and confirmed discard flows", async () => {
    register();

    queue.count = 0;
    await (handlers.get("redmyne.discardDrafts") as () => Promise<void>)();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("No drafts to discard");

    queue.count = 2;
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Discard All" as never);
    await (handlers.get("redmyne.discardDrafts") as () => Promise<void>)();
    expect(queue.clear).toHaveBeenCalledWith(DRAFT_COMMAND_SOURCE);
    expect(refreshTrees).toHaveBeenCalled();
  });

  it("applySingleDraft handles missing, success, and failure", async () => {
    const server = {
      setIssueStatus: vi.fn().mockResolvedValue(undefined),
    };
    register({ getServer: () => server });

    queue.getAll.mockReturnValue([]);
    await (handlers.get("redmyne.applySingleDraft") as (id: string) => Promise<void>)("missing");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Draft not found");

    queue.getAll.mockReturnValue([{
      id: "op-1",
      type: "setIssueStatus",
      timestamp: Date.now(),
      issueId: 123,
      description: "Set status",
      resourceKey: "issue:123:status",
      http: { method: "PUT", path: "/issues/123.json", data: { issue: { status_id: 2 } } },
    }]);
    await (handlers.get("redmyne.applySingleDraft") as (id: string) => Promise<void>)("op-1");
    expect(queue.remove).toHaveBeenCalledWith("op-1", DRAFT_COMMAND_SOURCE);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Applied: Set status");

    server.setIssueStatus.mockRejectedValueOnce(new Error("boom"));
    await (handlers.get("redmyne.applySingleDraft") as (id: string) => Promise<void>)("op-1");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Failed to apply: Set status")
    );
  });

  it("applySingleDraft executes all operation types and validation error branches", async () => {
    const server = {
      setIssueStatus: vi.fn().mockResolvedValue(undefined),
      updateIssueDates: vi.fn().mockResolvedValue(undefined),
      updateDoneRatio: vi.fn().mockResolvedValue(undefined),
      setIssuePriority: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      createIssue: vi.fn().mockResolvedValue(undefined),
      addTimeEntry: vi.fn().mockResolvedValue(undefined),
      updateTimeEntry: vi.fn().mockResolvedValue(undefined),
      deleteTimeEntry: vi.fn().mockResolvedValue(undefined),
      createVersion: vi.fn().mockResolvedValue(undefined),
      updateVersion: vi.fn().mockResolvedValue(undefined),
      deleteVersion: vi.fn().mockResolvedValue(undefined),
      createRelation: vi.fn().mockResolvedValue(undefined),
      deleteRelation: vi.fn().mockResolvedValue(undefined),
    };
    register({ getServer: () => server });

    queue.getAll.mockReturnValue([
      { id: "s1", type: "setIssueDates", timestamp: 1, issueId: 1, description: "dates", resourceKey: "k1", http: { method: "PUT", path: "/issues/1.json", data: { issue: { start_date: "2026-01-01" } } } },
      { id: "s2", type: "setIssueDoneRatio", timestamp: 1, issueId: 1, description: "ratio", resourceKey: "k2", http: { method: "PUT", path: "/issues/1.json", data: { issue: { done_ratio: 50 } } } },
      { id: "s3", type: "setIssuePriority", timestamp: 1, issueId: 1, description: "priority", resourceKey: "k3", http: { method: "PUT", path: "/issues/1.json", data: { issue: { priority_id: 4 } } } },
      { id: "s4", type: "setIssueAssignee", timestamp: 1, issueId: 1, description: "assignee", resourceKey: "k4", http: { method: "PUT", path: "/issues/1.json", data: { issue: { assigned_to_id: 9 } } } },
      { id: "s5", type: "addIssueNote", timestamp: 1, issueId: 1, description: "note", resourceKey: "k5", http: { method: "PUT", path: "/issues/1.json", data: { issue: { notes: "hello" } } } },
      { id: "s6", type: "createIssue", timestamp: 1, description: "create issue", resourceKey: "k6", http: { method: "POST", path: "/issues.json", data: { issue: { subject: "S", project_id: 1 } } } },
      { id: "s7", type: "createTimeEntry", timestamp: 1, description: "create time", resourceKey: "k7", http: { method: "POST", path: "/time_entries.json", data: { time_entry: { issue_id: 1, activity_id: 2, hours: "1", comments: "c" } } } },
      { id: "s8", type: "updateTimeEntry", timestamp: 1, resourceId: 21, description: "update time", resourceKey: "k8", http: { method: "PUT", path: "/time_entries/21.json", data: { time_entry: { hours: "2" } } } },
      { id: "s9", type: "deleteTimeEntry", timestamp: 1, resourceId: 22, description: "delete time", resourceKey: "k9", http: { method: "DELETE", path: "/time_entries/22.json" } },
      { id: "s10", type: "createVersion", timestamp: 1, description: "create version", resourceKey: "k10", http: { method: "POST", path: "/projects/proj-a/versions.json", data: { version: { name: "v1" } } } },
      { id: "s11", type: "updateVersion", timestamp: 1, resourceId: 31, description: "update version", resourceKey: "k11", http: { method: "PUT", path: "/versions/31.json", data: { version: { name: "v2" } } } },
      { id: "s12", type: "deleteVersion", timestamp: 1, resourceId: 32, description: "delete version", resourceKey: "k12", http: { method: "DELETE", path: "/versions/32.json" } },
      { id: "s13", type: "createRelation", timestamp: 1, description: "create relation", resourceKey: "k13", http: { method: "POST", path: "/issues/1/relations.json", data: { relation: { issue_to_id: 2, relation_type: "blocks" } } } },
      { id: "s14", type: "deleteRelation", timestamp: 1, resourceId: 41, description: "delete relation", resourceKey: "k14", http: { method: "DELETE", path: "/relations/41.json" } },
      { id: "bad-issue", type: "setIssueStatus", timestamp: 1, description: "missing issue", resourceKey: "k15", http: { method: "PUT", path: "/issues/1.json", data: { issue: { status_id: 2 } } } },
      { id: "bad-res", type: "deleteTimeEntry", timestamp: 1, description: "missing resource", resourceKey: "k16", http: { method: "DELETE", path: "/time_entries/x.json" } },
      { id: "bad-version-path", type: "createVersion", timestamp: 1, description: "bad version path", resourceKey: "k17", http: { method: "POST", path: "/versions.json", data: { version: { name: "v3" } } } },
      { id: "bad-rel-path", type: "createRelation", timestamp: 1, description: "bad relation path", resourceKey: "k18", http: { method: "POST", path: "/relations.json", data: { relation: { issue_to_id: 2, relation_type: "blocks" } } } },
      { id: "bad-type", type: "unknownType", timestamp: 1, description: "unknown", resourceKey: "k19", http: { method: "GET", path: "/" } },
    ] as never);

    const applySingle = handlers.get("redmyne.applySingleDraft") as (id: string) => Promise<void>;
    for (const id of [
      "s1","s2","s3","s4","s5","s6","s7","s8","s9","s10","s11","s12","s13","s14",
      "bad-issue","bad-res","bad-version-path","bad-rel-path","bad-type"
    ]) {
      await applySingle(id);
    }

    expect(server.updateIssueDates).toHaveBeenCalled();
    expect(server.updateDoneRatio).toHaveBeenCalled();
    expect(server.setIssuePriority).toHaveBeenCalled();
    expect(server.put).toHaveBeenCalledTimes(2);
    expect(server.createIssue).toHaveBeenCalled();
    expect(server.addTimeEntry).toHaveBeenCalled();
    expect(server.updateTimeEntry).toHaveBeenCalled();
    expect(server.deleteTimeEntry).toHaveBeenCalled();
    expect(server.createVersion).toHaveBeenCalledWith("proj-a", { name: "v1" }, { _bypassDraft: true });
    expect(server.updateVersion).toHaveBeenCalled();
    expect(server.deleteVersion).toHaveBeenCalled();
    expect(server.createRelation).toHaveBeenCalled();
    expect(server.deleteRelation).toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("missing issueId"));
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("missing resourceId"));
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Invalid version path"));
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Invalid relation path"));
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Unknown operation type"));
  });
});
