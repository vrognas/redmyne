# Redmyne

**Personal workload management for Redmine** — log time, track capacity, stay in flow.

<!-- TODO: Add screenshot/GIF here for marketplace -->

## Quick Start

```
1. Install extension
2. Ctrl+Shift+P → "Redmine: Set API Key"
3. Enter URL + API key
```

That's it. Your issues appear in the sidebar.

## What You Can Do

| Action | How |
|--------|-----|
| **Log time** | `Ctrl+Y Ctrl+Y` → pick issue → enter hours |
| **Create issue** | `Ctrl+Y Ctrl+N` → wizard without leaving IDE |
| **Start timer** | `Ctrl+Y Ctrl+T` → plan work units for the day |
| **See workload** | Click calendar icon → Gantt with heatmap |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Y Ctrl+Y` | Quick log time |
| `Ctrl+Y Ctrl+N` | Quick create issue |
| `Ctrl+Y Ctrl+T` | Plan day / toggle timer |

*(Mac: use `Cmd` instead of `Ctrl`)*

## Sidebar Views

| View | Purpose |
|------|---------|
| **Issues** | Your assigned issues by project. Filter, sort, right-click for actions. |
| **Kanban** | Stage tasks with notes before timing. Optional. |
| **Today's Plan** | Timer work units. 45min work + 15min break. |
| **Time Entries** | Logged time: Today, This Week, This Month. |

## Workload Visualization

### Issue Colors
- 🔴 **Overbooked** — not enough hours before due date
- 🟡 **At risk** — tight schedule
- 🟢 **On track** — comfortable buffer

### Status Bar
Enable `redmine.statusBar.showWorkload` to see: **"25h left, +8h buffer"**

### Gantt Chart
- Drag edges to adjust dates, drag bar to move both
- Multi-select with Ctrl+click, Shift+click, Ctrl+A
- Minimap for large projects
- Heatmap shows daily utilization (green → red)
- Critical path highlights blocking chains
- Dependency arrows (right-click to remove)
- Undo/redo for all edits

## Timer (Optional)

For structured work sessions:

1. `Ctrl+Y Ctrl+T` → choose number of units
2. Assign issues to each unit
3. Work 45min → break 15min → repeat
4. Time auto-logged when unit completes

State persists across restarts. Sound notification on completion.

## Settings

### Connection

| Setting | Default |
|---------|---------|
| `redmine.url` | *(required)* |
| `redmine.identifier` | `""` |
| `redmine.additionalHeaders` | `{}` |

### Working Hours

| Setting | Default |
|---------|---------|
| `redmine.workingHours.weeklySchedule` | 8h Mon-Fri |

```json
"redmine.workingHours.weeklySchedule": {
  "Mon": 10, "Tue": 10, "Wed": 10, "Thu": 10,
  "Fri": 0, "Sat": 0, "Sun": 0
}
```

Monthly overrides: `Redmine: Edit Monthly Working Hours`

### Behavior

| Setting | Default |
|---------|---------|
| `redmine.statusBar.showWorkload` | `false` |
| `redmine.timer.showInStatusBar` | `true` |
| `redmine.autoUpdateDoneRatio` | `true` |
| `redmine.logging.enabled` | `true` |
| `redmine.gantt.extendedRelationTypes` | `false` |

## Requirements

- VS Code 1.105+ or Positron 2025.06+
- Redmine with REST API enabled
- API key from My Account → API access key

## Security

- API keys in encrypted system keychain
- HTTPS required
- Sensitive data redacted in logs

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
