import { describe, it, expect, vi, beforeEach } from "vitest";
import { showActionableError, type ErrorAction } from "../../../src/utilities/error-feedback";
import * as vscode from "vscode";

describe("error-feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("showActionableError", () => {
    it("shows error message with action buttons", async () => {
      const mockShowErrorMessage = vi.mocked(vscode.window.showErrorMessage);
      mockShowErrorMessage.mockResolvedValue(undefined);

      const actions: ErrorAction[] = [
        { title: "Configure", command: "redmine.configure" },
        { title: "Retry", command: "redmine.refresh" },
      ];

      await showActionableError("Connection failed", actions);

      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        "Connection failed",
        "Configure",
        "Retry"
      );
    });

    it("executes command when action is selected", async () => {
      const mockShowErrorMessage = vi.mocked(vscode.window.showErrorMessage);
      const mockExecuteCommand = vi.mocked(vscode.commands.executeCommand);

      mockShowErrorMessage.mockResolvedValue("Configure" as any);
      mockExecuteCommand.mockResolvedValue(undefined);

      const actions: ErrorAction[] = [
        { title: "Configure", command: "redmine.configure" },
      ];

      await showActionableError("Not configured", actions);

      expect(mockExecuteCommand).toHaveBeenCalledWith("redmine.configure");
    });

    it("passes command arguments when provided", async () => {
      const mockShowErrorMessage = vi.mocked(vscode.window.showErrorMessage);
      const mockExecuteCommand = vi.mocked(vscode.commands.executeCommand);

      mockShowErrorMessage.mockResolvedValue("View Issue" as any);
      mockExecuteCommand.mockResolvedValue(undefined);

      const actions: ErrorAction[] = [
        { title: "View Issue", command: "redmine.openIssue", args: [123] },
      ];

      await showActionableError("Issue error", actions);

      expect(mockExecuteCommand).toHaveBeenCalledWith("redmine.openIssue", 123);
    });

    it("does nothing when no action selected", async () => {
      const mockShowErrorMessage = vi.mocked(vscode.window.showErrorMessage);
      const mockExecuteCommand = vi.mocked(vscode.commands.executeCommand);

      mockShowErrorMessage.mockResolvedValue(undefined);

      const actions: ErrorAction[] = [
        { title: "Retry", command: "redmine.refresh" },
      ];

      await showActionableError("Error", actions);

      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    it("works with no actions (simple error)", async () => {
      const mockShowErrorMessage = vi.mocked(vscode.window.showErrorMessage);
      mockShowErrorMessage.mockResolvedValue(undefined);

      await showActionableError("Simple error");

      expect(mockShowErrorMessage).toHaveBeenCalledWith("Simple error");
    });
  });
});
