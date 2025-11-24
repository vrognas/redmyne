# MVP Implementation Plan

**Date**: 2025-11-23
**Context**: Solving consultant workflow gaps identified in PROBLEM_SOLUTION_FIT_ASSESSMENT.md
**Approach**: Four focused MVPs addressing P0 (critical) and P1 (high value) gaps

---

## MVP Overview

| MVP | Priority | Value | Complexity | API Changes |
|-----|----------|-------|------------|-------------|
| **MVP-1: Timeline & Progress Display** | P0 | HIGH | MEDIUM | None (uses existing fields) |
| **MVP-2: Time Entry Viewing** | P0 | HIGH | MEDIUM | New endpoint |
| **MVP-3: Quick Time Logging** | P1 | MEDIUM | LOW | None (uses existing) |

---

## VSCode API Patterns (Ultrathink Analysis)

**Date**: 2025-11-24
**Source**: Deep analysis of VSCode extension capabilities

### Key Decisions

**ALL MVPs use native VSCode UI** - no webviews needed.

| MVP | VSCode Component | Pattern | Complexity |
|-----|------------------|---------|------------|
| **MVP-1** | TreeItem description + tooltip | `description` field + `MarkdownString` | LOW |
| **MVP-2** | New tree view | Two-level hierarchy (collapsible groups) | MEDIUM |
| **MVP-3** | QuickPick + InputBox | Native pickers + globalState cache | LOW |
| **MVP-4** | Tree view (NOT webview) | Summary metrics + urgent issues | MEDIUM |

### Critical Findings

**1. TreeItem Capabilities**
- `description`: Secondary text (reduced opacity) - PERFECT for "3.5/8h 2d +60% 🟢"
- `tooltip`: MarkdownString for rich formatting (bold, lists, line breaks)
- `iconPath`: Emoji in description simpler than custom icons
- `command`: Pass context data to click handlers

**2. Webview NOT Needed**
- VSCode docs: "Use sparingly, only when native API inadequate"
- Tree views handle all MVP requirements
- Webview = 2-3x complexity + security overhead (CSP, sanitization)
- MVP-4: Tree view 120 LOC vs webview 200-300 LOC

**3. Storage Strategy**
- `globalState`: Recent issues cache (syncs across machines via Settings Sync)
- `workspaceState`: Project-specific data
- `secrets`: API keys (already implemented)

**4. Performance Patterns**
- **Lazy calculation**: Compute flexibility in `getTreeItem()` (on-demand)
- **Pre-calculate totals**: MVP-2 date groups fetch totals upfront to avoid parent label update issues
- **Collapsible state**: Today=Expanded, Week=Collapsed
- **Refresh optimization**: Calculate on-demand, no debouncing needed (<100 items)

**5. Anti-Patterns to Avoid**
- ❌ Don't use webviews for simple data display
- ❌ Don't activate on `"*"` - use specific activation events
- ❌ Don't block UI with sync operations - use `withProgress`
- ❌ Don't store large data in globalState (2KB limit) - use file storage

### MVP-Specific Patterns

#### MVP-1: TreeItem Enhancement
```typescript
// File: src/utilities/tree-item-factory.ts
treeItem.description = `3.5/8h 2d +100%→+60% 🟢  #${issue.id}`;

// Rich tooltip
treeItem.tooltip = new vscode.MarkdownString(`
**Issue #${issue.id}: ${issue.subject}**

**Progress:** 3.5h / 8h (44%)

**Initial Plan:** +100% flexibility
**Current Status:** +60% flexibility
`);
```

**Key**: Emoji in description (🟢🟡🔴) simpler than ThemeIcon.

#### MVP-2: Dynamic Parent Labels
**Problem**: VSCode doesn't support updating parent label after children fetch.

**Solution**: Pre-calculate totals in root `getChildren()` call.

```typescript
async getChildren(element?: TreeItem): Promise<TreeItem[]> {
  if (!element) {
    // Fetch totals upfront
    const todayTotal = await this.fetchTotal(today(), today());
    return [
      { label: 'Today', total: todayTotal, from: today(), to: today() }
    ];
  }

  // Return cached/re-fetched entries
  return await this.server.getTimeEntries({ from: element.from, to: element.to });
}

getTreeItem(element: TreeItem): vscode.TreeItem {
  return new vscode.TreeItem(
    `📅 ${element.label} (${element.total}h)`,  // Total already known
    element.label === 'Today'
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed
  );
}
```

#### MVP-3: Quick Logging
```typescript
// Command with globalState cache
const recent = context.globalState.get<RecentTimeLog>('lastTimeLog');

const issueChoice = await vscode.window.showQuickPick([
  { label: `$(clock) Log to #${recent.issueId}: ${recent.subject}`, value: 'recent' },
  { label: '$(search) Choose different issue', value: 'new' }
]);

const input = await vscode.window.showInputBox({
  prompt: `Log time to #${issueId}`,
  placeHolder: '2.5|Implemented login',
  validateInput: (val) => /^\d+\.?\d*\|.*$/.test(val) ? null : 'Format: hours|comment'
});

// Save recent
context.globalState.update('lastTimeLog', { issueId, lastLogged: new Date() });
```

**Keybinding**: Chord pattern `Ctrl+K Ctrl+L` (VSCode convention, L for "Log")
- ⚠️ CRITICAL: `Ctrl+K Ctrl+T` conflicts with VSCode's Color Theme picker (default since 2016)
- Changed to `Ctrl+K Ctrl+L` - unassigned in default VSCode, mnemonic for **L**og time

#### MVP-4: Status Bar Item (Not Tree View or Webview)
```typescript
// Status bar (always visible, minimal code)
const statusBar = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Right,
  100
);
statusBar.text = "$(pulse) 25h left, +7h 🟢";
statusBar.tooltip = new vscode.MarkdownString(`
**Workload Overview**

Total estimated: 48h
Total spent: 23h
Remaining work: 25h
Available this week: 32h
Capacity: +7h buffer 🟢

**Top 3 Urgent:**
- #123: DUE TODAY, 8h left 🔴
- #456: 2d left, 5h left 🟡
- #789: 7d left, 12h left 🟢
`);
statusBar.command = "redmine.showWorkloadDetails";
statusBar.show();
```

**Pattern**: Status bar item (~20 LOC) vs tree view (~120 LOC).

**Why status bar > tree view**:
- Always visible (no view switching)
- 6× simpler implementation
- Tooltip provides full details
- Command opens QuickPick for interaction

**Tree view rejected**: Not truly hierarchical data, poor copy/paste UX
**Webview rejected**: Overkill for MVP, defer to v4.0 if charts needed

### Partial Tree Refresh Pattern (All MVPs)

**⚡ Performance**: Refresh only changed nodes, not entire tree

```typescript
class MyIssuesTree implements vscode.TreeDataProvider<Issue> {
  private _onDidChangeTreeData = new vscode.EventEmitter<Issue | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Partial refresh: only specified node
  refresh(issue?: Issue) {
    if (issue) {
      // Only refreshes this specific issue node
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

// vs BAD (full refresh):
myIssuesTree.refresh(); // Re-fetches ALL issues
```

**Impact**: 99% fewer API calls for single issue updates

**Pattern**: Already implemented in `ProjectsTree`, apply to all tree views

---

### Configuration Patterns
```typescript
// package.json
"redmine.workingHours.hoursPerDay": {
  "type": "number",
  "default": 8,
  "minimum": 1,
  "maximum": 24,
  "description": "Working hours per day for flexibility calculation"
}

// Read with change listener
const config = vscode.workspace.getConfiguration('redmine.workingHours');
vscode.workspace.onDidChangeConfiguration(e => {
  if (e.affectsConfiguration('redmine.workingHours')) {
    this.refresh();
  }
});
```

### Files to Create/Modify

**MVP-1** (6-8h):
- CREATE: `src/utilities/flexibility-calculator.ts` (~100 LOC)
- MODIFY: `src/utilities/tree-item-factory.ts` (description + tooltip)
- MODIFY: `src/trees/my-issues-tree.ts` (pass config)

**MVP-2** (4-6h):
- CREATE: `src/trees/my-time-entries-tree.ts` (~200 LOC)
- MODIFY: `src/extension.ts` (register tree view)
- MODIFY: `package.json` (view contribution)

**MVP-3** (3-4h):
- CREATE: `src/commands/quick-log-time.ts` (~150 LOC)
- MODIFY: `src/extension.ts` (register command + pass context)
- MODIFY: `package.json` (command + keybinding)

**MVP-4** (1-2h):
- MODIFY: `src/extension.ts` (create status bar item ~20 LOC)
- CREATE: `src/commands/show-workload-details.ts` (~50 LOC for QuickPick details)
- MODIFY: `package.json` (command only, NO view contribution)

**Total implementation**: 16-22h (optimized from original 17-24h)

---

## MVP-1: Timeline & Progress Display

### Problem
Cannot see planning quality or current deadline risk. No visibility into progress or remaining work.

### Solution
Calculate TWO flexibility scores: **initial** (planning quality - static) and **remaining** (current risk - dynamic). Merges spent/estimated hours display with dual flexibility calculation to show both "how well was this planned?" and "can I finish on time given current progress?"

**Merged**: Combines original MVP-1 (Flexibility) + MVP-2 (Spent Hours) into single integrated feature.

### Redmine API Reference

**NO API changes required** - uses existing Issue fields:
```json
{
  "issue": {
    "id": 123,
    "due_date": "2025-11-26",           // ✅ Already fetched
    "start_date": "2025-11-20",         // ✅ Already fetched
    "estimated_hours": 16.0,            // ✅ Issue only
    "spent_hours": 3.5,                 // ✅ Issue only
    "total_estimated_hours": 20.0,      // ✅ Includes subtasks (Redmine 3.3+)
    "total_spent_hours": 4.5,           // ✅ Includes subtasks (Redmine 3.3+)
    "created_on": "2025-11-18",         // ✅ Fallback if no start_date
    "status": { "id": 1, "name": "New", "is_closed": false },  // ✅ For filtering
    "fixed_version": { "id": 3, "name": "v2.1" }  // 💡 OPTIONAL: Version/milestone context
  }
}
```

**💡 OPTIONAL ENHANCEMENT**: `fixed_version` field available on all issues
- Provides version/milestone context at no extra API cost
- Can display version name alongside timeline (e.g., "Fix auth bug [v2.1] | 3.5/8h...")
- No extra API calls needed - already in response
- Consider for UI polish phase

**CRITICAL DISTINCTIONS** (from API analysis):
- **`spent_hours`**: Time logged on THIS issue only (excludes subtasks)
- **`total_spent_hours`**: Time on issue + all subtasks (Redmine 3.3+)
- **Use `total_spent_hours`** for accurate progress tracking

**VERSION REQUIREMENTS** (⚠️ CRITICAL):
- **Show endpoint** (`GET /issues/123.json`): Includes total_* fields in Redmine 3.3+ ✓
- **List endpoint** (`GET /issues.json`): Requires **Redmine 5.0.0+** for total_* fields ([#34857](https://www.redmine.org/issues/34857))
- **Pre-5.0.0 workaround**: Fetch individual issues or sum time_entries manually
- **Recommended minimum**: Redmine 5.0.0 for full MVP-1 support

**GROUP ASSIGNMENTS** (affects "assigned to me" filtering):
- Issues assigned to groups appear in "assigned to me" for group members
- Use `assigned_to_id=me` to include both direct + group assignments
- **⚠️ Prerequisite**: Admin must enable "Allow issue assignment to groups" in Settings → Issue Tracking

**CLOSED ISSUES** (critical for workload):
- Use `status.is_closed` flag to exclude from capacity calculations
- Fetch statuses: `GET /issue_statuses.json` (cached)

Source: [Rest Issues API](https://www.redmine.org/projects/redmine/wiki/Rest_Issues), [Feature #21757](https://www.redmine.org/issues/21757)

### Dual Flexibility Formula

**1. Initial Flexibility (Planning Quality - Static)**
```typescript
initial_flexibility = (available_time_total / total_estimated_hours - 1) * 100

where:
  available_time_total = working_days_total * hours_per_day
  working_days_total = count_working_days(start_date, due_date, working_days_config)
  total_estimated_hours = issue.total_estimated_hours || issue.estimated_hours || 0
```

Shows: How well was this issue planned? Did we build in enough buffer?

**2. Remaining Flexibility (Current Risk - Dynamic)**
```typescript
remaining_flexibility = (available_time_remaining / work_remaining - 1) * 100

where:
  available_time_remaining = working_days_remaining * hours_per_day
  working_days_remaining = count_working_days(TODAY, due_date, working_days_config)
  work_remaining = max(total_estimated_hours - total_spent_hours, 0)
  total_estimated_hours = issue.total_estimated_hours || issue.estimated_hours || 0
  total_spent_hours = issue.total_spent_hours || issue.spent_hours || 0
```

Shows: Can I finish on time given current progress? What's the risk TODAY?

**Interpretation**:
- **0%** = No buffer (perfectly tight)
- **+60%** = 60% extra time (comfortable)
- **-20%** = Need 20% more time (overbooked)

**Example**:
```
Issue planned with 5 working days (40h), 16h estimated:
  Initial: (40h / 16h - 1) = +150% (planned with 2.5× time needed)

Today (3 days elapsed), 8h spent, 2 days left (16h):
  Remaining: (16h / 8h - 1) = +100% (still 2× time for remaining work)

Conclusion: Well-planned (+150%) and on track (+100%) ✅
```

### Configuration

**New settings** (package.json contributions):
```jsonc
{
  "redmine.workingHours.hoursPerDay": {
    "type": "number",
    "default": 8,
    "minimum": 1,
    "maximum": 16,              // ⚠️ FIXED: Was 24 (unrealistic), now 16
    "description": "Working hours per day for flexibility calculation"
  },
  "redmine.workingHours.workingDays": {
    "type": "array",
    "items": {
      "type": "string",
      "enum": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    },
    "default": ["Mon", "Tue", "Wed", "Thu", "Fri"],
    "minItems": 1,              // ⚠️ ADDED: Prevent empty array (breaks calculations)
    "maxItems": 7,              // ⚠️ ADDED: Max 7 days in week
    "uniqueItems": true,        // ⚠️ ADDED: No duplicate days
    "description": "Working days of the week (excludes weekends/off-days)"
  },
  "redmine.timeline.enabled": {
    "type": "boolean",
    "default": true,
    "description": "Show flexibility score and timeline indicators"
  }
}
```

**Consultant config example**:
```json
{
  "redmine.workingHours.hoursPerDay": 8,
  "redmine.workingHours.workingDays": ["Mon", "Tue", "Wed", "Thu"]
}
```

### UI Design

**Current display:**
```
Fix authentication bug                 #123
```

**New display:**
```
Fix auth bug              3.5/8h 2d +100%→+60% 🟢  #123
Add reporting             0/16h 7d +150%→+150% 🟢  #456
Database optimization     8/4h! 1d 0%→-50% 🔴     #789
Client docs                                       #999  (no estimate)
```

**Format**: `{spent}/{est}h {days}d {initial}%→{remaining}% {icon}`

**Components**:
- `3.5/8h` = spent/estimated hours
- `2d` = working days remaining
- `+100%→+60%` = initial → remaining flexibility
- `🟢` = risk icon (based on remaining flexibility)
- `!` = over-budget indicator (if spent > estimated)

**Tooltip on hover:**
```
Issue #123: Fix auth bug
────────────────────────────────
Progress: 3.5h spent / 8h estimated (44% complete)

Initial Plan:
  Timeline: Mon Nov 20 → Fri Nov 24 (5 calendar days)
  Working days: 4 (Mon, Tue, Wed, Thu)
  Available: 32h (4 days × 8h/day)
  Flexibility: +100% (2× effective time) 🟢

Current Status (as of Wed Nov 22):
  Days remaining: 2 working days (16h available)
  Work remaining: 4.5h (8h - 3.5h)
  Flexibility: +256% (3.5× time for remaining work) 🟢

Assessment: Well-planned, ahead of schedule ✅
```

### Risk Levels (Based on Remaining Flexibility)

```typescript
remaining_flexibility < 0%   → 🔴 OVERBOOKED (impossible - need more time than available)
remaining_flexibility = 0%   → 🔴 CRITICAL (no buffer - need every working minute)
remaining_flexibility < 20%  → 🟡 TIGHT (minimal buffer - little room for error)
remaining_flexibility < 50%  → 🟡 LIMITED (some buffer - manageable)
remaining_flexibility >= 50% → 🟢 COMFORTABLE (healthy buffer)
```

**Color coding examples**:
```
8/4h! 1d 0%→-50% 🔴      (over budget, need 50% more time)
6/8h 1d +100%→+0% 🔴     (planned well but fell behind)
3/8h 2d +100%→+15% 🟡    (planned well, slightly behind)
2/8h 3d +150%→+200% 🟢   (planned conservatively, ahead)
```

**Note**: Risk uses **remaining flexibility** (dynamic) to reflect current status, not initial (static).

### Working Days Calculation

```typescript
function countWorkingDays(
  start: Date,
  end: Date,
  workingDays: string[]  // ["Mon", "Tue", "Wed", "Thu"]
): number {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let count = 0;
  const current = new Date(start);

  while (current <= end) {
    const dayName = dayNames[current.getDay()];
    if (workingDays.includes(dayName)) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }

  return count;
}

// Example: Mon Nov 20 → Sun Nov 26, working ["Mon","Tue","Wed","Thu"]
// Counts: Mon(20)✓, Tue(21)✓, Wed(22)✓, Thu(23)✓, Fri(24)✗, Sat(25)✗, Sun(26)✗
// Result: 4 working days
```

### Implementation Plan

1. **Add configuration types**: `/src/definitions/redmine-config.ts`
   ```typescript
   export interface WorkingHoursConfig {
     hoursPerDay: number;
     workingDays: string[];
   }
   ```

2. **Add helpers**: `/src/utilities/flexibility-calculator.ts` (new file)
   ```typescript
   export function countWorkingDays(start: Date, end: Date, workingDays: string[]): number
   export function calculateFlexibility(issue: Issue, config: WorkingHoursConfig): FlexibilityScore | null
   export interface FlexibilityScore {
     flexibility: number;      // Percentage (-20, 0, 60, 150, etc.)
     available: number;        // Available hours
     estimated: number;        // Estimated hours
     workingDays: number;      // Working days count
     level: 'overbooked' | 'tight' | 'limited' | 'some' | 'comfortable';
   }
   ```

   **⚡ Performance**: Memoize `countWorkingDays()` with Map cache
   ```typescript
   const workingDaysCache = new Map<string, number>();

   function countWorkingDays(start: Date, end: Date, workingDays: string[]): number {
     const key = `${start.toISOString()}_${end.toISOString()}_${workingDays.join(',')}`;
     if (workingDaysCache.has(key)) return workingDaysCache.get(key)!;

     const count = calculateWorkingDays(start, end, workingDays);
     workingDaysCache.set(key, count);
     return count;
   }
   ```
   **Impact**: O(n²) → O(n), ~10× faster for 100 issues with duplicate date ranges

3. **Modify**: `/src/utilities/tree-item-factory.ts` (VSCode TreeItem pattern)
   - Accept `WorkingHoursConfig` parameter
   - Call `calculateFlexibility(issue, config)`
   - **VSCode API**: Set `treeItem.description = "3.5/8h 2d +100%→+60% 🟢  #123"`
   - **VSCode API**: Use emoji in description for risk icons (🟢🟡🔴) - simpler than ThemeIcon
   - **VSCode API**: Set `treeItem.tooltip = new vscode.MarkdownString()` for rich formatting
   - Tooltip: Multi-line with progress, initial plan, current status (see VSCode API Patterns section)

4. **Update tree providers**: `/src/trees/my-issues-tree.ts`, `/src/trees/projects-tree.ts`
   - **VSCode API**: Read config: `vscode.workspace.getConfiguration('redmine.workingHours')`
   - **VSCode API**: Listen for changes: `onDidChangeConfiguration()` → refresh tree
   - **⚠️ CRITICAL FIX**: Pre-calculate flexibility in `getChildren()`, NOT `getTreeItem()`
   - **Performance**: Lazy calc in `getTreeItem()` causes 200+ API calls per refresh (freezes UI)
   ```typescript
   // CORRECT pattern:
   async getChildren() {
     const issues = await this.server.getIssuesAssignedToMe();

     // Calculate ONCE during fetch
     for (const issue of issues) {
       issue._cachedFlexibility = await this.calculateFlexibility(issue, config);
     }

     return issues;
   }

   getTreeItem(issue) {
     // Use cached value - no API calls
     treeItem.description = `${issue._cachedFlexibility}`;
   }
   ```

5. **Add to package.json**: Configuration schema (see Configuration section above)

6. **Write tests**: `/test/unit/utilities/flexibility-calculator.test.ts` (new file)
   - Test 1: Count working days (exclude weekends)
   - Test 2: Positive flexibility (+60%)
   - Test 3: Zero flexibility (0%)
   - Test 4: Negative flexibility (-20%)
   - Test 5: No due_date/estimated_hours → null
   - Test 6: Risk level assignment

7. **Update tree-item-factory tests**: `/test/unit/utilities/tree-item-factory.test.ts`
   - Test flexibility display formatting
   - Test icon selection
   - Test tooltip content

8. **Update docs**:
   - CHANGELOG.md: "feat: flexibility score and timeline indicators"
   - README.md: Add configuration section + screenshots
   - Bump version: 3.2.0 (minor)

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| No due_date | No indicator (preserve current display) |
| No estimated_hours | No indicator (can't calculate) |
| No start_date | Use created_on as fallback |
| Zero working days | Display "🔴 -100%" (weekend-only timeline) |
| Invalid date | No indicator (fail gracefully) |
| estimated_hours = 0 | Invalid data, skip (instantaneous work impossible) |

### Out of Scope (Future v2+)

- Progress tracking with spent_hours (separate feature)
- Configurable risk thresholds
- Sorting by flexibility/urgency
- Remaining flexibility (current vs initial)
- Target flexibility comparison

### Estimated Effort
- Configuration: ~20 LOC
- Issue model update: ~5 LOC
- Flexibility calculator (dual formula): ~100 LOC
- Tree item integration: ~60 LOC
- Tests: ~180 LOC
- Total: **6-8 hours**

---

## MVP-2: Time Entry Viewing

### Problem
Cannot verify logged time entries for billing accuracy. Must open browser to generate timesheets.

### Solution
New tree view "My Time Entries" showing logged time grouped by date with totals.

### Redmine API Reference

**New endpoint**: `GET /time_entries.json`

**CRITICAL FINDINGS** (from API analysis):
- **No server-side grouping**: Time entries returned as flat list
- **Must group client-side**: By date, project, or activity
- **Pagination**: Default 25/request, max 100 (configurable by admin)

**⚠️ user_id=me UNCERTAINTY** (UNDOCUMENTED):
- **Status**: Not officially documented, mixed evidence
- **Implementation approach**: Try `user_id=me` first
- **Conflicting reports**:
  - Feature #12763: One failure report (may be auth issue)
  - Issues API: `assigned_to_id=me` works reliably
  - No confirmed working examples found for time entries
- **Fallback strategy**: If fails, fetch user ID via `/users/current.json` and use numeric ID
- **Risk**: May work in some Redmine versions but not others

**Query parameters** (try this first):
```
GET /time_entries.json?user_id=me&from=2025-11-20&to=2025-11-23&limit=100
```

**Supported filters**:
- `user_id` - Filter by user (try "me", fallback to numeric ID if fails)
- `from` - Date range start (YYYY-MM-DD)
- `to` - Date range end (YYYY-MM-DD)
- `spent_on` - Specific date (YYYY-MM-DD)
- `project_id` - Filter by project
- `issue_id` - Filter by issue
- `limit` - Results per page (default: 25, max: 100)
- `offset` - Pagination offset

**Response**:
```json
{
  "time_entries": [
    {
      "id": 123,
      "project": { "id": 73, "name": "Project Alpha" },
      "issue": { "id": 5488 },
      "user": { "id": 5, "name": "John Smith" },
      "activity": { "id": 8, "name": "Development" },
      "hours": 3.5,
      "comments": "Implemented login feature",
      "spent_on": "2025-11-23",
      "created_on": "2025-11-23T15:30:00Z",
      "updated_on": "2025-11-23T15:30:00Z"
    }
  ],
  "total_count": 42,
  "limit": 100,
  "offset": 0
}
```

Source: [Rest TimeEntries](https://www.redmine.org/projects/redmine/wiki/Rest_TimeEntries), [Feature #13275](https://www.redmine.org/issues/13275)

### UI Design

**New tree view**: "My Time Entries" (third view in redmine-explorer)

**Hierarchy**:
```
┬ 📅 Today (8.5h)                              [expanded by default]
├─ #123 Development 4.0h "Implemented login"   [Project Alpha]
├─ #456 Testing 2.5h "QA review"               [Project Beta]
└─ #789 Development 2.0h "Bug fixes"           [Project Alpha]

┬ 📅 This Week (24.5h)                         [collapsed by default]
├─ Mon Nov 20 (7.0h)
├─ Tue Nov 21 (8.5h)
└─ Wed Nov 22 (9.0h)
```

**Tree item formats**:

Date group (parent):
- Label: `📅 {period} ({total}h)`
- Collapsible state: Today = expanded, Week = collapsed

Time entry (child):
- Label: `#{issue_id} {activity} {hours}h "{comments}"`
- Description: `{project_name}`
- Click: Opens issue actions menu
- Tooltip: `Logged on {spent_on} at {created_on}`

### Implementation Plan

1. **Update Model**: `/src/redmine/models/time-entry.ts`
   ```typescript
   export interface TimeEntry {
     id: number;
     project: NamedEntity;
     issue: { id: number };        // Note: issue is minimal object
     user: NamedEntity;
     activity: NamedEntity;
     hours: number;
     comments: string;
     spent_on: string;             // Date string YYYY-MM-DD
     created_on: string;           // Timestamp
     updated_on: string;           // Timestamp
   }

   export interface TimeEntriesResponse {
     time_entries: TimeEntry[];
     total_count: number;
     limit: number;
     offset: number;
   }
   ```

2. **Add API Method**: `/src/redmine/redmine-server.ts`
   ```typescript
   async getTimeEntries(filters: {
     userId?: string | number;
     from?: string;
     to?: string;
     spentOn?: string;
     projectId?: number;
     issueId?: number;
     limit?: number;
   }): Promise<TimeEntriesResponse> {
     const params = new URLSearchParams();
     if (filters.userId) params.set('user_id', String(filters.userId));
     if (filters.from) params.set('from', filters.from);
     if (filters.to) params.set('to', filters.to);
     if (filters.spentOn) params.set('spent_on', filters.spentOn);
     if (filters.projectId) params.set('project_id', String(filters.projectId));
     if (filters.issueId) params.set('issue_id', String(filters.issueId));
     params.set('limit', String(filters.limit || 100));

     return this.doRequest<TimeEntriesResponse>(
       `/time_entries.json?${params.toString()}`,
       'GET'
     );
   }
   ```

3. **Create Tree Provider**: `/src/trees/my-time-entries-tree.ts` (VSCode TreeView pattern)
   ```typescript
   type TreeItem = DateGroup | TimeEntry | LoadingPlaceholder;

   interface DateGroup {
     label: string;      // "Today", "This Week"
     from: string;       // YYYY-MM-DD
     to: string;         // YYYY-MM-DD
     total: number;      // ⚠️ CRITICAL: Pre-calculated (see VSCode API Patterns)
     _cachedEntries?: TimeEntry[];  // ⚡ Performance: Cache to avoid double-fetching
   }

   export class MyTimeEntriesTree implements vscode.TreeDataProvider<TreeItem> {
     async getChildren(element?: TreeItem): Promise<TreeItem[]> {
       if (!element) {
         // ⚠️ CRITICAL VSCode pattern: Pre-calculate totals upfront
         // VSCode doesn't support updating parent labels after children fetch

         // ⚡ Performance: Fetch once, cache on parent node to avoid double-fetching
         const todayEntries = await this.server.getTimeEntries({
           userId: 'me',
           from: today(),
           to: today(),
           limit: 100
         });
         const todayTotal = todayEntries.time_entries.reduce((sum, e) => sum + e.hours, 0);

         const weekEntries = await this.server.getTimeEntries({
           userId: 'me',
           from: weekAgo(),
           to: today(),
           limit: 100
         });
         const weekTotal = weekEntries.time_entries.reduce((sum, e) => sum + e.hours, 0);

         return [
           {
             label: 'Today',
             from: today(),
             to: today(),
             total: todayTotal,
             _cachedEntries: todayEntries.time_entries  // Cache entries
           },
           {
             label: 'This Week',
             from: weekAgo(),
             to: today(),
             total: weekTotal,
             _cachedEntries: weekEntries.time_entries  // Cache entries
           }
         ];
       }

       if (element instanceof DateGroup) {
         // Return cached entries (no re-fetch)
         return element._cachedEntries || [];
       }
     }

     getTreeItem(element: TreeItem): vscode.TreeItem {
       if (element instanceof DateGroup) {
         return {
           label: `📅 ${element.label} (${element.total}h)`,  // Total already known
           collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,  // ⚠️ Start collapsed (avoid VSCode bug #127711)
           id: element.label.toLowerCase().replace(/\s+/g, '-')  // Stable ID for state persistence
         };
       }

       if (element instanceof TimeEntry) {
         return {
           label: `#${element.issue.id} ${element.activity.name} ${element.hours}h "${element.comments}"`,
           description: element.project.name,  // VSCode API: Secondary text (reduced opacity)
           command: {  // VSCode API: Click handler with context data
             command: 'redmine.openActionsForIssue',
             arguments: [false, { server: this.server }, String(element.issue.id)],
             title: `Open issue #${element.issue.id}`
           }
         };
       }
     }
   }
   ```

   **⚡ Performance**: Cache entries at parent level to avoid double-fetching
   - **Problem**: Original plan fetched entries twice (once for total, once for children)
   - **Solution**: Fetch once in root `getChildren()`, cache on parent node
   - **Impact**: 50% reduction in API calls, faster tree rendering

4. **Register Tree View**: `/src/extension.ts`
   ```typescript
   const myTimeEntriesTree = new MyTimeEntriesTree();

   vscode.window.createTreeView('redmine-explorer-my-time-entries', {
     treeDataProvider: myTimeEntriesTree
   });

   registerCommand('refreshTimeEntries', () => {
     myTimeEntriesTree.refresh();
   });
   ```

5. **Add to package.json**:
   ```json
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
         "title": "Refresh Time Entries",
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
       ]
     }
   }
   ```

6. **Write Tests**: `/test/unit/trees/my-time-entries-tree.test.ts`
   - Test 1: Groups created correctly (Today, This Week)
   - Test 2: Fetches entries with correct date filters
   - Test 3: Calculates totals correctly
   - Test 4: Empty state (no entries)

7. **Test API Method**: `/test/unit/redmine/redmine-server.test.ts`
   - Test 1: Builds query params correctly
   - Test 2: Parses response correctly
   - Test 3: Handles pagination

8. **Update docs**:
   - CHANGELOG.md: "feat: time entry viewing"
   - README.md: Add screenshot + usage
   - Bump version: 3.3.0 (minor)

### Date Helper Functions

```typescript
function today(): string {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

function weekAgo(): string {
  const date = new Date();
  date.setDate(date.getDate() - 7);
  return date.toISOString().split('T')[0];
}
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| No entries today | Show "No time logged today" placeholder |
| 100+ entries | Show first 100, add "View more" button |
| Missing issue | Display as "#??? Unknown issue" |
| Empty comments | Show hours only: "#123 Development 2.0h" |
| API error | Show error message in tree |

### Out of Scope (Future v4)

- Edit/delete time entries
- Custom date range picker
- Grouping by project
- Export to CSV
- Time entry conflicts detection

### Estimated Effort
- Implementation: ~200 LOC
- Tests: ~150 LOC
- Total: 4-6 hours

---

## MVP-3: Quick Time Logging

### Problem
Multi-step workflow for frequent time logging. Consultant logs 5-10x daily, current process too slow.

### Solution
Command palette shortcut that remembers last issue and activity for rapid re-logging.

### Redmine API Reference

**Uses existing endpoint**: `POST /time_entries.json`

**CRITICAL FINDINGS** (from API analysis):
- **`activity_id` REQUIRED** unless server has default activity configured
- **Comments max length**: 255 characters (truncate if longer)
- **Date format**: YYYY-MM-DD for `spent_on` field
- **Either issue_id OR project_id** required (not both)

**ACTIVITY FETCHING** (⚠️ TWO ENDPOINTS):
1. **System-level activities**: `GET /enumerations/time_entry_activities.json`
   - Returns global activities only
   - Response: `[{id, name, is_default}]`

2. **Project-specific activities**: `GET /projects/{id}.json?include=time_entry_activities`
   - Required for projects with restricted activities ([#18095](https://www.redmine.org/issues/18095))
   - Available since Redmine 3.4.0
   - Returns project's allowed activities (AUTHORITATIVE for that project)

**IMPLEMENTATION STRATEGY** (⚠️ CANNOT NAIVELY MERGE):
- **For project-specific logging**: Use project activities endpoint (authoritative)
- **For non-project contexts**: Use system-level activities as fallback
- **Risk**: Activity IDs may conflict between sources; project-specific IDs take precedence
- **Authority rule**: When logging to specific project, MUST use project's activity list

Request body:
```json
{
  "time_entry": {
    "issue_id": 123,              // REQUIRED (or project_id)
    "hours": 2.5,                 // REQUIRED (decimal supported)
    "activity_id": 8,             // REQUIRED (unless default exists)
    "comments": "Implemented...", // OPTIONAL (max 255 chars)
    "spent_on": "2025-11-23"      // OPTIONAL (defaults to today)
  }
}
```

**Activity Fetch Example**:
```json
GET /enumerations/time_entry_activities.json
Response: {
  "time_entry_activities": [
    {"id": 8, "name": "Development", "is_default": true},
    {"id": 9, "name": "Testing", "is_default": false}
  ]
}
```

No API changes needed.

Source: [Rest TimeEntries](https://www.redmine.org/projects/redmine/wiki/Rest_TimeEntries), [Rest Enumerations](https://www.redmine.org/projects/redmine/wiki/Rest_Enumerations)

**PERMISSION HANDLING**:
- **No pre-check needed**: Redmine API has no endpoint to check `:log_time` permission without admin access
- **Strategy**: Attempt time entry creation, handle 403 response gracefully
- **Error message**: "Cannot log time: You don't have permission in this project. Visit {server}/projects/{project}/settings/members to request access."
- **Rationale**: REST best practice - let server validate permissions, avoid unnecessary pre-check API calls

### UX Design

**Command**: `Redmine: Quick Log Time`

**Flow (first time - 3 steps)**:
1. Command palette → "Redmine: Quick Log Time"
2. Pick issue from assigned issues list
3. Input: "2.5|Implemented login" (defaults to last activity)

**Flow (repeat logging - 2 steps)**:
1. Command palette → "Redmine: Quick Log Time"
2. Input prompt shows: "Log time to #123: Fix auth bug (2.5|comment)"

**Flow (power user with keybinding - 1-2 steps)**:
1. Press `Ctrl+K Ctrl+T` (chord) → prompt appears
2. Enter "2.5|Fixed bug" → done

### Smart Defaults

**Recent Issue Memory**:
```typescript
interface RecentTimeLog {
  issueId: number;
  issueSubject: string;
  lastActivityId: number;
  lastActivityName: string;
  lastLogged: Date;
}
```

- Store last logged issue in `context.globalState`
- Display in prompt: "Log to #123: Subject"
- Option to pick different issue
- Clear if > 24h old

**Activity Selection**:
- Default to last-used activity for this issue
- Global fallback: "Development" (id: 8, typical default)
- Persistent across sessions

### Implementation Plan

1. **Create Command**: `/src/commands/quick-log-time.ts` (VSCode QuickPick + globalState pattern)
   ```typescript
   export default async ({ server }: ActionProperties, context: vscode.ExtensionContext) => {
     // VSCode API: globalState for persistent cache (syncs via Settings Sync)
     const recent = context.globalState.get<RecentTimeLog>('lastTimeLog');

     let issueId: number;
     let activityId: number;

     if (recent && isRecent(recent.lastLogged)) {
       // VSCode API: showQuickPick with codicons ($(clock), $(search))
       const useRecent = await vscode.window.showQuickPick([
         { label: `$(clock) Log to #${recent.issueId}: ${recent.issueSubject}`, value: 'recent' },
         { label: '$(search) Choose different issue', value: 'new' }
       ], {
         placeHolder: 'Quick time logging'  // VSCode API: Placeholder text
       });

       if (!useRecent) return;

       if (useRecent.value === 'recent') {
         issueId = recent.issueId;
         activityId = recent.lastActivityId;
       } else {
         ({ issueId, activityId } = await pickIssueAndActivity(server));
       }
     } else {
       // No recent, pick fresh
       ({ issueId, activityId } = await pickIssueAndActivity(server));
     }

     // VSCode API: showInputBox with real-time validation
     const input = await vscode.window.showInputBox({
       prompt: `Log time to #${issueId}`,
       placeHolder: '2.5|Implemented feature',
       validateInput: (value) => {
         const match = value.match(/^(\d+\.?\d*)\|(.*)$/);
         return match ? null : 'Format: hours|comment';  // null = valid
       }
     });

     if (!input) return;

     const [_, hours, comments] = input.match(/^(\d+\.?\d*)\|(.*)$/)!;

     // Submit
     await server.addTimeEntry(
       issueId,
       parseFloat(hours),
       activityId,
       comments
     );

     // VSCode API: Update globalState cache
     context.globalState.update('lastTimeLog', {
       issueId,
       issueSubject: '...', // Fetch from issues list
       lastActivityId: activityId,
       lastActivityName: '...',
       lastLogged: new Date()
     });

     vscode.window.showInformationMessage(
       `Logged ${hours}h to #${issueId}`
     );
   };
   ```

2. **Register Command**: `/src/extension.ts` (CRITICAL: Pass context for globalState)
   ```typescript
   // ⚠️ CRITICAL: Must pass context to command for globalState access
   registerCommand('quickLogTime', (props: ActionProperties) => {
     return quickLogTime(props, context); // Pass context for globalState
   });
   ```

3. **Add to package.json**: (VSCode chord keybinding pattern)
   ```json
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
         "key": "ctrl+k ctrl+l",      // ⚠️ FIXED: Was ctrl+t (conflicts with Color Theme)
         "mac": "cmd+k cmd+l",         // L for "Log time"
         "when": "!terminalFocus && !editorTextFocus && !inDebugMode"
       }
     ]
   }
   ```

4. **Write Tests**: `/test/unit/commands/quick-log-time.test.ts`
   - Test 1: First time flow (no recent)
   - Test 2: Recent issue flow
   - Test 3: Input validation
   - Test 4: State persistence

5. **Update docs**:
   - CHANGELOG.md: "feat: quick time logging command"
   - README.md: Add usage + keybinding
   - Bump version: 3.3.0 (same as MVP-3)

### Helper Functions

```typescript
function isRecent(lastLogged: Date): boolean {
  const hoursAgo = (Date.now() - lastLogged.getTime()) / (1000 * 60 * 60);
  return hoursAgo < 24; // Within last 24h
}

async function pickIssueAndActivity(
  server: RedmineServer,
  context: vscode.ExtensionContext
): Promise<{
  issueId: number;
  activityId: number;
}> {
  const { issues } = await server.getIssuesAssignedToMe();

  // ⚡ Performance: Limit picker to recent 10 issues for instant UX
  const recentIssues = context.globalState.get<number[]>('recentIssueIds', []);
  const recentItems = recentIssues
    .map(id => issues.find(i => i.id === id))
    .filter(i => i !== undefined)
    .slice(0, 10);

  const quickPickItems = [
    ...(recentItems.length > 0
      ? [
          { label: '$(history) Recent Issues', kind: vscode.QuickPickItemKind.Separator },
          ...recentItems.map(issue => ({
            label: `#${issue.id} ${issue.subject}`,
            issue
          }))
        ]
      : []),
    { label: '$(search) All Issues', kind: vscode.QuickPickItemKind.Separator },
    ...issues.slice(0, 100).map(issue => ({
      label: `#${issue.id} ${issue.subject}`,
      description: issue.project?.name,
      issue
    }))
  ];

  const picked = await vscode.window.showQuickPick(quickPickItems, {
    placeHolder: 'Select issue to log time',
    matchOnDescription: true
  });

  if (!picked || !picked.issue) throw new Error('No issue selected');

  // Update recent issues cache
  const updatedRecent = [
    picked.issue.id,
    ...recentIssues.filter(id => id !== picked.issue.id)
  ].slice(0, 10);
  context.globalState.update('recentIssueIds', updatedRecent);

  const activities = await server.getTimeEntryActivities();
  const activity = await vscode.window.showQuickPick(
    activities.time_entry_activities.map(a => ({
      label: a.name,
      activity: a
    }))
  );

  if (!activity) throw new Error('No activity selected');

  return {
    issueId: picked.issue.id,
    activityId: activity.activity.id
  };
}

/**
 * ⚡ Performance Impact:
 * - Instant picker (<100ms vs 1-2s for 100+ issues)
 * - Better UX with recent issues prioritized
 * - Search still works for all issues
 */
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| No assigned issues | Show error, suggest browser |
| No recent log | Skip recent prompt, go to picker |
| Recent > 24h old | Treat as no recent |
| Invalid input format | Validation error, re-prompt |
| API error | Show error, don't update state |

### Out of Scope (Future v5)

- Status bar integration
- Multiple recent issues (LRU cache of 5)
- Time format variations ("1.5h" instead of "1.5")
- Auto-activity detection based on file type
- Batch time logging

### Estimated Effort
- Implementation: ~150 LOC
- Tests: ~100 LOC
- Total: 3-4 hours

---

## MVP-4: Workload Overview

**Status**: Planned for Phase 2 (see MVP_DECISIONS.md)

### Problem
Cannot assess total capacity or answer "Do I have time for new 8h request?"

### Solution
Status bar item (always visible) showing:
- Total estimated/spent/remaining hours across all assigned issues
- Available capacity this week (working days × hours/day - remaining work)
- Top 3 most urgent issues by deadline (in tooltip)

### Implementation Plan

1. **Create Status Bar Item**: `/src/extension.ts`
   ```typescript
   class WorkloadStatusBar {
     private statusBar: vscode.StatusBarItem;
     private server: RedmineServer;

     constructor(server: RedmineServer) {
       this.server = server;
       this.statusBar = vscode.window.createStatusBarItem(
         vscode.StatusBarAlignment.Right,
         100
       );
       this.statusBar.command = 'redmine.showWorkloadDetails';
       this.statusBar.show();
     }

     async update() {
       const workload = await this.calculateWorkload();
       this.statusBar.text = `$(pulse) ${workload.remaining}h left, ${workload.buffer}h ${workload.icon}`;

       this.statusBar.tooltip = new vscode.MarkdownString(`
**Workload Overview**

Total estimated: ${workload.totalEstimated}h
Total spent: ${workload.totalSpent}h
Remaining work: ${workload.remaining}h
Available this week: ${workload.available}h
Capacity: ${workload.buffer}h buffer ${workload.icon}

**Top 3 Urgent:**
${workload.topUrgent.map(i => `- #${i.id}: ${i.daysLeft}d left, ${i.hoursLeft}h ${i.icon}`).join('\n')}
       `);
     }

     private async calculateWorkload() {
       const { issues } = await this.server.getIssuesAssignedToMe();
       const openIssues = issues.filter(i => !i.status.is_closed);

       const totalEstimated = openIssues.reduce((sum, i) => sum + (i.total_estimated_hours || 0), 0);
       const totalSpent = openIssues.reduce((sum, i) => sum + (i.total_spent_hours || 0), 0);
       const remaining = totalEstimated - totalSpent;

       const config = vscode.workspace.getConfiguration('redmine.workingHours');
       const hoursPerDay = config.get<number>('hoursPerDay', 8);
       const workingDays = config.get<string[]>('workingDays', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

       const daysThisWeek = 5; // Simplified for MVP
       const available = daysThisWeek * hoursPerDay;
       const buffer = available - remaining;
       const icon = buffer >= 0 ? '🟢' : '🔴';

       // Top 3 urgent
       const topUrgent = openIssues
         .filter(i => i.due_date)
         .sort((a, b) => new Date(a.due_date!).getTime() - new Date(b.due_date!).getTime())
         .slice(0, 3)
         .map(i => ({
           id: i.id,
           daysLeft: Math.ceil((new Date(i.due_date!).getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
           hoursLeft: (i.total_estimated_hours || 0) - (i.total_spent_hours || 0),
           icon: '🔴' // Simplified
         }));

       return { totalEstimated, totalSpent, remaining, available, buffer, icon, topUrgent };
     }

     // ⚡ Performance: Event-driven updates (no polling)
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
         if (e.affectsConfiguration('redmine')) {
           this.update();
         }
       });

       // Initial update
       this.update();
     }

     dispose() {
       this.statusBar.dispose();
     }
   }
   ```

   **⚡ Performance**: Event-driven updates only
   - **No polling**: Updates only on specific events (time logged, manual refresh, config change)
   - **Impact**: Zero polling overhead, updates only when needed
   - **Pattern**: Already exists in codebase (tree refresh pattern)

2. **Register in Extension**: `/src/extension.ts`
   ```typescript
   const workloadStatusBar = new WorkloadStatusBar(server);
   workloadStatusBar.registerTriggers(context);
   context.subscriptions.push(workloadStatusBar);
   ```

**Estimated Effort**: 1-2 hours (status bar item ~20 LOC vs tree view ~120 LOC)

---

## Recommended Implementation Order

**⚠️ IMPLEMENT IN THIS SEQUENCE** (not by MVP number):

### 1️⃣ MVP-3: Quick Time Logging (3-4h) ⭐ START HERE
**Why first**:
- ✅ Simplest design (perfect, zero fixes needed)
- ✅ Highest ROI (10x faster logging)
- ✅ Tests caching patterns for later MVPs
- ✅ Immediate user value

**Tasks**:
- `Ctrl+K Ctrl+L` keybinding (fixed conflict)
- 1-issue globalState cache
- Activity defaulting

**Deliverable**: v3.2.0-alpha

---

### 2️⃣ MVP-2: Time Entry Viewing (4-6h)
**Why second**:
- ✅ Validates caching approach (learns from MVP-3)
- ✅ P0 priority (billing verification critical)
- ✅ Moderate complexity (good learning step)

**Tasks**:
- Cached time entries (pre-calculate totals)
- Collapsible date groups (start Collapsed)
- Tree view with click handlers

**Deliverable**: v3.2.0-beta

---

### 3️⃣ MVP-1: Timeline & Progress Display (8-10h)
**Why third**:
- ⚠️ Most complex (pre-calc caching, dual formulas)
- ⚠️ Highest risk (performance-critical)
- ✅ Benefits from lessons learned in MVP-2/3
- ✅ P0 priority (work prioritization)

**Tasks**:
- Dual flexibility formula (initial + remaining)
- Pre-calculated caching in getChildren()
- Simplified description (current status only)
- Rich tooltips (full details)

**Deliverable**: v3.2.0 (P0 complete)

---

### 4️⃣ MVP-4: Workload Overview (1-2h)
**Why last**:
- ✅ Trivial implementation (status bar item ~20 LOC)
- ✅ P1 priority (nice-to-have polish)
- ✅ Quick win after complex MVP-1

**Tasks**:
- Status bar item (always visible)
- Tooltip with workload details
- Command for QuickPick details

**Deliverable**: v3.3.0 (full MVP suite)

---

## Priority-Based Phases (Reference Only)

### Phase 1: P0 Features - 12-16h
1. **MVP-1**: Timeline & Progress Display (8-10h) ← Complex, do 3rd
2. **MVP-2**: Time Entry Viewing (4-6h) ← Moderate, do 2nd

**Release**: v3.2.0
**Value**: Core billing workflow

### Phase 2: P1 Features - 4-6h
1. **MVP-3**: Quick Time Logging (3-4h) ← Simple, do 1st ⭐
2. **MVP-4**: Workload Overview (1-2h) ← Trivial, do 4th

**Release**: v3.3.0
**Value**: Workflow efficiency

---

### Total Estimated Effort

**Implementation** (includes performance optimizations):
- MVP-3: 3-4h (start) - includes recent issues picker optimization
- MVP-2: 4-6h - includes caching optimization
- MVP-1: 8-10h (most complex) - includes memoization optimization
- MVP-4: 1-2h (finish) - includes event-driven updates

**Testing & Documentation**:
- Testing: ~6-8 hours
- Documentation: ~3-4 hours

**Performance Optimizations** (integrated above):
- MVP-1 memoization: +30 min
- MVP-2 caching: +15 min
- MVP-3 picker limit: +15 min
- MVP-4 event-driven: +5 min
- Partial refresh: +5 min
- **Total perf overhead**: ~1.5 hours (included in estimates above)

**Grand Total**: ~22-34 hours (3-4 days) - same as before, perf work integrated

### Expected Impact
- **After P0 (MVP-1+2)**: 60-65% workflow coverage, ~5 browser visits/day
- **After P1 (MVP-3+4)**: 75-80% workflow coverage, ~2-3 browser visits/day
- **Browser visits reduced**: 10/day → 2-3/day (70-80% reduction)

---

## Testing Strategy (TDD per CLAUDE.md)

### Before Implementation
1. Review `docs/LESSONS_LEARNED.md`
2. Review `docs/ARCHITECTURE.md`
3. Review `CLAUDE.md`

### During Implementation
1. Write tests FIRST for each MVP
2. Aim for 3 e2e tests per feature (minimalist)
3. Target 60% coverage (realistic per lessons learned)
4. Mock API responses using existing patterns
5. Avoid testing VS Code UI integration

### After Implementation
1. Run full test suite: `npm test`
2. Verify coverage: `npm run coverage`
3. Update `docs/LESSONS_LEARNED.md` with insights
4. Update `docs/ARCHITECTURE.md` if needed

---

## Success Metrics

### MVP-1 & MVP-2: Timeline/Hours
- **Goal**: Reduce daily browser visits for work prioritization by 80%
- **Measure**: User can answer "what should I work on today?" from IDE

### MVP-3: Time Entry Viewing
- **Goal**: Eliminate browser visits for time verification
- **Measure**: User can verify daily time logs from IDE

### MVP-4: Quick Time Logging
- **Goal**: Reduce time logging from 5 steps to 2 steps
- **Measure**: Log time in <10 seconds with <3 interactions

### Overall
- **Goal**: Reduce Redmine browser visits from ~10/day to ~2/day
- **Target**: 80% of workflow in IDE vs current 20%

---

## Risk Mitigation

### Risk: Redmine Version Compatibility
- **Mitigation**: Graceful degradation for missing fields
- **Testing**: Test with Redmine 3.3+ and <3.3

### Risk: Performance (API Call Volume)
- **Mitigation**:
  - MVP-1/MVP-2: No additional calls (uses existing data)
  - MVP-3: Lazy loading (fetch on expand)
  - Cache time entries for 5min
- **Testing**: Monitor API logs, add pagination if needed

### Risk: User Confusion (New UI Elements)
- **Mitigation**:
  - Clear tooltips
  - README documentation
  - Gradual rollout (MVP-1/2 first, then MVP-3/4)

### Risk: Breaking Changes
- **Mitigation**:
  - Follow semantic versioning
  - No changes to existing models (only additions)
  - Backward compatible (features degrade gracefully)

---

## Decisions Made

### MVP-1: Flexibility Score ✅
- Formula: `(available_time / estimated_time - 1) * 100`
- Shows buffer percentage directly (0% = tight, +60% = 60% buffer, -20% = overbooked)
- Working hours config: 8h/day, Mon-Thu for consultant
- Excludes weekends from working days calculation

### MVP-2: Spent Hours ✅
- Use `spent_hours` (issue only, not subtasks)
- Display format: "3.5/8h" (spent/estimated)
- Color coding for over-budget: Yes (append `!` if spent > estimated)

### MVP-3: Time Entries ✅
- Empty state: "No time logged today" placeholder
- Refresh strategy: Auto-refresh after logging
- Max entries: 100 per group initially

### MVP-4: Quick Logging ✅
- Keyboard shortcut: `Ctrl+K Ctrl+T` (chord, avoids GlazeWM conflict)
- State scope: globalState (cross-workspace)
- Recent issue limit: 5 (LRU cache)

## Remaining Questions

### MVP-1: Flexibility Score
1. Should issues without flexibility score (no due_date/estimate) appear at bottom of list?
2. Include start_date in tooltip or just working days calculation?
3. Default working hours for users without config?

### MVP-3: Time Entries
1. Grouping preference: by date only, or add "by project" option?
2. Click action on time entry: open issue or dedicated time entry menu?

---

## Future API Considerations

Based on comprehensive analysis of all 22 Redmine REST API endpoints:

### P2 Priority - Future MVPs

**1. Issue Relations** (`GET /issues.json?include=relations`)
- **Use case**: Show blocking/blocked issues in timeline view
- **Impact on capacity**: Blocked issues shouldn't count as "available work"
- **Display**: Add "🔴 BLOCKED by #456" indicator
- **Efficiency**: Use `include=relations` param for batch requests (single API call)
- **Effort**: 8-11h (MVP-5 candidate)
- **Example**: `#123 Fix auth | 3.5/8h 2d +60% 🔴 BLOCKED by #456`

**2. Saved Queries** (`GET /queries.json`, `GET /issues.json?query_id=X`)
- **Use case**: Show user's custom saved queries as tree views
- **Benefit**: Leverage existing Redmine filters without rebuilding
- **Read-only**: Can't create queries via API (must use web)
- **Effort**: 4-6h (MVP-6 candidate)

**3. Custom Fields** (`GET /custom_fields.json`)
- **Use case**: Support organization-specific time tracking fields
- **Examples**:
  - "Budget Hours" (override estimated_hours)
  - "Target Completion Date" (more reliable than due_date)
  - "Billable Category" (billing workflow)
- **Configuration**: Map field names in settings
- **Limitation**: Requires admin access to fetch definitions
- **Effort**: 6-8h (MVP-7 candidate)

**4. Issue Picker with Search** (`GET /issues.json` with subject filter)
- **Use case**: Quick issue lookup in time logging UI
- **Recommended approach**: Use `/issues.json?f[]=subject&op[subject]=~&v[subject][]=<query>`
- **⚠️ RISK**: Subject filtering **works but is UNDOCUMENTED** ([#13347](https://www.redmine.org/issues/13347))
- **Evidence**: Proven working in Redmine 3.4.1+, 4.0.4 (redmine-java-api lib, multiple user confirmations)
- **Not officially supported**: May break in future Redmine versions without warning
- **Operator**: `op[subject]=~` is "contains" operator, `%` works as wildcard
- **Why not /search.xml**: XML-only (no JSON), returns minimal data
- **Performance**: Max 100 results, supports wildcards
- **Effort**: 2-3h (enhancement to MVP-3) + risk mitigation strategy

**5. Version/Milestone Planning** (`GET /projects/{id}/versions`)
- **Use case**: Group workload by version/milestone
- **Timeline**: Show version due dates alongside issue deadlines
- **Effort**: 3-4h (MVP-8 candidate)

### Not Relevant for Extension

Based on analysis, these APIs have **no connection** to time tracking or issue management:
- News API - Project announcements
- WikiPages API - Documentation management
- Attachments API - File uploads
- Files API - Project files
- Issue Categories API - Taxonomic grouping only

### Critical Constraints Identified

**Closed Issues Filtering**:
- **MUST use `status.is_closed` flag** to exclude from workload
- Fetch statuses: `GET /issue_statuses.json` (cache result)
- Filter pattern:
  ```typescript
  const closedIds = statuses.filter(s => s.is_closed).map(s => s.id);
  const openIssues = issues.filter(i => !closedIds.includes(i.status.id));
  ```

**Group Assignments**:
- Issues assigned to groups appear in "assigned to me" for group members
- `assigned_to_id=me` includes both direct + group assignments
- No additional filtering needed

**Pagination Limits**:
- Default: 25 items per request
- Maximum: 100 items per request (**hardcoded**, not configurable)
- **Note**: Feature requests (#16069, #25555, #33526) exist to make this configurable but remain unimplemented
- Large datasets require offset/limit loops

**Caching Recommendations**:
- **Issue statuses**: Cache for 24h (rarely change), clear on manual refresh
- **Activities**: Cache for session (static data)
- **Time entries**: Cache for 5min max (frequently updated)

**No Server-Side Aggregation**:
- Time entry grouping: Client-side only
- Workload totals: Must sum locally
- Multi-project queries: Separate requests per project

---

## Next Steps

1. **Review this plan** with user
2. **Answer unresolved questions**
3. **Begin implementation** (MVP-1 first, TDD approach)
4. **Iterate based on feedback** (each MVP can be released independently)
5. **Consider P2 features** after v3.3.0 (Issue Relations, Saved Queries)

---

## References

### Redmine API Documentation
- [Rest Issues API](https://www.redmine.org/projects/redmine/wiki/Rest_Issues)
- [Rest TimeEntries API](https://www.redmine.org/projects/redmine/wiki/Rest_TimeEntries)
- [Feature #21757: Total spent/estimated hours](https://www.redmine.org/issues/21757)
- [Feature #5303: Add spent_hours to issues API](https://www.redmine.org/issues/5303)
- [Feature #13275: Time entries filtering](https://www.redmine.org/issues/13275)

### Codebase Documentation
- `/home/user/positron-redmine/docs/ARCHITECTURE.md`
- `/home/user/positron-redmine/docs/LESSONS_LEARNED.md`
- `/home/user/positron-redmine/docs/PROBLEM_SOLUTION_FIT_ASSESSMENT.md`
- `/home/user/positron-redmine/CLAUDE.md`
