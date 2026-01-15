import * as vscode from "vscode";
import { KanbanController } from "./kanban-controller";
import { KanbanTask, TaskPriority, getTaskStatus } from "./kanban-state";
import { showCreateTaskDialog, showEditTaskDialog } from "./kanban-dialogs";
import { RedmineServer } from "../redmine/redmine-server";
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
  getServer: () => RedmineServer | undefined
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
          linkedParentProjectId: result.linkedParentProjectId,
          linkedParentProjectName: result.linkedParentProjectName,
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

  // Refresh Parent Projects (migrate existing tasks)
  disposables.push(
    vscode.commands.registerCommand("redmine.kanban.refreshParentProjects", async () => {
      const server = getServer();
      if (!server) {
        showActionableError("Redmine not configured", [
          { title: "Configure", command: "redmine.configure" },
        ]);
        return;
      }

      const tasks = controller.getTasks();
      if (tasks.length === 0) {
        vscode.window.showInformationMessage("No tasks to refresh");
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Refreshing parent projects...",
          cancellable: false,
        },
        async (progress) => {
          const projects = await server.getProjects();
          const projectMap = new Map(projects.map((p) => [p.id, p]));

          let updated = 0;
          for (let i = 0; i < tasks.length; i++) {
            const task = tasks[i];
            progress.report({ increment: (100 / tasks.length), message: `${i + 1}/${tasks.length}` });

            const project = projectMap.get(task.linkedProjectId);
            const parentId = project?.parent?.id;
            const parentName = project?.parent?.name;

            // Only update if parent info changed
            if (task.linkedParentProjectId !== parentId || task.linkedParentProjectName !== parentName) {
              await controller.updateParentProject(task.id, parentId, parentName);
              updated++;
            }
          }

          vscode.window.showInformationMessage(`Updated ${updated} task(s) with parent project info`);
        }
      );
    })
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

        const server = getServer();

        // Look up parent project from cached projects
        let linkedParentProjectId: number | undefined;
        let linkedParentProjectName: string | undefined;
        const projectId = issue.project?.id;
        if (projectId && server) {
          try {
            const projects = await server.getProjects();
            const project = projects.find((p) => p.id === projectId);
            if (project?.parent) {
              linkedParentProjectId = project.parent.id;
              linkedParentProjectName = project.parent.name;
            }
          } catch {
            // Parent project lookup failed - continue without it
          }
        }

        await controller.addTask(
          issue.subject,
          issue.id,
          issue.subject,
          issue.project?.id ?? 0,
          issue.project?.name ?? "",
          {
            linkedParentProjectId,
            linkedParentProjectName,
          }
        );

        vscode.window.showInformationMessage(
          `Added #${issue.id} to Kanban`
        );
      }
    )
  );

  // --- Timer Commands ---

  // Start Timer
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.startTimer",
      async (taskId: string | TaskTreeItem) => {
        const id = typeof taskId === "string" ? taskId : taskId?.task?.id;
        if (!id) return;

        const task = controller.getTaskById(id);
        if (!task) return;

        const status = getTaskStatus(task);
        if (status === "done") {
          vscode.window.showInformationMessage("Cannot start timer on done tasks");
          return;
        }

        const server = getServer();
        if (!server) {
          showActionableError("Redmine not configured", [
            { title: "Configure", command: "redmine.configure" },
          ]);
          return;
        }

        // Pick activity for the linked issue's project
        const picked = await pickActivityForProject(
          server,
          task.linkedProjectId,
          "Start Timer",
          `#${task.linkedIssueId}`
        );
        if (!picked) return;

        await controller.startTimer(task.id, picked.activityId, picked.activityName);
      }
    )
  );

  // Pause Timer
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.pauseTimer",
      async (taskId: string | TaskTreeItem) => {
        const id = typeof taskId === "string" ? taskId : taskId?.task?.id;
        if (!id) return;

        await controller.pauseTimer(id);
      }
    )
  );

  // Resume Timer
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.resumeTimer",
      async (taskId: string | TaskTreeItem) => {
        const id = typeof taskId === "string" ? taskId : taskId?.task?.id;
        if (!id) return;

        await controller.resumeTimer(id);
      }
    )
  );

  // Stop Timer
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.stopTimer",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;
        await controller.stopTimer(item.task.id);
      }
    )
  );

  // Move to To Do (clears timer and hours)
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.moveToTodo",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;
        await controller.moveToTodo(item.task.id);
      }
    )
  );

  // Toggle Timer (keyboard shortcut)
  disposables.push(
    vscode.commands.registerCommand("redmine.kanban.toggleTimer", async () => {
      const active = controller.getActiveTask();
      if (active) {
        await controller.pauseTimer(active.id);
        return;
      }

      // Find first paused task to resume
      const paused = controller.getTasks().find((t) => t.timerPhase === "paused");
      if (paused) {
        await controller.resumeTimer(paused.id);
        return;
      }

      vscode.window.showInformationMessage("No active or paused timer to toggle");
    })
  );

  // Skip Break
  disposables.push(
    vscode.commands.registerCommand("redmine.kanban.skipBreak", async () => {
      if (!controller.isOnBreak()) {
        vscode.window.showInformationMessage("No break in progress");
        return;
      }
      controller.skipBreak();
    })
  );

  // Log Early (proportional time)
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.logEarly",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;

        const task = item.task;
        if (!task.timerPhase || task.timerSecondsLeft === undefined) {
          vscode.window.showInformationMessage("No active timer to log");
          return;
        }

        const server = getServer();
        if (!server) {
          showActionableError("Redmine not configured", [
            { title: "Configure", command: "redmine.configure" },
          ]);
          return;
        }

        // Calculate elapsed time
        const workDuration = controller.getWorkDurationSeconds();
        const elapsedSeconds = workDuration - task.timerSecondsLeft;
        const hours = elapsedSeconds / 3600;

        if (hours < 0.01) {
          vscode.window.showInformationMessage("Not enough time elapsed to log");
          return;
        }

        const roundedHours = Math.round(hours * 100) / 100;
        const confirm = await vscode.window.showWarningMessage(
          `Log ${roundedHours}h for #${task.linkedIssueId}?`,
          { modal: true },
          "Log"
        );
        if (confirm !== "Log") return;

        try {
          await server.addTimeEntry(
            task.linkedIssueId,
            task.activityId ?? 0,
            roundedHours.toString(),
            task.title
          );
          await controller.addLoggedHours(task.id, roundedHours);
          await controller.stopTimer(task.id);
          vscode.window.showInformationMessage(`Logged ${roundedHours}h`);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to log time: ${error}`);
        }
      }
    )
  );

  // Defer Time (stop timer, carry time to next task)
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.deferTime",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;

        const task = item.task;
        if (!task.timerPhase || task.timerSecondsLeft === undefined) {
          vscode.window.showInformationMessage("No active timer to defer");
          return;
        }

        // Calculate elapsed time
        const workDuration = controller.getWorkDurationSeconds();
        const elapsedSeconds = workDuration - task.timerSecondsLeft;
        const elapsedMinutes = Math.round(elapsedSeconds / 60);

        if (elapsedMinutes < 1) {
          vscode.window.showInformationMessage("Not enough time elapsed to defer");
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Defer ${elapsedMinutes}min to next task?`,
          { modal: true },
          "Defer"
        );
        if (confirm !== "Defer") return;

        controller.addDeferredMinutes(elapsedMinutes);
        await controller.stopTimer(task.id);
        vscode.window.showInformationMessage(`Deferred ${elapsedMinutes}min to next task`);
      }
    )
  );

  // Log and Continue (log full duration, reset timer)
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.logAndContinue",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;

        const task = item.task;
        if (!task.timerPhase) {
          vscode.window.showInformationMessage("No active timer");
          return;
        }

        const server = getServer();
        if (!server) {
          showActionableError("Redmine not configured", [
            { title: "Configure", command: "redmine.configure" },
          ]);
          return;
        }

        const workDuration = controller.getWorkDurationSeconds();
        const hours = workDuration / 3600;
        const roundedHours = Math.round(hours * 100) / 100;

        try {
          await server.addTimeEntry(
            task.linkedIssueId,
            task.activityId ?? 0,
            roundedHours.toString(),
            task.title
          );
          await controller.addLoggedHours(task.id, roundedHours);
          // Reset timer to full duration and keep running
          await controller.startTimer(task.id, task.activityId ?? 0, task.activityName ?? "");
          vscode.window.showInformationMessage(`Logged ${roundedHours}h, timer restarted`);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to log time: ${error}`);
        }
      }
    )
  );

  // Move Up
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.moveUp",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;
        await controller.moveUp(item.task.id);
      }
    )
  );

  // Move Down
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.moveDown",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;
        await controller.moveDown(item.task.id);
      }
    )
  );

  // Reveal Time Entry (focus My Time Entries view)
  disposables.push(
    vscode.commands.registerCommand(
      "redmine.kanban.revealTimeEntry",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;

        // Focus the time entries view and refresh
        await vscode.commands.executeCommand("redmine-explorer-my-time-entries.focus");
        await vscode.commands.executeCommand("redmine.refreshTimeEntries");

        vscode.window.showInformationMessage(
          `Look for entries on #${item.task.linkedIssueId}`
        );
      }
    )
  );

  return disposables;
}
