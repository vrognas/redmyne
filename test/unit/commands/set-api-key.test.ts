import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { setApiKey } from "../../../src/commands/set-api-key";

describe("setApiKey command", () => {
  let mockContext: vscode.ExtensionContext;

  beforeEach(() => {
    mockContext = ({
      secrets: {
        get: vi.fn(),
        store: vi.fn(),
        delete: vi.fn(),
        onDidChange: vi.fn(),
      },
    } as unknown) as vscode.ExtensionContext;
  });

  it("should prompt for API key", async () => {
    const mockFolder = {
      uri: vscode.Uri.parse("file:///home/user/project"),
      name: "test-project",
      index: 0,
    };

    // @ts-ignore - workspace mock
    vscode.workspace.workspaceFolders = [mockFolder];

    const showInputBoxSpy = vi
      .spyOn(vscode.window, "showInputBox")
      .mockResolvedValue("test-key-123");
    const showInfoSpy = vi
      .spyOn(vscode.window, "showInformationMessage")
      .mockResolvedValue(undefined);

    await setApiKey(mockContext);

    expect(showInputBoxSpy).toHaveBeenCalled();
    expect(mockContext.secrets.store).toHaveBeenCalled();
  });
});
