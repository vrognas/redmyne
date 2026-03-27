import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  showCreateTaskDialog,
  showEditTaskDialog,
} from "../../../src/kanban/kanban-dialogs";
import type { KanbanTask } from "../../../src/kanban/kanban-state";
import type { Issue } from "../../../src/redmine/models/issue";
import type { IRedmineServer } from "../../../src/redmine/redmine-server-interface";
import * as issuePicker from "../../../src/utilities/issue-picker";

type MockServer = {
  getFilteredIssues: ReturnType<typeof vi.fn>;
  getIssueById: ReturnType<typeof vi.fn>;
  searchIssues: ReturnType<typeof vi.fn>;
  getOpenIssuesForProject: ReturnType<typeof vi.fn>;
  getProjects: ReturnType<typeof vi.fn>;
};

type QuickPickScript = (api: {
  quickPick: vscode.QuickPick<vscode.QuickPickItem>;
  changeValue: (value: string) => void;
  emitSelection: (items: vscode.QuickPickItem[]) => void;
  accept: () => void;
  selectBy: (
    predicate: (item: vscode.QuickPickItem) => boolean
  ) => vscode.QuickPickItem | undefined;
  hide: () => void;
  flush: () => Promise<void>;
}) => void | Promise<void>;

function createIssue(overrides: Partial<Issue> = {}): Issue {
  const base: Issue = {
    id: 1,
    project: { id: 10, name: "Platform" },
    tracker: { id: 1, name: "Task" },
    status: { id: 1, name: "Open", is_closed: false },
    priority: { id: 1, name: "Normal" },
    author: { id: 1, name: "Author" },
    assigned_to: { id: 2, name: "Me" },
    subject: "Issue subject",
    description: "",
    start_date: null,
    due_date: null,
    done_ratio: 0,
    is_private: false,
    estimated_hours: null,
    created_on: "2026-02-01T00:00:00Z",
    updated_on: "2026-02-01T00:00:00Z",
    closed_on: null,
  };
  return {
    ...base,
    ...overrides,
    project: { ...base.project, ...(overrides.project ?? {}) },
    tracker: { ...base.tracker, ...(overrides.tracker ?? {}) },
    status: { ...base.status, ...(overrides.status ?? {}) },
    priority: { ...base.priority, ...(overrides.priority ?? {}) },
    author: { ...base.author, ...(overrides.author ?? {}) },
    assigned_to: { ...base.assigned_to, ...(overrides.assigned_to ?? {}) },
  };
}

function createMockServer(overrides: Partial<MockServer> = {}): MockServer {
  return {
    getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
      issues: filter.status === "open" ? [createIssue({ id: 100 })] : [],
    })),
    getIssueById: vi.fn().mockResolvedValue({
      issue: createIssue({ id: 300, subject: "Exact match" }),
    }),
    searchIssues: vi.fn().mockResolvedValue([]),
    getOpenIssuesForProject: vi.fn().mockResolvedValue({ issues: [] }),
    getProjects: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function createScriptedQuickPick(
  script: QuickPickScript
): vscode.QuickPick<vscode.QuickPickItem> {
  let onDidChangeValue:
    | ((value: string) => void)
    | undefined;
  let onDidAccept:
    | (() => void)
    | undefined;
  let onDidHide:
    | (() => void)
    | undefined;
  let onDidChangeSelection:
    | ((items: readonly vscode.QuickPickItem[]) => void)
    | undefined;

  const quickPick = {
    title: "",
    placeholder: "",
    value: "",
    items: [] as vscode.QuickPickItem[],
    activeItems: [] as vscode.QuickPickItem[],
    selectedItems: [] as vscode.QuickPickItem[],
    canSelectMany: false,
    matchOnDescription: false,
    matchOnDetail: false,
    busy: false,
    sortByLabel: true,
    onDidChangeValue: vi.fn((handler: (value: string) => void) => {
      onDidChangeValue = handler;
      return { dispose: vi.fn() };
    }),
    onDidAccept: vi.fn((handler: () => void) => {
      onDidAccept = handler;
      return { dispose: vi.fn() };
    }),
    onDidChangeSelection: vi.fn(
      (handler: (items: readonly vscode.QuickPickItem[]) => void) => {
        onDidChangeSelection = handler;
        return { dispose: vi.fn() };
      }
    ),
    onDidHide: vi.fn((handler: () => void) => {
      onDidHide = handler;
      return { dispose: vi.fn() };
    }),
    show: vi.fn(() => {
      const api = {
        quickPick: quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>,
        changeValue: (value: string) => {
          onDidChangeValue?.(value);
        },
        emitSelection: (items: vscode.QuickPickItem[]) => {
          quickPick.activeItems = items;
          onDidChangeSelection?.(items);
        },
        accept: () => {
          onDidAccept?.();
        },
        selectBy: (predicate: (item: vscode.QuickPickItem) => boolean) => {
          const selected = quickPick.items.find(predicate);
          if (selected) {
            quickPick.activeItems = [selected];
            onDidChangeSelection?.([selected]);
            onDidAccept?.();
          }
          return selected;
        },
        hide: () => {
          onDidHide?.();
        },
        flush: async () => {
          await Promise.resolve();
          await Promise.resolve();
        },
      };
      void Promise.resolve().then(() => script(api));
    }),
    hide: vi.fn(() => {
      onDidHide?.();
    }),
    dispose: vi.fn(),
  };

  return quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>;
}

function createTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "task-1",
    title: "Initial task",
    priority: "medium",
    linkedIssueId: 10,
    linkedIssueSubject: "Issue 10",
    linkedProjectId: 7,
    linkedProjectName: "Platform",
    loggedHours: 0,
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("kanban-dialogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(issuePicker, "getProjectPathMap").mockResolvedValue(
      new Map([[10, "Client: Platform"]])
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined when initial issue fetch fails", async () => {
    const server = createMockServer({
      getFilteredIssues: vi.fn().mockRejectedValue(new Error("boom")),
    });

    const result = await showCreateTaskDialog(server as unknown as IRedmineServer);

    expect(result).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to fetch issues: Error: boom"
    );
  });

  it("creates task with selected issue, parent project and parsed fields", async () => {
    const linkedIssue = createIssue({
      id: 222,
      subject: "Link me",
      project: { id: 10, name: "Platform" },
    });
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [linkedIssue] : [],
      })),
      getProjects: vi.fn().mockResolvedValue([
        { id: 10, parent: { id: 5, name: "Programs" } },
      ]),
    });

    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() =>
      createScriptedQuickPick(({ selectBy }) => {
        selectBy((item) => Boolean((item as { issue?: Issue }).issue));
      }) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce("  Build tests  ")
      .mockResolvedValueOnce("1.5");
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: "$(arrow-up) High",
      priority: "high",
    } as never);

    const result = await showCreateTaskDialog(server as unknown as IRedmineServer);

    expect(result).toEqual({
      title: "Build tests",
      linkedIssueId: 222,
      linkedIssueSubject: "Link me",
      linkedProjectId: 10,
      linkedProjectName: "Platform",
      linkedParentProjectId: 5,
      linkedParentProjectName: "Programs",
      priority: "high",
      estimatedHours: 1.5,
    });
  });

  it("uses defaults when priority omitted and parent lookup fails", async () => {
    const linkedIssue = createIssue({
      id: 223,
      subject: "Default flow",
      project: { id: 10, name: "Platform" },
    });
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [linkedIssue] : [],
      })),
      getProjects: vi.fn().mockRejectedValue(new Error("offline")),
    });

    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() =>
      createScriptedQuickPick(({ selectBy }) => {
        selectBy((item) => Boolean((item as { issue?: Issue }).issue));
      }) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce("Task title")
      .mockResolvedValueOnce("");
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    const result = await showCreateTaskDialog(server as unknown as IRedmineServer);

    expect(result).toEqual({
      title: "Task title",
      linkedIssueId: 223,
      linkedIssueSubject: "Default flow",
      linkedProjectId: 10,
      linkedProjectName: "Platform",
      linkedParentProjectId: undefined,
      linkedParentProjectName: undefined,
      priority: "medium",
      estimatedHours: undefined,
    });
  });

  it("handles selected issue without project/assignee metadata", async () => {
    const sparseIssue = {
      ...createIssue({ id: 224, subject: "Sparse issue" }),
      project: undefined,
      assigned_to: undefined,
    } as unknown as Issue;
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [sparseIssue] : [],
      })),
    });

    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() =>
      createScriptedQuickPick(({ selectBy }) => {
        selectBy((item) => Boolean((item as { issue?: Issue }).issue));
      }) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce("Sparse task")
      .mockResolvedValueOnce("");
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

    const result = await showCreateTaskDialog(server as unknown as IRedmineServer);
    expect(result).toMatchObject({
      linkedProjectId: 0,
      linkedProjectName: "Unknown",
      priority: "medium",
    });
    expect(server.getProjects).not.toHaveBeenCalled();
  });

  it("showEditTaskDialog handles cancel points and valid output", async () => {
    const task = createTask();

    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
    expect(await showEditTaskDialog(task)).toBeUndefined();

    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("Edited");
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);
    expect(await showEditTaskDialog(task)).toBeUndefined();

    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce("  Final title  ")
      .mockResolvedValueOnce("");
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: "Low",
      priority: "low",
    } as never);
    expect(await showEditTaskDialog(task)).toEqual({
      title: "Final title",
      priority: "low",
      estimatedHours: undefined,
    });

    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce("Again")
      .mockResolvedValueOnce(undefined);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: "High",
      priority: "high",
    } as never);
    expect(await showEditTaskDialog(task)).toBeUndefined();
  });

  it("validates create/edit dialog input rules", async () => {
    const linkedIssue = createIssue({ id: 224, subject: "Validation", project: { id: 10, name: "Platform" } });
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [linkedIssue] : [],
      })),
    });

    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() =>
      createScriptedQuickPick(({ selectBy }) => {
        selectBy((item) => Boolean((item as { issue?: Issue }).issue));
      }) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce("Valid title")
      .mockResolvedValueOnce("2");
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);
    await showCreateTaskDialog(server as unknown as IRedmineServer);

    const createTitleOptions = vi.mocked(vscode.window.showInputBox).mock.calls[0][0] as {
      validateInput?: (value: string) => string | undefined;
    };
    const createHoursOptions = vi.mocked(vscode.window.showInputBox).mock.calls[1][0] as {
      validateInput?: (value: string) => string | undefined;
    };
    expect(createTitleOptions.validateInput?.("   ")).toBe("Title is required");
    expect(createTitleOptions.validateInput?.("ok")).toBeUndefined();
    expect(createHoursOptions.validateInput?.("")).toBeUndefined();
    expect(createHoursOptions.validateInput?.("-1")).toBe("Enter a positive number");
    expect(createHoursOptions.validateInput?.("bad")).toBe("Enter a positive number");
    expect(createHoursOptions.validateInput?.("1.25")).toBeUndefined();

    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce("Edited")
      .mockResolvedValueOnce("3");
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: "Medium",
      priority: "medium",
    } as never);
    await showEditTaskDialog(createTask());

    const editTitleOptions = vi.mocked(vscode.window.showInputBox).mock.calls[2][0] as {
      validateInput?: (value: string) => string | undefined;
    };
    const editHoursOptions = vi.mocked(vscode.window.showInputBox).mock.calls[3][0] as {
      validateInput?: (value: string) => string | undefined;
    };
    expect(editTitleOptions.validateInput?.(" ")).toBe("Title is required");
    expect(editTitleOptions.validateInput?.("done")).toBeUndefined();
    expect(editHoursOptions.validateInput?.("")).toBeUndefined();
    expect(editHoursOptions.validateInput?.("0")).toBe("Enter a positive number");
    expect(editHoursOptions.validateInput?.("2")).toBeUndefined();
  });

  it("searches exact numeric ID and proceeds to title prompt", async () => {
    vi.useFakeTimers();
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [createIssue({ id: 10 })] : [],
      })),
      getIssueById: vi.fn().mockResolvedValue({
        issue: createIssue({ id: 321, subject: "Exact by id" }),
      }),
      searchIssues: vi.fn().mockResolvedValue([]),
    });

    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() =>
      createScriptedQuickPick(async ({ changeValue, selectBy, hide, flush }) => {
        changeValue("#321");
        vi.advanceTimersByTime(300);
        await flush();
        await flush();
        const selected = selectBy(
          (item) =>
            ((item as { issue?: Issue }).issue?.id ?? 0) === 321
        );
        if (!selected) hide();
      }) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

    const result = await showCreateTaskDialog(server as unknown as IRedmineServer);

    expect(result).toBeUndefined();
    expect(server.getIssueById).toHaveBeenCalledWith(321);
    expect(server.searchIssues).toHaveBeenCalledWith("#321", 25);
    expect(vscode.window.showInputBox).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Task title (subtask of #321)",
      })
    );
  });

  it("shows disabled warning for inaccessible numeric issue and cancels cleanly", async () => {
    vi.useFakeTimers();
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [createIssue({ id: 10 })] : [],
      })),
      getIssueById: vi.fn().mockRejectedValue(new Error("403 forbidden")),
      searchIssues: vi.fn().mockResolvedValue([]),
    });
    let warningItemSeen = false;

    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() =>
      createScriptedQuickPick(async ({ changeValue, selectBy, hide, flush, quickPick }) => {
        changeValue("999");
        vi.advanceTimersByTime(300);
        await flush();
        await flush();
        warningItemSeen = quickPick.items.some(
          (item) =>
            (item as { disabled?: boolean }).disabled === true &&
            (item.description ?? "").includes("don't have access")
        );
        selectBy((item) => (item as { disabled?: boolean }).disabled === true);
        hide();
      }) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const result = await showCreateTaskDialog(server as unknown as IRedmineServer);

    expect(result).toBeUndefined();
    expect(server.getIssueById).toHaveBeenCalledWith(999);
    expect(warningItemSeen).toBe(true);
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });

  it("shows not-found warning for 404 exact numeric lookup", async () => {
    vi.useFakeTimers();
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [createIssue({ id: 10 })] : [],
      })),
      getIssueById: vi.fn().mockRejectedValue(new Error("404 not found")),
      searchIssues: vi.fn().mockResolvedValue([]),
    });
    let warningNotFoundSeen = false;

    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() =>
      createScriptedQuickPick(async ({ changeValue, hide, flush, quickPick }) => {
        changeValue("404");
        vi.advanceTimersByTime(300);
        await flush();
        await flush();
        warningNotFoundSeen = quickPick.items.some(
          (item) => (item.description ?? "").includes("Issue not found")
        );
        hide();
      }) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const result = await showCreateTaskDialog(server as unknown as IRedmineServer);
    expect(result).toBeUndefined();
    expect(warningNotFoundSeen).toBe(true);
  });

  it("ignores non-Error exact ID lookup failures", async () => {
    vi.useFakeTimers();
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [createIssue({ id: 10 })] : [],
      })),
      getIssueById: vi.fn().mockRejectedValue("boom"),
      searchIssues: vi.fn().mockResolvedValue([]),
    });

    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() =>
      createScriptedQuickPick(async ({ changeValue, hide, flush }) => {
        changeValue("777");
        vi.advanceTimersByTime(300);
        await flush();
        await flush();
        hide();
      }) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const result = await showCreateTaskDialog(server as unknown as IRedmineServer);
    expect(result).toBeUndefined();
  });

  it("ignores short query and non-issue separator selection", async () => {
    vi.useFakeTimers();
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues:
          filter.status === "open"
            ? [createIssue({ id: 111 })]
            : [createIssue({ id: 222, status: { id: 2, name: "Closed", is_closed: true } })],
      })),
      searchIssues: vi.fn().mockResolvedValue([createIssue({ id: 333, subject: "Result" })]),
    });

    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() =>
      createScriptedQuickPick(async ({ changeValue, selectBy, hide, flush }) => {
        changeValue("a");
        vi.advanceTimersByTime(300);
        await flush();

        changeValue("ab");
        vi.advanceTimersByTime(300);
        await flush();
        await flush();

        selectBy((item) => item.label === "");
        hide();
      }) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const result = await showCreateTaskDialog(server as unknown as IRedmineServer);
    expect(result).toBeUndefined();
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });

  it("splits multi-token search and fetches project issues", async () => {
    vi.useFakeTimers();
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues:
          filter.status === "open"
            ? [createIssue({ id: 10, subject: "My open", project: { id: 10, name: "Platform" } })]
            : [createIssue({ id: 20, subject: "My closed", status: { id: 5, name: "Closed", is_closed: true } })],
      })),
      searchIssues: vi
        .fn()
        .mockResolvedValueOnce([
          createIssue({ id: 10, subject: "Duplicate of displayed issue" }),
          createIssue({ id: 30, subject: "Token result A" }),
        ])
        .mockResolvedValueOnce([createIssue({ id: 40, subject: "Token result B" })]),
      getOpenIssuesForProject: vi.fn().mockResolvedValue({
        issues: [createIssue({ id: 50, subject: "Project result" })],
      }),
    });
    vi.mocked(issuePicker.getProjectPathMap).mockResolvedValue(
      new Map([
        [10, "Client Platform"],
        [99, "Other Program"],
      ])
    );

    let projectResultCount = 0;
    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() =>
      createScriptedQuickPick(async ({ changeValue, selectBy, flush, quickPick }) => {
        changeValue("client api");
        vi.advanceTimersByTime(300);
        await flush();

        projectResultCount = quickPick.items.filter(
          (item) => ((item as { issue?: Issue }).issue?.id ?? 0) === 50
        ).length;

        selectBy(
          (item) => ((item as { issue?: Issue }).issue?.id ?? 0) === 50
        );
      }) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

    await showCreateTaskDialog(server as unknown as IRedmineServer);

    expect(server.searchIssues).toHaveBeenCalledTimes(2);
    expect(server.searchIssues).toHaveBeenCalledWith("client", 15);
    expect(server.searchIssues).toHaveBeenCalledWith("api", 15);
    expect(server.getOpenIssuesForProject).toHaveBeenCalledWith(
      10,
      true,
      30,
      false
    );
    expect(projectResultCount).toBe(1);
  });

  it("caps search result list to 50 items", async () => {
    vi.useFakeTimers();
    const manyIssues = Array.from({ length: 80 }, (_, i) =>
      createIssue({
        id: 1000 + i,
        subject: `Bulk ${i}`,
        project: { id: 10, name: "Platform" },
      })
    );
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [createIssue({ id: 10 })] : [],
      })),
      searchIssues: vi.fn().mockResolvedValue(manyIssues),
    });

    let resultItemsCount = 0;
    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() =>
      createScriptedQuickPick(async ({ changeValue, selectBy, hide, flush, quickPick }) => {
        changeValue("bulk");
        vi.advanceTimersByTime(300);
        await flush();
        await flush();

        const separatorIndex = quickPick.items.findIndex((item) => item.label === "");
        resultItemsCount = separatorIndex >= 0 ? separatorIndex : quickPick.items.length;

        const selected = selectBy(
          (item) => ((item as { issue?: Issue }).issue?.id ?? 0) === 1000
        );
        if (!selected) hide();
      }) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

    await showCreateTaskDialog(server as unknown as IRedmineServer);
    expect(resultItemsCount).toBe(50);
  });

  it("drops stale search response when newer query supersedes it", async () => {
    vi.useFakeTimers();
    let resolveAlpha: ((issues: Issue[]) => void) | undefined;
    const alphaPromise = new Promise<Issue[]>((resolve) => {
      resolveAlpha = resolve;
    });
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [createIssue({ id: 111 })] : [],
      })),
      searchIssues: vi.fn((query: string) => {
        if (query === "alpha") return alphaPromise;
        return Promise.resolve([createIssue({ id: 444, subject: "Beta result" })]);
      }),
    });

    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() =>
      createScriptedQuickPick(async ({ changeValue, selectBy, hide, flush }) => {
        changeValue("alpha");
        vi.advanceTimersByTime(300);
        await flush();

        changeValue("beta");
        vi.advanceTimersByTime(300);
        await flush();
        await flush();

        resolveAlpha?.([createIssue({ id: 555, subject: "Late alpha result" })]);
        await flush();
        await flush();

        const selected = selectBy(
          (item) => ((item as { issue?: Issue }).issue?.id ?? 0) === 444
        );
        if (!selected) hide();
      }) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

    await showCreateTaskDialog(server as unknown as IRedmineServer);
    expect(server.searchIssues).toHaveBeenCalledWith("alpha", 25);
    expect(server.searchIssues).toHaveBeenCalledWith("beta", 25);
  });

  it("handles accept/selection no-op branches and hide after resolve", async () => {
    vi.useFakeTimers();
    const sparseSearchIssue = {
      ...createIssue({ id: 901, subject: "Sparse result" }),
      status: undefined,
      assigned_to: undefined,
      project: undefined,
    } as unknown as Issue;
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [createIssue({ id: 111 })] : [],
      })),
      searchIssues: vi.fn().mockResolvedValue([sparseSearchIssue]),
    });

    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() =>
      createScriptedQuickPick(async ({ accept, emitSelection, changeValue, selectBy, hide, flush }) => {
        emitSelection([]);
        accept();
        changeValue("sparse");
        vi.advanceTimersByTime(300);
        await flush();
        await flush();

        const selected = selectBy(
          (item) => ((item as { issue?: Issue }).issue?.id ?? 0) === 901
        );
        if (!selected) hide();
        hide();
      }) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

    const result = await showCreateTaskDialog(server as unknown as IRedmineServer);
    expect(result).toBeUndefined();
  });

  it("clearing search query restores local item list", async () => {
    vi.useFakeTimers();
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues:
          filter.status === "open"
            ? [createIssue({ id: 111 })]
            : [createIssue({ id: 222, status: { id: 2, name: "Closed", is_closed: true } })],
      })),
      searchIssues: vi
        .fn()
        .mockResolvedValue([createIssue({ id: 333, subject: "Search result" })]),
    });
    let initialCount = 0;
    let searchedCount = 0;
    let resetCount = 0;

    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() =>
      createScriptedQuickPick(async ({ changeValue, selectBy, flush, quickPick }) => {
        initialCount = quickPick.items.length;
        changeValue("search");
        vi.advanceTimersByTime(300);
        await flush();
        searchedCount = quickPick.items.length;
        changeValue("");
        resetCount = quickPick.items.length;
        selectBy((item) => ((item as { issue?: Issue }).issue?.id ?? 0) === 111);
      }) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

    await showCreateTaskDialog(server as unknown as IRedmineServer);

    expect(searchedCount).toBeGreaterThan(initialCount);
    expect(resetCount).toBe(initialCount);
  });
});
