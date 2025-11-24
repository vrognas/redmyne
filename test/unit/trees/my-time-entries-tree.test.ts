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
        // Default mock: return issue with subject based on ID
        return Promise.resolve({
          issue: { id, subject: `Test Issue ${id}` },
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
    expect(secondResult[0].label).toBe("Today");
    expect(secondResult[1].label).toBe("This Week");
    expect(secondResult[2].label).toBe("This Month");
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
    expect(todayChildren[0].description).toBe("2.5h Development");
    expect(todayChildren[1].label).toBe("#124 Test Issue 124");
    expect(todayChildren[1].description).toBe("1.5h Testing");
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

    expect(groups[0].label).toBe("Today");
    expect(groups[0].description).toContain("4h"); // Contains total (format may vary based on working days)
    expect(groups[1].label).toBe("This Week");
    expect(groups[1].description).toContain("4h");
    expect(groups[2].label).toBe("This Month");
    expect(groups[2].description).toContain("4h");
  });

  it("shows empty state when no entries", async () => {
    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: [] })
      .mockResolvedValueOnce({ time_entries: [] })
      .mockResolvedValueOnce({ time_entries: [] });

    const groups = await getLoadedGroups();

    expect(groups).toHaveLength(3);
    expect(groups[0].description).toContain("0h"); // Contains 0h total

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
      issue: { id: 123, subject: "Fetched Issue Subject" },
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
      issue: { id: 123, subject: "Cached Issue" },
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
      issue: { id: 123, subject: "Fresh Issue" },
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
});
