import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerNavigationClipboardCommands } from "../../../src/commands/navigation-clipboard-commands";

describe("registerNavigationClipboardCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.commands.registerCommand).mockImplementation(
      () => ({ dispose: vi.fn() }) as unknown as vscode.Disposable
    );
  });

  it("registers navigation and clipboard commands", () => {
    const disposables = registerNavigationClipboardCommands();

    expect(disposables).toHaveLength(5);

    const registeredCommands = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.map(([command]) => command);

    expect(registeredCommands).toEqual(
      expect.arrayContaining([
        "redmyne.openIssueInBrowser",
        "redmyne.copyIssueUrl",
        "redmyne.copyIssueId",
        "redmyne.copyProjectId",
        "redmyne.copyProjectUrl",
      ])
    );
  });
});
