# Redmyne

> **⚠️ This is a fork** of [vscode-redmine](https://github.com/rozpuszczalny/vscode-redmine) by Tomasz Domański (MIT licensed).
> This extension adds **personal workload management features** not present in the original.

**Personal workload management for developers using Redmine.**

## Why This Extension?

Redmine's web UI asks: *"How is the PROJECT doing?"* — release status, team activity, where time is being spent. It's built for project managers and stakeholders.

**This extension asks a different question: *"How is MY WORKLOAD doing?"***

- What's assigned to me?
- Am I overbooked this week?
- What should I work on next?
- How much time did I log today?

If you're a **developer** using Redmine, you don't need another project dashboard — you need **personal productivity tools** integrated into your IDE where you already work.

### Why not just use Redmine's web UI?

The web UI is great for project-level oversight, but switching contexts between your IDE and browser breaks flow. This extension keeps your task list, time logging, and timeline **right next to your code**.

### Why not RedmineX or other clients?

Desktop clients like RedmineX replicate Redmine's full project management interface. They're powerful, but they're still project-focused tools. This extension is intentionally focused on **your personal workflow** — minimal UI, fast actions, IDE integration.

**Think of it as:** Redmine for *you*, not Redmine for your *project*.

## What's Different From the Original?

| Feature | Original | This Fork |
|---------|----------|-----------|
| **Gantt Chart** | ❌ | ✅ Interactive timeline with drag-to-edit |
| **Workload Heatmap** | ❌ | ✅ Visual capacity utilization |
| **Quick Time Logging** | ❌ | ✅ Ctrl+Y Ctrl+Y shortcut |
| **Quick Create Issue** | ❌ | ✅ Ctrl+Y Ctrl+N wizard |
| **Flexibility Scoring** | ❌ | ✅ Overbooked/at-risk/on-track indicators |
| **Status Bar Workload** | ❌ | ✅ "25h left, +8h buffer" |
| **Sub-Issue Creation** | ❌ | ✅ Right-click context menu |
| **Time Entry View** | ❌ | ✅ Today/Week/Month grouping |

## Features

### Workload Visualization
- **Gantt Chart** - interactive timeline with drag-to-edit dates, dependency arrows, undo/redo
- **Workload Heatmap** - color-coded daily utilization (green → red)
- **Flexibility Scoring** - issues marked as overbooked/at-risk/on-track
- **Status Bar** - "25h left, +8h buffer" at a glance

### Quick Actions
- **Quick Time Logging** (Ctrl+Y Ctrl+Y) - flexible formats: `2.5`, `1:45`, `1h 45min`
- **Quick Create Issue** (Ctrl+Y Ctrl+N) - full wizard without leaving IDE
- **Create Sub-Issue** - right-click context menu

### Sidebar
- Issues assigned to you, grouped by project
- Time entries grouped by Today/Week/Month
- Issue actions: change status, log time, quick update

### Workflow

The sidebar views follow a natural planning flow:

**My Issues** → **Personal Tasks** → **Today's Plan** → **My Time Entries**

1. **My Issues** - Issues assigned to you in Redmine
2. **Personal Tasks** - Your staging area for planning (add issues here to work on later)
3. **Today's Plan** - What you're working on today (timed work units)
4. **My Time Entries** - Time logged back to Redmine

## Compatibility

This extension works with both **Positron IDE** and **VS Code**.

## Requirements

- VS Code 1.106.0+
- Redmine with REST API enabled (`/settings?tab=api`, requires admin)
- API key from Redmine account (`/my/account`)

## Quick Start

1. Install extension
2. Run: `Redmine: Set API Key`
3. Enter URL and API key
4. Done!

## Security

API keys stored in VS Code Secrets (encrypted, machine-local).

## Migrating from v2.x

See [Migration Guide](./MIGRATION_GUIDE.md).

## Extension Settings

| Setting | Description |
|---------|-------------|
| `redmine.url` | Redmine server URL (HTTPS required) |
| `redmine.identifier` | Default project identifier |
| `redmine.additionalHeaders` | Custom HTTP headers |
| `redmine.workingHours.weeklySchedule` | Hours per day for capacity calculations |
| `redmine.statusBar.showWorkload` | Show workload summary in status bar |

API keys are stored securely via `Redmine: Set API Key` command.

## Development Setup

After cloning:

```bash
npm install
npm run install-hooks
```

Git hooks validate commit messages (subject ≤50 chars, body ≤72 chars).

## Contribution

If you want to contribute to the project, please read [contributing guide](./CONTRIBUTING.md) guide.

## Known Issues

No known issues yet. If you found one, feel free to open an issue!

## Release Notes

See [change log](./CHANGELOG.md)

## Contributors

This extension builds upon the excellent work of:

- **Tomasz Domański** ([@rozpuszczalny](https://github.com/rozpuszczalny)) - Original author
- **Doğan Özdoğan** - Tree view feature
- **Markus Amshove** - Quick update feature

## Attributions

### Original Project

This extension is a fork of [vscode-redmine](https://github.com/rozpuszczalny/vscode-redmine) by Tomasz Domański.

Copyright 2018 Tomasz Domański. Licensed under the MIT License.

### Logo

Logo is remixed version of original Redmine Logo.

Redmine Logo is Copyright (C) 2009 Martin Herr and is licensed under the Creative Commons Attribution-Share Alike 2.5 Generic license.
See http://creativecommons.org/licenses/by-sa/2.5/ for more details.
