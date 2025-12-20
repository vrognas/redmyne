import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { RedmineSecretManager } from "../../../src/utilities/secret-manager";

describe("RedmineSecretManager", () => {
  let context: vscode.ExtensionContext;
  let manager: RedmineSecretManager;

  beforeEach(() => {
    context = {
      secrets: {
        get: vi.fn(),
        store: vi.fn(),
        delete: vi.fn(),
        onDidChange: vi.fn(),
      },
    } as unknown as vscode.ExtensionContext;

    manager = new RedmineSecretManager(context);
  });

  it("should store API key globally", async () => {
    await manager.setApiKey("test-key-123");

    expect(context.secrets.store).toHaveBeenCalledWith(
      "redmine:global:apiKey:v2",
      "test-key-123"
    );
  });

  it("should retrieve API key", async () => {
    vi.mocked(context.secrets.get).mockResolvedValue("test-key-123");

    const key = await manager.getApiKey();
    expect(key).toBe("test-key-123");
    expect(context.secrets.get).toHaveBeenCalledWith("redmine:global:apiKey:v2");
  });

  it("should delete API key", async () => {
    await manager.deleteApiKey();

    expect(context.secrets.delete).toHaveBeenCalledWith("redmine:global:apiKey:v2");
  });
});
