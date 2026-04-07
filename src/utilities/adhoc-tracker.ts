import * as vscode from "vscode";

const SETTING_KEY = "adHocBudgetIssues";

function getIds(): number[] {
  return vscode.workspace.getConfiguration("redmyne").get<number[]>(SETTING_KEY, []);
}

async function setIds(ids: number[]): Promise<void> {
  await vscode.workspace.getConfiguration("redmyne").update(SETTING_KEY, ids, vscode.ConfigurationTarget.Global);
}

class AdHocTracker {
  private _queue: Promise<void> = Promise.resolve();

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this._queue.then(fn);
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  isAdHoc(issueId: number): boolean {
    return getIds().includes(issueId);
  }

  tag(issueId: number): Promise<void> {
    return this.enqueue(async () => {
      const ids = getIds();
      if (!ids.includes(issueId)) await setIds([...ids, issueId]);
    });
  }

  untag(issueId: number): Promise<void> {
    return this.enqueue(async () => {
      await setIds(getIds().filter((id) => id !== issueId));
    });
  }

  toggle(issueId: number): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.isAdHoc(issueId)) {
        await setIds(getIds().filter((id) => id !== issueId));
        return false;
      } else {
        await setIds([...getIds(), issueId]);
        return true;
      }
    });
  }

  getAll(): number[] {
    return getIds();
  }
}

export const adHocTracker = new AdHocTracker();
