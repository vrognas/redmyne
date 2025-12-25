/**
 * Schedule Configuration Utility
 * Shared access to working hours schedule configuration
 */

import * as vscode from "vscode";
import { WeeklySchedule, DEFAULT_WEEKLY_SCHEDULE } from "./flexibility-calculator";

/**
 * Get the weekly schedule from configuration
 */
export function getWeeklySchedule(): WeeklySchedule {
  const config = vscode.workspace.getConfiguration("redmine.workingHours");
  return config.get<WeeklySchedule>("weeklySchedule", DEFAULT_WEEKLY_SCHEDULE);
}
