/**
 * Monthly Schedule Commands
 * Commands for managing monthly working hours schedules
 */

import * as vscode from "vscode";
import {
  WeeklySchedule,
  DEFAULT_WEEKLY_SCHEDULE,
} from "../utilities/flexibility-calculator";
import {
  MonthlyScheduleOverrides,
  getMonthOptions,
  formatMonthKeyDisplay,
  formatScheduleDisplay,
  calculateWeeklyTotal,
  calculateMonthlyTotal,
  saveMonthlySchedules,
} from "../utilities/monthly-schedule";
import { formatHoursAsHHMM } from "../utilities/time-input";
import { showStatusBarMessage } from "../utilities/status-bar";

export interface MonthlyScheduleCommandDeps {
  getOverrides: () => MonthlyScheduleOverrides;
  setOverrides: (overrides: MonthlyScheduleOverrides) => void;
  refreshTree: () => void;
  setTreeSchedules: (overrides: MonthlyScheduleOverrides) => void;
}

export function registerMonthlyScheduleCommands(
  context: vscode.ExtensionContext,
  deps: MonthlyScheduleCommandDeps
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.workingHours.editMonth", async () => {
      // Get default schedule from config
      const config = vscode.workspace.getConfiguration("redmyne.workingHours");
      const defaultSchedule = config.get<WeeklySchedule>("weeklySchedule", DEFAULT_WEEKLY_SCHEDULE);
      const overrides = deps.getOverrides();

      // Select month
      const monthOptions = getMonthOptions();
      const monthItems = monthOptions.map((opt) => {
        const existing = overrides[opt.key];
        const weeklyHours = existing ? calculateWeeklyTotal(existing) : calculateWeeklyTotal(defaultSchedule);
        const monthlyHours = existing
          ? calculateMonthlyTotal(opt.key, existing)
          : calculateMonthlyTotal(opt.key, defaultSchedule);
        return {
          label: `${existing ? "$(calendar)" : "$(dash)"} ${opt.label}`,
          description: `${formatHoursAsHHMM(weeklyHours)}/week, ${formatHoursAsHHMM(monthlyHours)} total`,
          detail: existing ? formatScheduleDisplay(existing) : "(using default)",
          key: opt.key,
          hasOverride: !!existing,
        };
      });

      const selectedMonth = await vscode.window.showQuickPick(monthItems, {
        title: "Edit Monthly Working Hours",
        placeHolder: "Select month to configure",
      });

      if (!selectedMonth) return;

      // Get current schedule for this month
      const currentSchedule = overrides[selectedMonth.key] ?? { ...defaultSchedule };

      // Quick pick for what to do
      const actions = [
        {
          label: "$(edit) Edit day-by-day",
          description: "Configure hours for each day",
          action: "edit",
        },
        {
          label: "$(files) Copy from default",
          description: `Reset to default (${calculateWeeklyTotal(defaultSchedule)}h/week)`,
          action: "copy",
        },
        {
          label: "$(trash) Clear override",
          description: "Use default schedule",
          action: "clear",
          disabled: !selectedMonth.hasOverride,
        },
      ].filter((a) => !a.disabled);

      const selectedAction = await vscode.window.showQuickPick(actions, {
        title: `${formatMonthKeyDisplay(selectedMonth.key)}`,
        placeHolder: "What would you like to do?",
      });

      if (!selectedAction) return;

      if (selectedAction.action === "clear") {
        delete overrides[selectedMonth.key];
        deps.setOverrides(overrides);
        await saveMonthlySchedules(context.globalState, overrides);
        deps.setTreeSchedules(overrides);
        showStatusBarMessage(
          `$(check) ${formatMonthKeyDisplay(selectedMonth.key)} reset to default`,
          2000
        );
        deps.refreshTree();
        return;
      }

      if (selectedAction.action === "copy") {
        overrides[selectedMonth.key] = { ...defaultSchedule };
        deps.setOverrides(overrides);
        await saveMonthlySchedules(context.globalState, overrides);
        deps.setTreeSchedules(overrides);
        showStatusBarMessage(
          `$(check) ${formatMonthKeyDisplay(selectedMonth.key)} set to default`,
          2000
        );
        deps.refreshTree();
        return;
      }

      // Edit day-by-day
      const days: (keyof WeeklySchedule)[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      const newSchedule = { ...currentSchedule };

      for (const day of days) {
        const input = await vscode.window.showInputBox({
          title: `${formatMonthKeyDisplay(selectedMonth.key)} - ${day}`,
          prompt: `Hours for ${day} (0-24)`,
          value: String(newSchedule[day]),
          validateInput: (v) => {
            const num = parseFloat(v);
            if (isNaN(num) || num < 0 || num > 24) {
              return "Enter a number between 0 and 24";
            }
            return null;
          },
        });

        if (input === undefined) {
          // User cancelled - ask if they want to save partial changes
          const save = await vscode.window.showWarningMessage(
            "Save partial changes?",
            { modal: true },
            "Save",
            "Discard"
          );
          if (save === "Save") {
            overrides[selectedMonth.key] = newSchedule;
            deps.setOverrides(overrides);
            await saveMonthlySchedules(context.globalState, overrides);
            deps.setTreeSchedules(overrides);
            showStatusBarMessage("$(check) Partial changes saved", 2000);
            deps.refreshTree();
          }
          return;
        }

        newSchedule[day] = parseFloat(input);
      }

      // Save complete schedule
      overrides[selectedMonth.key] = newSchedule;
      deps.setOverrides(overrides);
      await saveMonthlySchedules(context.globalState, overrides);
      deps.setTreeSchedules(overrides);

      const weeklyTotal = calculateWeeklyTotal(newSchedule);
      const monthlyTotal = calculateMonthlyTotal(selectedMonth.key, newSchedule);
      showStatusBarMessage(
        `$(check) ${formatMonthKeyDisplay(selectedMonth.key)}: ${weeklyTotal}h/week, ${monthlyTotal}h total`,
        3000
      );
      deps.refreshTree();
    })
  );
}
