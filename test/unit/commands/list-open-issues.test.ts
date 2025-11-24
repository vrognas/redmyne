import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import listOpenIssues from "../../../src/commands/list-open-issues-assigned-to-me";

describe("listOpenIssuesAssignedToMe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should fetch and display issues", async () => {
    const mockServer = {
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [] }),
      options: { url: { hostname: "test.redmine.com" } },
    };

    const props = { server: mockServer, config: {} };

    // Mock showQuickPick to return undefined (user cancelled)
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);

    await listOpenIssues(props);

    expect(mockServer.getIssuesAssignedToMe).toHaveBeenCalled();
  });
});
