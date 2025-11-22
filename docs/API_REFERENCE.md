# API Reference Guide

Comprehensive reference for Redmine REST API, VS Code Extension API, and Positron IDE APIs used in this extension.

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

**Implementation**: `RedmineServer.getProjects()` - recursively fetches all pages.

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

**Implementations**:
- `RedmineServer.getIssuesAssignedToMe()` - user's open issues
- `RedmineServer.getOpenIssuesForProject(id, includeSubprojects)` - project issues

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

**Implementations**:
- `RedmineServer.setIssueStatus(issue, statusId)` - change status only
- `RedmineServer.applyQuickUpdate(quickUpdate)` - batch update status + assignee + notes

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

**Implementation**: `RedmineServer.getIssueStatuses()` - cached after first fetch.

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

**Implementation**: `RedmineServer.getTimeEntryActivities()` - cached after first fetch.

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

**Implementation**: `RedmineServer.getMemberships(projectId)` - converts to domain `Membership` objects.

### Available But Unused Endpoints

#### Issues (Extended)

**POST /issues.json**
```typescript
// Create new issue programmatically
POST /issues.json
Body: {
  issue: {
    project_id: number,
    tracker_id: number,
    subject: string,
    description?: string,
    status_id?: number,
    priority_id?: number,
    assigned_to_id?: number,
    // ... custom fields
  }
}
```

**Current**: Extension opens browser to Redmine's create form (`/projects/{id}/issues/new`).
**Opportunity**: Implement in-editor issue creation with VS Code UI.

**DELETE /issues/{id}.json**
```typescript
// Delete issue (if permitted)
DELETE /issues/{id}.json
```

**GET /issues.json (advanced queries)**
```typescript
// Filter by multiple criteria
GET /issues.json?{params}

Query params:
  - tracker_id: Filter by tracker
  - status_id: Filter by status (or "open", "closed", "*")
  - assigned_to_id: Filter by assignee (or "me", specific ID)
  - priority_id: Filter by priority
  - created_on: Date range (e.g., ">=2024-01-01")
  - updated_on: Date range
  - cf_{id}: Custom field filters
  - sort: Sort order (e.g., "updated_on:desc")
```

**Opportunity**: Advanced issue search/filtering in tree views.

#### Comments/Notes

**GET /issues/{id}.json?include=journals**
```typescript
// Get issue with comment history
GET /issues/{id}.json?include=journals

Response: {
  issue: Issue & {
    journals: Journal[]
  }
}

Journal: {
  id: number,
  user: NamedEntity,
  notes: string,
  created_on: string,
  details: Detail[]  // Field changes
}
```

**Opportunity**: Display comment history, add comments directly.

#### Attachments

**POST /uploads.json**
```typescript
// Upload file for attachment
POST /uploads.json
Headers: { "Content-Type": "application/octet-stream" }
Body: <binary data>

Response: {
  upload: {
    token: string
  }
}
```

**POST /issues/{id}.json (with attachment)**
```typescript
// Attach uploaded file to issue
PUT /issues/{id}.json
Body: {
  issue: {
    uploads: [{
      token: string,      // From upload response
      filename: string,
      description?: string,
      content_type?: string
    }]
  }
}
```

**Opportunity**: File attachments from workspace.

#### Watchers

**POST /issues/{id}/watchers.json**
```typescript
// Add watcher to issue
POST /issues/{id}/watchers.json
Body: { user_id: number }
```

**DELETE /issues/{id}/watchers/{user_id}.json**
```typescript
// Remove watcher
DELETE /issues/{id}/watchers/{user_id}.json
```

**Opportunity**: Watch/unwatch issues.

#### Custom Fields

**GET /custom_fields.json**
```typescript
// Available custom fields
GET /custom_fields.json

Response: {
  custom_fields: CustomField[]
}

CustomField: {
  id: number,
  name: string,
  customized_type: string,  // "issue", "project", etc.
  field_format: string,      // "string", "list", "date", etc.
  possible_values?: string[],
  is_required: boolean
}
```

**Opportunity**: Support custom fields in issue creation/updates.

#### Trackers

**GET /trackers.json**
```typescript
// Available issue types (Bug, Feature, etc.)
GET /trackers.json

Response: {
  trackers: Tracker[]
}

Tracker: {
  id: number,
  name: string,
  default_status_id: number
}
```

**Opportunity**: Filter issues by tracker type.

#### Priorities

**GET /enumerations/issue_priorities.json**
```typescript
// Issue priorities (Low, Normal, High, etc.)
GET /enumerations/issue_priorities.json

Response: {
  issue_priorities: Priority[]
}

Priority: {
  id: number,
  name: string,
  is_default: boolean
}
```

**Opportunity**: Set/filter by priority.

#### Versions (Releases)

**GET /projects/{id}/versions.json**
```typescript
// Project versions/releases
GET /projects/{id}/versions.json

Response: {
  versions: Version[]
}

Version: {
  id: number,
  project: NamedEntity,
  name: string,
  description: string,
  status: "open" | "locked" | "closed",
  due_date: string | null,
  created_on: string,
  updated_on: string
}
```

**Opportunity**: Milestone tracking, release planning.

#### News

**GET /news.json**
```typescript
// Project news/announcements
GET /news.json?project_id={id}

Response: {
  news: NewsItem[]
}
```

**Opportunity**: Display project announcements in extension.

#### Wiki

**GET /projects/{id}/wiki/index.json**
```typescript
// Wiki page list
GET /projects/{id}/wiki/index.json

Response: {
  wiki_pages: WikiPage[]
}
```

**GET /projects/{id}/wiki/{title}.json**
```typescript
// Single wiki page content
GET /projects/{id}/wiki/{title}.json

Response: {
  wiki_page: {
    title: string,
    text: string,
    version: number,
    author: NamedEntity,
    created_on: string,
    updated_on: string
  }
}
```

**Opportunity**: Embedded wiki viewer/editor.

#### Users

**GET /users/current.json**
```typescript
// Current user info
GET /users/current.json

Response: {
  user: {
    id: number,
    login: string,
    firstname: string,
    lastname: string,
    mail: string,
    created_on: string,
    last_login_on: string
  }
}
```

**Opportunity**: Display user info, validate API key.

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
  workspaceState: Memento,       // Workspace storage
  // ... many more
}

// Usage in extension.ts:13
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(...)
  );
}
```

**Current Usage**: Command registration cleanup.
**Location**: `src/extension.ts:13-191`

#### Commands

**`vscode.commands.registerCommand()`**
```typescript
vscode.commands.registerCommand(
  command: string,
  callback: (...args: any[]) => any
): Disposable

// Usage in extension.ts:137-151
context.subscriptions.push(
  vscode.commands.registerCommand("redmine.openActionsForIssue", handler)
);
```

**Current Commands Registered**:
- `redmine.listOpenIssuesAssignedToMe`
- `redmine.openActionsForIssue`
- `redmine.openActionsForIssueUnderCursor`
- `redmine.newIssue`
- `redmine.changeDefaultServer`
- `redmine.refreshIssues`
- `redmine.toggleTreeView`
- `redmine.toggleListView`

**Locations**: `src/extension.ts:154-189`

**`vscode.commands.executeCommand()`**
```typescript
vscode.commands.executeCommand(
  command: string,
  ...args: any[]
): Thenable<any>

// Usage examples:
vscode.commands.executeCommand("setContext", "redmine:treeViewStyle", value)
vscode.commands.executeCommand("vscode.open", uri)
```

**Current Usage**:
- Setting context variables (`src/extension.ts:29-39`)
- Opening URLs (`src/commands/new-issue.ts:7-15`)

#### Window (UI)

**`vscode.window.createTreeView()`**
```typescript
vscode.window.createTreeView<T>(
  viewId: string,
  options: { treeDataProvider: TreeDataProvider<T> }
): TreeView<T>

// Usage in extension.ts:22-27
vscode.window.createTreeView("redmine-explorer-my-issues", {
  treeDataProvider: myIssuesTree
});
```

**Current Tree Views**:
- `redmine-explorer-my-issues` → `MyIssuesTree`
- `redmine-explorer-projects` → `ProjectsTree`

**Locations**: `src/extension.ts:22-27`

**`vscode.window.showQuickPick()`**
```typescript
vscode.window.showQuickPick<T extends QuickPickItem>(
  items: T[],
  options?: QuickPickOptions
): Thenable<T | undefined>

interface QuickPickItem {
  label: string,
  description?: string,
  detail?: string,
  picked?: boolean
}

// Usage in issue-controller.ts:74-101
vscode.window.showQuickPick(
  statuses.map(s => ({ label: s.name, ... })),
  { placeHolder: "Pick a new status" }
)
```

**Current Usage**:
- Status selection (`src/controllers/issue-controller.ts:74`)
- Activity type selection (`src/controllers/issue-controller.ts:16`)
- Assignee selection (`src/controllers/issue-controller.ts:167`)
- Action menu (`src/controllers/issue-controller.ts:221`)
- Project selection (`src/commands/new-issue.ts:40`)
- Issue selection (`src/commands/list-open-issues-assigned-to-me.ts:45`)

**`vscode.window.showInputBox()`**
```typescript
vscode.window.showInputBox(
  options?: InputBoxOptions
): Thenable<string | undefined>

interface InputBoxOptions {
  placeHolder?: string,
  prompt?: string,
  value?: string,
  valueSelection?: [number, number],
  password?: boolean,
  validateInput?: (value: string) => string | null
}

// Usage in open-actions-for-issue.ts:7-9
issueId = await vscode.window.showInputBox({
  placeHolder: "Type in issue id"
});
```

**Current Usage**:
- Issue ID input (`src/commands/open-actions-for-issue.ts:7`)
- Time entry input (`src/controllers/issue-controller.ts:38`)
- Quick update message (`src/controllers/issue-controller.ts:188`)

**`vscode.window.showInformationMessage()`**
**`vscode.window.showWarningMessage()`**
**`vscode.window.showErrorMessage()`**
```typescript
vscode.window.show{Type}Message(
  message: string,
  ...items: string[]
): Thenable<string | undefined>

// Usage in issue-controller.ts:62
vscode.window.showInformationMessage("Time entry added.");
```

**Current Usage**: Success/error notifications throughout codebase.

**`vscode.window.withProgress()`**
```typescript
vscode.window.withProgress<R>(
  options: ProgressOptions,
  task: (progress: Progress<{ message?: string }>) => Thenable<R>
): Thenable<R>

interface ProgressOptions {
  location: ProgressLocation,
  title?: string,
  cancellable?: boolean
}

// Usage in open-actions-for-issue.ts:31-42
await vscode.window.withProgress(
  { location: vscode.ProgressLocation.Window },
  (progress) => {
    progress.report({ message: "Waiting for response..." });
    return promise;
  }
);
```

**Current Usage**: API call loading indicators.
**Locations**:
- `src/commands/open-actions-for-issue.ts:31`
- `src/commands/new-issue.ts:25`
- `src/commands/list-open-issues-assigned-to-me.ts:30`

**`vscode.window.showWorkspaceFolderPick()`**
```typescript
vscode.window.showWorkspaceFolderPick(
  options?: WorkspaceFolderPickOptions
): Thenable<WorkspaceFolder | undefined>

// Usage in extension.ts:58
const pickedFolder = await vscode.window.showWorkspaceFolderPick();
```

**Current Usage**: Multi-root workspace server selection.
**Location**: `src/extension.ts:58`

**`vscode.window.activeTextEditor`**
```typescript
// Currently active text editor
vscode.window.activeTextEditor: TextEditor | undefined

// Usage in open-actions-for-issue-under-cursor.ts:29
const editor = vscode.window.activeTextEditor;
```

**Current Usage**: Get cursor position for issue number extraction.
**Location**: `src/commands/open-actions-for-issue-under-cursor.ts:29`

**`vscode.window.createWebviewPanel()`**
```typescript
vscode.window.createWebviewPanel(
  viewType: string,
  title: string,
  showOptions: ViewColumn,
  options?: WebviewPanelOptions
): WebviewPanel

// Usage in extension.ts:97-128
const panel = vscode.window.createWebviewPanel(
  "redmineConfigurationUpdate",
  "New configuration arrived!",
  vscode.ViewColumn.One,
  {}
);
panel.webview.html = "<!DOCTYPE html>...";
```

**Current Usage**: Config migration guide (v1.0.0).
**Location**: `src/extension.ts:97-128`

#### Workspace

**`vscode.workspace.getConfiguration()`**
```typescript
vscode.workspace.getConfiguration(
  section?: string,
  scope?: WorkspaceFolder | null
): WorkspaceConfiguration

// Usage in extension.ts:66-69
const config = vscode.workspace.getConfiguration("redmine", pickedFolder?.uri);
const url = config.url;
const apiKey = config.apiKey;
```

**Current Usage**: Read extension settings.
**Locations**:
- `src/extension.ts:66` (command configuration)
- `src/extension.ts:94` (migration check)
- `src/trees/my-issues-tree.ts:9` (tree initialization)
- `src/trees/projects-tree.ts:19` (tree initialization)

**`vscode.workspace.workspaceFolders`**
```typescript
vscode.workspace.workspaceFolders: WorkspaceFolder[] | undefined

// Usage in extension.ts:32
(vscode.workspace.workspaceFolders?.length ?? 0) <= 1
```

**Current Usage**: Detect single vs multi-root workspace.
**Location**: `src/extension.ts:32`

#### Tree View

**`vscode.TreeDataProvider<T>`**
```typescript
interface TreeDataProvider<T> {
  onDidChangeTreeData?: Event<T | undefined | null>,
  getTreeItem(element: T): TreeItem | Thenable<TreeItem>,
  getChildren(element?: T): ProviderResult<T[]>
}

// Implementation in my-issues-tree.ts:6-43
export class MyIssuesTree implements vscode.TreeDataProvider<Issue> {
  onDidChangeTreeData$ = new vscode.EventEmitter<Issue>();
  onDidChangeTreeData = this.onDidChangeTreeData$.event;

  getTreeItem(issue: Issue): vscode.TreeItem { ... }
  getChildren(): Promise<Issue[]> { ... }
}
```

**Current Implementations**:
- `MyIssuesTree` → displays `Issue[]`
- `ProjectsTree` → displays `RedmineProject | Issue` (polymorphic)

**Locations**:
- `src/trees/my-issues-tree.ts:6-43`
- `src/trees/projects-tree.ts:13-97`

**`vscode.TreeItem`**
```typescript
class TreeItem {
  label: string,
  collapsibleState: TreeItemCollapsibleState,
  command?: Command,
  contextValue?: string,
  description?: string,
  iconPath?: string | Uri | ThemeIcon,
  tooltip?: string | MarkdownString
}

// Usage in my-issues-tree.ts:23-34
const item = new vscode.TreeItem(
  `#${issue.id} [${issue.tracker.name}] ...`,
  vscode.TreeItemCollapsibleState.None
);
item.command = {
  command: "redmine.openActionsForIssue",
  arguments: [false, { server: this.server }, `${issue.id}`],
  title: "Open actions for issue"
};
```

**Current Usage**: Tree item rendering with click handlers.

**`vscode.EventEmitter<T>`**
```typescript
class EventEmitter<T> {
  event: Event<T>,
  fire(data: T): void,
  dispose(): void
}

// Usage in my-issues-tree.ts:20-21
onDidChangeTreeData$ = new vscode.EventEmitter<Issue>();
onDidChangeTreeData: vscode.Event<Issue> = this.onDidChangeTreeData$.event;

// Trigger refresh
this.onDidChangeTreeData$.fire();
```

**Current Usage**: Tree view refresh mechanism.

#### URIs

**`vscode.Uri.parse()`**
```typescript
vscode.Uri.parse(value: string): Uri

// Usage in issue-controller.ts:108
vscode.Uri.parse(`${this.redmine.options.address}/issues/${this.issue.id}`)
```

**Current Usage**: Create URIs for browser opening.

#### Text Editor

**`vscode.TextEditor`**
```typescript
interface TextEditor {
  selection: Selection,
  document: TextDocument,
  // ...
}

// Usage in open-actions-for-issue-under-cursor.ts:5-25
function getTextUnderCursor(editor: vscode.TextEditor): string {
  const { start, end } = editor.selection;
  // Expand selection to capture issue number
  const newSelection = new vscode.Selection(newStart, newEnd);
  return editor.document.getText(newSelection);
}
```

**Current Usage**: Extract issue number from cursor position.
**Location**: `src/commands/open-actions-for-issue-under-cursor.ts`

**`vscode.Selection`**
```typescript
class Selection extends Range {
  constructor(
    anchor: Position,
    active: Position
  )
}

// Usage in open-actions-for-issue-under-cursor.ts:13-16
const newSelection = new vscode.Selection(
  start.translate(0, -10),
  end.translate(0, 10)
);
```

**Current Usage**: Text range expansion for pattern matching.

### Available But Unused APIs

#### Status Bar
```typescript
vscode.window.createStatusBarItem(
  alignment?: StatusBarAlignment,
  priority?: number
): StatusBarItem

statusBarItem.text = "$(sync~spin) Syncing issues...";
statusBarItem.show();
```

**Opportunity**: Show active server, issue count, sync status.

#### Notifications with Actions
```typescript
vscode.window.showInformationMessage(
  "Issue created!",
  "Open in Browser",
  "View Details"
).then(selection => {
  if (selection === "Open in Browser") { ... }
});
```

**Opportunity**: Action buttons on notifications.

#### Output Channel
```typescript
const outputChannel = vscode.window.createOutputChannel("Redmine");
outputChannel.appendLine("API request sent...");
outputChannel.show();
```

**Opportunity**: Debug logging, API request tracing.

#### Tasks
```typescript
const task = new vscode.Task(
  { type: "redmine" },
  vscode.TaskScope.Workspace,
  "Sync Issues",
  "Redmine"
);
vscode.tasks.executeTask(task);
```

**Opportunity**: Background sync tasks.

#### Decorations
```typescript
const decorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: "rgba(255, 0, 0, 0.3)"
});
editor.setDecorations(decorationType, [rangeArray]);
```

**Opportunity**: Highlight issue references in code.

#### Hover Provider
```typescript
vscode.languages.registerHoverProvider("*", {
  provideHover(document, position) {
    const range = document.getWordRangeAtPosition(position, /#\d+/);
    if (range) {
      const issueId = document.getText(range).substring(1);
      // Fetch and display issue preview
      return new vscode.Hover(`**Issue #${issueId}**: ${preview}`);
    }
  }
});
```

**Opportunity**: Hover over `#123` to see issue preview.

#### Code Actions
```typescript
vscode.languages.registerCodeActionsProvider("*", {
  provideCodeActions(document, range) {
    // Detect issue references, offer actions
    return [
      {
        title: "Open Redmine Issue",
        command: "redmine.openActionsForIssue",
        arguments: [issueId]
      }
    ];
  }
});
```

**Opportunity**: Quick actions on issue references (💡 lightbulb).

#### Webview API (Advanced)
```typescript
// Two-way communication
panel.webview.onDidReceiveMessage(message => {
  // Handle messages from webview
});

panel.webview.postMessage({ type: "update", data: ... });
```

**Opportunity**: Rich issue editor, Gantt charts, reports.

#### File System Watcher
```typescript
const watcher = vscode.workspace.createFileSystemWatcher("**/*.{md,txt}");
watcher.onDidChange(uri => {
  // Update issue references when files change
});
```

**Opportunity**: Track issue references in workspace.

#### Terminal
```typescript
const terminal = vscode.window.createTerminal("Redmine CLI");
terminal.sendText("redmine-cli list-issues");
terminal.show();
```

**Opportunity**: CLI integration.

#### Source Control
```typescript
vscode.scm.createSourceControlResourceGroup(...);
```

**Opportunity**: Git commit → Redmine issue linking.

---

## Positron IDE API

### Overview

Positron is a data science IDE based on VS Code, built by Posit (formerly RStudio). Extends VS Code with data science features.

**Compatibility**: Extension targets both VS Code `^1.74.0` and Positron `^2025.06.0`.

**Key Difference**: Positron adds data-science-specific APIs while maintaining full VS Code API compatibility.

### Engine Requirements
```json
"engines": {
  "vscode": "^1.74.0",
  "positron": "^2025.06.0"
}
```

**Source**: `package.json:13-16`

### Positron-Specific APIs

Positron extends VS Code with additional APIs under the `positron` namespace. Current extension doesn't use these yet.

#### Data Explorer
```typescript
// Hypothetical Positron API (not currently used)
positron.dataExplorer.register({
  getDataFrame: async () => {
    // Convert Redmine data to DataFrame
  }
});
```

**Opportunity**: Export issue lists, time entries to data frames for analysis.

#### Notebook Integration
```typescript
// Register issue data as notebook variable
positron.runtime.execute(`
  issues <- fromJSON("...")
  View(issues)
`);
```

**Opportunity**: Load Redmine data into R/Python notebooks.

#### Connections Pane
```typescript
positron.connections.register({
  name: "Redmine Server",
  connect: async () => { ... },
  disconnect: async () => { ... }
});
```

**Opportunity**: Manage multiple Redmine servers in Connections pane.

### Compatibility Strategy

**Current Approach**: Extension uses only standard VS Code APIs, ensuring compatibility with both platforms.

**Detection Pattern** (if needed):
```typescript
const isPositron = vscode.env.appName.includes("Positron");

if (isPositron) {
  // Use Positron-specific features
} else {
  // Standard VS Code features
}
```

**Recommendation**: Continue using standard VS Code APIs unless Positron-specific features provide significant value (e.g., data frame export for analytics).

---

## API Usage Summary

### Redmine API Coverage

| Category | Used | Available | Coverage |
|----------|------|-----------|----------|
| Issues | 4/10 | 10 | 40% |
| Projects | 1/3 | 3 | 33% |
| Time Entries | 2/3 | 3 | 66% |
| Users | 0/5 | 5 | 0% |
| Wiki | 0/4 | 4 | 0% |
| Attachments | 0/2 | 2 | 0% |
| Custom Fields | 0/2 | 2 | 0% |

**Total**: 7/29 endpoints (24%)

### VS Code API Coverage

| Category | Used | Key Gaps |
|----------|------|----------|
| Commands | ✅ Full | - |
| Configuration | ✅ Full | - |
| Tree Views | ✅ Full | - |
| Quick Pick | ✅ Full | - |
| Progress | ✅ Basic | Cancellation tokens |
| Notifications | ✅ Basic | Action buttons |
| Text Editors | ✅ Basic | Decorations, hover |
| Webviews | ⚠️ Limited | Two-way communication |
| Status Bar | ❌ None | Status items |
| Output Channel | ❌ None | Debug logging |
| Language Features | ❌ None | Hover, code actions |

### Positron API Coverage

| Category | Used | Opportunity |
|----------|------|-------------|
| Data Explorer | ❌ None | Issue/time data export |
| Connections | ❌ None | Server management |
| Runtime | ❌ None | Notebook integration |

**Note**: Extension prioritizes VS Code compatibility.

---

## Best Practices

### API Key Security
```typescript
// ✅ Good: Use VS Code secure storage
await context.secrets.store("redmine.apiKey", apiKey);

// ❌ Current: Plain settings (encrypted by VS Code but visible)
config.get("redmine.apiKey");
```

### Error Handling
```typescript
// ✅ Good: Specific error messages
catch (error) {
  if (error.message.includes("401")) {
    vscode.window.showErrorMessage("Invalid API key. Check settings.");
  }
}

// ✅ Current: Descriptive errors in RedmineServer.doRequest()
```

### Progress Reporting
```typescript
// ✅ Good: Cancellable progress
await vscode.window.withProgress({
  location: vscode.ProgressLocation.Notification,
  cancellable: true
}, async (progress, token) => {
  token.onCancellationRequested(() => abort());
  progress.report({ increment: 50, message: "Fetching issues..." });
});

// ⚠️ Current: Non-cancellable window progress
```

### Caching Strategy
```typescript
// ✅ Current: Static data cached (statuses, activities)
if (this.issueStatuses) return Promise.resolve(this.issueStatuses);

// ✅ Good: Add TTL for semi-static data
if (this.projects && Date.now() - this.projectsFetchedAt < 5 * 60 * 1000) {
  return this.projects;
}
```

---

## Extension Opportunities Matrix

| Feature | Redmine API | VS Code API | Complexity | Impact |
|---------|-------------|-------------|------------|--------|
| Issue creation in-editor | POST /issues.json | showInputBox, showQuickPick | Medium | High |
| Issue comments | GET/POST journals | Webview or tree children | Medium | Medium |
| File attachments | POST /uploads.json | workspace.fs, showOpenDialog | High | Medium |
| Issue reference hover | GET /issues/{id}.json | registerHoverProvider | Low | High |
| Advanced search | GET /issues.json?{filters} | New tree view | Medium | Medium |
| Custom fields | GET /custom_fields.json | Dynamic UI generation | High | Low |
| Wiki viewer | GET /wiki/*.json | Webview + markdown | Medium | Low |
| Status bar indicator | - | createStatusBarItem | Low | Low |
| Debug logging | - | createOutputChannel | Low | Medium |
| Data export (Positron) | GET /time_entries.json | positron.dataExplorer | High | Medium |

**Legend**:
- **Complexity**: Low (< 1 day), Medium (1-3 days), High (> 3 days)
- **Impact**: Low (nice-to-have), Medium (useful), High (game-changer)

---

## Migration Path

### Phase 1: Quick Wins
1. Status bar item (server status, issue count)
2. Output channel (debug logging)
3. Notification action buttons

### Phase 2: Enhanced UX
1. Issue reference hover provider
2. In-editor issue creation
3. Advanced issue search/filters

### Phase 3: Advanced Features
1. Comment viewing/posting
2. File attachments
3. Custom field support

### Phase 4: Positron Integration
1. Data frame export (issues, time entries)
2. Connections pane integration
3. Notebook variable injection
