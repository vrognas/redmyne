import * as vscode from "vscode";
import { KanbanController } from "./kanban-controller";
import { KanbanTask, TaskPriority, getTaskStatus } from "./kanban-state";
import { showCreateTaskDialog, showEditTaskDialog } from "./kanban-dialogs";
import { RedmineServer } from "../redmine/redmine-server";
import { TimerController } from "../timer/timer-controller";
import { createWorkUnit } from "../timer/timer-state";
import { pickActivityForProject } from "../utilities/issue-picker";
import { showActionableError } from "../utilities/error-feedback";

interface TaskTreeItem {
  task?: KanbanTask;
}

/**
 * Register all kanban commands
 */
export function registerKanbanCommands(
  _context: vscode.ExtensionContext,
  controller: KanbanController,
  getServer: () => RedmineServer | undefined,
  getTimerController: () => TimerController | undefined,
  getWorkDurationSeconds: () => number
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Add Task
  disposables.push(
    vscode.commands.registerCommand("redmine.kanban.add", async () => {
      const server = getServer();
      if (!server) {
        showActionableError("Redmine not configured", [
          { title: "Configure", command: "redmine.configure" },
        ]);
        return;
      }

      const result = await showCreateTaskDialog(server);
      if (!result) return;

      await controller.addTask(
        result.title,
        result.linkedIssueId,
        result.linkedIssueSubject,
        result.linkedProjectId,
        result.linkedProjectName,
        {
          priority: result.priority,
          estimatedHours: result.estimatedHours,
        }
      );
    })
  );

  // Edit Task
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.edit",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;

        const updates = await showEditTaskDialog(item.task);
        if (!updates) return;

        await controller.updateTask(item.task.id, updates);
      }
    )
  );

  // Delete Task
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.delete",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;

        const confirm = await vscode.window.showWarningMessage(
          `Delete task "${item.task.title}"?`,
          { modal: true },
          "Delete"
        );
        if (confirm !== "Delete") return;

        await controller.deleteTask(item.task.id);
      }
    )
  );

  // Mark Done
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.markDone",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;
        await controller.markDone(item.task.id);
      }
    )
  );

  // Reopen
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.reopen",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;
        await controller.reopen(item.task.id);
      }
    )
  );

  // Set Priority
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.setPriority",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;

        const choice = await vscode.window.showQuickPick(
          [
            { label: "$(arrow-up) High", priority: "high" as TaskPriority },
            { label: "$(dash) Medium", priority: "medium" as TaskPriority },
            { label: "$(arrow-down) Low", priority: "low" as TaskPriority },
          ],
          { title: "Set Priority" }
        );
        if (!choice) return;

        await controller.updateTask(item.task.id, { priority: choice.priority });
      }
    )
  );

  // Open Linked Issue in Browser
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.openInBrowser",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;

        const server = getServer();
        if (!server) {
          showActionableError("Redmine not configured", [
          { title: "Configure", command: "redmine.configure" },
        ]);
          return;
        }

        const url = `${server.options.address}/issues/${item.task.linkedIssueId}`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    )
  );

  // Clear Done
  disposables.push(
    vscode.commands.registerCommand("redmine.kanban.clearDone", async () => {
      const doneTasks = controller.getTasks().filter((t) => getTaskStatus(t) === "done");
      if (doneTasks.length === 0) {
        vscode.window.showInformationMessage("No done tasks to clear");
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Clear ${doneTasks.length} done task(s)?`,
        { modal: true },
        "Clear"
      );
      if (confirm !== "Clear") return;

      await controller.clearDone();
    })
  );

  // Add to Today's Plan
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.addToPlan",
      async (taskId: string | TaskTreeItem) => {
        const id = typeof taskId === "string" ? taskId : taskId?.task?.id;
        if (!id) return;

        const task = controller.getTaskById(id);
        if (!task) return;

        const status = getTaskStatus(task);
        if (status === "done") {
          vscode.window.showInformationMessage("Cannot add done tasks to plan");
          return;
        }

        const server = getServer();
        if (!server) {
          showActionableError("Redmine not configured", [
          { title: "Configure", command: "redmine.configure" },
        ]);
          return;
        }

        const timerController = getTimerController();
        if (!timerController) {
          vscode.window.showErrorMessage("Timer not available");
          return;
        }

        // Pick activity for the linked issue's project
        const picked = await pickActivityForProject(
          server,
          task.linkedProjectId,
          "Add to Today's Plan",
          `#${task.linkedIssueId}`
        );
        if (!picked) return;

        // Create work unit with task title as comment
        const workDuration = getWorkDurationSeconds();
        const unit = createWorkUnit(
          task.linkedIssueId,
          task.linkedIssueSubject,
          picked.activityId,
          picked.activityName,
          workDuration,
          task.title // Task title becomes comment
        );

        // Link back to personal task for syncing logged hours
        unit.personalTaskId = task.id;

        // Add to plan
        const currentPlan = timerController.getPlan();
        timerController.setPlan([...currentPlan, unit]);

        vscode.window.showInformationMessage(
          `Added "${task.title}" to Today's Plan`
        );
      }
    )
  );

  // Copy Task Subject
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.copySubject",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;
        await vscode.env.clipboard.writeText(item.task.title);
        vscode.window.showInformationMessage("Copied task subject");
      }
    )
  );

  // Add issue from My Issues tree to Kanban
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.addIssueToKanban",
      async (issue: { id: number; subject: string; project?: { id: number; name: string } }) => {
        if (!issue?.id) {
          vscode.window.showErrorMessage("No issue selected");
          return;
        }

        await controller.addTask(
          issue.subject,
          issue.id,
          issue.subject,
          issue.project?.id ?? 0,
          issue.project?.name ?? ""
        );

        vscode.window.showInformationMessage(
          `Added #${issue.id} to Kanban`
        );
      }
    )
  );

  return disposables;
}
