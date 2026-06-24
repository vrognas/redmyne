import * as vscode from "vscode";
import { TaskPriority, getTaskStatus } from "./kanban-state";
import { showCreateTaskDialog, showEditTaskDialog } from "./kanban-dialogs";
import { showActionableError } from "../utilities/error-feedback";
import { getIssueIdOrShowError } from "../commands/command-guards";
import { KanbanCommandDeps, TaskTreeItem } from "./kanban-command-helpers";

/** Task CRUD, status, copy, and add-from-tree commands. */
export function registerKanbanTaskCommands(deps: KanbanCommandDeps): vscode.Disposable[] {
  const { controller, getServer } = deps;
  const disposables: vscode.Disposable[] = [];

  // Add Task
  disposables.push(
    vscode.commands.registerCommand("redmyne.kanban.add", async () => {
      const server = getServer();
      if (!server) {
        void showActionableError("Redmyne not configured", [
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
          void showActionableError("Redmyne not configured", [
          { title: "Configure", command: "redmyne.configure" },
        ]);
          return;
        }

        const url = `${server.options.address}/issues/${item.task.linkedIssueId}`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    )
  );

  // Reveal the card's linked issue in the Gantt. Thin proxy mirroring the
  // Time Entries one: validate the id, then delegate to openIssueInGantt — the
  // single source of the reveal.
  disposables.push(
    vscode.commands.registerCommand(
      "redmyne.kanban.showInGantt",
      async (item: TaskTreeItem) => {
        const issueId = getIssueIdOrShowError({ id: item?.task?.linkedIssueId });
        if (!issueId) return;
        await vscode.commands.executeCommand("redmyne.openIssueInGantt", { id: issueId });
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
        void showActionableError("Redmyne not configured", [
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
            if (!task) continue;
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

  return disposables;
}
