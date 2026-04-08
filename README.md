# Redmyne

![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/vrognas/redmyne/ci.yml)
![Visual Studio Marketplace Downloads](https://img.shields.io/visual-studio-marketplace/d/vrognas.redmyne)
![GitHub License](https://img.shields.io/github/license/vrognas/redmyne)

**Personal workload management for Redmine** — log time, track capacity, stay in flow.

> [!NOTE]
> This extension is currently in active development.
> While stable for daily use, expect occasional breaking changes.
> Please report any issues to help improve the extension.

## Quick Start

```
1. Install extension
2. Ctrl+Shift+P → "Redmyne: Set API Key"
3. Enter URL + API key
```

Your issues appear in the sidebar. Start logging time.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Y Ctrl+Y` | Quick log time |
| `Ctrl+Y Ctrl+N` | Quick create issue |
| `Ctrl+Y Ctrl+T` | Toggle timer |

*(Mac: use `Cmd` instead of `Ctrl`)*

## Features

### Issues View

Browse your assigned issues grouped by project.

**Filters:**
- My Open Issues *(default)*
- All Open Issues
- My Closed Issues
- All Issues

**Sorting:** By #ID, Subject, or Assignee (click to toggle direction)

**View modes:** Tree (hierarchy) or List (flat)

**Actions (right-click):**
- Quick Update (status + assignee + comment in one step)
- Log Time
- Set % Done
- Create Sub-Issue
- Show in Gantt
- Open in Browser
- Copy URL

**Colors:**
- 🔴 Overbooked — not enough hours before due date
- 🟡 At risk — tight schedule
- 🟢 On track — comfortable buffer

### Time Entries View

See logged time grouped by **Today**, **This Week**, **This Month**.

**Filters:** My Time, All Users

**Sorting:** By #ID, Subject, Comment, or User

**Actions (right-click):**
- Edit Time Entry
- Delete Time Entry
- Open in Browser

**Add entries:** Right-click any date → Add Time Entry

**Copy/paste:** Copy single entries, days, or weeks → paste to other dates

**Custom fields:** Required and optional custom fields prompted when logging time

### Gantt Chart

Interactive timeline for workload visualization.

**Editing:**
- Drag bar edges → adjust start or due date
- Drag bar body → move both dates together
- Right-click bar → Update issue dialog

**Selection:**
- Click → select single issue
- Ctrl+click → toggle selection
- Shift+click → select range
- Ctrl+A → select all
- Drag selected → bulk move

**Navigation:**
- Arrow keys → move focus
- Home/End → first/last issue
- Enter → open issue actions
- Minimap (bottom) → click/drag to navigate

**Visualization:**
- Zoom: Day / Week / Month / Quarter / Year
- Intensity toggle → daily work distribution on bars
- Critical path toggle → highlight blocking chains
- Capacity ribbon → daily utilization overview
- % Done shown on bars
- Overdue issues → red outline
- Project filter → checkboxes to show/hide

**Dependencies:**
- Drag from circle → create relation
- Right-click arrow → remove relation
- Relation types: blocks, precedes, follows, relates, duplicates, copied

**Other:**
- Undo/redo for all edits
- Project bars show aggregate dates

### Time Sheet

Week-by-week time entry editing in a spreadsheet-style webview.

- Open via table icon in Time Entries pane header
- Cascading dropdowns: Client → Project → Task → Activity
- Daily hours input with dirty tracking and draft mode
- Undo/redo (`Ctrl+Z` / `Ctrl+Shift+Z`)
- Sortable columns, searchable issue picker
- Copy/paste rows, duplicate entries
- Custom fields support (required + optional)

### Timer (Pomodoro)

Structured work sessions with auto-logging.

1. `Ctrl+Y Ctrl+T` → choose number of units
2. Assign issues/activities to each unit
3. Work 45min → break 15min → repeat
4. Time auto-logged when unit completes

**Features:**
- Status bar countdown with progress bar
- Sound notification
- State persists across restarts
- Add/remove/reorder units
- Skip break option

### Kanban Board

Stage tasks before timing them.

- Add standalone tasks or link to Redmine issues
- Priority levels: High / Medium / Low
- Status: Todo → In Progress → Done
- Tasks grouped by client/project hierarchy
- Add to Today's Plan when ready

### Draft Mode

Queue write operations locally before sending to Redmine.

- Toggle via command palette or status bar
- Review panel to inspect, apply, or discard pending drafts
- Per-draft or bulk apply/discard
- Server identity validation
- Persists across restarts

### Quick Actions

| Action | How |
|--------|-----|
| Log time | `Ctrl+Y Ctrl+Y` → pick issue → enter hours (`2h`, `1:30`, `1.5`) |
| Create issue | `Ctrl+Y Ctrl+N` → project → tracker → subject → done |
| Create sub-issue | Right-click issue → Create Sub-Issue |
| Quick update | Right-click issue → Quick Update (batch changes) |
| View history | Right-click issue → View History |

### Status Bar

**Timer:** Shows countdown, issue number, progress (e.g., `32:15 #1234 [Dev] (3/6)`)

**Workload:** Enable to see `25h left, +8h buffer` *(opt-in)*

## All Settings

### Connection

| Setting | Description | Default |
|---------|-------------|---------|
| `redmyne.serverUrl` | Redmine server URL (HTTPS required) | — |
| `redmyne.logging.enabled` | Log API requests to output channel for debugging | `true` |
| `redmyne.maxConcurrentRequests` | Maximum concurrent API requests | `2` |

API keys stored via `Redmyne: Set API Key` command (encrypted keychain).

### Working Hours

| Setting | Description | Default |
|---------|-------------|---------|
| `redmyne.workingHours.weeklySchedule` | Hours per day for capacity calculations | 8h Mon-Fri |

```json
"redmyne.workingHours.weeklySchedule": {
  "Mon": 8, "Tue": 8, "Wed": 8, "Thu": 8, "Fri": 8,
  "Sat": 0, "Sun": 0
}
```

**Monthly overrides:** `Redmyne: Edit Monthly Working Hours` for varying FTE per month.

### Status Bar

| Setting | Description | Default |
|---------|-------------|---------|
| `redmyne.statusBar.showWorkload` | Show workload summary ("25h left, +8h buffer") | `false` |

### Behavior

| Setting | Description | Default |
|---------|-------------|---------|
| `redmyne.autoUpdateDonePercent` | Auto-update % Done when logging time (caps at 99%) | `false` |
| `redmyne.showCalculatedPriority` | Show calculated priority score in Gantt tooltips | `false` |
| `redmyne.gantt.visibleRelationTypes` | Relation types shown as dependency arrows in Gantt | `["blocks","precedes"]` |
| `redmyne.gantt.perfDebug` | Enable performance debug logging for Gantt | `false` |

### Tooltips & Display

| Setting | Description | Default |
|---------|-------------|---------|
| `redmyne.showProjectMembers` | Show project members in tooltips (Issues tree + Gantt) | `true` |
| `redmyne.hideProjectMembersFor` | Project IDs to exclude from member display | `[]` |

### Issue Tracking

| Setting | Description | Default |
|---------|-------------|---------|
| `redmyne.autoUpdateIssues` | Issue IDs that auto-update %done when logging time | `[]` |
| `redmyne.adHocBudgetIssues` | Issue IDs tagged as ad-hoc budget pools | `[]` |
| `redmyne.precedenceIssues` | Issue IDs scheduled before all others in Gantt | `[]` |

### Advanced

| Setting | Description | Default |
|---------|-------------|---------|
| `redmyne.caFile` | Custom CA certificate file path (PEM/CRT) for TLS validation | — |

## Requirements

- VS Code 1.105+ or Positron 2025.12.0+
- Redmine with REST API enabled (`/settings` → API tab)
- API key from My Account → API access key

## Security

- API keys stored in encrypted system keychain (Windows Credential Manager / macOS Keychain / Linux libsecret)
- HTTPS required — HTTP connections rejected
- Sensitive data redacted in API logs

---

## Why This Extension?

Redmine's web UI is for project managers: *"How is the project doing?"*

This extension is for developers: *"How is MY workload doing?"*

- What's assigned to me?
- Am I overbooked?
- How much did I log today?

Stay in your IDE. Stay in flow.

---

<details>
<summary>Commands Reference</summary>

| Command | Description |
|---------|-------------|
| `Redmyne: Set API Key` | Configure server URL and API key |
| `Log Time` | Log time with keyboard (Ctrl+Y Ctrl+Y) |
| `Create Issue` | Create issue wizard (Ctrl+Y Ctrl+N) |
| `Toggle Timer` | Start/stop timer (Ctrl+Y Ctrl+T) |
| `Show Gantt` | Open Gantt chart |
| `Time Sheet` | Open week-by-week time entry editor |
| `Redmyne: Edit Monthly Working Hours` | Configure FTE per month |
| `Redmyne: Show API Output` | View API request/response log |
| `Redmyne: Toggle API Logging` | Enable/disable request logging |
| `Redmyne: Review Drafts` | Review pending draft operations |
| `Redmyne: Apply All Drafts` | Send all queued drafts to Redmine |
| `Redmyne: Discard All Drafts` | Discard all pending drafts |

</details>

<details>
<summary>Development</summary>

```bash
npm install        # deps + git hooks
npm run compile    # build
npm test           # tests
npm run ci         # lint + typecheck + test
```

See [CONTRIBUTING.md](./CONTRIBUTING.md)

</details>

<details>
<summary>Attributions</summary>

Fork of [vscode-redmine](https://github.com/rozpuszczalny/vscode-redmine) by Tomasz Domański (MIT).

Contributors: Doğan Özdoğan (tree view), Markus Amshove (quick update).

Logo remixed from Redmine Logo © 2009 Martin Herr ([CC BY-SA 2.5](http://creativecommons.org/licenses/by-sa/2.5/)).

</details>

[Changelog](./CHANGELOG.md) · [Issues](https://github.com/vrognas/redmyne/issues)
