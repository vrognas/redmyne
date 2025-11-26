# Architecture Documentation

## Overview

Positron-Redmine is a VS Code/Positron IDE extension that integrates Redmine project management. Built on TypeScript 5.9+, it provides sidebar views, issue management, time tracking, and workload visualization via Redmine REST API.

**Core Pattern**: MVC-like with Tree Providers (View), Controllers (Business Logic), and RedmineServer (Model/API).

**Version**: 3.7.0 | **Min VS Code**: 1.106.0 | **Node**: >=20.0.0

## Directory Structure

```
positron-redmine/
├── src/
│   ├── extension.ts              # Entry point, lifecycle
│   ├── commands/                 # User-triggered actions
│   │   ├── commons/             # Shared utilities
│   │   ├── action-properties.ts
│   │   ├── list-open-issues-assigned-to-me.ts
│   │   ├── new-issue.ts
│   │   ├── open-actions-for-issue.ts
│   │   ├── open-actions-for-issue-under-cursor.ts
│   │   ├── quick-log-time.ts
│   │   └── set-api-key.ts
│   ├── controllers/             # Business logic
│   │   ├── domain.ts           # Domain models
│   │   └── issue-controller.ts # Issue operations
│   ├── redmine/                # API integration
│   │   ├── redmine-server.ts
│   │   ├── logging-redmine-server.ts
│   │   ├── redmine-project.ts
│   │   └── models/            # API response interfaces
│   ├── trees/                 # Tree view providers
│   │   ├── my-issues-tree.ts
│   │   ├── my-time-entries-tree.ts
│   │   └── projects-tree.ts
│   ├── webviews/              # Webview panels
│   │   └── gantt-panel.ts     # SVG timeline
│   ├── definitions/           # Configuration schemas
│   │   └── redmine-config.ts
│   └── utilities/             # Helpers
│       ├── api-logger.ts
│       ├── error-to-string.ts
│       ├── flexibility-calculator.ts
│       ├── redaction.ts
│       ├── secret-manager.ts
│       ├── time-input.ts      # Time parsing utilities
│       ├── tree-item-factory.ts
│       └── workload-calculator.ts
├── test/
│   ├── fixtures/              # Mock data
│   ├── mocks/                 # VS Code mocks
│   └── unit/                  # Vitest tests
├── scripts/                   # Git hooks
└── docs/                      # Documentation
```

## Component Architecture

### 1. Extension Entry Point (`src/extension.ts`)

**Responsibility**: Bootstrap extension, wire dependencies, manage lifecycle.

**Initialization Flow**:

```
activate()
  │
  ├─► Create server instance bucket (LRU cache, max 3)
  ├─► Initialize SecretManager & API log output channel
  ├─► Create tree providers (MyIssuesTree, ProjectsTree, MyTimeEntriesTree)
  ├─► Register tree views with VS Code
  ├─► Initialize workload status bar (opt-in)
  ├─► Listen for secret changes
  ├─► updateConfiguredContext()
  │   ├─► Check URL + API key presence
  │   ├─► Set redmine:configured context
  │   └─► Initialize server for trees
  ├─► Config change listener (300ms debounce)
  ├─► Register commands via registerCommand() wrapper
  └─► parseConfiguration() helper
      ├─► Workspace folder selection
      ├─► Config reading
      ├─► Server creation/reuse
      └─► Return ActionProperties
```

### 2. Redmine API Layer (`src/redmine/`)

#### RedmineServer (`redmine-server.ts`)

**Responsibility**: HTTP client for Redmine REST API with caching.

**Connection Options**:
```typescript
interface RedmineServerConnectionOptions {
  address: string;              // HTTPS required (https://redmine.example.com)
  key: string;                  // API key
  additionalHeaders?: object;   // Custom headers
  requestFn?: typeof http.request; // DI for testing
}
```

**HTTP Flow**:
```
doRequest(path, method, data?)
  ├─► Build request (hostname, port, headers, path)
  ├─► Handle response (401, 403, 404, 400+ errors)
  ├─► Success → Parse JSON, call onResponseSuccess()
  ├─► 30s timeout
  └─► Return Promise<T>
```

**Hooks for Logging**: `onResponseSuccess()`, `onResponseError()` - overridden by LoggingRedmineServer.

**API Methods**:

| Method | Purpose | Caching |
|--------|---------|---------|
| `getProjects()` | Paginated project fetch | No |
| `getTimeEntryActivities()` | Activity types | Yes (instance) |
| `addTimeEntry()` | Log time to issue | No |
| `getTimeEntries()` | User's time entries | No |
| `getIssueById()` | Single issue fetch | No |
| `setIssueStatus()` | Update issue status | No |
| `getIssueStatuses()` | All statuses | Yes (instance) |
| `getIssueStatusesTyped()` | Typed status list | Via getIssueStatuses |
| `getMemberships()` | Project members | No |
| `applyQuickUpdate()` | Batch issue update | No |
| `getIssuesAssignedToMe()` | Current user's issues | No |
| `getOpenIssuesForProject()` | Project issues | No |

**Pagination Pattern**: Recursive async function fetches all pages (offset/limit) until `total_count` reached.

#### LoggingRedmineServer (`logging-redmine-server.ts`)

**Pattern**: Decorator extending RedmineServer for API logging.

**Features**: Request/response logging, duration tracking, request correlation, stale request cleanup (60s).

### 3. Tree View Providers (`src/trees/`)

All tree providers implement `vscode.TreeDataProvider<T>`.

#### ProjectsTree (`projects-tree.ts`)

**Displays**: All projects with assigned issues grouped by project.

**Features**:
- Parallel fetch of projects AND assigned issues
- Issues grouped by project with flexibility scores
- Projects with assigned issues shown first (with count)
- Projects without assigned issues dimmed/deemphasized
- Risk-based issue sorting within projects (overbooked → at-risk → on-track → completed)
- Flexibility caching for status bar and Gantt integration

**View Modes**: LIST (flat) or TREE (hierarchical with parent/child).

**TreeItem Icons**: ThemeIcon with color coding (red: overbooked, yellow: at-risk, green: on-track/completed).

#### MyTimeEntriesTreeDataProvider (`my-time-entries-tree.ts`)

**Displays**: Time entries grouped by period (Today/Week/Month) with hours/percentage.

**Features**: Non-blocking async loading (<10ms initial render), parallel API requests, issue caching with batch fetching.

#### MyIssuesTree (`my-issues-tree.ts`) [Legacy]

**Note**: This tree is deprecated as of v3.8.0. Its functionality has been consolidated into ProjectsTree.

### 4. Commands (`src/commands/`)

**Registration Pattern**: Commands registered via `registerCommand()` wrapper that handles configuration parsing.

**Command Map**:

| Command | File | Trigger |
|---------|------|---------|
| `listOpenIssuesAssignedToMe` | list-open-issues-assigned-to-me.ts | Command palette |
| `openActionsForIssue` | open-actions-for-issue.ts | Tree click, input |
| `openActionsForIssueUnderCursor` | open-actions-for-issue-under-cursor.ts | Editor context |
| `newIssue` | new-issue.ts | Opens browser |
| `quickLogTime` | quick-log-time.ts | Ctrl+Y Ctrl+Y |
| `setApiKey` | set-api-key.ts | Command palette |
| `configure` | extension.ts (inline) | Tree header |
| `changeDefaultServer` | extension.ts (inline) | Multi-workspace |
| `refreshIssues` | extension.ts (inline) | Tree header |
| `refreshTimeEntries` | extension.ts (inline) | Tree header |
| `toggleTreeView` / `toggleListView` | extension.ts (inline) | Projects tree |
| `openTimeEntryInBrowser` | extension.ts (inline) | Time entry context |
| `openIssueInBrowser` | extension.ts (inline) | Issue context |
| `copyIssueUrl` | extension.ts (inline) | Issue context |
| `showApiOutput` | extension.ts (inline) | Debug |
| `clearApiOutput` | extension.ts (inline) | Debug |
| `toggleApiLogging` | extension.ts (inline) | Debug |

#### Quick Log Time (`quick-log-time.ts`)

**Flow**: Prompt for recent/new issue → pick activity → input hours (flexible formats: "1.75", "1:45", "1h 45min") → input comment → POST → cache → status bar confirmation.

### 5. Controllers (`src/controllers/`)

#### IssueController (`issue-controller.ts`)

**Responsibility**: Orchestrate issue operations via VS Code UI prompts.

**Actions**: Change status, add time entry, open in browser, quick update (batch: status + assignee + message).

#### Domain Models (`domain.ts`)

**Classes**: `Membership`, `IssueStatus`, `QuickUpdate`, `QuickUpdateResult`.

### 6. Utilities (`src/utilities/`)

#### SecretManager (`secret-manager.ts`)

**Responsibility**: Secure API key storage via VS Code Secrets API.

**Platform Storage**: Windows (Credential Manager), macOS (Keychain), Linux (libsecret/gnome-keyring).

#### Flexibility Calculator (`flexibility-calculator.ts`)

**Purpose**: Calculate issue timeline risk based on due date and remaining work.

**Formula**: `flexibility = (available_hours / needed_hours - 1) * 100`

**Status Thresholds**: completed (done_ratio = 100), overbooked (remaining < 0), at-risk (remaining < 20), on-track (remaining ≥ 20).

**Key Functions**: `calculateFlexibility()`, `countWorkingDays()` (memoized), `countAvailableHours()` (memoized).

#### Workload Calculator (`workload-calculator.ts`)

**Purpose**: Status bar summary across all assigned issues (total estimated/spent, remaining, available this week, buffer, top 3 urgent).

#### API Logger (`api-logger.ts`)

**Features**: Request/response formatting, sensitive data redaction, query param truncation, binary content detection.

### 7. Models (`src/redmine/models/`)

TypeScript interfaces matching Redmine API JSON: `Issue`, `TimeEntry`, `Project`, `Membership`, `IssueStatus`, `TimeEntryActivity`, `NamedEntity`.

## Data Flow Diagrams

### Configuration Flow

```
Extension Activates → updateConfiguredContext()
  ├─► Read workspace config (redmine.url)
  ├─► Get API key from SecretManager
  └─► Both present?
      ├─► Yes: Set redmine:configured=true, create server, set on trees, refresh
      └─► No: Set redmine:configured=false, clear servers
```

### Issue Actions Flow

```
User clicks issue → TreeItem.command → "redmine.openActionsForIssue"
  ├─► parseConfiguration() → ActionProperties
  ├─► server.getIssueById(id)
  ├─► new IssueController(issue, server)
  └─► listActions() → showQuickPick(actions) → execute action
      ├─► Change status: getIssueStatuses() → pick → setIssueStatus()
      ├─► Add time entry: getTimeEntryActivities() → pick → input hours/comment → POST
      ├─► Open in browser: vscode.open(issueUrl)
      └─► Quick update: get memberships/statuses → pick status/assignee → input message → POST
```

### Time Entry View Flow

```
getChildren(undefined) → Return cached or [loadingNode]
  ├─► Start loadTimeEntries() (async, non-blocking)
  └─► loadTimeEntries() (background)
      ├─► Parallel fetch: today/week/month
      ├─► Calculate totals/percentages
      ├─► Build group nodes, set cachedGroups
      └─► Fire onDidChangeTreeData → refresh view
```

## Configuration Schema

### Extension Settings (`package.json`)

| Setting | Type | Scope | Description |
|---------|------|-------|-------------|
| `redmine.url` | string | machine | Server URL (HTTPS required) |
| `redmine.apiKey` | string | machine | **DEPRECATED** - use Secrets |
| `redmine.identifier` | string | machine | Default project |
| `redmine.additionalHeaders` | object | machine | Custom headers |
| `redmine.logging.enabled` | boolean | machine | API logging |
| `redmine.workingHours.weeklySchedule` | object | application | Per-day hours |
| `redmine.workingHours.hoursPerDay` | number | application | **DEPRECATED** |
| `redmine.workingHours.workingDays` | array | application | **DEPRECATED** |
| `redmine.statusBar.showWorkload` | boolean | application | Enable workload |

### Weekly Schedule Format

```json
{
  "redmine.workingHours.weeklySchedule": {
    "Mon": 8, "Tue": 8, "Wed": 8, "Thu": 8, "Fri": 8,
    "Sat": 0, "Sun": 0
  }
}
```

### Context Variables

| Variable | Purpose |
|----------|---------|
| `redmine:configured` | Show/hide welcome views |
| `redmine:hasSingleConfig` | Show/hide server switcher |
| `redmine:treeViewStyle` | Projects view mode |

## Build System

### Build Configuration

**esbuild**: Bundle to CommonJS, minify in production, external: vscode.

**TypeScript**: ES2022, strict mode, bundler resolution, strict unused checks.

### NPM Scripts

| Script | Purpose |
|--------|---------|
| `compile` | Production build |
| `watch` | Development mode |
| `typecheck` | TypeScript validation |
| `lint` | ESLint check |
| `test` | Run Vitest |
| `test:coverage` | Coverage report |
| `ci` | lint + typecheck + test:coverage |
| `package` | Create VSIX |
| `clean` | Remove artifacts |

## Testing Strategy

**Framework**: Vitest with v8 coverage (60% target).

**Exclusions**: extension.ts, trees, UI-heavy commands, controllers, type definitions.

**HTTP Testing**: Dependency injection via `requestFn` parameter (avoids module mock hoisting).

## Security Considerations

**API Key Storage**: VS Code Secrets API (platform-native encryption), per-workspace scope, never synced.

**Logging Redaction**: Auto-redacts password, api_key, token, secret, auth, authorization, key.

**Network**: HTTPS required, TLS certificate validation always enabled, 30s timeout.

## Extension Points

**Adding Commands**: Create file in `src/commands/`, export default function, register in `extension.ts`, add to `package.json` → `contributes.commands`.

**Adding Tree Views**: Implement `TreeDataProvider<T>`, add EventEmitter, register via `createTreeView()`, add to `package.json` → `contributes.views`.

**Adding API Methods**: Add method to `RedmineServer`, use `doRequest<T>()`, create model interface if needed, consider caching.

**Adding Configuration**: Update `RedmineConfig` interface, add to `package.json` → `contributes.configuration.properties`, access via `vscode.workspace.getConfiguration()`.

## Performance Optimizations

**Optimizations**: Server LRU cache (max 3), status/activity caching, async tree loading (<10ms), working days memoization, config change debouncing (300ms), concurrent fetch deduplication.

**Patterns**: Non-blocking tree loading (fire-and-forget with loading placeholder), config debouncing (300ms timeout).

## Git Hooks

**commit-msg**: Validates subject ≤ 50 chars, blank line, body ≤ 72 chars (exceptions: merge/revert). Install via `npm run install-hooks`.

## Claude Code Hooks

Located in `scripts/hooks/`, configured in `.claude/settings.json`.

| Hook | Type | File | Purpose |
|------|------|------|---------|
| SessionStart | command | install_pkgs.sh | Install gh CLI, npm deps, validate Node |
| UserPromptSubmit | command | context-inject.sh | Inject git branch/status |
| PreCompact | command | pre-compact-log.sh | Log context compaction events |

## Dependencies

### Runtime

None (lodash removed in v3.0.0)

### Development

| Package | Purpose |
|---------|---------|
| typescript | Language |
| esbuild | Bundler |
| eslint | Linting |
| prettier | Formatting |
| vitest | Testing |
| @vitest/coverage-v8 | Coverage |
| @types/vscode | Type definitions |
| @types/node | Node types |
| @vscode/vsce | Packaging |
