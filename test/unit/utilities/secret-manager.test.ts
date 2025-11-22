import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { RedmineSecretManager } from "../../../src/utilities/secret-manager";

describe("RedmineSecretManager", () => {
  let context: vscode.ExtensionContext;
  let manager: RedmineSecretManager;

  beforeEach(() => {
    context = ({
      secrets: {
        get: vi.fn(),
        store: vi.fn(),
        delete: vi.fn(),
        onDidChange: vi.fn(),
      },
    } as unknown) as vscode.ExtensionContext;

    manager = new RedmineSecretManager(context);
  });

  it("should store API key", async () => {
    const uri = vscode.Uri.parse("file:///home/user/project");
    await manager.setApiKey(uri, "test-key-123");

    expect(context.secrets.store).toHaveBeenCalledWith(
      expect.stringContaining("redmine:"),
      "test-key-123"
    );
  });

  it("should retrieve API key", async () => {
    const uri = vscode.Uri.parse("file:///home/user/project");
    vi.mocked(context.secrets.get).mockResolvedValue("test-key-123");

    const key = await manager.getApiKey(uri);
    expect(key).toBe("test-key-123");
  });
});
