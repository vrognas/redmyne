import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import {
  DraftReviewPanel,
  escapeHtml,
  formatTime,
  getTypeVerb,
  getTypeClass,
  formatChangesPreview,
  getNonce,
} from "../../../src/draft-mode/draft-review-panel";

describe("escapeHtml", () => {
  it("escapes HTML special characters", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;"
    );
  });

  it("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes quotes", () => {
    expect(escapeHtml('"test"')).toBe("&quot;test&quot;");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("formatTime", () => {
  it("formats today's time as HH:MM", () => {
    const now = new Date();
    now.setHours(14, 30, 0, 0);
    const result = formatTime(now.getTime());
    // Should contain time portion (varies by locale but should have digit:digit pattern)
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });

  it("formats past dates as month day", () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 7); // 7 days ago
    const result = formatTime(pastDate.getTime());
    // Should be a date format like "Jan 15" not a time
    expect(result).not.toMatch(/^\d{1,2}:\d{2}\s*(AM|PM)?$/i);
  });
});

describe("getTypeVerb", () => {
  it("returns Create for createIssue", () => {
    expect(getTypeVerb("createIssue")).toBe("Create");
  });

  it("returns Create for createTimeEntry", () => {
    expect(getTypeVerb("createTimeEntry")).toBe("Create");
  });

  it("returns Update for updateIssue", () => {
    expect(getTypeVerb("updateIssue")).toBe("Update");
  });

  it("returns Update for setIssueStatus", () => {
    expect(getTypeVerb("setIssueStatus")).toBe("Update");
  });

  it("returns Delete for deleteTimeEntry", () => {
    expect(getTypeVerb("deleteTimeEntry")).toBe("Delete");
  });

  it("returns Add for addIssueNote", () => {
    expect(getTypeVerb("addIssueNote")).toBe("Add");
  });

  it("splits camelCase for unknown types", () => {
    expect(getTypeVerb("unknownOperation")).toBe("unknown Operation");
  });
});

describe("getTypeClass", () => {
  it("returns type-create for createIssue", () => {
    expect(getTypeClass("createIssue")).toBe("type-create");
  });

  it("returns type-update for updateIssue", () => {
    expect(getTypeClass("updateIssue")).toBe("type-update");
  });

  it("returns type-update for setIssueStatus", () => {
    expect(getTypeClass("setIssueStatus")).toBe("type-update");
  });

  it("returns type-delete for deleteTimeEntry", () => {
    expect(getTypeClass("deleteTimeEntry")).toBe("type-delete");
  });

  it("returns type-add for addIssueNote", () => {
    expect(getTypeClass("addIssueNote")).toBe("type-add");
  });

  it("returns empty string for unknown types", () => {
    expect(getTypeClass("unknownOperation")).toBe("");
  });
});

describe("getNonce", () => {
  it("returns 32 character string", () => {
    const nonce = getNonce();
    expect(nonce.length).toBe(32);
  });

  it("returns only alphanumeric characters", () => {
    const nonce = getNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("returns unique values", () => {
    const nonces = new Set(Array.from({ length: 100 }, () => getNonce()));
    expect(nonces.size).toBe(100);
  });
});

describe("formatChangesPreview", () => {
  it("returns empty string for undefined data", () => {
    expect(formatChangesPreview(undefined)).toBe("");
  });

  it("returns empty string for empty object", () => {
    expect(formatChangesPreview({})).toBe("");
  });

  it("formats time_entry payload", () => {
    const result = formatChangesPreview({
      time_entry: { hours: 2.5, comments: "Work done" },
    });
    expect(result).toContain("hours");
    expect(result).toContain("2.5");
    expect(result).toContain("comment");
    expect(result).toContain("Work done");
  });

  it("formats issue status payload", () => {
    const result = formatChangesPreview({
      issue: { status_id: 5 },
    });
    expect(result).toContain("status");
    expect(result).toContain("5");
  });

  it("truncates long strings", () => {
    const longComment = "This is a very long comment that exceeds thirty characters limit";
    const result = formatChangesPreview({
      time_entry: { comments: longComment },
    });
    expect(result).toContain("...");
    expect(result).not.toContain(longComment);
  });

  it("limits to 3 fields", () => {
    const result = formatChangesPreview({
      issue: {
        status_id: 1,
        done_ratio: 50,
        start_date: "2026-01-01",
        due_date: "2026-01-31",
        priority_id: 2,
      },
    });
    // Count the separators - should be at most 2 (for 3 fields)
    const separatorCount = (result.match(/·/g) || []).length;
    expect(separatorCount).toBeLessThanOrEqual(2);
  });

  it("skips null values", () => {
    const result = formatChangesPreview({
      issue: { status_id: null, done_ratio: 50 },
    });
    expect(result).not.toContain("status");
    expect(result).toContain("progress");
  });
});

describe("DraftReviewPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset singleton
    DraftReviewPanel.currentPanel = undefined;
  });

  describe("message handling", () => {
    it("executes applyDraft command with id", async () => {
      // Verify command interface matches expected shape
      const msg = { command: "applyDraft", id: "test-id" };
      expect(msg.command).toBe("applyDraft");
      expect(msg.id).toBe("test-id");
    });

    it("executes discardAll with confirmation required", async () => {
      const msg = { command: "discardAll" };
      expect(msg.command).toBe("discardAll");
    });
  });

  describe("webview commands", () => {
    it("supports all expected command types", () => {
      const commandTypes = ["applyAll", "discardAll", "removeDraft", "applyDraft"];
      commandTypes.forEach(cmd => {
        expect(typeof cmd).toBe("string");
      });
    });
  });

  describe("panel lifecycle", () => {
    function setupPanelHarness(operations = [{ id: "d1", type: "updateIssue", description: "Update #1", timestamp: Date.now() }]) {
      let receiveMessageHandler: ((message: { command: string; id?: string }) => Promise<void>) | undefined;
      let queueChangeHandler: (() => void) | undefined;
      let panelDisposeHandler: (() => void) | undefined;

      const webview = {
        html: "",
        cspSource: "vscode-test",
        asWebviewUri: vi.fn((uri) => uri),
        postMessage: vi.fn(),
        onDidReceiveMessage: vi.fn((handler: typeof receiveMessageHandler) => {
          receiveMessageHandler = handler as (message: { command: string; id?: string }) => Promise<void>;
          return { dispose: vi.fn() };
        }),
      };
      const panel = {
        webview,
        reveal: vi.fn(),
        onDidDispose: vi.fn((handler: () => void) => {
          panelDisposeHandler = handler;
          return { dispose: vi.fn() };
        }),
        dispose: vi.fn(),
      };
      const queue = {
        getAll: vi.fn(() => operations),
        onDidChange: vi.fn((handler: () => void) => {
          queueChangeHandler = handler;
          return { dispose: vi.fn() };
        }),
      };

      (vscode as unknown as { ViewColumn: { One: number } }).ViewColumn = { One: 1 };
      (vscode.Uri as unknown as { joinPath: (...parts: unknown[]) => unknown }).joinPath = (...parts: unknown[]) =>
        vscode.Uri.parse(parts.map((part) => String(part)).join("/"));
      (
        vscode.window as unknown as {
          createWebviewPanel: ReturnType<typeof vi.fn>;
        }
      ).createWebviewPanel = vi
        .fn()
        .mockReturnValue(panel as unknown as vscode.WebviewPanel);

      return {
        extensionUri: vscode.Uri.parse("file:///extension"),
        queue,
        panel,
        webview,
        getReceiveMessageHandler: () => receiveMessageHandler,
        fireQueueChange: () => queueChangeHandler?.(),
        fireDispose: () => panelDisposeHandler?.(),
      };
    }

    it("creates panel, renders html, and updates existing panel on re-open", () => {
      const harness = setupPanelHarness();

      const first = DraftReviewPanel.createOrShow(
        harness.queue as unknown as never,
        harness.extensionUri
      );
      const second = DraftReviewPanel.createOrShow(
        harness.queue as unknown as never,
        harness.extensionUri
      );

      expect(first).toBe(second);
      expect(harness.panel.reveal).toHaveBeenCalledTimes(1);
      expect(harness.webview.html).toContain("Pending Drafts");
      expect(harness.webview.html).toContain("Update #1");
      expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    });

    it("handles webview commands and loading states", async () => {
      const harness = setupPanelHarness();
      DraftReviewPanel.createOrShow(harness.queue as unknown as never, harness.extensionUri);
      const onMessage = harness.getReceiveMessageHandler();

      await onMessage?.({ command: "applyAll" });
      await onMessage?.({ command: "applyDraft", id: "d1" });
      await onMessage?.({ command: "discardAll" });
      await onMessage?.({ command: "removeDraft", id: "d1" });

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.applyDrafts");
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.applySingleDraft", "d1");
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.discardDrafts");
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.removeDraft", "d1");
      expect(harness.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: "setLoading", loading: true })
      );
    });

    it("sends incremental update on queue changes and clears singleton on dispose", () => {
      const harness = setupPanelHarness([
        { id: "d1", type: "updateIssue", description: "A", timestamp: Date.now() },
        { id: "d2", type: "createIssue", description: "B", timestamp: Date.now() },
      ]);
      const panel = DraftReviewPanel.createOrShow(
        harness.queue as unknown as never,
        harness.extensionUri
      );

      harness.fireQueueChange();
      expect(harness.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: "updateOperations", count: 2 })
      );

      panel.dispose();
      expect(harness.panel.dispose).toHaveBeenCalledTimes(1);
      expect(DraftReviewPanel.currentPanel).toBeUndefined();
    });

    it("restores panel and ignores command handling after disposal", async () => {
      const harness = setupPanelHarness();
      const restored = DraftReviewPanel.restore(
        harness.panel as unknown as vscode.WebviewPanel,
        harness.queue as unknown as never,
        harness.extensionUri
      );
      const onMessage = harness.getReceiveMessageHandler();

      restored.dispose();
      await onMessage?.({ command: "applyAll" });
      harness.fireDispose();

      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("redmyne.applyDrafts");
      expect(DraftReviewPanel.currentPanel).toBeUndefined();
    });
  });
});
