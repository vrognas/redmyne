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
      "redmyne:global:apiKey:v2",
      "test-key-123"
    );
  });

  it("should retrieve API key", async () => {
    vi.mocked(context.secrets.get).mockResolvedValue("test-key-123");

    const key = await manager.getApiKey();
    expect(key).toBe("test-key-123");
    expect(context.secrets.get).toHaveBeenCalledWith("redmyne:global:apiKey:v2");
  });

  it("should delete API key", async () => {
    await manager.deleteApiKey();

    expect(context.secrets.delete).toHaveBeenCalledWith("redmyne:global:apiKey:v2");
  });

  it("should return undefined and show error when getApiKey fails", async () => {
    vi.mocked(context.secrets.get).mockRejectedValue(new Error("Secret storage error"));

    const key = await manager.getApiKey();

    expect(key).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Failed to retrieve API key")
    );
  });

  it("should subscribe to secret changes", () => {
    const callback = vi.fn();
    const mockDisposable = { dispose: vi.fn() };
    let changeHandler: (event: { key: string }) => void;

    vi.mocked(context.secrets.onDidChange).mockImplementation((handler) => {
      changeHandler = handler;
      return mockDisposable;
    });

    const disposable = manager.onSecretChanged(callback);

    // Trigger change for the API key
    changeHandler!({ key: "redmyne:global:apiKey:v2" });
    expect(callback).toHaveBeenCalledTimes(1);

    // Trigger change for unrelated key - should not call callback
    changeHandler!({ key: "other:key" });
    expect(callback).toHaveBeenCalledTimes(1);

    expect(disposable).toBe(mockDisposable);
  });
});
