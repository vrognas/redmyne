import * as vscode from "vscode";

const SETTING_KEY = "adHocBudgetIssues";

function getIds(): number[] {
  return vscode.workspace.getConfiguration("redmyne").get<number[]>(SETTING_KEY, []);
}

async function setIds(ids: number[]): Promise<void> {
  await vscode.workspace.getConfiguration("redmyne").update(SETTING_KEY, ids, vscode.ConfigurationTarget.Global);
}

class AdHocTracker {
  /** @deprecated No-op, kept for migration compatibility */
  initialize(_context: unknown): void { /* no-op */ }

  isAdHoc(issueId: number): boolean {
    return getIds().includes(issueId);
  }

  async tag(issueId: number): Promise<void> {
    const ids = getIds();
    if (!ids.includes(issueId)) {
      await setIds([...ids, issueId]);
    }
  }

  async untag(issueId: number): Promise<void> {
    const ids = getIds();
    await setIds(ids.filter((id) => id !== issueId));
  }

  async toggle(issueId: number): Promise<boolean> {
    if (this.isAdHoc(issueId)) {
      await this.untag(issueId);
      return false;
    } else {
      await this.tag(issueId);
      return true;
    }
  }

  getAll(): number[] {
    return getIds();
  }
}

export const adHocTracker = new AdHocTracker();
