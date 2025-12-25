/**
 * Workload Status Bar
 * Shows workload overview in status bar
 */

import * as vscode from "vscode";
import { Issue } from "../redmine/models/issue";
import { WeeklySchedule, DEFAULT_WEEKLY_SCHEDULE } from "../utilities/flexibility-calculator";
import { MonthlyScheduleOverrides, getMonthKey, formatMonthKeyDisplay, calculateWeeklyTotal } from "../utilities/monthly-schedule";
import { calculateWorkload } from "../utilities/workload-calculator";
import { formatHoursAsHHMM } from "../utilities/time-input";

export interface WorkloadStatusBarDeps {
  fetchIssuesIfNeeded: () => Promise<Issue[]>;
  getMonthlySchedules: () => MonthlyScheduleOverrides | undefined;
  getUserFte: () => number | undefined;
}

export class WorkloadStatusBar implements vscode.Disposable {
  private statusBar: vscode.StatusBarItem | undefined;
  private deps: WorkloadStatusBarDeps;
  private disposed = false;

  constructor(deps: WorkloadStatusBarDeps) {
    this.deps = deps;
    this.initialize();
  }

  private initialize(): void {
    const config = vscode.workspace.getConfiguration("redmine.statusBar");
    const showWorkload = config.get<boolean>("showWorkload", false);

    if (!showWorkload) {
      this.disposeStatusBar();
      return;
    }

    if (!this.statusBar) {
      this.statusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        50
      );
      this.statusBar.command = "redmine.listOpenIssuesAssignedToMe";
    }
  }

  private disposeStatusBar(): void {
    if (this.statusBar) {
      this.statusBar.dispose();
      this.statusBar = undefined;
    }
  }

  async update(): Promise<void> {
    if (this.disposed || !this.statusBar) return;

    const issues = await this.deps.fetchIssuesIfNeeded();

    if (this.disposed || !this.statusBar) return;

    if (issues.length === 0) {
      this.statusBar.hide();
      return;
    }

    const scheduleConfig = vscode.workspace.getConfiguration("redmine.workingHours");
    const defaultSchedule = scheduleConfig.get<WeeklySchedule>("weeklySchedule", DEFAULT_WEEKLY_SCHEDULE);

    const currentMonthKey = getMonthKey(new Date());
    const monthlySchedules = this.deps.getMonthlySchedules();
    const schedule = monthlySchedules?.[currentMonthKey] ?? defaultSchedule;

    const workload = calculateWorkload(issues, schedule);

    const bufferText = workload.buffer >= 0 ? `+${workload.buffer}h` : `${workload.buffer}h`;
    this.statusBar.text = `$(pulse) ${workload.remaining}h left, ${bufferText} buffer`;

    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = true;
    tooltip.appendMarkdown("**Workload Overview**\n\n");
    tooltip.appendMarkdown(`**Remaining work:** ${workload.remaining}h\n\n`);
    tooltip.appendMarkdown(`**Available this week:** ${workload.availableThisWeek}h\n\n`);
    tooltip.appendMarkdown(`**Buffer:** ${bufferText} ${workload.buffer >= 0 ? "(On Track)" : "(Overbooked)"}\n\n`);

    const userFte = this.deps.getUserFte();
    if (userFte) {
      tooltip.appendMarkdown(`**Your FTE:** ${userFte}\n\n`);
    }

    if (monthlySchedules?.[currentMonthKey]) {
      const weeklyTotal = calculateWeeklyTotal(schedule);
      tooltip.appendMarkdown(`**Schedule:** ${formatMonthKeyDisplay(currentMonthKey)} (${weeklyTotal}h/week)\n\n`);
    }

    if (workload.topUrgent.length > 0) {
      tooltip.appendMarkdown("**Top Urgent:**\n");
      for (const issue of workload.topUrgent) {
        tooltip.appendMarkdown(`- #${issue.id}: ${issue.daysLeft}d, ${formatHoursAsHHMM(issue.hoursLeft)} left\n`);
      }
    }

    this.statusBar.tooltip = tooltip;
    this.statusBar.show();
  }

  reinitialize(): void {
    this.initialize();
  }

  dispose(): void {
    this.disposed = true;
    this.disposeStatusBar();
  }
}
