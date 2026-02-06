import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerInternalEstimateCommands } from "../../../src/commands/internal-estimate-commands";
import { STORAGE_KEY } from "../../../src/utilities/internal-estimates";

type RegisteredHandler = (...args: unknown[]) => unknown;

function createMockGlobalState() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => store.get(key)),
    update: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    _store: store,
  };
}

describe("registerInternalEstimateCommands", () => {
  let handlers: Map<string, RegisteredHandler>;
  let globalState: ReturnType<typeof createMockGlobalState>;
  let context: vscode.ExtensionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map<string, RegisteredHandler>();
    globalState = createMockGlobalState();

    vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
      handlers.set(command as string, callback as RegisteredHandler);
      return { dispose: vi.fn() } as unknown as vscode.Disposable;
    });

    context = {
      subscriptions: [],
      globalState,
    } as unknown as vscode.ExtensionContext;
  });

  it("registers internal estimate command surface", () => {
    registerInternalEstimateCommands(context);

    expect(context.subscriptions).toHaveLength(2);
    expect(Array.from(handlers.keys())).toEqual(
      expect.arrayContaining([
        "redmyne.setInternalEstimate",
        "redmyne.clearInternalEstimate",
      ])
    );
  });

  it("shows issue id error for missing issue in set command", async () => {
    registerInternalEstimateCommands(context);

    await handlers.get("redmyne.setInternalEstimate")?.(undefined);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Could not determine issue ID"
    );
  });

  it("sets internal estimate and refreshes gantt data", async () => {
    registerInternalEstimateCommands(context);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("2.5");

    await handlers.get("redmyne.setInternalEstimate")?.({
      id: 123,
      subject: "Implement feature",
    });

    const stored = globalState._store.get(STORAGE_KEY) as Record<string, unknown>;
    expect((stored["123"] as { hoursRemaining: number }).hoursRemaining).toBe(2.5);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.refreshGanttData");
  });

  it("clears internal estimate and refreshes gantt data", async () => {
    globalState._store.set(STORAGE_KEY, {
      123: { hoursRemaining: 4, updatedAt: "2026-01-01T00:00:00.000Z" },
      999: { hoursRemaining: 2, updatedAt: "2026-01-01T00:00:00.000Z" },
    });
    registerInternalEstimateCommands(context);

    await handlers.get("redmyne.clearInternalEstimate")?.({
      id: 123,
      subject: "Implement feature",
    });

    const stored = globalState._store.get(STORAGE_KEY) as Record<string, unknown>;
    expect(stored["123"]).toBeUndefined();
    expect(stored["999"]).toBeDefined();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("redmyne.refreshGanttData");
  });
});
