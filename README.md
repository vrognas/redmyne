# Redmyne

> **Fork** of [vscode-redmine](https://github.com/rozpuszczalny/vscode-redmine) by Tomasz Domański (MIT).
> Adds **personal workload management** not in the original.

**Personal workload management for developers using Redmine.**

## Why This Extension?

Redmine's web UI asks: *"How is the PROJECT doing?"* — release status, team activity, where time is being spent. It's built for project managers.

**This extension asks: *"How is MY WORKLOAD doing?"***

- What's assigned to me?
- Am I overbooked this week?
- What should I work on next?
- How much time did I log today?

**Think of it as:** Redmine for *you*, not Redmine for your *project*.

## What's Different From the Original?

| Feature | Original | This Fork |
|---------|----------|-----------|
| **Gantt Chart** | - | Interactive timeline, drag-to-edit, minimap, critical path |
| **Pomodoro Timer** | - | Ctrl+Y Ctrl+T, work units with auto-logging |
| **Kanban Board** | - | Personal task staging before timing |
| **Quick Time Logging** | - | Ctrl+Y Ctrl+Y, flexible formats |
| **Quick Create Issue** | - | Ctrl+Y Ctrl+N wizard |
| **Workload Heatmap** | - | Color-coded daily utilization |
| **Flexibility Scoring** | - | Overbooked/at-risk/on-track indicators |
| **Status Bar** | - | "25h left, +8h buffer" at a glance |
| **Filter & Sort** | - | My/All issues, sort by ID/Subject/Assignee |

## Features

### Gantt Chart
- Interactive timeline with drag-to-edit start/due dates
- Drag bar body to move both dates together
- Multi-select (Ctrl+click, Shift+click, Ctrl+A) with bulk drag
- Minimap for navigation on large projects
- Critical path highlighting (blocks/precedes chains)
- Dependency arrows with right-click to remove
- Workload heatmap overlay (green → red utilization)
- Project filter checkboxes to show/hide issues
- Keyboard navigation (arrows, Home/End, Enter)
- Undo/redo for all edits

### Timer (Pomodoro-style)
- **Ctrl+Y Ctrl+T** - Plan work units for the day
- 45min work + 15min break cycles (configurable)
- Auto-log time to Redmine when unit completes
- Status bar countdown with issue context
- "Today's Plan" tree view shows all units
- Sound notification on completion
- State persists across VS Code restarts

### Kanban Board
- Stage tasks before timing them
- Priority levels (high/medium/low)
- Link to Redmine issues or standalone tasks
- Drag between todo/in-progress/done columns

### Quick Actions
- **Ctrl+Y Ctrl+Y** - Quick time logging (formats: `2.5`, `1:45`, `1h 45min`)
- **Ctrl+Y Ctrl+N** - Quick create issue wizard
- **Ctrl+Y Ctrl+T** - Plan timer units
- Right-click issue → Create sub-issue

### Sidebar Views
- **Issues** - Grouped by project, filter (My/All Open/Closed), sort by ID/Subject/Assignee
- **Kanban** - Personal task board
- **Today's Plan** - Timer work units
- **Time Entries** - Today/Week/Month with hours totals

### Workload Visualization
- **Flexibility scoring** - Issues marked overbooked (red), at-risk (yellow), on-track (green)
- **Status bar** - "25h left, +8h buffer" summary
- **Gantt heatmap** - Daily capacity utilization

### Workflow

**Issues** → **Kanban** → **Today's Plan** → **Time Entries**

1. **Issues** - Find work (filter: My Open, All Open, My Closed, All Issues)
2. **Kanban** - Stage tasks with notes
3. **Today's Plan** - Timer-tracked work units
4. **Time Entries** - View logged time (filter: My Time, All Users)

## Compatibility

Works with **VS Code** and **Positron IDE**.

## Requirements

- VS Code 1.105.0+ or Positron 2025.06.0+
- Redmine with REST API enabled (`/settings?tab=api`, requires admin)
- API key from Redmine account (`/my/account`)

## Quick Start

1. Install extension
2. Run: `Redmine: Set API Key`
3. Enter URL and API key
4. Done!

## Security

- API keys stored in VS Code Secrets (encrypted, machine-local)
- HTTPS required (HTTP rejected)
- Sensitive data redacted in API logs

## Extension Settings

### Connection

| Setting | Description | Default |
|---------|-------------|---------|
| `redmine.url` | Redmine server URL (HTTPS required) | - |
| `redmine.identifier` | Default project identifier | `""` |
| `redmine.additionalHeaders` | Custom HTTP headers (e.g., auth proxy) | `{}` |

API keys stored securely via `Redmine: Set API Key` command.

### Working Hours

| Setting | Description | Default |
|---------|-------------|---------|
| `redmine.workingHours.weeklySchedule` | Hours per day (Mon-Sun) for capacity calculations | 8h Mon-Fri |

Example for 4-day week:
```json
"redmine.workingHours.weeklySchedule": {
  "Mon": 10, "Tue": 10, "Wed": 10, "Thu": 10,
  "Fri": 0, "Sat": 0, "Sun": 0
}
```

Monthly overrides: `Redmine: Edit Monthly Working Hours` command.

### UI & Behavior

| Setting | Description | Default |
|---------|-------------|---------|
| `redmine.statusBar.showWorkload` | Show "25h left, +8h buffer" in status bar | `false` |
| `redmine.timer.showInStatusBar` | Show timer countdown in status bar | `true` |
| `redmine.autoUpdateDoneRatio` | Auto-update %done when logging time (caps at 99%) | `true` |
| `redmine.logging.enabled` | Log API requests to output channel | `true` |
| `redmine.gantt.extendedRelationTypes` | Enable Gantt plugin relation types (FS/SS/FF/SF) | `false` |

## Development

```bash
npm install        # installs deps + git hooks
npm run compile    # build
npm test           # run tests
npm run ci         # lint + typecheck + test
```

## Contribution

See [contributing guide](./CONTRIBUTING.md).

## Known Issues

None. [Open an issue](https://github.com/vrognas/redmyne/issues) if you find one!

## Release Notes

See [CHANGELOG](./CHANGELOG.md).

## Contributors

- **Tomasz Domański** ([@rozpuszczalny](https://github.com/rozpuszczalny)) - Original author
- **Doğan Özdoğan** - Tree view feature
- **Markus Amshove** - Quick update feature

## Attributions

### Original Project

Fork of [vscode-redmine](https://github.com/rozpuszczalny/vscode-redmine) by Tomasz Domański.
Copyright 2018 Tomasz Domański. MIT License.

### Logo

Remixed from Redmine Logo. Copyright (C) 2009 Martin Herr.
Licensed under [CC BY-SA 2.5](http://creativecommons.org/licenses/by-sa/2.5/).
