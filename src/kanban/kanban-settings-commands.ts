import * as vscode from "vscode";
import { KANBAN_TIMER_KEYS, KANBAN_TIMER_DEFAULTS } from "./kanban-state";
import { showStatusBarMessage } from "../utilities/status-bar";
import { KanbanCommandDeps, createIntegerRangeValidator } from "./kanban-command-helpers";

/** Cleanup + Configure Timer settings commands. */
export function registerKanbanSettingsCommands(deps: KanbanCommandDeps): vscode.Disposable[] {
  const { context, controller } = deps;
  const disposables: vscode.Disposable[] = [];

  // Cleanup corrupted tasks
  disposables.push(
    vscode.commands.registerCommand("redmyne.kanban.cleanup", async () => {
      const tasks = controller.getTasks();
      const corruptedTasks = tasks.filter(
        (t) => !t.title || !t.linkedIssueId || !t.linkedProjectName
      );

      if (corruptedTasks.length === 0) {
        vscode.window.showInformationMessage("No corrupted tasks found");
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Found ${corruptedTasks.length} corrupted task(s). Delete them?`,
        { modal: true },
        "Delete"
      );
      if (confirm !== "Delete") return;

      for (const task of corruptedTasks) {
        await controller.deleteTask(task.id);
      }

      vscode.window.showInformationMessage(
        `Deleted ${corruptedTasks.length} corrupted task(s)`
      );
    })
  );

  // Configure Timer Settings
  disposables.push(
    vscode.commands.registerCommand("redmyne.kanban.configureTimer", async () => {
      const currentUnit = context.globalState.get<number>(KANBAN_TIMER_KEYS.unitDuration, KANBAN_TIMER_DEFAULTS.unitDuration);
      const currentWork = context.globalState.get<number>(KANBAN_TIMER_KEYS.workDuration, KANBAN_TIMER_DEFAULTS.workDuration);
      const currentBreak = currentUnit - currentWork;
      const currentSound = context.globalState.get<boolean>(KANBAN_TIMER_KEYS.soundEnabled, KANBAN_TIMER_DEFAULTS.soundEnabled);
      const currentBarWidth = context.globalState.get<number>(KANBAN_TIMER_KEYS.progressBarWidth, KANBAN_TIMER_DEFAULTS.progressBarWidth);

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
          {
            label: `$(symbol-number) Progress Bar: ${currentBarWidth} segments`,
            description: "Number of segments in progress bar (3-100)",
            setting: "progressBar",
          },
        ],
        { placeHolder: "Configure timer" }
      );

      if (!choice) return;

      if (choice.setting === "sound") {
        await context.globalState.update(KANBAN_TIMER_KEYS.soundEnabled, !currentSound);
        showStatusBarMessage(`$(check) Sound ${!currentSound ? "enabled" : "disabled"}`, 2000);
        return;
      }

      if (choice.setting === "progressBar") {
        const input = await vscode.window.showInputBox({
          prompt: "Enter number of progress bar segments (3-100):",
          value: currentBarWidth.toString(),
          validateInput: createIntegerRangeValidator({
            min: 3,
            max: 100,
            minMessage: "Minimum 3 segments",
            maxMessage: "Maximum 100 segments",
          }),
        });
        if (!input) return;
        const value = parseInt(input, 10);
        await context.globalState.update(KANBAN_TIMER_KEYS.progressBarWidth, value);
        showStatusBarMessage(`$(check) Progress bar set to ${value} segments`, 2000);
        return;
      }

      if (choice.setting === "break") {
        const input = await vscode.window.showInputBox({
          prompt: `Break = Unit (${currentUnit}min) - Work. Enter new break duration:`,
          value: currentBreak.toString(),
          validateInput: createIntegerRangeValidator({
            min: 0,
            max: currentUnit,
            minMessage: "Minimum 0 minutes",
            maxMessage: `Must be less than unit duration (${currentUnit}min)`,
            maxInclusive: false,
          }),
        });
        if (!input) return;
        const newBreak = parseInt(input, 10);
        const newWork = currentUnit - newBreak;
        await context.globalState.update(KANBAN_TIMER_KEYS.workDuration, newWork);
        controller.setWorkDurationSeconds(newWork * 60);
        controller.setBreakDurationSeconds(newBreak * 60);
        showStatusBarMessage(`$(check) Break set to ${newBreak}min (work: ${newWork}min)`, 2000);
        return;
      }

      const prompt = choice.setting === "unitDuration"
        ? "Enter unit duration (minutes):"
        : "Enter work duration (minutes):";
      const current = choice.setting === "unitDuration" ? currentUnit : currentWork;
      const max = choice.setting === "unitDuration" ? 480 : currentUnit;

      const input = await vscode.window.showInputBox({
        prompt,
        value: current.toString(),
        validateInput: createIntegerRangeValidator({
          min: 1,
          max,
          minMessage: "Minimum 1 minute",
          maxMessage: `Maximum ${max} minutes`,
        }),
      });
      if (!input) return;

      const value = parseInt(input, 10);
      if (choice.setting === "unitDuration") {
        await context.globalState.update(KANBAN_TIMER_KEYS.unitDuration, value);
        // Adjust work duration if needed
        const effectiveWork = Math.min(currentWork, value);
        if (currentWork > value) {
          await context.globalState.update(KANBAN_TIMER_KEYS.workDuration, value);
          controller.setWorkDurationSeconds(value * 60);
        }
        controller.setBreakDurationSeconds((value - effectiveWork) * 60);
        showStatusBarMessage(`$(check) Unit duration set to ${value}min`, 2000);
      } else {
        await context.globalState.update(KANBAN_TIMER_KEYS.workDuration, value);
        controller.setWorkDurationSeconds(value * 60);
        controller.setBreakDurationSeconds((currentUnit - value) * 60);
        showStatusBarMessage(`$(check) Work duration set to ${value}min`, 2000);
      }
    })
  );

  return disposables;
}
