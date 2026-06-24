# Architecture

VS Code/Positron extension for Redmine workload management. TypeScript 5.9+.

**v4.40.0** | VS Code ≥1.109.0 | Node ≥20

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
│   ├── gantt-panel.ts    # SVG timeline, dependencies, heatmap
│   └── timesheet-panel.ts # Weekly timesheet grid editor
├── kanban/               # Personal task management (incl. work timer)
├── draft-mode/           # Offline write queueing
├── status-bars/          # Workload status bar
├── shared/               # Base classes (BaseTreeProvider, BaseStatusBar)
└── utilities/            # Helpers — see grouping below
```

`utilities/` (~48 files) groups loosely by theme:
- **Scheduling/calc**: `flexibility-calculator` (kernel), `capacity-calculator`,
  `workload-calculator`, `contribution-calculator`, `remaining-work`, `monthly-schedule`, `date-utils`
- **Issue domain**: `issue-*` (label/status/sorting/search/picker), `hierarchy-builder`, `dependency-graph`
- **Config/state trackers**: `config-id-set-tracker` + the ad-hoc/auto-update/precedence trackers, `config-change`, `migration`
- **Secrets/UI plumbing**: `secret-manager`, `server-url`, `webview-nonce`, `status-bar`, pickers, `wizard`
- Some scheduling files are Gantt-specific (single consumer) and are candidates to move under `webviews/gantt/`.

## Key Components

### RedmineServer (`src/redmine/redmine-server.ts`)
- HTTPS-only HTTP client with 30s timeout, bounded concurrency (`maxConcurrentRequests`)
- Offset/limit pagination (`paginate`), plus URL-length id-batching for bulk fetches
- Caching: per-instance memoization (statuses, activities, projects, current user,
  per-issue TTL) and a change-aware cache (`change-aware-cache.ts`) that probes
  `updated_on` to serve stale data when nothing changed
- Implements `IRedmineServer` (the dependency seam); decorated by `LoggingRedmineServer`
  and wrapped by `DraftModeServer`. DI via `requestFn` for testing — no module mocks

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
- **Windowed (virtualized) rendering** (v4.29.0): the extension ships a chrome
  skeleton + per-row SVG fragments (generated at y=0) + relation data; the
  webview mounts only viewport-intersecting rows (±10 buffer). A collapse
  toggle is a data operation: flip a key in the expanded set, recompute the
  visible list, remount ~40 rows. Zebra bands, indent guides, and dependency
  arrows are recomputed from data per refresh. Collapse state syncs back via
  `collapseStateSync`/`collapseStateSyncBulk` (bulk expand is additive — the
  webview only knows the current board's keys); the extension's payload memo
  is version-keyed on data revision + collapse version + display flags + date.
  Because elements churn (recycled with their classes, or materialized fresh
  without them), ALL interaction handlers are delegated and state-driven
  classes (selection, focus chain, arrow selection) re-sync from state in
  row-window refresh listeners; "find then act" paths resolve the key from
  row data and `scrollToKey` (scroll + mount) before querying the element
  (v4.29.1).
- Modular generation (`src/webviews/gantt/`):
  - `gantt-html-generator.ts`: per-row label/cell/bar fragments
  - `gantt-toolbar-generator.ts`: toolbar controls
  - `gantt-render-types.ts`: shared interfaces
  - `row-window.js`: windowed mounting + data-computed layers (webview)
  - `row-window-utils.js`: pure visible-list/band/span/range functions
  - `arrow-svg.js`: dependency-arrow path builder (webview). `computeArrowGeometry`
    is the ONLY arrow router — initial render and live drag updates both call it
    (a drag-local copy of the routing diverged once; don't reintroduce one)
  - `lookup-maps.js`: mounted-element lookup maps, rebuilt per refresh (webview)
  - `gantt-row-interaction.js`: collapse toggles, row selection, keyboard nav,
    hover band, and the capture-phase ghost guard — ghost projections are inert
    hover surfaces; ONE document-capture listener stops all their mouse events
    and row-selects on plain press (webview)
- Lateness/remaining-work judgments (late chip/filter, ghost projections, bar
  badges, arrow health, flexibility) all call `remainingHours()` in
  `src/utilities/remaining-work.ts` — the single owner of the
  internal-estimate-first / consumed-budget heuristic. Never inline a copy.

### TimesheetPanel (`src/webviews/timesheet-panel.ts`)
- Weekly grid editor for time entries (rows = issues, columns = days)
- Inline hour editing, paste, and draft-mode-aware writes
- Shares CSP/nonce + message-passing patterns with GanttPanel

### Kanban (`src/kanban/`)
- Local task management (todo/in-progress/done)
- Links to Redmine issues, priority levels
- Work timer (idle → working → paused → break), persisted to globalState
  (formerly the standalone `src/timer/`, now folded in — see `kanban-timer-handlers.ts`)

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
| Auto-update/Ad-hoc/Precedence issue IDs | VS Code settings (arrays) |
| Draft queue | globalStorageUri (file) |
| Config | VS Code settings |

## Build & Bundling

`esbuild.cjs` builds 5 data-driven targets (one `baseOpts` + per-target overrides):
- `src/extension.ts` → `out/extension.js` (CJS, node, external: `vscode`)
- `src/webviews/{gantt,timesheet}/index.js` → `media/{gantt,timesheet}.js` (IIFE, browser)
- `src/webviews/{gantt,timesheet}/styles.css` → `media/{gantt,timesheet}.css`

Production builds minify; `--watch` (dev) emits unminified + sourcemaps. The
`media/*` bundles are **generated and gitignored** (only vendored assets like
`flatpickr*` / `webview-common.css` are tracked); `vscode:prepublish` runs
`npm run compile` so the shipped bundle is always rebuilt. A 250KB VSIX size
gate runs in both CI and release.

## CI/CD

- **`ci.yml`** (push to main/develop + PRs): lint + typecheck + manifest validate
  + `npm audit`; cross-platform test matrix (ubuntu/windows/macos, coverage on
  ubuntu → Codecov); build + 250KB size gate. Concurrency cancels superseded PR runs.
- **`release.yml`** (tag `vX.Y.Z` or manual): verifies `package.json` matches the
  tag, re-runs tests/lint/compile, packages, size-gates, publishes to Open VSX +
  VS Code Marketplace, and creates the GitHub release. Never cancels in-flight.
- Node version is a single `NODE_VERSION` env per workflow; `package.json` engines
  is the supported floor. Commit messages validated by `scripts/commit-msg`
  (mirrored in CI via `scripts/validate-commits.sh`).

## Test

- **Vitest**, 88% line-coverage threshold (functions 78 / branches 72 / statements 88)
- **Isolation**: `isolate: true` + parallel files; avoid brittle cross-file singleton module mocks
- **HTTP mocking**: DI via `requestFn` (no module mocks); `vscode` aliased to `test/mocks/vscode.ts`

## Extension Points

- **Commands**: add to `src/commands/`, register in `extension.ts` (often via a
  `register*Commands` registrar module), declare in `package.json` (`commands` +
  `menus`; use `when: false` for context-only commands so they don't leak into the palette)
- **Tree views**: Extend `BaseTreeProvider`, register via `createTreeView()`
- **Status bars**: Extend `shared/base-status-bar.ts` (`BaseStatusBar`)
- **API methods**: Add to `RedmineServer`, use `doRequest<T>()`; mirror the signature in `IRedmineServer`
- **Config**: Update `package.json` → `contributes.configuration`

## Security

- API keys in encrypted platform keychain
- HTTPS enforced, TLS validation enabled (`rejectUnauthorized: true`)
- Optional `caFile` setting for custom CA trust (advanced fallback)
- Sensitive data redacted in logs
- CSP with crypto nonces in webviews

## Performance Patterns

- Server LRU cache (max 3 instances)
- Async tree loading with placeholders
- Working days memoization
- Config change debouncing (300ms)
- Concurrent fetch deduplication
