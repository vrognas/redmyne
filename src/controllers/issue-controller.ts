import * as vscode from "vscode";
import { QuickUpdate, Membership, IssueStatus } from "./domain";
import { RedmineServer } from "../redmine/redmine-server";
import { Issue } from "../redmine/models/issue";
import { IssueStatus as RedmineIssueStatus } from "../redmine/models/issue-status";
import { TimeEntryActivity } from "../redmine/models/time-entry-activity";

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
      activities.map((activity) => {
        return {
          label: activity.name,
          description: "",
          detail: "",
          activity: activity,
        };
      }),
      {
        placeHolder: "Pick an activity type",
      }
    );
    if (!act) return;

    this.setTimeEntryMessage(act);
  }

  async setTimeEntryMessage(activity: TimeEntryActivityItem) {
    const input = await vscode.window.showInputBox({
      placeHolder: `"hours spent|additional message" or "hours spent|"`,
    });
    const indexOf = input?.indexOf("|") ?? -1;
    if (indexOf === -1) {
      await vscode.window.showWarningMessage(
        `Provide message in the following pattern: "hours spent|additional message" or "hours spent|", if you don't want to provide a message`
      );
      this.setTimeEntryMessage(activity);
      return;
    }
    if (!input) {
      vscode.window.showErrorMessage("Time entry input required");
      return;
    }
    const hours = input.substring(0, indexOf);
    const message = input.substring(indexOf + 1);

    try {
      await this.redmine.addTimeEntry(
        this.issue.id,
        activity.activity.id,
        hours,
        message
      );
      vscode.window.showInformationMessage(
        `Time entry for issue #${this.issue.id} has been added.`
      );
    } catch (reason) {
      vscode.window.showErrorMessage(reason as string);
    }
  }

  async changeIssueStatus(statuses: RedmineIssueStatus[]) {
    const stat = await vscode.window.showQuickPick(
      statuses.map((status) => {
        return {
          label: status.name,
          description: "",
          detail: "",
          fullIssue: status,
        };
      }),
      {
        placeHolder: "Pick a new status",
      }
    );
    if (!stat) return;

    try {
      await this.redmine.setIssueStatus(this.issue, stat.fullIssue.id);
      vscode.window.showInformationMessage(
        `Issue #${this.issue.id} status changed to ${stat.fullIssue.name}`
      );
    } catch (reason) {
      vscode.window.showErrorMessage(reason as string);
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
    } catch (reason) {
      vscode.window.showErrorMessage(reason as string);
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
    try {
      memberships = await this.redmine.getMemberships(this.issue.project.id);
    } catch (_error) {
      vscode.window.showErrorMessage(
        `Could not get memberships of project ${this.issue.project.name}`
      );
      return;
    }

    let possibleStatuses: IssueStatus[];
    try {
      possibleStatuses = await this.redmine.getIssueStatusesTyped();
    } catch (_error) {
      vscode.window.showErrorMessage("Could not get possible issue statuses");
      return;
    }

    const statusChoice = await vscode.window.showQuickPick(
      possibleStatuses.map((status) => {
        return {
          label: status.name,
          description: "",
          detail: "",
          status: status,
        };
      }),
      {
        placeHolder: `Current: ${this.issue.status.name}`,
      }
    );
    if (!statusChoice) {
      return;
    }

    const desiredStatus = statusChoice.status;

    const assigneeChoice = await vscode.window.showQuickPick(
      memberships.map((membership) => {
        return {
          label: `${membership.name}${!membership.isUser ? " (group)" : ""}`,
          description: "",
          detail: "",
          assignee: membership,
        };
      }),
      {
        placeHolder: `Current: ${
          this.issue.assigned_to ? this.issue.assigned_to.name : "_unassigned_"
        }`,
      }
    );
    if (!assigneeChoice) {
      return;
    }

    const desiredAssignee = assigneeChoice.assignee;
    const message =
      (await vscode.window.showInputBox({
        placeHolder: "Message",
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
            action: "changeStatus",
            label: "Change status",
            description: "Changes issue status",
            detail: issueDetails,
          },
          {
            action: "addTimeEntry",
            label: "Add time entry",
            description: "Adds new time entry to this issue",
            detail: issueDetails,
          },
          {
            action: "openInBrowser",
            label: "Open in browser",
            description:
              "Opens an issue in a browser (might need additional login)",
            detail: issueDetails,
          },
          {
            action: "quickUpdate",
            label: "Quick update",
            description:
              "Change assignee, status and leave a message in one step",
            detail: issueDetails,
          },
        ],
        {
          placeHolder: "Pick an action to do",
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
    } catch (_error) {
      /* ? */
    }
  }
}
