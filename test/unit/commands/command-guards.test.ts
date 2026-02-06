import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  ensureIssueId,
  getConfiguredServerUrlOrShowError,
  getIssueIdOrShowError,
  getNestedProjectIdOrShowError,
  getNestedProjectIdentifierOrShowError,
  getProjectIdOrShowError,
  getProjectIdentifierOrShowError,
  getServerOrShowError,
} from "../../../src/commands/command-guards";

describe("command-guards", () => {
  it("returns issue id when present", () => {
    expect(getIssueIdOrShowError({ id: 42 })).toBe(42);
  });

  it("shows issue error when id is missing", () => {
    expect(getIssueIdOrShowError(undefined)).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Could not determine issue ID"
    );
  });

  it("narrows issue with ensureIssueId type guard", () => {
    const issue: { id?: number } | undefined = { id: 7 };
    expect(ensureIssueId(issue)).toBe(true);
    expect(issue?.id).toBe(7);
  });

  it("returns project id and identifier for plain project payloads", () => {
    expect(getProjectIdOrShowError({ id: 9 })).toBe(9);
    expect(getProjectIdentifierOrShowError({ identifier: "ops" })).toBe("ops");
  });

  it("returns nested project id and identifier for node payloads", () => {
    expect(getNestedProjectIdOrShowError({ project: { id: 33 } })).toBe(33);
    expect(
      getNestedProjectIdentifierOrShowError({ project: { identifier: "platform" } })
    ).toBe("platform");
  });

  it("shows URL error when redmine server URL is missing", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
      update: vi.fn(),
    } as unknown as vscode.WorkspaceConfiguration);

    expect(getConfiguredServerUrlOrShowError()).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "No Redmine URL configured"
    );
  });

  it("returns configured server URL when available", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn().mockReturnValue("https://redmine.example.test"),
      update: vi.fn(),
    } as unknown as vscode.WorkspaceConfiguration);

    expect(getConfiguredServerUrlOrShowError()).toBe("https://redmine.example.test");
  });

  it("supports custom URL error message", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
      update: vi.fn(),
    } as unknown as vscode.WorkspaceConfiguration);

    expect(getConfiguredServerUrlOrShowError("Custom URL missing")).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Custom URL missing"
    );
  });

  it("returns server from getter when configured", () => {
    const server = { ping: true };
    expect(getServerOrShowError(() => server)).toBe(server);
  });

  it("shows default server error when getter returns undefined", () => {
    expect(getServerOrShowError(() => undefined)).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "No Redmine server configured"
    );
  });

  it("supports custom server error message", () => {
    expect(getServerOrShowError(() => undefined, "Custom server missing")).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Custom server missing"
    );
  });
});
