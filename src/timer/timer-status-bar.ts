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
            this.statusBarItem.tooltip = this.buildIdleNoPlansTooltip();
            this.statusBarItem.command = "redmine.timer.planDay";
          }
        } else {
          // Has plan but not started - find next startable unit
          const nextUnit = plan.find(u => u.unitPhase === "pending" || u.unitPhase === "paused");
          if (nextUnit) {
            this.statusBarItem.text = `$(play) #${nextUnit.issueId} ready ${progress}`;
            if (phaseChanged) {
              this.statusBarItem.tooltip = this.buildIdleReadyTooltip(nextUnit, state);
              this.statusBarItem.command = "redmine.timer.start";
            }
          } else {
            // All units completed
            this.statusBarItem.text = `$(check) Done ${progress}`;
            if (phaseChanged) {
              this.statusBarItem.tooltip = this.buildAllDoneTooltip(state);
              this.statusBarItem.command = "redmine.timer.planDay";
            }
          }
        }
        break;

      case "working":
        this.statusBarItem.text = `$(pulse) ${formatSecondsAsMMSS(workingUnit?.secondsLeft ?? 0)} #${workingUnit?.issueId || "?"} [${workingUnit?.activityName || "?"}] ${progress}`;
        if (phaseChanged) {
          this.statusBarItem.tooltip = this.buildWorkingTooltip(state);
          this.statusBarItem.command = "redmine.timer.toggle";
        }
        break;

      case "paused":
        // Use pausedUnit which may differ from currentUnitIndex
        this.statusBarItem.text = `$(debug-pause) ${formatSecondsAsMMSS(pausedUnit?.secondsLeft ?? 0)} #${pausedUnit?.issueId || "?"} [${pausedUnit?.activityName || "?"}] ${progress}`;
        if (phaseChanged) {
          this.statusBarItem.tooltip = this.buildPausedTooltip(pausedUnit, state);
          this.statusBarItem.command = "redmine.timer.toggle";
        }
        break;

      case "logging":
        this.statusBarItem.text = "$(bell) Log time?";
        if (phaseChanged) {
          this.statusBarItem.tooltip = this.buildLoggingTooltip(unit);
          this.statusBarItem.command = "redmine.timer.showLogDialog";
        }
        break;

      case "break":
        this.statusBarItem.text = `$(coffee) ${formatSecondsAsMMSS(breakSecondsLeft)} break`;
        if (phaseChanged) {
          this.statusBarItem.tooltip = this.buildBreakTooltip(state);
          this.statusBarItem.command = "redmine.timer.toggle";
        }
        break;
    }

    this.lastPhase = phase;
    this.lastUnitIndex = currentUnitIndex;
  }

  /**
   * Tooltip when no plans exist yet
   */
  private buildIdleNoPlansTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown("**No plan for today**\n\n");
    md.appendMarkdown("Click to add tasks to Kanban Doing board.\n\n");
    md.appendMarkdown("---\n\n");
    md.appendMarkdown("*Tip: `Ctrl+Y T` toggles timer*");
    return md;
  }

  /**
   * Tooltip when plan exists but timer not started
   */
  private buildIdleReadyTooltip(nextUnit: TimerState["plan"][0], state: TimerState): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    const hoursLogged = this.getTodayHoursLogged(state);
    const completed = countCompleted(state);
    const total = state.plan.length;

    md.appendMarkdown("**Ready to start**\n\n");
    md.appendMarkdown(`Next: #${nextUnit.issueId} - ${nextUnit.issueSubject}\n\n`);
    md.appendMarkdown("---\n\n");
    md.appendMarkdown(`Today: ${formatHoursAsHHMM(hoursLogged)} logged (${completed}/${total})\n\n`);
    md.appendMarkdown("*Click to start timer*");
    return md;
  }

  /**
   * Tooltip when all units completed
   */
  private buildAllDoneTooltip(state: TimerState): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    const hoursLogged = this.getTodayHoursLogged(state);
    const total = state.plan.length;

    md.appendMarkdown("**All done!** ✓\n\n");
    md.appendMarkdown(`${total} units completed\n\n`);
    md.appendMarkdown(`${formatHoursAsHHMM(hoursLogged)} logged today\n\n`);
    md.appendMarkdown("---\n\n");
    md.appendMarkdown("*Click to add more tasks to Kanban*");
    return md;
  }

  /**
   * Tooltip when actively working
   */
  private buildWorkingTooltip(state: TimerState): vscode.MarkdownString {
    const { plan, currentUnitIndex } = state;
    const md = new vscode.MarkdownString();

    if (plan.length === 0 || currentUnitIndex < 0 || currentUnitIndex >= plan.length) {
      md.appendMarkdown("No active unit");
      return md;
    }

    const unit = plan[currentUnitIndex];
    const hoursLogged = this.getTodayHoursLogged(state);
    const completed = countCompleted(state);
    const total = plan.length;

    md.appendMarkdown("**Working** $(pulse)\n\n");
    if (unit) {
      md.appendMarkdown(`#${unit.issueId} - ${unit.issueSubject}\n\n`);
      md.appendMarkdown(`Activity: ${unit.activityName}\n\n`);
    }
    md.appendMarkdown("---\n\n");
    md.appendMarkdown(`Today: ${formatHoursAsHHMM(hoursLogged)} (${completed}/${total})\n\n`);
    md.appendMarkdown("**Actions:**\n");
    md.appendMarkdown("- Click to pause\n");
    md.appendMarkdown("- Right-click for more options");
    return md;
  }

  /**
   * Tooltip when timer is paused
   */
  private buildPausedTooltip(pausedUnit: TimerState["plan"][0] | undefined, state: TimerState): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    const hoursLogged = this.getTodayHoursLogged(state);

    md.appendMarkdown("**Paused** $(debug-pause)\n\n");
    if (pausedUnit) {
      md.appendMarkdown(`#${pausedUnit.issueId} - ${pausedUnit.issueSubject}\n\n`);
      md.appendMarkdown(`Remaining: ${formatSecondsAsMMSS(pausedUnit.secondsLeft)}\n\n`);
    }
    md.appendMarkdown("---\n\n");
    md.appendMarkdown(`Today: ${formatHoursAsHHMM(hoursLogged)} logged\n\n`);
    md.appendMarkdown("*Click to resume*");
    return md;
  }

  /**
   * Tooltip when waiting to log time
   */
  private buildLoggingTooltip(unit: TimerState["plan"][0] | undefined): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown("**Time to log!** $(bell)\n\n");
    if (unit) {
      md.appendMarkdown(`#${unit.issueId} - ${unit.issueSubject}\n\n`);
    }
    md.appendMarkdown("---\n\n");
    md.appendMarkdown("**Actions:**\n");
    md.appendMarkdown("- Click to record time\n");
    md.appendMarkdown("- Or defer to next unit");
    return md;
  }

  /**
   * Tooltip during break
   */
  private buildBreakTooltip(state: TimerState): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    const hoursLogged = this.getTodayHoursLogged(state);

    md.appendMarkdown("**Break time** $(coffee)\n\n");
    md.appendMarkdown("Take a moment to rest.\n\n");
    md.appendMarkdown("---\n\n");
    md.appendMarkdown(`Today: ${formatHoursAsHHMM(hoursLogged)} logged\n\n`);
    md.appendMarkdown("*Click to start next unit early*");
    return md;
  }

  /**
   * Calculate total hours logged today
   */
  private getTodayHoursLogged(state: TimerState): number {
    return state.plan
      .filter(u => u.logged && u.loggedHours)
      .reduce((sum, u) => sum + (u.loggedHours ?? 0), 0);
  }
}

