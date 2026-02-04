import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as vscode from "vscode";

// Mock context factory
function createMockContext() {
  const stateStore: Record<string, unknown> = {};
  const secretStore: Record<string, string> = {};

  const globalState: vscode.Memento = {
    get: <T>(key: string, defaultValue?: T) =>
      (stateStore[key] as T) ?? (defaultValue as T),
    update: vi.fn(async (key: string, value: unknown) => {
      if (value === undefined) {
        delete stateStore[key];
      } else {
        stateStore[key] = value;
      }
    }),
    keys: () => Object.keys(stateStore),
    setKeysForSync: vi.fn(),
  };

  const secrets: vscode.SecretStorage = {
    get: vi.fn(async (key: string) => secretStore[key]),
    store: vi.fn(async (key: string, value: string) => {
      secretStore[key] = value;
    }),
    delete: vi.fn(async (key: string) => {
      delete secretStore[key];
    }),
    onDidChange: vi.fn() as unknown as vscode.Event<vscode.SecretStorageChangeEvent>,
  };

  return {
    globalState,
    secrets,
    _stateStore: stateStore,
    _secretStore: secretStore,
  } as unknown as vscode.ExtensionContext & {
    _stateStore: Record<string, unknown>;
    _secretStore: Record<string, string>;
  };
}

describe("migration", () => {
  let runMigration: (context: vscode.ExtensionContext) => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const module = await import("../../../src/utilities/migration");
    runMigration = module.runMigration;
  });

  describe("runMigration", () => {
    it("skips migration if already at current version", async () => {
      const context = createMockContext();
      context._stateStore["redmyne.migrationVersion"] = 1;

      await runMigration(context);

      // Should not have updated migration version again
      expect(context.globalState.update).not.toHaveBeenCalled();
    });

    it("migrates globalState keys from old to new namespace", async () => {
      const context = createMockContext();
      context._stateStore["redmine.kanban"] = [{ id: "task1" }];
      context._stateStore["redmine.issueFilter"] = "myOpen";

      await runMigration(context);

      // New keys should exist
      expect(context._stateStore["redmyne.kanban"]).toEqual([{ id: "task1" }]);
      expect(context._stateStore["redmyne.issueFilter"]).toBe("myOpen");
      // Old keys should be removed
      expect(context._stateStore["redmine.kanban"]).toBeUndefined();
      expect(context._stateStore["redmine.issueFilter"]).toBeUndefined();
    });

    it("does not overwrite existing new namespace keys", async () => {
      const context = createMockContext();
      context._stateStore["redmine.kanban"] = [{ id: "old" }];
      context._stateStore["redmyne.kanban"] = [{ id: "new" }];

      await runMigration(context);

      // New value should be preserved
      expect(context._stateStore["redmyne.kanban"]).toEqual([{ id: "new" }]);
    });

    it("migrates secret keys from old to new namespace", async () => {
      const context = createMockContext();
      context._secretStore["redmine:global:apiKey:v2"] = "secret123";

      await runMigration(context);

      expect(context.secrets.store).toHaveBeenCalledWith(
        "redmyne:global:apiKey:v2",
        "secret123"
      );
      expect(context.secrets.delete).toHaveBeenCalledWith(
        "redmine:global:apiKey:v2"
      );
    });

    it("does not overwrite existing new secret keys", async () => {
      const context = createMockContext();
      context._secretStore["redmine:global:apiKey:v2"] = "old_secret";
      context._secretStore["redmyne:global:apiKey:v2"] = "new_secret";

      await runMigration(context);

      // store should not have been called for this key
      expect(context.secrets.store).not.toHaveBeenCalledWith(
        "redmyne:global:apiKey:v2",
        "old_secret"
      );
    });

    it("sets migration version after completion", async () => {
      const context = createMockContext();

      await runMigration(context);

      expect(context._stateStore["redmyne.migrationVersion"]).toBe(1);
    });

    it("handles empty migration gracefully", async () => {
      const context = createMockContext();

      await runMigration(context);

      // Should complete without errors
      expect(context._stateStore["redmyne.migrationVersion"]).toBe(1);
    });
  });
});
