# Performance Assessment

**Assessment Date:** 2025-11-25
**Extension Version:** 3.6.0

## Executive Summary

Overall perceived performance is **acceptable for typical usage** (10-100 issues). Architecture uses lazy loading correctly with no blocking API calls during startup. Main bottlenecks are:

1. **Quick Log Time sequential waits** - 4+ chained operations
2. **Triple-fire refresh pattern** - causes cascading re-renders
3. **Chatty pagination** - degrades at scale (200+ items)
4. **Missing progress indicators** - UI appears frozen during network calls

---

## Findings by Category

### Startup Performance

**Status:** GOOD

| Aspect | Finding | Location |
|--------|---------|----------|
| Activation event | `onStartupFinished` - deferred | package.json:21 |
| Blocking API calls | None during activate() | extension.ts:42-744 |
| Tree initialization | Lazy - no eager fetches | extension.ts:70-85 |
| Sync operations | <10ms total | extension.ts:49-50, 77-85 |

**Issues Found:**

| Issue | Severity | Location | Impact |
|-------|----------|----------|--------|
| Double secret read | Low | extension.ts:192, 206 | 50-200ms on slow systems |
| Unwaited async ops | Medium | extension.ts:160, 232 | Status bar flicker |

### Tree View Rendering

**Status:** GOOD foundations, MEDIUM inefficiency

| Aspect | Finding | Location |
|--------|---------|----------|
| Loading states | All trees show placeholders | my-issues-tree.ts:80, projects-tree.ts:52, my-time-entries-tree.ts:118 |
| Caching | Flexibility pre-cached per issue | my-issues-tree.ts:94-99 |
| Concurrent dedup | pendingFetch pattern | my-issues-tree.ts:143-154 |
| Parallel fetches | Time entries use Promise.all | my-time-entries-tree.ts:58-62 |

**Critical Issue - Triple-Fire Pattern:**

```
extension.ts:213-215, 628-630, 702-703
```

When server configured or refresh clicked:
- 3 tree events fired simultaneously
- Status bar listener triggers 4th fetch
- Creates refresh cascade

### API/Network Efficiency

**Status:** ACCEPTABLE, degrades at scale

| Aspect | Finding | Location |
|--------|---------|----------|
| Timeout | 30s with proper cleanup | redmine-server.ts:20, 271-278 |
| Error handling | User-friendly messages | redmine-server.ts:239-266 |
| Statuses cache | Instance-level | redmine-server.ts:408-431 |
| Activities cache | Instance-level | redmine-server.ts:316-335 |

**Chatty Pagination:**

| Endpoint | Pattern | Impact |
|----------|---------|--------|
| getProjects() | Recursive, limit=50 | N requests for large deployments |
| getIssuesAssignedToMe() | Recursive, limit=50 | 200 issues = 4 requests |
| getOpenIssuesForProject() | Recursive, limit=50 | No early termination |

**Not Cached (hit network each time):**
- getProjects()
- getIssuesAssignedToMe()
- getOpenIssuesForProject()
- getMemberships()
- getTimeEntries()
- getIssueById()

### Command Responsiveness

**Status:** NEEDS IMPROVEMENT

| Command | Progress? | Issue |
|---------|-----------|-------|
| openActionsForIssue | Yes | Returns early from withProgress |
| listOpenIssuesAssignedToMe | Yes | Returns early from withProgress |
| quickLogTime | **No** | 4 network calls, zero progress |
| openActionsForIssueUnderCursor | No | Direct call, no feedback |

**Quick Log Time Flow (Ctrl+Y Ctrl+Y):**

```
1. showQuickPick("Recent or new?")     [UI wait]
2. getIssuesAssignedToMe()             [NETWORK - no progress]
3. showQuickPick(issues)               [UI wait]
4. getTimeEntryActivities()            [NETWORK - cached after 1st]
5. showQuickPick(activities)           [UI wait]
6. getTimeEntries()                    [NETWORK - could parallelize]
7. showInputBox(hours)                 [UI wait]
8. showInputBox(comment)               [UI wait]
9. addTimeEntry()                      [NETWORK - no progress]
```

**Issue:** Steps 2,4,6 are sequential. Step 6 could run while steps 3-5 execute.

---

## Phased Improvement Plan

### Phase 1: Quick Wins (Low effort, High impact)

**P1.1 - Fix double secret read**
- Location: extension.ts:192, 206
- Change: Cache first read, reuse for second check
- Impact: 50-200ms startup improvement

**P1.2 - Add progress to quickLogTime**
- Location: quick-log-time.ts
- Change: Wrap network calls in withProgress
- Impact: Eliminates "frozen UI" perception

**P1.3 - Parallelize time entry fetch**
- Location: quick-log-time.ts:99
- Change: Start getTimeEntries() before issue picker, await after
- Impact: 200-400ms reduction per quickLogTime invocation

### Phase 2: Architecture Improvements (Medium effort)

**P2.1 - Consolidate tree refreshes**
- Location: extension.ts:213-215, 628-630, 702-703
- Change: Single coordinated refresh instead of triple-fire
- Impact: Eliminates cascading fetches

**P2.2 - Add request-level deduplication**
- Location: redmine-server.ts
- Change: Memoize in-flight requests by URL
- Impact: Prevents duplicate concurrent requests

**P2.3 - Cache project list**
- Location: redmine-server.ts or ProjectsTree
- Change: TTL-based cache for getProjects()
- Impact: Faster project tree expansion

### Phase 3: Scale Optimizations (Higher effort)

**P3.1 - Pagination with limits**
- Location: redmine-server.ts:284, 477, 511
- Change: Add maxItems parameter, early exit
- Impact: Prevents 20+ requests for large datasets

**P3.2 - Virtual scrolling consideration**
- Evaluate: For 500+ issue lists
- Pattern: Load visible items only
- Impact: Constant-time tree rendering at scale

**P3.3 - Membership caching by project**
- Location: redmine-server.ts:437-447
- Change: LRU cache keyed by projectId
- Impact: Faster quickUpdate repeated on same project

---

## Metrics & Thresholds

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Startup (activate→ready) | ~100-300ms | <200ms | Disable workload bar |
| Tree first paint | <10ms | <10ms | Maintain |
| Quick Log Time (total) | ~3-5s | <2s | With parallelization |
| Issue list (100 items) | ~2 requests | ~2 requests | Acceptable |
| Issue list (500 items) | ~10 requests | <5 requests | With pagination limits |

---

## Testing Performance Changes

```bash
# Measure startup time
code --disable-extensions && code --install-extension ./redmyne-*.vsix

# Profile network calls
# Enable: redmyne.logging.enabled = true
# View: Output panel → "Redmine API"

# Measure tree render time
# Add console.time() in getChildren() during development
```

---

## 2026-05-15 — Deep-Pagination Investigation (offset=1500 spike)

**Symptom:** Cold load of side pane with `assignee=any, status=any` filter takes ~16s for ~1505 issues across 16 pages. Page timing is mostly 0.6–1.3s, **except offset=1500 → 9.9s** (~10× the median). The same Redmine server's `/projects/*/memberships.json` calls right after take 100–250ms, so it is not a general server slowdown.

**Endpoint:** `GET /issues.json?include=children,relations&status_id=*&limit=100&offset=1500`. Returns 5 issues / 47 KB — payload size is not the cost driver.

### Hypotheses (most → least likely)

1. **`include=children,relations` JOIN cost at the tail.** `relations` requires a left join + group-concat on `issue_relations`; `children` adds a correlated subquery. When the outer slice is small (5 rows) but Redmine still has to materialise the JOIN over the full filter set before slicing, the per-row cost dominates. Mid-pages mask it because more rows amortise the work.
2. **`OFFSET 1500` against `id DESC` (Redmine's default sort) loses the covering index.** MySQL/PostgreSQL count rows up to the offset; when combined with the JOINs in (1), the planner may switch from index scan → filesort + temp table.
3. **Cold buffer pool for the last slice.** Late rows (oldest, by `id DESC`) may not be in the InnoDB buffer pool while top 1400 are hot from previous user activity. Plausible but doesn't fully explain 10× spike.
4. **Network/TLS jitter.** Possible noise, but the same client made fast requests immediately before and after, so not the primary cause.

### Validation (server-side, recommended)

Run these against the Redmine DB to confirm hypothesis (1)/(2):

```sql
EXPLAIN ANALYZE
SELECT issues.*
FROM issues
LEFT JOIN issue_relations ON issue_relations.issue_from_id = issues.id
WHERE issues.status_id IN (<all status ids>)
ORDER BY issues.id DESC
LIMIT 100 OFFSET 1500;
```

Compare against the same query at `OFFSET 0` and `OFFSET 1400`. If `OFFSET 1500` switches to a filesort or shows a much higher `rows_examined`, hypothesis (2) is confirmed.

Also check that these indexes exist:
- `issues(status_id, id)` — supports the WHERE + ORDER BY
- `issue_relations(issue_from_id)` — already standard
- `issue_children` is a self-join through `issues.parent_id`; ensure `issues(parent_id)` index exists

### Client-side mitigations available now

- **(Shipped)** Streaming render: first page is visible after ~1s, so the 9.9s tail no longer blocks UX. (See projects-tree.ts:applyIssues, redmine-server.ts:paginate.)
- **(Shipped)** Default `maxConcurrentRequests` raised 2→4 — earlier pages overlap, but won't help the tail page if it's the bottleneck.
- **(Available, not shipped)** Drop `include=children` from the side-pane query: parent→child hierarchy is already derivable from `issue.parent.id`, which Redmine returns without `include`. The `children` array is unused by `ProjectsTree`. Expected ~30–50% reduction in per-page cost.
- **(Available, not shipped)** Drop `include=relations` for `assignee=any` filter (relations are only consumed by `extractSchedulingDependencyIds`, which is meaningful only for the assigned-to-me view). Expected ~20–30% reduction.
- **(Future)** Partition by project (`project_id=<id>`) and fetch in parallel. Smaller queries; no large OFFSET. Trade-off: more requests, but each one is bounded.
- **(Future)** Cursor on `id<`<lastSeenId> instead of `offset=` — avoids the OFFSET scan entirely. Requires a stable sort (`sort=id:desc`).

### Recommendation

If the 9.9s tail persists after measuring with EXPLAIN, ship the `include=` reduction first (smallest blast radius). If still slow, move to ID-cursor pagination. Server-side index review is the durable fix.

---

## Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - System design
- [LESSONS_LEARNED.md](./LESSONS_LEARNED.md) - Past optimizations
