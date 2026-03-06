import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerConfigureCommand } from "../../../src/commands/configure-command";
import * as statusBarUtil from "../../../src/utilities/status-bar";

type Handler = (...args: unknown[]) => unknown;

describe("registerConfigureCommand", () => {
  let handlers: Map<string, Handler>;
  let context: vscode.ExtensionContext;
  let configGet: ReturnType<typeof vi.fn>;
  let configUpdate: ReturnType<typeof vi.fn>;
  let secretManager: {
    getApiKey: ReturnType<typeof vi.fn>;
    setApiKey: ReturnType<typeof vi.fn>;
    deleteApiKey: ReturnType<typeof vi.fn>;
  };
  let updateConfiguredContext: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(statusBarUtil, "showStatusBarMessage").mockImplementation(() => undefined);

    handlers = new Map<string, Handler>();
    context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

    configGet = vi.fn();
    configUpdate = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: configGet,
      update: configUpdate,
    } as unknown as vscode.WorkspaceConfiguration);

    vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
      handlers.set(command as string, callback as Handler);
      return { dispose: vi.fn() } as unknown as vscode.Disposable;
    });

    secretManager = {
      getApiKey: vi.fn(),
      setApiKey: vi.fn().mockResolvedValue(undefined),
      deleteApiKey: vi.fn().mockResolvedValue(undefined),
    };
    updateConfiguredContext = vi.fn().mockResolvedValue(undefined);
  });

  function registerAndGetHandler(): () => Promise<void> {
    registerConfigureCommand(context, {
      secretManager: secretManager as unknown as never,
      updateConfiguredContext,
    });
    return handlers.get("redmyne.configure") as () => Promise<void>;
  }

  it("updates only api key when existing url+key and user picks api key", async () => {
    configGet.mockReturnValue("https://redmine.example.test");
    secretManager.getApiKey.mockResolvedValue("old-key");
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ value: "apiKey" } as never);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue("I Have My Key" as never);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("12345678901234567890");

    const handler = registerAndGetHandler();
    await handler();

    expect(configUpdate).not.toHaveBeenCalled();
    expect(secretManager.setApiKey).toHaveBeenCalledWith("12345678901234567890");
    expect(updateConfiguredContext).toHaveBeenCalledTimes(1);
    expect(statusBarUtil.showStatusBarMessage).toHaveBeenCalledWith(
      "$(check) Redmyne configured",
      3000
    );
  });

  it("returns early when existing url+key and action choice is cancelled", async () => {
    configGet.mockReturnValue("https://redmine.example.test");
    secretManager.getApiKey.mockResolvedValue("old-key");
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    const handler = registerAndGetHandler();
    await handler();

    expect(configUpdate).not.toHaveBeenCalled();
    expect(secretManager.setApiKey).not.toHaveBeenCalled();
    expect(updateConfiguredContext).not.toHaveBeenCalled();
  });

  it("updates only url when existing url+key and user picks url", async () => {
    configGet.mockReturnValue("https://redmine.example.test");
    secretManager.getApiKey.mockResolvedValue("old-key");
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ value: "url" } as never);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("https://new-redmine.example.test");

    const handler = registerAndGetHandler();
    await handler();

    expect(configUpdate).toHaveBeenCalledWith(
      "serverUrl",
      "https://new-redmine.example.test",
      vscode.ConfigurationTarget.Global
    );
    expect(secretManager.setApiKey).not.toHaveBeenCalled();
    expect(updateConfiguredContext).toHaveBeenCalledTimes(1);
  });

  it("opens redmine account when action is selected during api key prompt", async () => {
    configGet.mockReturnValue("https://redmine.example.test");
    secretManager.getApiKey.mockResolvedValue("old-key");
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ value: "both" } as never);
    vi.mocked(vscode.window.showInformationMessage)
      .mockResolvedValueOnce("Open Redmine Account" as never)
      .mockResolvedValueOnce("Got It" as never);
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce("https://new-redmine.example.test")
      .mockResolvedValueOnce("abcdefghijklmnopqrstuvwxyz");

    const handler = registerAndGetHandler();
    await handler();

    expect(vscode.env.openExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        toString: expect.any(Function),
      })
    );
    const urlArg = vi.mocked(vscode.env.openExternal).mock.calls[0][0];
    expect(urlArg.toString()).toBe("https://new-redmine.example.test/my/account");
    expect(secretManager.setApiKey).toHaveBeenCalledWith("abcdefghijklmnopqrstuvwxyz");
    expect(updateConfiguredContext).toHaveBeenCalledTimes(1);
  });

  it("returns early if api key helper modal cancelled", async () => {
    configGet.mockReturnValue("https://redmine.example.test");
    secretManager.getApiKey.mockResolvedValue("old-key");
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ value: "apiKey" } as never);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);

    const handler = registerAndGetHandler();
    await handler();

    expect(secretManager.setApiKey).not.toHaveBeenCalled();
    expect(updateConfiguredContext).not.toHaveBeenCalled();
  });

  it("prompts api key when url exists but key missing and user keeps url", async () => {
    configGet.mockReturnValue("https://redmine.example.test");
    secretManager.getApiKey.mockResolvedValue(undefined);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ value: "keep" } as never);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue("I Have My Key" as never);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("abcdefghijklmnopqrstuvwxyz");

    const handler = registerAndGetHandler();
    await handler();

    expect(configUpdate).not.toHaveBeenCalled();
    expect(secretManager.setApiKey).toHaveBeenCalledWith("abcdefghijklmnopqrstuvwxyz");
    expect(updateConfiguredContext).toHaveBeenCalledTimes(1);
  });

  it("returns early when url exists but key missing and url choice cancelled", async () => {
    configGet.mockReturnValue("https://redmine.example.test");
    secretManager.getApiKey.mockResolvedValue(undefined);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    const handler = registerAndGetHandler();
    await handler();

    expect(secretManager.setApiKey).not.toHaveBeenCalled();
    expect(updateConfiguredContext).not.toHaveBeenCalled();
  });

  it("returns early when invalid configuration warning dismissed", async () => {
    configGet.mockReturnValue(undefined);
    secretManager.getApiKey.mockResolvedValue("legacy-key");
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined);

    const handler = registerAndGetHandler();
    await handler();

    expect(secretManager.deleteApiKey).not.toHaveBeenCalled();
    expect(configUpdate).not.toHaveBeenCalled();
    expect(updateConfiguredContext).not.toHaveBeenCalled();
  });

  it("reconfigures from scratch when api key exists without url", async () => {
    configGet.mockReturnValue(undefined);
    secretManager.getApiKey.mockResolvedValue("legacy-key");
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce("Reconfigure" as never);
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce("https://new-redmine.example.test")
      .mockResolvedValueOnce("abcdefghijklmnopqrstuvwxyz");
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue("I Have My Key" as never);

    const handler = registerAndGetHandler();
    await handler();

    expect(secretManager.deleteApiKey).toHaveBeenCalledTimes(1);
    expect(configUpdate).toHaveBeenCalledWith(
      "serverUrl",
      "https://new-redmine.example.test",
      vscode.ConfigurationTarget.Global
    );
    expect(secretManager.setApiKey).toHaveBeenCalledWith("abcdefghijklmnopqrstuvwxyz");
    expect(updateConfiguredContext).toHaveBeenCalledTimes(1);
  });

  it("returns early when user cancels initial setup modal", async () => {
    configGet.mockReturnValue(undefined);
    secretManager.getApiKey.mockResolvedValue(undefined);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);

    const handler = registerAndGetHandler();
    await handler();

    expect(configUpdate).not.toHaveBeenCalled();
    expect(secretManager.setApiKey).not.toHaveBeenCalled();
    expect(updateConfiguredContext).not.toHaveBeenCalled();
  });

  it("returns early when user continues initial setup but cancels url", async () => {
    configGet.mockReturnValue(undefined);
    secretManager.getApiKey.mockResolvedValue(undefined);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue("Continue" as never);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

    const handler = registerAndGetHandler();
    await handler();

    expect(configUpdate).not.toHaveBeenCalled();
    expect(secretManager.setApiKey).not.toHaveBeenCalled();
    expect(updateConfiguredContext).not.toHaveBeenCalled();
  });

  it("runs validators for url and api key input boxes", async () => {
    configGet.mockReturnValue("https://redmine.example.test");
    secretManager.getApiKey.mockResolvedValue("old-key");
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ value: "both" } as never);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue("I Have My Key" as never);

    const inputValidators: Array<(value: string) => string | null> = [];
    vi.mocked(vscode.window.showInputBox)
      .mockImplementationOnce(async (options) => {
        inputValidators.push(options?.validateInput as (value: string) => string | null);
        return "https://new-redmine.example.test";
      })
      .mockImplementationOnce(async (options) => {
        inputValidators.push(options?.validateInput as (value: string) => string | null);
        return "abcdefghijklmnopqrstuvwxyz";
      });

    const handler = registerAndGetHandler();
    await handler();

    expect(inputValidators[0]("")).toBe("URL cannot be empty");
    expect(inputValidators[0]("not-a-url")).toBe("Invalid URL format");
    expect(inputValidators[0]("http://example.test")).toBe(
      "HTTPS required. URL must start with https://"
    );
    expect(inputValidators[0]("https://example.test")).toBeNull();

    expect(inputValidators[1]("")).toBe("API key cannot be empty");
    expect(inputValidators[1]("short")).toBe("API key appears too short");
    expect(inputValidators[1]("12345678901234567890")).toBeNull();
  });
});
