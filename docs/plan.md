# Implementation Plan - Phase 2

**Date**: 2025-11-25
**Status**: Ready for implementation
**Previous**: Phase 1 complete (MVP-1 through MVP-4, v3.6.0)

---

## Problem Statement

**User**: Data programmer/consultant working in Positron (Code-OSS fork)

**Core workflow needs**:
1. Log time to correct issues (billable vs non-billable) for invoicing
2. Track work across multiple projects/clients simultaneously
3. Assess timelines: due dates, sub-tasks, how others' work affects mine
4. Minimize context switching to browser

**Current fit score**: ~60%

---

## Gap Analysis

### Bugs

| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| B1 | Subproject filter logic inverted | Issues duplicated in tree view | 5 min |

### Missing Features

| # | Feature | Impact | Effort |
|---|---------|--------|--------|
| F1 | Billable indicator (tracker visibility) | Can't distinguish Task vs Non-billable at glance | Low |
| F2 | Sub-issue hierarchy | Can't see task breakdown or roll-up | Medium |
| F3 | Issue relations (blocks/blocked by) | Can't see dependencies | Medium |
| F4 | Gantt/timeline visualization | No visual planning | High |

### UX Inconsistencies

| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| U1 | Time logging UX differs (IssueController vs QuickLogTime) | Friction, learning curve | Low |

---

## What We Won't Build (Scope Boundaries)

- **No custom fields support** - tracker covers billable distinction
- **No issue creation in IDE** - browser adequate, rarely used
- **No attachment handling** - browser adequate
- **No journal/comment viewing** - nice-to-have, not blocking
- **No drag-to-reschedule in Gantt** - read-only sufficient initially
- **No saved queries** - Redmine web handles complex filtering

---

## VS Code API Leverage

### Built-in Features (No Custom UI)

| Need | VS Code API | Notes |
|------|-------------|-------|
| Dim non-billable | `ThemeColor('list.deemphasizedForeground')` | Native gray color |
| Tooltip formatting | `MarkdownString` | Already in use |
| Collapsible tree | `TreeItemCollapsibleState.Collapsed` | Native expansion |
| Status icons | `ThemeIcon` + `ThemeColor` | Already in use |
| Blocked indicator | `ThemeIcon('error')` | Red icon |
| Progress feedback | `withProgress(ProgressLocation.Notification)` | Native spinner |

### Patterns Already in Codebase

| Pattern | File | Reuse For |
|---------|------|-----------|
| `ThemeIcon` with color | `tree-item-factory.ts:66` | Blocked icon (2.3) |
| `MarkdownString` tooltip | `tree-item-factory.ts:105` | Relations display (2.3) |
| `TreeItemCollapsibleState` | `projects-tree.ts:44` | Sub-issue hierarchy (2.2) |
| `getChildren(element?)` | `projects-tree.ts:52` | Parent/child pattern (2.2) |

### New Patterns Needed

| Feature | Pattern | Effort |
|---------|---------|--------|
| Webview panel | `createWebviewPanel()` | Medium |
| Webview messaging | `postMessage()` / `onDidReceiveMessage()` | Medium |
| Webview theming | CSS `var(--vscode-*)` variables | Low |
| Webview CSP | Content-Security-Policy meta tag | Low |
| State persistence | `getState()` / `setState()` | Low |

---

## UX Guidelines Compliance

### Tree Views (2.1-2.3)

| Guideline | Status | Notes |
|-----------|--------|-------|
| Max 3 nesting levels | ✅ | Plan uses 2 levels |
| Icons as primary indicators | ✅ | Using ThemeIcon |
| Max 3 action buttons/item | ✅ | Using context menus |
| Avoid deep hierarchy | ✅ | Flatten grandchildren |

### Webview (2.5)

| Guideline | Action |
|-----------|--------|
| Handle resize/reflow | Test at arbitrary panel sizes |
| Use `--vscode-*` CSS vars | No hardcoded colors |
| ARIA labels | Add to timeline items |
| Keyboard navigation | Arrow keys, Tab support |
| Virtualize long lists | Render only visible tasks |

### Quick Picks (2.4)

| Guideline | Action |
|-----------|--------|
| Icons for recognition | Add to activity picker |
| Step counter | Title: "Log Time (1/3)" |
| Separators | Group activity categories |

### Notifications

| Guideline | Action |
|-----------|--------|
| Avoid modal spam | Use status bar flash (existing) |
| "Don't show again" | Add for repetitive confirmations |
| Contextual errors | Include retry/view logs actions |

### Settings (New)

| Setting | Type | Default | Scope |
|---------|------|---------|-------|
| `redmine.ui.dimNonBillable` | boolean | `true` | application |
| `redmine.ui.showRelations` | boolean | `true` | application |
| `redmine.gantt.enabled` | boolean | `false` | application |

### Not Adding (Avoid Over-Engineering)

- Walkthroughs - overkill for focused extension
- Activity bar changes - stay in existing sidebar
- Custom settings webview - native Settings UI sufficient
- Toolbar beyond 2-3 buttons - use context menus

---

## Phased Implementation

### Phase 2.0: Bug Fixes (P0)

**Scope**: Fix blocking bugs before new features

| Task | File | Change |
|------|------|--------|
| B1: Fix subproject filter | `redmine-server.ts:525-527` | Swap ternary condition |

**Effort**: 15 min (including test)

---

### Phase 2.1: Billable Visibility (P1)

**Scope**: Show tracker (Task vs Non-billable) in issue display

**Decision**: Tooltip-only + dim non-billable issues

**Changes**:
1. `tree-item-factory.ts`: Add tracker to tooltip ("**Tracker:** Task")
2. `tree-item-factory.ts`: Reduce opacity for non-billable issues (gray text)

**Display**:
```
Billable:     Fix login bug #123 10/40h 5d On Track     (normal)
Non-billable: Update docs #124 2/4h 3d On Track        (dimmed/gray)
```

**Tooltip addition**:
```markdown
**#123: Fix login bug**
**Tracker:** Task
**Progress:** 10h / 40h
```

**Effort**: 30 min

---

### Phase 2.2: Sub-Issue Support (P0)

**Scope**: Display parent/child issue relationships

**Decisions**:
- Tree style: Collapsible parent nodes (like projects tree)
- Unassigned parents: Show as container even if not directly assigned

**API available**:
```
GET /issues/:id.json?include=children  → child issues
GET /issues.json?parent_id=123         → filter by parent
Issue response includes: parent: { id, name }
```

**Changes**:

1. **Model** (`issue.ts`):
   ```typescript
   parent?: NamedEntity;
   children?: Issue[];
   ```

2. **API** (`redmine-server.ts`):
   - Fetch issues with parent info included
   - Group by parent_id client-side
   - Fetch parent issue details if not in assigned list

3. **Tree** (`my-issues-tree.ts`):
   - Top-level: root issues (no parent) + parent containers
   - Collapsible: parent issues expand to show children
   - Parent containers shown even if user not directly assigned
   - Aggregate hours in parent tooltip (sum of children)

**Display**:
```
▶ Parent Task #100 (3 sub-issues)        ← collapsible, even if unassigned
  ├─ Sub-task A #101 2/8h 5d On Track
  ├─ Sub-task B #102 4/8h 3d At Risk
  └─ Sub-task C #103 0/4h 7d On Track
▶ Standalone Task #105 8/16h 2d On Track ← no parent, still collapsible if has children
```

**Edge cases**:
- Parent assigned but no children assigned → show parent only (no expand)
- Child assigned but parent not → fetch parent, show as container
- Deeply nested (grandchildren) → flatten to 2 levels max

**Effort**: 3-4h

---

### Phase 2.3: Issue Relations (P1)

**Scope**: Show blocking dependencies

**Decision**: Eager fetch (relations always visible in tooltip)

**API available**:
```
GET /issues/:id.json?include=relations
Relation types: blocks, blocked, precedes, follows, relates, duplicates
```

**Changes**:

1. **Model** (`issue.ts`):
   ```typescript
   relations?: IssueRelation[];

   interface IssueRelation {
     id: number;
     issue_id: number;
     issue_to_id: number;
     relation_type: 'blocks' | 'blocked' | 'precedes' | 'follows' | 'relates' | 'duplicates';
     delay?: number;  // days, for precedes/follows
   }
   ```

2. **API** (`redmine-server.ts`):
   - Add `include=relations` to `getIssuesAssignedToMe()` fetch
   - Relations included in initial load, no separate calls

3. **Tree** (`my-issues-tree.ts`):
   - Tooltip: show relations grouped by type
   - Tree description: add `🚫` icon if blocked by open issue
   - Blocked issues sorted lower (can't work on them)

**Display**:
```
Tree item (blocked):
  🚫 Fix login bug #123 10/40h 5d Blocked

Tooltip:
  **#123: Fix login bug**
  **Tracker:** Task
  **⛔ Blocked by:** #120 (Database migration)
  **▶ Blocks:** #125, #126
  **Progress:** 10h / 40h (25%)
```

**Relation display priority** (tooltip order):
1. `blocked` - most important, can't proceed
2. `blocks` - others waiting on this
3. `precedes/follows` - timeline dependencies
4. `relates/duplicates` - informational

**Effort**: 2-3h

---

### Phase 2.4: Unified Time Logging UX (P1)

**Scope**: Make IssueController use same flow as QuickLogTime

**Current IssueController flow** (`issue-controller.ts:38-70`):
```
1. Pick activity
2. Enter "hours|comment" in single field  ← awkward
```

**QuickLogTime flow** (`quick-log-time.ts`):
```
1. Pick issue (skip - already have it)
2. Pick activity
3. Enter hours (flexible: "2.5", "1:45", "1h 30min")
4. Enter comment (optional, separate)
```

**Changes**:
1. Extract time input logic from `quick-log-time.ts` to shared utility
2. Replace `setTimeEntryMessage()` in IssueController
3. Reuse `parseTimeInput()` for flexible formats

**Effort**: 1-2h

---

### Phase 2.5: Gantt Webview (P2)

**Scope**: Visual timeline for issues and dependencies

**Decision**: Keep in plan - users value visual timeline

**Features**:
- Horizontal bar chart: issues on Y-axis, time on X-axis
- Bar = start_date → due_date, filled portion = progress
- Dependency arrows between related issues
- Parent/child nesting (collapsible rows)
- Color coding: billable vs non-billable, risk status
- Click issue → open actions menu

**Technical approach**:
- VS Code Webview panel
- Read-only (no drag-to-edit) - keeps complexity low
- Library options:
  - **vis-timeline** - pre-built Gantt, good for MVP
  - **D3.js** - more control, higher effort
  - **Custom SVG** - simplest, limited interactivity

**Implementation sequence**:
1. Basic timeline with issue bars
2. Add dependency arrows
3. Add parent/child grouping
4. Add click interactions

**Effort**: 8-12h

---

## Implementation Order

```
2.0 Bug Fixes     [15 min]  ← Do first, unblocks tree view
    ↓
2.1 Billable      [30 min]  ← Quick win, high value for invoicing
    ↓
2.2 Sub-issues    [3-4h]    ← Core feature for task breakdown
    ↓
2.3 Relations     [2-3h]    ← Dependencies, builds on 2.2
    ↓
2.4 Time UX       [1-2h]    ← Polish, can parallelize
    ↓
2.5 Gantt         [8-12h]   ← Evaluate need after above
```

**Total P0-P1**: ~8-10h
**With P2 (Gantt)**: ~18-22h

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Problem-solution fit | 60% | 85%+ |
| Browser visits/day | 4-5 | 1-2 |
| Time to log entry | 15s | 10s |
| Can see task breakdown | No | Yes |
| Can see blockers | No | Yes |

---

## Decisions Log

| Question | Decision |
|----------|----------|
| Billable display | Tooltip-only + dim non-billable issues |
| Sub-issue tree style | Collapsible parent nodes (like projects tree) |
| Unassigned parents | Show as container even if not assigned |
| Relations fetch | Eager (always visible) |
| Gantt necessity | Keep - users value visual timeline |

---

## Changelog

- 2025-11-25: Added UX guidelines compliance section
- 2025-11-25: Added VS Code API leverage section from docs research
- 2025-11-25: Resolved all open questions, finalized decisions
- 2025-11-25: Initial plan created from fit assessment
