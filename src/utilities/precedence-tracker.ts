import { createConfigIdSetTracker } from "./config-id-set-tracker";

const tracker = createConfigIdSetTracker("precedenceIssues");

export function getPrecedenceIssues(): Set<number> {
  return tracker.getAllSet();
}

export function hasPrecedence(issueId: number): boolean {
  return tracker.has(issueId);
}

export function setPrecedence(issueId: number): Promise<void> {
  return tracker.add(issueId);
}

export function clearPrecedence(issueId: number): Promise<void> {
  return tracker.remove(issueId);
}

export function togglePrecedence(issueId: number): Promise<boolean> {
  return tracker.toggle(issueId);
}
