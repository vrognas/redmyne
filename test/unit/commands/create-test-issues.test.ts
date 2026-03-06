import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerCreateTestIssuesCommand } from "../../../src/commands/create-test-issues";

type Handler = (...args: unknown[]) => unknown;

function makeProject(id: number, label: string, identifier?: string) {
  return {
    id,
    toQuickPickItem: () => ({ label, identifier }),
  };
}

describe("registerCreateTestIssuesCommand", () => {
  let handlers: Map<string, Handler>;
  let context: vscode.ExtensionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map<string, Handler>();
    context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

    vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
      handlers.set(command as string, callback as Handler);
      return { dispose: vi.fn() } as unknown as vscode.Disposable;
    });
  });

  function registerAndGetHandler(deps: {
    getServer: () => unknown;
    refreshProjects: ReturnType<typeof vi.fn>;
  }): () => Promise<void> {
    registerCreateTestIssuesCommand(context, deps as never);
    return handlers.get("redmyne.createTestIssues") as () => Promise<void>;
  }

  it("shows guard error and exits when no server is configured", async () => {
    const refreshProjects = vi.fn();
    const handler = registerAndGetHandler({
      getServer: () => undefined,
      refreshProjects,
    });

    await handler();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Redmine not configured. Run 'Redmine: Configure' first."
    );
    expect(vscode.window.withProgress).not.toHaveBeenCalled();
    expect(refreshProjects).not.toHaveBeenCalled();
  });

  it("shows project error when Operations project is missing", async () => {
    const server = {
      getProjects: vi.fn().mockResolvedValue([makeProject(1, "Platform", "platform")]),
      getTrackers: vi.fn().mockResolvedValue([{ id: 10, name: "Task" }]),
      getIssueStatuses: vi.fn().mockResolvedValue({
        issue_statuses: [
          { id: 20, name: "In Progress" },
          { id: 21, name: "New" },
        ],
      }),
      getPriorities: vi.fn().mockResolvedValue([
        { id: 30, name: "Low" },
        { id: 31, name: "Normal" },
        { id: 32, name: "High" },
        { id: 33, name: "Urgent" },
      ]),
      createIssue: vi.fn(),
      createRelation: vi.fn(),
    };
    const refreshProjects = vi.fn();
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Create Issues" as never);

    const handler = registerAndGetHandler({
      getServer: () => server,
      refreshProjects,
    });
    await handler();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Operations project not found")
    );
    expect(server.createIssue).not.toHaveBeenCalled();
    expect(refreshProjects).not.toHaveBeenCalled();
  });

  it("creates issue set, relation, and refreshes on success", async () => {
    let nextId = 1000;
    const server = {
      getProjects: vi.fn().mockResolvedValue([makeProject(1, "Operations", "operations")]),
      getTrackers: vi.fn().mockResolvedValue([{ id: 10, name: "Task" }]),
      getIssueStatuses: vi.fn().mockResolvedValue({
        issue_statuses: [
          { id: 20, name: "In Progress" },
          { id: 21, name: "New" },
        ],
      }),
      getPriorities: vi.fn().mockResolvedValue([
        { id: 30, name: "Low" },
        { id: 31, name: "Normal" },
        { id: 32, name: "High" },
        { id: 33, name: "Urgent" },
      ]),
      createIssue: vi.fn().mockImplementation(async () => {
        nextId += 1;
        return { issue: { id: nextId } };
      }),
      createRelation: vi.fn().mockResolvedValue(undefined),
    };
    const refreshProjects = vi.fn();
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Create Issues" as never);

    const handler = registerAndGetHandler({
      getServer: () => server,
      refreshProjects,
    });
    await handler();

    expect(server.createIssue).toHaveBeenCalledTimes(10);
    expect(server.createRelation).toHaveBeenCalledWith(1009, 1010, "blocks");
    expect(refreshProjects).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Created 10 test issues"
    );
  });
});
