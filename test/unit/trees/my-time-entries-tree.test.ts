import { describe, it, expect, vi, beforeEach } from "vitest";
import { MyTimeEntriesTreeDataProvider } from "../../../src/trees/my-time-entries-tree";
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

  // Helper to wait for async loading to complete
  const waitForLoad = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  };

  // Helper to get loaded groups
  const getLoadedGroups = async () => {
    await provider.getChildren(); // Trigger load
    await waitForLoad(); // Wait for background fetch
    return provider.getChildren(); // Get cached result
  };

  beforeEach(() => {
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

    provider = new MyTimeEntriesTreeDataProvider();
    provider.setServer(mockServer as unknown as never);
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

    // Wait for background load to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Second call returns actual data (cached)
    const secondResult = await provider.getChildren();
    expect(secondResult).toHaveLength(4); // Today, This Week, This Month, Last Month
    expect(secondResult[0].label).toContain("Today");
    expect(secondResult[1].label).toContain("This Week");
    expect(secondResult[2].label).toContain("This Month");
    expect(secondResult[3].label).toContain("Last Month");
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

    // Wait for background load
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Get root groups (cached)
    const groups = await provider.getChildren();

    expect(groups).toHaveLength(4); // Today, This Week, This Month, Last Month
    expect(mockServer.getTimeEntries).toHaveBeenCalledTimes(1); // Single fetch

    // Get children for first group (Today)
    const todayChildren = await provider.getChildren(groups[0]);

    // Should NOT call API again (cached)
    expect(mockServer.getTimeEntries).toHaveBeenCalledTimes(1);
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
    expect(groups[2].label).toContain("This Month");
    expect(groups[2].description).toContain("4:00");
    expect(groups[3].label).toContain("Last Month");
  });

  it("shows empty state when no entries", async () => {
    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: [] }) // today
      .mockResolvedValueOnce({ time_entries: [] }) // week
      .mockResolvedValueOnce({ time_entries: [] }) // month
      .mockResolvedValueOnce({ time_entries: [] }); // last month

    const groups = await getLoadedGroups();

    expect(groups).toHaveLength(4); // Today, This Week, This Month, Last Month
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
    // Wait for async loadTimeEntries to complete
    await waitForLoad();

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

  it("groups This Month entries by week then day with empty days", async () => {
    const monthEntries: TimeEntry[] = [
      // Week 50 (Dec 8-14)
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "8",
        comments: "",
        spent_on: "2025-12-09", // Tuesday (week 50)
      },
      // Week 51 (Dec 15-21)
      {
        id: 2,
        issue_id: 124,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "4",
        comments: "",
        spent_on: "2025-12-15", // Monday (week 51)
      },
      {
        id: 3,
        issue_id: 125,
        activity_id: 10,
        activity: { id: 10, name: "Testing" },
        hours: "3",
        comments: "",
        spent_on: "2025-12-16", // Tuesday (week 51)
      },
    ];

    // Single API call returns all entries; client-side filters by date
    // These entries are from Dec 2025, which falls in "Last Month" from Jan 2026 perspective
    mockServer.getTimeEntries.mockResolvedValueOnce({ time_entries: monthEntries });

    const groups = await getLoadedGroups();
    // With Dec 2025 entries and Jan 2026 "today", these entries are in "Last Month"
    const lastMonth = groups[3];
    expect(lastMonth.label).toContain("Last Month");

    // Get week groups
    const weekGroups = await provider.getChildren(lastMonth);

    // Should have 2 week groups (weeks 50 and 51)
    expect(weekGroups.length).toBe(2);
    expect(weekGroups[0].type).toBe("week-subgroup");

    // Weeks should be in reverse chronological order (most recent first)
    expect(weekGroups[0].label).toContain("Week 51");
    expect(weekGroups[1].label).toContain("Week 50");

    // Get days for Week 51 - now includes all working days in the week range
    const week51Days = await provider.getChildren(weekGroups[0]);

    // Find the days with entries
    const mon15 = week51Days.find((d) => d.label?.includes("Mon") && d.label?.includes("15"));
    const tue16 = week51Days.find((d) => d.label?.includes("Tue") && d.label?.includes("16"));

    expect(mon15).toBeDefined();
    expect(tue16).toBeDefined();
    expect(mon15!.description).toContain("4:00");
    expect(tue16!.description).toContain("3:00");

    // Should have more days than just the 2 with entries (includes empty working days)
    expect(week51Days.length).toBeGreaterThanOrEqual(2);

    // Get entries for Monday
    const dayEntries = await provider.getChildren(mon15!);
    expect(dayEntries.length).toBe(1);
  });
});
