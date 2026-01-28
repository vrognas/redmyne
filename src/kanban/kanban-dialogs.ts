import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { KanbanTask, TaskPriority } from "./kanban-state";
import { Issue } from "../redmine/models/issue";
import { debounce } from "../utilities/debounce";
import { getProjectPathMap } from "../utilities/issue-picker";

const SEARCH_DEBOUNCE_MS = 300;

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
  linkedParentProjectId?: number;
  linkedParentProjectName?: string;
  description?: string;
  priority: TaskPriority;
  estimatedHours?: number;
}

/**
 * Show dialog to create a new kanban task
 */
export async function showCreateTaskDialog(
  server: RedmineServer
): Promise<CreateTaskResult | undefined> {
  // 1. Pick linked issue (required)
  const selectedIssue = await pickIssueForTask(server);
  if (!selectedIssue) return undefined;

  // 2. Enter title (required)
  const title = await vscode.window.showInputBox({
    title: "Create Kanban Task",
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
      title: "Create Kanban Task",
      placeHolder: "Priority (default: Medium)",
    }
  );
  const priority = priorityItem?.priority ?? "medium";

  // 4. Estimated hours (optional)
  const hoursStr = await vscode.window.showInputBox({
    title: "Create Kanban Task",
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

  // Look up parent project from cached projects
  let linkedParentProjectId: number | undefined;
  let linkedParentProjectName: string | undefined;
  const projectId = selectedIssue.project?.id;
  if (projectId) {
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

  return {
    title: title.trim(),
    linkedIssueId: selectedIssue.id,
    linkedIssueSubject: selectedIssue.subject,
    linkedProjectId: selectedIssue.project?.id ?? 0,
    linkedProjectName: selectedIssue.project?.name ?? "Unknown",
    linkedParentProjectId,
    linkedParentProjectName,
    priority,
    estimatedHours,
  };
}

/**
 * Show dialog to edit an existing task
 */
export async function showEditTaskDialog(
  task: KanbanTask
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
  // Fetch my issues + project map in parallel (uses cached project map)
  let myOpenIssues: Issue[];
  let myClosedIssues: Issue[];
  let projectPathMap: Map<number, string>;
  try {
    const [openResult, closedResult, pathMap] = await Promise.all([
      server.getFilteredIssues({ assignee: "me", status: "open" }),
      server.getFilteredIssues({ assignee: "me", status: "closed" }),
      getProjectPathMap(server),
    ]);
    myOpenIssues = openResult.issues;
    myClosedIssues = closedResult.issues;
    projectPathMap = pathMap;
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to fetch issues: ${error}`);
    return undefined;
  }
  const issues = [...myOpenIssues, ...myClosedIssues];
  const myIssueIds = new Set(issues.map(i => i.id));

  // Build items with status labels (use full project path for parent matching)
  const items: IssueQuickPickItem[] = [
    ...myOpenIssues.map((issue) => ({
      label: `#${issue.id} ${issue.subject}`,
      description: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name,
      issue,
    })),
    ...myClosedIssues.slice(0, 20).map((issue) => ({
      label: `$(archive) #${issue.id} ${issue.subject}`,
      description: `${projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name} (closed)`,
      issue,
    })),
  ];

  const selectedIssue = await new Promise<Issue | undefined>((resolve) => {
    const quickPick = vscode.window.createQuickPick<IssueQuickPickItem>();
    quickPick.title = "Link to Redmine Issue";
    quickPick.placeholder = "Type to search, or select from list";
    quickPick.items = items;
    quickPick.matchOnDescription = true;

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

    const debouncedSearch = debounce(SEARCH_DEBOUNCE_MS, async (query: string) => {
      if (query.length < 2) return;

      const thisSearchVersion = ++searchVersion;
      quickPick.busy = true;

      try {
        // Check if query is a numeric ID
        const cleanQuery = query.replace(/^#/, "");
        const possibleId = parseInt(cleanQuery, 10);
        const isNumericQuery = !isNaN(possibleId) && cleanQuery === String(possibleId);

        // Find projects matching query tokens (for project-name search)
        const queryTokens = query.trim().split(/\s+/).filter(t => t.length >= 2);
        const matchingProjectIds: number[] = [];
        for (const token of queryTokens) {
          const lowerToken = token.toLowerCase();
          for (const [projectId, path] of projectPathMap.entries()) {
            if (path.toLowerCase().includes(lowerToken) && !matchingProjectIds.includes(projectId)) {
              matchingProjectIds.push(projectId);
            }
          }
        }

        // Parallel: exact ID lookup + text search + project issues
        const projectIssueResults: Issue[] = [];
        const [exactIssue, searchResults] = await Promise.all([
          isNumericQuery
            ? server.getIssueById(possibleId).then(r => r.issue).catch(() => null)
            : Promise.resolve(null),
          server.searchIssues(query, 25),
          // Fetch issues from matching projects (include subprojects + closed)
          ...matchingProjectIds.slice(0, 8).map(async (projectId) => {
            try {
              const result = await server.getOpenIssuesForProject(projectId, true, 30, false);
              projectIssueResults.push(...result.issues);
            } catch { /* ignore */ }
          }),
        ]);

        if (thisSearchVersion !== searchVersion || resolved) return;

        // Combine and rank results: mine+open > mine+closed > other+open > other+closed
        const allResults = [...searchResults, ...projectIssueResults];
        allResults.sort((a, b) => {
          const aIsMine = myIssueIds.has(a.id) ? 0 : 1;
          const bIsMine = myIssueIds.has(b.id) ? 0 : 1;
          const aIsClosed = (a.status?.is_closed ?? false) ? 0.5 : 0;
          const bIsClosed = (b.status?.is_closed ?? false) ? 0.5 : 0;
          return (aIsMine + aIsClosed) - (bIsMine + bIsClosed);
        });
        const seenIds = new Set(issues.map((i) => i.id));
        const resultItems: IssueQuickPickItem[] = [];

        // Add exact match first if found
        if (exactIssue && !seenIds.has(exactIssue.id)) {
          const isClosed = exactIssue.status?.is_closed ?? false;
          const isMine = myIssueIds.has(exactIssue.id);
          const icon = isClosed ? "$(archive)" : isMine ? "$(account)" : "$(search)";
          const tags: string[] = [];
          if (!isMine) tags.push("not mine");
          if (isClosed) tags.push("closed");
          const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
          resultItems.push({
            label: `${icon} #${exactIssue.id} ${exactIssue.subject}`,
            description: `${projectPathMap.get(exactIssue.project?.id ?? 0) ?? exactIssue.project?.name}${tagStr}`,
            issue: exactIssue,
          });
          seenIds.add(exactIssue.id);
        }

        // Add search results with labels
        for (const issue of allResults) {
          if (!seenIds.has(issue.id)) {
            const isMine = myIssueIds.has(issue.id);
            const isClosed = issue.status?.is_closed ?? false;
            const icon = isClosed ? "$(archive)" : isMine ? "$(account)" : "$(search)";
            const tags: string[] = [];
            if (!isMine) tags.push("not mine");
            if (isClosed) tags.push("closed");
            const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
            resultItems.push({
              label: `${icon} #${issue.id} ${issue.subject}`,
              description: `${projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name}${tagStr}`,
              issue,
            });
            seenIds.add(issue.id);
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
    });

    quickPick.onDidChangeValue((value) => {
      const query = value.trim();
      if (!query) {
        debouncedSearch.cancel();
        quickPick.items = items;
        return;
      }
      debouncedSearch(query);
    });

    quickPick.onDidAccept(() => {
      const selected = quickPick.activeItems[0];
      if (selected) handleSelection(selected);
    });

    quickPick.onDidChangeSelection((sel) => {
      if (sel.length > 0) handleSelection(sel[0]);
    });

    quickPick.onDidHide(() => {
      debouncedSearch.cancel();
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
