import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import openActionsForIssue from "../../../src/commands/open-actions-for-issue";
import openActionsForIssueUnderCursor from "../../../src/commands/open-actions-for-issue-under-cursor";
import openActionsForIssueId from "../../../src/commands/commons/open-actions-for-issue-id";
import newIssue from "../../../src/commands/new-issue";
import { registerTimeSheetCommands } from "../../../src/commands/timesheet-commands";
import { TimeSheetPanel } from "../../../src/webviews/timesheet-panel";
import { IssueController } from "../../../src/controllers/issue-controller";
import * as openActionsForIssueIdModule from "../../../src/commands/commons/open-actions-for-issue-id";

describe("open-actions + timesheet commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe("openActionsForIssue", () => {
    it("uses provided issue id without prompting", async () => {
      const server = {} as never;
      const openSpy = vi
        .spyOn(openActionsForIssueIdModule, "default")
        .mockResolvedValue(undefined);
      const inputSpy = vi.spyOn(vscode.window, "showInputBox");

      await openActionsForIssue({ server, config: {} }, "123");

      expect(inputSpy).not.toHaveBeenCalled();
      expect(openSpy).toHaveBeenCalledWith(server, "123");
    });

    it("prompts for issue id when none provided", async () => {
      const server = {} as never;
      vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("456");
      const openSpy = vi
        .spyOn(openActionsForIssueIdModule, "default")
        .mockResolvedValue(undefined);

      await openActionsForIssue({ server, config: {} });

      expect(openSpy).toHaveBeenCalledWith(server, "456");
    });
  });

  describe("openActionsForIssueUnderCursor", () => {
    it("extracts numeric id from selected text", async () => {
      const server = {} as never;
      const openSpy = vi
        .spyOn(openActionsForIssueIdModule, "default")
        .mockResolvedValue(undefined);
      (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
        selection: { isEmpty: false },
        document: {
          getText: () => "#789:",
        },
      };

      await openActionsForIssueUnderCursor({ server, config: {} });

      expect(openSpy).toHaveBeenCalledWith(server, "789");
    });

    it("shows error and passes null when selection is not an issue id", async () => {
      const server = {} as never;
      const openSpy = vi
        .spyOn(openActionsForIssueIdModule, "default")
        .mockResolvedValue(undefined);
      const errSpy = vi.spyOn(vscode.window, "showErrorMessage");
      (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
        selection: { isEmpty: false },
        document: {
          getText: () => "not-an-id",
        },
      };

      await openActionsForIssueUnderCursor({ server, config: {} });

      expect(errSpy).toHaveBeenCalledWith("No issue selected");
      expect(openSpy).toHaveBeenCalledWith(server, null);
    });

    it("passes null when no active editor", async () => {
      const server = {} as never;
      const openSpy = vi
        .spyOn(openActionsForIssueIdModule, "default")
        .mockResolvedValue(undefined);
      (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = undefined;

      await openActionsForIssueUnderCursor({ server, config: {} });

      expect(openSpy).toHaveBeenCalledWith(server, null);
    });

    it("reads word at cursor when selection is empty", async () => {
      const server = {} as never;
      const openSpy = vi
        .spyOn(openActionsForIssueIdModule, "default")
        .mockResolvedValue(undefined);
      (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
        selection: { isEmpty: true, active: { line: 0, character: 3 } },
        document: {
          getWordRangeAtPosition: () => ({
            start: { line: 0, character: 1 },
            end: { line: 0, character: 5 },
          }),
          getText: () => "#321",
        },
      };

      await openActionsForIssueUnderCursor({ server, config: {} });

      expect(openSpy).toHaveBeenCalledWith(server, "321");
    });
  });

  describe("openActionsForIssueId", () => {
    it("returns early for invalid issue id", async () => {
      const server = {
        getIssueById: vi.fn(),
        options: { url: { hostname: "example.test" } },
      } as unknown as {
        getIssueById: ReturnType<typeof vi.fn>;
        options: { url: { hostname: string } };
      };

      await openActionsForIssueId(server as never, "abc");

      expect(server.getIssueById).not.toHaveBeenCalled();
    });

    it("loads issue and lists actions when found", async () => {
      const server = {
        getIssueById: vi.fn().mockResolvedValue({
          issue: {
            id: 42,
            subject: "Issue 42",
          },
        }),
        options: { url: { hostname: "example.test" } },
      } as never;
      const listSpy = vi
        .spyOn(IssueController.prototype, "listActions")
        .mockImplementation(() => undefined);

      await openActionsForIssueId(server, "42");

      expect(listSpy).toHaveBeenCalled();
    });

    it("handles missing issue and request failure", async () => {
      const missingServer = {
        getIssueById: vi.fn().mockResolvedValue(null),
        options: { url: { hostname: "example.test" } },
      } as never;
      const failingServer = {
        getIssueById: vi.fn().mockRejectedValue(new Error("boom")),
        options: { url: { hostname: "example.test" } },
      } as never;
      const listSpy = vi
        .spyOn(IssueController.prototype, "listActions")
        .mockImplementation(() => undefined);
      const errSpy = vi.spyOn(vscode.window, "showErrorMessage");

      await openActionsForIssueId(missingServer, "42");
      await openActionsForIssueId(failingServer, "42");

      expect(listSpy).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith("boom");
    });
  });

  describe("newIssue", () => {
    it("opens default project directly", async () => {
      const executeSpy = vi
        .spyOn(vscode.commands, "executeCommand")
        .mockResolvedValue(undefined);
      const showQuickPickSpy = vi.spyOn(vscode.window, "showQuickPick");
      const server = {
        options: {
          address: "https://redmine.example",
          url: { hostname: "redmine.example" },
        },
      };

      await newIssue({
        server: server as never,
        config: { defaultProject: "alpha" },
      });

      expect(showQuickPickSpy).not.toHaveBeenCalled();
      expect(executeSpy).toHaveBeenCalledWith(
        "vscode.open",
        expect.objectContaining({
          toString: expect.any(Function),
        })
      );
      const openArg = (executeSpy.mock.calls[0] ?? [])[1] as { toString: () => string };
      expect(openArg.toString()).toBe("https://redmine.example/projects/alpha/issues/new");
    });

    it("lets user choose project and supports cancel", async () => {
      const executeSpy = vi
        .spyOn(vscode.commands, "executeCommand")
        .mockResolvedValue(undefined);
      const showQuickPickSpy = vi
        .spyOn(vscode.window, "showQuickPick")
        .mockResolvedValueOnce({ identifier: "beta" } as never)
        .mockResolvedValueOnce(undefined);
      const server = {
        getProjects: vi.fn().mockResolvedValue([
          {
            toQuickPickItem: () => ({
              label: "Beta",
              identifier: "beta",
            }),
          },
        ]),
        options: {
          address: "https://redmine.example",
          url: { hostname: "redmine.example" },
        },
      };

      await newIssue({ server: server as never, config: {} });
      await newIssue({ server: server as never, config: {} });

      expect(server.getProjects).toHaveBeenCalledTimes(2);
      expect(showQuickPickSpy).toHaveBeenCalledTimes(2);
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it("surfaces project load and open failures", async () => {
      const errSpy = vi.spyOn(vscode.window, "showErrorMessage");
      const failingServer = {
        getProjects: vi.fn().mockRejectedValue(new Error("load failed")),
        options: {
          address: "https://redmine.example",
          url: { hostname: "redmine.example" },
        },
      };
      const openFailServer = {
        getProjects: vi.fn().mockResolvedValue([
          {
            toQuickPickItem: () => ({
              label: "Gamma",
              identifier: "gamma",
            }),
          },
        ]),
        options: {
          address: "https://redmine.example",
          url: { hostname: "redmine.example" },
        },
      };
      vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue({
        identifier: "gamma",
      } as never);
      vi.spyOn(vscode.commands, "executeCommand").mockRejectedValue("open failed");

      await newIssue({ server: failingServer as never, config: {} });
      await newIssue({ server: openFailServer as never, config: {} });
      await Promise.resolve();

      expect(errSpy).toHaveBeenCalledWith("load failed");
      expect(errSpy).toHaveBeenCalledWith("open failed");
    });
  });

  describe("registerTimeSheetCommands", () => {
    it("registers commands and serializer and wires callbacks", async () => {
      const context = {
        extensionUri: { path: "/tmp/ext" },
      } as never;
      const deps = {
        getServer: vi.fn(),
        getDraftQueue: vi.fn(),
        getDraftModeManager: vi.fn(),
        getCachedIssues: vi.fn().mockReturnValue([]),
      };

      const registered: Record<string, () => unknown> = {};
      const disposable = { dispose: vi.fn() };
      vi.spyOn(vscode.commands, "registerCommand").mockImplementation(
        (name: string, callback: () => unknown) => {
          registered[name] = callback;
          return disposable as never;
        }
      );
      const serializerMock = vi.fn();
      (
        vscode.window as unknown as {
          registerWebviewPanelSerializer: ReturnType<typeof vi.fn>;
        }
      ).registerWebviewPanelSerializer = serializerMock;
      const createSpy = vi
        .spyOn(TimeSheetPanel, "createOrShow")
        .mockReturnValue({} as never);
      const refreshSpy = vi
        .spyOn(TimeSheetPanel, "refresh")
        .mockImplementation(() => undefined);
      const restoreSpy = vi
        .spyOn(TimeSheetPanel, "restore")
        .mockReturnValue({} as never);

      const disposables = registerTimeSheetCommands(context, deps);

      expect(disposables).toHaveLength(2);
      expect(Object.keys(registered).sort()).toEqual([
        "redmyne.refreshTimesheet",
        "redmyne.showTimeSheet",
      ]);
      expect(serializerMock).toHaveBeenCalledWith(
        "redmyneTimeSheet",
        expect.objectContaining({
          deserializeWebviewPanel: expect.any(Function),
        })
      );

      registered["redmyne.showTimeSheet"]();
      registered["redmyne.refreshTimesheet"]();
      expect(createSpy).toHaveBeenCalled();
      expect(refreshSpy).toHaveBeenCalled();

      const serializerArg = serializerMock.mock.calls[0][1] as {
        deserializeWebviewPanel: (panel: unknown) => Promise<void>;
      };
      await serializerArg.deserializeWebviewPanel({ id: "panel" });
      expect(restoreSpy).toHaveBeenCalled();
    });
  });
});
