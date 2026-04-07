import * as vscode from "vscode";

const SETTING_KEY = "precedenceIssues";

function getIds(): number[] {
  return vscode.workspace.getConfiguration("redmyne").get<number[]>(SETTING_KEY, []);
}

async function setIds(ids: number[]): Promise<void> {
  await vscode.workspace.getConfiguration("redmyne").update(SETTING_KEY, ids, vscode.ConfigurationTarget.Global);
}

let queue: Promise<void> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn);
  queue = result.then(() => {}, () => {});
  return result;
}

export function getPrecedenceIssues(): Set<number> {
  return new Set(getIds());
}

export function hasPrecedence(issueId: number): boolean {
  return getIds().includes(issueId);
}

export function setPrecedence(issueId: number): Promise<void> {
  return enqueue(async () => {
    const ids = getIds();
    if (!ids.includes(issueId)) await setIds([...ids, issueId]);
  });
}

export function clearPrecedence(issueId: number): Promise<void> {
  return enqueue(async () => {
    await setIds(getIds().filter((id) => id !== issueId));
  });
}

export function togglePrecedence(issueId: number): Promise<boolean> {
  return enqueue(async () => {
    if (hasPrecedence(issueId)) {
      await setIds(getIds().filter((id) => id !== issueId));
      return false;
    } else {
      await setIds([...getIds(), issueId]);
      return true;
    }
  });
}
