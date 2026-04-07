import * as vscode from "vscode";

const SETTING_KEY = "autoUpdateIssues";

function getIds(): number[] {
  return vscode.workspace.getConfiguration("redmyne").get<number[]>(SETTING_KEY, []);
}

async function setIds(ids: number[]): Promise<void> {
  await vscode.workspace.getConfiguration("redmyne").update(SETTING_KEY, ids, vscode.ConfigurationTarget.Global);
}

class AutoUpdateTracker {
  /** @deprecated No-op, kept for migration compatibility */
  initialize(_context: unknown): void { /* no-op */ }

  isEnabled(issueId: number): boolean {
    return getIds().includes(issueId);
  }

  async enable(issueId: number): Promise<void> {
    const ids = getIds();
    if (!ids.includes(issueId)) {
      await setIds([...ids, issueId]);
    }
  }

  async disable(issueId: number): Promise<void> {
    const ids = getIds();
    await setIds(ids.filter((id) => id !== issueId));
  }

  async toggle(issueId: number): Promise<boolean> {
    if (this.isEnabled(issueId)) {
      await this.disable(issueId);
      return false;
    } else {
      await this.enable(issueId);
      return true;
    }
  }
}

export const autoUpdateTracker = new AutoUpdateTracker();
