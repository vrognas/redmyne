# Change Log

All notable changes to the "Redmyne" extension will be documented in this file.

## [3.22.0]

### Added

- **Priority submenu** - set issue priority from context menu (Low, Normal, High, Urgent, Immediate, Other) in both Gantt and sidebar
- **% Done submenu for sidebar** - sidebar issues now have same quick % Done options as Gantt
- **Status submenu for sidebar** - sidebar issues now have same quick status options as Gantt
- **On/Off submenus** - Auto-update %, Ad-hoc Budget, and Precedence now use explicit On/Off submenus instead of toggle commands
- **Internal Estimate submenu** - Set.../Clear options in both Gantt and sidebar
- **Create Sub-Issue conditional** - option hidden for issues that are already children of another issue
- **Issue Priority support** - display, change, and filter by Redmine priority; priority shown in tree tooltips, Gantt data, and issue actions menu; API filtering via `getFilteredIssues({ priority: id })`
- **showCalculatedPriority config** - optional setting to show calculated priority score (based on due date urgency, downstream dependencies, external blocks) in Gantt tooltips
- **Set % Done submenu** - Gantt bar context menu now has "Set % Done" submenu with 0-100% quick options (10% increments) plus "Custom..." for input picker
- **Set Status submenu** - Gantt bar context menu now has "Set Status" submenu with "New", "In Progress", "Closed" quick options plus "Other..." for all statuses picker
- **Actual time entry reconciliation** - past-day intensity now uses actual logged hours instead of predictions; today and future use priority-based scheduling
- **Priority-based capacity scheduling** - capacity/intensity now uses frontloaded day-by-day simulation; prioritizes by due date urgency, external blocks (2x weight), and downstream count
- **Gantt bar intensity visualization** - bars show scheduled work distribution (person view); intensity lines indicate when work is actually scheduled vs uniform spread
- **Internal estimates** - right-click issue to set manual "hours remaining" when original estimate is outdated; takes highest priority in capacity calculation
- **Precedence priority tag** - right-click issue to tag as precedence; tagged issues always scheduled first (+10000 priority bonus)
- **Ad-hoc budget transfers** - tag issues as ad-hoc budget pools; time entries on ad-hoc issues can contribute hours to other issues via `#<id>` in comments
- **Gantt contribution display** - tooltip shows contributed hours breakdown (direct + from ad-hoc)
- **Time entry contribution commands** - right-click time entries on ad-hoc issues to set/remove contribution target
- **Gantt toggle ad-hoc** - right-click context menu to tag/untag issues as ad-hoc budget
- **Gantt left column scroll** - horizontal scroll for issue/project names, hover shows full name
- **Configurable concurrent requests** - `redmine.maxConcurrentRequests` setting (1-20, default 2)

### Changed

- **Context menu harmonization** - Gantt and sidebar context menus now have consistent structure; grouped by intent (navigation, actions, properties, time, settings, integrations, clipboard)
- **Submenu labels shortened** - removed "Set" prefix from "% Done", "Status", "Priority" submenus
- **Show in Issues renamed** - "Show in Issues" → "Show in Sidebar" for clarity
- **Color harmonization** - unified color semantics across Gantt: GREEN=done, BLUE=on-track (muted), YELLOW=at-risk, RED=overbooked; uses VS Code theme variables for full theme integration
- **Gantt bar opacity** - on-track bars muted (60% opacity) to let alert states (red/yellow/green) pop per 60-30-10 UX rule
- **Dependency arrows simplified** - consolidated from 6 colors to 3: blocking (red), scheduling (blue), informational (gray)
- **Badges reduced** - removed progress % badge and checkmark; bar color + fill now conveys status; kept flex/blocks/blocker/assignee
- **Ad-hoc contribution uses issue picker** - "Contribute to Issue" now uses searchable issue picker instead of manual ID entry; allows selecting issues from projects without time tracking (contributions are links, not time entries)
- **Time entries single fetch** - reduced API calls from 4 to 1 by fetching all periods at once and filtering client-side
- **Request queue with concurrency limit** - API requests now queued with max 2 concurrent to prevent server overload (503 errors)
- **Batched pagination** - pagination requests now fetched in batches of 2 instead of all at once
- **Gantt batched requests** - contribution/version fetches now batched to respect concurrency limit
- **Gantt bar labels outside** - %done badge and assignee now appear after bar; adaptive positioning flips to left when near edge
- **Gantt toolbar redesign** - grouped controls, SVG icons, collapsible legend row, overflow menu
- **Gantt default zoom** - changed from Day to Month level
- **Gantt collapse performance** - collapse/expand now client-side without HTML regeneration; debounced + cached hierarchy
- **Debounce utility** - extracted shared `debounce()` function; refactored 5 manual debounce patterns
- **Gantt gridlines visibility** - increased opacity for clearer day/week markers
- **Current user caching** - `/users/current.json` cached for session duration
- **Issue lookup caching** - `getIssueById` cached with 60s TTL, auto-invalidated on mutations
- **Gantt single time entries fetch** - contributions now fetch all time entries in one request instead of per-project
- **Gantt by-person optimizations** - skip versions fetch in person mode; user filter for contribution fetching
- **Gantt bar tooltip enhanced** - now shows progress %, estimated, spent, and contributed hours
- **Gantt contribution fetch date filter** - only fetches time entries within displayed issues' date range
- **Gantt timeline range by displayed issues** - timeline range uses only actually displayed issues, not all issues in same projects
- **Capacity tooltip shows project** - breakdown now shows project name instead of subject (issue ID already visible)
- **Internal estimate prompt on %done** - setting manual %done now prompts for hours remaining
- **Gantt native context menu** - issue bars now use VS Code native context menus instead of custom HTML
- **Gantt project context menu** - project labels now have native VS Code context menu with "Open in Browser" and "Show in Gantt"
- **Gantt VS Code-style chevrons** - collapse/expand arrows now match native VS Code tree view with rotation animation
- **Gantt font size harmonization** - column text sizes aligned with VS Code defaults (13px body, 12px headers)
- **Sidebar loading indicator** - simplified to single row with spinning disc and "Loading..." text
- **Gantt per-project view** - top-level project row removed; shows "Client: Project" title in header
- **Gantt continuous indent guides** - vertical lines rendered as single continuous SVG layer without row gaps

### Fixed

- **Today-line timezone** - today marker now uses local date instead of UTC; fixes wrong day display around midnight
- **Closed issues excluded from capacity/intensity** - issues with `closed_on` set now excluded from capacity and intensity calculations
- **Gantt refresh on time entry changes** - Gantt now refreshes when time entries are added/edited/deleted
- **Gantt refresh on contribution changes** - Gantt refreshes when setting/removing contribution targets
- **Contributions from non-displayed ad-hoc issues** - contributions now calculated from ALL ad-hoc issues, not just displayed ones
- **Cross-user contributions** - contributions from other users' time entries now included in calculations
- **Progress bar includes contributions** - visual progress now accounts for contributed hours from ad-hoc issues
- **Issue picker duplicate results** - search results no longer duplicate issues already shown in assigned list
- **Time entries empty month expansion** - "This Month" now shows fallback message when empty instead of failing to expand
- **Gantt by-person timeline range** - timeline no longer extends to old issues assigned to others in same project
- **Gantt zebra stripe overlap on collapse** - stripes now shrink correctly when parents collapsed; delta calculated from contributions ensuring consistent behavior across project and person views
- **Gantt by-project collapse-all** - issues no longer disappear when collapse-all used in by-person view then switching to by-project
- **Intensity off-by-1** - fixed timezone mismatch causing intensity bars to show on wrong day
- **Internal estimates in scheduling** - issues with internal estimates but no Redmine estimate now included
- **Week subgroup ID collision** - fixed duplicate week ID error when same week spans multiple month groups
- **Gantt column cells collapse** - Status, ID, Start, Due, Assignee columns now hide when parent collapsed
- **Gantt parent issues collapse** - click-to-collapse/expand now works for parent issues, not just projects
- **Gantt dependency arrows collapse** - arrows now hide when source or target issue is collapsed
- **Gantt time-group collapse** - time-group rows now properly collapse/expand
- **Gantt Today button disabled** - button grayed out with tooltip when today is outside timeline range; T hotkey shows modal

## [3.19.0]

### Added

- **Gantt multi-select** - Ctrl+click toggles, Shift+click selects range, Ctrl+A selects all, bulk drag moves all
- **Gantt minimap** - fixed bottom panel with full timeline, viewport indicator, click/drag to navigate
- **Gantt critical path** - toggle to highlight longest blocking chain (blocks/precedes relations)
- **Gantt drag bar to move** - drag bar body to shift both start/due dates together
- **Gantt %done display** - shows done percentage on non-closed issue bars
- **Gantt overdue indicator** - red outline/glow on overdue issues (past due, not closed, <100%)
- **Gantt keyboard navigation** - Home/End keys, visible active state, auto-scroll to focused item
- **Gantt project filter** - checkbox column to show/hide project issues; separate column with synced scroll
- **Gantt dynamic date range** - timeline min/max dates adjust to visible issues only

### Changed

- **Renamed "Personal Tasks" to "Kanban"** - clearer purpose; reflects kanban-style workflow
- **Gantt minimap styling** - subtle shaded viewport like VS Code minimap; drag without jumping
- **Gantt aggregate bars** - project bars now always visible, not just when collapsed

### Fixed

- **Gantt zebra stripe alignment** - fixed 1px misalignment between left column and timeline

### Security

- **Cryptographic nonce** - replaced Math.random with crypto.randomBytes for CSP nonces
- **CSP compliance** - removed unsafe-inline; all styles use nonces, inline styles converted to classes

## [3.18.0]

### Added

- **Opt-in auto-update %done** - per-issue toggle in context menu; when enabled, logging time auto-calculates %done from spent/estimated hours (capped at 99%)

### Changed

- **Faster issue loading** - parallel pagination reduces "All Issues" fetch from ~13s to ~2s
- **Faster time entries** - batch issue fetching replaces N+1 individual API calls
- **Gantt click behavior** - clicking issue/bar now scrolls to bar start instead of opening update dialog
- **Gantt context menu** - added "Update Issue..." option, removed emojis for native VS Code look
- **Faster hierarchy building** - O(n) project children lookup instead of O(n²)
- **Faster startup** - setContext runs parallel with server init

### Fixed

- **Gantt dependency arrows clipped** - arrows now render past timeline edge
- **Infinite refresh loop** - sorting issues no longer triggers Gantt cache clear loop

## [3.17.0]

### Added

- **Sorting dropdown menus** - sort Issues by #ID, Subject, Assignee; sort Time Entries by #ID, Subject, Comment, User
- Toggles direction (asc/desc) when clicking same field again

### Changed

- **Consistent issue styling** - all issues now use enhanced format (`#id Subject` with hours) regardless of flexibility data availability
- **Hierarchical issue display** - sub-issues now appear nested under parent issues in tree view

## [3.16.0]

### Added

- **Issue filter presets** - quick pick with filter options: My Open (default), All Open, My Closed, All Issues
- **Time entries filter** - toggle between my time and all users' time
- **Assignee/user display** - shows assignee on issues and user on time entries when filtered

### Changed

- **Renamed views** - "My Issues" → "Issues", "My Time Entries" → "Time Entries"
- **Unified filter API** - `getFilteredIssues(filter)` consolidates issue queries
- Filter button shows filled icon when filtered, outline for default view

## [3.15.0]

### Added

- **Add to Personal Tasks** - context menu on My Issues to add issues to Personal Tasks
- **Workflow documentation** - README now explains the planning flow

### Fixed

- **Add Time Entry uses clicked date** - right-clicking a date now pre-selects that date

### Changed

- **DRY refactor** - consolidated date utilities, getWeeklySchedule, error handling
- **Tree item info density reduced** - label now `#id Subject`, status via icon color only
- **Gantt progressive disclosure** - Deps/Intensity toggle buttons in toolbar
- **Actionable error feedback** - config errors show "Configure" button for quick setup
- **Contextual hints** - keyboard shortcuts in command titles, tips in welcome views
- **Timer phase clarity** - enhanced tooltips with phase explanations, dynamic tree title
- **Wizard back navigation** - Create Issue wizard now supports going back to previous steps

## [3.14.0]

### Changed

- **BaseTreeProvider abstraction** - all tree providers now extend shared base class (DRY refactor)
- **Timer plan persists indefinitely** - no auto-clear on new day; manual clear only
- **Rebranded** to "Redmyne" - clearer differentiation from original extension
- **New green logo** - distinct from original Redmine blue
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
- **Inline issue search in unit picker** - type directly to search by #ID or text
- **Empty working days in time entries** - show days with 0 logged hours based on weekly schedule
- **Add Time Entry from day** - right-click day in time entries to add entry for that date
- **Enter/click starts timer unit** - click or Enter on tree item starts/pauses unit
- **Start Timer respects selection** - title bar button starts selected unit

## [3.13.0]

### Added

- **Pomodoro/Unit Timer** (Ctrl+Y Ctrl+T) - plan work units with auto-logging
  - Day planning wizard: pick unit count, assign issues/activities
  - 45min work + 15min break cycles (configurable)
  - Status bar shows timer countdown, current issue, progress
  - "Today's Plan" tree view shows all units with status
  - Auto-log time when unit completes
  - Sound notification on completion
  - State persists across VS Code restarts
- **Date picker for Quick Log Time** - log time on previous days
- **Day subdivisions in This Week** - time entries grouped by day
- **Week/day subdivisions in This Month** - entries grouped by week, then day
- **Start/due date in Quick Update** - change dates with presets
- **Quick Create Issue** (Ctrl+Y Ctrl+N) - create issues without leaving IDE
- **Create Sub-Issue** context menu action - right-click issue to create child

### Fixed

- **Positron stable compatibility** - lowered VS Code engine from 1.106 to 1.105
- **Billable tracker detection** - now matches "Tasks" (was "Task")

## [3.12.0]

### Added

- **Drag-to-link relations** in Gantt chart - drag from link handle to another bar
- **Improved relation arrows** (GitLens-inspired) - smooth bezier curves, distinct colors per type
- **Past-portion texture** - Redmine-style diagonal red stripes show elapsed time
- **Past bars dimmed** - issues with due date before today are desaturated
- **Parent issues as summaries** - bracket-style bars, dates derived from subtasks
- **Progress bars** - done_ratio shown as fill on Gantt bars
- **View History** - see issue updates/comments via "View history" action
- **Relation removal** - right-click dependency arrows to delete
- **Gantt accessibility** - keyboard navigation, focus indicators, ARIA labels
- **Interactive walkthrough** - 4-step onboarding guide

### Security

- **BREAKING**: HTTPS now required - HTTP URLs rejected
- **BREAKING**: TLS certificate validation always enabled
- Removed `rejectUnauthorized` setting (was insecure default)

### Changed

- **View renamed**: "Projects" → "My Issues"
- **Default view style**: Tree view (was list)
- **Command prefixes**: Toggle commands now use "Redmine:" prefix
- **Status bar**: Workload now on left side (workspace status)
- **Notifications**: Success messages use status bar instead of popups
- Git hooks auto-install on `npm install` via prepare script
- Config changes and refresh debounced (300ms)

### Fixed

- **Time logging activity validation** - uses project-specific activities
- Silent error catch in IssueController now shows errors
- Unsafe `reason as string` casts replaced with `errorToString()`
- HTTP requests now timeout after 30s
- HTTP error messages now user-friendly
- **Subproject filter logic was inverted**
- **Gantt timeline clicks now work**
- **422 errors now show Redmine's actual error message**
- **Icon colors restored** - non-billable issues show correct status color

### Removed

- Legacy v1.x migration webview

## [3.11.0]

### Added

- **Workload heatmap toggle** in Gantt chart - shades days by aggregate utilization
- **Zoom preserves center date** - switching zoom levels keeps same date centered

### Fixed

- Gantt bar segments now align with background grid
- Intensity line now renders as step function spanning full day width

## [3.10.0]

### Added

- **Consolidated Projects view** - merged "Issues assigned to me" into Projects
- **Timeline button in view title** - calendar icon for quick Gantt access

### Changed

- **Quick update now first in issue actions** - most common action at top
- Removed separate "Issues assigned to me" view (consolidated into Projects)

## [3.9.0]

### Added

- **Gantt timeline webview** - SVG-based visual timeline (`Redmine: Show Timeline`)
- **Sub-issue hierarchy** - Collapsible parent/child tree view
- **Issue relations display** - Shows blocking dependencies
- **Billable visibility** - Tracker info in tooltips, non-billable dimmed
- Unified time logging UX (separate hours/comment inputs, flexible formats)

### Changed

- Issue model extended with parent/children/relations fields
- Tree sorting considers blocked status

## [3.8.0]

### Added

- Claude Code hooks for AI-assisted development
- SessionStart extended: Node version validation, auto npm install

### Changed

- Hooks organized in scripts/hooks/ directory

## [3.7.0]

### Added

- **Workload Overview status bar item** - remaining work and capacity buffer
- Rich tooltip with top 3 urgent issues
- Opt-in via `redmine.statusBar.showWorkload` setting

### Changed

- Status bar format: "25h left, +8h buffer"

## [3.6.0]

### Added

- **Timeline & Progress Display** with flexibility scores
- Risk status indicators: On Track, At Risk, Overbooked, Done
- ThemeIcon + ThemeColor for accessible risk display
- Rich tooltip with progress, days remaining, flexibility %
- Issues sorted by risk priority (overbooked first)
- Context menus for issues: Open in Browser, Quick Log Time, Copy URL
- Working hours memoization for performance

### Changed

- Issue tree items now show enhanced format
- Pre-calculated flexibility in getChildren()

## [3.5.0]

### Added

- Issue caching in time entries tree
- Batch issue fetching to avoid N+1 queries
- Dependency injection for HTTP client

### Fixed

- UI blocking on sidebar click (252ms → <10ms via async loading)
- CI test failures from module mock timing issues

## [3.4.0]

### Added

- Quick Time Logging (Ctrl+Y Ctrl+Y) for fast time entry
- Recent issue/activity cache for one-click logging
- Flexible time format support: decimal, HH:MM, units
- Status bar confirmation after logging

### Fixed

- Auto-select single workspace folder

## [3.3.0]

### Added

- Output channel for API call logging
- `redmine.logging.enabled` config
- Commands: showApiOutput, clearApiOutput, toggleApiLogging
- LoggingRedmineServer: decorator pattern
- Sensitive data redaction

### Changed

- Log format with timestamp, counter, duration, size

## [3.2.0]

### Added

- Commit message validation hook
- Hook installation script

### Changed

- Subject ≤50 chars, body ≤72 chars enforced

## [3.1.0]

### Fixed

- Extension activation error: removed `"type": "module"` from package.json

## [3.0.3]

### Changed

- Refactored promise chains to async/await
- ESLint ecmaVersion 2020 → 2023
- Added TypeScript strict compiler options

### Added

- npm scripts: `typecheck`, `clean`, `ci`

## [3.0.2]

### Changed

- Updated Vitest, ESLint, Prettier to latest versions
- Migrated to ESLint 9 flat config

## [3.0.1]

### Added

- Configure icon in view title
- Config change listener
- Security info modal on first-time setup

### Fixed

- SVG logo external DTD/entity references removed
- Tree refresh guard

## [3.0.0]

### BREAKING CHANGES

- **API keys in Secrets**: Machine-local, encrypted storage
- **VS Code 1.105+ required**
- **TypeScript 5.7**: Modern language features
- **Bundle size reduced**: 80KB smaller (lodash removed)

### Added

- `redmine.setApiKey` command
- Comprehensive test suite (60% coverage)

### Removed

- lodash dependency
- Deprecated VS Code APIs

### Fixed

- Memory leaks (EventEmitter disposal)
- URL parsing edge cases

---

## Legacy Versions (pre-fork)

## 1.1.1 - 17.08.2022

### Fixed

- [Issue #53](https://github.com/rozpuszczalny/vscode-redmine/issues/53)

## 1.1.0 - 19.01.2022

### Added

- Subprojects as tree with toggle to flat view
- Code of conduct, contributing guide, issue template

## 1.0.4 - 13.10.2021

### Fixed

- [Issue #37](https://github.com/rozpuszczalny/vscode-redmine/issues/37)

## 1.0.3 - 21.09.2020

### Fixed

- [Issue #30](https://github.com/rozpuszczalny/vscode-redmine/issues/30)

## 1.0.0 - 25.08.2020

### Added

- Multiroot support
- Sidebar panel with issues and projects
- ESLint and Prettier

### Removed

- Legacy settings (`serverUrl`, `serverPort`, `serverIsSsl`, `authorization`)

## 0.5.0 - 30.01.2019

### Added

- Quick update action for issue
- Open issue actions from number in document

## 0.4.0 - 16.09.2018

### Added

- Custom `Authorization` header

## 0.3.0 - 21.06.2018

### Added

- Create issue command

## 0.2.0 - 02.06.2018

### Added

- `rejectUnauthorized` parameter

## 0.1.0 - 04.02.2018

### Added

- Change issue status
- Add time entries to issue
- Get issue actions by typing issue id

## 0.0.1 - 28.01.2018

Initial release - list issues, open in browser, configure server/API key
