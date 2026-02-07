# Architecture

VS Code/Positron extension for Redmine workload management. TypeScript 5.9+.

**v4.16.0** | VS Code ≥1.105.0 | Node ≥20

## Core Pattern

MVC-like: Tree Providers (View) → Controllers (Logic) → RedmineServer (Model/API)

## Directory Structure

```
src/
├── extension.ts          # Entry point, lifecycle, command registration
├── commands/             # User actions (quick log, create issue, etc.)
├── controllers/          # Business logic orchestration
├── redmine/              # API client + models
│   ├── redmine-server.ts         # HTTP client, pagination, caching
│   ├── logging-redmine-server.ts # Decorator for API logging
│   └── models/                   # TypeScript interfaces
├── trees/                # Tree view providers
│   ├── projects-tree.ts          # Issues by project, filters, sorting
│   └── my-time-entries-tree.ts   # Time entries by period
├── webviews/
│   └── gantt-panel.ts    # SVG timeline, dependencies, heatmap
├── timer/                # Pomodoro-style work units
├── kanban/               # Personal task management
├── draft-mode/           # Offline write queueing
├── status-bars/          # Workload status bar
├── shared/               # Base classes (BaseTreeProvider)
└── utilities/            # Helpers (secrets, flexibility calc, etc.)
```

## Key Components

### RedmineServer (`src/redmine/redmine-server.ts`)
- HTTPS-only HTTP client with 30s timeout
- Recursive pagination for large datasets
- Instance-level caching (statuses, activities)
- DI support via `requestFn` for testing

### ProjectsTree (`src/trees/projects-tree.ts`)
- Issues grouped by project with flexibility scoring
- Filters: My Open / All Open / My Closed / All
- Sorting: ID / Subject / Assignee (+ risk-based)
- View modes: LIST (flat) or TREE (hierarchical)

### GanttPanel (`src/webviews/gantt-panel.ts`)
- Interactive SVG timeline with drag-to-edit
- Dependency arrows, workload heatmap
- Multi-select, minimap, critical path
- Undo/redo, keyboard navigation
- Modular HTML generation (`src/webviews/gantt/`):
  - `gantt-html-generator.ts`: labels, cells, bars
  - `gantt-toolbar-generator.ts`: toolbar controls
  - `gantt-render-types.ts`: shared interfaces

### Timer (`src/timer/`)
- State machine: idle → working → paused → logging → break
- Per-unit work sessions with customizable durations
- Persists to globalState across sessions

### Kanban (`src/kanban/`)
- Local task management (todo/in-progress/done)
- Links to Redmine issues, priority levels

### Draft Mode (`src/draft-mode/`)
- Intercepts write operations when enabled
- DraftModeServer wraps RedmineServer, queues writes
- DraftQueue persists to globalStorageUri file
- Server identity check prevents misapplying drafts
- Conflict resolution: latest wins per resource key

## Data Flow

```
Config (`redmyne.serverUrl`) + SecretManager (API key)
    ↓
RedmineServer instance (LRU cache, max 3)
    ↓
Tree Providers fetch → cache → render
    ↓
Commands execute actions → API calls → refresh trees
```

## State Storage

| Data | Storage |
|------|---------|
| API Key | VS Code Secrets API (encrypted) |
| Collapse state, filters | globalState (memento) |
| Timer/Kanban state | globalState |
| Draft queue | globalStorageUri (file) |
| Config | VS Code settings |

## Build & Test

- **Bundler**: esbuild → CJS (external: vscode)
- **Tests**: Vitest, 60% coverage target
- **Test isolation**: `isolate: false` + parallel files; avoid brittle cross-file singleton module mocks
- **HTTP mocking**: DI via `requestFn` (no module mocks)
- **Scripts**: `npm run compile`, `test`, `lint`, `ci`

## Extension Points

- **Commands**: Add to `src/commands/`, register in `extension.ts`, add to `package.json`
- **Tree views**: Extend `BaseTreeProvider`, register via `createTreeView()`
- **API methods**: Add to `RedmineServer`, use `doRequest<T>()`
- **Config**: Update `package.json` → `contributes.configuration`

## Security

- API keys in encrypted platform keychain
- HTTPS enforced, TLS validation enabled
- Sensitive data redacted in logs
- CSP with crypto nonces in webviews

## Performance Patterns

- Server LRU cache (max 3 instances)
- Async tree loading with placeholders
- Working days memoization
- Config change debouncing (300ms)
- Concurrent fetch deduplication
