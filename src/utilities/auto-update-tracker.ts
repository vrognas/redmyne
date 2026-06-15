import { createConfigIdSetTracker } from "./config-id-set-tracker";

const tracker = createConfigIdSetTracker("autoUpdateIssues");

class AutoUpdateTracker {
  isEnabled(issueId: number): boolean {
    return tracker.has(issueId);
  }

  enable(issueId: number): Promise<void> {
    return tracker.add(issueId);
  }

  disable(issueId: number): Promise<void> {
    return tracker.remove(issueId);
  }

  toggle(issueId: number): Promise<boolean> {
    return tracker.toggle(issueId);
  }
}

export const autoUpdateTracker = new AutoUpdateTracker();
