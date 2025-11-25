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
code --disable-extensions && code --install-extension ./positron-redmine-*.vsix

# Profile network calls
# Enable: redmine.logging.enabled = true
# View: Output panel → "Redmine API"

# Measure tree render time
# Add console.time() in getChildren() during development
```

---

## Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - System design
- [LESSONS_LEARNED.md](./LESSONS_LEARNED.md) - Past optimizations
