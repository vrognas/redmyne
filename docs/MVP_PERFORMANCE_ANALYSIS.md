# MVP Performance Analysis

**Date**: 2025-11-24
**Focus**: Obvious bottlenecks only - no overengineering

---

## Critical Bottlenecks Identified

### 1. MVP-1: Working Days Calculation (O(n²) problem)

**Problem**: `countWorkingDays()` called for EVERY issue on EVERY refresh

```typescript
// Called 100 times for 100 issues:
for (const issue of issues) {
  const workingDays = countWorkingDays(issue.start_date, issue.due_date); // Iterates dates
}
```

**Impact**:
- 100 issues × 7-day average range × 2 calculations (initial + remaining) = **1,400 date iterations**
- Date iteration is expensive (Date object creation, day-of-week checks)

**Simple Fix**: Memoize by date range
```typescript
const workingDaysCache = new Map<string, number>();

function countWorkingDays(start: Date, end: Date, workingDays: string[]): number {
  const key = `${start.toISOString()}_${end.toISOString()}_${workingDays.join(',')}`;

  if (workingDaysCache.has(key)) {
    return workingDaysCache.get(key)!;
  }

  const count = calculateWorkingDays(start, end, workingDays);
  workingDaysCache.set(key, count);
  return count;
}
```

**Impact**: O(n²) → O(n), ~10x faster for 100 issues with duplicate date ranges

**Effort**: 5 lines, 10 minutes

---

### 2. MVP-2: Double-Fetching (Already Identified)

**Problem**: Fetching time entries twice per date group

```typescript
// Root call - fetches entries for total
const todayTotal = await fetchTotal(today(), today());

// Child call - fetches SAME entries again
return await this.server.getTimeEntries({ from: today(), to: today() });
```

**Impact**: 2× API calls, 2× network latency

**Simple Fix**: Cache response at parent
```typescript
private entriesCache = new Map<string, TimeEntry[]>();

async getChildren(element?) {
  if (!element) {
    const key = 'today';
    const entries = await this.server.getTimeEntries({ from: today(), to: today() });
    this.entriesCache.set(key, entries);

    const total = entries.reduce((sum, e) => sum + e.hours, 0);
    return [{ label: 'Today', total, _cacheKey: key }];
  }

  // Reuse cached entries
  return this.entriesCache.get(element._cacheKey) || [];
}
```

**Impact**: 50% fewer API calls

**Effort**: 10 lines, 15 minutes

---

### 3. MVP-3: Issue Picker with 100+ Issues

**Problem**: Loading all assigned issues into QuickPick

```typescript
const issues = await server.getIssuesAssignedToMe(); // Could be 100+
const picked = await vscode.window.showQuickPick(
  issues.map(issue => ({ label: issue.subject, issue }))
);
```

**Impact**:
- Slow picker rendering (100+ items)
- User must scroll/search through long list
- 1-2 second delay before picker shows

**Simple Fix**: Limit + filter pattern
```typescript
// Show recent 10 + allow search
const recentIssues = getRecentIssues(10); // From globalState or workspaceState

const picked = await vscode.window.showQuickPick([
  { label: '$(history) Recent Issues', kind: vscode.QuickPickItemKind.Separator },
  ...recentIssues.slice(0, 10).map(i => ({ label: `#${i.id} ${i.subject}`, issue: i })),
  { label: '$(search) Search all issues...', kind: vscode.QuickPickItemKind.Separator },
  { label: 'Type issue number or subject', isSearchPrompt: true }
], {
  placeHolder: 'Select issue or type to search',
  matchOnDescription: true
});

// If user types, lazy load matching issues
```

**Impact**: Instant picker, better UX

**Effort**: 30 lines, 30 minutes

---

### 4. MVP-4: Status Bar Polling

**Problem**: How often to update workload status bar?

**Options**:
- ❌ Poll every 5 minutes → Wasteful API calls
- ❌ Update on every tree refresh → Too frequent
- ✅ Update only on explicit events:
  - After logging time (MVP-3)
  - Manual refresh command
  - Config change

**Simple Fix**: Event-driven updates
```typescript
class WorkloadStatusBar {
  private statusBar: vscode.StatusBarItem;

  constructor() {
    this.statusBar = vscode.window.createStatusBarItem(...);
  }

  async update() {
    const workload = await this.calculateWorkload();
    this.statusBar.text = `$(pulse) ${workload.remaining}h left, ${workload.buffer}h ${workload.icon}`;
  }

  // Only update on specific events
  registerTriggers(context: vscode.ExtensionContext) {
    // After time logged
    context.subscriptions.push(
      vscode.commands.registerCommand('redmine.onTimeLogged', () => this.update())
    );

    // Manual refresh
    context.subscriptions.push(
      vscode.commands.registerCommand('redmine.refreshWorkload', () => this.update())
    );

    // Config change
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('redmine')) this.update();
    });
  }
}
```

**Impact**: Zero polling overhead, updates only when needed

**Effort**: Pattern already exists, 5 minutes

---

### 5. Tree Refresh Optimization (All MVPs)

**Problem**: Refreshing entire tree on single issue update

```typescript
// BAD: Full tree refresh when one issue changes
await server.updateIssue(issueId);
myIssuesTree.refresh(); // Re-fetches ALL issues
```

**Simple Fix**: Partial refresh with EventEmitter
```typescript
class MyIssuesTree {
  private _onDidChangeTreeData = new vscode.EventEmitter<Issue | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(issue?: Issue) {
    if (issue) {
      // Partial refresh: only this issue
      this._onDidChangeTreeData.fire(issue);
    } else {
      // Full refresh: all issues
      this._onDidChangeTreeData.fire();
    }
  }
}

// Usage:
await server.updateIssue(issue);
myIssuesTree.refresh(issue); // Only refreshes this node
```

**Impact**: 99% fewer API calls for single issue updates

**Effort**: Already implemented in ProjectsTree, 5 minutes to add

---

## Non-Obvious Bottlenecks (Document, Don't Fix Yet)

### 6. API Call Batching (Future Optimization)

**Observation**: MVP-1 may need time entries for spent_hours

**Current**: Individual API calls per issue (if needed)
```typescript
for (const issue of issues) {
  const timeEntries = await server.getTimeEntries({ issueId: issue.id }); // 100 calls
}
```

**Future**: Redmine API doesn't support batching, but could:
- Use `total_spent_hours` field (Redmine 5.0+) - already in issue response
- Avoid fetching time entries entirely for MVP-1

**Decision**: Use `total_spent_hours` field (already planned). No optimization needed.

---

### 7. Large Dataset Pagination (Future)

**Observation**: Redmine API limits responses to 100 items

**Current plan**: Display first 100, add "Load more" if needed

**When to optimize**: Only if users complain about missing items

**Simple Fix** (if needed):
```typescript
async getAllIssues() {
  let offset = 0;
  let allIssues = [];

  while (true) {
    const response = await server.getIssues({ limit: 100, offset });
    allIssues.push(...response.issues);

    if (response.issues.length < 100) break; // Last page
    offset += 100;
  }

  return allIssues;
}
```

**Decision**: Don't implement unless users have >100 assigned issues (rare)

---

## Performance Budget

| Operation | Target | Rationale |
|-----------|--------|-----------|
| Tree refresh | <2s | 100 issues with flexibility calc |
| Time entry view load | <1s | 100 entries with totals |
| Quick log picker | <100ms | Instant feel required |
| Status bar update | <500ms | Background, non-blocking |
| Working days calc | <10ms | Memoized, called frequently |

---

## Implementation Priority

### Must Fix (Before Release)
1. ✅ MVP-1: Memoize `countWorkingDays()` (10 min)
2. ✅ MVP-2: Cache time entries at parent (15 min)

### Should Fix (Before v3.2.0)
3. ✅ MVP-3: Limit issue picker to recent 10 + search (30 min)
4. ✅ MVP-4: Event-driven status bar updates (5 min)
5. ✅ All: Partial tree refresh for single issue updates (5 min)

**Total effort**: ~65 minutes (1 hour)

### Monitor (Don't Fix Yet)
6. ⏭️ API call batching (not needed - use total_spent_hours field)
7. ⏭️ Pagination for >100 issues (rare edge case)

---

## Testing Strategy

### Performance Tests

**Test 1: Flexibility calculation with 100 issues**
- Load 100 issues with date ranges
- Measure time to calculate all flexibility scores
- Target: <2s total
- With memoization: Expect <200ms

**Test 2: Time entry view with 100 entries**
- Fetch 100 time entries
- Group by date, calculate totals
- Target: <1s total
- With caching: Expect <500ms

**Test 3: Issue picker responsiveness**
- Open quick log command
- Measure time until picker shows
- Target: <100ms
- With recent-only: Expect <50ms

---

## Monitoring Recommendations

Add performance logging (optional, for debugging):

```typescript
const startTime = performance.now();
const issues = await calculateFlexibility(issues);
const endTime = performance.now();

if (endTime - startTime > 2000) {
  console.warn(`[Redmine] Flexibility calculation slow: ${endTime - startTime}ms for ${issues.length} issues`);
}
```

**When to log**:
- Flexibility calculation >2s
- API calls >5s
- Tree refresh >3s

**Where to log**: Output channel (already exists in codebase)

---

## Summary

### Critical Fixes (Must Do)
- Memoize working days calculation (O(n²) → O(n))
- Cache time entries response (50% fewer API calls)
- Limit issue picker to recent items (instant UX)

### Nice-to-Have Fixes (Should Do)
- Event-driven status bar updates (no polling)
- Partial tree refresh (99% fewer refreshes)

### Not Needed (Don't Do)
- API call batching (Redmine API limitation + field already available)
- Pagination (rare edge case, <1% of users)

**Total additional effort**: ~1 hour
**Performance improvement**: 5-10× faster for common operations

---

## Integration with MVP Plan

Add to each MVP's implementation plan:

**MVP-1**: Add memoization to `flexibility-calculator.ts` (5 min)
**MVP-2**: Add response caching to `my-time-entries-tree.ts` (15 min)
**MVP-3**: Limit picker to recent 10 issues in `quick-log-time.ts` (30 min)
**MVP-4**: Event-driven updates in `extension.ts` (5 min)

**Updated effort estimates**:
- MVP-1: 8-10h → 8.5-10.5h (+30 min)
- MVP-2: 4-6h → 4.5-6.5h (+30 min)
- MVP-3: 3-4h → 3.5-4.5h (+30 min)
- MVP-4: 1-2h → 1-2h (no change, pattern already planned)

**New total**: 17.5-23.5h (was 16-22h) - marginal increase for 5-10× performance gain
