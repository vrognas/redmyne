# Change Log

All notable changes to the "Redmyne" extension will be documented in this file.

## [4.12.5]

### Added

- **FTE-aware flexibility** - users' FTE% custom field (id=18) scales capacity for flexibility calculations
  - Current user tasks: use your custom schedule settings
  - Other users' tasks: scale default schedule by their FTE%
  - Unknown/missing FTE: defaults to 100%

### Improved

- **Assignee badges** - expanded to 12 colors with fill+stroke combos (144 unique combinations)
- **Past bars** - slightly brighter saturation (50% vs 40%) for better visibility
- **Resize handle** - glow effect on active drag

### Internal

- **Gantt maintainability** - extracted ~800 LOC to stateless generator module
  - Labels, cells, bars delegated to `gantt-html-generator.ts`
  - Fixed O(n²) `collectProjectIds` algorithm
  - Added timeline right padding (220px) for badge overflow

## [4.12.4]

### Fixed

- **Draft mode button** - now adapts to VS Code theme colors
- **Assignee badges** - use theme-adaptive chart colors (6 distinct colors per person)

## [4.12.2]

### Changed

- **B hotkey** - now toggles all badges (progress, flexibility, assignee, blocks/blocked)
- **Removed Heatmap** - redundant with Intensity + Capacity ribbon
- **Removed Health Filter** - F hotkey removed, health badges still visible on bars

## [4.12.1]

### Improved

- **Gantt dependency badges** - redesigned with intuitive emoji icons
  - ⏳ (hourglass) at bar start: "waiting on X issues"
  - ⛔ (stop) at bar end: "blocking X issues"
  - Yellow for 1 dependency, red for 2+
  - Link anchors now use theme colors

### Fixed

- **TypeScript errors** - fixed type definitions for Gantt panel
  - Added `removeDraft` to webview message types
  - Added extended scheduling relation types (SS, SF, FF, FS)
  - Made `start_date` nullable in Issue/FlexibilityIssue types

## [4.10.1]

### Improved

- **Time Sheet stateless webview** - refactored webview to pure renderer pattern
  - Extension owns all state; webview renders from message data
  - Cascade data (projects, issues, activities) sent with render messages
  - Reduced coupling between extension and webview
  - Cleaner separation of concerns for maintainability

## [4.10.0]

### Added

- **Editable aggregated rows** - edit hours in aggregated (merged) rows
  - Empty cell → creates new entry
  - Single entry → updates that entry
  - Multiple entries → replaces with single entry (shows toast + undo)
  - Set to 0h → deletes all source entries
  - Multi-entry cells show count badge and glowing border
  - Delete/duplicate enabled for aggregated rows
  - Toast notifications with undo for destructive actions

## [4.9.0]

### Added

- **Time Sheet sorting** - click column headers to sort rows
  - Sortable columns: Client, Project, Task, Activity, Comments, Total
  - Click once for ascending, again for descending, third click clears
  - Sort indicator (▲/▼) shows current sort state

- **Time Sheet comments column** - prominent Comments field per row
  - Wider column for better visibility (comment-centric design)
  - Persists with time entries on save
  - Supports sorting

- **Time Sheet #ID in dropdowns** - Client and Project dropdowns show project IDs
  - Format: `#123 ProjectName` for easier identification
  - "Others" group shows no ID prefix

- **Time Sheet undo/redo** - revert hour changes with keyboard shortcuts
  - `Ctrl+Z` / `Cmd+Z` to undo
  - `Ctrl+Shift+Z` / `Cmd+Shift+Z` to redo
  - `Ctrl+Y` also works for redo on Windows/Linux
  - `Escape` restores original value while editing

### Improved

- **Time Sheet premium aesthetic** - refined visual design
  - Rounded hover highlight on hour cells
  - Only dirty (changed) cells show draft background
  - Focus outline without background change
  - Theme-aware dropdown colors with native chevron
  - Low-opacity grid lines for cleaner table appearance
  - Monospaced font for time values, sans-serif for labels
  - Today column glow effect with focus border color
  - Row hover highlighting across all cells
  - Progress bars in Daily Total row showing actual/target hours
  - Icon-based action buttons (🗑️ Delete, 📋 Copy)
  - "Add Time Entry..." link-style button in footer
  - All colors theme-aware (adapts to VS Code theme)
  - Custom scrollbar styling matching VSCode aesthetic

- **Time Sheet performance** - faster dropdown loading
  - Uses cached issues from sidebar (avoids redundant API calls)
  - Parallel loading of issues and activities for selected project

- **Time Sheet cascading dropdowns** - Client → Project → Task → Activity
  - Select Client (parent project) first to enable Project dropdown
  - Select Project to enable Task (issue) dropdown
  - "Others" group for orphan projects without parent
  - Search button bypasses cascade, auto-fills all fields
  - Existing rows pre-populate all dropdowns on load

## [4.8.0]

### Added

- **Time Sheet webview** - week-by-week time entry editing
  - Open via table icon in Time Entries pane header
  - Auto-enables Draft Mode for batch operations
  - Navigate weeks (prev/next/today)
  - Add, delete, duplicate rows
  - Searchable issue picker per row
  - Activity dropdown per row
  - Daily hours input with dirty tracking
  - Daily/weekly totals with target indicators

## [4.7.0]

### Improved

- **Log Time context menu** - right-click issue → Log Time now auto-selects that issue
- **Internal Estimate submenu** - renamed items to "Set" and "Clear"

## [4.6.0]

### Added

- **Copy/Paste Time Entries** - copy and paste time entries, days, or weeks
  - Copy single entry: right-click time entry → Copy
  - Copy day: right-click day group → Copy Day
  - Copy week: right-click week group → Copy Week
  - Paste to day or week targets with smart date mapping
  - Week→week preserves day-of-week (Mon→Mon, Tue→Tue)
  - Respects working days from `weeklySchedule` and monthly overrides

## [4.5.0]

### Changed

- **Settings UX overhaul**
  - Renamed: `url` → `serverUrl`, `autoUpdateDoneRatio` → `autoUpdateDonePercent`
  - Hidden from UI (power-user): `defaultProject`, `additionalHeaders`
  - Removed deprecated: `apiKey`, `hoursPerDay`, `workingDays`
  - Merged `extendedRelationTypes` into `visibleRelationTypes` (auto-detects server types)
  - Simplified welcome message to single "Configure" button
  - Fixed duplicate Cancel buttons in modal dialogs

## [4.4.0]

### Added

- **Draft Mode** - queue write operations locally before sending to Redmine
  - Toggle via command palette or status bar
  - Status bar shows pending draft count with warning indicator
  - Review panel to inspect, apply, or discard pending drafts
  - Per-draft removal and per-draft apply supported
  - Server identity validation prevents applying drafts to wrong server
  - Persists across VS Code restarts
  - Supports all write operations: issue CRUD, time entries, versions, relations

### Improved

- **Draft Review Panel UX**
  - Incremental DOM updates via postMessage (no full page refresh)
  - Loading/processing states with visual feedback
  - Confirmation dialog for Discard All
  - Per-row apply button to apply individual drafts
  - Sticky header for better navigation on long lists
  - Keyboard navigation: Arrow keys, Enter (apply), Delete (remove)

## [4.3.0]

### Changed

- **User-facing terminology** - command palette, error messages, and panel titles now say "Redmyne" instead of "Redmine" to distinguish the extension from the server software

## [4.2.0]

### Added

- **Project tooltips** - hover projects in tree view and Gantt to see custom fields

### Fixed

- **Create Sub-Issue menu** - only appears for root issues without a parent
- **Gantt loading UI** - moved loading text to header
- **Gantt "All Projects"** - project selector now allows viewing all projects in by-project view
- **Gantt sorting in by-person view** - column sorting now works correctly

## [4.1.0]

### Added

- **Fuzzy issue search** - multi-term queries like "nuvalent non" now match issues across subject + project name (uses fuse.js)
- **Search operators** - `project:xxx` and `status:xxx` filters in issue picker
- **Recent issues** - previously selected issues shown first with $(history) icon
- **Visual grouping** - issue picker grouped by Recent/Assigned/No Time Tracking sections

### Changed

- **Faster debounce** - search debounce reduced from 300ms to 150ms
- **Fuse index caching** - search index cached for 1 minute, faster subsequent searches

## [4.0.0]

### BREAKING CHANGES

- **Namespace renamed**: All extension identifiers changed from `redmine.*` to `redmyne.*`
  - Settings: `redmine.url` → `redmyne.url`, `redmine.workingHours.*` → `redmyne.workingHours.*`, etc.
  - Commands: `redmine.configure` → `redmyne.configure`, etc.
  - Views: `redmine-explorer-*` → `redmyne-explorer-*`
  - Context keys: `redmine:configured` → `redmyne:configured`
- **Automatic migration**: API key and all preferences auto-migrate on first v4.0.0 startup

### Changed

- Distinguishes extension "Redmyne" from server software "Redmine"
- Class names (RedmineServer, etc.) unchanged (they interface with Redmine server)

## [3.25.1]

### Changed

- **Gantt performance** - instant toggles (heatmap, capacity, intensity, dependencies) via CSS-only updates
- **Computation caching** - workload/capacity data cached with revision counters; invalidates on filter changes
- **Selection optimization** - O(1) bar lookup for single-item selection updates
- **Collapse caching** - stripe contributions parsed once, cached for reuse
- **Intensity toggle O(1)** - uses container class instead of iterating all bars
- **Perf logging config** - `redmyne.gantt.perfDebug` setting gates timing logs in both extension and webview

## [3.25.0]

### Added

- **Plan your day → Kanban** - "Plan your day" wizard now creates Kanban tasks in Doing board instead of Today's Plan
- **Client folders** - Kanban groups tasks by parent project (client) → project hierarchy in To Do and Done boards
- **Refresh parent projects** - button to populate parent project info for existing tasks

### Changed

- **Done board at top** - Kanban board order is now Done → Doing → To Do
- **Projects without parent** - shown directly under status header (no "No Client" wrapper)
- **Folder icons** - match Issues view styling (folder-opened with accent color)
- **Hidden Gantt commands** - webview commands no longer clutter command palette

## [3.24.0]

### Added

- **Drag date tooltip** - shows target date when dragging Gantt bar edges (start/due); displays "Start: Jan 15 (Wed)" or "Due: Jan 18 (Sat)" for resize, range arrow for move
- **Copy subject commands** - right-click Kanban tasks or Timer units to copy subject to clipboard

## [3.23.1]

### Changed

- **Minimum VS Code version** - now requires VS Code ^1.106.0 (was ^1.105.0)
- **Minimum Positron version** - now requires Positron ^2025.12.0 (was ^2025.06.0)

## [3.23.0]

### Fixed

- **Timer settings now update pending plan units** - changing work/break duration updates all pending (not yet started) units in today's plan
- **Kanban add-to-plan uses current timer settings** - previously used stale value captured at extension activation
- **Open issue in Gantt shows correct project** - switches to issue's project view before scrolling

### Changed

- **Simplified loading placeholder** - cleaner "Loading..." text instead of skeleton blocks

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
- **Configurable concurrent requests** - `redmyne.maxConcurrentRequests` setting (1-20, default 2)

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
- Opt-in via `redmyne.statusBar.showWorkload` setting

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
- `redmyne.logging.enabled` config
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

- `redmyne.setApiKey` command
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
