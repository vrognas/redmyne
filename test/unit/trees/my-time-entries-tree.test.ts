import { describe, it, expect, vi, beforeEach } from "vitest";
import { MyTimeEntriesTreeDataProvider } from "../../../src/trees/my-time-entries-tree";
import { TimeEntry } from "../../../src/redmine/models/time-entry";
import * as vscode from "vscode";

describe("MyTimeEntriesTreeDataProvider", () => {
  let mockServer: {
    getTimeEntries: ReturnType<typeof vi.fn>;
    getIssueById: ReturnType<typeof vi.fn>;
    options: { address: string };
  };
  let provider: MyTimeEntriesTreeDataProvider;

  // Helper to wait for async loading to complete
  const waitForLoad = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  };

  // Helper to get loaded groups
  const getLoadedGroups = async () => {
    await provider.getChildren(); // Trigger load
    await waitForLoad(); // Wait for background fetch
    return provider.getChildren(); // Get cached result
  };

  beforeEach(() => {
    mockServer = {
      getTimeEntries: vi.fn(),
      getIssueById: vi.fn().mockImplementation((id: number) => {
        // Default mock: return issue with subject and project based on ID
        return Promise.resolve({
          issue: { id, subject: `Test Issue ${id}`, project: { id: 1, name: "Test Project" } },
        });
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
        spent_on: "2025-11-24",
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: todayEntries })
      .mockResolvedValueOnce({ time_entries: [] })
      .mockResolvedValueOnce({ time_entries: [] });

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
    expect(secondResult).toHaveLength(3);
    expect(secondResult[0].label).toContain("Today");
    expect(secondResult[1].label).toContain("This Week");
    expect(secondResult[2].label).toContain("This Month");
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
        spent_on: "2025-11-24",
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
        spent_on: "2025-11-23",
      },
    ];

    const monthEntries: TimeEntry[] = [...weekEntries];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: todayEntries })
      .mockResolvedValueOnce({ time_entries: weekEntries })
      .mockResolvedValueOnce({ time_entries: monthEntries });

    // First call returns loading state
    await provider.getChildren();

    // Wait for background load
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Get root groups (cached)
    const groups = await provider.getChildren();

    expect(groups).toHaveLength(3);
    expect(mockServer.getTimeEntries).toHaveBeenCalledTimes(3);

    // Get children for first group (Today)
    const todayChildren = await provider.getChildren(groups[0]);

    // Should NOT call API again (cached)
    expect(mockServer.getTimeEntries).toHaveBeenCalledTimes(3);
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
        spent_on: "2025-11-24",
      },
      {
        id: 2,
        issue_id: 124,
        activity_id: 10,
        activity: { id: 10, name: "Testing" },
        hours: "1.5",
        comments: "",
        spent_on: "2025-11-24",
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: todayEntries })
      .mockResolvedValueOnce({ time_entries: [] })
      .mockResolvedValueOnce({ time_entries: [] });

    const groups = await getLoadedGroups();
    const todayChildren = await provider.getChildren(groups[0]);

    expect(todayChildren).toHaveLength(2);
    expect(todayChildren[0].label).toBe("#123 Test Issue 123");
    expect(todayChildren[0].description).toBe("2:30 • Development • Test Project");
    expect(todayChildren[1].label).toBe("#124 Test Issue 124");
    expect(todayChildren[1].description).toBe("1:30 • Testing • Test Project");
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
        spent_on: "2025-11-24",
      },
      {
        id: 2,
        issue_id: 124,
        activity_id: 10,
        activity: { id: 10, name: "Testing" },
        hours: "1.5",
        comments: "",
        spent_on: "2025-11-24",
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: todayEntries })
      .mockResolvedValueOnce({ time_entries: todayEntries })
      .mockResolvedValueOnce({ time_entries: todayEntries });

    const groups = await getLoadedGroups();

    expect(groups[0].label).toContain("Today");
    expect(groups[0].description).toContain("4:00"); // Contains total in H:MM format
    expect(groups[1].label).toContain("This Week");
    expect(groups[1].description).toContain("4:00");
    expect(groups[2].label).toContain("This Month");
    expect(groups[2].description).toContain("4:00");
  });

  it("shows empty state when no entries", async () => {
    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: [] })
      .mockResolvedValueOnce({ time_entries: [] })
      .mockResolvedValueOnce({ time_entries: [] });

    const groups = await getLoadedGroups();

    expect(groups).toHaveLength(3);
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
        spent_on: "2025-11-24",
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: todayEntries })
      .mockResolvedValueOnce({ time_entries: [] })
      .mockResolvedValueOnce({ time_entries: [] });

    const groups = await getLoadedGroups();
    const todayChildren = await provider.getChildren(groups[0]);

    expect(todayChildren[0].contextValue).toBe("time-entry");
  });

  it("refresh fires onDidChangeTreeData event", () => {
    const eventSpy = vi.fn();
    provider.onDidChangeTreeData(eventSpy);

    provider.refresh();

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
        spent_on: "2025-11-24",
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: todayEntries })
      .mockResolvedValueOnce({ time_entries: [] })
      .mockResolvedValueOnce({ time_entries: [] });

    mockServer.getIssueById.mockResolvedValue({
      issue: { id: 123, subject: "Fetched Issue Subject", project: { id: 1, name: "Test Project" } },
    });

    const groups = await getLoadedGroups();
    const todayChildren = await provider.getChildren(groups[0]);

    expect(todayChildren).toHaveLength(1);
    expect(todayChildren[0].label).toBe("#123 Fetched Issue Subject");
    expect(mockServer.getIssueById).toHaveBeenCalledWith(123);
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
        spent_on: "2025-11-24",
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: todayEntries })
      .mockResolvedValueOnce({ time_entries: todayEntries })
      .mockResolvedValueOnce({ time_entries: [] });

    mockServer.getIssueById.mockResolvedValue({
      issue: { id: 123, subject: "Cached Issue", project: { id: 1, name: "Test Project" } },
    });

    const groups = await getLoadedGroups();

    // First expansion - should fetch issue
    await provider.getChildren(groups[0]);
    expect(mockServer.getIssueById).toHaveBeenCalledTimes(1);

    // Second expansion (This Week) - should use cache
    await provider.getChildren(groups[1]);
    expect(mockServer.getIssueById).toHaveBeenCalledTimes(1); // Still 1, not 2
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
        spent_on: "2025-11-24",
      },
    ];

    mockServer.getTimeEntries.mockResolvedValue({ time_entries: todayEntries });

    mockServer.getIssueById.mockResolvedValue({
      issue: { id: 123, subject: "Fresh Issue", project: { id: 1, name: "Test Project" } },
    });

    const groups = await getLoadedGroups();
    await provider.getChildren(groups[0]);
    expect(mockServer.getIssueById).toHaveBeenCalledTimes(1);

    // Refresh should clear cache
    provider.refresh();

    const newGroups = await getLoadedGroups();
    await provider.getChildren(newGroups[0]);
    expect(mockServer.getIssueById).toHaveBeenCalledTimes(2); // Fetched again
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
        spent_on: "2025-11-24",
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: todayEntries })
      .mockResolvedValueOnce({ time_entries: [] })
      .mockResolvedValueOnce({ time_entries: [] });

    mockServer.getIssueById.mockRejectedValue(new Error("Issue not found"));

    const groups = await getLoadedGroups();
    const todayChildren = await provider.getChildren(groups[0]);

    expect(todayChildren).toHaveLength(1);
    expect(todayChildren[0].label).toBe("#999 Unknown Issue");
  });

  it("groups This Week entries by day of week", async () => {
    const weekEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "4",
        comments: "",
        spent_on: "2025-12-15", // Monday
      },
      {
        id: 2,
        issue_id: 124,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "3",
        comments: "",
        spent_on: "2025-12-15", // Monday (same day)
      },
      {
        id: 3,
        issue_id: 125,
        activity_id: 10,
        activity: { id: 10, name: "Testing" },
        hours: "2",
        comments: "",
        spent_on: "2025-12-16", // Tuesday
      },
    ];

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: [] }) // today
      .mockResolvedValueOnce({ time_entries: weekEntries }) // week
      .mockResolvedValueOnce({ time_entries: weekEntries }); // month

    const groups = await getLoadedGroups();
    const thisWeek = groups[1];
    expect(thisWeek.label).toContain("This Week");

    // Get day groups
    const dayGroups = await provider.getChildren(thisWeek);

    // Should have 2 day groups (Monday and Tuesday)
    expect(dayGroups.length).toBe(2);
    expect(dayGroups[0].type).toBe("day-group");

    // Days should be in order (Monday before Tuesday)
    expect(dayGroups[0].label).toContain("Mon");
    expect(dayGroups[1].label).toContain("Tue");

    // Monday should show 7:00 total (4+3)
    expect(dayGroups[0].description).toContain("7:00");

    // Tuesday should show 2:00
    expect(dayGroups[1].description).toContain("2:00");

    // Get entries for Monday
    const mondayEntries = await provider.getChildren(dayGroups[0]);
    expect(mondayEntries.length).toBe(2);
  });

  it("groups This Month entries by week then day", async () => {
    const monthEntries: TimeEntry[] = [
      // Week 50 (Dec 9-15)
      {
        id: 1,
        issue_id: 123,
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "8",
        comments: "",
        spent_on: "2025-12-09", // Tuesday (week 50)
      },
      // Week 51 (Dec 16-22)
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

    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: [] }) // today
      .mockResolvedValueOnce({ time_entries: [] }) // week
      .mockResolvedValueOnce({ time_entries: monthEntries }); // month

    const groups = await getLoadedGroups();
    const thisMonth = groups[2];
    expect(thisMonth.label).toContain("This Month");

    // Get week groups
    const weekGroups = await provider.getChildren(thisMonth);

    // Should have 2 week groups
    expect(weekGroups.length).toBe(2);
    expect(weekGroups[0].type).toBe("week-subgroup");

    // Weeks should be in reverse chronological order (most recent first)
    expect(weekGroups[0].label).toContain("Week 51");
    expect(weekGroups[1].label).toContain("Week 50");

    // Get days for Week 51 (now first)
    const week51Days = await provider.getChildren(weekGroups[0]);
    expect(week51Days.length).toBe(2); // Mon 15, Tue 16
    expect(week51Days[0].type).toBe("day-group");

    // Get entries for a day
    const dayEntries = await provider.getChildren(week51Days[0]);
    expect(dayEntries.length).toBe(1);
  });
});
