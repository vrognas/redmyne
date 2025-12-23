import * as vscode from "vscode";
import { TimerController } from "./timer-controller";
import { WorkUnit } from "./timer-state";
import { formatHoursAsHHMM, formatSecondsAsMMSS } from "../utilities/time-input";

interface PlanTreeItem {
  type: "header" | "unit" | "add-button";
  unit?: WorkUnit;
  index?: number;
  isCurrent: boolean;
  isCompleted: boolean;
}

/**
 * Tree provider for "Today's Plan" view
 */
export class TimerTreeProvider implements vscode.TreeDataProvider<PlanTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PlanTreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private disposables: vscode.Disposable[] = [];
  private cachedItems: PlanTreeItem[] = [];
  private lastWorkingIndex: number = -1;

  constructor(private controller: TimerController) {
    // Subscribe to state changes
    this.disposables.push(
      controller.onStateChange(() => this.refreshWorkingUnit())
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onDidChangeTreeData.dispose();
  }

  /**
   * Refresh only the working unit to update timer, avoiding full tree refresh flicker
   */
  private refreshWorkingUnit(): void {
    const state = this.controller.getState();
    const workingIndex = state.plan.findIndex(u => u.unitPhase === "working");

    // Count unit items in cache (excluding add-button)
    const cachedUnitCount = this.cachedItems.filter(i => i.type === "unit").length;

    // If plan length changed (unit added/removed), do full refresh
    if (state.plan.length !== cachedUnitCount) {
      this.lastWorkingIndex = workingIndex;
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    // If working unit changed, refresh both old and new
    if (workingIndex !== this.lastWorkingIndex) {
      // Refresh previously working unit (now paused)
      if (this.lastWorkingIndex >= 0 && this.cachedItems[this.lastWorkingIndex]?.type === "unit") {
        this.cachedItems[this.lastWorkingIndex].unit = state.plan[this.lastWorkingIndex];
        this._onDidChangeTreeData.fire(this.cachedItems[this.lastWorkingIndex]);
      }
      this.lastWorkingIndex = workingIndex;
    }

    const cachedItem = this.cachedItems[workingIndex];
    if (workingIndex >= 0 && cachedItem && cachedItem.type === "unit") {
      // Update cached item in place (same object reference) and fire targeted refresh
      cachedItem.unit = state.plan[workingIndex];
      this._onDidChangeTreeData.fire(cachedItem);
    } else if (workingIndex < 0 && this.lastWorkingIndex < 0) {
      // No working unit - might need full refresh for phase changes
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  refresh(): void {
    this.cachedItems = [];
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: PlanTreeItem): vscode.TreeItem {
    if (element.type === "add-button") {
      const item = new vscode.TreeItem("Add unit...");
      item.iconPath = new vscode.ThemeIcon("add");
      item.command = {
        command: "redmine.timer.addUnit",
        title: "Add Unit",
      };
      return item;
    }

    if (element.type === "unit" && element.unit && element.index !== undefined) {
      return this.createUnitTreeItem(
        element.unit,
        element.index,
        element.isCurrent,
        element.isCompleted
      );
    }

    return new vscode.TreeItem("");
  }


  /**
   * Format ISO timestamp as HH:MM for description
   */
  private formatClockTime(isoString: string): string {
    const date = new Date(isoString);
    return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  /**
   * Format ISO timestamp as YYYY-MM-DD HH:MM:SS for tooltip
   */
  private formatFullTimestamp(isoString: string): string {
    const date = new Date(isoString);
    const yyyy = date.getFullYear();
    const mm = (date.getMonth() + 1).toString().padStart(2, "0");
    const dd = date.getDate().toString().padStart(2, "0");
    const hh = date.getHours().toString().padStart(2, "0");
    const min = date.getMinutes().toString().padStart(2, "0");
    const ss = date.getSeconds().toString().padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
  }

  private createUnitTreeItem(
    unit: WorkUnit,
    index: number,
    _isCurrent: boolean,  // Kept for API compatibility, using unit.unitPhase instead
    isCompleted: boolean
  ): vscode.TreeItem {
    // Label: "1. #ID Comment" or "1. #ID" or "1. (not assigned)"
    let label: string;
    if (unit.issueId > 0) {
      label = unit.comment
        ? `${index + 1}. #${unit.issueId} ${unit.comment}`
        : `${index + 1}. #${unit.issueId}`;
    } else {
      label = `${index + 1}. (not assigned)`;
    }

    const item = new vscode.TreeItem(label);

    // Icon based on unitPhase
    switch (unit.unitPhase) {
      case "completed":
        item.iconPath = new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed"));
        break;
      case "working":
        item.iconPath = new vscode.ThemeIcon("pulse", new vscode.ThemeColor("charts.green"));
        break;
      case "paused":
        item.iconPath = new vscode.ThemeIcon("debug-pause", new vscode.ThemeColor("charts.yellow"));
        break;
      default:
        item.iconPath = new vscode.ThemeIcon("circle-outline");
    }

    // Description: "MM:SS [Activity] Subject" or completed status
    if (isCompleted && unit.loggedHours) {
      const completedTimeStr = unit.completedAt ? ` @ ${this.formatClockTime(unit.completedAt)}` : "";
      item.description = `${formatHoursAsHHMM(unit.loggedHours)} logged${completedTimeStr}`;
    } else if (unit.issueId > 0) {
      const timeStr = formatSecondsAsMMSS(unit.secondsLeft);
      const activityStr = unit.activityName ? `[${unit.activityName}]` : "";
      item.description = `${timeStr} ${activityStr} ${unit.issueSubject}`.trim();
    } else if (unit.secondsLeft > 0) {
      item.description = formatSecondsAsMMSS(unit.secondsLeft);
    }

    // Context menu - use unitPhase for accurate state
    switch (unit.unitPhase) {
      case "completed":
        item.contextValue = "timer-unit-completed";
        break;
      case "working":
        item.contextValue = "timer-unit-working";
        break;
      case "paused":
        item.contextValue = "timer-unit-paused";
        break;
      default:
        item.contextValue = "timer-unit-pending";
    }

    // Tooltip
    if (unit.issueId > 0) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**#${unit.issueId}** ${unit.issueSubject}\n\n`);
      md.appendMarkdown(`Activity: ${unit.activityName}\n\n`);
      md.appendMarkdown(`Timer: ${formatSecondsAsMMSS(unit.secondsLeft)}\n\n`);
      if (unit.comment) {
        md.appendMarkdown(`Comment: ${unit.comment}\n\n`);
      }
      if (unit.logged && unit.loggedHours) {
        const timestampStr = unit.completedAt ? ` at ${this.formatFullTimestamp(unit.completedAt)}` : "";
        md.appendMarkdown(`---\n\n✓ ${formatHoursAsHHMM(unit.loggedHours)} logged${timestampStr}`);
      }
      item.tooltip = md;
    }

    return item;
  }

  getChildren(element?: PlanTreeItem): PlanTreeItem[] {
    // Only show root level
    if (element) return [];

    const state = this.controller.getState();
    const { plan, currentUnitIndex } = state;

    if (plan.length === 0) {
      // No plan - show message
      this.cachedItems = [];
      return [];
    }

    // Build items, reusing cached objects where possible for targeted refresh
    const items: PlanTreeItem[] = plan.map((unit, index) => {
      const existing = this.cachedItems[index];
      if (existing && existing.type === "unit" && existing.index === index) {
        // Update existing item (keeps same object reference for targeted refresh)
        existing.unit = unit;
        existing.isCurrent = index === currentUnitIndex;
        existing.isCompleted = unit.logged;
        return existing;
      }
      // Create new item
      return {
        type: "unit" as const,
        unit,
        index,
        isCurrent: index === currentUnitIndex,
        isCompleted: unit.logged,
      };
    });

    // Add button at end
    const addButton = this.cachedItems.find(i => i.type === "add-button") || {
      type: "add-button" as const,
      isCurrent: false,
      isCompleted: false,
    };
    items.push(addButton);

    this.cachedItems = items;
    return items;
  }
}
