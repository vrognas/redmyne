import { describe, it, expect, vi, beforeEach } from "vitest";
import { MyTimeEntriesTreeDataProvider } from "../../../src/trees/my-time-entries-tree";
import { TimeEntry } from "../../../src/redmine/models/time-entry";
import * as vscode from "vscode";

describe("MyTimeEntriesTreeDataProvider", () => {
  let mockServer: {
    getTimeEntries: ReturnType<typeof vi.fn>;
    options: { address: string };
  };
  let provider: MyTimeEntriesTreeDataProvider;

  beforeEach(() => {
    mockServer = {
      getTimeEntries: vi.fn(),
      options: { address: "https://redmine.example.com" },
    };

    provider = new MyTimeEntriesTreeDataProvider();
    provider.setServer(mockServer as unknown as never);
  });

  it("shows loading state during concurrent fetch", async () => {
    // Simulate slow fetch
    let resolvePromise: (value: unknown) => void;
    const slowPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    mockServer.getTimeEntries.mockReturnValue(slowPromise);

    // Start first fetch (doesn't await)
    const firstCall = provider.getChildren();

    // Immediately call again - should show loading
    const secondCall = provider.getChildren();
    const loadingResult = await secondCall;

    expect(loadingResult).toHaveLength(1);
    expect(loadingResult[0].label).toContain("Loading");
    expect(loadingResult[0].iconPath).toEqual(
      new vscode.ThemeIcon("loading~spin")
    );

    // Resolve the first call to clean up
    resolvePromise!({ time_entries: [] });
    await firstCall;
  });

  it("caches entries at parent level (no double-fetch)", async () => {
    const todayEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        issue: { id: 123, subject: "Test Issue" },
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
        issue: { id: 124, subject: "Another Issue" },
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

    // Get root groups
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
        issue: { id: 123, subject: "Test Issue" },
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "2.5",
        comments: "Test comment",
        spent_on: "2025-11-24",
      },
      {
        id: 2,
        issue_id: 124,
        issue: { id: 124, subject: "Another Issue" },
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

    const groups = await provider.getChildren();
    const todayChildren = await provider.getChildren(groups[0]);

    expect(todayChildren).toHaveLength(2);
    expect(todayChildren[0].label).toBe("Test Issue");
    expect(todayChildren[0].description).toBe("2.5h Development");
    expect(todayChildren[1].label).toBe("Another Issue");
    expect(todayChildren[1].description).toBe("1.5h Testing");
  });

  it("calculates correct totals for groups", async () => {
    const todayEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        issue: { id: 123, subject: "Test Issue" },
        activity_id: 9,
        activity: { id: 9, name: "Development" },
        hours: "2.5",
        comments: "",
        spent_on: "2025-11-24",
      },
      {
        id: 2,
        issue_id: 124,
        issue: { id: 124, subject: "Another Issue" },
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

    const groups = await provider.getChildren();

    expect(groups[0].label).toBe("Today");
    expect(groups[0].description).toBe("4h"); // 2.5 + 1.5 = 4
    expect(groups[1].label).toBe("This Week");
    expect(groups[1].description).toBe("4h");
    expect(groups[2].label).toBe("This Month");
    expect(groups[2].description).toBe("4h");
  });

  it("shows empty state when no entries", async () => {
    mockServer.getTimeEntries
      .mockResolvedValueOnce({ time_entries: [] })
      .mockResolvedValueOnce({ time_entries: [] })
      .mockResolvedValueOnce({ time_entries: [] });

    const groups = await provider.getChildren();

    expect(groups).toHaveLength(3);
    expect(groups[0].description).toBe("0h");

    const todayChildren = await provider.getChildren(groups[0]);
    expect(todayChildren).toHaveLength(0);
  });

  it("sets contextValue for time entry items", async () => {
    const todayEntries: TimeEntry[] = [
      {
        id: 1,
        issue_id: 123,
        issue: { id: 123, subject: "Test Issue" },
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

    const groups = await provider.getChildren();
    const todayChildren = await provider.getChildren(groups[0]);

    expect(todayChildren[0].contextValue).toBe("time-entry");
  });

  it("refresh fires onDidChangeTreeData event", () => {
    const eventSpy = vi.fn();
    provider.onDidChangeTreeData(eventSpy);

    provider.refresh();

    expect(eventSpy).toHaveBeenCalledWith(undefined);
  });
});
