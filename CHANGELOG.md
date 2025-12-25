# Change Log

All notable changes to the "vscode-redmine" extension will be documented in this file.

## [Unreleased]

### Changed

- **Tree item info density reduced (4.1)** - label now `#id Subject`, status via icon color only
- **Gantt progressive disclosure (4.2)** - Deps/Intensity toggle buttons in toolbar

### Added

- **Actionable error feedback (4.5)** - config errors show "Configure" button for quick setup
- **Contextual hints (4.4)** - keyboard shortcuts in command titles, tips in welcome views
- **Timer phase clarity (4.6)** - enhanced tooltips with phase explanations, dynamic tree title

## [3.14.0]

### Changed

- **BaseTreeProvider abstraction** - all tree providers now extend shared base class (DRY refactor)
- **Timer plan persists indefinitely** - no auto-clear on new day; manual clear only
- **Rebranded** to "Redmyne" - clearer differentiation from original extension
- **New green logo** - distinct from original Redmine blue
- **README** - prominent fork notice, feature comparison table
- **Week groups in This Month** - sorted most recent first (descending)

### Fixed

- **Open in Browser for time entries** - handles entries with `issue.id` instead of `issue_id`
- **Quick Log Time filters issues** - only shows issues from projects with time tracking enabled
- **Timer status bar shows activity** - working/paused now shows `#1234 [Data Management] (4/8)`
- **Timer session recovery** - preserves "logging" phase for completed timers
- **Timer phase consistency** - orphaned "paused" phase when unit removed/reset
- **Timer state mutation** - getPlan() returns copy, restoreState() deep clones
- **Timer resume finds correct unit** - searches by unitPhase, not index
- **Timer persisted state validation** - validates phase, plan, numeric fields

### Added

- **Monthly Working Hours** - configure different working schedules per month
  - Edit schedules: `Redmine: Edit Monthly Working Hours` command
  - View all months: `Redmine: View Monthly Working Hours` command
  - Supports varying FTE (e.g., 100% in Jan, 50% in Feb)
  - Flexible distribution (8h Mon/Tue + 4h Wed vs 4h every day)
  - Persists across VS Code restarts
  - Shows custom schedule in workload tooltip
- **Inline issue search in unit picker** - type directly to search by #ID or text; results appear inline
- **Empty working days in time entries** - show days with 0 logged hours based on weekly schedule; tooltips explain date range
- **Add Time Entry from day** - right-click day in time entries to add entry for that date
- **Enter/click starts timer unit** - click or Enter on tree item starts/pauses unit
- **Start Timer respects selection** - title bar button starts selected unit



- **Pomodoro/Unit Timer** (Ctrl+Y Ctrl+T) - plan work units with auto-logging
  - Day planning wizard: pick unit count, assign issues/activities
  - 45min work + 15min break cycles (configurable)
  - Status bar shows timer countdown, current issue, progress
  - "Today's Plan" tree view shows all units with status
  - Auto-log time when unit completes (full unit duration)
  - Sound notification on completion
  - State persists across VS Code restarts (same day)
- **Date picker for Quick Log Time** - log time on previous days (Today/Yesterday/custom)
- **Day subdivisions in This Week** - time entries grouped by day (Mon, Tue, etc.)
- **Week/day subdivisions in This Month** - entries grouped by week, then day
- **Start/due date in Quick Update** - change dates with presets (Today/Tomorrow/Next week)
- **Quick Create Issue** (Ctrl+Y Ctrl+N) - create issues without leaving IDE
  - Full wizard: project → tracker → priority → subject → description → hours → due date
  - All optional fields skippable via Enter
  - Status bar confirmation on success
- **Create Sub-Issue** context menu action - right-click issue to create child
  - Inherits parent's project and tracker
  - Reduced wizard steps (priority → subject → description → hours → due date)

### Fixed

- **Positron stable compatibility** - lowered VS Code engine from 1.106 to 1.105
- **Billable tracker detection** - now matches "Tasks" (was "Task")

---

- **Drag-to-link relations** in Gantt chart - drag from link handle on bar to another bar
  - Visual feedback: arrow with arrowhead follows cursor, target highlights
  - Inline picker for all 6 Redmine relation types with tooltips
- **Improved relation arrows** (GitLens-inspired):
  - Smooth bezier curves instead of elbow paths
  - Distinct colors per type: blocks (red), precedes (purple), follows (blue), relates (gray dashed), duplicates (orange dotted), copied (teal dashed)
  - Smart routing to avoid bar overlap
  - Legend showing all relation types and colors
  - Detailed tooltips explaining each relation's behavior
- **Past-portion texture** - Redmine-style diagonal red stripes show elapsed time on bars
- **Past bars dimmed** - issues with due date before today are desaturated
- **Parent issues as summaries** - bracket-style bars, no drag (dates derived from subtasks)
- **Progress bars** - done_ratio shown as fill on Gantt bars
- **View History** - see issue updates/comments via "View history" action
- **Relation removal** - right-click dependency arrows to delete, with hover effect
- **Gantt accessibility** - keyboard navigation (Arrow Up/Down, Enter), focus indicators, ARIA labels
- **Interactive walkthrough** - 4-step onboarding guide (configure, view issues, log time, timeline)

### Security

- **BREAKING**: HTTPS now required - HTTP URLs rejected
- **BREAKING**: TLS certificate validation always enabled
- Removed `rejectUnauthorized` setting (was insecure default)

### Changed

- **View renamed**: "Projects" → "My Issues" (better describes content)
- **Default view style**: Tree view (was list) - groups issues by project hierarchy
- **Parent project highlighting**: Projects with subproject issues are now highlighted
- **Command prefixes**: Toggle commands now use "Redmine:" prefix
- **Status bar**: Workload now on left side (workspace status)
- **Notifications**: Success messages use status bar instead of popups

### Fixed

- **Time logging activity validation** - uses project-specific activities when configured
- Silent error catch in IssueController.listActions() now shows errors
- Unsafe `reason as string` casts replaced with `errorToString()`
- HTTP requests now timeout after 30s (prevents indefinite hangs)
- HTTP error messages now user-friendly (5xx, 4xx, network errors)
- **Subproject filter logic was inverted** - fixed in getOpenIssuesForProject
- **Gantt timeline clicks now work** - was passing wrong args to command
- **422 errors now show Redmine's actual error message** - not generic "Validation failed"
- **Icon colors restored** - non-billable issues show ○ prefix instead of removing status color

### Changed

- Git hooks auto-install on `npm install` via prepare script
- Deduplicated date utilities (-60 lines)
- Config changes and refresh debounced (300ms) to prevent API spam
- Magic numbers extracted to named constants

### Removed

- Legacy v1.x migration webview (no longer needed)

## [3.9.0] - 2025-11-26

### Added

- **Workload heatmap toggle** in Gantt chart - shades days by aggregate utilization
  - Green (<80%), Yellow (80-100%), Orange (100-120%), Red (>120%)
- **Zoom preserves center date** - switching zoom levels keeps same date centered

### Fixed

- Gantt bar segments now align with background grid (was off by 1 day)
- Intensity line now renders as step function spanning full day width

## [3.8.0] - 2025-11-25

### Added

- **Consolidated Projects view** - merged "Issues assigned to me" into Projects
  - Issues assigned to you grouped under their projects
  - Projects with assigned issues shown first (with count)
  - Projects without assigned issues dimmed/deemphasized
  - Enhanced tree items with flexibility scores under projects
- **Timeline button in view title** - calendar icon for quick Gantt access

### Changed

- **Quick update now first in issue actions** - most common action at top
- Removed separate "Issues assigned to me" view (consolidated into Projects)

## [3.7.0] - 2025-11-25

### Added

- **Gantt timeline webview** - SVG-based visual timeline (`Redmine: Show Timeline`)
  - Bars colored by flexibility status (overbooked/at-risk/on-track/completed)
  - Click bars to open issue actions
  - Weekly date markers with today indicator
- **Sub-issue hierarchy** - Collapsible parent/child tree view
  - Parent containers for unassigned parents (aggregated hours)
  - API fetches with `include=children,relations`
- **Issue relations display** - Shows blocking dependencies
  - 🚫 blocked indicator in tree description
  - Relations grouped by type in tooltip
  - Blocked issues sorted to bottom
- **Billable visibility** - Tracker info in tooltips
  - Non-billable issues (tracker !== "Task") dimmed
  - Tracker name shown in tooltip
- Unified time logging UX (IssueController matches QuickLogTime flow)
  - Separate hours/comment inputs (not "hours|comment")
  - Flexible time formats: 1.5, 1:30, 1h 30min
  - Status bar confirmation

### Changed

- Issue model extended with parent/children/relations fields
- Tree sorting considers blocked status

## [3.6.0] - 2025-11-25

### Added

- Claude Code hooks for AI-assisted development
  - UserPromptSubmit: Inject git branch/status context
  - PreCompact: Log context compaction events for debugging
- SessionStart extended: Node version validation, auto npm install
- Claude hooks test suite (5 tests)

### Changed

- Hooks organized in scripts/hooks/ directory
- SessionStart now validates Node >=20 and auto-installs npm deps

## [3.4.0] - 2025-11-24

### Added

- MVP-4: Workload Overview status bar item
- Shows remaining work and capacity buffer at a glance
- Rich tooltip with top 3 urgent issues
- Opt-in via `redmine.statusBar.showWorkload` setting (default: false)
- Event-driven updates on tree refresh and config change
- MyIssuesTree.getIssues() method for workload calculation

### Changed

- Status bar format: "25h left, +8h buffer"
- Click status bar to list open issues

## [3.3.0] - 2025-11-24

### Added

- MVP-1: Timeline & Progress Display with flexibility scores
- Dual flexibility formula: initial (planning quality) + remaining (current risk)
- Risk status indicators: On Track, At Risk, Overbooked, Done
- ThemeIcon + ThemeColor for accessible risk display
- Rich tooltip with progress, days remaining, hours remaining, flexibility %
- Issues sorted by risk priority (overbooked first)
- Context menus for issues: Open in Browser, Quick Log Time, Copy URL
- Working hours memoization for performance
- Config listener for weeklySchedule changes

### Changed

- Issue tree items now show enhanced format: "#id spent/est days status"
- "Issues assigned to me" view sorted by urgency
- Pre-calculated flexibility in getChildren() to avoid UI freeze

## [3.2.1] - 2025-11-24

### Added

- Issue caching in time entries tree (fetches issue details from /issues API)
- Batch issue fetching to avoid N+1 queries
- Tooltip with "Open in Browser" command link for time entries
- Dependency injection for HTTP client (improves test reliability)

### Fixed

- UI blocking on sidebar click (252ms → <10ms via async loading)
- Command URI encoding for markdown tooltips
- Null/undefined API response handling (optional chaining)
- CI test failures from module mock timing issues
- Mock endpoint path for time entry activities

## [3.2.0] - 2025-11-24

### Added

- Quick Time Logging (MVP-3): Ctrl+Y Ctrl+Y keybinding for fast time entry
- Recent issue/activity cache (<24h) for one-click logging
- Flexible time format support: decimal (2.5), HH:MM (1:45), units (1h 45min)
- Optional comment field for time entries
- Activity name shown in all prompts for clarity
- Status bar confirmation (3s flash) after logging
- Extension activation on startup for keybindings

### Fixed

- Auto-select single workspace folder (no picker prompt)
- Unhandled promise rejection in list-open-issues command

## [3.1.0] - 2025-11-23

### Changed

- "Issues assigned to me" UI: simplified to "{Subject} #{id}"
- "Projects" view issues: same simplified format as assigned issues
- Issue number now rendered with reduced opacity (both views)
- Refactored: shared `createIssueTreeItem()` utility (DRY)
- eslint.config.js → eslint.config.mjs (eliminates Node.js warning)
- tsconfig.json: added *.mjs to exclude list

### Added

- tree-item-factory utility for consistent issue display
- MyIssuesTree tests (3 new tests)
- ProjectsTree tests (4 new tests)
- tree-item-factory tests (4 new tests, 109 total)

## [3.0.7] - 2025-11-23

### Fixed

- Memory leaks: server bucket now LRU cache (max 3 instances)
- Memory leaks: cleanup timer in LoggingRedmineServer
- Memory leaks: deactivate() now disposes all resources
- Data truncation: pagination for getIssuesAssignedToMe()
- Data truncation: pagination for getOpenIssuesForProject()
- N+1 query in applyQuickUpdate() (removed redundant GET)
- Pagination edge case: handle total_count=0 correctly

### Added

- Loading indicators for tree views (MyIssuesTree, ProjectsTree)
- Resource disposal in deactivate()
- LRU cache for server instances (prevents unbounded growth)

### Changed

- Quick update API calls now parallel (2-3s faster)
- Tree operations show "⏳ Loading..." during fetch
- Server instances auto-disposed when evicted from cache

## [3.0.6] - 2025-11-23

### Added

- Commit message validation hook (scripts/commit-msg)
- Hook installation script (scripts/install-hooks.sh)
- Commit message tests (7 new tests, 98 total)

### Changed

- Subject line limited to 50 chars
- Body lines limited to 72 chars
- Blank line enforced between subject and body
- Exceptions for merge and revert commits

## [3.0.5] - 2025-11-23

### Added

- Output channel for API call logging
- `redmine.logging.enabled` config (default: true)
- Commands: showApiOutput, clearApiOutput, toggleApiLogging
- ApiLogger utility: timestamp+counter+duration format
- LoggingRedmineServer: decorator pattern wrapping RedmineServer
- Protected hooks in RedmineServer: onResponseSuccess, onResponseError
- Request body logging (200 char truncation, redacted)
- Response size tracking in bytes
- Query parameter truncation (>100 chars)
- Binary content detection (image/*, application/pdf)
- Error response body logging
- Sensitive data redaction (password, api_key, token, secret)
- Redaction utility module

### Changed

- Log format: `[HH:MM:SS.mmm] [counter] METHOD path → status (duration) sizeB [binary]`
- Zero overhead when logging disabled
- All sensitive fields redacted in request/response logs

## [3.0.4] - 2025-11-23

### Fixed

- Extension activation error: removed `"type": "module"` from package.json (conflicts with CJS build output)

## [3.0.3] - 2025-11-23

### Changed

- Refactored promise chains to async/await in RedmineServer and IssueController
- Updated ESLint ecmaVersion from 2020 to 2023 for Node 20+ syntax support
- Added TypeScript strict compiler options: noUnusedLocals, noUnusedParameters, noImplicitReturns
- Removed unused server parameter from RedmineProject constructor

### Added

- npm scripts: `typecheck`, `clean`, `ci` for better DX

## [3.0.2] - 2025-11-22

### Changed

- Updated Vitest from 2.1.9 to 4.0.13
- Updated @vitest/coverage-v8 from 2.1.9 to 4.0.13
- Updated ESLint from 8.x to 9.39.1 (flat config)
- Updated eslint-config-prettier from 8.x to 10.1.8
- Updated eslint-plugin-prettier from 4.x to 5.5.4
- Updated Prettier from 2.x to 3.6.2
- Migrated from legacy .eslintrc to ESLint 9 flat config (eslint.config.js)

### Fixed

- Catch clause error variables now properly ignored with underscore prefix

## [3.0.1] - 2025-11-22

### Added

- Configure icon in view title (always visible)
- Config change listener: auto-update when URL/API key removed
- Security info modal on first-time setup (explains credential storage)
- Settings descriptions with security details

### Changed

- All Redmine settings now save to User settings (machine scope, not synced)
- URL prompt warns about API key reconfiguration when changing URL

### Fixed

- SVG logo: removed external DTD/entity references (eliminates browser fetch spam)
- Tree refresh guard: prevent fetches when server not configured
- Server cleared from trees when config removed
- Trees update immediately when config changes

## [3.0.0] - 2025-11-22

### BREAKING CHANGES

- **API keys in Secrets**: Machine-local, encrypted storage
- **VS Code 1.106+ required**: For latest API compatibility
- **TypeScript 5.7**: Modern language features
- **Bundle size reduced**: 80KB smaller (lodash removed)

### Migration

See [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md)

### Added

- `redmine.setApiKey` command
- Comprehensive test suite (60% coverage)

### Removed

- lodash dependency
- Deprecated VS Code APIs

### Fixed

- Memory leaks (EventEmitter disposal)
- URL parsing edge cases

## 1.1.1 - 17.08.2022

### Fixed

- [Issue #53](https://github.com/rozpuszczalny/vscode-redmine/issues/53)

## 1.1.0 - 19.01.2022

### Added

- [Issue #34](https://github.com/rozpuszczalny/vscode-redmine/issues/34) - display subprojects as a tree and toggle back to flat view (thanks to [doganOz](https://github.com/doganOz)!)
- Code of conduct, contributing guide and issue template

### Changed

- eslint rules to be more restrictive
- small refactor

## 1.0.4 - 13.10.2021

### Fixed

- [Issue #37](https://github.com/rozpuszczalny/vscode-redmine/issues/37)

## 1.0.3 - 21.09.2020

### Fixed

- [Issue #30](https://github.com/rozpuszczalny/vscode-redmine/issues/30)

## 1.0.2 - 25.08.2020

### Added

- Updated link 😇

## 1.0.1 - 25.08.2020

### Added

- Link to my website

## 1.0.0 - 25.08.2020

### Fixed

- [Issue #23](https://github.com/rozpuszczalny/vscode-redmine/issues/23)

### Added

- [Issue #18](https://github.com/rozpuszczalny/vscode-redmine/issues/18) Showcase of features in README.md
- [Issue #16](https://github.com/rozpuszczalny/vscode-redmine/issues/16) Mulitroot support - configuration can be set in `settings.json` file, under `.vscode` folder of workspace folder.
- ESLint and Prettier
- [Issue #11](https://github.com/rozpuszczalny/vscode-redmine/issues/11) Sidebar panel with issues assigned to user and list of projects

### Removed

- 💥 `serverUrl`, `serverPort`, `serverIsSsl` and `authorization` settings; use `url` and `additionalHeaders` instead.

### Changed

- Bumped to TypeScript 3
- Align code to ESLint suggestions
- Format codebase with Prettier

## 0.5.1 - 30.01.2019

### Changed

- Updated README.md with new features description

## 0.5.0 - 30.01.2019

### Added

Thanks to **[MarkusAmshove](https://github.com/MarkusAmshove)**:

- Quick update action for issue
  - You can quickly change issue status, assigned and add note
- Open issue actions from number selected in document

## 0.4.0 - 16.09.2018

### Added

- Custom `Authorization` header
  - You can configure `Authorization` header by setting `redmine.authorization`.

## 0.3.1 - 20.08.2018

### Fixed

- [Issue #7](https://github.com/rozpuszczalny/vscode-redmine/issues/7) (thanks to **[hanyuzhou2006](https://github.com/hanyuzhou2006)** for discovering and fixing an issue!)

## 0.3.0 - 21.06.2018

### Added

- Create issue command
  - You can configure project name under `redmine.projectName` setting
  - You can choose project from the list, if `redmine.projectName` isn't configured
- 0.2.2 `CHANGELOG.md` entry

### Changed

- 0.2.1 correct year in `CHANGELOG.md`

## 0.2.2 - 07.06.2018

### Added

- Attribution of Redmine Logo

## 0.2.1 - 07.06.2018

### Added

- Extension icon

### Changed

- Display name

## 0.2.0 - 02.06.2018

### Added

- `rejectUnauthorized` parameter, which is passed to https request options
- Missing open by issue id in feature list in `README.md`
- Information about future features in `README.md`

## 0.1.1 - 14.03.2018

### Fixed

- messy issue description in quick pick

## 0.1.0 - 04.02.2018

Added more basic functionalities to this extensions.

### Added

- possibility to change issue status
- possibility to add time entries to issue
- getting issue actions by typing in an issue id

### Changed

- splitted changelog entries into separate sections

### Removed

- `Release notes` section in `README.md` - it can be viewed here, so there is no reason to copy that across multiple files

## 0.0.2 - 28.01.2018

### Added

- repository URL to `package.json`, so VSCode Marketplace see `README.md` and other files

## 0.0.1 - 28.01.2018

Initial release of `vscode-redmine`

### Added

- list of issues assigned to API key owner
- possibility to open issue in browser
- configuration for server and API key
