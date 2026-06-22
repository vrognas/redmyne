# Redmyne

![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/vrognas/vrognas-redmyne/ci.yml)
![Visual Studio Marketplace Downloads](https://img.shields.io/visual-studio-marketplace/d/vrognas.redmyne)
![GitHub License](https://img.shields.io/github/license/vrognas/vrognas-redmyne)

**Personal workload management for Redmine** — log time, track capacity, stay in flow.

Redmine's web UI answers *"How is the project doing?"* Redmyne answers *"How is **my** workload doing?"* — what's assigned to me, am I overbooked, how much did I log today — without leaving your IDE.

> [!NOTE]
> Actively developed and stable for daily use; expect the occasional breaking change. Please report issues.

## Quick Start

```
1. Install the extension
2. Ctrl+Shift+P → "Redmyne: Set API Key"
3. Enter your Redmine URL + API key
```

Your issues appear in the sidebar. Start logging time.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Y Ctrl+Y` | Quick log time — pick issue → hours (`2h`, `1:30`, `1.5`) |
| `Ctrl+Y Ctrl+N` | Quick create issue — project → tracker → subject |
| `Ctrl+Y Ctrl+T` | Toggle Pomodoro timer |
| `Ctrl+C` / `Ctrl+V` | Copy / paste in the Time Entries pane |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo (Gantt, Time Sheet) |

*(Mac: `Cmd` instead of `Ctrl`.)* Most other actions live on right-click in each view.

## Features

### Issues

Your assigned issues, grouped by project — Tree (hierarchy) or List (flat).

- **Filters:** My Open *(default)*, All Open, My Closed, My Issues, All Issues; **by Task Type** (a custom field); **show / hide empty projects**
- **Sort:** by #ID, Subject, or Assignee
- **Health colors:** 🔴 overbooked · 🟡 at risk · 🟢 on track (hours left vs. due date)
- **Right-click:** Quick Update (status + assignee + comment in one step), Log Time, Set % Done, Set Internal Estimate, Toggle Ad-Hoc Budget (then Contribute / Remove to route its hours to another issue), Create Sub-Issue, Create Version / Milestone, Show in Gantt, Add to Kanban, Open in Browser, Copy URL

### Time Entries

Logged time grouped by **Today**, **This Week**, **This Month**.

- **Filters:** My Time / All Users; **show / hide 0% days** (zero-utilization days hidden by default)
- **Sort:** by #ID, Subject, Comment, or User
- **Right-click / hover:** Edit, Delete, Open in Browser, Show in Gantt (jump to the issue on the timeline); on a date → Add Entry
- **Copy / paste** single entries, whole days, or weeks across dates
- Required + optional custom fields are prompted when logging time

### Time Sheet

Spreadsheet-style week editing in a webview (table icon in the Time Entries header).

- Cascading **Client → Project → Task → Activity** dropdowns
- Daily hours with dirty tracking, draft mode, undo / redo
- Sortable columns, searchable issue picker, copy / paste / duplicate rows, custom fields

### Gantt Chart

Interactive timeline for workload visualization.

- **Edit:** drag bar edges (start / due), drag the body (move both), right-click → Update dialog; full undo / redo
- **Select:** click rows (Ctrl / Shift / Ctrl+A for multi); click a bar to pin its highlight + dependency arrows; drag a selection to bulk-move
- **Navigate:** arrow keys, Home / End, Enter to act, minimap to jump
- **Colors** (theme-aware): bar **fill** = schedule health (done / on-track / at-risk / overbooked), **border** = state (overdue / projected-late / ad-hoc / external), **ghost bar** = projected finish past the due date. Hover any bar for the full breakdown.
- **View:** zoom Day *(default)* / Week / Month / Quarter / Year; lookback selector (2 Weeks → 10 Years, **default 6 Months**) bounds how far *back* the axis reaches — the right edge follows your furthest scheduled task; filters for task type and empty projects, plus toggles for intensity, critical path, capacity ribbon, late issues, and highlight-my-issues
- **Dependencies:** drag from a bar's circle to create a relation; right-click an arrow to remove (blocks, precedes, follows, relates, duplicates, copied)
- **Tooltips:** progress, flexibility, assignee, and an opt-in calculated priority score (due-date urgency + downstream dependencies)

### Kanban Board

Stage tasks before timing them.

- Standalone tasks or linked to Redmine issues; High / Medium / Low priority
- Todo → In Progress → Done, grouped by client / project; add to today's plan when ready

### Timer (Pomodoro)

Structured work sessions with auto-logging (`Ctrl+Y Ctrl+T`).

- Assign issues / activities to each unit; work 45 / break 15; time auto-logged when a unit completes
- Status-bar countdown + progress, sound notification, persists across restarts, skip-break option

### Draft Mode

Queue write operations locally before sending to Redmine.

- Toggle via the command palette or status bar
- Review panel to inspect, apply, or discard pending drafts (per-draft or bulk)
- Server-identity validation; persists across restarts

### Auto-tracking helpers

- **Auto-update % Done** — opt-in per issue; advances %Done from spent / estimated as you log (caps at 99%)
- **Ad-hoc budget pools** — tag an issue as a pool, then route its logged hours to other issues

## Status Bar

- **Timer:** countdown, issue, progress (e.g. `32:15 #1234 [Dev] (3/6)`)
- **Workload** *(opt-in):* `25h left, +8h buffer`

## Requirements

- VS Code 1.109+ or Positron 2026.04+
- Redmine with the REST API enabled (`/settings` → API tab)
- API key from My Account → API access key

## Security

- API keys stored in the encrypted system keychain (Windows Credential Manager / macOS Keychain / Linux libsecret) and never synced
- HTTPS required — HTTP connections are rejected
- Sensitive data redacted in API logs

<details>
<summary>Settings</summary>

Most are easiest to set in the VS Code Settings UI (search "Redmyne").

| Setting | Purpose | Default |
|---------|---------|---------|
| `redmyne.serverUrl` | Redmine server URL (HTTPS) | — |
| `redmyne.logging.enabled` | Log API requests to the output channel | `true` |
| `redmyne.maxConcurrentRequests` | Max concurrent API requests | `4` |
| `redmyne.taskTypeField` | Custom field name backing the Task Type filter | `Task Type` |
| `redmyne.workingHours.weeklySchedule` | Hours per day for capacity (e.g. 8h Mon–Fri) | 8h Mon–Fri |
| `redmyne.statusBar.showWorkload` | Show the workload summary | `false` |
| `redmyne.autoUpdateDonePercent` | Auto-advance %Done when logging time | `false` |
| `redmyne.autoUpdateIssues` | Issue IDs that auto-update %Done | `[]` |
| `redmyne.showCalculatedPriority` | Calculated priority score in Gantt tooltips | `false` |
| `redmyne.adHocBudgetIssues` | Issue IDs tagged as ad-hoc budget pools | `[]` |
| `redmyne.precedenceIssues` | Issue IDs scheduled before all others in Gantt | `[]` |
| `redmyne.gantt.visibleRelationTypes` | Relation types shown as Gantt arrows | `["blocks","precedes"]` |
| `redmyne.showProjectMembers` | Show project members in tooltips | `true` |
| `redmyne.hideProjectMembersFor` | Project IDs to exclude from member display | `[]` |
| `redmyne.caFile` | Custom CA certificate (PEM/CRT) for TLS | — |
| `redmyne.gantt.perfDebug` | Gantt performance debug logging | `false` |

Monthly hour overrides: `Redmyne: Edit Monthly Working Hours`.

</details>

<details>
<summary>Commands</summary>

| Command | Description |
|---------|-------------|
| `Redmyne: Set API Key` | Configure server URL and API key |
| `Log Time` | Log time (`Ctrl+Y Ctrl+Y`) |
| `Create Issue` | Create-issue wizard (`Ctrl+Y Ctrl+N`) |
| `Toggle Timer` | Start / stop the Pomodoro timer (`Ctrl+Y Ctrl+T`) |
| `Show Gantt` | Open the Gantt chart |
| `Time Sheet` | Open the week-by-week editor |
| `Redmyne: Edit Monthly Working Hours` | Configure FTE per month |
| `Redmyne: Show API Output` | View the API request / response log |
| `Redmyne: Toggle API Logging` | Enable / disable request logging |
| `Redmyne: Review Drafts` | Review pending draft operations |
| `Redmyne: Apply All Drafts` / `Discard All Drafts` | Send / discard all queued drafts |

</details>

<details>
<summary>Development</summary>

```bash
npm install        # deps + git hooks
npm run compile    # build
npm test           # tests (run via bash on Windows)
npm run ci         # lint + typecheck + test
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

</details>

<details>
<summary>Attributions</summary>

Fork of [vscode-redmine](https://github.com/rozpuszczalny/vscode-redmine) by Tomasz Domański (MIT). Contributors: Doğan Özdoğan (tree view), Markus Amshove (quick update). Logo remixed from the Redmine logo © 2009 Martin Herr ([CC BY-SA 2.5](http://creativecommons.org/licenses/by-sa/2.5/)).

</details>

[Changelog](./CHANGELOG.md) · [Issues](https://github.com/vrognas/vrognas-redmyne/issues)
