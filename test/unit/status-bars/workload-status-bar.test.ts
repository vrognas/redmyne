import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { WorkloadStatusBar } from "../../../src/status-bars/workload-status-bar";
import { getMonthKey } from "../../../src/utilities/monthly-schedule";
import * as workloadCalculator from "../../../src/utilities/workload-calculator";

type StatusBarItemMock = {
  text: string;
  command?: string;
  tooltip?: unknown;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

describe("WorkloadStatusBar", () => {
  let showWorkload = true;

  beforeEach(() => {
    vi.clearAllMocks();
    showWorkload = true;

    vi.mocked(vscode.workspace.getConfiguration).mockImplementation((section?: string) => {
      if (section === "redmyne.statusBar") {
        return {
          get: vi.fn((key: string, fallback?: unknown) =>
            key === "showWorkload" ? showWorkload : fallback
          ),
          update: vi.fn(),
        } as unknown as vscode.WorkspaceConfiguration;
      }

      if (section === "redmyne.workingHours") {
        return {
          get: vi.fn((_key: string, fallback?: unknown) => fallback),
          update: vi.fn(),
        } as unknown as vscode.WorkspaceConfiguration;
      }

      return {
        get: vi.fn(),
        update: vi.fn(),
      } as unknown as vscode.WorkspaceConfiguration;
    });
  });

  it("does nothing when workload status bar feature is disabled", async () => {
    showWorkload = false;
    const deps = {
      fetchIssuesIfNeeded: vi.fn().mockResolvedValue([]),
      getMonthlySchedules: vi.fn().mockReturnValue(undefined),
      getUserFte: vi.fn().mockReturnValue(undefined),
    };

    const bar = new WorkloadStatusBar(deps as never);
    await bar.update();
    bar.dispose();

    expect(vscode.window.createStatusBarItem).not.toHaveBeenCalled();
    expect(deps.fetchIssuesIfNeeded).not.toHaveBeenCalled();
  });

  it("hides the status bar when there are no issues", async () => {
    const deps = {
      fetchIssuesIfNeeded: vi.fn().mockResolvedValue([]),
      getMonthlySchedules: vi.fn().mockReturnValue(undefined),
      getUserFte: vi.fn().mockReturnValue(undefined),
    };

    const bar = new WorkloadStatusBar(deps as never);
    await bar.update();

    const item = vi.mocked(vscode.window.createStatusBarItem).mock
      .results[0].value as StatusBarItemMock;
    expect(item.hide).toHaveBeenCalledTimes(1);
    expect(item.show).not.toHaveBeenCalled();

    bar.dispose();
  });

  it("renders workload text and tooltip details with schedule/FTE info", async () => {
    const currentMonthKey = getMonthKey(new Date());
    const deps = {
      fetchIssuesIfNeeded: vi.fn().mockResolvedValue([{}]),
      getMonthlySchedules: vi.fn().mockReturnValue({
        [currentMonthKey]: {
          Mon: 6,
          Tue: 6,
          Wed: 6,
          Thu: 6,
          Fri: 6,
          Sat: 0,
          Sun: 0,
        },
      }),
      getUserFte: vi.fn().mockReturnValue(0.8),
    };

    vi.spyOn(workloadCalculator, "calculateWorkload").mockReturnValue({
      totalEstimated: 10,
      totalSpent: 2,
      remaining: 8,
      availableThisWeek: 18,
      buffer: 10,
      topUrgent: [{ id: 42, subject: "Urgent", daysLeft: 1, hoursLeft: 2 }],
    });

    const bar = new WorkloadStatusBar(deps as never);
    await bar.update();

    const item = vi.mocked(vscode.window.createStatusBarItem).mock
      .results[0].value as StatusBarItemMock;

    expect(item.text).toBe("$(pulse) 8h left, +10h buffer");
    expect(item.show).toHaveBeenCalledTimes(1);
    expect((item.tooltip as vscode.MarkdownString).value).toContain("Workload Overview");
    expect((item.tooltip as vscode.MarkdownString).value).toContain("Your FTE");
    expect((item.tooltip as vscode.MarkdownString).value).toContain("Schedule:");
    expect((item.tooltip as vscode.MarkdownString).value).toContain("#42: 1d");

    bar.dispose();
  });
});
