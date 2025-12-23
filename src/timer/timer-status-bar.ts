import * as vscode from "vscode";
import { TimerController } from "./timer-controller";
import { TimerState, TimerPhase, countCompleted, getWorkingUnit } from "./timer-state";
import { formatHoursAsHHMM, formatSecondsAsMMSS } from "../utilities/time-input";

/**
 * Status bar display for timer
 * Priority 49 (left of workload bar at 50)
 */
export class TimerStatusBar {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private lastPhase: TimerPhase | null = null;
  private lastUnitIndex: number = -1;

  constructor(controller: TimerController) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      49
    );
    this.statusBarItem.command = "redmine.timer.toggle";

    // Subscribe to state changes
    this.disposables.push(
      controller.onStateChange((state) => this.update(state))
    );

    // Initial render
    this.update(controller.getState());
    this.statusBarItem.show();
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  private update(state: TimerState): void {
    const { phase, plan, currentUnitIndex, breakSecondsLeft } = state;
    const unit = plan[currentUnitIndex];
    const workingUnit = getWorkingUnit(state);
    // Find paused unit for paused phase (may differ from currentUnitIndex)
    const pausedUnit = plan.find(u => u.unitPhase === "paused");
    const completed = countCompleted(state);
    const total = plan.length;
    const progress = total > 0 ? `(${completed}/${total})` : "";

    // Only update tooltip/command when phase or unit changes (not on every tick)
    const phaseChanged = phase !== this.lastPhase || currentUnitIndex !== this.lastUnitIndex;

    switch (phase) {
      case "idle":
        if (total === 0) {
          this.statusBarItem.text = "$(clock) Plan day...";
          if (phaseChanged) {
            this.statusBarItem.tooltip = "Click to plan your work units";
            this.statusBarItem.command = "redmine.timer.planDay";
          }
        } else {
          // Has plan but not started - find next startable unit
          const nextUnit = plan.find(u => u.unitPhase === "pending" || u.unitPhase === "paused");
          if (nextUnit) {
            this.statusBarItem.text = `$(play) #${nextUnit.issueId} ready ${progress}`;
            if (phaseChanged) {
              this.statusBarItem.tooltip = `Click to start: ${nextUnit.issueSubject}`;
              this.statusBarItem.command = "redmine.timer.start";
            }
          } else {
            // All units completed
            this.statusBarItem.text = `$(check) Done ${progress}`;
            if (phaseChanged) {
              this.statusBarItem.tooltip = "All units completed - click to plan more";
              this.statusBarItem.command = "redmine.timer.planDay";
            }
          }
        }
        break;

      case "working":
        this.statusBarItem.text = `$(pulse) ${formatSecondsAsMMSS(workingUnit?.secondsLeft ?? 0)} #${workingUnit?.issueId || "?"} [${workingUnit?.activityName || "?"}] ${progress}`;
        if (phaseChanged) {
          this.statusBarItem.tooltip = this.buildTooltip(state);
          this.statusBarItem.command = "redmine.timer.toggle";
        }
        break;

      case "paused":
        // Use pausedUnit which may differ from currentUnitIndex
        this.statusBarItem.text = `$(debug-pause) ${formatSecondsAsMMSS(pausedUnit?.secondsLeft ?? 0)} #${pausedUnit?.issueId || "?"} [${pausedUnit?.activityName || "?"}] ${progress}`;
        if (phaseChanged) {
          this.statusBarItem.tooltip = "Timer paused - click to resume";
          this.statusBarItem.command = "redmine.timer.toggle";
        }
        break;

      case "logging":
        this.statusBarItem.text = "$(bell) Log time?";
        if (phaseChanged) {
          this.statusBarItem.tooltip = `Log ${unit?.issueSubject || "time"} to Redmine`;
          this.statusBarItem.command = "redmine.timer.showLogDialog";
        }
        break;

      case "break":
        this.statusBarItem.text = `$(coffee) ${formatSecondsAsMMSS(breakSecondsLeft)} break`;
        if (phaseChanged) {
          this.statusBarItem.tooltip = "Break time - click to start next unit";
          this.statusBarItem.command = "redmine.timer.toggle";
        }
        break;
    }

    this.lastPhase = phase;
    this.lastUnitIndex = currentUnitIndex;
  }

  private buildTooltip(state: TimerState): vscode.MarkdownString {
    const { plan, currentUnitIndex } = state;
    const md = new vscode.MarkdownString();

    // Guard against empty plan or invalid index
    if (plan.length === 0 || currentUnitIndex < 0 || currentUnitIndex >= plan.length) {
      md.appendMarkdown("No active unit");
      return md;
    }

    const unit = plan[currentUnitIndex];
    const completedCount = countCompleted(state);
    const total = plan.length;

    // Calculate actual hours logged (sum of loggedHours)
    const hoursLogged = plan
      .filter(u => u.logged && u.loggedHours)
      .reduce((sum, u) => sum + (u.loggedHours ?? 0), 0);

    md.appendMarkdown(`**Work Unit ${currentUnitIndex + 1} of ${total}**\n\n`);

    if (unit) {
      md.appendMarkdown(`Issue: #${unit.issueId} - ${unit.issueSubject}\n\n`);
      md.appendMarkdown(`Activity: ${unit.activityName}\n\n`);
    }

    md.appendMarkdown("---\n\n");
    md.appendMarkdown(`Today: ${formatHoursAsHHMM(hoursLogged)} logged (${completedCount}/${total} units)\n\n`);
    md.appendMarkdown("Click to pause");

    return md;
  }
}

