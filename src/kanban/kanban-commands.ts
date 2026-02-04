import * as vscode from "vscode";
import { KanbanController } from "./kanban-controller";
import { KanbanTask, TaskPriority, getTaskStatus } from "./kanban-state";
import { showCreateTaskDialog, showEditTaskDialog } from "./kanban-dialogs";
import { RedmineServer } from "../redmine/redmine-server";
import { pickActivityForProject } from "../utilities/issue-picker";
import { showActionableError } from "../utilities/error-feedback";
import { showStatusBarMessage } from "../utilities/status-bar";
import { promptForRequiredCustomFields, TimeEntryCustomFieldValue } from "../utilities/custom-field-picker";
import { KanbanTreeProvider } from "./kanban-tree-provider";

interface TaskTreeItem {
  task?: KanbanTask;
}

/**
 * Register all kanban commands
 */
export function registerKanbanCommands(
  context: vscode.ExtensionContext,
  controller: KanbanController,
  getServer: () => RedmineServer | undefined,
  treeProvider?: KanbanTreeProvider
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Add Task
  disposables.push(
    vscode.commands.registerCommand("redmyne.kanban.add", async () => {
      const server = getServer();
      if (!server) {
        showActionableError("Redmyne not configured", [
          { title: "Configure", command: "redmyne.configure" },
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
      "redmyne.kanban.edit",
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
      "redmyne.kanban.delete",
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
      "redmyne.kanban.markDone",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;
        await controller.markDone(item.task.id);
      }
    )
  );

  // Reopen
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.reopen",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;
        await controller.reopen(item.task.id);
      }
    )
  );

  // Set Priority
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.setPriority",
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
      "redmyne.kanban.openInBrowser",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;

        const server = getServer();
        if (!server) {
          showActionableError("Redmyne not configured", [
          { title: "Configure", command: "redmyne.configure" },
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
    vscode.commands.registerCommand("redmyne.kanban.clearDone", async () => {
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
    vscode.commands.registerCommand("redmyne.kanban.refreshParentProjects", async () => {
      const server = getServer();
      if (!server) {
        showActionableError("Redmyne not configured", [
          { title: "Configure", command: "redmyne.configure" },
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
      "redmyne.kanban.copySubject",
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
      "redmyne.addIssueToKanban",
      async (issue: { id: number; subject?: string; project?: { id: number; name: string } }) => {
        if (!issue?.id) {
          vscode.window.showErrorMessage("No issue selected");
          return;
        }

        const server = getServer();

        // Fetch issue data if subject or project is missing (e.g., from Gantt context menu)
        let subject = issue.subject;
        let projectId = issue.project?.id;
        let projectName = issue.project?.name;

        if ((!subject || !projectId) && server) {
          try {
            const { issue: fullIssue } = await server.getIssueById(issue.id);
            subject = subject ?? fullIssue.subject;
            projectId = projectId ?? fullIssue.project?.id;
            projectName = projectName ?? fullIssue.project?.name;
          } catch (error) {
            vscode.window.showErrorMessage(`Failed to fetch issue #${issue.id}: ${error}`);
            return;
          }
        }

        if (!subject) {
          vscode.window.showErrorMessage("Could not determine issue subject");
          return;
        }

        // Look up parent project from cached projects
        let linkedParentProjectId: number | undefined;
        let linkedParentProjectName: string | undefined;
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
          subject,
          issue.id,
          subject,
          projectId ?? 0,
          projectName ?? "",
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
      "redmyne.kanban.startTimer",
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
          showActionableError("Redmyne not configured", [
            { title: "Configure", command: "redmyne.configure" },
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
      "redmyne.kanban.pauseTimer",
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
      "redmyne.kanban.resumeTimer",
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
      "redmyne.kanban.stopTimer",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;
        await controller.stopTimer(item.task.id);
      }
    )
  );

  // Move to To Do (clears timer and hours)
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.moveToTodo",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;
        await controller.moveToTodo(item.task.id);
      }
    )
  );

  // Toggle Timer (keyboard shortcut)
  disposables.push(
    vscode.commands.registerCommand("redmyne.kanban.toggleTimer", async () => {
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
    vscode.commands.registerCommand("redmyne.kanban.skipBreak", async () => {
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
      "redmyne.kanban.logEarly",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;

        const task = item.task;
        if (!task.timerPhase || task.timerSecondsLeft === undefined) {
          vscode.window.showInformationMessage("No active timer to log");
          return;
        }

        const server = getServer();
        if (!server) {
          showActionableError("Redmyne not configured", [
            { title: "Configure", command: "redmyne.configure" },
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

        // Prompt for required custom fields first
        const { values: customFieldValues, cancelled, prompted } =
          await promptForRequiredCustomFields(() => server.getTimeEntryCustomFields());
        if (cancelled) return;

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
            task.title,
            undefined,
            customFieldValues
          );
          await controller.addLoggedHours(task.id, roundedHours);
          await controller.stopTimer(task.id);
          vscode.window.showInformationMessage(`Logged ${roundedHours}h`);
        } catch (error) {
          const errorMsg = String(error);
          if (/custom.?field/i.test(errorMsg) && !prompted) {
            vscode.window.showErrorMessage(
              `${errorMsg} - Custom fields API requires admin access.`
            );
          } else {
            vscode.window.showErrorMessage(`Failed to log time: ${error}`);
          }
        }
      }
    )
  );

  // Defer Time (stop timer, carry time to next task)
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.deferTime",
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
      "redmyne.kanban.logAndContinue",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;

        const task = item.task;
        if (!task.timerPhase) {
          vscode.window.showInformationMessage("No active timer");
          return;
        }

        const server = getServer();
        if (!server) {
          showActionableError("Redmyne not configured", [
            { title: "Configure", command: "redmyne.configure" },
          ]);
          return;
        }

        // Prompt for required custom fields first
        const { values: customFieldValues, cancelled, prompted } =
          await promptForRequiredCustomFields(() => server.getTimeEntryCustomFields());
        if (cancelled) return;

        const workDuration = controller.getWorkDurationSeconds();
        const hours = workDuration / 3600;
        const roundedHours = Math.round(hours * 100) / 100;

        try {
          await server.addTimeEntry(
            task.linkedIssueId,
            task.activityId ?? 0,
            roundedHours.toString(),
            task.title,
            undefined,
            customFieldValues
          );
          await controller.addLoggedHours(task.id, roundedHours);
          // Reset timer to full duration and keep running
          await controller.startTimer(task.id, task.activityId ?? 0, task.activityName ?? "");
          vscode.window.showInformationMessage(`Logged ${roundedHours}h, timer restarted`);
        } catch (error) {
          const errorMsg = String(error);
          if (/custom.?field/i.test(errorMsg) && !prompted) {
            vscode.window.showErrorMessage(
              `${errorMsg} - Custom fields API requires admin access.`
            );
          } else {
            vscode.window.showErrorMessage(`Failed to log time: ${error}`);
          }
        }
      }
    )
  );

  // Move Up
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.moveUp",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;
        await controller.moveUp(item.task.id);
      }
    )
  );

  // Move Down
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.moveDown",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;
        await controller.moveDown(item.task.id);
      }
    )
  );

  // Reveal Time Entry (focus My Time Entries view)
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.revealTimeEntry",
      async (item: TaskTreeItem) => {
        if (!item?.task) return;

        // Focus the time entries view and refresh
        await vscode.commands.executeCommand("redmyne-explorer-my-time-entries.focus");
        await vscode.commands.executeCommand("redmyne.refreshTimeEntries");

        vscode.window.showInformationMessage(
          `Look for entries on #${item.task.linkedIssueId}`
        );
      }
    )
  );

  // Cleanup corrupted tasks
  disposables.push(
    vscode.commands.registerCommand("redmyne.kanban.cleanup", async () => {
      const tasks = controller.getTasks();
      const corruptedTasks = tasks.filter(
        (t) => !t.title || !t.linkedIssueId || !t.linkedProjectName
      );

      if (corruptedTasks.length === 0) {
        vscode.window.showInformationMessage("No corrupted tasks found");
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Found ${corruptedTasks.length} corrupted task(s). Delete them?`,
        { modal: true },
        "Delete"
      );
      if (confirm !== "Delete") return;

      for (const task of corruptedTasks) {
        await controller.deleteTask(task.id);
      }

      vscode.window.showInformationMessage(
        `Deleted ${corruptedTasks.length} corrupted task(s)`
      );
    })
  );

  // Configure Timer Settings
  disposables.push(
    vscode.commands.registerCommand("redmyne.kanban.configureTimer", async () => {
      const currentUnit = context.globalState.get<number>("redmyne.timer.unitDuration", 60);
      const currentWork = context.globalState.get<number>("redmyne.timer.workDuration", 45);
      const currentBreak = currentUnit - currentWork;
      const currentSound = context.globalState.get<boolean>("redmyne.timer.soundEnabled", true);
      const currentBarWidth = context.globalState.get<number>("redmyne.timer.progressBarWidth", 45);

      const choice = await vscode.window.showQuickPick(
        [
          {
            label: `$(clock) Unit Duration: ${currentUnit} min`,
            description: "Total time logged per unit",
            setting: "unitDuration",
          },
          {
            label: `$(pulse) Work Duration: ${currentWork} min`,
            description: "Active work time before break",
            setting: "workDuration",
          },
          {
            label: `$(coffee) Break Duration: ${currentBreak} min`,
            description: "Adjusts work duration to match",
            setting: "break",
          },
          {
            label: `$(unmute) Sound: ${currentSound ? "On" : "Off"}`,
            description: "Play sound when timer completes",
            setting: "sound",
          },
          {
            label: `$(symbol-number) Progress Bar: ${currentBarWidth} segments`,
            description: "Number of segments in progress bar (3-100)",
            setting: "progressBar",
          },
        ],
        { placeHolder: "Configure timer" }
      );

      if (!choice) return;

      if (choice.setting === "sound") {
        await context.globalState.update("redmyne.timer.soundEnabled", !currentSound);
        showStatusBarMessage(`$(check) Sound ${!currentSound ? "enabled" : "disabled"}`, 2000);
        return;
      }

      if (choice.setting === "progressBar") {
        const input = await vscode.window.showInputBox({
          prompt: "Enter number of progress bar segments (3-100):",
          value: currentBarWidth.toString(),
          validateInput: (v) => {
            const n = parseInt(v, 10);
            if (isNaN(n) || n < 3) return "Minimum 3 segments";
            if (n > 100) return "Maximum 100 segments";
            return null;
          },
        });
        if (!input) return;
        const value = parseInt(input, 10);
        await context.globalState.update("redmyne.timer.progressBarWidth", value);
        showStatusBarMessage(`$(check) Progress bar set to ${value} segments`, 2000);
        return;
      }

      if (choice.setting === "break") {
        const input = await vscode.window.showInputBox({
          prompt: `Break = Unit (${currentUnit}min) - Work. Enter new break duration:`,
          value: currentBreak.toString(),
          validateInput: (v) => {
            const n = parseInt(v, 10);
            if (isNaN(n) || n < 0) return "Minimum 0 minutes";
            if (n >= currentUnit) return `Must be less than unit duration (${currentUnit}min)`;
            return null;
          },
        });
        if (!input) return;
        const newBreak = parseInt(input, 10);
        const newWork = currentUnit - newBreak;
        await context.globalState.update("redmyne.timer.workDuration", newWork);
        controller.setWorkDurationSeconds(newWork * 60);
        showStatusBarMessage(`$(check) Break set to ${newBreak}min (work: ${newWork}min)`, 2000);
        return;
      }

      const prompt = choice.setting === "unitDuration"
        ? "Enter unit duration (minutes):"
        : "Enter work duration (minutes):";
      const current = choice.setting === "unitDuration" ? currentUnit : currentWork;
      const max = choice.setting === "unitDuration" ? 480 : currentUnit;

      const input = await vscode.window.showInputBox({
        prompt,
        value: current.toString(),
        validateInput: (v) => {
          const n = parseInt(v, 10);
          if (isNaN(n) || n < 1) return "Minimum 1 minute";
          if (n > max) return `Maximum ${max} minutes`;
          return null;
        },
      });
      if (!input) return;

      const value = parseInt(input, 10);
      if (choice.setting === "unitDuration") {
        await context.globalState.update("redmyne.timer.unitDuration", value);
        // Adjust work duration if needed
        if (currentWork > value) {
          await context.globalState.update("redmyne.timer.workDuration", value);
          controller.setWorkDurationSeconds(value * 60);
        }
        showStatusBarMessage(`$(check) Unit duration set to ${value}min`, 2000);
      } else {
        await context.globalState.update("redmyne.timer.workDuration", value);
        controller.setWorkDurationSeconds(value * 60);
        showStatusBarMessage(`$(check) Work duration set to ${value}min`, 2000);
      }
    })
  );

  // Filter/sort commands (only if tree provider is available)
  if (treeProvider) {
    // Filter commands
    disposables.push(
      vscode.commands.registerCommand("redmyne.kanban.filterAll", () => {
        treeProvider.setFilter("all");
        showStatusBarMessage("$(check) Showing all priorities", 2000);
      })
    );
    disposables.push(
      vscode.commands.registerCommand("redmyne.kanban.filterHigh", () => {
        treeProvider.setFilter("high");
        showStatusBarMessage("$(check) Showing high priority", 2000);
      })
    );
    disposables.push(
      vscode.commands.registerCommand("redmyne.kanban.filterMedium", () => {
        treeProvider.setFilter("medium");
        showStatusBarMessage("$(check) Showing medium priority", 2000);
      })
    );
    disposables.push(
      vscode.commands.registerCommand("redmyne.kanban.filterLow", () => {
        treeProvider.setFilter("low");
        showStatusBarMessage("$(check) Showing low priority", 2000);
      })
    );

    // Sort commands
    disposables.push(
      vscode.commands.registerCommand("redmyne.kanban.sortPriority", () => {
        treeProvider.setSort("priority");
        const { direction } = treeProvider.getSort();
        const arrow = direction === "asc" ? "↑" : "↓";
        showStatusBarMessage(`$(check) Sort by priority ${arrow}`, 2000);
      })
    );
    disposables.push(
      vscode.commands.registerCommand("redmyne.kanban.sortIssueId", () => {
        treeProvider.setSort("issueId");
        const { direction } = treeProvider.getSort();
        const arrow = direction === "asc" ? "↑" : "↓";
        showStatusBarMessage(`$(check) Sort by issue ID ${arrow}`, 2000);
      })
    );
  }

  return disposables;
}
