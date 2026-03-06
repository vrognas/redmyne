import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { setApiKey } from "../../../src/commands/set-api-key";
import * as statusBarUtil from "../../../src/utilities/status-bar";

describe("setApiKey command", () => {
  let mockContext: vscode.ExtensionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockContext = {
      secrets: {
        get: vi.fn(),
        store: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn(),
        onDidChange: vi.fn(),
      },
    } as unknown as vscode.ExtensionContext;
    vi.spyOn(statusBarUtil, "showStatusBarMessage").mockImplementation(() => undefined);
  });

  it("stores api key and flashes status", async () => {
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("12345678901234567890");

    await setApiKey(mockContext);

    expect(mockContext.secrets.store).toHaveBeenCalledTimes(1);
    expect(mockContext.secrets.store).toHaveBeenCalledWith(
      expect.any(String),
      "12345678901234567890"
    );
    expect(statusBarUtil.showStatusBarMessage).toHaveBeenCalledWith(
      "$(check) API key stored securely",
      2000
    );
  });

  it("returns early when user cancels input", async () => {
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(undefined);

    await setApiKey(mockContext);

    expect(mockContext.secrets.store).not.toHaveBeenCalled();
    expect(statusBarUtil.showStatusBarMessage).not.toHaveBeenCalled();
  });

  it("validates api key input", async () => {
    vi.spyOn(vscode.window, "showInputBox").mockImplementation(async (options) => {
      const validateInput = options?.validateInput as ((value: string) => string | null);
      expect(validateInput("")).toBe("API key cannot be empty");
      expect(validateInput("short")).toBe("API key appears invalid");
      expect(validateInput("12345678901234567890")).toBeNull();
      return undefined;
    });

    await setApiKey(mockContext);

    expect(mockContext.secrets.store).not.toHaveBeenCalled();
  });
});
