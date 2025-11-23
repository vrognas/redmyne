# Architecture Documentation

## Overview

Positron-Redmine is a VS Code/Positron IDE extension that integrates Redmine project management. Built on TypeScript, it provides sidebar views, issue management, and time tracking via Redmine REST API.

**Core Pattern**: MVC-like with Tree Providers (View), Controllers (Business Logic), and RedmineServer (Model/API).

## Project Structure

```
positron-redmine/
├── src/
│   ├── extension.ts              # Entry point - registers commands, trees
│   ├── commands/                 # User-triggered actions
│   │   ├── commons/             # Shared command utilities
│   │   ├── new-issue.ts
│   │   ├── open-actions-for-issue.ts
│   │   ├── open-actions-for-issue-under-cursor.ts
│   │   ├── list-open-issues-assigned-to-me.ts
│   │   └── action-properties.ts # Command parameter interface
│   ├── controllers/             # Business logic layer
│   │   ├── domain.ts           # Domain models (Membership, IssueStatus, QuickUpdate)
│   │   └── issue-controller.ts # Issue operations orchestration
│   ├── redmine/                # Redmine API integration
│   │   ├── redmine-server.ts  # HTTP client, API methods
│   │   ├── redmine-project.ts # Project representation
│   │   └── models/            # API response models
│   │       ├── issue.ts
│   │       ├── project.ts
│   │       ├── membership.ts
│   │       ├── issue-status.ts
│   │       ├── time-entry.ts
│   │       ├── time-entry-activity.ts
│   │       └── named-entity.ts
│   ├── trees/                 # VS Code tree view providers
│   │   ├── my-issues-tree.ts  # "Issues assigned to me" view
│   │   └── projects-tree.ts   # "Projects" view (list/tree modes)
│   ├── definitions/           # TypeScript interfaces
│   │   └── redmine-config.ts  # Extension configuration schema
│   └── utilities/             # Helper functions
│       ├── error-to-string.ts
│       └── secret-manager.ts  # Secure API key storage
├── docs/                      # Documentation
│   ├── ARCHITECTURE.md       # This file
│   └── LESSONS_LEARNED.md    # Development insights
├── package.json              # Extension manifest
├── tsconfig.json            # TypeScript config
└── esbuild.js               # Build configuration
```

## Core Components

### 1. Extension Entry (`src/extension.ts`)

**Responsibility**: Bootstrap extension, wire dependencies.

**Key Functions**:

- `activate()`: Entry point called by VS Code
  - Initializes `RedmineSecretManager` for secure API key storage
  - Initializes tree providers (`MyIssuesTree`, `ProjectsTree`)
  - Registers commands with `registerCommand()` wrapper
  - Sets up configuration parsing via `parseConfiguration()`
  - Updates context (`updateConfiguredContext()`) to check URL + API key presence
  - Listens for secret changes via `secretManager.onSecretChanged()`
  - Manages server instance bucket for reuse

**Configuration System**:

```typescript
parseConfiguration(withPick, props?, ...args)
  → Prompts workspace folder selection (multi-root workspace)
  → Reads redmine.* config from workspace settings
  → Retrieves API key from RedmineSecretManager (v3.0+)
  → Creates/reuses RedmineServer instance with URL + API key
  → Returns ActionProperties { server, config }
```

**Server Bucket**: Caches `RedmineServer` instances to avoid duplicate connections with same credentials.

### 2. Redmine API Layer (`src/redmine/`)

#### RedmineServer (`redmine-server.ts`)

**Responsibility**: HTTP client for Redmine REST API.

**Key Features**:

- Protocol-agnostic (http/https) via Node.js `http`/`https` modules
- Authentication via `X-Redmine-API-Key` header
- Caching for statuses, activities (rarely change)
- Error handling (401, 403, 404)

**Core Methods**:

```typescript
doRequest<T>(path, method, data?): Promise<T>  // Low-level HTTP
getProjects(): Promise<RedmineProject[]>       // Paginated fetch
getIssuesAssignedToMe(): Promise<{issues}>
getOpenIssuesForProject(id, subprojects?): Promise<{issues}>
getIssueById(id): Promise<{issue}>
setIssueStatus(issue, statusId): Promise<void>
addTimeEntry(issueId, activityId, hours, msg): Promise<void>
applyQuickUpdate(quickUpdate): Promise<QuickUpdateResult>
getIssueStatuses(): Promise<{issue_statuses}>  // Cached
getTimeEntryActivities(): Promise<{time_entry_activities}>  // Cached
getMemberships(projectId): Promise<Membership[]>
```

**Connection Options**:

- `address`: Base URL (e.g., `https://redmine.example.com`)
- `key`: API key from user's Redmine account
- `rejectUnauthorized`: SSL cert validation (default: false)
- `additionalHeaders`: Custom headers (e.g., auth proxies)

#### RedmineProject (`redmine-project.ts`)

**Responsibility**: Project data representation.

**Properties**: `id`, `name`, `description`, `identifier`, `parent` (for hierarchy).

**Methods**: `toQuickPickItem()` - converts to VS Code picker format.

#### Models (`src/redmine/models/`)

**Purpose**: TypeScript interfaces matching Redmine JSON responses.

**Key Models**:

- `Issue`: Full issue data (id, subject, status, assignee, etc.)
- `Project`: Project metadata
- `Membership`: User/group with project access
- `IssueStatus`: Status definition
- `TimeEntry`: Time log entry
- `TimeEntryActivity`: Activity types (development, testing, etc.)
- `NamedEntity`: Base interface for entities with id+name

### 3. Tree View Providers (`src/trees/`)

#### MyIssuesTree (`my-issues-tree.ts`)

**Implements**: `vscode.TreeDataProvider<Issue>`

**Purpose**: Displays issues assigned to current user in sidebar.

**Data Source**: `RedmineServer.getIssuesAssignedToMe()`

**Tree Item Format**: `#123 [Bug] (New) Fix login by John Doe`

**Click Action**: Opens issue actions menu.

**Refresh**: Triggered via `onDidChangeTreeData$` EventEmitter.

#### ProjectsTree (`projects-tree.ts`)

**Implements**: `vscode.TreeDataProvider<RedmineProject | Issue>`

**Purpose**: Hierarchical project/issue browser.

**View Modes** (via `ProjectsViewStyle` enum):

- **LIST**: Flat project list
- **TREE**: Hierarchical (respects project parent/child relationships)

**Data Flow**:

```
getChildren(undefined) → All projects (root level)
getChildren(project) → Subprojects + issues for that project
```

**Caching**: Projects cached in `projects` property, cleared on refresh.

**Commands**:

- `toggleTreeView`: Switch to LIST mode
- `toggleListView`: Switch to TREE mode

### 4. Commands (`src/commands/`)

**Pattern**: Each command exports default function accepting `ActionProperties`.

**Registration**: Via `registerCommand()` wrapper in `extension.ts`, which:

1. Prefixes with `redmine.` namespace
2. Handles configuration parsing
3. Passes `ActionProperties` to command function

**Command Implementations**:

| Command                             | File                                     | Purpose                                    |
| ----------------------------------- | ---------------------------------------- | ------------------------------------------ |
| `listOpenIssuesAssignedToMe`        | `list-open-issues-assigned-to-me.ts`     | Shows quick pick of user's issues          |
| `openActionsForIssue`               | `open-actions-for-issue.ts`              | Issue actions menu (status, time, browser) |
| `openActionsForIssueUnderCursor`    | `open-actions-for-issue-under-cursor.ts` | Extracts issue # from text, opens actions  |
| `newIssue`                          | `new-issue.ts`                           | Opens browser to Redmine new issue form    |
| `setApiKey`                         | `set-api-key.ts`                         | Securely stores API key in VS Code Secrets |
| `changeDefaultServer`               | (inline in extension.ts)                 | Switches active server in trees            |
| `refreshIssues`                     | (inline)                                 | Clears cache, refreshes trees              |
| `toggleTreeView` / `toggleListView` | (inline)                                 | Toggle project view mode                   |

**ActionProperties Interface** (`action-properties.ts`):

```typescript
{
  server: RedmineServer,
  config: RedmineConfig
}
```

### 5. Controllers (`src/controllers/`)

#### IssueController (`issue-controller.ts`)

**Responsibility**: Orchestrates issue operations via interactive prompts.

**Constructor**: `(issue: Issue, redmine: RedmineServer)`

**Public Method**: `listActions()` - Shows action menu with 4 options:

**Actions**:

1. **changeStatus()**:
   - Fetches available statuses
   - Shows quick pick
   - Calls `RedmineServer.setIssueStatus()`

2. **addTimeEntry()**:
   - Fetches activity types (Development, Testing, etc.)
   - Prompts for activity via `chooseTimeEntryType()`
   - Prompts for `hours|message` format via `setTimeEntryMessage()`
   - Calls `RedmineServer.addTimeEntry()`

3. **openInBrowser()**:
   - Constructs issue URL: `{server}/issues/{id}`
   - Opens via `vscode.open` command

4. **quickUpdate()**:
   - Fetches memberships, statuses
   - Sequential prompts: status → assignee → message
   - Applies all changes atomically via `RedmineServer.applyQuickUpdate()`
   - Validates changes (shows warnings if partial success)

#### Domain Models (`domain.ts`)

**Classes**:

- `Membership`: User/group (id, name, isUser flag)
- `IssueStatus`: Status with id+name
- `QuickUpdate`: Batch update request (issueId, message, assignee, status)
- `QuickUpdateResult`: Response with `differences[]` array for validation

### 6. Configuration (`src/definitions/redmine-config.ts`)

**Extension Settings** (defined in `package.json`):

| Setting                      | Type    | Description                                                   |
| ---------------------------- | ------- | ------------------------------------------------------------- |
| `redmine.url`                | string  | Server URL (e.g., `https://redmine.example.com:8443/redmine`) |
| `redmine.rejectUnauthorized` | boolean | SSL cert validation (for self-signed certs)                   |
| `redmine.identifier`         | string  | Default project identifier for new issues                     |
| `redmine.additionalHeaders`  | object  | Custom HTTP headers                                           |

**API Key Storage** (v3.0+): Stored securely via VS Code Secrets API (platform-native encryption), not in settings. Use `Redmine: Set API Key` command.

**Workspace Support**: All settings scoped to `resource` (multi-root workspace).

## Data Flow

### Issue Actions Flow

```
User clicks issue in tree
  → Tree item command triggers "redmine.openActionsForIssue"
  → Command calls RedmineServer.getIssueById()
  → Creates IssueController with issue+server
  → IssueController.listActions() shows menu
  → User selects action (e.g., "Change status")
  → Controller prompts for new status
  → Controller calls RedmineServer.setIssueStatus()
  → Shows success/error message
```

### Tree Refresh Flow

```
User clicks refresh button
  → "redmine.refreshIssues" command
  → Calls ProjectsTree.clearProjects()
  → Fires onDidChangeTreeData$ event
  → VS Code calls getChildren() on tree providers
  → Trees fetch fresh data from RedmineServer
  → UI updates
```

### Configuration Flow

```
Extension activates
  → Reads workspace.getConfiguration("redmine")
  → Creates RedmineServer with config
  → Passes to tree providers
User changes config or workspace folder
  → parseConfiguration() called
  → New RedmineServer created/retrieved from bucket
  → Trees updated via changeDefaultServer command
```

## Key File Locations

### Entry Points

- **Extension activation**: `src/extension.ts:13` (`activate()`)
- **Extension deactivation**: `src/extension.ts:195` (`deactivate()`)

### Command Registration

- **Command wrapper**: `src/extension.ts:131-152` (`registerCommand()`)
- **Command list**: `src/extension.ts:154-189`

### API Methods

- **HTTP client**: `src/redmine/redmine-server.ts:95-177` (`doRequest()`)
- **Projects**: `src/redmine/redmine-server.ts:179-212` (`getProjects()`)
- **Issues**: `src/redmine/redmine-server.ts:259-374`

### Tree Providers

- **My Issues tree**: `src/trees/my-issues-tree.ts:22-38`
- **Projects tree**: `src/trees/projects-tree.ts:34-83`

### Controllers

- **Issue actions**: `src/controllers/issue-controller.ts:217-275` (`listActions()`)

## Extension Points

### Adding New Commands

1. Create command file in `src/commands/`
2. Export default function: `(props: ActionProperties, ...args) => void`
3. Register in `extension.ts` via `registerCommand("commandName", handlerFn)`
4. Add to `package.json` `contributes.commands` array
5. Optionally add to `activationEvents`

### Adding New Tree Views

1. Create provider class implementing `vscode.TreeDataProvider<T>`
2. Implement `getTreeItem(element: T)` and `getChildren(element?: T)`
3. Add EventEmitter for `onDidChangeTreeData`
4. Register in `extension.ts` via `vscode.window.createTreeView()`
5. Add view definition to `package.json` `contributes.views`

### Adding New API Methods

1. Add method to `RedmineServer` class
2. Use `doRequest<T>(path, method, data?)` for HTTP calls
3. Map response to model from `src/redmine/models/`
4. Consider caching for rarely-changing data (see `issueStatuses`, `timeEntryActivities`)

### Adding New Configuration

1. Add property to `RedmineConfig` interface in `src/definitions/redmine-config.ts`
2. Add schema to `package.json` `contributes.configuration.properties`
3. Access via `vscode.workspace.getConfiguration("redmine").{propertyName}`

## Build System

**Bundler**: esbuild (configured in `esbuild.js`)

**Output**: `out/extension.js` (single bundled file)

**Scripts** (from `package.json`):

- `compile`: Production build
- `watch`: Development mode with auto-rebuild
- `package`: Create VSIX file via `@vscode/vsce`

**TypeScript**: Configured via `tsconfig.json`, targets ES6.

## Error Handling

### API Errors

- **401**: Invalid API key or additional auth required
- **403**: Insufficient permissions
- **404**: Resource not found
- **400+**: Generic server error

All handled in `RedmineServer.doRequest()` with descriptive error messages.

### User Errors

- Invalid input formats (e.g., time entry pattern)
- Missing configuration (empty URL/API key)
- Network failures (NodeJS request errors)

Displayed via `vscode.window.showErrorMessage()`.

## Migration Notes

### Configuration Schema Change (v1.0.0)

Extension detects old config (`redmine.serverUrl`) and shows migration guide via webview panel.

**Old → New**:

- `serverUrl` + `serverPort` + `serverIsSsl` → `url` (single combined URL)
- `projectName` → `identifier`
- `authorization` → `additionalHeaders` (object)

Migration handled in `src/extension.ts:96-129`.

## Output Channel Logging

**Purpose**: Debug API interactions via VS Code output channel.

**Architecture**: Decorator pattern with protected hooks in `RedmineServer`.

**Components**:

- `ApiLogger` (`src/utilities/api-logger.ts`): Formats log entries, redacts sensitive data
- `LoggingRedmineServer` (`src/redmine/logging-redmine-server.ts`): Decorator extending `RedmineServer`
- `redaction.ts` (`src/utilities/redaction.ts`): Redacts sensitive fields from JSON
- Protected hooks in `RedmineServer`: `onResponseSuccess()`, `onResponseError()`
- Output channel: "Redmine API" (created in `extension.ts:26`)

**Configuration**: `redmine.logging.enabled` (boolean, default: true)

**Log Format**: `[HH:MM:SS.mmm] [counter] METHOD path → status (duration) sizeB [binary]`

**Features**:

- Request body logging (200 char truncation, redacted)
- Response size tracking in bytes
- Query parameter truncation (>100 chars)
- Binary content detection (image/\*, application/pdf)
- Error response body logging (always shown, redacted)
- Sensitive data redaction (password, api_key, token, secret, auth)

**Example**:

```
[14:23:45.123] [1] POST /users.json
  Body: {"user":{"login":"admin","password":"***"}}
[14:23:45.265] [1] → 201 (142ms) 85B
[14:23:46.100] [2] GET /avatar.png
[14:23:46.234] [2] → 200 (134ms) 2048B [binary]
```

**Commands**:

- `redmine.showApiOutput` - Reveal output channel
- `redmine.clearApiOutput` - Clear logs
- `redmine.toggleApiLogging` - Enable/disable at runtime

**Implementation**: When logging enabled, `createServer()` returns `LoggingRedmineServer` instead of `RedmineServer` (extension.ts:30-44). Protected hooks allow child class to capture response metadata without modifying return values. Zero overhead when disabled.

## Dependencies

**Runtime**:

- `lodash` (utility functions: `isNil`, `isEqual`)

**Development**:

- `@types/vscode`, `@types/node`, `@types/lodash`
- `typescript`, `esbuild`
- `eslint` + prettier + TypeScript plugins
- `@vscode/vsce` (packaging)

**VS Code API Usage**:

- Commands: `vscode.commands`
- Trees: `vscode.window.createTreeView`, `TreeDataProvider`
- UI: `showQuickPick`, `showInputBox`, `showInformationMessage`
- Progress: `withProgress`
- Configuration: `workspace.getConfiguration`

## Testing Strategy

**Current State** (v3.0+): Comprehensive test suite with 60%+ coverage.

**Test Framework**: Vitest with MSW (Mock Service Worker) for HTTP mocking.

**Coverage**:

- Unit tests for `RedmineServer` methods (HTTP mocked via MSW)
- Unit tests for commands (`setApiKey`, domain utilities)
- Unit tests for utilities (`RedmineSecretManager`, error handling)
- 46+ tests, ~75% coverage, <2s runtime

**Run Tests**: `npm test` (includes coverage report)

## Future Extension Points

### Potential Features

- Inline issue creation (without browser)
- Issue commenting
- Attachment upload
- Custom field support
- Webhook integration
- Issue search/filter
- Gantt chart visualization
- Time tracking reports

### Architecture Considerations

- **Custom fields**: Extend `Issue` model, add to `IssueController`
- **Comments**: New command + API method in `RedmineServer`
- **Attachments**: File picker + multipart upload in `doRequest()`
- **Search**: New tree view with query-based data source
- **Reports**: Webview panel with charting library

## Performance Optimization

**Current**:

- Project list cached until manual refresh
- Statuses/activities cached (fetch once per server instance)
- Server instances reused via bucket

**Future**:

- Background refresh with TTL
- Incremental issue updates (websockets/polling)
- Lazy loading for large project hierarchies
- Virtual scrolling for issue lists

## Security Considerations

- **API Keys** (v3.0+): Stored via VS Code Secrets API with platform-native encryption
  - Windows: Credential Manager
  - macOS: Keychain
  - Linux: libsecret/gnome-keyring
  - Never synced across devices
  - Managed via `RedmineSecretManager` utility
- **Server URLs**: Stored in workspace settings (may sync via Settings Sync)
- **HTTPS**: Recommended (HTTP supported for local dev)
- **Self-signed Certs**: `rejectUnauthorized` option (use cautiously)
- **No credential storage in extension code**: All API calls authenticated via header

## Multi-Workspace Support

Extension fully supports multi-root workspaces:

- Each workspace folder can have different Redmine config
- `parseConfiguration()` prompts for folder selection
- Server instances cached per unique config
- Trees can switch between servers via `changeDefaultServer`

**Context Variables**:

- `redmine:hasSingleConfig`: Hides server switcher in single-folder workspaces
- `redmine:treeViewStyle`: Controls tree/list view toggle visibility
