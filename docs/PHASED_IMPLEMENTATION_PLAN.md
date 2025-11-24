# Phased Implementation Plan - Redmine VSCode Extension MVPs

**Date**: 2025-11-24
**Status**: Ready for implementation
**Compliance**: A (91/100) - All critical issues resolved

---

## Executive Summary

### MVP Structure

4 MVPs addressing consultant workflow gaps, totaling **26-40h** (3-5 days)

| MVP | Priority | Effort | Start | Description |
|-----|----------|--------|-------|-------------|
| **MVP-3** | P1 | 3-4h | ⭐ **START** | Quick Time Logging (Ctrl+K Ctrl+L) |
| **MVP-2** | P0 | 5-7h | Phase 2 | Time Entry Viewing (tree view) |
| **MVP-1** | P0 | 9-11h | Phase 3 | Timeline & Progress Display (flexibility scores) |
| **MVP-4** | P1 | 2-3h | Phase 4 | Workload Overview (status bar) |

**Implementation Order**: MVP-3 → MVP-2 → MVP-1 → MVP-4
**Rationale**: Simple→Complex, de-risk patterns early

### Validation Status

✅ **3 validation passes completed**:
1. **Critical fixes**: Keybinding conflict, lazy calc freeze, caching, config validation
2. **UX compliance** (1st pass): Accessibility (ThemeIcon), status bar, loading states, welcome views
3. **UX compliance** (2nd pass): Docs, context menus, notifications, settings

**Verdict**: Ready for implementation - no blocking issues

### Expected Impact

**Current**: 30-35% workflow coverage, ~10 browser visits/day

**After P0 (MVP-1+2)**: 60-65% coverage, ~4-5 visits/day
- ✅ Work prioritization (flexibility scores)
- ✅ Time verification (view logged entries)

**After P1 (MVP-3+4)**: 75-80% coverage, ~2-3 visits/day
- ✅ Quick time logging (10s vs 60s)
- ✅ Capacity assessment (workload overview)

**Browser visits reduced**: 10/day → 2-3/day (70-80% reduction)

---

## Critical Findings & Fixes

### Validation Findings (Fixed)

#### 1. Keybinding Conflict
**Problem**: `Ctrl+K Ctrl+T` conflicts with VSCode Color Theme picker
**Fix**: ✅ Changed to `Ctrl+K Ctrl+L` (L for "Log time")

#### 2. MVP-1 Lazy Calculation Freeze
**Problem**: Calculating flexibility in `getTreeItem()` = 200+ API calls per refresh
**Fix**: ✅ Pre-calculate in `getChildren()`, cache on issue object

#### 3. MVP-2 Double-Fetching
**Problem**: Fetching time entries twice (total + children)
**Fix**: ✅ Cache at parent level, return cached entries for children

#### 4. Config Validation Missing
**Problem**: `workingDays` array can be empty (breaks calculations)
**Fix**: ✅ Added `minItems: 1`, `maxItems: 7`, `uniqueItems: true`

#### 5. Storage Strategy
**Problem**: Docs said "5-issue LRU" but globalState has 2KB limit
**Fix**: ✅ Store only 1 recent issue (400 bytes)

### UX Compliance (Fixed)

#### 1. Accessibility - Emoji → ThemeIcon
**Problem**: Color-only risk indicators (🟢🟡🔴) lack screen reader support
**Fix**: ✅ ThemeIcon with semantic colors + text alternatives

#### 2. Status Bar Multi-Icon
**Problem**: "$(pulse) 25h left, +7h 🟢" has two icons
**Fix**: ✅ Text-only: "25h left, +7h buffer"

#### 3. Visual Density
**Problem**: "3.5/8h 2d +100%→+60% 🟢 #123" too long (35 chars)
**Fix**: ✅ Simplified to "#123 3.5/8h 2d +60% On Track" (20 chars)

#### 4. Loading States
**Problem**: Tree views show empty until data arrives
**Fix**: ✅ Added ThemeIcon('loading~spin') placeholder

#### 5. Welcome Views
**Problem**: No setup guidance when no server configured
**Fix**: ✅ Added viewsWelcome for onboarding

### Second Pass Findings (Integrated)

#### 1. Context Menus
**Problem**: No right-click menus on tree items
**Fix**: ✅ Added view/item/context menu contributions

#### 2. Command Naming
**Problem**: Inconsistent "Redmine:" prefix
**Fix**: ✅ All commands have "Redmine:" category prefix

#### 3. Notifications
**Problem**: Confirmation after every time log (5-10x/day)
**Fix**: ✅ Status bar flash instead (3s timeout)

#### 4. Settings Enhancements
**Problem**: Missing scope, plain descriptions
**Fix**: ✅ Added scope, markdownDescription, order, cross-refs

---

## VSCode API Patterns

### Core Patterns Used

**Native UI Only** - No webviews needed

| Component | Usage | MVPs |
|-----------|-------|------|
| TreeView | Data display, hierarchy | MVP-1, MVP-2 |
| TreeItem | Description, tooltip, icon, context | MVP-1, MVP-2 |
| StatusBarItem | Always-visible summary | MVP-4 |
| QuickPick | Issue/activity selection | MVP-3 |
| InputBox | Hours input | MVP-3 |
| ThemeIcon | Accessible, theme-aware icons | All |
| MarkdownString | Rich tooltips | All |

### Tree View Pattern

```typescript
export class MyIssuesTreeDataProvider implements vscode.TreeDataProvider<Issue> {
  private _onDidChangeTreeData = new vscode.EventEmitter<Issue | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);  // Full refresh
  }

  async getChildren(element?: Issue): Promise<Issue[]> {
    if (!element) {
      // Root level - fetch and pre-calculate
      const issues = await this.server.getIssuesAssignedToMe();

      // Pre-calculate flexibility (NOT in getTreeItem)
      for (const issue of issues) {
        issue._cachedFlexibility = await this.calculateFlexibility(issue);
      }

      return issues;
    }
    return [];  // No children
  }

  getTreeItem(issue: Issue): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(issue.subject);

    // Use cached values - no API calls
    treeItem.description = `#${issue.id} ${issue._cachedFlexibility}`;
    treeItem.iconPath = new vscode.ThemeIcon('pass');
    treeItem.tooltip = new vscode.MarkdownString(`...`);
    treeItem.contextValue = 'issue';  // For context menus

    return treeItem;
  }
}
```

### Accessibility Pattern (ThemeIcon)

```typescript
// Risk Icon Mapping
function getRiskIcon(flexibility: number): { icon: string, color: string, text: string } {
  if (flexibility < 0) return { icon: 'error', color: 'errorForeground', text: 'Overbooked' };
  if (flexibility < 20) return { icon: 'warning', color: 'warningForeground', text: 'At Risk' };
  return { icon: 'pass', color: 'testing.iconPassed', text: 'On Track' };
}

const risk = getRiskIcon(flexibility);
treeItem.iconPath = new vscode.ThemeIcon(risk.icon, new vscode.ThemeColor(risk.color));
treeItem.description = `#${issue.id} 3.5/8h 2d ${risk.text}`;
```

### Configuration Pattern

```typescript
// package.json
"contributes": {
  "configuration": {
    "properties": {
      "redmine.workinghours.hoursperday": {
        "type": "number",
        "default": 8,
        "minimum": 1,
        "maximum": 16,
        "scope": "application",
        "order": 10,
        "markdownDescription": "**Daily working hours** for deadline calculations\n\nUsed with `#redmine.workinghours.workingdays#`"
      }
    }
  }
}

// Read config
const config = vscode.workspace.getConfiguration('redmine.workingHours');
const hoursPerDay = config.get<number>('hoursPerDay', 8);

// Listen for changes
vscode.workspace.onDidChangeConfiguration(e => {
  if (e.affectsConfiguration('redmine.workingHours')) {
    this.refresh();
  }
});
```

### Welcome View Pattern

```json
"viewsWelcome": [
  {
    "view": "redmine-explorer-my-issues",
    "contents": "No Redmine server configured.\n\n[$(gear) Configure Server](command:redmine.configure)\n\n[$(book) Documentation](https://github.com/vrognas/positron-redmine)",
    "when": "!redmine:serverConfigured"
  }
]
```

**Set context key**:
```typescript
vscode.commands.executeCommand('setContext', 'redmine:serverConfigured', !!serverUrl);
```

### Context Menu Pattern

```json
"menus": {
  "view/item/context": [
    {
      "command": "redmine.openInBrowser",
      "when": "view == 'redmine-explorer-my-issues' && viewItem == 'issue'",
      "group": "navigation@1"
    },
    {
      "command": "redmine.quickLogTime",
      "when": "viewItem == 'issue'",
      "group": "redmine@1"
    },
    {
      "command": "redmine.copyIssueUrl",
      "when": "viewItem == 'issue'",
      "group": "9_cutcopypaste@1"
    }
  ]
}
```

### Loading State Pattern

```typescript
async getChildren(element?: TreeItem): Promise<TreeItem[]> {
  if (!element && this.isLoading) {
    return [{
      label: 'Loading time entries...',
      iconPath: new vscode.ThemeIcon('loading~spin'),
      collapsibleState: vscode.TreeItemCollapsibleState.None
    }];
  }

  this.isLoading = true;
  const data = await this.fetchData();
  this.isLoading = false;

  return data;
}
```

### Performance Pattern (Memoization)

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

---

## Phase 1: MVP-3 Quick Time Logging (3-4h)

### Overview

**Start Here** ⭐ - Simplest MVP, highest ROI, validates patterns

**User Story**: As a consultant, I want to log time in 10s (vs 60s browser) using Ctrl+K Ctrl+L

**Success Criteria**:
- Keybinding works in all contexts
- Recent issue cached and pre-filled
- Validation prevents invalid inputs
- Status bar confirms success (no notification spam)

### Implementation Steps

#### Step 1: Create Command (1h)

**File**: `src/commands/quick-log-time.ts` (~150 LOC)

```typescript
export async function quickLogTime(
  props: ActionProperties,
  context: vscode.ExtensionContext  // CRITICAL: Pass for globalState
): Promise<void> {
  // 1. Get recent log from cache
  const recent = context.globalState.get<RecentTimeLog>('lastTimeLog');

  // 2. Prompt: recent issue or pick new?
  let selection: { issueId: number, activityId: number };

  if (recent && isRecent(recent.lastLogged)) {
    const choice = await vscode.window.showQuickPick([
      { label: `$(history) Log to #${recent.issueId}: ${recent.issueSubject}`, value: 'recent' },
      { label: '$(search) Pick different issue', value: 'pick' }
    ], { placeHolder: 'Log time to...' });

    if (choice?.value === 'recent') {
      selection = { issueId: recent.issueId, activityId: recent.lastActivityId };
    } else {
      selection = await pickIssueAndActivity(props, context);
    }
  } else {
    selection = await pickIssueAndActivity(props, context);
  }

  // 3. Input hours
  const hours = await vscode.window.showInputBox({
    prompt: `Hours worked on #${selection.issueId}`,
    placeHolder: '2.5',
    validateInput: (value) => {
      const num = parseFloat(value);
      if (isNaN(num) || num <= 0 || num > 24) {
        return 'Must be 0.1-24 hours';
      }
      return null;
    }
  });

  if (!hours) throw new Error('No hours entered');

  // 4. Post time entry
  await props.server.postTimeEntry({
    issue_id: selection.issueId,
    hours: parseFloat(hours),
    activity_id: selection.activityId,
    spent_on: new Date().toISOString().split('T')[0]
  });

  // 5. Update cache
  context.globalState.update('lastTimeLog', {
    issueId: selection.issueId,
    issueSubject: '...',
    lastActivityId: selection.activityId,
    lastActivityName: '...',
    lastLogged: new Date()
  });

  // 6. Confirm with status bar flash (NOT notification)
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBar.text = `$(check) Logged ${hours}h to #${selection.issueId}`;
  statusBar.show();
  setTimeout(() => statusBar.hide(), 3000);
}
```

**Helper function**:
```typescript
async function pickIssueAndActivity(
  props: ActionProperties,
  context: vscode.ExtensionContext
): Promise<{ issueId: number, activityId: number }> {
  // Get recent issue IDs from cache (LRU 10)
  const recentIds = context.globalState.get<number[]>('recentIssueIds', []);

  // Fetch assigned issues
  const issues = await props.server.getIssuesAssignedToMe();

  // Sort: recent first, then by due date
  const sortedIssues = [
    ...issues.filter(i => recentIds.includes(i.id)),
    ...issues.filter(i => !recentIds.includes(i.id))
  ].slice(0, 10);  // Limit to 10 for instant UX

  const quickPickItems = [
    { label: '$(search) Search all issues', value: null },
    ...sortedIssues.map(i => ({
      label: `#${i.id} ${i.subject}`,
      description: i.project.name,
      detail: `${i.status.name} | Due: ${i.due_date || 'None'}`,
      issue: i
    }))
  ];

  const picked = await vscode.window.showQuickPick(quickPickItems, {
    title: 'Log Time (1/2)',
    placeHolder: 'Select issue to log time',
    matchOnDescription: true
  });

  if (!picked || !picked.issue) throw new Error('No issue selected');

  // Update recent issues cache
  const updatedRecent = [
    picked.issue.id,
    ...recentIds.filter(id => id !== picked.issue.id)
  ].slice(0, 10);
  context.globalState.update('recentIssueIds', updatedRecent);

  // Pick activity
  const activities = await props.server.getTimeEntryActivities();
  const activity = await vscode.window.showQuickPick(
    activities.time_entry_activities.map(a => ({
      label: a.name,
      description: a.is_default ? 'Default' : undefined,
      activity: a
    })),
    {
      title: 'Log Time (2/2)',
      placeHolder: 'Select activity'
    }
  );

  if (!activity) throw new Error('No activity selected');

  return {
    issueId: picked.issue.id,
    activityId: activity.activity.id
  };
}

interface RecentTimeLog {
  issueId: number;
  issueSubject: string;
  lastActivityId: number;
  lastActivityName: string;
  lastLogged: Date;
}

function isRecent(date: Date): boolean {
  return (Date.now() - new Date(date).getTime()) < 24 * 60 * 60 * 1000;  // 24h
}
```

#### Step 2: Register Command (15min)

**File**: `src/extension.ts`

```typescript
// CRITICAL: Pass context for globalState access
registerCommand('quickLogTime', (props: ActionProperties) => {
  return quickLogTime(props, context);
});
```

#### Step 3: Add to package.json (15min)

```json
{
  "contributes": {
    "commands": [
      {
        "command": "redmine.quickLogTime",
        "title": "Redmine: Quick Log Time"
      }
    ],
    "keybindings": [
      {
        "command": "redmine.quickLogTime",
        "key": "ctrl+k ctrl+l",
        "mac": "cmd+k cmd+l",
        "when": "!terminalFocus && !inDebugMode && !inQuickOpen"
      }
    ]
  }
}
```

#### Step 4: Write Tests (1-1.5h)

**File**: `src/commands/quick-log-time.test.ts`

```typescript
describe('quickLogTime', () => {
  it('shows recent issue if logged <24h ago', async () => {
    // Setup: globalState with recent log from 1h ago
    // Execute: quickLogTime
    // Assert: QuickPick shows recent option first
  });

  it('validates hours input (0.1-24 range)', async () => {
    // Assert: Rejects "0", "-5", "25", "abc"
  });

  it('updates globalState cache after logging', async () => {
    // Assert: lastTimeLog updated with new issue
  });
});
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| No assigned issues | Show error, suggest browser |
| No recent log | Skip recent prompt, go to picker |
| Recent > 24h old | Treat as no recent |
| Invalid input format | Validation error, re-prompt |
| API error | Show error, don't update state |

### Files

**CREATE**:
- `src/commands/quick-log-time.ts` (~150 LOC)
- `src/commands/quick-log-time.test.ts` (~100 LOC)

**MODIFY**:
- `src/extension.ts` (register command, pass context)
- `package.json` (command + keybinding)

### Success Criteria

- [ ] Ctrl+K Ctrl+L works in all editor contexts
- [ ] Recent issue shows if <24h old
- [ ] Input validation prevents invalid hours
- [ ] Status bar flash confirms (no notification)
- [ ] globalState cache updates correctly
- [ ] Tests pass (3 scenarios)

**Estimated Effort**: 3-4 hours

---

## Phase 2: MVP-2 Time Entry Viewing (5-7h)

### Overview

**Priority**: P0 - Critical for billing verification

**User Story**: As a consultant, I want to view logged time entries by date to verify billing accuracy before EOD

**Success Criteria**:
- Tree view with Today/Week/Month groups
- Entries cached at parent level (no double-fetching)
- Loading state shows during fetch
- Refresh command works
- Context menu for entries (view, edit, delete)

### Implementation Steps

#### Step 1: Create Tree Data Provider (2-3h)

**File**: `src/trees/my-time-entries-tree.ts` (~200 LOC)

```typescript
export class MyTimeEntriesTreeDataProvider implements vscode.TreeDataProvider<TimeEntryNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TimeEntryNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private isLoading = false;

  constructor(private server: RedmineServer) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(element?: TimeEntryNode): Promise<TimeEntryNode[]> {
    // Loading state
    if (!element && this.isLoading) {
      return [{
        label: 'Loading time entries...',
        iconPath: new vscode.ThemeIcon('loading~spin'),
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        type: 'loading'
      }];
    }

    // Root level - date groups
    if (!element) {
      this.isLoading = true;

      try {
        const today = new Date().toISOString().split('T')[0];
        const weekStart = getWeekStart();
        const monthStart = getMonthStart();

        // Fetch once, cache on parent nodes
        const todayEntries = await this.server.getTimeEntries({ from: today, to: today });
        const weekEntries = await this.server.getTimeEntries({ from: weekStart, to: today });
        const monthEntries = await this.server.getTimeEntries({ from: monthStart, to: today });

        const todayTotal = todayEntries.time_entries.reduce((sum, e) => sum + e.hours, 0);
        const weekTotal = weekEntries.time_entries.reduce((sum, e) => sum + e.hours, 0);
        const monthTotal = monthEntries.time_entries.reduce((sum, e) => sum + e.hours, 0);

        return [
          {
            label: 'Today',
            description: `${todayTotal}h`,
            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
            type: 'group',
            _cachedEntries: todayEntries.time_entries
          },
          {
            label: 'This Week',
            description: `${weekTotal}h`,
            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
            type: 'group',
            _cachedEntries: weekEntries.time_entries
          },
          {
            label: 'This Month',
            description: `${monthTotal}h`,
            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
            type: 'group',
            _cachedEntries: monthEntries.time_entries
          }
        ];
      } finally {
        this.isLoading = false;
      }
    }

    // Child level - time entries (use cached)
    if (element.type === 'group' && element._cachedEntries) {
      return element._cachedEntries.map(entry => ({
        label: `#${entry.issue.id} ${entry.issue.subject}`,
        description: `${entry.hours}h ${entry.activity.name}`,
        tooltip: new vscode.MarkdownString(`
**Time Entry #${entry.id}**

**Issue:** #${entry.issue.id} ${entry.issue.subject}
**Hours:** ${entry.hours}h
**Activity:** ${entry.activity.name}
**Date:** ${entry.spent_on}
**Comments:** ${entry.comments || 'None'}

[View in Redmine](${this.server.getUrl()}/time_entries/${entry.id})
        `),
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        type: 'entry',
        contextValue: 'time-entry',
        _entry: entry
      }));
    }

    return [];
  }

  getTreeItem(node: TimeEntryNode): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(node.label, node.collapsibleState);
    treeItem.description = node.description;
    treeItem.tooltip = node.tooltip;
    treeItem.iconPath = node.iconPath;
    treeItem.contextValue = node.contextValue;
    return treeItem;
  }
}

interface TimeEntryNode {
  label: string;
  description?: string;
  tooltip?: vscode.MarkdownString;
  iconPath?: vscode.ThemeIcon;
  collapsibleState: vscode.TreeItemCollapsibleState;
  contextValue?: string;
  type: 'loading' | 'group' | 'entry';
  _cachedEntries?: TimeEntry[];
  _entry?: TimeEntry;
}
```

**Helper functions**:
```typescript
function getWeekStart(): string {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);  // Monday
  return new Date(now.setDate(diff)).toISOString().split('T')[0];
}

function getMonthStart(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
}
```

#### Step 2: Register Tree View (30min)

**File**: `src/extension.ts`

```typescript
const timeEntriesProvider = new MyTimeEntriesTreeDataProvider(server);
const timeEntriesView = vscode.window.createTreeView('redmine-explorer-my-time-entries', {
  treeDataProvider: timeEntriesProvider
});

registerCommand('refreshTimeEntries', () => {
  timeEntriesProvider.refresh();
});
```

#### Step 3: Add to package.json (30min)

```json
{
  "contributes": {
    "views": {
      "redmine-explorer": [
        {
          "id": "redmine-explorer-my-time-entries",
          "name": "My Time Entries"
        }
      ]
    },
    "commands": [
      {
        "command": "redmine.refreshTimeEntries",
        "title": "Redmine: Refresh Time Entries",
        "icon": "$(refresh)"
      }
    ],
    "menus": {
      "view/title": [
        {
          "command": "redmine.refreshTimeEntries",
          "when": "view == 'redmine-explorer-my-time-entries'",
          "group": "navigation"
        }
      ],
      "view/item/context": [
        {
          "command": "redmine.openTimeEntryInBrowser",
          "when": "viewItem == 'time-entry'",
          "group": "navigation@1"
        }
      ]
    }
  }
}
```

#### Step 4: Write Tests (1.5-2h)

**File**: `src/trees/my-time-entries-tree.test.ts`

```typescript
describe('MyTimeEntriesTreeDataProvider', () => {
  it('shows loading state during fetch', async () => {
    // Assert: getChildren returns loading item
  });

  it('caches entries at parent level (no double-fetch)', async () => {
    // Assert: getTimeEntries called 3x (today/week/month), not 6x
  });

  it('returns cached entries for children', async () => {
    // Assert: No API calls when expanding groups
  });
});
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| No entries today | Show "No time logged today" |
| API error | Show error message, retry button |
| Slow network | Loading state visible >500ms |
| Collapsed state | Start collapsed (avoid VSCode bug #127711) |

### Files

**CREATE**:
- `src/trees/my-time-entries-tree.ts` (~200 LOC)
- `src/trees/my-time-entries-tree.test.ts` (~100 LOC)

**MODIFY**:
- `src/extension.ts` (register tree view)
- `package.json` (view contribution)

### Success Criteria

- [ ] Tree view shows Today/Week/Month groups
- [ ] Total hours shown in group descriptions
- [ ] Loading state appears during fetch
- [ ] No double-fetching (cached entries)
- [ ] Refresh command works
- [ ] Context menu opens time entry in browser
- [ ] Tests pass (3 scenarios)

**Estimated Effort**: 5-7 hours

---

## Phase 3: MVP-1 Timeline & Progress (9-11h)

### Overview

**Priority**: P0 - Critical for work prioritization

**User Story**: As a consultant, I want to see flexibility scores and risk indicators on each issue to prioritize my work

**Success Criteria**:
- Dual flexibility formula (initial + remaining)
- ThemeIcon + text for accessibility
- Pre-calculated in getChildren (no lazy calc freeze)
- Memoized working days calculation
- Rich tooltip with full details
- Context menu for actions

### Implementation Steps

#### Step 1: Create Flexibility Calculator (3-4h)

**File**: `src/utilities/flexibility-calculator.ts` (~150 LOC)

```typescript
const workingDaysCache = new Map<string, number>();

export interface FlexibilityScore {
  initial: number;
  remaining: number;
  status: 'overbooked' | 'at-risk' | 'on-track';
  daysRemaining: number;
  hoursRemaining: number;
}

export function calculateFlexibility(
  issue: Issue,
  config: WorkingHoursConfig
): FlexibilityScore {
  const { hoursPerDay, workingDays } = config;

  // Initial flexibility (planning quality)
  const totalAvailable = countWorkingDays(
    new Date(issue.start_date),
    new Date(issue.due_date),
    workingDays
  ) * hoursPerDay;

  const initial = ((totalAvailable / issue.estimated_hours) - 1) * 100;

  // Remaining flexibility (current risk)
  const today = new Date();
  const dueDate = new Date(issue.due_date);

  const daysRemaining = countWorkingDays(today, dueDate, workingDays);
  const availableRemaining = daysRemaining * hoursPerDay;
  const hoursRemaining = Math.max(issue.estimated_hours - issue.spent_hours, 0);

  const remaining = hoursRemaining > 0
    ? ((availableRemaining / hoursRemaining) - 1) * 100
    : 100;  // Completed = 100% flexibility

  const status = remaining < 0 ? 'overbooked'
    : remaining < 20 ? 'at-risk'
    : 'on-track';

  return {
    initial,
    remaining,
    status,
    daysRemaining,
    hoursRemaining
  };
}

function countWorkingDays(start: Date, end: Date, workingDays: string[]): number {
  const key = `${start.toISOString()}_${end.toISOString()}_${workingDays.join(',')}`;

  if (workingDaysCache.has(key)) {
    return workingDaysCache.get(key)!;
  }

  let count = 0;
  const current = new Date(start);

  while (current <= end) {
    const dayName = current.toLocaleDateString('en-US', { weekday: 'short' });
    if (workingDays.includes(dayName)) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }

  workingDaysCache.set(key, count);
  return count;
}

export function clearFlexibilityCache(): void {
  workingDaysCache.clear();
}
```

#### Step 2: Update Tree Item Factory (2-3h)

**File**: `src/utilities/tree-item-factory.ts`

```typescript
export function enhanceIssueTreeItem(
  issue: Issue,
  flexibility: FlexibilityScore,
  serverUrl: string
): vscode.TreeItem {
  const treeItem = new vscode.TreeItem(issue.subject);

  // Simplified description (current status only)
  const risk = getRiskDetails(flexibility.remaining);
  treeItem.description = `#${issue.id} ${issue.spent_hours}/${issue.estimated_hours}h ${flexibility.daysRemaining}d ${risk.text}`;

  // ThemeIcon for accessibility
  treeItem.iconPath = new vscode.ThemeIcon(risk.icon, new vscode.ThemeColor(risk.color));

  // Rich tooltip with full details
  treeItem.tooltip = new vscode.MarkdownString(`
**Issue #${issue.id}: ${issue.subject}**

**Progress:** ${issue.spent_hours}h / ${issue.estimated_hours}h (${Math.round(issue.spent_hours / issue.estimated_hours * 100)}% complete)

**Initial Plan:**
- Start: ${issue.start_date}
- Due: ${issue.due_date}
- Flexibility: ${flexibility.initial >= 0 ? '+' : ''}${flexibility.initial.toFixed(0)}%
- Assessment: ${flexibility.initial >= 50 ? 'Comfortable buffer' : flexibility.initial >= 0 ? 'Tight but doable' : 'Underestimated'}

**Current Status:**
- Days Remaining: ${flexibility.daysRemaining} working days
- Hours Remaining: ${flexibility.hoursRemaining}h
- Flexibility: ${flexibility.remaining >= 0 ? '+' : ''}${flexibility.remaining.toFixed(0)}%
- Status: ${risk.text}

**Risk Assessment:** ${getRiskExplanation(flexibility)}

[View in Redmine](${serverUrl}/issues/${issue.id})
  `);

  treeItem.contextValue = issue.status.is_closed ? 'issue-closed' : 'issue-open';

  return treeItem;
}

interface RiskDetails {
  icon: string;
  color: string;
  text: string;
}

function getRiskDetails(flexibility: number): RiskDetails {
  if (flexibility < 0) {
    return { icon: 'error', color: 'errorForeground', text: 'Overbooked' };
  }
  if (flexibility < 20) {
    return { icon: 'warning', color: 'warningForeground', text: 'At Risk' };
  }
  return { icon: 'pass', color: 'testing.iconPassed', text: 'On Track' };
}

function getRiskExplanation(flex: FlexibilityScore): string {
  if (flex.status === 'overbooked') {
    return `Need ${Math.abs(flex.remaining).toFixed(0)}% more time. Consider extending deadline or reducing scope.`;
  }
  if (flex.status === 'at-risk') {
    return `Minimal buffer (${flex.remaining.toFixed(0)}%). Monitor closely, avoid distractions.`;
  }
  return `Comfortable buffer (${flex.remaining.toFixed(0)}%). Stay on track.`;
}
```

#### Step 3: Update My Issues Tree (1-2h)

**File**: `src/trees/my-issues-tree.ts`

```typescript
export class MyIssuesTreeDataProvider implements vscode.TreeDataProvider<Issue> {
  private _onDidChangeTreeData = new vscode.EventEmitter<Issue | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private server: RedmineServer,
    private context: vscode.ExtensionContext
  ) {
    // Listen for config changes
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('redmine.workingHours')) {
        clearFlexibilityCache();
        this.refresh();
      }
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(element?: Issue): Promise<Issue[]> {
    if (element) return [];  // No children

    // Fetch issues
    const issues = await this.server.getIssuesAssignedToMe();

    // Get config
    const config = vscode.workspace.getConfiguration('redmine.workingHours');
    const workingHoursConfig = {
      hoursPerDay: config.get<number>('hoursPerDay', 8),
      workingDays: config.get<string[]>('workingDays', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])
    };

    // Pre-calculate flexibility for ALL issues (NOT in getTreeItem)
    for (const issue of issues) {
      issue._cachedFlexibility = calculateFlexibility(issue, workingHoursConfig);
    }

    // Sort by risk (overbooked first)
    return issues.sort((a, b) => {
      if (a._cachedFlexibility.status !== b._cachedFlexibility.status) {
        const order = { overbooked: 0, 'at-risk': 1, 'on-track': 2 };
        return order[a._cachedFlexibility.status] - order[b._cachedFlexibility.status];
      }
      return a._cachedFlexibility.remaining - b._cachedFlexibility.remaining;
    });
  }

  getTreeItem(issue: Issue): vscode.TreeItem {
    const serverUrl = this.server.getUrl();

    // Use cached flexibility - NO API calls
    return enhanceIssueTreeItem(issue, issue._cachedFlexibility, serverUrl);
  }
}
```

#### Step 4: Add Context Menus (1h)

**File**: `package.json`

```json
"menus": {
  "view/item/context": [
    {
      "command": "redmine.openInBrowser",
      "when": "view == 'redmine-explorer-my-issues' && viewItem == 'issue-open'",
      "group": "navigation@1"
    },
    {
      "command": "redmine.quickLogTime",
      "when": "viewItem =~ /issue-(open|closed)/",
      "group": "redmine@1"
    },
    {
      "command": "redmine.copyIssueUrl",
      "when": "viewItem =~ /issue/",
      "group": "9_cutcopypaste@1"
    }
  ]
}
```

#### Step 5: Write Tests (2-3h)

**File**: `src/utilities/flexibility-calculator.test.ts`

```typescript
describe('calculateFlexibility', () => {
  it('calculates initial flexibility correctly', () => {
    // 10 day task, 80h available, 40h estimated = +100% initial
    // Assert: initial = 100
  });

  it('calculates remaining flexibility correctly', () => {
    // 5 days left, 40h available, 20h remaining = +100% remaining
    // Assert: remaining = 100
  });

  it('memoizes working days calculation', () => {
    // Call countWorkingDays 3x with same params
    // Assert: Only calculates once (cache hit)
  });
});
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| No due date | Skip flexibility, show "No deadline" |
| Completed issue | Show 100% flexibility, "Completed" status |
| Overdue | Show negative days, "Overdue" status |
| Config change | Clear cache, recalculate all |

### Files

**CREATE**:
- `src/utilities/flexibility-calculator.ts` (~150 LOC)
- `src/utilities/flexibility-calculator.test.ts` (~120 LOC)

**MODIFY**:
- `src/utilities/tree-item-factory.ts` (enhance with flexibility)
- `src/trees/my-issues-tree.ts` (pre-calculate, sort by risk)
- `package.json` (context menus)

### Success Criteria

- [ ] Flexibility scores accurate (initial + remaining)
- [ ] ThemeIcon shows risk level (error/warning/pass)
- [ ] Text alternatives for accessibility
- [ ] Pre-calculated in getChildren (no freeze)
- [ ] Memoization reduces calc time by 10×
- [ ] Config changes trigger recalculation
- [ ] Context menu works
- [ ] Tests pass (5+ scenarios)

**Estimated Effort**: 9-11 hours

---

## Phase 4: MVP-4 Workload Overview (2-3h)

### Overview

**Priority**: P1 - Capacity planning

**User Story**: As a consultant, I want to see total remaining work and available capacity to answer "Can I take on 8h more work?"

**Success Criteria**:
- Status bar shows remaining work + buffer
- Opt-in configuration (avoid noise)
- Tooltip shows top 3 urgent issues
- Event-driven updates (no polling)

### Implementation Steps

#### Step 1: Create Workload Calculator (1h)

**File**: `src/utilities/workload-calculator.ts` (~80 LOC)

```typescript
export interface WorkloadSummary {
  totalEstimated: number;
  totalSpent: number;
  remaining: number;
  availableThisWeek: number;
  buffer: number;
  topUrgent: Array<{
    id: number;
    subject: string;
    daysLeft: number;
    hoursLeft: number;
    status: string;
  }>;
}

export function calculateWorkload(
  issues: Issue[],
  config: WorkingHoursConfig
): WorkloadSummary {
  const today = new Date();
  const weekEnd = getWeekEnd();

  // Total across all issues
  const totalEstimated = issues.reduce((sum, i) => sum + i.estimated_hours, 0);
  const totalSpent = issues.reduce((sum, i) => sum + i.spent_hours, 0);
  const remaining = totalEstimated - totalSpent;

  // Available capacity this week
  const daysLeftThisWeek = countWorkingDays(today, weekEnd, config.workingDays);
  const availableThisWeek = daysLeftThisWeek * config.hoursPerDay;

  // Buffer
  const buffer = availableThisWeek - remaining;

  // Top 3 urgent (by due date, with hours left)
  const topUrgent = issues
    .filter(i => i.due_date && !i.status.is_closed)
    .map(i => ({
      id: i.id,
      subject: i.subject,
      daysLeft: countWorkingDays(today, new Date(i.due_date), config.workingDays),
      hoursLeft: Math.max(i.estimated_hours - i.spent_hours, 0),
      status: i.status.name
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, 3);

  return {
    totalEstimated,
    totalSpent,
    remaining,
    availableThisWeek,
    buffer,
    topUrgent
  };
}

function getWeekEnd(): Date {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diff = 5 - dayOfWeek;  // Friday
  return new Date(now.setDate(now.getDate() + diff));
}
```

#### Step 2: Create Status Bar Item (1h)

**File**: `src/extension.ts`

```typescript
let workloadStatusBar: vscode.StatusBarItem | undefined;

function initializeWorkloadStatusBar(
  context: vscode.ExtensionContext,
  issuesProvider: MyIssuesTreeDataProvider
) {
  const config = vscode.workspace.getConfiguration('redmine.statusBar');

  if (!config.get<boolean>('showWorkload', false)) {
    return;  // Opt-in only
  }

  workloadStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );

  // Update on config or tree changes
  updateWorkloadStatusBar(issuesProvider);

  vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('redmine')) {
      updateWorkloadStatusBar(issuesProvider);
    }
  });

  // Listen for tree refresh
  issuesProvider.onDidChangeTreeData(() => {
    updateWorkloadStatusBar(issuesProvider);
  });

  workloadStatusBar.command = 'redmine.showWorkloadDetails';
  workloadStatusBar.show();

  context.subscriptions.push(workloadStatusBar);
}

async function updateWorkloadStatusBar(issuesProvider: MyIssuesTreeDataProvider) {
  if (!workloadStatusBar) return;

  const issues = await issuesProvider.getIssues();
  const config = vscode.workspace.getConfiguration('redmine.workingHours');
  const workingHoursConfig = {
    hoursPerDay: config.get<number>('hoursPerDay', 8),
    workingDays: config.get<string[]>('workingDays', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])
  };

  const workload = calculateWorkload(issues, workingHoursConfig);

  // Text only (no icons)
  workloadStatusBar.text = `${workload.remaining}h left, ${workload.buffer >= 0 ? '+' : ''}${workload.buffer}h buffer`;

  // Rich tooltip
  workloadStatusBar.tooltip = new vscode.MarkdownString(`
**Workload Overview**

**Total estimated:** ${workload.totalEstimated}h
**Total spent:** ${workload.totalSpent}h
**Remaining work:** ${workload.remaining}h
**Available this week:** ${workload.availableThisWeek}h
**Capacity:** ${workload.buffer >= 0 ? '+' : ''}${workload.buffer}h buffer ${workload.buffer >= 0 ? '(On Track)' : '(Overbooked)'}

**Top 3 Urgent:**
${workload.topUrgent.map(i => `- #${i.id}: ${i.daysLeft}d left, ${i.hoursLeft}h remaining`).join('\n')}

[View Details](command:redmine.showWorkloadDetails)
  `);
}
```

#### Step 3: Add Configuration (15min)

**File**: `package.json`

```json
"configuration": {
  "properties": {
    "redmine.statusBar.showWorkload": {
      "type": "boolean",
      "default": false,
      "scope": "application",
      "markdownDescription": "Show workload overview in status bar\n\n**Note:** Opt-in to reduce noise. Enable if you need capacity planning at a glance."
    }
  }
}
```

#### Step 4: Write Tests (30min)

**File**: `src/utilities/workload-calculator.test.ts`

```typescript
describe('calculateWorkload', () => {
  it('calculates remaining work correctly', () => {
    // 3 issues: 10h est, 5h spent each = 15h remaining
    // Assert: remaining = 15
  });

  it('calculates buffer correctly', () => {
    // 5 days left, 8h/day = 40h available
    // 25h remaining = +15h buffer
    // Assert: buffer = 15
  });

  it('returns top 3 urgent issues', () => {
    // 5 issues with different due dates
    // Assert: Returns 3 soonest
  });
});
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| No issues | Hide status bar |
| Opt-out | Don't show status bar |
| Negative buffer | Show warning in tooltip |
| No due dates | Skip topUrgent list |

### Files

**CREATE**:
- `src/utilities/workload-calculator.ts` (~80 LOC)
- `src/utilities/workload-calculator.test.ts` (~60 LOC)

**MODIFY**:
- `src/extension.ts` (create status bar item, event listeners)
- `package.json` (configuration)

### Success Criteria

- [ ] Status bar shows remaining + buffer
- [ ] Text-only (no icons/emoji)
- [ ] Tooltip shows top 3 urgent
- [ ] Opt-in via configuration
- [ ] Event-driven updates (no polling)
- [ ] Tests pass (3 scenarios)

**Estimated Effort**: 2-3 hours

---

## Testing Strategy

### Pre-Implementation (TDD per CLAUDE.md)

Before implementing each MVP:
1. Review `docs/LESSONS_LEARNED.md`
2. Review `docs/ARCHITECTURE.md`
3. Review `CLAUDE.md`
4. Write tests FIRST (minimalist, ~3 E2E tests per MVP)

### Test Types

#### Unit Tests (~6-8h total)

**Flexibility Calculator**:
- Initial flexibility formula
- Remaining flexibility formula
- Memoization cache hits
- Edge cases (no due date, overdue, completed)

**Workload Calculator**:
- Remaining work aggregation
- Buffer calculation
- Top 3 urgent sorting

**Tree Data Providers**:
- Pre-calculation in getChildren
- Caching at parent level
- Loading states

**Commands**:
- Recent issue caching
- Input validation
- globalState updates

#### Integration Tests (~2h)

- End-to-end time logging flow
- Tree refresh triggers
- Config changes propagate
- Status bar updates

#### Accessibility Tests (~1h)

- Screen reader announces text status (not "green circle")
- High-contrast theme shows icon differentiation
- Color-blind mode distinguishes risk levels
- Keyboard navigation works

#### Performance Tests (~1h)

- Tree refresh <500ms for 100 issues
- No UI freeze during calculation
- Memoization reduces calc time by 10×

### Test Execution

**After each implementation**:
```bash
npm test                    # Run all tests
npm run test:coverage       # Check coverage (aim for >80%)
```

**Manual testing checklist**:
- [ ] Test in all 4 themes (Light, Dark, High Contrast Light, High Contrast Dark)
- [ ] Test with screen reader (NVDA/JAWS/VoiceOver)
- [ ] Test keybindings in all contexts (editor, terminal, debug)
- [ ] Test with slow network (throttle to 3G)
- [ ] Test with 100+ issues (performance)

---

## Effort Estimates & Timeline

### By Phase

| Phase | MVP | Effort | Days |
|-------|-----|--------|------|
| **1** | MVP-3: Quick Time Logging | 3-4h | 0.5d |
| **2** | MVP-2: Time Entry Viewing | 5-7h | 1d |
| **3** | MVP-1: Timeline & Progress | 9-11h | 1.5d |
| **4** | MVP-4: Workload Overview | 2-3h | 0.5d |

**Implementation Subtotal**: 19-25h (2.5-3 days)

### Supporting Tasks

| Task | Effort |
|------|--------|
| Testing (unit + integration + accessibility) | 6-8h |
| Documentation updates | 3-4h |
| UX polishing (context menus, settings, notifications) | 1-3h |

**Supporting Subtotal**: 10-15h (1-2 days)

### Grand Total

**26-40 hours (3-5 days)**

**Breakdown**:
- P0 Features (MVP-1+2): 14-18h
- P1 Features (MVP-3+4): 5-7h
- Testing: 6-8h
- Documentation: 3-4h
- UX polishing: 1-3h

### Optimization Overhead (Integrated Above)

- Performance: +1.5h (memoization, caching, picker, event-driven, partial refresh)
- UX Compliance (1st pass): +3h (ThemeIcon, loading states, welcome views, configuration)
- UX Compliance (2nd pass): +1-3h (context menus, settings, notifications, quick pick titles)

**Total overhead**: ~5.5-8 hours

### Risk Buffer

**Contingency**: +20% for unexpected issues
**Adjusted Total**: 31-48h (4-6 days)

**Common risks**:
- API endpoint changes
- VSCode API deprecations
- Test failures requiring debugging
- Performance issues requiring optimization

---

## Configuration

### Settings Schema

```json
{
  "redmine.workinghours.hoursperday": {
    "type": "number",
    "default": 8,
    "minimum": 1,
    "maximum": 16,
    "scope": "application",
    "order": 10,
    "markdownDescription": "**Daily working hours** for deadline calculations\n\nUsed with `#redmine.workinghours.workingdays#` to compute available time.\n\n**Common values:** 6, 7.5, 8, 10"
  },
  "redmine.workinghours.workingdays": {
    "type": "array",
    "items": {
      "enum": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    },
    "default": ["Mon", "Tue", "Wed", "Thu", "Fri"],
    "minItems": 1,
    "maxItems": 7,
    "uniqueItems": true,
    "scope": "application",
    "order": 11,
    "markdownDescription": "**Working days** for deadline calculations\n\nUsed with `#redmine.workinghours.hoursperday#` to count available time."
  },
  "redmine.statusBar.showWorkload": {
    "type": "boolean",
    "default": false,
    "scope": "application",
    "order": 20,
    "markdownDescription": "Show workload overview in status bar\n\n**Note:** Opt-in to reduce noise. Enable if you need capacity planning at a glance."
  }
}
```

---

## Versioning

### Semantic Versioning

**Current**: v3.1.x

**Release Plan**:
- **v3.2.0-alpha**: MVP-3 (Quick Time Logging)
- **v3.2.0-beta**: MVP-2 (Time Entry Viewing)
- **v3.2.0**: MVP-1 (Timeline & Progress) - **P0 COMPLETE**
- **v3.3.0**: MVP-4 (Workload Overview) - **Full Suite**

### Changelog Template

```markdown
## [3.3.0] - 2025-MM-DD

### Added
- MVP-1: Timeline & Progress Display with dual flexibility scores
- MVP-2: Time Entry Viewing tree with Today/Week/Month groups
- MVP-3: Quick Time Logging with Ctrl+K Ctrl+L keybinding
- MVP-4: Workload Overview status bar item
- Context menus for tree items (open, log time, copy URL)
- Loading states for async tree views
- Welcome views for first-time setup

### Changed
- Keybinding changed from Ctrl+K Ctrl+T to Ctrl+K Ctrl+L (avoid conflict)
- Status bar text-only (removed emoji)
- Simplified issue descriptions for better readability
- Pre-calculation of flexibility in getChildren (10× faster)

### Fixed
- Lazy calculation causing UI freeze (200+ API calls per refresh)
- Double-fetching in time entries tree (50% fewer API calls)
- Config validation for working days (prevent empty array)
- Accessibility violations (WCAG 2.1 compliance)

### Performance
- Memoization reduces working days calc from O(n²) to O(n)
- Caching eliminates 50% of API calls
- Event-driven updates (zero polling overhead)
```

---

## Next Steps

### Immediate Actions

1. ✅ Review this consolidated plan
2. ✅ Review `docs/LESSONS_LEARNED.md` for insights
3. ✅ Review `docs/ARCHITECTURE.md` for patterns
4. ⏭️ **Start MVP-3 implementation** ⭐
5. ⏭️ Write tests FIRST (TDD per CLAUDE.md)
6. ⏭️ Commit often with concise messages

### Implementation Sequence

**Week 1** (3-4 days):
- Day 1: MVP-3 (3-4h) + tests
- Day 2: MVP-2 (5-7h) + tests
- Day 3-4: MVP-1 (9-11h) + tests

**Week 2** (1 day):
- Day 5: MVP-4 (2-3h) + final testing + docs

### Post-Implementation

1. Update `docs/LESSONS_LEARNED.md` with new insights
2. Update `docs/ARCHITECTURE.md` with new patterns
3. Update `CLAUDE.md` with new guidelines
4. Create changelog entry
5. Update version number
6. Tag release
7. Deploy to marketplace

---

## References

### Internal Documentation
- `docs/MVP_DECISIONS.md` - MVP structure and priorities
- `docs/MVP_VALIDATION_FINDINGS.md` - Critical fixes
- `docs/MVP_UX_GUIDELINES_COMPLIANCE.md` - First pass UX
- `docs/MVP_UX_SECOND_PASS_FINDINGS.md` - Second pass UX
- `docs/LESSONS_LEARNED.md` - Implementation insights
- `docs/ARCHITECTURE.md` - Technical patterns
- `CLAUDE.md` - Development guidelines

### External References
- [VSCode Extension API](https://code.visualstudio.com/api/references/vscode-api)
- [VSCode UX Guidelines](https://code.visualstudio.com/api/ux-guidelines/overview)
- [TreeView API](https://code.visualstudio.com/api/extension-guides/tree-view)
- [Status Bar API](https://code.visualstudio.com/api/extension-guides/status-bar)
- [Redmine REST API](https://www.redmine.org/projects/redmine/wiki/Rest_api)

---

**Document Status**: Ready for implementation
**Last Updated**: 2025-11-24
**Validation Status**: ✅ All critical issues resolved (A grade, 91/100)
