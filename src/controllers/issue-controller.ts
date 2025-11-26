import * as vscode from "vscode";
import { QuickUpdate, Membership, IssueStatus } from "./domain";
import { RedmineServer } from "../redmine/redmine-server";
import { Issue } from "../redmine/models/issue";
import { IssueStatus as RedmineIssueStatus } from "../redmine/models/issue-status";
import { TimeEntryActivity } from "../redmine/models/time-entry-activity";
import { errorToString } from "../utilities/error-to-string";
import { parseTimeInput, validateTimeInput } from "../utilities/time-input";

interface TimeEntryActivityItem extends vscode.QuickPickItem {
  activity: TimeEntryActivity;
}

export class IssueController {
  constructor(
    private issue: Issue,
    private redmine: RedmineServer
  ) {}

  async chooseTimeEntryType(activities: TimeEntryActivity[]) {
    const act = await vscode.window.showQuickPick(
      activities.map((activity) => ({
        label: activity.name,
        activity: activity,
      })),
      {
        title: `Add Time Entry - #${this.issue.id}`,
        placeHolder: "Select activity type",
      }
    );
    if (!act) return;

    this.setTimeEntryMessage(act);
  }

  /**
   * Unified time entry input flow (matches QuickLogTime UX)
   */
  async setTimeEntryMessage(activity: TimeEntryActivityItem) {
    // Step 1: Input hours with flexible format validation
    const hoursInput = await vscode.window.showInputBox({
      title: `Log Time (1/2) - #${this.issue.id}`,
      prompt: `Hours for ${activity.activity.name}`,
      placeHolder: "e.g., 2.5, 1:45, 1h 45min",
      validateInput: (value: string) => validateTimeInput(value),
    });

    if (!hoursInput) return; // User cancelled

    const hours = parseTimeInput(hoursInput);
    if (hours === null) {
      vscode.window.showErrorMessage("Invalid time format");
      return;
    }

    // Step 2: Input comment (optional)
    const comment = await vscode.window.showInputBox({
      title: `Log Time (2/2) - #${this.issue.id}`,
      prompt: "Comment (optional)",
      placeHolder: "e.g., Implemented feature X",
    });

    if (comment === undefined) return; // User cancelled

    try {
      await this.redmine.addTimeEntry(
        this.issue.id,
        activity.activity.id,
        hours.toString(),
        comment || ""
      );

      // Status bar confirmation (matches QuickLogTime UX)
      const statusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right
      );
      statusBar.text = `$(check) Logged ${hours.toFixed(2).replace(/\.?0+$/, "")}h to #${this.issue.id}`;
      statusBar.show();
      setTimeout(() => {
        statusBar.hide();
        statusBar.dispose();
      }, 3000);
    } catch (error) {
      vscode.window.showErrorMessage(errorToString(error));
    }
  }

  async changeIssueStatus(statuses: RedmineIssueStatus[]) {
    const stat = await vscode.window.showQuickPick(
      statuses.map((status) => ({
        label: status.name,
        fullIssue: status,
      })),
      {
        title: `Change Status - #${this.issue.id}`,
        placeHolder: `Current: ${this.issue.status.name}`,
      }
    );
    if (!stat) return;

    try {
      await this.redmine.setIssueStatus(this.issue, stat.fullIssue.id);
      vscode.window.showInformationMessage(
        `Issue #${this.issue.id} status changed to ${stat.fullIssue.name}`
      );
    } catch (error) {
      vscode.window.showErrorMessage(errorToString(error));
    }
  }

  private async openInBrowser() {
    try {
      await vscode.commands.executeCommand(
        "vscode.open",
        vscode.Uri.parse(
          `${this.redmine.options.address}/issues/${this.issue.id}`
        )
      );
    } catch (error) {
      vscode.window.showErrorMessage(errorToString(error));
    }
  }

  private async changeStatus() {
    const statuses = await this.redmine.getIssueStatuses();
    this.changeIssueStatus(statuses.issue_statuses);
  }

  private async addTimeEntry() {
    const activities = await this.redmine.getTimeEntryActivities();
    this.chooseTimeEntryType(activities.time_entry_activities);
  }

  private async quickUpdate() {
    let memberships: Membership[];
    let possibleStatuses: IssueStatus[];
    try {
      [memberships, possibleStatuses] = await Promise.all([
        this.redmine.getMemberships(this.issue.project.id),
        this.redmine.getIssueStatusesTyped(),
      ]);
    } catch (_error) {
      vscode.window.showErrorMessage(
        "Could not fetch required data for quick update"
      );
      return;
    }

    // Build status options: "No change" first, then other statuses (excluding current)
    const currentStatus = new IssueStatus(this.issue.status.id, this.issue.status.name);
    const statusOptions = [
      { label: "$(check) No change", status: currentStatus, isNoChange: true },
      ...possibleStatuses
        .filter((s) => s.statusId !== this.issue.status.id)
        .map((status) => ({ label: status.name, status, isNoChange: false })),
    ];

    const statusChoice = await vscode.window.showQuickPick(statusOptions, {
      title: `Quick Update (1/3) - #${this.issue.id}`,
      placeHolder: `Current: ${this.issue.status.name}`,
    });
    if (!statusChoice) {
      return;
    }

    const desiredStatus = statusChoice.status;

    // Build assignee options: "No change" first, then other members (excluding current)
    const currentAssigneeId = this.issue.assigned_to?.id;
    const currentAssigneeName = this.issue.assigned_to?.name ?? "_unassigned_";
    const noChangeAssignee: Membership = currentAssigneeId
      ? new Membership(currentAssigneeId, currentAssigneeName, true)
      : new Membership(0, "_unassigned_", true);

    const assigneeOptions = [
      { label: "$(check) No change", assignee: noChangeAssignee, isNoChange: true },
      ...memberships
        .filter((m) => m.id !== currentAssigneeId)
        .map((membership) => ({
          label: `${membership.name}${!membership.isUser ? " (group)" : ""}`,
          assignee: membership,
          isNoChange: false,
        })),
    ];

    const assigneeChoice = await vscode.window.showQuickPick(assigneeOptions, {
      title: `Quick Update (2/3) - #${this.issue.id}`,
      placeHolder: `Current: ${currentAssigneeName}`,
    });
    if (!assigneeChoice) {
      return;
    }

    const desiredAssignee = assigneeChoice.assignee;
    const message =
      (await vscode.window.showInputBox({
        title: `Quick Update (3/3) - #${this.issue.id}`,
        placeHolder: "Add a comment (optional)",
      })) ?? "";

    const quickUpdate = new QuickUpdate(
      this.issue.id,
      message,
      desiredAssignee,
      desiredStatus
    );

    try {
      const updateResult = await this.redmine.applyQuickUpdate(quickUpdate);
      if (updateResult.isSuccessful()) {
        vscode.window.showInformationMessage("Issue updated");
      } else {
        vscode.window.showErrorMessage(
          `Issue updated partially; problems: \n${updateResult.differences.join(
            "\t\n"
          )}`
        );
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Error while applying quick update: ${error}`
      );
    }
  }

  async listActions() {
    const issueDetails = `Issue #${this.issue.id} assigned to ${
      this.issue.assigned_to ? this.issue.assigned_to.name : "no one"
    }`;
    try {
      const option = await vscode.window.showQuickPick(
        [
          {
            action: "quickUpdate",
            label: "$(zap) Quick update",
            description: "Change status, assignee, and comment",
            detail: issueDetails,
          },
          {
            action: "addTimeEntry",
            label: "$(history) Add time entry",
            description: "Log time to this issue",
            detail: issueDetails,
          },
          {
            action: "changeStatus",
            label: "$(arrow-swap) Change status",
            description: "Update issue status only",
            detail: issueDetails,
          },
          {
            action: "openInBrowser",
            label: "$(link-external) Open in browser",
            description: "View issue in Redmine",
            detail: issueDetails,
          },
        ],
        {
          title: `#${this.issue.id}: ${this.issue.subject}`,
          placeHolder: "Select an action",
        }
      );
      if (!option) return;
      if (option.action === "openInBrowser") {
        this.openInBrowser();
      }
      if (option.action === "changeStatus") {
        this.changeStatus();
      }
      if (option.action === "addTimeEntry") {
        this.addTimeEntry();
      }
      if (option.action === "quickUpdate") {
        this.quickUpdate();
      }
    } catch (error) {
      vscode.window.showErrorMessage(errorToString(error));
    }
  }
}
