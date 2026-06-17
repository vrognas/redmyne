import * as vscode from "vscode";
import { createConfigIdSetTracker } from "./config-id-set-tracker";

// Cached: isAdHoc() is called from inside hot loops (per-row Gantt render,
// per-time-entry contribution calc). The factory caches the read set and
// invalidates on config change (Settings UI, sync, draft mode).
// Use lazyCache so the listener is registered (and disposed) via initAdHocTracker.
const tracker = createConfigIdSetTracker("adHocBudgetIssues", { lazyCache: true });

class AdHocTracker {
  isAdHoc(issueId: number): boolean {
    return tracker.has(issueId);
  }

  tag(issueId: number): Promise<void> {
    return tracker.add(issueId);
  }

  untag(issueId: number): Promise<void> {
    return tracker.remove(issueId);
  }

  toggle(issueId: number): Promise<boolean> {
    return tracker.toggle(issueId);
  }

  getAll(): number[] {
    return tracker.getAllArray();
  }
}

export const adHocTracker = new AdHocTracker();

/**
 * Register the cache-invalidation listener for adHocTracker and push its
 * Disposable to context.subscriptions. Must be called once from activate().
 */
export function initAdHocTracker(context: vscode.ExtensionContext): void {
  context.subscriptions.push(tracker.registerCacheListener!());
}
