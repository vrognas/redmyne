import * as vscode from "vscode";

const SETTING_KEY = "precedenceIssues";

function getIds(): number[] {
  return vscode.workspace.getConfiguration("redmyne").get<number[]>(SETTING_KEY, []);
}

async function setIds(ids: number[]): Promise<void> {
  await vscode.workspace.getConfiguration("redmyne").update(SETTING_KEY, ids, vscode.ConfigurationTarget.Global);
}

export function getPrecedenceIssues(): Set<number> {
  return new Set(getIds());
}

export function hasPrecedence(issueId: number): boolean {
  return getIds().includes(issueId);
}

export async function setPrecedence(issueId: number): Promise<void> {
  const ids = getIds();
  if (!ids.includes(issueId)) {
    await setIds([...ids, issueId]);
  }
}

export async function clearPrecedence(issueId: number): Promise<void> {
  await setIds(getIds().filter((id) => id !== issueId));
}

export async function togglePrecedence(issueId: number): Promise<boolean> {
  if (hasPrecedence(issueId)) {
    await clearPrecedence(issueId);
    return false;
  } else {
    await setPrecedence(issueId);
    return true;
  }
}
