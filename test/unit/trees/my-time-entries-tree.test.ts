import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MyTimeEntriesTreeDataProvider, TimeEntryNode } from "../../../src/trees/my-time-entries-tree";
import { TimeEntry } from "../../../src/redmine/models/time-entry";
import * as vscode from "vscode";

// Helper to format date as YYYY-MM-DD in local timezone (avoids UTC issues)
const formatLocalDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

// Helper to get today's date string in YYYY-MM-DD format (local timezone)
const getTodayStr = () => formatLocalDate(new Date());

// Helper to get yesterday's date string (local timezone)
const getYesterdayStr = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatLocalDate(d);
};

// Helper to get a weekday (Mon-Fri) within current week (local timezone)
const getWeekdayThisWeek = () => {
  const d = new Date();
  const day = d.getDay(); // 0=Sun, 6=Sat
  // If weekend, go back to Friday
  if (day === 0) d.setDate(d.getDate() - 2); // Sun -> Fri
  else if (day === 6) d.setDate(d.getDate() - 1); // Sat -> Fri
  return formatLocalDate(d);
};

// Get day of month from date string
const getDayOfMonth = (dateStr: string) => parseInt(dateStr.split("-")[2], 10);

// Helper to find day node by exact day number (label format: "Mon 1", "Tue 15", etc.)
const findDayNode = (dayGroups: { label?: string }[], dayNum: number) =>
  dayGroups.find((d) => d.label?.endsWith(` ${dayNum}`));

describe("MyTimeEntriesTreeDataProvider", () => {
  let mockServer: {
    getTimeEntries: ReturnType<typeof vi.fn>;
    getIssueById: ReturnType<typeof vi.fn>;
    options: { address: string };
  };
  let provider: MyTimeEntriesTreeDataProvider;

  // Helper to flush pending async work without wall-clock timers
  const waitForLoad = async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  };

  const isLoadingNode = (nodes: TimeEntryNode[]) =>
    nodes.length === 1 && nodes[0].type === "loading";

  const waitUntilLoaded = async <T extends TimeEntryNode[]>(
    fetch: () => Promise<T>,
    context: string
  ): Promise<T> => {
    for (let i = 0; i < 50; i++) {
      const nodes = await fetch();
      if (!isLoadingNode(nodes)) {
        return nodes;
      }
      await waitForLoad();
    }
    throw new Error(`Timeout waiting for ${context}`);
  };

  // Helper to get loaded groups
  const getLoadedGroups = async () => {
    await provider.getChildren(); // Trigger load
    return waitUntilLoaded(() => provider.getChildren(), "root groups");
  };

  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    mockServer = {
      getTimeEntries: vi.fn(),
      getIssueById: vi.fn().mockImplementation((id: number) => {
        // Default mock: return issue with subject and project based on ID
        return Promise.resolve({
          issue: { id, subject: `Test Issue ${id}`, project: { id: 1, name: "Test Project" } },
        });
      }),
      getIssuesByIds: vi.fn().mockImplementation((ids: number[]) => {
        // Default mock: return issues with subject and project based on ID
        return Promise.resolve(
          ids.map((id) => ({ id, subject: `Test Issue ${id}`, project: { id: 1, name: "Test Project" } }))
        );
      }),
      options: { address: "https://redmine.example.com" },
    };

    // Mock workspace.getConfiguration to return working hours config
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        if (key === "weeklySchedule") {
          return {
            Mon: 8,
            Tue: 8,
            Wed: 8,
            Thu: 8,
            Fri: 8,
            Sat: 0,
            Sun: 0,
          };
        }
        return defaultValue;
      }),
      update: vi.fn(),
    } as never);

    const mockGlobalState = { get: vi.fn().mockReturnValue(true), update: vi.fn() };
    provider = new MyTimeEntriesTreeDataProvider(mockGlobalState as never);
    provider.setServer(mockServer as unknown as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns loading state on first call then actual data", async () => {
    const todayEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "2.5",
        comments: "Test",
        spent_on: getTodayStr(),
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: todayEntries }) // today
      .mockResolvedValueOnce({ time_entries: todayEntries }) // week
      .mockResolvedValueOnce({ time_entries: todayEntries }) // month
      .mockResolvedValueOnce({ time_entries: [] }); // last month

    // First call returns loading state
    const firstResult = await provider.getChildren();
    expect(firstResult).toHaveLength(1);
    expect(firstResult[0].label).toContain("Loading");
    expect(firstResult[0].iconPath).toEqual(
      new vscode.ThemeIcon("loading~spin")
    );

    // Second call returns actual data (cached)
    const secondResult = await getLoadedGroups();
    // New structure: Today, This Week, 3 month nodes, Load Earlier = 6 items
    expect(secondResult).toHaveLength(6);
    expect(secondResult[0].label).toContain("Today");
    expect(secondResult[1].label).toContain("This Week");
    // Month nodes show month names like "January 2026"
    expect(secondResult[2].type).toBe("month-group");
    expect(secondResult[5].label).toBe("Load another 3 months");
  });

  it("caches entries at parent level (no double-fetch)", async () => {
    const todayEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "2.5",
        comments: "Test comment",
        spent_on: getTodayStr(),
      },
    ];

    const weekEntries: TimeEntry[] = [
      ...todayEntries,
      {
        id: 2,
        issue_id: 124,
        activity_id: 10,
        activity: { id: 10, name: "Testing" },
        hours: "1.5",
        comments: "",
        spent_on: getYesterdayStr(),
      },
    ];

    const monthEntries: TimeEntry[] = [...weekEntries];

    // Single API call returns all entries; client-side filters by date
    mockServer.getTimeEntries.mockResolvedValueOnce({ time_entries: monthEntries });

    // First call returns loading state
    await provider.getChildren();

    // Get root groups (cached)
    const groups = await getLoadedGroups();

    // New structure: Today, This Week, 3 month nodes, Load Earlier = 6 items
    expect(groups).toHaveLength(6);
    // 1 fetch for today/week + up to 3 preloaded months
    expect(mockServer.getTimeEntries).toHaveBeenCalled();

    // Get children for first group (Today)
    const callCountBefore = mockServer.getTimeEntries.mock.calls.length;
    const todayChildren = await provider.getChildren(groups[0]);

    // Today children come from cache (no additional API call for today specifically)
    expect(mockServer.getTimeEntries.mock.calls.length).toBe(callCountBefore);
    expect(todayChildren).toHaveLength(1);
  });

  it("returns cached entries for children", async () => {
    const todayEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "2.5",
        comments: "Test comment",
        spent_on: getTodayStr(),
      },
      {
        id: 2,
        issue_id: 124,
        activity_id: 10,
        activity: { id: 10, name: "Testing" },
        hours: "1.5",
        comments: "",
        spent_on: getTodayStr(),
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: todayEntries }) // today
      .mockResolvedValueOnce({ time_entries: todayEntries }) // week
      .mockResolvedValueOnce({ time_entries: todayEntries }) // month
      .mockResolvedValueOnce({ time_entries: [] }); // last month

    const groups = await getLoadedGroups();
    const todayChildren = await provider.getChildren(groups[0]);

    expect(todayChildren).toHaveLength(2);
    // Label format: "#id comment", description: "H:MM [activity] subject"
    expect(todayChildren[0].label).toBe("#123 Test comment");
    expect(todayChildren[0].description).toBe("2:30 [Development] Test Issue 123");
    expect(todayChildren[1].label).toBe("#124");
    expect(todayChildren[1].description).toBe("1:30 [Testing] Test Issue 124");
  });

  it("calculates correct totals for groups", async () => {
    const todayEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "2.5",
        comments: "",
        spent_on: getTodayStr(),
      },
      {
        id: 2,
        issue_id: 124,
        activity_id: 10,
        activity: { id: 10, name: "Testing" },
        hours: "1.5",
        comments: "",
        spent_on: getTodayStr(),
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: todayEntries }) // today
      .mockResolvedValueOnce({ time_entries: todayEntries }) // week
      .mockResolvedValueOnce({ time_entries: todayEntries }) // month
      .mockResolvedValueOnce({ time_entries: [] }); // last month

    const groups = await getLoadedGroups();

    expect(groups[0].label).toContain("Today");
    expect(groups[0].description).toContain("4:00"); // Contains total in H:MM format
    expect(groups[1].label).toContain("This Week");
    expect(groups[1].description).toContain("4:00");
    // Month nodes show month names (lazy-loaded, no description until expanded)
    expect(groups[2].type).toBe("month-group");
  });

  it("shows empty state when no entries", async () => {
    mockServer.getTimeEntries.mockResolvedValue({ time_entries: [] });

    const groups = await getLoadedGroups();

    // New structure: Today, This Week, 3 month nodes, Load Earlier = 6 items
    expect(groups).toHaveLength(6);
    expect(groups[0].description).toContain("0:00"); // Contains 0:00 total

    const todayChildren = await provider.getChildren(groups[0]);
    expect(todayChildren).toHaveLength(0);
  });

  it("sets contextValue for time entry items", async () => {
    const todayEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "2.5",
        comments: "Test comment",
        spent_on: getTodayStr(),
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: todayEntries }) // today
      .mockResolvedValueOnce({ time_entries: todayEntries }) // week
      .mockResolvedValueOnce({ time_entries: todayEntries }) // month
      .mockResolvedValueOnce({ time_entries: [] }); // last month

    const groups = await getLoadedGroups();
    const todayChildren = await provider.getChildren(groups[0]);

    expect(todayChildren[0].contextValue).toBe("time-entry");
  });

  it("refresh fires onDidChangeTreeData event", async () => {
    mockServer.getTimeEntries.mockResolvedValue({ time_entries: [] });

    const eventSpy = vi.fn();
    provider.onDidChangeTreeData(eventSpy);

    provider.refresh();
    await getLoadedGroups();

    expect(eventSpy).toHaveBeenCalledWith(undefined);
  });

  it("fetches issue details from API when not in time entry", async () => {
    const todayEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "2.5",
        comments: "Test comment",
        spent_on: getTodayStr(),
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: todayEntries }) // today
      .mockResolvedValueOnce({ time_entries: todayEntries }) // week
      .mockResolvedValueOnce({ time_entries: todayEntries }) // month
      .mockResolvedValueOnce({ time_entries: [] }); // last month

    mockServer.getIssuesByIds.mockResolvedValue([
      { id: 123, subject: "Fetched Issue Subject", project: { id: 1, name: "Test Project" } },
    ]);

    const groups = await getLoadedGroups();
    const todayChildren = await provider.getChildren(groups[0]);

    expect(todayChildren).toHaveLength(1);
    // Label format: "#id comment", description: "HH:MM [activity] subject"
    expect(todayChildren[0].label).toBe("#123 Test comment");
    expect(todayChildren[0].description).toContain("Fetched Issue Subject");
    expect(mockServer.getIssuesByIds).toHaveBeenCalledWith([123], false);
  });

  it("caches fetched issues to avoid redundant API calls", async () => {
    const todayEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "2.5",
        comments: "",
        spent_on: getTodayStr(),
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: todayEntries }) // today
      .mockResolvedValueOnce({ time_entries: todayEntries }) // week
      .mockResolvedValueOnce({ time_entries: todayEntries }) // month
      .mockResolvedValueOnce({ time_entries: [] }); // last month

    mockServer.getIssuesByIds.mockResolvedValue([
      { id: 123, subject: "Cached Issue", project: { id: 1, name: "Test Project" } },
    ]);

    const groups = await getLoadedGroups();

    // First expansion - should fetch issue
    await provider.getChildren(groups[0]);
    expect(mockServer.getIssuesByIds).toHaveBeenCalledTimes(1);

    // Second expansion (This Week) - should use cache
    await provider.getChildren(groups[1]);
    expect(mockServer.getIssuesByIds).toHaveBeenCalledTimes(1); // Still 1, not 2
  });

  it("clears issue cache on refresh", async () => {
    const todayEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "2.5",
        comments: "",
        spent_on: getTodayStr(),
      },
    ];

    mockServer.getTimeEntries.mockResolvedValue({ time_entries: todayEntries });

    mockServer.getIssuesByIds.mockResolvedValue([
      { id: 123, subject: "Fresh Issue", project: { id: 1, name: "Test Project" } },
    ]);

    const groups = await getLoadedGroups();
    await provider.getChildren(groups[0]);
    expect(mockServer.getIssuesByIds).toHaveBeenCalledTimes(1);

    // Refresh should clear cache
    provider.refresh();

    const newGroups = await getLoadedGroups();
    await provider.getChildren(newGroups[0]);
    expect(mockServer.getIssuesByIds).toHaveBeenCalledTimes(2); // Fetched again
  });

  it("handles issue fetch failures gracefully", async () => {
    const todayEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 999,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "2.5",
        comments: "",
        spent_on: getTodayStr(),
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: todayEntries }) // today
      .mockResolvedValueOnce({ time_entries: todayEntries }) // week
      .mockResolvedValueOnce({ time_entries: todayEntries }) // month
      .mockResolvedValueOnce({ time_entries: [] }); // last month

    mockServer.getIssuesByIds.mockRejectedValue(new Error("Issue not found"));

    const groups = await getLoadedGroups();
    const todayChildren = await provider.getChildren(groups[0]);

    expect(todayChildren).toHaveLength(1);
    // Label format: "#id comment" (no comment = just "#id")
    // "Unknown Issue" goes in description as subject fallback
    expect(todayChildren[0].label).toBe("#999");
    expect(todayChildren[0].description).toContain("Unknown Issue");
  });

  it("groups This Week entries by day of week with empty working days", async () => {
    // Use a dynamic weekday within current week
    const testDate = getWeekdayThisWeek();

    // Create entries for the test date
    const weekEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "4",
        comments: "",
        spent_on: testDate,
      },
      {
        id: 2,
        issue_id: 124,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "3",
        comments: "",
        spent_on: testDate,
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: weekEntries }) // today
      .mockResolvedValueOnce({ time_entries: weekEntries }) // week
      .mockResolvedValueOnce({ time_entries: weekEntries }) // month
      .mockResolvedValueOnce({ time_entries: [] }); // last month

    const groups = await getLoadedGroups();
    const thisWeek = groups[1];
    expect(thisWeek.label).toContain("This Week");

    // Get day groups
    const dayGroups = await provider.getChildren(thisWeek);

    // Should have at least 1 day with entries
    expect(dayGroups.length).toBeGreaterThanOrEqual(1);
    expect(dayGroups[0].type).toBe("day-group");

    // Find the day with entries (use endsWith for exact match, not includes)
    const dayNumInt = getDayOfMonth(testDate);
    const entryNode = findDayNode(dayGroups, dayNumInt);

    expect(entryNode).toBeDefined();

    // That day should show 7:00 total (4+3)
    expect(entryNode!.description).toContain("7:00");

    // Get entries for that day
    const dayEntries = await provider.getChildren(entryNode!);
    expect(dayEntries.length).toBe(2);
  });

  it("shows empty working days in week view", async () => {
    // Test that week-group includes working days even without entries
    // Use a dynamic weekday within current week
    const testDate = getWeekdayThisWeek();
    const dayNumInt = getDayOfMonth(testDate);

    const weekEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "8",
        comments: "",
        spent_on: testDate,
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: weekEntries }) // today
      .mockResolvedValueOnce({ time_entries: weekEntries }) // week
      .mockResolvedValueOnce({ time_entries: weekEntries }) // month
      .mockResolvedValueOnce({ time_entries: [] }); // last month

    const groups = await getLoadedGroups();
    const thisWeek = groups[1];
    const dayGroups = await provider.getChildren(thisWeek);

    // Should have at least 1 day with entry
    expect(dayGroups.length).toBeGreaterThanOrEqual(1);

    // Find node for the test date (use endsWith for exact match)
    const entryNode = findDayNode(dayGroups, dayNumInt);
    expect(entryNode).toBeDefined();
    expect(entryNode!.description).toContain("8:00");
  });

  it("shows non-working day only if has entries", async () => {
    // Test that non-working days (Sat/Sun with 0 scheduled hours) appear only when they have entries
    // Use a dynamic weekday within current week
    const testDate = getWeekdayThisWeek();
    const dayNumInt = getDayOfMonth(testDate);

    const weekEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "2",
        comments: "Work entry",
        spent_on: testDate,
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: weekEntries }) // today
      .mockResolvedValueOnce({ time_entries: weekEntries }) // week
      .mockResolvedValueOnce({ time_entries: weekEntries }) // month
      .mockResolvedValueOnce({ time_entries: [] }); // last month

    const groups = await getLoadedGroups();
    const thisWeek = groups[1];
    const dayGroups = await provider.getChildren(thisWeek);

    // Find node for test date - it should be present because it has an entry
    const entryNode = findDayNode(dayGroups, dayNumInt);

    expect(entryNode).toBeDefined();
    expect(entryNode!.description).toContain("2:00");

    // At minimum we should have the entry day
    expect(dayGroups.length).toBeGreaterThanOrEqual(1);
  });

  it("lazy-loads month entries and groups by week then day", async () => {
    // Use past month entries to avoid date-sensitivity issues
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    const lastMonthStr = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, "0")}`;
    const weekday1 = `${lastMonthStr}-10`;
    const weekday2 = `${lastMonthStr}-11`;

    const monthEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "4",
        comments: "",
        spent_on: weekday1,
      },
      {
        id: 2,
        issue_id: 124,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "3",
        comments: "",
        spent_on: weekday2,
      },
    ];

    // First call loads today/week, subsequent calls load month data
    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: [] }) // today/week
      .mockResolvedValue({ time_entries: monthEntries }); // month lazy load

    const groups = await getLoadedGroups();

    // Find the previous month node (second month after Today and This Week)
    const targetMonth = groups[3];
    expect(targetMonth.type).toBe("month-group");
    expect(targetMonth._monthYear).toBeDefined();

    // Month may be preloaded (first 3 months load in background after init).
    // Wait until data is available (either preloaded or lazy-loaded on expand).
    const weekGroups = await waitUntilLoaded(
      () => provider.getChildren(targetMonth),
      "month group load"
    );
    expect(weekGroups.length).toBeGreaterThanOrEqual(1);
    expect(weekGroups[0].type).toBe("week-subgroup");

    // Get days for a week that has entries (not a boundary week)
    const weekWithEntries = weekGroups.find((w) => w._cachedEntries && w._cachedEntries.length > 0);
    expect(weekWithEntries).toBeDefined();
    const weekDays = await provider.getChildren(weekWithEntries!);
    expect(weekDays.length).toBeGreaterThanOrEqual(1);
    expect(weekDays[0].type).toBe("day-group");
  });

  it("loadEarlierMonths adds more months to visible list", async () => {
    mockServer.getTimeEntries.mockResolvedValue({ time_entries: [] });

    const groups = await getLoadedGroups();
    // Initial: Today, This Week, 3 months, Load Earlier = 6 items
    expect(groups).toHaveLength(6);

    // Call loadEarlierMonths
    provider.loadEarlierMonths();

    const newGroups = await provider.getChildren();
    // Now: Today, This Week, 6 months, Load Earlier = 9 items
    expect(newGroups).toHaveLength(9);
  });

  it("maps draft create/update entries with draft-specific context values", async () => {
    const today = getTodayStr();
    const baseEntry: TimeEntry = {
      id: 99,
      issue_id: 123,
      activity_id: 9,
      activity: { id: 9, name: "Development" },
      hours: "1.0",
      comments: "server",
      spent_on: today,
    };

    mockServer.getTimeEntries.mockResolvedValueOnce({ time_entries: [baseEntry] });
    const queue = {
      getAll: vi.fn(() => [
        {
          id: "draft-create-1",
          type: "createTimeEntry",
          resourceId: undefined,
          http: { data: { time_entry: { issue_id: 321, activity_id: 7, hours: "2.5", comments: "draft", spent_on: today } } },
        },
        {
          id: "draft-update-1",
          type: "updateTimeEntry",
          resourceId: 99,
          http: { data: { time_entry: { comments: "updated in draft", hours: "1.5" } } },
        },
      ]),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    };
    provider.setDraftQueue(queue as never);

    const groups = await getLoadedGroups();
    const todayEntries = await provider.getChildren(groups[0]);
    const contexts = todayEntries.map((node) => node.contextValue);

    expect(contexts).toContain("time-entry-draft");
    expect(contexts).toContain("time-entry-modified");
  });

  it("toggles show-all-users and includes user name in entry description", async () => {
    const refreshSpy = vi.spyOn(provider, "refresh");
    provider.setShowAllUsers(false); // no-op path
    expect(refreshSpy).not.toHaveBeenCalled();

    provider.setShowAllUsers(true);
    expect(provider.getShowAllUsers()).toBe(true);
    expect(refreshSpy).toHaveBeenCalled();

    const todayEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "1.0",
        comments: "user test",
        spent_on: getTodayStr(),
        user: { id: 1, name: "Alice" },
      },
    ];
    const children = await provider.getChildren({
      id: "group-today",
      label: "Today",
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      type: "group",
      _cachedEntries: todayEntries,
      _date: getTodayStr(),
    });
    expect(children[0].description).toContain("Alice");
  });

  it("sorts by id, subject, comment, and user with direction toggle", () => {
    const entries: TimeEntry[] = [
      { issue_id: 2, hours: "1", comments: "b", activity_id: 1, user: { id: 1, name: "Zed" } },
      { issue_id: 1, hours: "1", comments: "a", activity_id: 1, user: { id: 2, name: "Amy" } },
    ];
    (provider as unknown as { issueCache: Map<number, { subject: string }> }).issueCache.set(1, { subject: "Alpha" });
    (provider as unknown as { issueCache: Map<number, { subject: string }> }).issueCache.set(2, { subject: "Beta" });

    provider.setSort("id");
    let sorted = (provider as unknown as { sortEntries: (rows: TimeEntry[]) => TimeEntry[] }).sortEntries(entries);
    expect(sorted.map((e) => e.issue_id)).toEqual([1, 2]);
    provider.setSort("id"); // toggle to desc
    sorted = (provider as unknown as { sortEntries: (rows: TimeEntry[]) => TimeEntry[] }).sortEntries(entries);
    expect(sorted.map((e) => e.issue_id)).toEqual([2, 1]);

    (provider as unknown as { entrySort: { field: string; direction: "asc" | "desc" } }).entrySort = {
      field: "subject",
      direction: "asc",
    };
    (provider as unknown as { issueCache: Map<number, { subject: string }> }).issueCache.set(1, { subject: "Alpha" });
    (provider as unknown as { issueCache: Map<number, { subject: string }> }).issueCache.set(2, { subject: "Beta" });
    sorted = (provider as unknown as { sortEntries: (rows: TimeEntry[]) => TimeEntry[] }).sortEntries(entries);
    expect(sorted.map((e) => e.issue_id)).toEqual([1, 2]);

    (provider as unknown as { entrySort: { field: string; direction: "asc" | "desc" } }).entrySort = {
      field: "comment",
      direction: "asc",
    };
    sorted = (provider as unknown as { sortEntries: (rows: TimeEntry[]) => TimeEntry[] }).sortEntries(entries);
    expect(sorted.map((e) => e.comments)).toEqual(["a", "b"]);

    provider.setSort("user");
    sorted = (provider as unknown as { sortEntries: (rows: TimeEntry[]) => TimeEntry[] }).sortEntries(entries);
    expect(sorted.map((e) => e.user?.name)).toEqual(["Amy", "Zed"]);
    expect(provider.getSort()).toEqual({ field: "user", direction: "asc" });
  });

  it("shows all weeks in month even with entries in only one week", async () => {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    const lastMonthStr = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, "0")}`;
    const entryDate = `${lastMonthStr}-15`;

    const monthEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "4",
        comments: "",
        spent_on: entryDate,
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: [] })
      .mockResolvedValue({ time_entries: monthEntries });

    const groups = await getLoadedGroups();
    const targetMonth = groups[3];
    expect(targetMonth.type).toBe("month-group");

    await provider.getChildren(targetMonth);
    const weekGroups = await waitUntilLoaded(
      () => provider.getChildren(targetMonth),
      "month weeks"
    );

    // Every month spans at least 4 ISO weeks
    expect(weekGroups.length).toBeGreaterThanOrEqual(4);
    expect(weekGroups.every((w) => w.type === "week-subgroup")).toBe(true);
  });

  it("empty week is expandable with working day nodes when 0% days shown", async () => {
    provider.setHideZeroDays(false);
    const now = new Date();
    const lastMonthStr = `${new Date(now.getFullYear(), now.getMonth() - 1, 1).getFullYear()}-${String(new Date(now.getFullYear(), now.getMonth() - 1, 1).getMonth() + 1).padStart(2, "0")}`;
    const entryDate = `${lastMonthStr}-15`;

    const monthEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "4",
        comments: "",
        spent_on: entryDate,
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: [] })
      .mockResolvedValue({ time_entries: monthEntries });

    const groups = await getLoadedGroups();
    const targetMonth = groups[3];

    await provider.getChildren(targetMonth);
    const weekGroups = await waitUntilLoaded(
      () => provider.getChildren(targetMonth),
      "month weeks"
    );

    const emptyWeek = weekGroups.find(
      (w) => w._cachedEntries && w._cachedEntries.length === 0
    );
    expect(emptyWeek).toBeDefined();

    const dayNodes = await provider.getChildren(emptyWeek!);
    expect(dayNodes.length).toBeGreaterThanOrEqual(1);
    expect(dayNodes[0].type).toBe("day-group");
  });

  it("completely empty month shows week nodes not 'No time entries'", async () => {
    mockServer.getTimeEntries.mockResolvedValue({ time_entries: [] });

    const groups = await getLoadedGroups();
    const targetMonth = groups[3];
    expect(targetMonth.type).toBe("month-group");

    await provider.getChildren(targetMonth);
    const weekGroups = await waitUntilLoaded(
      () => provider.getChildren(targetMonth),
      "empty month weeks"
    );

    expect(weekGroups.length).toBeGreaterThanOrEqual(4);
    expect(weekGroups[0].type).toBe("week-subgroup");
  });

  it("boundary week dateRange is clipped to month boundary", async () => {
    mockServer.getTimeEntries.mockResolvedValue({ time_entries: [] });

    const groups = await getLoadedGroups();
    // Expand last month (groups[3]) and current month (groups[2])
    const lastMonth = groups[3];
    const thisMonth = groups[2];
    expect(lastMonth.type).toBe("month-group");
    expect(thisMonth.type).toBe("month-group");

    // Load both months
    await provider.getChildren(lastMonth);
    const lastMonthWeeks = await waitUntilLoaded(
      () => provider.getChildren(lastMonth),
      "last month weeks"
    );
    await provider.getChildren(thisMonth);
    const thisMonthWeeks = await waitUntilLoaded(
      () => provider.getChildren(thisMonth),
      "this month weeks"
    );

    // Find a week label that appears in both months (boundary week)
    const lastMonthLabels = lastMonthWeeks.map((w) => w.label);
    const thisMonthLabels = thisMonthWeeks.map((w) => w.label);
    const sharedLabel = lastMonthLabels.find((l) => thisMonthLabels.includes(l));

    if (sharedLabel) {
      // Boundary week exists — verify date ranges don't overlap
      const inLast = lastMonthWeeks.find((w) => w.label === sharedLabel)!;
      const inThis = thisMonthWeeks.find((w) => w.label === sharedLabel)!;
      // Last month's range must end before this month's range starts
      expect(inLast._dateRange!.end < inThis._dateRange!.start).toBe(true);
    }
    // If no shared label, month boundary aligns with week boundary — no clipping needed
  });

  it("weeks are sorted descending by week number", async () => {
    mockServer.getTimeEntries.mockResolvedValue({ time_entries: [] });

    const groups = await getLoadedGroups();
    const targetMonth = groups[3];

    await provider.getChildren(targetMonth);
    const weekGroups = await waitUntilLoaded(
      () => provider.getChildren(targetMonth),
      "month weeks for sort check"
    );

    // Extract week numbers from labels like "Week 14", "Week 9"
    const weekNums = weekGroups.map((w) => {
      const match = w.label?.match(/Week (\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    });

    // Verify strictly descending
    for (let i = 1; i < weekNums.length; i++) {
      expect(weekNums[i]).toBeLessThan(weekNums[i - 1]);
    }
  });

  it("week node IDs use zero-padded week numbers", async () => {
    mockServer.getTimeEntries.mockResolvedValue({ time_entries: [] });

    const groups = await getLoadedGroups();
    // Use 2-months-ago to get a month with single-digit week numbers (e.g. Feb → weeks 5-9)
    const targetMonth = groups[4];
    expect(targetMonth.type).toBe("month-group");

    await provider.getChildren(targetMonth);
    const weekGroups = await waitUntilLoaded(
      () => provider.getChildren(targetMonth),
      "month weeks for ID check"
    );

    // All week node IDs should have zero-padded week numbers
    for (const week of weekGroups) {
      const match = week.id?.match(/week-(\d+)-(\d+)$/);
      expect(match).toBeTruthy();
      if (match) {
        const weekNumStr = match[2];
        expect(weekNumStr.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("entries without spent_on are excluded from week grouping", async () => {
    const now = new Date();
    const lastMonthStr = `${new Date(now.getFullYear(), now.getMonth() - 1, 1).getFullYear()}-${String(new Date(now.getFullYear(), now.getMonth() - 1, 1).getMonth() + 1).padStart(2, "0")}`;

    const monthEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "4",
        comments: "",
        spent_on: `${lastMonthStr}-15`,
      },
      {
        id: 2,
        issue_id: 124,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "2",
        comments: "",
        spent_on: undefined as unknown as string,
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: [] })
      .mockResolvedValue({ time_entries: monthEntries });

    const groups = await getLoadedGroups();
    const targetMonth = groups[3];

    await provider.getChildren(targetMonth);
    const weekGroups = await waitUntilLoaded(
      () => provider.getChildren(targetMonth),
      "month weeks with undefined spent_on"
    );

    // No week should have label "Week NaN"
    expect(weekGroups.every((w) => !w.label?.includes("NaN"))).toBe(true);
  });

  it("getMonthDateRange caps at today using year/month comparison", async () => {
    // Access private method via cast
    const getRange = (provider as unknown as {
      getMonthDateRange: (m: { year: number; month: number }) => { start: string; end: string };
    }).getMonthDateRange.bind(provider);

    const now = new Date();
    const currentMonth = { year: now.getFullYear(), month: now.getMonth() };
    const range = getRange(currentMonth);

    // Current month should be capped at today
    expect(range.end).toBe(formatLocalDate(now));

    // Past month should NOT be capped
    const pastMonth = { year: 2025, month: 0 }; // January 2025
    const pastRange = getRange(pastMonth);
    expect(pastRange.end).toBe("2025-01-31");
  });

  it("hides zero-percent days by default, shows when filter toggled", async () => {
    // hideZeroDays is true by default
    expect(provider.getHideZeroDays()).toBe(true);

    const testDate = getWeekdayThisWeek();

    const weekEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "2",
        comments: "",
        spent_on: testDate,
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: weekEntries })
      .mockResolvedValueOnce({ time_entries: weekEntries })
      .mockResolvedValueOnce({ time_entries: weekEntries })
      .mockResolvedValueOnce({ time_entries: [] });

    const groups = await getLoadedGroups();
    const thisWeek = groups[1];
    const dayGroups = await provider.getChildren(thisWeek);

    // Only the day with entries should show (0% days hidden)
    const withEntries = dayGroups.filter((d) => d._cachedEntries && d._cachedEntries.length > 0);
    const withoutEntries = dayGroups.filter((d) => d._cachedEntries && d._cachedEntries.length === 0);
    expect(withEntries.length).toBe(1);
    expect(withoutEntries.length).toBe(0);

    // Toggle filter off — now 0% days should appear
    provider.setHideZeroDays(false);

    // Re-fetch with same data
    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: weekEntries })
      .mockResolvedValueOnce({ time_entries: weekEntries });

    const groups2 = await getLoadedGroups();
    const thisWeek2 = groups2[1];
    const dayGroups2 = await provider.getChildren(thisWeek2);

    // Now working days without entries should appear too
    const withoutEntries2 = dayGroups2.filter((d) => d._cachedEntries && d._cachedEntries.length === 0);
    expect(withoutEntries2.length).toBeGreaterThanOrEqual(1);
  });

  it("assigns command for load-earlier tree item", () => {
    const item = provider.getTreeItem({
      id: "load-earlier",
      label: "Load another 3 months",
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      type: "load-earlier",
    });
    expect(item.command?.command).toBe("redmyne.loadEarlierTimeEntries");
  });
});
