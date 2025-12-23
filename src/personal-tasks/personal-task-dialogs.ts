import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { PersonalTask, TaskPriority } from "./personal-task-state";
import { Issue } from "../redmine/models/issue";

interface IssueQuickPickItem extends vscode.QuickPickItem {
  issue?: Issue;
  disabled?: boolean;
}

export interface CreateTaskResult {
  title: string;
  linkedIssueId: number;
  linkedIssueSubject: string;
  linkedProjectId: number;
  linkedProjectName: string;
  description?: string;
  priority: TaskPriority;
  estimatedHours?: number;
}

/**
 * Show dialog to create a new personal task
 */
export async function showCreateTaskDialog(
  server: RedmineServer
): Promise<CreateTaskResult | undefined> {
  // 1. Pick linked issue (required)
  const selectedIssue = await pickIssueForTask(server);
  if (!selectedIssue) return undefined;

  // 2. Enter title (required)
  const title = await vscode.window.showInputBox({
    title: "Create Personal Task",
    prompt: `Task title (subtask of #${selectedIssue.id})`,
    placeHolder: "e.g., Preprocess demographics",
    validateInput: (value) => (!value.trim() ? "Title is required" : undefined),
  });
  if (!title) return undefined;

  // 3. Pick priority (optional, defaults to medium)
  const priorityItem = await vscode.window.showQuickPick(
    [
      { label: "$(arrow-up) High", priority: "high" as TaskPriority },
      { label: "$(dash) Medium", priority: "medium" as TaskPriority },
      { label: "$(arrow-down) Low", priority: "low" as TaskPriority },
    ],
    {
      title: "Create Personal Task",
      placeHolder: "Priority (default: Medium)",
    }
  );
  const priority = priorityItem?.priority ?? "medium";

  // 4. Estimated hours (optional)
  const hoursStr = await vscode.window.showInputBox({
    title: "Create Personal Task",
    prompt: "Estimated hours (optional)",
    placeHolder: "e.g., 2 or 1.5",
    validateInput: (value) => {
      if (!value.trim()) return undefined;
      const num = parseFloat(value);
      if (isNaN(num) || num <= 0) return "Enter a positive number";
      return undefined;
    },
  });
  const estimatedHours = hoursStr ? parseFloat(hoursStr) : undefined;

  return {
    title: title.trim(),
    linkedIssueId: selectedIssue.id,
    linkedIssueSubject: selectedIssue.subject,
    linkedProjectId: selectedIssue.project?.id ?? 0,
    linkedProjectName: selectedIssue.project?.name ?? "Unknown",
    priority,
    estimatedHours,
  };
}

/**
 * Show dialog to edit an existing task
 */
export async function showEditTaskDialog(
  task: PersonalTask
): Promise<Partial<CreateTaskResult> | undefined> {
  // 1. Edit title
  const title = await vscode.window.showInputBox({
    title: "Edit Task",
    prompt: "Task title",
    value: task.title,
    validateInput: (value) => (!value.trim() ? "Title is required" : undefined),
  });
  if (title === undefined) return undefined; // cancelled

  // 2. Pick priority
  const priorityItem = await vscode.window.showQuickPick(
    [
      {
        label: "$(arrow-up) High",
        priority: "high" as TaskPriority,
        picked: task.priority === "high",
      },
      {
        label: "$(dash) Medium",
        priority: "medium" as TaskPriority,
        picked: task.priority === "medium",
      },
      {
        label: "$(arrow-down) Low",
        priority: "low" as TaskPriority,
        picked: task.priority === "low",
      },
    ],
    {
      title: "Edit Task",
      placeHolder: "Priority",
    }
  );
  if (!priorityItem) return undefined;

  // 3. Estimated hours
  const hoursStr = await vscode.window.showInputBox({
    title: "Edit Task",
    prompt: "Estimated hours",
    value: task.estimatedHours?.toString() ?? "",
    validateInput: (value) => {
      if (!value.trim()) return undefined;
      const num = parseFloat(value);
      if (isNaN(num) || num <= 0) return "Enter a positive number";
      return undefined;
    },
  });
  if (hoursStr === undefined) return undefined;

  return {
    title: title.trim(),
    priority: priorityItem.priority,
    estimatedHours: hoursStr.trim() ? parseFloat(hoursStr) : undefined,
  };
}

/**
 * Pick an issue for linking to a task (without activity selection)
 */
async function pickIssueForTask(server: RedmineServer): Promise<Issue | undefined> {
  let issues: Issue[];
  try {
    const result = await server.getIssuesAssignedToMe();
    issues = result.issues;
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to fetch issues: ${error}`);
    return undefined;
  }

  const items: IssueQuickPickItem[] = issues.map((issue) => ({
    label: `#${issue.id} ${issue.subject}`,
    description: issue.project?.name,
    issue,
  }));

  const selectedIssue = await new Promise<Issue | undefined>((resolve) => {
    const quickPick = vscode.window.createQuickPick<IssueQuickPickItem>();
    quickPick.title = "Link to Redmine Issue";
    quickPick.placeholder = "Type to search, or select from list";
    quickPick.items = items;
    quickPick.matchOnDescription = true;

    let searchTimeout: ReturnType<typeof setTimeout> | undefined;
    let resolved = false;
    let searchVersion = 0;

    const handleSelection = (selected: IssueQuickPickItem): boolean => {
      if (resolved) return false;
      if (selected.disabled) return false;
      if (selected.issue) {
        resolved = true;
        quickPick.dispose();
        resolve(selected.issue);
        return true;
      }
      return false;
    };

    quickPick.onDidChangeValue(async (value) => {
      if (searchTimeout) clearTimeout(searchTimeout);
      if (!value.trim()) {
        quickPick.items = items;
        return;
      }

      searchTimeout = setTimeout(async () => {
        const query = value.trim();
        if (!query || query.length < 2) return;

        const thisSearchVersion = ++searchVersion;
        quickPick.busy = true;

        try {
          const searchResults = await server.searchIssues(query, 10);
          if (thisSearchVersion !== searchVersion || resolved) return;

          const seenIds = new Set(issues.map((i) => i.id));
          const resultItems: IssueQuickPickItem[] = [];

          for (const issue of searchResults) {
            if (!seenIds.has(issue.id)) {
              resultItems.push({
                label: `$(search) #${issue.id} ${issue.subject}`,
                description: issue.project?.name,
                issue,
              });
            }
          }

          quickPick.items = [
            ...resultItems,
            { label: "", kind: vscode.QuickPickItemKind.Separator } as IssueQuickPickItem,
            ...items,
          ];
        } catch {
          // Search failed, keep local items
        } finally {
          if (thisSearchVersion === searchVersion) {
            quickPick.busy = false;
          }
        }
      }, 300);
    });

    quickPick.onDidAccept(() => {
      const selected = quickPick.activeItems[0];
      if (selected) handleSelection(selected);
    });

    quickPick.onDidChangeSelection((sel) => {
      if (sel.length > 0) handleSelection(sel[0]);
    });

    quickPick.onDidHide(() => {
      if (searchTimeout) clearTimeout(searchTimeout);
      if (!resolved) {
        resolved = true;
        resolve(undefined);
      }
      quickPick.dispose();
    });

    quickPick.show();
  });

  return selectedIssue;
}
