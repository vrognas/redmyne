# Changelog

All notable changes to Redmyne are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

## [Unreleased]

## [4.26.3]

### Fixed

- **Dependency arrows track rows through collapse/expand** — arrow paths were computed once at render and only visibility-toggled afterwards, so arrows detached from their bars after collapse/expand shifted rows; paths now re-anchor to current row positions after every toggle (and bar drags compute endpoint Y from live positions instead of render-time values)

## [4.26.2]

### Fixed

- **Nested collapse/expand no longer corrupts row layout** — expanding a parent whose subtasks are themselves expanded parents repositioned rows in breadth-first order, wedging a later subtask between an earlier subtask and its children; a subsequent toggle then stacked rows on top of each other (overlapping labels). Visible descendants are now repositioned in document (pre-order) order

## [4.26.1]

### Fixed

- **Arrow-key date nudge is timezone-safe** — nudging start/due dates via keyboard now uses UTC parsing so dates don't shift by one day in negative-offset timezones
- **Minimap jump-click position** — click-to-scroll on the minimap now maps the click offset to the correct timeline position
- **Overdue and past bar styling** — bars compare dates in the UTC frame that the geometry uses, so past/overdue classes are applied consistently regardless of local timezone
- **Today line is timezone-consistent** — the today marker and scroll target use a UTC-midnight anchor matching the bar geometry reference frame
- **Dependency arrows and milestone markers aligned with bars** — x-positions for arrows and milestone diamonds use the same UTC-anchored geometry as bar start/end, eliminating sub-pixel drift
- **Capacity-ribbon week markers aligned with body gridlines** — week-marker lines iterate in the UTC frame so they coincide with the Monday gridlines in the main body
- **Lookback change re-fetches contributions** — changing the lookback slider now triggers a fresh contribution fetch instead of reusing stale data
- **Relation delay preserved through undo/redo** — undo/redo of relation edits now round-trips the `delay` field, preventing silent delay loss
- **Link-drag drop targets reliable** — drop-target hit detection accounts for row offsets so dragging a relation endpoint lands on the intended row
- **Clipboard HTML is properly escaped** — angle brackets in issue subjects are HTML-escaped before being placed in the copy buffer, preventing broken SVG fragments
- **Past shading for due-date-only issues** — issues with only a due date (no start date) now receive the past/overdue shading when the due date has passed
- **Ctrl/Alt+1–5 no longer hijack zoom** — the zoom-level keybindings are scoped to the Gantt webview context and no longer fire when the editor or other panels are focused

### Changed

- Internal: extracted `dateToX` / `endExclusiveX` helpers (`gantt-coords.ts`) — eliminates ~10 copies of the date→pixel formula scattered across `gantt-panel.ts` and `gantt-html-generator.ts`

## [4.26.0]

### Added

- **Gantt click-to-select rows** — click any part of a row (label, column cell, bar, or empty timeline lane) to select it; a full-row highlight band spans all columns. Selection syncs with keyboard navigation, persists across re-renders, and clears on Escape. Drag-release does not trigger selection

## [4.25.0]

### Added

- **Retry failed entries after a partial paste** — when some entries in a paste fail (e.g. a network blip mid-batch), the warning now offers a "Retry Failed" action that re-creates only the failed entries. Previously the only recourse was re-pasting the whole batch, which duplicated everything that had already succeeded. Retry re-runs until everything lands or you dismiss it; the success total accumulates across attempts

### Fixed

- **Copying an empty week no longer clobbers the clipboard** — mirroring the empty-day guard from 4.24.0, `Copy Week` on a week with no entries previously stored an empty, unpasteable clipboard (a dead end that also discarded whatever was previously copied). It now shows "Nothing to copy — week is empty" and leaves the existing clipboard intact
- **Current-week copy & paste now cover the full week** — copying the current week (toolbar or the "This Week" node), and the paste confirm's "already in target week" summary, previously read the tree's display cache, which stops at today. Entries dated later this week (e.g. hours logged in advance) were silently dropped from the copy and absent from the duplicate summary. Both now fetch the full Mon–Sun week; past weeks were already complete and are unaffected
- **Timesheet "Copy Week" skips unsaved cells** — it copied every cell with hours, including queued-but-unsaved draft creates, so pasting could duplicate work that wasn't committed yet. It now copies only persisted cells (those with a server id), matching the sidebar's deliberate draft exclusion

### Internal

- Extracted `buildPasteWorkItems` (pure, flattens a paste into `(date, entry)` items — the single source of truth for the count, execution, and retry) and `executePaste` (runs the items, returns successes + the items that failed) from the ~60-line inline paste loop. Paste stays sequential by design: in draft mode every entry serializes on the draft-queue persist lock so concurrency buys nothing, and in direct mode it avoids parallel writes to the Redmine server
- Decomposed the `pasteTimeEntries` command further into a pure, tested `resolvePasteTarget` (focused node → target day/week, with the fallback week passed in) and `runPasteWithRetry` (progress reporting + failed-item retry loop), leaving the command body as orchestration
- Consolidated five inline "draft entry = negative id" checks behind a single `isDraftEntry` predicate, and removed the now-unused `getISODayOfWeek` helper
- Added a shared `fetchFullWeekEntries` helper for the full-week copy/paste fetches, and simplified the paste handler's existing-entries extraction (dropped a redundant `in`-check + cast)

## [4.24.0]

### Added

- **Paste confirmation shows what lands where** — the confirm dialog is now scenario-aware. Pasting a day/entry across a week notes "on each of N working days" with the total entry count; pasting a week onto a week shows a per-day breakdown of which entries map to which day. Week targets also summarise entries already in the target week (per-day count + hours) so duplicates are visible before you commit, not just for single-day pastes. Extracted a pure, tested `buildPasteConfirmLines` helper

### Changed

- **Paste messages reflect draft mode** — when draft mode is active, pasting time entries now shows "Queueing time entries..." and "Queued N entries to draft" instead of "Creating..."/"Created N entries". Tree-pane paste always routed through the draft queue via the `DraftModeServer` wrapper; the wording just made it look like a direct commit. Threaded `isDraftMode` through `TimeEntryCommandDeps`
- **Closed-issue check deferred until after confirm** — `confirmLogTimeOnClosedIssues` (a batched server lookup) now runs only after the user clicks "Create" in the paste confirmation, so cancelling the paste no longer pays for the lookup

### Fixed

- **Copying an empty day no longer clobbers the clipboard** — `Copy Day` on a day with no entries previously stored an empty clipboard, which then failed to paste with "Clipboard is empty" (a dead end that also discarded whatever was previously copied). It now shows "Nothing to copy — day is empty" and leaves the existing clipboard intact

## [4.23.2]

### Fixed

- **Symmetric clipboard payload between Time Entries pane and Timesheet panel** — tree-pane copies now include `project_id` (which Timesheet paste needs to build its draft payload), and Timesheet copies now include `issueSubject` and `activityName` (which the tree paste confirm dialog renders). Cross-UI copy/paste no longer drops these fields. Custom fields remain tree-only until Timesheet rows track them
- **Clipboard cleared on Redmine server URL change** — module-level clipboard previously survived `redmyne.serverUrl` switches, leaving stale `issue_id` values that pointed at issues on the prior server. Paste would 404 or, worse, hit unrelated issues with the same numeric ID on the new server. `extension.ts` now calls `clearClipboard()` from the debounced config-change handler when `redmyne.serverUrl` changes

### Internal

- Extracted `toClipboardEntry(source)` helper in `time-entry-clipboard.ts` (Rule of Three — three nested-shape mappings in tree-pane copy commands collapsed to one call site each). Timesheet keeps its inline flat construction since it builds from a different source shape (`TimeSheetRow`). Both producers now populate the same `ClipboardEntry` fields where data is available

## [4.23.1]

### Fixed

- **Ctrl/Cmd+C in Time Entries pane never fired** — the 4.23.0 keybindings filtered on `viewItem =~ /^time-entry/`, but VS Code only populates `viewItem` in menu `when`-clauses, not keybinding ones, so the bindings always failed to match. Replaced the three per-`viewItem` copy bindings with a single `redmyne.copyFromTimeEntriesPane` dispatcher bound to `focusedView == 'redmyne-explorer-my-time-entries' && listFocus`; the dispatcher reads the focused tree node's `contextValue` from `treeView.selection[0]` and routes to `copyTimeEntry` / `copyDayTimeEntries` / `copyWeekTimeEntries`. Paste now binds directly to `redmyne.pasteTimeEntries` with the same `focusedView && listFocus && redmyne:timeEntryClipboardType` clause; the existing selection-fallback in that command already handles dispatch by node shape

## [4.23.0]

### Added

- **Ctrl/Cmd+C and Ctrl/Cmd+V in Time Entries pane** — copy a focused time entry, day-group, or week-group with `Ctrl+C` (`Cmd+C` on macOS) and paste with `Ctrl+V` (`Cmd+V`). Same semantics as the right-click menu: copy detects node type (entry / day / week); paste only enables on day/week targets with a compatible clipboard kind (week→day still disallowed per existing rule). Implemented via per-`viewItem` keybindings scoped to `focusedView == 'redmyne-explorer-my-time-entries'` so normal Ctrl+C/V elsewhere (editors, inputs, terminal) is untouched

### Internal

- `MyTimeEntriesTreeDataProvider.getSelectedNode()` exposes the focused tree node for `TimeEntryCommandDeps.getSelectedNode`, letting `redmyne.copyTimeEntry`, `redmyne.copyDayTimeEntries`, `redmyne.copyWeekTimeEntries`, and `redmyne.pasteTimeEntries` resolve their target from selection when invoked without an arg (keybinding path), while preserving the existing context-menu and toolbar paths
- Pinned the clock with `vi.setSystemTime` in the `hides zero-percent days by default…` test in `my-time-entries-tree.test.ts`; the test failed every Monday because the current-week date range (capped at today) collapses to a single day, leaving no zero-entry working day to assert against

## [4.22.3]

### Fixed

- **Filter-change-mid-load race in `ProjectsTree`** — old streaming load's `onProgress` callbacks could fire after `clearProjects()` and overwrite the cleared state with stale issues, leaving `getAssignedIssues()` (consumed by Gantt and status bar) showing data for the previous filter. Fixed via a `loadToken` bumped in `clearProjects()`; in-flight loads check before mutating state. Stale loads also fire one refresh on completion so the next load can start cleanly

### Performance

- **Skip redundant final `applyIssues` when streaming covered the full set** — previously `applyIssues` ran one extra time at the end of every streamed load to canonicalize offset order. Saves a full `buildFlexibilityCache` + 2× `groupBy` + all project-node rebuilds on the heaviest data set. Cache-hit (non-streaming) path unchanged

### Internal

- Extracted `fetchMyOpenAndClosedIssues(server)` helper (`src/utilities/get-my-issues.ts`) replacing three duplicated `Promise.all` of `getFilteredIssues({assignee:"me",...})` call sites (kanban-dialogs, issue-picker prewarm, issue-picker fresh fetch)
- Extracted `ProjectsTree.loadRoot()` and `ProjectsTree.expandProjectNode()` private methods: `getChildren()` is now a pure ~18-line dispatcher (issue → inline, project → `expandProjectNode`, root → `loadRoot`). The ~55-line streaming-load orchestration with 4 token-invalidation guards and the ~40-line project-expansion logic each live in their own focused method. Stale-bails in `loadRoot` simplify from `return this.sortProjectNodes(this.projectNodes)` to plain `return;` since the caller falls through to the same sort

## [4.22.2]

> v4.22.1 was tagged but the publish workflow failed lint (ESLint
> didn't ignore the newly moved `src/webviews/timesheet/` webview
> source — same situation `src/webviews/gantt/` was already in).
> v4.22.2 is v4.22.1 with that ignore added; no functional change.

### Packaging

- **VSIX shrunk 226 KB → 207 KB** (~8.5% smaller, 19 KB compressed off the published artifact). Three contributing changes:
  - `.remember/**` (AI scratch logs / handoff buffer) added to `.vscodeignore` — was leaking ~258 KB of uncompressed text into every install because `.vscodeignore` and `.gitignore` are independent lists
  - `media/timesheet.js` (77 KB hand-written IIFE) moved to `src/webviews/timesheet/index.js` and bundled through esbuild like `media/gantt.js` — 77 KB → 35 KB minified
  - `media/gantt.css` and `media/timesheet.css` moved to `src/webviews/{gantt,timesheet}/styles.css` and minified through esbuild — 45 KB → 36 KB and 37 KB → 29 KB

### Internal

- esbuild config consolidated: extension + 2 webview bundles + 2 CSS minifications now drive off a single contexts array so adding a webview is one entry instead of three

## [4.22.0]

### Performance

- **Side-pane "any/any" load is interactive ~10× sooner** — `getFilteredIssues` now accepts an `onProgress` callback that fires per pagination batch, and `ProjectsTree` rebuilds its derived state + refreshes (debounced 150ms) as each page lands. With 1500 issues across 16 pages, the first page is visible after ~1s instead of waiting ~16s for the slow last batch
- **Default `maxConcurrentRequests` raised 2 → 4** — earlier pagination batches now overlap; safe for typical Redmine servers (range 1–20 unchanged in `redmyne.maxConcurrentRequests` setting)

### Internal

- `RedmineServer.paginate` gained an optional `onPage` callback so any paginated endpoint can be streamed in the future
- `ProjectsTree` data-derivation split into `applyProjects(projects)` + `applyIssues(issues)` + `rebuildProjectNodes()`, separating project-state from issue-state. Eliminates per-page rebuild of `projectsByParent` (depends only on projects)
- Skeleton placeholder gate now keys on `projectNodes.length === 0` in addition to `isLoadingProjects`, so VS Code's re-query after the debounced refresh paints streamed partials instead of falling back to skeletons (fix: streaming was silently invisible before this)
- `debouncedRefresh.cancel()` registered as a disposable so a pending timer can't fire `refresh()` on a disposed `EventEmitter`
- Projects assigned via `getProjects().then(...)` so streamed onProgress pages always have project structure to attach to, regardless of which request resolves first

### Investigation

- Documented the Redmine-side deep-pagination spike (offset=1500 → 9.9s on a 1505-issue dataset) in `docs/PERFORMANCE.md` with hypotheses (JOIN cost from `include=children,relations`, OFFSET losing the covering index), an `EXPLAIN ANALYZE` validation query, and next-step client mitigations

## [4.21.0]

### Performance

- **Gantt view-switch no longer freezes the UI** — the ~5-7s lockup when switching to a 1000+ row "By Project" view came from `initializeGantt` attaching per-element listeners on `.drag-handle`, `.bar-outline`, and `.issue-bar` (~6K listeners per render). Converted to delegated handlers on `document`; the existing `_ganttCleanup` registry now also removes them on re-render
- **Gantt person view** no longer re-runs the day-by-day capacity simulator twice per render (`calculateScheduledCapacityByZoom` was duplicating the work already done to build `issueScheduleMap`). ~50-80ms saved per render with 100 schedulable issues
- **`actualTimeEntries`** pre-inverted to `Map<date, Entry[]>` once per simulation; previously every past day walked the full per-issue Map (~9K Map.get calls per render returning mostly undefined)
- **`WeeklySchedule` cache keys** memoized via WeakMap, eliminating ~600 `JSON.stringify` calls per flexibility refresh
- **Project-children parent map** in Gantt view filter cached by `projects` reference instead of rebuilt per render
- **`isAdHoc()`** now reads a cached `Set` invalidated via `onDidChangeConfiguration` instead of a fresh config read on every call (called per row in Gantt render and per time entry in contributions)
- **Kanban timer tick** decoupled from the tree refresh: countdown frames fire a new `_onTimerTick` event that only the status bar listens to; tree + context-sync stay on `_onTasksChange` and skip the per-second work
- **Projects tree refresh** dropped from O(N²) to O(N) by precomputing `projectsByParent: Map<id, children>` once instead of `.filter(this.projects)` per `countIssuesWithSubprojects` call
- **`perfDebug` flag** pinned at render entry so the ~17 `perfStart`/`perfEnd` call sites inside `_getRenderPayload` stop hitting vscode config on each call
- **`updateIssues` cold-start fetches** (`getIssueStatuses`, `getCurrentUser`, time entries) now run via `Promise.all` instead of serialized awaits; saves ~100-300ms on first open / fresh project switch
- **`GanttPanel._membershipsCache` removed** — was shadowing `RedmineServer.membershipsCache` (which already dedupes in-flight requests and is shared with `ProjectsTree`)

### Fixed

- **Gantt: quick-create version** triggered `redmyne.refreshGantt`, which does not exist — Gantt never refreshed after milestone creation. Now correctly dispatches `redmyne.refreshGanttData`
- **Ad-hoc time entries: contribution target replacement** failed silently on multi-line comments (regex `/#\d+.*$/` couldn't span newlines and required end-of-string anchor). Switched to `/#\d+[^\n]*/`
- **First-launch migration** is now awaited during activation; previously raced with `initRecentIssues`, `loadMonthlySchedules`, and `DraftModeManager.initialize` writing to overlapping `globalState` keys on fresh upgrades
- **Bulk %-done update** previously fired `setInternalEstimate` calls in parallel against a single `globalState` key; all but the last write silently lost. Now serialized
- **Logging server** per-command leak — `configured-command-registrar` built a fresh `LoggingRedmineServer` per invocation and dropped it without `dispose()` when an equivalent cached one existed. Each leak left an active 30s cleanup interval
- **Extension deactivation** now disposes tree views before their providers (views subscribe to provider EventEmitters and disposing the provider first could throw), and disposes the previously-leaked `kanbanController`, `kanbanStatusBar`, `draftQueue`, `draftModeManager`, and `draftModeServer`
- **Webview panel re-entry** — `dispose()` now early-returns if already disposed, preventing re-entry through `onDidDispose`. The `requestProjectMembers` `.then` is also guarded against writes to a disposed panel

### Changed

- **Engine floor raised** — `engines.vscode` `^1.105.0 → ^1.109.0`, `engines.positron` `^2025.12.0 → ^2026.04.0`. Users on older VS Code versions will no longer be able to install via the Marketplace listing. `@types/vscode` aligned with the floor

### Internal

- Dead webview message types (`scrollPosition`, `openProjectInBrowser`, `setIssueStatus`, `setIssuePriority`, `setAllProjectsVisibility`, `setDoneRatio.value`, `extendedRelationTypes`) and matching handlers removed
- Duplicate `draftBadge` click handler removed
- Unused `_debouncedCollapseUpdate` + `COLLAPSE_DEBOUNCE_MS` deleted
- `getNonce` extracted to `utilities/webview-nonce.ts`; timesheet panel's `Math.random` nonce replaced with the crypto-backed one (CSP requires a CSPRNG)
- `buildWeekInfo` reuses `formatLocalDate` + `getISOWeekNumber` from `date-utils` instead of three local re-implementations
- `_currentUserId` dropped from capacity cache key (pinned per session, redundant)

## [4.20.2]

### Fixed

- **Kanban: Log & Continue** now resets the work timer to full duration instead of continuing from the partially-elapsed seconds (could otherwise re-fire completion immediately and risk double-logging)
- **Draft mode: quick-update** no longer surfaces a spurious `TypeError` on save — drafted ops were queued correctly but the user saw a scary error message
- **Time entry clipboard: week paste** is DST-safe — entries copied across a spring-forward DST boundary no longer shift onto the wrong day
- **Time entry: edit activity** now shows a clear error when the entry has no linked issue, instead of producing a confusing `/issues/0` server error
- **Project cache** detects in-place edits (renames, parent/identifier changes) via `updated_on` probe instead of count-delta only
- **Version cache** invalidated selectively on update/delete instead of clearing every project's cache

### Improved

- **Kanban: Toggle Timer** hidden from command palette when Redmyne isn't configured (was visible unconditionally)
- **Time entry node types** deduplicated to a shared `CachedEntry` interface
- **`startTimer`** now accepts an explicit `reset` flag, making "fresh start vs resume existing seconds" an explicit caller choice

## [4.20.1]

### Improved

- **Kanban: Add Task** available in command palette (`Redmyne: Add Kanban Task`)
- **Kanban: Toggle Timer** available in command palette (`Redmyne: Toggle Timer`, hotkey `Ctrl+Y Ctrl+T`)
- **Kanban: estimated hours** shown in task description (e.g., `2:00est / 1:30log`)

## [4.20.0]

### Performance

- **Change-aware API cache** — probes `updated_on` before refetching issues/time entries; exponential backoff on stable data (10s→5min)
- **Batch time entries** — combines ~80 per-issue API calls into 1 comma-separated query for Gantt contributions
- **Parallel dependency fetch** — scheduling dependencies fetched concurrently with grouping/flexibility computation
- **Batch membership preload** — 3 concurrent instead of sequential; tooltips show instantly
- **FTE batch size** 5→10, version cache per project, version fetch concurrency 2→5

### Improved

- **Project labels** simplified to name only (no health dot/progress/counts)
- **Project descriptions** show subproject + direct issue count (`3 projects · 5 issues`)
- **Time entries: preload 3 months** in background after initial load
- **Time entries: persist hideZeroDays** across sessions
- **Time entries: better month tooltips** with date range + hours summary
- **Issue picker prewarm** — pre-fetches issues on server init so picker opens instantly
- **Paste confirmation** shows issue name, activity, and hours per entry
- **Zero-days toggle** split into Show/Hide with context-aware menu

### Fixed

- Cache probe used `>=` (always matched last record) — changed to `>`
- Projects probe failure caused repeated probing — now applies backoff
- Issue mutations (status/dates/priority) didn't invalidate change cache
- Version cache not invalidated after create/update/delete
- `applyQuickUpdate` read stale per-issue cache for verification
- Probe failure triggered full refetch — now returns cached data with backoff
- `createIssue`/`createRelation`/`deleteRelation` missing cache invalidation
- 3 context-menu-only commands visible in command palette

## [4.19.1]

### Improved

- **Time Entry UX: progressive context titles** — each step (issue → activity → date → hours → comment) shows accumulated selections in the title so user always knows where they are
- **Time Entry UX: recent working-day shortcuts** — date picker shows up to 3 recent weekdays beyond Today/Yesterday for faster retroactive logging
- **Issue picker: instant display** — picker shows immediately with loading indicator; issues populate asynchronously instead of blocking until all data is fetched
- **Issue picker: time tracking cache** — project time-tracking status cached for 5 min, eliminating redundant HTTP requests on repeat opens
- **Issue search: ~16 → ~4-6 HTTP calls per query** — single full-query search instead of per-token, dropped redundant starts-with filter, deferred search API behind subject filter, capped project searches at 3
- **Issue search: prefix cache** — typing "fea" → "feat" → "feature" reuses cached results client-side (5s TTL), eliminating all HTTP calls for prefix extensions
- **Issue search: debounce 150 → 250ms** — reduces wasted searches during active typing

### Fixed

- **Search API dropped closed issues** — `getIssuesByIds` defaulted `skipClosed=true` during search result hydration; closed issues from `/search.json` were silently lost

## [4.19.0]

### Added

- **Time Entries: "Show 0% Days" filter** - days with zero logged hours hidden by default; toggle via filter menu
- **Time Entries: collapse-all button** - in header for Time Entries, Issues, and Kanban views
- **Compact hours display** - description shows `2:00 (31%)` instead of `2:00/6:24 (31%)`; full breakdown in tooltip
- **Human-readable week tooltips** - hover shows `2026 March 2–6; 2:00/6:24 (31%)`
- **Project members in tooltips** - members grouped by role in both Issues tree and Gantt view (lazy-loaded)
- **Parent project in Gantt tooltip** - shown as `Client: <name>`
- **`showProjectMembers` setting** - toggle member display in tooltips (default: on)
- **`hideProjectMembersFor` setting** - exclude specific project IDs from member display
- **`autoUpdateIssues` setting** - replaces context menu toggle for auto-update %done
- **`adHocBudgetIssues` setting** - replaces context menu toggle for ad-hoc budget
- **`precedenceIssues` setting** - replaces context menu toggle for precedence priority

### Changed

- **Tracker storage moved to settings.json** - auto-update, ad-hoc, and precedence issue IDs now stored in VS Code settings instead of globalState; V2 migration runs automatically
- **Gantt project members loaded lazily** - fetched on first hover instead of all at once during data load
- **Gantt sourcemap URL suppressed** - eliminates CSP warning in webview DevTools

### Fixed

- **Time Entries: show empty weeks in month view** - weeks with zero logged hours now appear
- **Time Entries: boundary week clipping** - weeks spanning two months show correct days under each month
- **Time Entries: week sort order** - single-digit week numbers sort correctly
- **Time Entries: weekend-only boundary weeks hidden** - boundary weeks with only non-working days not shown
- **Time Entries: node ID zero-padding** - expansion state preserved for single-digit weeks
- **Time Entries: month date range edge case** - midnight comparison replaced with year/month check
- **Time Entries: skip entries without date** - prevents "Week NaN" from appearing
- **Time Entries: error handling** - month load errors no longer leave tree in loading state
- **Time Entries: Today chevron** - only shows when entries exist
- **Gantt: project tooltip URL double-slash** - stripped trailing slash from server address
- **Gantt: "Open in Browser" link** - shows as clickable text, URL visible on hover
- **All tooltip URLs** - trailing slash stripped consistently

### Removed

- **Context menu toggles** - Auto-update %, Ad-hoc Budget, and Precedence On/Off submenus removed from tree and Gantt context menus (use settings.json instead)
- **6 toggle/set commands** - `toggleAutoUpdateDoneRatio`, `toggleAdHoc`, `togglePrecedence`, `setAutoUpdateDoneRatio`, `setAdHoc`, `setPrecedence`
- **12 proxy commands** - On/Off variants for tree and Gantt contexts

## [4.17.1]

### Fixed

- **Timesheet: delete/update draft entries in expanded dropdown** - deleting or zeroing a draft entry (not yet saved) in the expanded cell dropdown no longer sends `DELETE /time_entries/null.json` to the server; instead removes the pending CREATE from the draft queue

## [4.17.0]

### Added

- **Custom CA certificate setting** - `redmyne.caFile` for environments where the OS/container trust store lacks the Redmine server's issuing CA (advanced fallback)

### Fixed

- **TLS error message accuracy** - certificate validation errors now say "The machine or container may not trust the issuing CA" instead of referencing a removed `rejectUnauthorized` setting

### Security

- TLS validation remains always enabled (`rejectUnauthorized: true`); no insecure bypass

## [4.16.5]

### Fixed

- **macOS CI timeout flake in tree tests** - hardened `my-time-entries-tree` tests to avoid timer leakage under `isolate:false` by forcing real timers and using deterministic async polling

## [4.16.4]

### Internal

- **Panel public-flow test coverage** - added integration-style tests for `GanttPanel` + `TimeSheetPanel` public flows (`createOrShow`, `restore`, message dispatch, deferred render) using stable webview/panel spies

## [4.16.3]

### Fixed

- **macOS CI flaky ad-hoc command test** - replaced fragile module mock in `adhoc-commands` tests with direct `spyOn(adHocTracker, "isAdHoc")` so test behavior is stable under `isolate:false` and parallel execution

## [4.16.2]

### Internal

- **Command validation and URL helpers** - centralized shared guards and URL builders to reduce duplication and tighten typed validation across command handlers
- **Command test coverage expansion** - added focused unit tests for command guard/url helpers and refactored command modules to preserve behavior during ongoing cleanup

## [4.16.1]

### Internal

- **CI coverage stabilization** - excluded extracted command-wiring modules from coverage thresholds to keep global CI thresholds aligned with prior behavior

## [4.16.0]

### Added

- **Closed issue warning** - confirmation dialog before logging time on closed issues
  - Applies to: Quick Log Time, context menu, timer completion, paste entries, kanban
  - Batch paste shows single dialog for all closed issues

## [4.15.1]

### Changed

- **VS Code engine requirement** - bumped minimum from 1.100.0 to 1.105.0

### Internal

- **Dependency updates** - prettier 3.8.0, vitest 4.0.18

## [4.15.0]

### Added

- **Hide empty projects when filter active** - projects with no matching issues are now hidden (#64)
  - Default: "No Filter" shows all projects (persisted across sessions)
  - New "My Issues" filter: shows open + closed issues assigned to me
  - Existing filters (My Open, All Open, etc.) now hide empty projects
  - Parent projects with issues only in subprojects remain visible

## [4.14.2]

### Fixed

- **Custom fields for all time entry paths** - fixed missing custom field prompts (#63)
  - Issue left-click → Add Time Entry
  - Kanban → Log Early / Log and Continue
  - Timer completion dialog
  - Apply drafts now passes stored custom fields
  - Copy/paste now preserves custom field values

## [4.14.1]

### Internal

- **Test coverage improvements** - raised coverage thresholds to industry standards (72% statements, 75% lines, 76% functions, 63% branches)
  - Added tests for migration.ts (0%→97%)
  - Added tests for recent-issues.ts (15%→100%)
  - Added tests for kanban-status-bar.ts (0%→98%)
  - Added tests for precedence-tracker.ts (0%→100%)
  - Added tests for secret-manager.ts (54%→100%)
  - Expanded kanban-state.ts tests (61%→100%)
  - Expanded kanban-controller.ts tests (60%→81%)
  - Excluded completion-sound.ts from coverage (platform-specific audio)

## [4.14.0]

### Added

- **Custom fields for time entries** - supports required and optional custom fields when logging time (#63)
  - Prompts for required fields during Quick Log Time
  - "Edit Custom Fields" option in time entry edit menu
  - Handles all field types: list, bool, int, float, date, string, text
  - Multi-select support for list fields
  - Graceful fallback when admin-only API is inaccessible

## [4.13.4]

### Internal

- **Draft-mode test coverage** - improved from 42% to 78% statements, added tests for all untested utilities and edge cases

## [4.13.3]

### Fixed

- **Flaky test** - time entries tree test used hardcoded future dates causing CI failures early in month

## [4.13.2]

### Performance

- **Gantt collapse** - O(n²) → O(k) for finding descendants via BFS with caches
- **Quick search** - 50ms debounce + pre-cached labels (was iterating all labels per keystroke)
- **Drag operations** - cache grip circles at drag start (was querySelectorAll per frame)
- **Zebra stripes** - single query reused 3x per collapse (was 3 separate queries)
- **Lookup maps** - combined into single querySelectorAll (was 5 separate queries)
- **Arrow selection** - track elements for O(1) clearing (was querySelectorAll)

## [4.13.1]

### Fixed

- **Gantt "Add to Kanban"** - now fetches issue data instead of creating empty folder
- **Corrupted tasks** - added cleanup command for tasks with missing data

## [4.13.0]

### Added

- **Project/client search** - search issues by parent project name (e.g., "marea" finds all Marea Therapeutics issues)
- **Inaccessible issue feedback** - shows warning when searching for issue IDs you can't access (403/404)

### Improved

- **Issue picker display** - consistent format across all pickers:
  - Row 1: #id subject | assignee
  - Row 2: project path (detail)
- **Project hierarchy** - clearer display with "Client: Project / Subproject" format
- **Search ranking** - results ranked: mine+open > mine+closed > other+open > other+closed
- **Multi-word search** - searches each word separately for better results
- **Hidden closed issues** - closed issues beyond top 20 now findable via search

### Internal

- **DRY refactor** - shared project path map between kanban and time entry pickers

## [4.12.9]

### Internal

- **Test coverage** - increased from 60% to 63% lines
  - Added tests for `validation.ts`, `collection-utils.ts`, `issue-sorting.ts`
  - Updated coverage thresholds: lines 63%, functions 60%, branches 55%
- **CI fix** - use real blocked relations in tests (mock incompatible with isolate:false on macOS)

## [4.12.8]

### Added

- **Timer progress bar** - visual ▰▱ progress bar in statusbar
- **Progress bar settings** - configurable width 3-100 segments (default 45)

### Improved

- **Timer completion modal** - cleaner "Log & complete" / "Log & continue" options
- **Timer settings** - apply immediately without restart
- **Ready state** - shows timer info instead of just "Ready (X/Y)"

## [4.12.7]

### Improved

- **Kanban timer** - status bar shows task comment instead of issue ID
- **Timer position** - moved to rightmost left-aligned position (closer to center)
- **Tooltip icons** - theme icons now render properly in all tooltips

## [4.12.6]

### Fixed

- **Toolbar tooltips** - hide when dropdown is open (native dropdowns render above CSS)

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

- **Gantt maintainability** - extracted ~800 LOC to stateless generator modules
  - Labels, cells, bars delegated to `gantt-html-generator.ts`
  - Toolbar delegated to `gantt-toolbar-generator.ts` (~145 LOC)
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
