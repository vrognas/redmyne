# MVP Implementation Plan

**Date**: 2025-11-23
**Context**: Solving consultant workflow gaps identified in PROBLEM_SOLUTION_FIT_ASSESSMENT.md
**Approach**: Four focused MVPs addressing P0 (critical) and P1 (high value) gaps

---

## MVP Overview

| MVP | Priority | Value | Complexity | API Changes |
|-----|----------|-------|------------|-------------|
| **MVP-1: Flexibility Score & Timeline** | P0 | HIGH | MEDIUM | None (uses existing fields) |
| **MVP-2: Spent Hours Display** | P0 | HIGH | LOW | None (field included by default) |
| **MVP-3: Time Entry Viewing** | P1 | HIGH | MEDIUM | New endpoint |
| **MVP-4: Quick Time Logging** | P1 | MEDIUM | LOW | None (uses existing) |

---

## MVP-1: Flexibility Score & Timeline

### Problem
Cannot see planning quality or deadline urgency. Issues with tight timelines or approaching deadlines invisible in UI.

### Solution
Calculate "flexibility score" showing buffer percentage based on working hours configuration. Displays both estimated hours and flexibility to enable daily work prioritization.

### Redmine API Reference

**NO API changes required** - uses existing Issue fields:
```json
{
  "issue": {
    "id": 123,
    "due_date": "2025-11-26",      // ✅ Already fetched
    "start_date": "2025-11-20",    // ✅ Already fetched
    "estimated_hours": 16.0,       // ✅ Already fetched
    "created_on": "2025-11-18"     // ✅ Fallback if no start_date
  }
}
```

Source: [Rest Issues API](https://www.redmine.org/projects/redmine/wiki/Rest_Issues)

### Flexibility Formula

```typescript
flexibility = (available_time / estimated_time - 1) * 100

where:
  available_time = working_days * hours_per_day
  working_days = count_working_days(start_date, due_date, working_days_config)
  estimated_time = estimated_hours
```

**Interpretation**:
- **0%** = No buffer (perfectly tight planning)
- **+60%** = 60% extra time (comfortable buffer)
- **-20%** = Need 20% more time (overbooked)

**Examples**:
```
Available: 8h,  Estimated: 5h  → (8/5 - 1) = 0.6 = +60% buffer
Available: 40h, Estimated: 16h → (40/16 - 1) = 1.5 = +150% buffer
Available: 8h,  Estimated: 8h  → (8/8 - 1) = 0.0 = 0% buffer (tight)
Available: 16h, Estimated: 20h → (16/20 - 1) = -0.2 = -20% (overbooked)
```

### Configuration

**New settings** (package.json contributions):
```jsonc
{
  "redmine.workingHours.hoursPerDay": {
    "type": "number",
    "default": 8,
    "minimum": 1,
    "maximum": 24,
    "description": "Working hours per day for flexibility calculation"
  },
  "redmine.workingHours.workingDays": {
    "type": "array",
    "items": {
      "type": "string",
      "enum": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    },
    "default": ["Mon", "Tue", "Wed", "Thu", "Fri"],
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
Fix auth bug              16h +150% 🟢  #123
Add reporting             8h  +0%   🟡  #456
Database optimization     20h -20%  🔴  #789
Client docs                            #999  (no estimate/due date)
```

**Format**: `{estimated}h {+/-}{flexibility}% {icon}`

**Tooltip on hover:**
```
Issue #123: Fix auth bug
────────────────────────────────
Timeline: Mon Nov 20 → Fri Nov 24 (5 calendar days)
Working days: 4 (Mon, Tue, Wed, Thu)
Available: 32h (4 days × 8h/day)
Estimated: 16h

Flexibility: +100% buffer (2× effective time)
Planning: Comfortable 🟢
```

### Risk Levels

```typescript
flexibility < 0%      → 🔴 OVERBOOKED (impossible timeline)
flexibility = 0%      → 🟡 TIGHT (no buffer, need every minute)
flexibility < 20%     → 🟡 LIMITED (minimal buffer)
flexibility < 50%     → 🟢 SOME (decent buffer)
flexibility >= 50%    → 🟢 COMFORTABLE (healthy buffer)
```

**Color coding examples**:
```
20h -20% 🔴  (need 20% more time - impossible)
8h  +0%  🟡  (need every working minute)
8h  +15% 🟡  (15% buffer - tight)
16h +45% 🟢  (45% buffer - some)
16h +150% 🟢 (150% buffer - very comfortable)
```

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

3. **Modify**: `/src/utilities/tree-item-factory.ts`
   - Accept `WorkingHoursConfig` parameter
   - Call `calculateFlexibility(issue, config)`
   - Update description format: `{est}h {+/-}{flex}%`
   - Add icon based on risk level
   - Add detailed tooltip

4. **Update tree providers**: `/src/trees/my-issues-tree.ts`, `/src/trees/projects-tree.ts`
   - Read configuration from workspace settings
   - Pass config to `createIssueTreeItem()`

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
- Flexibility calculator: ~60 LOC
- Tree item integration: ~40 LOC
- Tests: ~120 LOC
- Total: **4-5 hours**

---

## MVP-2: Spent Hours Display

### Problem
Cannot see how much time accumulated on issues. No way to track against estimates or budgets.

### Solution
Display spent_hours alongside estimated_hours in issue tree items.

### Redmine API Reference

**API endpoint**: Already called (`GET /issues.json`)

**Add query parameter**:
```
GET /issues.json?assigned_to_id=me&status_id=open
```

**Response includes** (Redmine 3.3+):
```json
{
  "issue": {
    "id": 123,
    "estimated_hours": 8.0,
    "spent_hours": 3.5,              // ✅ Time on this issue only
    "total_estimated_hours": 12.0,   // ✅ Including subtasks
    "total_spent_hours": 5.5         // ✅ Including subtasks
  }
}
```

**Note**: Fields always present on Redmine 3.3+. No explicit `include` parameter needed.

Source: [Feature #21757](https://www.redmine.org/issues/21757), [Feature #5303](https://www.redmine.org/issues/5303)

### UI Design

**Current display:**
```
Fix authentication bug                 #123
```

**New display (with estimates):**
```
Fix authentication bug      3.5/8h 🟢 3d  #123
Add reporting feature       0/12h  🟡 7d  #456
Database optimization       8/4h!  🔴 1d  #789  (over budget)
Client documentation               🟢 5d  #999  (no estimate)
```

**Format**: `{spent}/{estimated}h`
- Over budget (spent > estimated): Append `!` and use warning color
- No estimate: Hide hours display
- No spent time: Show `0/8h`

### Implementation Plan

1. **Update Model**: `/src/redmine/models/issue.ts`
   ```typescript
   export interface Issue {
     // ... existing fields
     estimated_hours: number | null;
     spent_hours?: number;              // Add (optional for backward compat)
     total_estimated_hours?: number;    // Add
     total_spent_hours?: number;        // Add
   }
   ```

2. **Verify API Response**: Check if current Redmine server (version?) returns these fields
   - Add logging to see actual response structure
   - Handle gracefully if fields missing (older Redmine)

3. **Modify**: `/src/utilities/tree-item-factory.ts`
   - Add `getHoursDisplay(issue: Issue): string` helper
   - Update description to include hours before risk indicator
   - Format: `{hours} {risk} #{id}`

4. **Test**: `/test/unit/utilities/tree-item-factory.test.ts`
   - Test 1: No estimate → no hours display
   - Test 2: Estimate with no spent → "0/8h"
   - Test 3: Under budget → "3.5/8h"
   - Test 4: Over budget → "8/4h!"
   - Test 5: Missing fields → graceful degradation

5. **Update docs**:
   - CHANGELOG.md: "feat: display spent/estimated hours"
   - Bump version: 3.2.0 (same release as MVP-1)

### Edge Cases

| Scenario | Display |
|----------|---------|
| No estimated_hours | Hide hours (preserve current) |
| spent_hours missing (old Redmine) | Hide hours (backward compat) |
| spent = estimated | "8/8h" (no indicator) |
| spent > estimated | "9/8h!" (budget warning) |
| Decimal hours | "3.5/8h" (preserve precision) |

### Compatibility

**Minimum Redmine version**: 3.3.0 (released 2016-09-25)
- For older versions: Fields won't be present, feature disabled gracefully

### Out of Scope (Future v3)

- Configurable display format
- Total vs individual hours toggle
- Budget percentage (75% of 8h)
- Hours breakdown by user

### Estimated Effort
- Implementation: ~40 LOC
- Tests: ~60 LOC
- Total: 1-2 hours

---

## MVP-3: Time Entry Viewing

### Problem
Cannot verify logged time entries for billing accuracy. Must open browser to generate timesheets.

### Solution
New tree view "My Time Entries" showing logged time grouped by date with totals.

### Redmine API Reference

**New endpoint**: `GET /time_entries.json`

**Query parameters**:
```
GET /time_entries.json?user_id=me&from=2025-11-20&to=2025-11-23&limit=100
```

**Supported filters**:
- `user_id` - Filter by user (use `me` for current user)
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

3. **Create Tree Provider**: `/src/trees/my-time-entries-tree.ts`
   ```typescript
   type TreeItem = DateGroup | TimeEntry | LoadingPlaceholder;

   interface DateGroup {
     label: string;      // "Today", "This Week"
     from: string;       // YYYY-MM-DD
     to: string;         // YYYY-MM-DD
     total?: number;     // Calculated after fetch
   }

   export class MyTimeEntriesTree implements vscode.TreeDataProvider<TreeItem> {
     async getChildren(element?: TreeItem): Promise<TreeItem[]> {
       if (!element) {
         // Root: return date groups
         return [
           { label: 'Today', from: today(), to: today() },
           { label: 'This Week', from: weekAgo(), to: today() }
         ];
       }

       if (element instanceof DateGroup) {
         // Fetch time entries for date range
         const response = await this.server.getTimeEntries({
           userId: 'me',
           from: element.from,
           to: element.to,
           limit: 100
         });

         // Calculate total
         const total = response.time_entries.reduce(
           (sum, entry) => sum + entry.hours, 0
         );
         element.total = total;

         return response.time_entries;
       }
     }

     getTreeItem(element: TreeItem): vscode.TreeItem {
       if (element instanceof DateGroup) {
         return {
           label: `📅 ${element.label}${element.total ? ` (${element.total}h)` : ''}`,
           collapsibleState: element.label === 'Today'
             ? vscode.TreeItemCollapsibleState.Expanded
             : vscode.TreeItemCollapsibleState.Collapsed
         };
       }

       if (element instanceof TimeEntry) {
         return {
           label: `#${element.issue.id} ${element.activity.name} ${element.hours}h "${element.comments}"`,
           description: element.project.name,
           command: {
             command: 'redmine.openActionsForIssue',
             arguments: [false, { server: this.server }, String(element.issue.id)],
             title: `Open issue #${element.issue.id}`
           }
         };
       }
     }
   }
   ```

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

## MVP-4: Quick Time Logging

### Problem
Multi-step workflow for frequent time logging. Consultant logs 5-10x daily, current process too slow.

### Solution
Command palette shortcut that remembers last issue and activity for rapid re-logging.

### Redmine API Reference

**Uses existing endpoint**: `POST /time_entries.json`

Request body:
```json
{
  "time_entry": {
    "issue_id": 123,
    "hours": 2.5,
    "activity_id": 8,
    "comments": "Implemented login feature"
  }
}
```

No API changes needed.

Source: [Rest TimeEntries](https://www.redmine.org/projects/redmine/wiki/Rest_TimeEntries)

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

1. **Create Command**: `/src/commands/quick-log-time.ts`
   ```typescript
   export default async ({ server }: ActionProperties, context: vscode.ExtensionContext) => {
     // Get recent log from state
     const recent = context.globalState.get<RecentTimeLog>('lastTimeLog');

     let issueId: number;
     let activityId: number;

     if (recent && isRecent(recent.lastLogged)) {
       // Prompt with recent issue pre-filled
       const useRecent = await vscode.window.showQuickPick([
         { label: `Log to #${recent.issueId}: ${recent.issueSubject}`, value: 'recent' },
         { label: 'Choose different issue', value: 'new' }
       ]);

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

     // Input hours and comment
     const input = await vscode.window.showInputBox({
       prompt: `Log time to #${issueId}`,
       placeHolder: '2.5|Implemented feature',
       validateInput: (value) => {
         const match = value.match(/^(\d+\.?\d*)\|(.*)$/);
         return match ? null : 'Format: hours|comment';
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

     // Save to recent
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

2. **Register Command**: `/src/extension.ts`
   ```typescript
   registerCommand('quickLogTime', (props: ActionProperties) => {
     return quickLogTime(props, context); // Pass context for state
   });
   ```

3. **Add to package.json**:
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
         "key": "ctrl+k ctrl+t",
         "mac": "cmd+k cmd+t"
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

async function pickIssueAndActivity(server: RedmineServer): Promise<{
  issueId: number;
  activityId: number;
}> {
  const { issues } = await server.getIssuesAssignedToMe();

  const picked = await vscode.window.showQuickPick(
    issues.map(issue => ({
      label: issue.subject,
      description: `#${issue.id}`,
      issue
    }))
  );

  if (!picked) throw new Error('No issue selected');

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

## Implementation Sequence

### Phase 1: Flexibility & Hours (Week 1)
1. **MVP-1**: Flexibility Score & Timeline (4-5h)
2. **MVP-2**: Spent Hours Display (1-2h)
3. Testing + documentation (2h)
4. **Release**: v3.2.0

**Value**: Immediate daily work prioritization with planning quality insights

### Phase 2: Time Tracking (Week 2)
1. **MVP-3**: Time Entry Viewing (4-6h)
2. **MVP-4**: Quick Time Logging (3-4h)
3. Testing + documentation (3h)
4. **Release**: v3.3.0

**Value**: Complete time tracking workflow in IDE

### Total Estimated Effort
- Implementation: ~17-20 hours
- Testing: ~5-7 hours
- Documentation: ~2-3 hours
- **Total**: ~24-30 hours (3-4 days)

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

## Next Steps

1. **Review this plan** with user
2. **Answer unresolved questions**
3. **Begin implementation** (MVP-1 first, TDD approach)
4. **Iterate based on feedback** (each MVP can be released independently)

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
