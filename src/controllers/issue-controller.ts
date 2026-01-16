import * as vscode from "vscode";
import { QuickUpdate, Membership, IssueStatus } from "./domain";
import { RedmineServer } from "../redmine/redmine-server";
import { Issue } from "../redmine/models/issue";
import { IssueStatus as RedmineIssueStatus, IssuePriority, TimeEntryActivity } from "../redmine/models/common";
import { errorToString } from "../utilities/error-feedback";
import { parseTimeInput, validateTimeInput, formatHoursAsHHMM } from "../utilities/time-input";
import { showStatusBarMessage } from "../utilities/status-bar";
import { pickOptionalDate } from "../utilities/date-picker";

interface TimeEntryActivityItem extends vscode.QuickPickItem {
  activity: TimeEntryActivity;
}

export class IssueController {
  constructor(
    private issue: Issue,
    private redmine: RedmineServer,
    private onIssueUpdated?: () => void
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

      // Refresh time entries tree
      vscode.commands.executeCommand("redmyne.refreshTimeEntries");

      // Status bar confirmation (matches QuickLogTime UX)
      showStatusBarMessage(
        `$(check) Logged ${formatHoursAsHHMM(hours)} to #${this.issue.id}`
      );
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
      showStatusBarMessage(
        `$(check) #${this.issue.id} → ${stat.fullIssue.name}`,
        2000
      );
    } catch (error) {
      vscode.window.showErrorMessage(errorToString(error));
    }
  }

  async changeIssuePriority(priorities: IssuePriority[]) {
    const item = await vscode.window.showQuickPick(
      priorities.map((p) => ({
        label: p.name,
        description: p.id === this.issue.priority.id ? "(current)" : undefined,
        priority: p,
      })),
      {
        title: `Change Priority - #${this.issue.id}`,
        placeHolder: `Current: ${this.issue.priority.name}`,
      }
    );
    if (!item || item.priority.id === this.issue.priority.id) return;

    try {
      await this.redmine.setIssuePriority(this.issue.id, item.priority.id);
      showStatusBarMessage(
        `$(check) #${this.issue.id} priority → ${item.priority.name}`,
        2000
      );
      this.onIssueUpdated?.();
      vscode.commands.executeCommand("redmyne.refreshAfterIssueUpdate");
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

  private async changePriority() {
    const { issue_priorities } = await this.redmine.getIssuePriorities();
    this.changeIssuePriority(issue_priorities);
  }

  private async addTimeEntry() {
    // Use project-specific activities (falls back to global if not restricted)
    const activities = await this.redmine.getProjectTimeEntryActivities(
      this.issue.project.id
    );
    this.chooseTimeEntryType(activities);
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
      title: `Quick Update (1/5) - #${this.issue.id}`,
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
      title: `Quick Update (2/5) - #${this.issue.id}`,
      placeHolder: `Current: ${currentAssigneeName}`,
    });
    if (!assigneeChoice) {
      return;
    }

    const desiredAssignee = assigneeChoice.assignee;

    // Start date picker
    const startDateResult = await pickOptionalDate(
      "Start date",
      this.issue.start_date || undefined,
      `Quick Update (3/5) - #${this.issue.id}`
    );
    if (startDateResult === undefined) return; // cancelled

    // Due date picker
    const dueDateResult = await pickOptionalDate(
      "Due date",
      this.issue.due_date || undefined,
      `Quick Update (4/5) - #${this.issue.id}`
    );
    if (dueDateResult === undefined) return; // cancelled

    const message = await vscode.window.showInputBox({
      title: `Quick Update (5/5) - #${this.issue.id}`,
      placeHolder: "Add a comment (optional)",
    });
    if (message === undefined) return; // cancelled

    const quickUpdate = new QuickUpdate(
      this.issue.id,
      message,
      desiredAssignee,
      desiredStatus,
      startDateResult.changed ? startDateResult.value : undefined,
      dueDateResult.changed ? dueDateResult.value : undefined
    );

    try {
      const updateResult = await this.redmine.applyQuickUpdate(quickUpdate);
      if (updateResult.isSuccessful()) {
        showStatusBarMessage("$(check) Issue updated", 2000);
      } else {
        vscode.window.showErrorMessage(
          `Issue updated partially; problems: \n${updateResult.differences.join(
            "\t\n"
          )}`
        );
      }
      // Trigger refresh (even on partial success - issue was modified)
      this.onIssueUpdated?.();
      vscode.commands.executeCommand("redmyne.refreshAfterIssueUpdate");
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
            description: "Change status, assignee, dates, and comment",
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
            action: "changePriority",
            label: "$(flame) Change priority",
            description: `Current: ${this.issue.priority.name}`,
            detail: issueDetails,
          },
          {
            action: "openInBrowser",
            label: "$(link-external) Open in browser",
            description: "View issue in Redmine",
            detail: issueDetails,
          },
          {
            action: "viewHistory",
            label: "$(git-commit) View history",
            description: "See updates and comments",
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
      if (option.action === "changePriority") {
        this.changePriority();
      }
      if (option.action === "addTimeEntry") {
        this.addTimeEntry();
      }
      if (option.action === "quickUpdate") {
        this.quickUpdate();
      }
      if (option.action === "viewHistory") {
        this.viewHistory();
      }
    } catch (error) {
      vscode.window.showErrorMessage(errorToString(error));
    }
  }

  /**
   * Show issue history (journal entries)
   */
  private async viewHistory() {
    try {
      const result = await this.redmine.getIssueWithJournals(this.issue.id);
      const journals = result.issue.journals || [];

      if (journals.length === 0) {
        vscode.window.showInformationMessage(`No history for #${this.issue.id}`);
        return;
      }

      // Build list of journal entries as quick pick items
      const items = journals
        .slice()
        .reverse() // Most recent first
        .map((j) => {
          const date = new Date(j.created_on);
          const dateStr = date.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });

          // Summarize changes
          const changes = j.details
            .map((d) => {
              if (d.property === "attr") {
                return `${d.name}: ${d.old_value || "∅"} → ${d.new_value || "∅"}`;
              }
              return d.name;
            })
            .join(", ");

          const hasComment = j.notes && j.notes.trim().length > 0;
          const label = hasComment
            ? `$(comment) ${j.notes.substring(0, 60)}${j.notes.length > 60 ? "..." : ""}`
            : changes
              ? `$(diff) ${changes}`
              : `$(git-commit) Update`;

          return {
            label,
            description: `${j.user.name} • ${dateStr}`,
            detail: hasComment && changes ? changes : undefined,
            journal: j,
          };
        });

      const selected = await vscode.window.showQuickPick(items, {
        title: `History - #${this.issue.id}`,
        placeHolder: `${journals.length} updates`,
      });

      // If user selected an entry with a comment, show full comment
      if (selected && selected.journal.notes) {
        const action = await vscode.window.showQuickPick(
          [
            { label: "$(copy) Copy comment", action: "copy" },
            { label: "$(arrow-left) Back to history", action: "back" },
          ],
          { title: `Comment by ${selected.journal.user.name}` }
        );

        if (action?.action === "copy") {
          await vscode.env.clipboard.writeText(selected.journal.notes);
          showStatusBarMessage("$(check) Copied to clipboard", 2000);
        } else if (action?.action === "back") {
          this.viewHistory();
        }
      }
    } catch (error) {
      vscode.window.showErrorMessage(errorToString(error));
    }
  }
}
