import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerIssueContextCommands } from "../../../src/commands/issue-context-commands";

describe("registerIssueContextCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.commands.registerCommand).mockImplementation(
      () => ({ dispose: vi.fn() }) as unknown as vscode.Disposable
    );
  });

  it("registers issue context command surface", () => {
    const disposables = registerIssueContextCommands({
      globalState: {
        get: vi.fn(),
        update: vi.fn(),
      } as unknown as vscode.Memento,
      getProjectsServer: () => undefined,
      refreshProjectsTree: vi.fn(),
      getAssignedIssues: () => [],
      getDependencyIssues: () => [],
      getProjectNodeById: () => undefined,
      getProjectsTreeView: () => undefined,
      getTimeEntriesServer: () => undefined,
      refreshTimeEntries: vi.fn(),
    });

    expect(disposables).toHaveLength(17);

    const registeredCommands = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.map(([command]) => command);

    expect(registeredCommands).toEqual(
      expect.arrayContaining([
        "redmyne.setDoneRatio",
        "redmyne.setStatus",
        "redmyne.bulkSetDoneRatio",
        "redmyne.setIssueStatus",
        "redmyne.openProjectInBrowser",
        "redmyne.showProjectInGantt",
        "redmyne.revealIssueInTree",
        "redmyne.revealProjectInTree",
        "redmyne.toggleAutoUpdateDoneRatio",
        "redmyne.toggleAdHoc",
        "redmyne.contributeToIssue",
        "redmyne.removeContribution",
        "redmyne.togglePrecedence",
        "redmyne.setIssuePriority",
        "redmyne.setAutoUpdateDoneRatio",
        "redmyne.setAdHoc",
        "redmyne.setPrecedence",
      ])
    );
  });
});
