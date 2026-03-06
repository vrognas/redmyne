import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerNavigationClipboardCommands } from "../../../src/commands/navigation-clipboard-commands";

type RegisteredHandler = (...args: unknown[]) => unknown;

describe("registerNavigationClipboardCommands", () => {
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

  it("registers navigation and clipboard commands", () => {
    const disposables = registerNavigationClipboardCommands();

    expect(disposables).toHaveLength(5);
    expect(Array.from(handlers.keys())).toEqual(
      expect.arrayContaining([
        "redmyne.openIssueInBrowser",
        "redmyne.copyIssueUrl",
        "redmyne.copyIssueId",
        "redmyne.copyProjectId",
        "redmyne.copyProjectUrl",
      ])
    );
  });

  it("opens issue URL in browser when issue and server URL exist", async () => {
    setServerUrl("https://redmine.example.test");
    registerNavigationClipboardCommands();

    await handlers.get("redmyne.openIssueInBrowser")?.({ id: 42 });

    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
    const [uri] = vi.mocked(vscode.env.openExternal).mock.calls[0];
    expect((uri as { toString(): string }).toString()).toBe(
      "https://redmine.example.test/issues/42"
    );
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it("copies issue URL to clipboard", async () => {
    setServerUrl("https://redmine.example.test");
    registerNavigationClipboardCommands();

    await handlers.get("redmyne.copyIssueUrl")?.({ id: 77 });

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
      "https://redmine.example.test/issues/77"
    );
  });

  it("shows error when issue context is missing", async () => {
    setServerUrl("https://redmine.example.test");
    registerNavigationClipboardCommands();

    await handlers.get("redmyne.openIssueInBrowser")?.(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Could not determine issue ID"
    );
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });

  it("shows error when server URL is missing", async () => {
    setServerUrl(undefined);
    registerNavigationClipboardCommands();

    await handlers.get("redmyne.copyProjectUrl")?.({ id: 1, identifier: "ops" });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "No Redmine URL configured"
    );
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("copies issue and project ids to clipboard", async () => {
    setServerUrl("https://redmine.example.test");
    registerNavigationClipboardCommands();

    await handlers.get("redmyne.copyIssueId")?.({ id: 88 });
    await handlers.get("redmyne.copyProjectId")?.({ id: 11 });

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("#88");
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("#11");
  });

  it("copies project url when identifier and server are configured", async () => {
    setServerUrl("https://redmine.example.test");
    registerNavigationClipboardCommands();

    await handlers.get("redmyne.copyProjectUrl")?.({ id: 1, identifier: "platform" });

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
      "https://redmine.example.test/projects/platform"
    );
  });

  it("shows project identifier error when copy project url has no identifier", async () => {
    setServerUrl("https://redmine.example.test");
    registerNavigationClipboardCommands();

    await handlers.get("redmyne.copyProjectUrl")?.({ id: 1 });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Could not determine project identifier"
    );
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("shows project id error when copy project id has no context", async () => {
    setServerUrl("https://redmine.example.test");
    registerNavigationClipboardCommands();

    await handlers.get("redmyne.copyProjectId")?.(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Could not determine project ID"
    );
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });
});
