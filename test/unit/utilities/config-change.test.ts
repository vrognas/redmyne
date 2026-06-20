import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { isClientStateOnlyConfigChange } from "../../../src/utilities/config-change";

/** Minimal ConfigurationChangeEvent whose affectsConfiguration checks a key set. */
function event(...keys: string[]): vscode.ConfigurationChangeEvent {
  const set = new Set(keys);
  return { affectsConfiguration: (k: string) => set.has(k) } as vscode.ConfigurationChangeEvent;
}

describe("isClientStateOnlyConfigChange", () => {
  it("is true for each client-side id-set toggle on its own", () => {
    expect(isClientStateOnlyConfigChange(event("redmyne.adHocBudgetIssues"))).toBe(true);
    expect(isClientStateOnlyConfigChange(event("redmyne.autoUpdateIssues"))).toBe(true);
    expect(isClientStateOnlyConfigChange(event("redmyne.precedenceIssues"))).toBe(true);
  });

  it("is false for server-affecting and display config", () => {
    expect(isClientStateOnlyConfigChange(event("redmyne.serverUrl"))).toBe(false);
    expect(isClientStateOnlyConfigChange(event("redmyne.caFile"))).toBe(false);
    expect(isClientStateOnlyConfigChange(event("redmyne.taskTypeField"))).toBe(false);
  });

  it("is false when a server key changes alongside an id-set (must still rebuild)", () => {
    expect(
      isClientStateOnlyConfigChange(event("redmyne.serverUrl", "redmyne.adHocBudgetIssues")),
    ).toBe(false);
  });
});
