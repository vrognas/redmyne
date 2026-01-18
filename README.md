# Redmyne

**Personal workload management for Redmine** — log time, track capacity, stay in flow.

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
| `Ctrl+Y Ctrl+T` | Plan day / toggle timer |

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
- Heatmap toggle → daily utilization (green → red)
- Critical path toggle → highlight blocking chains
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

### Timer (Pomodoro)

Structured work sessions with auto-logging.

1. `Ctrl+Y Ctrl+T` → choose number of units
2. Assign issues/activities to each unit
3. Work 45min → break 15min → repeat
4. Time auto-logged when unit completes

**Features:**
- Status bar countdown
- Sound notification
- State persists across restarts
- Add/remove/reorder units
- Skip break option

### Kanban Board

Stage tasks before timing them.

- Add standalone tasks or link to Redmine issues
- Priority levels: High / Medium / Low
- Status: Todo → In Progress → Done
- Add to Today's Plan when ready

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
| `redmine.url` | Redmine server URL (HTTPS required) | — |
| `redmine.identifier` | Default project identifier | `""` |
| `redmine.additionalHeaders` | Custom HTTP headers for auth proxies | `{}` |

API keys stored via `Redmyne: Set API Key` command (encrypted keychain).

### Working Hours

| Setting | Description | Default |
|---------|-------------|---------|
| `redmine.workingHours.weeklySchedule` | Hours per day for capacity calculations | 8h Mon-Fri |

```json
"redmine.workingHours.weeklySchedule": {
  "Mon": 8, "Tue": 8, "Wed": 8, "Thu": 8, "Fri": 8,
  "Sat": 0, "Sun": 0
}
```

**Monthly overrides:** `Redmine: Edit Monthly Working Hours` for varying FTE per month.

### Status Bar

| Setting | Description | Default |
|---------|-------------|---------|
| `redmine.statusBar.showWorkload` | Show workload summary ("25h left, +8h buffer") | `false` |
| `redmine.timer.showInStatusBar` | Show timer countdown | `true` |

### Behavior

| Setting | Description | Default |
|---------|-------------|---------|
| `redmine.autoUpdateDoneRatio` | Auto-update % Done when logging time (caps at 99%) | `true` |
| `redmine.logging.enabled` | Log API requests to output channel for debugging | `true` |
| `redmine.gantt.extendedRelationTypes` | Enable Gantt plugin relation types (FS/SS/FF/SF) | `false` |

## Requirements

- VS Code 1.105+ or Positron 2025.06+
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
| `Redmyne: Quick Log Time` | Log time with keyboard (Ctrl+Y Ctrl+Y) |
| `Redmyne: Quick Create Issue` | Create issue wizard (Ctrl+Y Ctrl+N) |
| `Redmyne: Plan Day` | Set up timer work units (Ctrl+Y Ctrl+T) |
| `Redmyne: Show Gantt` | Open Gantt chart |
| `Redmyne: Edit Monthly Working Hours` | Configure FTE per month |
| `Redmyne: Show API Output` | View API request/response log |
| `Redmyne: Toggle API Logging` | Enable/disable request logging |

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
