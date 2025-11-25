# API Reference

Reference for Redmine REST API, VS Code Extension API, and Positron IDE APIs used in this extension.

## Table of Contents

1. [Redmine REST API](#redmine-rest-api)
2. [VS Code Extension API](#vs-code-extension-api)
3. [Positron IDE API](#positron-ide-api)

---

## Redmine REST API

### Overview

Redmine provides a REST API for programmatic access. Authentication via `X-Redmine-API-Key` header.

**Base URL Pattern**: `{server}/path.json`
**Documentation**: https://www.redmine.org/projects/redmine/wiki/Rest_api

### Currently Used Endpoints

#### Projects

**GET /projects.json**

```typescript
// Fetch all projects (paginated)
GET /projects.json?limit={limit}&offset={offset}

Response: {
  projects: Project[],
  total_count: number,
  offset: number,
  limit: number
}

Project: {
  id: number,
  name: string,
  identifier: string,
  description: string,
  parent?: { id: number, name: string },
  status: number,
  is_public: boolean,
  created_on: string,
  updated_on: string
}
```

**Implementation**: `RedmineServer.getProjects()` (recursive pagination)

#### Issues

**GET /issues.json**

```typescript
// Open issues assigned to current user
GET /issues.json?status_id=open&assigned_to_id=me

// Open issues for project (with subprojects)
GET /issues.json?status_id=open&project_id={id}&subproject_id=!*

// Open issues for project (no subprojects)
GET /issues.json?status_id=open&project_id={id}

Response: {
  issues: Issue[],
  total_count: number,
  offset: number,
  limit: number
}

Issue: {
  id: number,
  project: NamedEntity,
  tracker: NamedEntity,
  status: NamedEntity,
  priority: NamedEntity,
  author: NamedEntity,
  assigned_to: NamedEntity,
  subject: string,
  description: string,
  start_date: string,
  due_date: string | null,
  done_ratio: number,
  is_private: boolean,
  estimated_hours: number | null,
  created_on: string,
  updated_on: string,
  closed_on: string | null
}
```

**Implementations**: `RedmineServer.getIssuesAssignedToMe()`, `RedmineServer.getOpenIssuesForProject(id, includeSubprojects)`

**GET /issues/{id}.json**

```typescript
// Single issue by ID
GET /issues/{id}.json

Response: {
  issue: Issue
}
```

**Implementation**: `RedmineServer.getIssueById(issueId)`

**PUT /issues/{id}.json**

```typescript
// Update issue
PUT /issues/{id}.json
Body: {
  issue: {
    status_id?: number,
    assigned_to_id?: number,
    notes?: string,
    // ... other fields
  }
}

Response: 200 OK (empty body) or error
```

**Implementations**: `RedmineServer.setIssueStatus(issue, statusId)`, `RedmineServer.applyQuickUpdate(quickUpdate)`

#### Issue Statuses

**GET /issue_statuses.json**

```typescript
GET /issue_statuses.json

Response: {
  issue_statuses: IssueStatus[]
}

IssueStatus: {
  id: number,
  name: string,
  is_closed: boolean,
  is_default?: boolean
}
```

**Implementation**: `RedmineServer.getIssueStatuses()` (cached)

#### Time Entries

**POST /time_entries.json**

```typescript
// Add time entry to issue
POST /time_entries.json
Body: {
  time_entry: {
    issue_id: number,
    activity_id: number,
    hours: string,  // e.g., "2.5"
    comments: string
  }
}

Response: {
  time_entry: TimeEntry
}

TimeEntry: {
  id: number,
  project: NamedEntity,
  issue: NamedEntity,
  user: NamedEntity,
  activity: NamedEntity,
  hours: number,
  comments: string,
  spent_on: string,
  created_on: string,
  updated_on: string
}
```

**Implementation**: `RedmineServer.addTimeEntry(issueId, activityId, hours, message)`

**GET /enumerations/time_entry_activities.json**

```typescript
// Available time entry activity types
GET /enumerations/time_entry_activities.json

Response: {
  time_entry_activities: TimeEntryActivity[]
}

TimeEntryActivity: {
  id: number,
  name: string,  // e.g., "Development", "Testing", "Design"
  is_default: boolean,
  active: boolean
}
```

**Implementation**: `RedmineServer.getTimeEntryActivities()` (cached)

#### Memberships

**GET /projects/{id}/memberships.json**

```typescript
// Users and groups with access to project
GET /projects/{id}/memberships.json

Response: {
  memberships: Membership[],
  total_count: number,
  offset: number,
  limit: number
}

Membership: {
  id: number,
  project: NamedEntity,
  user?: NamedEntity,  // Present if member is user
  group?: NamedEntity, // Present if member is group
  roles: Role[]
}

Role: {
  id: number,
  name: string
}
```

**Implementation**: `RedmineServer.getMemberships(projectId)`

### Available But Unused Endpoints

| Category | Endpoint | Use Case |
|----------|----------|----------|
| **Issues** | `POST /issues.json` | In-editor issue creation |
| | `DELETE /issues/{id}.json` | Delete issues |
| | `GET /issues.json?{filters}` | Advanced search/filtering |
| **Comments** | `GET /issues/{id}.json?include=journals` | Display comment history |
| | `PUT /issues/{id}.json` (with notes) | Add comments |
| **Attachments** | `POST /uploads.json` | Upload files |
| | `PUT /issues/{id}.json` (with uploads) | Attach files to issues |
| **Watchers** | `POST /issues/{id}/watchers.json` | Add watchers |
| | `DELETE /issues/{id}/watchers/{user_id}.json` | Remove watchers |
| **Custom Fields** | `GET /custom_fields.json` | Support custom fields |
| **Trackers** | `GET /trackers.json` | Filter by issue type |
| **Priorities** | `GET /enumerations/issue_priorities.json` | Set/filter by priority |
| **Versions** | `GET /projects/{id}/versions.json` | Milestone tracking |
| **News** | `GET /news.json` | Display announcements |
| **Wiki** | `GET /projects/{id}/wiki/{title}.json` | Embedded wiki viewer |
| **Users** | `GET /users/current.json` | Display user info, validate API key |

---

## VS Code Extension API

### Currently Used APIs

#### Extension Lifecycle

**`vscode.ExtensionContext`**

```typescript
interface ExtensionContext {
  subscriptions: Disposable[],  // Auto-cleanup on deactivate
  extensionPath: string,
  globalState: Memento,          // Global storage
  workspaceState: Memento        // Workspace storage
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(...)
  );
}
```

**Usage**: Command registration cleanup (`src/extension.ts`)

#### Commands

**`vscode.commands.registerCommand()`**

```typescript
vscode.commands.registerCommand(
  command: string,
  callback: (...args: any[]) => any
): Disposable
```

**Registered Commands**: `setApiKey`, `listOpenIssuesAssignedToMe`, `openActionsForIssue`, `openActionsForIssueUnderCursor`, `newIssue`, `changeDefaultServer`, `refreshIssues`, `toggleTreeView`, `toggleListView` (`src/extension.ts`)

**`vscode.commands.executeCommand()`**

```typescript
vscode.commands.executeCommand(command: string, ...args: any[]): Thenable<any>
```

**Usage**: Setting context variables, opening URLs (`src/extension.ts`, `src/commands/new-issue.ts`)

#### Window (UI)

**`vscode.window.createTreeView()`**

```typescript
vscode.window.createTreeView<T>(
  viewId: string,
  options: { treeDataProvider: TreeDataProvider<T> }
): TreeView<T>
```

**Tree Views**: `redmine-explorer-my-issues` (MyIssuesTree), `redmine-explorer-projects` (ProjectsTree) (`src/extension.ts`)

**`vscode.window.showQuickPick()`**

```typescript
vscode.window.showQuickPick<T extends QuickPickItem>(
  items: T[],
  options?: QuickPickOptions
): Thenable<T | undefined>

interface QuickPickItem {
  label: string,
  description?: string,
  detail?: string
}
```

**Usage**: Status, activity, assignee, action, project, and issue selection (`src/controllers/issue-controller.ts`, `src/commands/`)

**`vscode.window.showInputBox()`**

```typescript
vscode.window.showInputBox(options?: InputBoxOptions): Thenable<string | undefined>

interface InputBoxOptions {
  placeHolder?: string,
  prompt?: string,
  password?: boolean,
  validateInput?: (value: string) => string | null
}
```

**Usage**: Issue ID, time entry, and message input (`src/commands/open-actions-for-issue.ts`, `src/controllers/issue-controller.ts`)

**`vscode.window.show{Information|Warning|Error}Message()`**

```typescript
vscode.window.show{Type}Message(message: string, ...items: string[]): Thenable<string | undefined>
```

**Usage**: Success/error notifications throughout codebase

**`vscode.window.withProgress()`**

```typescript
vscode.window.withProgress<R>(
  options: ProgressOptions,
  task: (progress: Progress<{ message?: string }>) => Thenable<R>
): Thenable<R>
```

**Usage**: API call loading indicators (`src/commands/`)

**`vscode.window.showWorkspaceFolderPick()`**

```typescript
vscode.window.showWorkspaceFolderPick(options?: WorkspaceFolderPickOptions): Thenable<WorkspaceFolder | undefined>
```

**Usage**: Multi-root workspace server selection (`src/extension.ts`)

**`vscode.window.activeTextEditor`**

```typescript
vscode.window.activeTextEditor: TextEditor | undefined
```

**Usage**: Get cursor position for issue number extraction (`src/commands/open-actions-for-issue-under-cursor.ts`)

**`vscode.window.createWebviewPanel()`**

```typescript
vscode.window.createWebviewPanel(
  viewType: string,
  title: string,
  showOptions: ViewColumn,
  options?: WebviewPanelOptions
): WebviewPanel
```

**Usage**: Config migration guide (`src/extension.ts`)

#### Workspace

**`vscode.workspace.getConfiguration()`**

```typescript
vscode.workspace.getConfiguration(
  section?: string,
  scope?: WorkspaceFolder | null
): WorkspaceConfiguration
```

**Usage**: Read extension settings (`src/extension.ts`, `src/trees/`)

**`vscode.workspace.workspaceFolders`**

```typescript
vscode.workspace.workspaceFolders: WorkspaceFolder[] | undefined
```

**Usage**: Detect single vs multi-root workspace (`src/extension.ts`)

#### Tree View

**`vscode.TreeDataProvider<T>`**

```typescript
interface TreeDataProvider<T> {
  onDidChangeTreeData?: Event<T | undefined | null>,
  getTreeItem(element: T): TreeItem | Thenable<TreeItem>,
  getChildren(element?: T): ProviderResult<T[]>
}
```

**Implementations**: `MyIssuesTree` (Issue[]), `ProjectsTree` (RedmineProject | Issue) (`src/trees/`)

**`vscode.TreeItem`**

```typescript
class TreeItem {
  label: string,
  collapsibleState: TreeItemCollapsibleState,
  command?: Command,
  contextValue?: string,
  description?: string,
  tooltip?: string | MarkdownString
}
```

**Usage**: Tree item rendering with click handlers (`src/trees/`)

**`vscode.EventEmitter<T>`**

```typescript
class EventEmitter<T> {
  event: Event<T>,
  fire(data: T): void,
  dispose(): void
}
```

**Usage**: Tree view refresh mechanism (`src/trees/`)

#### URIs

**`vscode.Uri.parse()`**

```typescript
vscode.Uri.parse(value: string): Uri
```

**Usage**: Create URIs for browser opening (`src/controllers/issue-controller.ts`)

#### Text Editor

**`vscode.TextEditor`** & **`vscode.Selection`**

```typescript
interface TextEditor {
  selection: Selection
  document: TextDocument
}

class Selection extends Range {
  constructor(anchor: Position, active: Position)
}
```

**Usage**: Extract issue number from cursor position (`src/commands/open-actions-for-issue-under-cursor.ts`)

### Available But Unused APIs

| API | Use Case |
|-----|----------|
| `createStatusBarItem()` | Show active server, issue count, sync status |
| `showInformationMessage()` (with actions) | Action buttons on notifications |
| `createOutputChannel()` | Debug logging, API request tracing |
| `vscode.Task` | Background sync tasks |
| `createTextEditorDecorationType()` | Highlight issue references in code |
| `registerHoverProvider()` | Hover over `#123` to see issue preview |
| `registerCodeActionsProvider()` | Quick actions on issue references |
| `Webview` (two-way) | Rich issue editor, Gantt charts, reports |
| `createFileSystemWatcher()` | Track issue references in workspace |
| `createTerminal()` | CLI integration |
| `vscode.scm` | Git commit → Redmine issue linking |

---

## Positron IDE API

### Overview

Positron is a data science IDE based on VS Code (built by Posit). Extension targets both VS Code `^1.106.0` and Positron `^2025.06.0`.

### Compatibility Strategy

**Current**: Extension uses only standard VS Code APIs, ensuring compatibility with both platforms.

**Detection** (if needed):
```typescript
const isPositron = vscode.env.appName.includes("Positron");
```

### Potential Positron-Specific Features

| API | Use Case |
|-----|----------|
| `positron.dataExplorer` | Export issues/time entries to data frames |
| `positron.runtime` | Load Redmine data into R/Python notebooks |
| `positron.connections` | Manage multiple Redmine servers in Connections pane |

**Note**: Not currently implemented. Standard VS Code APIs prioritized.

---

## API Usage Summary

### Redmine API Coverage

| Category      | Used | Available | Coverage |
| ------------- | ---- | --------- | -------- |
| Issues        | 4/10 | 10        | 40%      |
| Projects      | 1/3  | 3         | 33%      |
| Time Entries  | 2/3  | 3         | 66%      |
| Users         | 0/5  | 5         | 0%       |
| Wiki          | 0/4  | 4         | 0%       |
| Attachments   | 0/2  | 2         | 0%       |
| Custom Fields | 0/2  | 2         | 0%       |

**Total**: 7/29 endpoints (24%)

### VS Code API Coverage

| Category          | Used       | Key Gaps              |
| ----------------- | ---------- | --------------------- |
| Commands          | ✅ Full    | -                     |
| Configuration     | ✅ Full    | -                     |
| Tree Views        | ✅ Full    | -                     |
| Quick Pick        | ✅ Full    | -                     |
| Progress          | ✅ Basic   | Cancellation tokens   |
| Notifications     | ✅ Basic   | Action buttons        |
| Text Editors      | ✅ Basic   | Decorations, hover    |
| Webviews          | ⚠️ Limited | Two-way communication |
| Status Bar        | ❌ None    | Status items          |
| Output Channel    | ❌ None    | Debug logging         |
| Language Features | ❌ None    | Hover, code actions   |

### Positron API Coverage

| Category      | Used    | Opportunity            |
| ------------- | ------- | ---------------------- |
| Data Explorer | ❌ None | Issue/time data export |
| Connections   | ❌ None | Server management      |
| Runtime       | ❌ None | Notebook integration   |

**Note**: Extension prioritizes VS Code compatibility.

---

## Best Practices

### API Key Security

**Current (v3.0+)**: `RedmineSecretManager` wraps VS Code Secrets API with workspace-scoped keys
- Platform-native encryption (Credential Manager/Keychain/libsecret)
- Never synced across devices
- Methods: `setApiKey()`, `getApiKey()`, `deleteApiKey()`, `onSecretChanged()`

**Deprecated (<v3.0)**: Plain settings (insecure, synced)

### Error Handling

Extension provides specific error messages via `RedmineServer.doRequest()`. Example: 401 errors → "Invalid API key" message.

### Progress Reporting

**Current**: Non-cancellable window progress
**Future**: Add cancellation tokens for long-running operations

### Caching

**Current**: Static data cached (issue statuses, time entry activities)
**Future**: Add TTL for semi-static data (projects, memberships)

---

## Extension Opportunities

| Feature | Complexity | Impact | APIs Required |
|---------|------------|--------|---------------|
| Issue reference hover | Low | High | `registerHoverProvider`, `GET /issues/{id}` |
| In-editor issue creation | Medium | High | `showInputBox`, `POST /issues.json` |
| Status bar indicator | Low | Low | `createStatusBarItem` |
| Debug logging | Low | Medium | `createOutputChannel` |
| Issue comments | Medium | Medium | `GET/POST journals`, Webview |
| Advanced search | Medium | Medium | `GET /issues.json?{filters}` |
| File attachments | High | Medium | `POST /uploads.json`, `workspace.fs` |
| Data export (Positron) | High | Medium | `positron.dataExplorer`, `GET /time_entries` |

**Complexity**: Low (< 1 day), Medium (1-3 days), High (> 3 days)
**Impact**: Low (nice-to-have), Medium (useful), High (game-changer)
