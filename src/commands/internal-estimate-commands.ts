/**
 * Internal Estimate Commands
 * Set/clear user-provided remaining hours estimates for issues.
 * Used when original estimated_hours is no longer accurate.
 */

import * as vscode from "vscode";
import {
  setInternalEstimate,
  clearInternalEstimate,
  getInternalEstimate,
} from "../utilities/internal-estimates";
import { ensureIssueId } from "./command-guards";

export function registerInternalEstimateCommands(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    // Set internal estimate for an issue
    vscode.commands.registerCommand(
      "redmyne.setInternalEstimate",
      async (issue: { id: number; subject: string; estimated_hours?: number | null } | undefined) => {
        if (!ensureIssueId(issue)) return;

        // Get current value for placeholder
        const current = getInternalEstimate(context.globalState, issue.id);
        const placeholder = current?.hoursRemaining?.toString() ?? "";

        const input = await vscode.window.showInputBox({
          title: `Set Internal Estimate: #${issue.id}`,
          prompt: `Hours remaining for "${issue.subject}"`,
          placeHolder: placeholder || "Enter hours remaining (e.g., 5, 2.5)",
          value: placeholder,
          validateInput: (value) => {
            if (!value.trim()) return "Please enter a number";
            const num = parseFloat(value);
            if (isNaN(num)) return "Please enter a valid number";
            if (num < 0) return "Hours cannot be negative";
            return null;
          },
        });

        if (input === undefined) return; // Cancelled

        const hours = parseFloat(input);
        await setInternalEstimate(context.globalState, issue.id, hours);

        vscode.window.showInformationMessage(
          `Internal estimate set: #${issue.id} → ${hours}h remaining`
        );

        // Refresh Gantt if open
        vscode.commands.executeCommand("redmyne.refreshGanttData");
      }
    ),

    // Clear internal estimate
    vscode.commands.registerCommand(
      "redmyne.clearInternalEstimate",
      async (issue: { id: number; subject: string } | undefined) => {
        if (!ensureIssueId(issue)) return;

        const current = getInternalEstimate(context.globalState, issue.id);
        if (!current) {
          vscode.window.showInformationMessage(
            `No internal estimate set for #${issue.id}`
          );
          return;
        }

        await clearInternalEstimate(context.globalState, issue.id);

        vscode.window.showInformationMessage(
          `Internal estimate cleared for #${issue.id}`
        );

        // Refresh Gantt if open
        vscode.commands.executeCommand("redmyne.refreshGanttData");
      }
    )
  );
}
