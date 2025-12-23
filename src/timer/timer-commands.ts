import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { TimerController } from "./timer-controller";
import { showPlanDayDialog, pickIssueAndActivity } from "./timer-dialogs";
import { showStatusBarMessage } from "../utilities/status-bar";
import { playCompletionSound } from "./timer-sound";
import { formatHoursAsHHMM } from "../utilities/time-input";

interface TreeItem {
  type?: string;
  index?: number;
}

/**
 * Register all timer-related commands
 */
export function registerTimerCommands(
  context: vscode.ExtensionContext,
  controller: TimerController,
  getServer: () => RedmineServer | undefined,
  timerTreeView?: vscode.TreeView<TreeItem>
): void {
  // Timer config stored in globalState (not VS Code settings - allows proper validation)
  const getUnitDuration = () => {
    const val = context.globalState.get<number>("redmine.timer.unitDuration", 60);
    return Math.max(1, Math.min(120, val)); // Clamp to valid range
  };
  const getWorkDuration = () => {
    const unit = getUnitDuration();
    const work = context.globalState.get<number>("redmine.timer.workDuration", 45);
    // Clamp work duration to valid range (1 to unitDuration)
    return Math.max(1, Math.min(work, unit));
  };
  const getWorkDurationSeconds = () => getWorkDuration() * 60;
  const getSoundEnabled = () => context.globalState.get<boolean>("redmine.timer.soundEnabled", true);

  // Plan day wizard
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.planDay", async () => {
      const server = getServer();
      if (!server) {
        vscode.window.showErrorMessage("No Redmine server configured");
        return;
      }

      const units = await showPlanDayDialog(server, getUnitDuration(), getWorkDurationSeconds());
      if (!units || units.length === 0) return;

      controller.setPlan(units);
      showStatusBarMessage(`$(check) Planned ${units.length} units`, 2000);

      // Optionally auto-start
      const autoStart = await vscode.window.showQuickPick(
        [
          { label: "$(play) Start now", start: true },
          { label: "$(clock) Start later", start: false },
        ],
        { placeHolder: "Ready to start?" }
      );

      if (autoStart?.start) {
        controller.start();
      }
    })
  );

  // Start timer (respects tree view selection if available)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.start", () => {
      // Check if a unit is selected in tree view
      if (timerTreeView?.selection?.length) {
        const selected = timerTreeView.selection[0];
        if (selected?.type === "unit" && selected.index !== undefined) {
          controller.startUnit(selected.index);
          return;
        }
      }
      // Fallback to starting current unit
      controller.start();
    })
  );

  // Pause timer
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.pause", () => {
      controller.pause();
    })
  );

  // Resume timer
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.resume", () => {
      controller.resume();
    })
  );

  // Stop timer (keeps plan)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.stop", () => {
      controller.stop();
      showStatusBarMessage("$(check) Timer stopped", 2000);
    })
  );

  // Clear plan (destructive - removes all units)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.clearPlan", async () => {
      const confirm = await vscode.window.showQuickPick(
        [
          { label: "$(trash) Yes, clear plan", confirm: true },
          { label: "$(close) Cancel", confirm: false },
        ],
        { placeHolder: "Clear all planned units?" }
      );

      if (confirm?.confirm) {
        controller.clearPlan();
        showStatusBarMessage("$(check) Plan cleared", 2000);
      }
    })
  );

  // Toggle (pause/resume/start)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.toggle", () => {
      controller.toggle();
    })
  );

  // Start next unit
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.startNextUnit", () => {
      controller.startNextUnit();
    })
  );

  // Skip break
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.skipBreak", () => {
      controller.skipBreak();
    })
  );

  // Show log dialog (triggered when timer completes)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.showLogDialog", async () => {
      const unit = controller.getCurrentUnit();
      if (!unit) return;

      const server = getServer();
      if (!server) {
        vscode.window.showErrorMessage("No Redmine server configured");
        return; // Stay in logging phase, let user retry
      }

      // Handle unassigned units
      if (unit.issueId <= 0) {
        controller.skipLogging();
        showStatusBarMessage("$(info) No issue assigned - skipped", 2000);
        return;
      }

      const hoursPerUnit = getUnitDuration() / 60;
      const hoursStr = formatHoursAsHHMM(hoursPerUnit);

      // Go directly to comment input (skip redundant QuickPick)
      const comment = await vscode.window.showInputBox({
        title: `Log ${hoursStr} to #${unit.issueId}`,
        prompt: `${unit.issueSubject} • ${unit.activityName}`,
        value: unit.comment || "",
        placeHolder: "Comment (optional)",
      });

      // Cancel → stay in logging phase, let user retry
      if (comment === undefined) return;

      // Log to Redmine
      try {
        const response = await server.addTimeEntry(
          unit.issueId,
          unit.activityId,
          hoursPerUnit.toString(),
          comment || ""
        );
        const timeEntryId = response?.time_entry?.id;

        // Refresh time entries tree
        vscode.commands.executeCommand("redmine.refreshTimeEntries");

        showStatusBarMessage(
          `$(check) Logged ${hoursStr} to #${unit.issueId}`,
          2000
        );

        controller.markLogged(hoursPerUnit, timeEntryId);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to log time: ${error}`);
        // Stay in logging phase, let user retry
      }
    })
  );

  // Add unit to existing plan
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.addUnit", async () => {
      const server = getServer();
      if (!server) {
        vscode.window.showErrorMessage("No Redmine server configured");
        return;
      }

      // Use dialog to pick units
      const units = await showPlanDayDialog(server, getUnitDuration(), getWorkDurationSeconds());
      if (!units || units.length === 0) return;

      // Append to existing plan
      const currentPlan = controller.getPlan();
      controller.setPlan([...currentPlan, ...units]);

      showStatusBarMessage(`$(check) Added ${units.length} unit(s)`, 2000);
    })
  );

  // Remove unit from plan
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.removeUnit", async (item: { index?: number }) => {
      const index = item?.index;
      if (index === undefined) return;

      const unit = controller.getPlan()[index];
      if (!unit) return;

      const confirm = await vscode.window.showQuickPick(
        [
          { label: "$(trash) Yes, remove", confirm: true },
          { label: "$(close) Cancel", confirm: false },
        ],
        { placeHolder: `Remove unit ${index + 1}: #${unit.issueId || "(not assigned)"}?` }
      );

      if (confirm?.confirm) {
        controller.removeUnit(index);
        showStatusBarMessage("$(check) Unit removed", 2000);
      }
    })
  );

  // Edit unit issue/activity
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.editUnit", async (item: { index?: number }) => {
      const index = item?.index;
      if (index === undefined) return;

      const server = getServer();
      if (!server) {
        vscode.window.showErrorMessage("No Redmine server configured");
        return;
      }

      const newUnit = await pickIssueAndActivity(server, `Edit Unit ${index + 1}`, getWorkDurationSeconds());
      if (!newUnit) return;

      // Preserve existing timer state when editing issue/activity
      const existingUnit = controller.getPlan()[index];
      controller.updateUnit(index, {
        ...newUnit,
        secondsLeft: existingUnit?.secondsLeft ?? newUnit.secondsLeft,
        unitPhase: existingUnit?.unitPhase ?? newUnit.unitPhase,
      });
      showStatusBarMessage("$(check) Unit updated", 2000);
    })
  );

  // Start specific unit (from context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.startUnit", (item: { index?: number }) => {
      const index = item?.index;
      if (index === undefined) return;

      controller.startUnit(index);
    })
  );

  // Toggle unit by index (from tree item command - Enter/click)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.toggleUnit", (index: number) => {
      if (index === undefined) return;

      const plan = controller.getPlan();
      const unit = plan[index];
      if (!unit) return;

      // Toggle based on unit state
      if (unit.unitPhase === "working") {
        controller.pause();
      } else if (unit.unitPhase === "pending" || unit.unitPhase === "paused") {
        controller.startUnit(index);
      }
      // completed: do nothing
    })
  );

  // Keep command for programmatic access
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.toggleSelectedUnit", () => {
      if (!timerTreeView?.selection?.length) return;

      const selected = timerTreeView.selection[0];
      if (selected?.type !== "unit" || selected.index === undefined) return;

      const plan = controller.getPlan();
      const unit = plan[selected.index];
      if (!unit) return;

      if (unit.unitPhase === "working") {
        controller.pause();
      } else if (unit.unitPhase === "pending" || unit.unitPhase === "paused") {
        controller.startUnit(selected.index);
      }
    })
  );

  // Reset unit timer
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.resetUnit", (item: { index?: number }) => {
      const index = item?.index;
      if (index === undefined) return;

      controller.resetUnit(index);
      showStatusBarMessage("$(check) Timer reset", 2000);
    })
  );

  // Move unit up
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.moveUnitUp", (item: { index?: number }) => {
      const index = item?.index;
      if (index === undefined || index === 0) return;

      controller.moveUnit(index, index - 1);
    })
  );

  // Move unit down
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.moveUnitDown", (item: { index?: number }) => {
      const index = item?.index;
      if (index === undefined) return;

      const plan = controller.getPlan();
      if (index >= plan.length - 1) return;

      controller.moveUnit(index, index + 1);
    })
  );

  // Reveal completed unit in My Time Entries
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.revealTimeEntry", async (item: { index?: number }) => {
      const index = item?.index;
      const unit = index !== undefined ? controller.getPlan()[index] : undefined;

      // Focus the time entries view and refresh
      await vscode.commands.executeCommand("redmine-explorer-my-time-entries.focus");
      await vscode.commands.executeCommand("redmine.refreshTimeEntries");

      // Show info about which entry to look for
      if (unit?.timeEntryId) {
        showStatusBarMessage(`$(eye) Look for entry #${unit.timeEntryId}`, 3000);
      }
    })
  );

  // Configure timer settings (stored in globalState for proper validation)
  context.subscriptions.push(
    vscode.commands.registerCommand("redmine.timer.configureTimer", async () => {
      const currentUnit = getUnitDuration();
      const currentWork = getWorkDuration();
      const currentBreak = currentUnit - currentWork;
      const currentSound = getSoundEnabled();

      const choice = await vscode.window.showQuickPick(
        [
          {
            label: `$(clock) Unit Duration: ${currentUnit} min`,
            description: "Total time logged per unit",
            setting: "unitDuration",
          },
          {
            label: `$(pulse) Work Duration: ${currentWork} min`,
            description: "Active work time before break",
            setting: "workDuration",
          },
          {
            label: `$(coffee) Break Duration: ${currentBreak} min`,
            description: "Adjusts work duration to match",
            setting: "break",
          },
          {
            label: `$(unmute) Sound: ${currentSound ? "On" : "Off"}`,
            description: "Play sound when timer completes",
            setting: "sound",
          },
        ],
        { placeHolder: "Configure timer" }
      );

      if (!choice) return;

      if (choice.setting === "sound") {
        await context.globalState.update("redmine.timer.soundEnabled", !currentSound);
        showStatusBarMessage(`$(check) Sound ${!currentSound ? "enabled" : "disabled"}`, 2000);
        return;
      }

      if (choice.setting === "break") {
        // Let user adjust break by changing work duration
        const input = await vscode.window.showInputBox({
          prompt: `Break = Unit (${currentUnit}min) - Work. Enter new break duration:`,
          value: currentBreak.toString(),
          validateInput: (v) => {
            const n = parseInt(v, 10);
            if (isNaN(n) || n < 0) return "Minimum 0 minutes";
            if (n >= currentUnit) return `Must be less than unit duration (${currentUnit}min)`;
            return null;
          },
        });

        if (!input) return;

        const newBreak = parseInt(input, 10);
        const newWork = currentUnit - newBreak;
        await context.globalState.update("redmine.timer.workDuration", newWork);
        showStatusBarMessage(`$(check) Break set to ${newBreak}min (work: ${newWork}min)`, 2000);
        return;
      }

      const input = await vscode.window.showInputBox({
        prompt: `Enter new ${choice.setting === "unitDuration" ? "unit" : "work"} duration in minutes`,
        value: choice.setting === "unitDuration" ? currentUnit.toString() : currentWork.toString(),
        validateInput: (v) => {
          const n = parseInt(v, 10);
          if (isNaN(n) || n < 1) return "Minimum 1 minute";
          if (n > 120) return "Maximum 120 minutes";
          // Work duration must not exceed unit duration
          if (choice.setting === "workDuration" && n > currentUnit) {
            return `Must be ≤ unit duration (${currentUnit} min)`;
          }
          return null;
        },
      });

      if (!input) return;

      const value = parseInt(input, 10);
      await context.globalState.update(`redmine.timer.${choice.setting}`, value);
      showStatusBarMessage(`$(check) ${choice.setting === "unitDuration" ? "Unit" : "Work"} duration set to ${value}min`, 2000);
    })
  );

  // Listen for timer complete event
  context.subscriptions.push(
    controller.onTimerComplete(async (unit) => {
      if (getSoundEnabled()) {
        playCompletionSound();
      }
      // Show prominent modal notification
      let issueLabel: string;
      if (unit.issueId > 0) {
        const comment = unit.comment ? ` ${unit.comment}` : "";
        const activity = unit.activityName ? ` [${unit.activityName}]` : "";
        issueLabel = `#${unit.issueId}${comment}${activity} ${unit.issueSubject}`;
      } else {
        issueLabel = "Unassigned";
      }
      const action = await vscode.window.showWarningMessage(
        `Unit Complete\n${issueLabel}`,
        { modal: true },
        "Log Time",
        "Skip"
      );
      if (action === "Log Time") {
        vscode.commands.executeCommand("redmine.timer.showLogDialog");
      } else if (action === "Skip") {
        controller.skipLogging();
        showStatusBarMessage("$(dash) Skipped logging", 2000);
      }
      // Cancel (undefined) → do nothing, stay in logging phase
    })
  );

}
