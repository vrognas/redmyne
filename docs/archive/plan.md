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

**⚠️ VS Code guideline: Webviews are "last resort only"** - use native API when possible.

**Justification for Gantt**: No native VS Code API for timeline/Gantt visualization. Tree views cannot represent temporal data on X-axis. Webview is the only option.

| Guideline | Action |
|-----------|--------|
| Handle resize/reflow | Test at arbitrary panel sizes |
| Use `--vscode-*` CSS vars | No hardcoded colors |
| ARIA labels | Add to timeline items |
| Keyboard navigation | Arrow keys, Tab support |
| Virtualize long lists | Render only visible tasks |
| Avoid anti-patterns | No promotions, no wizards, no update popups |

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
| "Don't show again" | **Required on every notification** |
| Contextual errors | Include retry/view logs actions |
| Information | No required actions |
| Warning | Issues requiring user input + resolution |
| Error | Failures + corrective actions |

### Settings (New)

**Naming**: `extensionName.settingName` format (dots for hierarchy)
**Scope**: `application` = user settings only, synced across devices

| Setting | Type | Default | Scope | Description |
|---------|------|---------|-------|-------------|
| `redmine.ui.dimNonBillable` | boolean | `true` | application | Dim non-billable issues in tree views |
| `redmine.ui.showRelations` | boolean | `true` | application | Show issue relations in tooltips |
| `redmine.gantt.enabled` | boolean | `false` | application | Enable Gantt timeline view |

### Not Adding (Avoid Over-Engineering)

- Walkthroughs - overkill for focused extension
- Activity bar changes - stay in existing sidebar
- Custom settings webview - native Settings UI sufficient
- Toolbar beyond 2-3 buttons - use context menus

---

## Redmine API Patterns

### Efficient Combined Fetch

```
GET /issues.json?assigned_to_id=me&status_id=open&include=children,relations
```

Returns all data needed for Phase 2 in single paginated call:
- Issues with tracker (billable indicator) - **always included, no param needed**
- Children array per issue (sub-issues)
- Relations array per issue (dependencies)

**Pagination**: `?offset=0&limit=100` (no documented max)

### API Patterns by Phase

| Phase | Endpoint | Include | Notes |
|-------|----------|---------|-------|
| 2.1 | (existing) | - | `tracker` always in response (id + name) |
| 2.2 | `/issues.json` | `children` | Also: `?parent_id=X` to filter |
| 2.3 | `/issues.json` | `relations` | Combine with children |
| 2.4 | `/time_entries.json` | - | No API change, UX only |

### Relation Types (DIRECTIONAL)

**Critical**: Relations are directional, not bidirectional. Each direction is a separate type.

| Type | Inverse | Direction | Use |
|------|---------|-----------|-----|
| `blocked` | `blocks` | I'm blocked by X | 🚫 icon in tree |
| `blocks` | `blocked` | I block X | Show in tooltip |
| `precedes` | `follows` | X must finish before me | Timeline |
| `follows` | `precedes` | I start after X | Timeline |
| `relates` | `relates` | General link (symmetric) | Tooltip only |
| `duplicates` | `duplicated` | I duplicate X | Tooltip only |
| `duplicated` | `duplicates` | X duplicates me | Tooltip only |
| `copied_to` | `copied_from` | I was copied to X | Tooltip only |
| `copied_from` | `copied_to` | I was copied from X | Tooltip only |

**Implication**: When checking "am I blocked?", check for `blocked` type in relations array.

### Response Structure

```json
{
  "issues": [{
    "id": 123,
    "subject": "Task name",
    "tracker": { "id": 1, "name": "Task" },
    "parent": { "id": 100 },
    "children": [{ "id": 124, "subject": "Sub-task" }],
    "relations": [{
      "id": 1,
      "issue_id": 123,
      "issue_to_id": 99,
      "relation_type": "blocked",
      "delay": null
    }]
  }]
}
```

### Parent Container Fetching

When child assigned but parent not in list:
```
GET /issues/[parent_id].json
```

Fetch parent details to show as container in tree.

---

## Implementation Details

### Pre-Implementation Validation

**Required before Phase 2.2:**
```bash
# Test actual Redmine API response structure for parent field
curl -H "X-Redmine-API-Key: $KEY" \
  "$REDMINE_URL/issues.json?assigned_to_id=me&include=children,relations" | jq '.issues[0]'
```

Confirm `parent` field structure: `{ "id": number, "name"?: string }` or just `{ "id": number }`

---

### Type Design (Phase 2.2)

**Issue model additions:**
```typescript
// issue.ts
export interface Issue {
  // ... existing fields
  parent?: { id: number };           // From API - may not include name
  children?: Issue[];                // From include=children
  relations?: IssueRelation[];       // From include=relations
}

// New interface for parent containers (unassigned parents)
export interface ParentContainer {
  id: number;
  subject: string;
  isContainer: true;                 // Discriminator
  childCount: number;
  aggregatedHours: { spent: number; estimated: number };
}

// Tree item union type
export type IssueTreeItem = Issue | ParentContainer | LoadingPlaceholder;
```

**Type guard:**
```typescript
function isParentContainer(item: IssueTreeItem): item is ParentContainer {
  return 'isContainer' in item && item.isContainer === true;
}
```

---

### Parent Fetching Strategy (Phase 2.2)

**When:** During initial `getChildren()` call (blocking, not lazy)

**Algorithm:**
1. Fetch assigned issues with `include=children,relations`
2. Extract unique `parent.id` values from issues with parents
3. Filter out parents already in assigned list
4. Batch fetch missing parents: `GET /issues.json?issue_id=1,2,3`
5. Create `ParentContainer` objects for each
6. Cache containers for session

**Error handling:**
- Parent fetch fails → show child without container, log warning
- Parent deleted → skip container, show orphaned children at root

---

### Sorting Algorithm (Phase 2.3)

**Sort key for blocked issues:**
```typescript
function getIssueSortKey(issue: Issue): number {
  const hasBlocker = issue.relations?.some(r => r.relation_type === 'blocked');
  const flexibility = calculateFlexibility(issue);

  // Primary: blocked issues sink to bottom
  // Secondary: by flexibility status (overbooked > at-risk > on-track)
  // Tertiary: by days remaining
  if (hasBlocker) return 1000 + flexibility.daysRemaining;
  if (flexibility.status === 'overbooked') return 100 + flexibility.daysRemaining;
  if (flexibility.status === 'at-risk') return 200 + flexibility.daysRemaining;
  return 300 + flexibility.daysRemaining;
}
```

---

### Aggregated Hours (Phase 2.2)

**Calculation:** Pre-computed during parent container creation

```typescript
function createParentContainer(parentIssue: Issue, children: Issue[]): ParentContainer {
  return {
    id: parentIssue.id,
    subject: parentIssue.subject,
    isContainer: true,
    childCount: children.length,
    aggregatedHours: {
      spent: children.reduce((sum, c) => sum + (c.spent_hours ?? 0), 0),
      estimated: children.reduce((sum, c) => sum + (c.estimated_hours ?? 0), 0),
    },
  };
}
```

**Refresh:** Recalculated on tree refresh (not live)

---

### Settings Usage (Phase 2.1-2.5)

| Setting | Check Location | Effect |
|---------|----------------|--------|
| `redmine.ui.dimNonBillable` | `tree-item-factory.ts` | Skip ThemeColor if false |
| `redmine.ui.showRelations` | `my-issues-tree.ts` | Skip `include=relations` if false |
| `redmine.gantt.enabled` | `extension.ts` | Hide Gantt command if false |

**Implementation:**
```typescript
// tree-item-factory.ts
const config = vscode.workspace.getConfiguration('redmine.ui');
if (config.get('dimNonBillable') && issue.tracker.name !== 'Task') {
  treeItem.iconPath = new ThemeIcon('circle-outline',
    new ThemeColor('list.deemphasizedForeground'));
}
```

---

### Billable Determination (Phase 2.1)

**Assumption:** Tracker name `"Task"` = billable, anything else = non-billable

**Validation:** User's Redmine has trackers "Task" and "Non-billable"

**Configurable fallback (future):** If other users need different logic:
```typescript
// Could add setting: redmine.ui.billableTrackers: ["Task", "Feature"]
const billableTrackers = config.get<string[]>('billableTrackers') ?? ['Task'];
const isBillable = billableTrackers.includes(issue.tracker.name);
```

**For now:** Hardcode "Task" check, document assumption

---

### Gantt Library Decision (Phase 2.5)

**Selected:** Custom SVG (simplest)

**Rationale:**
- vis-timeline: Overkill for read-only view, adds 200KB+ dependency
- D3.js: High learning curve, overkill for basic bars + arrows
- Custom SVG: ~200 lines, full control, no dependencies

**Implementation approach:**
```typescript
// Simple SVG generation
function renderGanttSVG(issues: Issue[]): string {
  const rowHeight = 30;
  const dayWidth = 20;
  // ... calculate positions, return SVG string
}
```

**Dependency arrows:** SVG `<path>` with bezier curves

---

### Webview Implementation (Phase 2.5)

**createWebviewPanel() call:**
```typescript
const panel = vscode.window.createWebviewPanel(
  'redmineGantt',           // viewType (internal)
  'Redmine Gantt',          // title (user-visible)
  vscode.ViewColumn.One,    // editor column
  {
    enableScripts: true,
    retainContextWhenHidden: true,  // preserve state on hide
    localResourceRoots: [extensionUri]
  }
);
```

**CSP meta tag (required):**
```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           style-src ${webview.cspSource} 'unsafe-inline';
           script-src ${webview.cspSource};
           img-src ${webview.cspSource} data:;" />
```

**State persistence:**
```typescript
// Save: scroll position, expanded rows
panel.webview.postMessage({ command: 'getState' });
panel.webview.onDidReceiveMessage(msg => {
  if (msg.command === 'state') {
    context.workspaceState.update('ganttState', msg.data);
  }
});
```

**Click interaction:**
```typescript
// Webview sends: { command: 'issueClick', issueId: 123 }
// Extension handles:
panel.webview.onDidReceiveMessage(async msg => {
  if (msg.command === 'issueClick') {
    const issue = await server.getIssueById(msg.issueId);
    new IssueController(issue, server).listActions();
  }
});
```

**acquireVsCodeApi() pattern:**
```javascript
// In webview HTML - call ONCE, store reference
const vscode = acquireVsCodeApi();

function handleIssueClick(issueId) {
  vscode.postMessage({ command: 'issueClick', issueId });
}
```

**Theming (CSS variables):**
```css
/* Use VS Code theme tokens - dots become hyphens */
body {
  color: var(--vscode-editor-foreground);
  background: var(--vscode-editor-background);
}
.issue-bar {
  fill: var(--vscode-button-background);
}
.blocked-bar {
  fill: var(--vscode-errorForeground);
}
/* Theme detection via body class: .vscode-light, .vscode-dark, .vscode-high-contrast */
```

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

**Effort**: 4-5h (includes type design, parent fetching, aggregation)

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
     relation_type: 'relates' | 'duplicates' | 'duplicated' | 'blocks' | 'blocked' | 'precedes' | 'follows' | 'copied_to' | 'copied_from';
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
- **Library decision: Custom SVG** (no external dependencies, ~200 lines)

**Implementation sequence**:
1. Basic webview with CSP + theming
2. SVG timeline with issue bars
3. Add dependency arrows (bezier curves)
4. Add parent/child grouping (indentation)
5. Add click interactions (postMessage)
6. State persistence (scroll, expanded)

**Effort**: 6-8h (custom SVG simpler than library integration)

---

## Implementation Order

```
2.0 Bug Fixes     [15 min]  ← Do first, unblocks tree view
    ↓
2.1 Billable      [30 min]  ← Quick win, high value for invoicing
    ↓
2.2 Sub-issues    [4-5h]    ← Core feature for task breakdown
    ↓
2.3 Relations     [2-3h]    ← Dependencies, builds on 2.2
    ↓
2.4 Time UX       [1-2h]    ← Polish, can parallelize
    ↓
2.5 Gantt         [6-8h]    ← Custom SVG, no dependencies
```

**Total P0-P1**: ~9-11h
**With P2 (Gantt)**: ~15-19h

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
| Billable tracker | Hardcode "Task" = billable (user's setup) |
| Sub-issue tree style | Collapsible parent nodes (like projects tree) |
| Unassigned parents | Show as container even if not assigned |
| Parent fetch timing | Blocking during initial load, cached |
| Relations fetch | Eager (always visible) |
| Blocked issue sorting | Sink to bottom, then by flexibility |
| Gantt necessity | Keep - users value visual timeline |
| Gantt library | Custom SVG (no dependencies, ~200 lines) |

---

## Changelog

- 2025-11-25: **Second validation pass** - validated against official Redmine/VS Code docs
  - **Critical fix**: Relations are DIRECTIONAL (blocks≠blocked, duplicates≠duplicated)
  - Added all 9 relation types (was 6)
  - Tracker always included in API response (confirmed)
  - Added webview "last resort" warning + justification
  - Settings: added proper naming conventions and scope docs
  - Notifications: "Do not show again" now required on all
  - Webview: added createWebviewPanel params, theming CSS vars
  - Added pagination info to API section
- 2025-11-25: Comprehensive validation pass - added Implementation Details section
  - Type design for ParentContainer
  - Parent fetching strategy and error handling
  - Sorting algorithm for blocked issues
  - Aggregated hours calculation
  - Settings usage locations
  - Billable determination logic
  - Gantt library decision (custom SVG)
  - Webview CSP, state, click handling
  - Updated effort estimates
- 2025-11-25: Added Redmine API patterns section
- 2025-11-25: Added UX guidelines compliance section
- 2025-11-25: Added VS Code API leverage section from docs research
- 2025-11-25: Resolved all open questions, finalized decisions
- 2025-11-25: Initial plan created from fit assessment
