import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { Issue } from "../../../src/redmine/models/issue";
import type { TimeEntryActivity } from "../../../src/redmine/models/common";
import type { RedmineServer } from "../../../src/redmine/redmine-server";
import { RedmineProject } from "../../../src/redmine/redmine-project";

type MockServer = {
  options: { address: string };
  getProjects: ReturnType<typeof vi.fn>;
  getIssuesAssignedToMe: ReturnType<typeof vi.fn>;
  getFilteredIssues: ReturnType<typeof vi.fn>;
  isTimeTrackingEnabled: ReturnType<typeof vi.fn>;
  getProjectTimeEntryActivities: ReturnType<typeof vi.fn>;
  getIssueById: ReturnType<typeof vi.fn>;
  searchIssues: ReturnType<typeof vi.fn>;
  getOpenIssuesForProject: ReturnType<typeof vi.fn>;
};

function createProject(
  id: number,
  name: string,
  parent?: { id: number; name: string }
): RedmineProject {
  return new RedmineProject({
    id,
    name,
    description: "",
    identifier: `p-${id}`,
    parent,
  });
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  const base: Issue = {
    id: 1,
    project: { id: 10, name: "Project A" },
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
    created_on: "2026-01-01T00:00:00Z",
    updated_on: "2026-01-01T00:00:00Z",
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
  const server: MockServer = {
    options: { address: "https://redmine.local" },
    getProjects: vi.fn().mockResolvedValue([]),
    getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [] }),
    getFilteredIssues: vi.fn().mockResolvedValue({ issues: [] }),
    isTimeTrackingEnabled: vi.fn().mockResolvedValue(true),
    getProjectTimeEntryActivities: vi.fn().mockResolvedValue([]),
    getIssueById: vi.fn().mockResolvedValue({ issue: createIssue() }),
    searchIssues: vi.fn().mockResolvedValue([]),
    getOpenIssuesForProject: vi.fn().mockResolvedValue({ issues: [] }),
  };
  return { ...server, ...overrides };
}

function createAutoSelectQuickPick(
  pickItem: (items: readonly vscode.QuickPickItem[]) => vscode.QuickPickItem | undefined
): vscode.QuickPick<vscode.QuickPickItem> {
  let onDidChangeSelection:
    | ((items: readonly vscode.QuickPickItem[]) => void)
    | undefined;
  let onDidAccept: (() => void) | undefined;
  let onDidHide: (() => void) | undefined;

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
    onDidChangeValue: vi.fn(() => ({ dispose: vi.fn() })),
    onDidAccept: vi.fn((handler: () => void) => {
      onDidAccept = handler;
      return { dispose: vi.fn() };
    }),
    onDidChangeSelection: vi.fn((handler: (items: readonly vscode.QuickPickItem[]) => void) => {
      onDidChangeSelection = handler;
      return { dispose: vi.fn() };
    }),
    onDidHide: vi.fn((handler: () => void) => {
      onDidHide = handler;
      return { dispose: vi.fn() };
    }),
    show: vi.fn(() => {
      const selected = pickItem(quickPick.items);
      if (!selected) {
        onDidHide?.();
        return;
      }
      quickPick.activeItems = [selected];
      onDidChangeSelection?.([selected]);
      onDidAccept?.();
    }),
    hide: vi.fn(() => {
      onDidHide?.();
    }),
    dispose: vi.fn(),
  };

  return quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>;
}

type ControlledQuickPick = vscode.QuickPick<vscode.QuickPickItem> & {
  triggerValue: (value: string) => void;
  triggerSelection: (
    pickItem: (items: readonly vscode.QuickPickItem[]) => vscode.QuickPickItem | undefined
  ) => boolean;
  triggerHide: () => void;
};

function createControlledQuickPick(): ControlledQuickPick {
  let onDidChangeValue: ((value: string) => void) | undefined;
  let onDidChangeSelection:
    | ((items: readonly vscode.QuickPickItem[]) => void)
    | undefined;
  let onDidAccept: (() => void) | undefined;
  let onDidHide: (() => void) | undefined;

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
    onDidChangeSelection: vi.fn((handler: (items: readonly vscode.QuickPickItem[]) => void) => {
      onDidChangeSelection = handler;
      return { dispose: vi.fn() };
    }),
    onDidHide: vi.fn((handler: () => void) => {
      onDidHide = handler;
      return { dispose: vi.fn() };
    }),
    show: vi.fn(),
    hide: vi.fn(() => {
      onDidHide?.();
    }),
    dispose: vi.fn(),
    triggerValue: (value: string) => {
      quickPick.value = value;
      onDidChangeValue?.(value);
    },
    triggerSelection: (
      pickItem: (items: readonly vscode.QuickPickItem[]) => vscode.QuickPickItem | undefined
    ): boolean => {
      const selected = pickItem(quickPick.items);
      if (!selected) return false;
      quickPick.activeItems = [selected];
      onDidChangeSelection?.([selected]);
      onDidAccept?.();
      return true;
    },
    triggerHide: () => {
      onDidHide?.();
    },
  };

  return quickPick as unknown as ControlledQuickPick;
}

async function flushMicrotasks(iterations = 12): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

const pickFirstEnabledIssue = (
  items: readonly vscode.QuickPickItem[]
): vscode.QuickPickItem | undefined =>
  items.find((item) => {
    const candidate = item as { issue?: Issue; disabled?: boolean };
    return Boolean(candidate.issue) && candidate.disabled !== true;
  });

const pickSkipAction = (
  items: readonly vscode.QuickPickItem[]
): vscode.QuickPickItem | undefined =>
  items.find((item) => {
    const candidate = item as { action?: string };
    return candidate.action === "skip";
  });

describe("issue-picker", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("buildProjectPathMap builds root + nested separators", async () => {
    const { buildProjectPathMap } = await import("../../../src/utilities/issue-picker");
    const projects = [
      createProject(1, "Client"),
      createProject(2, "Program", { id: 1, name: "Client" }),
      createProject(3, "Feature", { id: 2, name: "Program" }),
    ];

    const map = buildProjectPathMap(projects);

    expect(map.get(1)).toBe("Client");
    expect(map.get(2)).toBe("Client: Program");
    expect(map.get(3)).toBe("Client: Program / Feature");
  });

  it("buildProjectPathMap reuses cached parent path for sibling branches", async () => {
    const { buildProjectPathMap } = await import("../../../src/utilities/issue-picker");
    const projects = [
      createProject(1, "Client"),
      createProject(2, "Platform", { id: 1, name: "Client" }),
      createProject(3, "Billing", { id: 1, name: "Client" }),
    ];

    const map = buildProjectPathMap(projects);

    expect(map.get(2)).toBe("Client: Platform");
    expect(map.get(3)).toBe("Client: Billing");
  });

  it("getProjectPathMap reuses cache and falls back to cached map after refresh error", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);

    const { getProjectPathMap } = await import("../../../src/utilities/issue-picker");
    const projects = [createProject(11, "Alpha")];
    const server = createMockServer({
      getProjects: vi.fn().mockResolvedValue(projects),
    });

    const first = await getProjectPathMap(server as unknown as RedmineServer);

    nowSpy.mockReturnValue(1_300_001);
    server.getProjects.mockRejectedValueOnce(new Error("network fail"));
    const second = await getProjectPathMap(server as unknown as RedmineServer);

    expect(server.getProjects).toHaveBeenCalledTimes(2);
    expect(second).toBe(first);
    expect(second.get(11)).toBe("Alpha");
  });

  it("getProjectPathMap cache resets on module reload", async () => {
    const moduleA = await import("../../../src/utilities/issue-picker");
    const seededServer = createMockServer({
      getProjects: vi.fn().mockResolvedValue([createProject(99, "Seed")]),
    });
    const seeded = await moduleA.getProjectPathMap(seededServer as unknown as RedmineServer);
    expect(seeded.get(99)).toBe("Seed");

    vi.resetModules();
    const moduleB = await import("../../../src/utilities/issue-picker");
    const failingServer = createMockServer({
      getProjects: vi.fn().mockRejectedValue(new Error("boom")),
    });

    const fresh = await moduleB.getProjectPathMap(failingServer as unknown as RedmineServer);
    expect(fresh.size).toBe(0);
  });

  it("pickIssue returns selected issue and records recents", async () => {
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    const recordRecentIssueSpy = vi
      .spyOn(recentIssues, "recordRecentIssue")
      .mockImplementation(() => {});

    const { pickIssue } = await import("../../../src/utilities/issue-picker");
    const selectedIssue = createIssue({
      id: 321,
      subject: "Assigned work",
      project: { id: 55, name: "Delivery" },
    });
    const server = createMockServer({
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [selectedIssue] }),
      getProjects: vi.fn().mockResolvedValue([createProject(55, "Delivery")]),
      isTimeTrackingEnabled: vi.fn().mockResolvedValue(true),
    });

    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(() =>
      createAutoSelectQuickPick(pickFirstEnabledIssue) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const result = await pickIssue(server as unknown as RedmineServer, "Pick issue");

    expect(result?.id).toBe(321);
    expect(server.isTimeTrackingEnabled).toHaveBeenCalledWith(55);
    expect(recordRecentIssueSpy).toHaveBeenCalledWith(321, "Assigned work", "Delivery");
  });

  it("pickIssueWithSearch returns issue + activity payload", async () => {
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const { pickIssueWithSearch } = await import("../../../src/utilities/issue-picker");
    const selectedIssue = createIssue({
      id: 777,
      subject: "Fix API",
      project: { id: 88, name: "Platform" },
    });
    const selectedActivity: TimeEntryActivity = { id: 4, name: "Development" };

    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [selectedIssue] : [],
      })),
      getProjects: vi.fn().mockResolvedValue([createProject(88, "Platform")]),
      isTimeTrackingEnabled: vi.fn().mockResolvedValue(true),
      getIssueById: vi.fn().mockResolvedValue({ issue: selectedIssue }),
      getProjectTimeEntryActivities: vi.fn().mockResolvedValue([selectedActivity]),
    });

    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(() =>
      createAutoSelectQuickPick(pickFirstEnabledIssue) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );
    vi.spyOn(vscodeApi.window, "showQuickPick").mockResolvedValue({
      label: selectedActivity.name,
      activity: selectedActivity,
    } as unknown as vscode.QuickPickItem);

    const result = await pickIssueWithSearch(server as unknown as RedmineServer, "Pick issue/activity");

    expect(result).toEqual({
      issueId: 777,
      issueSubject: "Fix API",
      activityId: 4,
      activityName: "Development",
    });
    expect(server.getIssueById).toHaveBeenCalledWith(777);
    expect(server.getProjectTimeEntryActivities).toHaveBeenCalledWith(88);
  });

  it("pickIssueWithSearch builds grouped base sections for recent/open/closed/non-trackable", async () => {
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([1001]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const quickPick = createControlledQuickPick();
    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(
      () => quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const openRecent = createIssue({
      id: 1001,
      subject: "Recent open",
      project: { id: 201, name: "Core" },
      status: { id: 1, name: "Open", is_closed: false },
    });
    const openOther = createIssue({
      id: 1002,
      subject: "Other open",
      project: { id: 201, name: "Core" },
      status: { id: 1, name: "Open", is_closed: false },
    });
    const closedTrackable = createIssue({
      id: 1003,
      subject: "Closed tracked",
      project: { id: 201, name: "Core" },
      status: { id: 5, name: "Closed", is_closed: true },
    });
    const nonTrackable = createIssue({
      id: 1004,
      subject: "No tracking",
      project: { id: 202, name: "Ops" },
      status: { id: 1, name: "Open", is_closed: false },
    });

    const { pickIssueWithSearch } = await import("../../../src/utilities/issue-picker");
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [openRecent, openOther, nonTrackable] : [closedTrackable],
      })),
      getProjects: vi.fn().mockResolvedValue([
        createProject(201, "Core"),
        createProject(202, "Ops"),
      ]),
      isTimeTrackingEnabled: vi.fn(async (projectId: number) => projectId === 201),
    });

    const pending = pickIssueWithSearch(server as unknown as RedmineServer, "Pick issue/activity");
    await flushMicrotasks();

    const labels = quickPick.items.map((i) => i.label);
    expect(labels).toContain("Recent");
    expect(labels).toContain("My Open");
    expect(labels).toContain("My Closed");
    expect(labels).toContain("No Time Tracking");

    quickPick.triggerHide();
    await expect(pending).resolves.toBeUndefined();
  });

  it("pickIssueWithSearch shows error when fetching my issues fails", async () => {
    const vscodeApi = await import("vscode");
    const { pickIssueWithSearch } = await import("../../../src/utilities/issue-picker");
    const server = createMockServer({
      getFilteredIssues: vi.fn().mockRejectedValue(new Error("issues down")),
    });

    const result = await pickIssueWithSearch(server as unknown as RedmineServer, "Pick issue/activity");

    expect(result).toBeUndefined();
    expect(vscodeApi.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to fetch issues: Error: issues down"
    );
  });

  it("pickActivityForProject returns selected activity", async () => {
    const vscodeApi = await import("vscode");
    const { pickActivityForProject } = await import("../../../src/utilities/issue-picker");
    const selectedActivity: TimeEntryActivity = { id: 5, name: "Review", is_default: true };
    const server = createMockServer({
      isTimeTrackingEnabled: vi.fn().mockResolvedValue(true),
      getProjectTimeEntryActivities: vi.fn().mockResolvedValue([selectedActivity]),
    });

    vi.spyOn(vscodeApi.window, "showQuickPick").mockResolvedValue({
      label: selectedActivity.name,
      activity: selectedActivity,
    } as unknown as vscode.QuickPickItem);

    const result = await pickActivityForProject(
      server as unknown as RedmineServer,
      123,
      "Pick activity",
      "#777"
    );

    expect(result).toEqual({ activityId: 5, activityName: "Review" });
    expect(server.isTimeTrackingEnabled).toHaveBeenCalledWith(123);
    expect(vscodeApi.window.showQuickPick).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ placeHolder: "Activity for #777" })
    );
  });

  it("pickIssueWithSearch returns skip when skip option selected", async () => {
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const { pickIssueWithSearch } = await import("../../../src/utilities/issue-picker");
    const server = createMockServer({
      getFilteredIssues: vi.fn().mockResolvedValue({ issues: [] }),
      getProjects: vi.fn().mockResolvedValue([]),
    });

    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(() =>
      createAutoSelectQuickPick(pickSkipAction) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const result = await pickIssueWithSearch(
      server as unknown as RedmineServer,
      "Pick issue/activity",
      { allowSkip: true }
    );

    expect(result).toBe("skip");
    expect(server.getIssueById).not.toHaveBeenCalled();
    expect(vscodeApi.window.showQuickPick).not.toHaveBeenCalled();
  });

  it("pickIssue supports skipTimeTrackingCheck and does not validate projects", async () => {
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const { pickIssue } = await import("../../../src/utilities/issue-picker");
    const selectedIssue = createIssue({
      id: 909,
      subject: "Cross-project move",
      project: { id: 77, name: "Migration" },
    });
    const server = createMockServer({
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [selectedIssue] }),
      getProjects: vi.fn().mockResolvedValue([createProject(77, "Migration")]),
      getIssueById: vi.fn().mockResolvedValue({ issue: selectedIssue }),
    });

    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(() =>
      createAutoSelectQuickPick(pickFirstEnabledIssue) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const result = await pickIssue(server as unknown as RedmineServer, "Pick issue", {
      skipTimeTrackingCheck: true,
    });

    expect(result?.id).toBe(909);
    expect(server.isTimeTrackingEnabled).not.toHaveBeenCalled();
  });

  it("pickIssue shows error when assigned issue fetch fails", async () => {
    const vscodeApi = await import("vscode");
    const { pickIssue } = await import("../../../src/utilities/issue-picker");
    const server = createMockServer({
      getIssuesAssignedToMe: vi.fn().mockRejectedValue(new Error("assigned down")),
    });

    const result = await pickIssue(server as unknown as RedmineServer, "Pick issue");

    expect(result).toBeUndefined();
    expect(vscodeApi.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to fetch issues: Error: assigned down"
    );
  });

  it("pickIssue builds recent/assigned/no-tracking base sections when checks enabled", async () => {
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([931]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const quickPick = createControlledQuickPick();
    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(
      () => quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const recentTrackable = createIssue({
      id: 931,
      subject: "Recent trackable",
      project: { id: 81, name: "Core" },
    });
    const otherTrackable = createIssue({
      id: 932,
      subject: "Other trackable",
      project: { id: 81, name: "Core" },
    });
    const nonTrackable = createIssue({
      id: 933,
      subject: "No tracking",
      project: { id: 82, name: "Ops" },
    });

    const { pickIssue } = await import("../../../src/utilities/issue-picker");
    const server = createMockServer({
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [recentTrackable, otherTrackable, nonTrackable] }),
      getProjects: vi.fn().mockResolvedValue([createProject(81, "Core"), createProject(82, "Ops")]),
      isTimeTrackingEnabled: vi.fn(async (projectId: number) => projectId === 81),
      searchIssues: vi.fn().mockResolvedValue([]),
    });

    const pending = pickIssue(server as unknown as RedmineServer, "Pick issue");
    await flushMicrotasks();

    const labels = quickPick.items.map((i) => i.label);
    expect(labels).toContain("Recent");
    expect(labels).toContain("Assigned");
    expect(labels).toContain("No Time Tracking");

    quickPick.triggerHide();
    await expect(pending).resolves.toBeUndefined();
  });

  it("pickIssue ignores separator and disabled selections during search", async () => {
    vi.useFakeTimers();
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const quickPick = createControlledQuickPick();
    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(
      () => quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const assignedIssue = createIssue({
      id: 941,
      subject: "Assigned",
      project: { id: 91, name: "Core" },
    });
    const nonTrackableIssue = createIssue({
      id: 942,
      subject: "Remote non-trackable",
      project: { id: 92, name: "Remote" },
    });

    const { pickIssue } = await import("../../../src/utilities/issue-picker");
    const server = createMockServer({
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [assignedIssue] }),
      getProjects: vi.fn().mockResolvedValue([createProject(91, "Core"), createProject(92, "Remote")]),
      isTimeTrackingEnabled: vi.fn(async (projectId: number) => projectId === 91),
      searchIssues: vi.fn().mockResolvedValue([nonTrackableIssue]),
    });

    const pending = pickIssue(server as unknown as RedmineServer, "Pick issue");
    await flushMicrotasks();

    quickPick.triggerSelection((items) => items.find((item) => item.kind === vscodeApi.QuickPickItemKind.Separator));
    await flushMicrotasks();

    quickPick.triggerValue("a");
    await vi.advanceTimersByTimeAsync(200);
    expect(server.searchIssues).not.toHaveBeenCalled();

    quickPick.triggerValue("remote");
    await vi.advanceTimersByTimeAsync(200);
    const selectedDisabled = quickPick.triggerSelection((items) =>
      items.find((item) => item.label.includes("#942"))
    );
    expect(selectedDisabled).toBe(true);

    quickPick.triggerHide();
    await expect(pending).resolves.toBeUndefined();
  });

  it("pickIssueWithSearch shows exact numeric no-access result during inline search", async () => {
    vi.useFakeTimers();
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const quickPick = createControlledQuickPick();
    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(
      () => quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const { pickIssueWithSearch } = await import("../../../src/utilities/issue-picker");
    const server = createMockServer({
      getFilteredIssues: vi.fn().mockResolvedValue({ issues: [] }),
      getProjects: vi.fn().mockResolvedValue([]),
      getIssueById: vi.fn().mockRejectedValue(new Error("403 forbidden")),
      searchIssues: vi.fn().mockResolvedValue([]),
    });

    const pending = pickIssueWithSearch(server as unknown as RedmineServer, "Pick issue/activity");
    await flushMicrotasks();
    expect(quickPick.onDidChangeValue).toHaveBeenCalled();

    quickPick.triggerValue("123");
    await vi.advanceTimersByTimeAsync(200);

    expect(server.getIssueById).toHaveBeenCalledWith(123);
    expect(quickPick.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "$(error) #123 no access",
          disabled: true,
        }),
      ])
    );

    quickPick.triggerHide();
    await expect(pending).resolves.toBeUndefined();
  });

  it("pickIssueWithSearch shows exact numeric not-found result during inline search", async () => {
    vi.useFakeTimers();
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const quickPick = createControlledQuickPick();
    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(
      () => quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const { pickIssueWithSearch } = await import("../../../src/utilities/issue-picker");
    const server = createMockServer({
      getFilteredIssues: vi.fn().mockResolvedValue({ issues: [] }),
      getProjects: vi.fn().mockResolvedValue([]),
      getIssueById: vi.fn().mockRejectedValue(new Error("404 missing")),
      searchIssues: vi.fn().mockResolvedValue([]),
    });

    const pending = pickIssueWithSearch(server as unknown as RedmineServer, "Pick issue/activity");
    await flushMicrotasks();
    expect(quickPick.onDidChangeValue).toHaveBeenCalled();

    quickPick.triggerValue("#999");
    await vi.advanceTimersByTimeAsync(200);

    expect(server.getIssueById).toHaveBeenCalledWith(999);
    expect(quickPick.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "$(error) #999 not found",
          disabled: true,
        }),
      ])
    );

    quickPick.triggerHide();
    await expect(pending).resolves.toBeUndefined();
  });

  it("pickIssueWithSearch applies operator filters with multi-token project search", async () => {
    vi.useFakeTimers();
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const quickPick = createControlledQuickPick();
    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(
      () => quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const openMatch = createIssue({
      id: 701,
      subject: "Auth bug fix",
      project: { id: 22, name: "Platform" },
      status: { id: 1, name: "Open", is_closed: false },
    });
    const closedMismatch = createIssue({
      id: 702,
      subject: "Auth bug old",
      project: { id: 22, name: "Platform" },
      status: { id: 5, name: "Closed", is_closed: true },
    });
    const projectSearchMatch = createIssue({
      id: 703,
      subject: "Auth bug from project fetch",
      project: { id: 22, name: "Platform" },
      status: { id: 1, name: "Open", is_closed: false },
    });

    const { pickIssueWithSearch } = await import("../../../src/utilities/issue-picker");
    const server = createMockServer({
      getFilteredIssues: vi.fn().mockResolvedValue({ issues: [] }),
      getProjects: vi.fn().mockResolvedValue([
        createProject(21, "ClientA"),
        createProject(22, "Platform", { id: 21, name: "ClientA" }),
      ]),
      isTimeTrackingEnabled: vi.fn().mockResolvedValue(true),
      searchIssues: vi.fn(async (token: string) => {
        if (token.toLowerCase().includes("auth") || token.toLowerCase().includes("bug")) {
          return [openMatch, closedMismatch];
        }
        return [];
      }),
      getOpenIssuesForProject: vi.fn(async (projectId: number) => ({
        issues: projectId === 22 ? [projectSearchMatch] : [],
      })),
    });

    const pending = pickIssueWithSearch(server as unknown as RedmineServer, "Pick issue/activity");
    await flushMicrotasks();
    expect(quickPick.onDidChangeValue).toHaveBeenCalled();

    quickPick.triggerValue("clienta project:ClientA status:Open auth bug");
    await vi.advanceTimersByTimeAsync(200);

    expect(server.searchIssues).toHaveBeenCalledWith("auth", 10);
    expect(server.searchIssues).toHaveBeenCalledWith("bug", 10);
    expect(server.getOpenIssuesForProject).toHaveBeenCalledWith(22, true, 30, false);
    expect(
      quickPick.items.some((item) => item.label.includes("#701"))
    ).toBe(true);
    expect(
      quickPick.items.some((item) => item.label.includes("#702"))
    ).toBe(false);
    expect(
      quickPick.items.some((item) => item.label.includes("#703"))
    ).toBe(true);

    quickPick.triggerHide();
    await expect(pending).resolves.toBeUndefined();
  });

  it("pickIssue falls back to search error item when inline search throws", async () => {
    vi.useFakeTimers();
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const quickPick = createControlledQuickPick();
    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(
      () => quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const issue = createIssue({
      id: 515,
      subject: "Retry search",
      project: { id: 15, name: "Core" },
    });
    const { pickIssue } = await import("../../../src/utilities/issue-picker");
    const server = createMockServer({
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [issue] }),
      getProjects: vi.fn().mockResolvedValue([createProject(15, "Core")]),
      isTimeTrackingEnabled: vi.fn().mockResolvedValue(true),
      searchIssues: vi.fn().mockRejectedValue(new Error("search down")),
    });

    const pending = pickIssue(server as unknown as RedmineServer, "Pick issue");
    await flushMicrotasks();
    expect(quickPick.onDidChangeValue).toHaveBeenCalled();

    quickPick.triggerValue("retry");
    await vi.advanceTimersByTimeAsync(200);

    expect(quickPick.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "$(error) Search failed", disabled: true }),
        expect.objectContaining({ label: expect.stringContaining("#515") }),
      ])
    );

    quickPick.triggerHide();
    await expect(pending).resolves.toBeUndefined();
  });

  it("pickIssue inline search builds trackable and non-trackable result items", async () => {
    vi.useFakeTimers();
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const quickPick = createControlledQuickPick();
    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(
      () => quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const assignedIssue = createIssue({
      id: 901,
      subject: "Auth assigned",
      project: { id: 41, name: "Core" },
      status: { id: 1, name: "Open", is_closed: false },
    });
    const nonTrackableIssue = createIssue({
      id: 902,
      subject: "Auth non-trackable",
      project: { id: 42, name: "Ops" },
      assigned_to: { id: 77, name: "Someone Else" },
      status: { id: 1, name: "Open", is_closed: false },
    });
    const noProjectIssue = createIssue({
      id: 903,
      subject: "Auth without project",
      project: undefined,
      assigned_to: { id: 77, name: "Someone Else" },
    } as Partial<Issue>);

    const { pickIssue } = await import("../../../src/utilities/issue-picker");
    const server = createMockServer({
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [assignedIssue] }),
      getProjects: vi.fn().mockResolvedValue([
        createProject(41, "Core"),
        createProject(42, "Ops"),
      ]),
      isTimeTrackingEnabled: vi
        .fn()
        .mockImplementation(async (projectId: number) => projectId === 41),
      searchIssues: vi.fn().mockResolvedValue([nonTrackableIssue, noProjectIssue]),
    });

    const pending = pickIssue(server as unknown as RedmineServer, "Pick issue");
    await flushMicrotasks();

    quickPick.triggerValue("auth");
    await vi.advanceTimersByTimeAsync(200);

    expect(
      quickPick.items.some((item) => item.label.includes("$(account) #901"))
    ).toBe(true);
    expect(
      quickPick.items.some((item) => item.label.includes("$(circle-slash) #902"))
    ).toBe(true);
    expect(
      quickPick.items.some((item) => item.label.includes("$(circle-slash) #903"))
    ).toBe(true);

    quickPick.triggerSelection((items) => items.find((item) => item.label.includes("#901")));
    await expect(pending).resolves.toMatchObject({ id: 901 });
  });

  it("pickIssue inline search with skipTimeTrackingCheck selects non-assigned result", async () => {
    vi.useFakeTimers();
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const quickPick = createControlledQuickPick();
    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(
      () => quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const assignedIssue = createIssue({
      id: 911,
      subject: "Assigned base",
      project: { id: 51, name: "Base" },
    });
    const searchOnlyIssue = createIssue({
      id: 912,
      subject: "Remote search result",
      project: { id: 52, name: "Remote" },
      assigned_to: { id: 99, name: "Other" },
    });

    const { pickIssue } = await import("../../../src/utilities/issue-picker");
    const server = createMockServer({
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [assignedIssue] }),
      getProjects: vi.fn().mockResolvedValue([createProject(51, "Base"), createProject(52, "Remote")]),
      searchIssues: vi.fn().mockResolvedValue([searchOnlyIssue]),
      isTimeTrackingEnabled: vi.fn(),
    });

    const pending = pickIssue(server as unknown as RedmineServer, "Pick issue", {
      skipTimeTrackingCheck: true,
    });
    await flushMicrotasks();

    quickPick.triggerValue("remote");
    await vi.advanceTimersByTimeAsync(200);

    expect(
      quickPick.items.some((item) => item.label.includes("$(search) #912"))
    ).toBe(true);
    quickPick.triggerSelection((items) => items.find((item) => item.label.includes("#912")));

    await expect(pending).resolves.toMatchObject({ id: 912 });
    expect(server.isTimeTrackingEnabled).not.toHaveBeenCalled();
  });

  it("pickIssue clears inline query back to base items", async () => {
    vi.useFakeTimers();
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const quickPick = createControlledQuickPick();
    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(
      () => quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const baseIssue = createIssue({
      id: 921,
      subject: "Baseline",
      project: { id: 61, name: "Core" },
    });

    const { pickIssue } = await import("../../../src/utilities/issue-picker");
    const server = createMockServer({
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [baseIssue] }),
      getProjects: vi.fn().mockResolvedValue([createProject(61, "Core")]),
      isTimeTrackingEnabled: vi.fn().mockResolvedValue(true),
      searchIssues: vi.fn().mockResolvedValue([]),
    });

    const pending = pickIssue(server as unknown as RedmineServer, "Pick issue");
    await flushMicrotasks();

    quickPick.triggerValue("zz");
    await vi.advanceTimersByTimeAsync(200);
    expect(
      quickPick.items.some((item) => item.label.includes("No results for"))
    ).toBe(true);

    quickPick.triggerValue("");
    expect(
      quickPick.items.some((item) => item.label.includes("#921 Baseline"))
    ).toBe(true);

    quickPick.triggerHide();
    await expect(pending).resolves.toBeUndefined();
  });

  it("pickIssueWithSearch shows error when refreshed issue has no project", async () => {
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const { pickIssueWithSearch } = await import("../../../src/utilities/issue-picker");
    const selectedIssue = createIssue({
      id: 811,
      subject: "Selected issue",
      project: { id: 66, name: "Core" },
    });
    const refreshedWithoutProject = {
      ...selectedIssue,
      project: undefined,
    } as unknown as Issue;

    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [selectedIssue] : [],
      })),
      getProjects: vi.fn().mockResolvedValue([createProject(66, "Core")]),
      isTimeTrackingEnabled: vi.fn().mockResolvedValue(true),
      getIssueById: vi.fn().mockResolvedValue({ issue: refreshedWithoutProject }),
    });

    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(() =>
      createAutoSelectQuickPick(pickFirstEnabledIssue) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const result = await pickIssueWithSearch(server as unknown as RedmineServer, "Pick issue/activity");

    expect(result).toBeUndefined();
    expect(vscodeApi.window.showErrorMessage).toHaveBeenCalledWith(
      "Issue has no associated project"
    );
    expect(server.getProjectTimeEntryActivities).not.toHaveBeenCalled();
  });

  it("pickIssueWithSearch shows error when refreshed issue project no longer tracks time", async () => {
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const { pickIssueWithSearch } = await import("../../../src/utilities/issue-picker");
    const selectedIssue = createIssue({
      id: 812,
      subject: "Time tracking changed",
      project: { id: 67, name: "Ops" },
    });
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [selectedIssue] : [],
      })),
      getProjects: vi.fn().mockResolvedValue([createProject(67, "Ops")]),
      isTimeTrackingEnabled: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      getIssueById: vi.fn().mockResolvedValue({ issue: selectedIssue }),
    });

    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(() =>
      createAutoSelectQuickPick(pickFirstEnabledIssue) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const result = await pickIssueWithSearch(server as unknown as RedmineServer, "Pick issue/activity");

    expect(result).toBeUndefined();
    expect(vscodeApi.window.showErrorMessage).toHaveBeenCalledWith(
      'Cannot log time: Project "Ops" does not have time tracking enabled'
    );
    expect(server.getProjectTimeEntryActivities).not.toHaveBeenCalled();
  });

  it("pickIssueWithSearch shows error when activity fetch fails after issue selection", async () => {
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const { pickIssueWithSearch } = await import("../../../src/utilities/issue-picker");
    const selectedIssue = createIssue({
      id: 813,
      subject: "Fetch activity fail",
      project: { id: 68, name: "Platform" },
    });
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [selectedIssue] : [],
      })),
      getProjects: vi.fn().mockResolvedValue([createProject(68, "Platform")]),
      isTimeTrackingEnabled: vi.fn().mockResolvedValue(true),
      getIssueById: vi.fn().mockResolvedValue({ issue: selectedIssue }),
      getProjectTimeEntryActivities: vi.fn().mockRejectedValue(new Error("activity endpoint down")),
    });

    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(() =>
      createAutoSelectQuickPick(pickFirstEnabledIssue) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const result = await pickIssueWithSearch(server as unknown as RedmineServer, "Pick issue/activity");

    expect(result).toBeUndefined();
    expect(vscodeApi.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to fetch activities: Error: activity endpoint down"
    );
  });

  it("pickIssueWithSearch falls back to selected issue when refresh fails", async () => {
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const { pickIssueWithSearch } = await import("../../../src/utilities/issue-picker");
    const selectedIssue = createIssue({
      id: 814,
      subject: "Fallback issue",
      project: { id: 69, name: "Infra" },
    });
    const selectedActivity: TimeEntryActivity = { id: 9, name: "Ops work" };

    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [selectedIssue] : [],
      })),
      getProjects: vi.fn().mockResolvedValue([createProject(69, "Infra")]),
      isTimeTrackingEnabled: vi.fn().mockResolvedValue(true),
      getIssueById: vi.fn().mockRejectedValue(new Error("refresh failed")),
      getProjectTimeEntryActivities: vi.fn().mockResolvedValue([selectedActivity]),
    });

    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(() =>
      createAutoSelectQuickPick(pickFirstEnabledIssue) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );
    vi.spyOn(vscodeApi.window, "showQuickPick").mockResolvedValue({
      label: selectedActivity.name,
      activity: selectedActivity,
    } as unknown as vscode.QuickPickItem);

    const result = await pickIssueWithSearch(server as unknown as RedmineServer, "Pick issue/activity");

    expect(server.getIssueById).toHaveBeenCalledWith(814);
    expect(result).toEqual({
      issueId: 814,
      issueSubject: "Fallback issue",
      activityId: 9,
      activityName: "Ops work",
    });
  });

  it("pickIssueWithSearch shows error when selected project has no activities", async () => {
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const { pickIssueWithSearch } = await import("../../../src/utilities/issue-picker");
    const selectedIssue = createIssue({
      id: 815,
      subject: "No activity setup",
      project: { id: 70, name: "Billing" },
    });
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [selectedIssue] : [],
      })),
      getProjects: vi.fn().mockResolvedValue([createProject(70, "Billing")]),
      isTimeTrackingEnabled: vi.fn().mockResolvedValue(true),
      getIssueById: vi.fn().mockResolvedValue({ issue: selectedIssue }),
      getProjectTimeEntryActivities: vi.fn().mockResolvedValue([]),
    });

    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(() =>
      createAutoSelectQuickPick(pickFirstEnabledIssue) as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const result = await pickIssueWithSearch(server as unknown as RedmineServer, "Pick issue/activity");

    expect(result).toBeUndefined();
    expect(vscodeApi.window.showErrorMessage).toHaveBeenCalledWith(
      "No activities available for this project"
    );
  });

  it("pickIssueWithSearch keeps disabled non-trackable selections unselected", async () => {
    const vscodeApi = await import("vscode");
    const recentIssues = await import("../../../src/utilities/recent-issues");
    vi.spyOn(recentIssues, "getRecentIssueIds").mockReturnValue([]);
    vi.spyOn(recentIssues, "recordRecentIssue").mockImplementation(() => {});

    const quickPick = createControlledQuickPick();
    vi.spyOn(vscodeApi.window, "createQuickPick").mockImplementation(
      () => quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>
    );

    const issue = createIssue({
      id: 404,
      subject: "No tracking issue",
      project: { id: 33, name: "Archived" },
    });
    const { pickIssueWithSearch } = await import("../../../src/utilities/issue-picker");
    const server = createMockServer({
      getFilteredIssues: vi.fn(async (filter: { status: "open" | "closed" }) => ({
        issues: filter.status === "open" ? [issue] : [],
      })),
      getProjects: vi.fn().mockResolvedValue([createProject(33, "Archived")]),
      isTimeTrackingEnabled: vi.fn().mockResolvedValue(false),
    });

    const pending = pickIssueWithSearch(server as unknown as RedmineServer, "Pick issue/activity");
    await flushMicrotasks();
    expect(
      quickPick.items.some((item) => {
        const candidate = item as { issue?: Issue; disabled?: boolean };
        return candidate.issue?.id === 404 && candidate.disabled === true;
      })
    ).toBe(true);

    const selectedDisabled = quickPick.triggerSelection((items) =>
      items.find((item) => {
        const candidate = item as { issue?: Issue; disabled?: boolean };
        return candidate.issue?.id === 404 && candidate.disabled === true;
      })
    );

    expect(selectedDisabled).toBe(true);
    expect(vscodeApi.window.showInformationMessage).toHaveBeenCalledWith(
      'Project "Archived" has no time tracking enabled'
    );
    expect(server.getIssueById).not.toHaveBeenCalled();

    quickPick.triggerHide();
    await expect(pending).resolves.toBeUndefined();
  });

  it("pickActivityForProject shows error when time tracking is disabled", async () => {
    const vscodeApi = await import("vscode");
    const { pickActivityForProject } = await import("../../../src/utilities/issue-picker");
    const server = createMockServer({
      isTimeTrackingEnabled: vi.fn().mockResolvedValue(false),
    });

    const result = await pickActivityForProject(
      server as unknown as RedmineServer,
      55,
      "Pick activity"
    );

    expect(result).toBeUndefined();
    expect(vscodeApi.window.showErrorMessage).toHaveBeenCalledWith(
      "Project does not have time tracking enabled"
    );
  });

  it("pickActivityForProject shows error when activity fetch fails", async () => {
    const vscodeApi = await import("vscode");
    const { pickActivityForProject } = await import("../../../src/utilities/issue-picker");
    const server = createMockServer({
      isTimeTrackingEnabled: vi.fn().mockResolvedValue(true),
      getProjectTimeEntryActivities: vi.fn().mockRejectedValue(new Error("activities down")),
    });

    const result = await pickActivityForProject(
      server as unknown as RedmineServer,
      42,
      "Pick activity"
    );

    expect(result).toBeUndefined();
    expect(vscodeApi.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to fetch activities: Error: activities down"
    );
  });

  it("pickActivityForProject shows error when no activities exist", async () => {
    const vscodeApi = await import("vscode");
    const { pickActivityForProject } = await import("../../../src/utilities/issue-picker");
    const server = createMockServer({
      isTimeTrackingEnabled: vi.fn().mockResolvedValue(true),
      getProjectTimeEntryActivities: vi.fn().mockResolvedValue([]),
    });

    const result = await pickActivityForProject(
      server as unknown as RedmineServer,
      42,
      "Pick activity"
    );

    expect(result).toBeUndefined();
    expect(vscodeApi.window.showErrorMessage).toHaveBeenCalledWith(
      "No activities available for this project"
    );
  });

  it("internal parser + fuzzy filter handles operators and token modes", async () => {
    const { __testIssuePicker } = await import("../../../src/utilities/issue-picker");
    const issueA = createIssue({
      id: 1,
      subject: "Auth bug fix",
      project: { id: 10, name: "Platform" },
      status: { id: 1, name: "Open", is_closed: false },
    });
    const issueB = createIssue({
      id: 2,
      subject: "Auth legacy cleanup",
      project: { id: 10, name: "Platform" },
      status: { id: 5, name: "Closed", is_closed: true },
    });
    const issueC = createIssue({
      id: 3,
      subject: "Billing integration",
      project: { id: 20, name: "Billing" },
      status: { id: 1, name: "Open", is_closed: false },
    });
    const projectPathMap = new Map<number, string>([
      [10, "ClientA: Platform"],
      [20, "ClientB: Billing"],
    ]);

    expect(__testIssuePicker.parseSearchOperators('project:"ClientA" status:open auth bug')).toEqual({
      textQuery: "auth bug",
      projectFilter: "clienta",
      statusFilter: "open",
    });

    const operatorOnly = __testIssuePicker.fuzzyFilterIssues(
      [issueA, issueB, issueC],
      "project:clienta status:open",
      projectPathMap,
      new Set<number>([1]),
      new Set<number>([1])
    );
    expect(operatorOnly.map((i: Issue) => i.id)).toEqual([1]);

    const multiToken = __testIssuePicker.fuzzyFilterIssues(
      [issueA, issueB, issueC],
      "auth bug",
      projectPathMap,
      new Set<number>([1]),
      new Set<number>([1])
    );
    expect(multiToken.map((i: Issue) => i.id)).toContain(1);
    expect(multiToken.map((i: Issue) => i.id)).not.toContain(3);
  });

  it("internal fuzzy search returns exact-match errors and project-sourced results", async () => {
    const { __testIssuePicker } = await import("../../../src/utilities/issue-picker");
    const localIssue = createIssue({
      id: 101,
      subject: "Auth bug local",
      project: { id: 22, name: "Platform" },
      status: { id: 1, name: "Open", is_closed: false },
    });
    const serverIssue = createIssue({
      id: 102,
      subject: "Auth bug server",
      project: { id: 22, name: "Platform" },
      status: { id: 1, name: "Open", is_closed: false },
    });
    const projectIssue = createIssue({
      id: 103,
      subject: "Auth bug from project query",
      project: { id: 22, name: "Platform" },
      status: { id: 1, name: "Open", is_closed: false },
    });

    const server = {
      getIssueById: vi
        .fn()
        .mockRejectedValueOnce(new Error("403 forbidden"))
        .mockRejectedValueOnce(new Error("404 missing")),
      searchIssues: vi.fn(async (token: string) => {
        if (token.toLowerCase().includes("auth") || token.toLowerCase().includes("bug")) {
          return [serverIssue];
        }
        return [];
      }),
      getOpenIssuesForProject: vi.fn().mockResolvedValue({ issues: [projectIssue] }),
    } as unknown as RedmineServer;

    const noAccess = await __testIssuePicker.searchIssuesWithFuzzy(
      server,
      "#77",
      [],
      new Map<number, string>(),
      new Set<number>()
    );
    expect(noAccess.exactMatchError).toBe("no access");

    const notFound = await __testIssuePicker.searchIssuesWithFuzzy(
      server,
      "#88",
      [],
      new Map<number, string>(),
      new Set<number>()
    );
    expect(notFound.exactMatchError).toBe("not found");

    const mixed = await __testIssuePicker.searchIssuesWithFuzzy(
      server,
      "clienta auth bug",
      [localIssue],
      new Map<number, string>([[22, "ClientA: Platform"]]),
      new Set<number>([101])
    );
    expect(server.searchIssues).toHaveBeenCalledWith("auth", 10);
    expect(server.searchIssues).toHaveBeenCalledWith("bug", 10);
    expect(server.getOpenIssuesForProject).toHaveBeenCalledWith(22, true, 30, false);
    expect(mixed.results.map((i: Issue) => i.id)).toEqual(expect.arrayContaining([101, 102, 103]));
  });

  it("internal fuzzy search keeps exact numeric match and ignores non-Error fetch failures", async () => {
    const { __testIssuePicker } = await import("../../../src/utilities/issue-picker");
    const exactIssue = createIssue({
      id: 321,
      subject: "Exact numeric",
      project: { id: 71, name: "Core" },
    });
    const server = {
      getIssueById: vi
        .fn()
        .mockResolvedValueOnce({ issue: exactIssue })
        .mockRejectedValueOnce("string failure"),
      searchIssues: vi.fn().mockResolvedValue([]),
      getOpenIssuesForProject: vi.fn().mockResolvedValue({ issues: [] }),
    } as unknown as RedmineServer;

    const exact = await __testIssuePicker.searchIssuesWithFuzzy(
      server,
      "321",
      [],
      new Map<number, string>(),
      new Set<number>()
    );
    expect(exact.exactMatch?.id).toBe(321);
    expect(exact.exactMatchError).toBeNull();

    const unknownFailure = await __testIssuePicker.searchIssuesWithFuzzy(
      server,
      "322",
      [],
      new Map<number, string>(),
      new Set<number>()
    );
    expect(unknownFailure.exactMatchError).toBeNull();
  });

  it("internal helpers cover hasSortByLabel + showActivityPicker cancel/select", async () => {
    const vscodeApi = await import("vscode");
    const { __testIssuePicker } = await import("../../../src/utilities/issue-picker");

    expect(__testIssuePicker.hasSortByLabel({} as unknown as vscode.QuickPick<vscode.QuickPickItem>)).toBe(false);
    expect(
      __testIssuePicker.hasSortByLabel({ sortByLabel: true } as unknown as vscode.QuickPick<vscode.QuickPickItem>)
    ).toBe(true);

    const activityA: TimeEntryActivity = { id: 5, name: "Review" };
    vi.spyOn(vscodeApi.window, "showQuickPick")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        label: "Review",
        activity: activityA,
      } as unknown as vscode.QuickPickItem);

    const canceled = await __testIssuePicker.showActivityPicker([activityA], "Title", "Holder");
    expect(canceled).toBeUndefined();
    const selected = await __testIssuePicker.showActivityPicker([activityA], "Title", "Holder");
    expect(selected).toEqual(activityA);
  });
});
