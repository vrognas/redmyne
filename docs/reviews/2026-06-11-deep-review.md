# Deep Review 2026-06-11 (v4.29.1, main)

Ultracode 4-dimension review of all 129 src files (~38K lines). Run wf_5412ec7c-fab: 19 finders (16 module units + 3 cross-cutting lenses), 1 adversarial verifier per candidate, gap sweep.

**142 findings: 136 CONFIRMED, 6 PLAUSIBLE (12 refuted). By dimension: bug 67, duplication 38, soc 19, complexity 18.**

Status legend: [ ] open, [x] fixed, [-] wontfix.

## CRITICAL (2)

### 1. [x] src/webviews/timesheet-panel.ts:1346 — Changing issue/project on a saved row queues PUT without issue_id, so hours stay logged to the old issue

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** _updateRowField (field 'issue', line 1432) sets row.issueId and marks all cells dirty, then the completion block (lines 1475-1481) calls _queueCellOperation for each cell with an entryId. The update branch (lines 1336-1355) builds the PUT body as { hours, activity_id, comments } only — no issue_id (or project_id). The op description even claims `Update #${row.issueId}` with the NEW issue id, but the request never reassigns the entry. Result: the UI shows the entry moved to the new issue, Save All writes hours/activity/comments onto the entry still attached to the OLD issue, and after reload the row snaps back. This is a silent wrong write to the Redmine API every time a user re-targets an existing entry via the Task (or Project) dropdown.
- **fix:** In _queueCellOperation's updateTimeEntry branch, include issue_id: row.issueId in the time_entry body (Redmine PUT /time_entries/:id.json supports reassignment and derives project from issue). Alternatively, when issueId differs from the entry's original issue, queue delete+create instead.

### 2. [x] src/commands/draft-mode-commands.ts:72 — Applied drafts stay in queue until whole batch ends, enabling duplicate writes to Redmine

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** applyDraftsWithTracking executes ops in a loop (lines 48-70) but removes succeeded ops only after the entire loop finishes (lines 72-87). Two concrete consequences: (1) the onError callback (lines 197-205) awaits a non-modal showErrorMessage toast that can stay open indefinitely; meanwhile the review panel is fully interactive and still lists already-applied ops — clicking a row's apply button fires redmyne.applySingleDraft (line 276), which finds the op still in queue.getAll() and re-executes it, producing a duplicate POST/PUT (duplicate time entry, duplicate issue, double status write). Panel row buttons are never disabled during a batch apply started from the status bar or command palette. (2) A window reload/crash mid-batch leaves all succeeded ops persisted in the queue file; next 'Apply All' replays them — duplicate creates against the Redmine API.
- **fix:** Remove each op immediately after its successful executeOperation: `await queue.remove(op.id, DRAFT_COMMAND_SOURCE)` inside the success branch, and delete the end-of-run removeMany block. Optionally add an in-flight guard so applySingleDraft/applyDrafts can't run concurrently.

## HIGH (39)

### 3. [x] src/webviews/gantt-panel.ts:1774 — Delay update deletes relation on server, then has no rollback if recreate fails — relation permanently lost and UI desyncs

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** _updateRelationDelay (lines 1772-1789) does `await deleteRelation(relationId)` then `await createRelation(...)` because Redmine cannot update delay in place. If createRelation rejects (network blip, Redmine validation such as a date conflict introduced by the new delay), the catch block only shows an error message: the relation is already deleted on the Redmine server, but local state is untouched (_removeRelationLocally is only called after both calls succeed), so the chart keeps drawing an arrow for a relation that no longer exists, and the user's relation (incl. its old delay) is silently destroyed server-side.
- **fix:** In the catch after a successful delete, attempt to recreate the relation with the original delay (best-effort rollback); on rollback failure, call _removeRelationLocally(relationId) + _updateContent() and tell the user the relation was lost so the UI matches server state.

### 4. [x] src/webviews/gantt-panel.ts:3020 — Today marker (and week-zoom current-period highlight) drawn one day to the right in UTC-negative timezones — disagrees with todayX/capacity-ribbon marker on the same chart

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** The x-axis is UTC-anchored: _generateDateMarkers iterates UTC-midnight instants (current starts at minDate, advances via setUTCDate, line 3027) and all other today anchors use todayUTC = new Date(getTodayStr()) (lines 1975, 2530, 2547). But the loop compares `formatLocalDate(current) === todayLocal` (lines 3010, 3020). formatLocalDate renders a UTC-midnight instant in the LOCAL frame, so for any timezone west of UTC it yields the previous calendar day; the match therefore fires at the UTC gridline of local-today+1. Result: the body today-line lands one gridline right of the minimap todayX, the capacity-ribbon today marker, and the 'T' auto-scroll target, and bars due yesterday appear to touch 'today'. Same mechanism shifts the week-zoom today-header-bg (periodStart built from local-frame today at lines 2845-2848 while month/quarter/year periodStarts are UTC-built and happen to cancel out).
- **fix:** Compare in one frame: replace formatLocalDate(current) with a UTC formatter (or compare current.getTime() === todayUTC.getTime()), and build the week periodStart from todayUTC so all today/period anchors share the UTC convention documented at lines 1966-1975.

### 5. [ ] src/webviews/gantt-panel.ts:181 — GanttPanel is a 3205-line god-class mixing webview transport, Redmine write operations, data loading, view-model build, and raw SVG string generation

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** One class handles: postMessage protocol + a ~40-case message switch (_handleMessage, lines 1253-1612); Redmine API writes with undo/redo (relations CRUD + date updates, lines 1614-1939); async supplemental data loading/caching (contributions, versions, time entries, FTE, lines 800-1062); the 790-line _getRenderPayload (1957-2745) which itself does filtering, sorting, hierarchy build, capacity simulation, layout math, and inline SVG for milestones/minimap/capacity ribbon; plus _generateDateMarkers SVG (2811-3037), skeleton SVG (406-601), and tooltip text formatting (3042-3168). Any change to one concern forces edits in this file, and the render-cache invariants (_payloadByFocus, _capacityCache, _cachedHierarchy) are spread across all of them.
- **fix:** Incremental split following the existing gantt/ module precedent: (1) move relation CRUD + undo/redo + _addRelationLocally/_removeRelationLocally to src/webviews/gantt/gantt-relation-actions.ts taking {server, postMessage, onLocalChange} deps; (2) move _loadContributions/_loadVersions/_loadActualTimeEntriesForPersonView/_refreshSupplementalData to gantt/gantt-supplemental-loader.ts; (3) move _generateDateMarkers + milestone/minimap/capacity-ribbon SVG builders next to buildRowsPayload in gantt/gantt-html-generator.ts. Panel keeps state, caching, and message routing.

### 6. [x] src/webviews/timesheet-panel.ts:1186 — Undo of row delete (_restoreRow) never re-queues the create ops _deleteRow removed, silently losing unsaved hours

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** _deleteRow for isNew rows removes all backing draft ops: removeByTempIdPrefix(`${rowId}:`) at line 1090 plus _removePastedDraftOpsForRow at line 1094, and clears incomplete-row storage (line 1086). It then posts rowDeleted for undo. _restoreRow (lines 1186-1199) only handles the non-new case (removes queued deleteTimeEntry ops) and pushes the row back into _rows. For a restored new row the cells still display hours, but no createTimeEntry ops exist anymore: Save All writes nothing for them, and on the next week reload _restoreIncompleteRows drops the row (hasHours=true, hasDraftOps=false, lines 810-819) — the user's 'restored' unsaved hours vanish. Side effect for non-new rows: the delete op queued in _deleteRow shares resourceKey ts:timeentry:{id} with any pending update, so DraftQueue.add replaced it; restore removes the delete and the user's earlier edit is also gone.
- **fix:** In _restoreRow, for isNew rows re-queue creates via _queueCellOperation for every cell with hours > 0 and call _saveIncompleteRows(); for existing rows re-queue update ops for cells where hours !== originalHours after removing the delete ops.

### 7. [x] src/webviews/timesheet-panel.ts:943 — Pasted draft ops merge additively into an existing saved row's cell, enabling double-counted hours on the server

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** _applyPendingDraftChanges' 'draft-timeentry-' branch matches an existing row by issue/activity/comments (lines 915-917) — including 'existing-' rows whose cell already has an entryId — then sets row.days[dayIndex] = { ...cell, hours: cell.hours + hours } (line 943), keeping the entryId. The cell now shows saved+pasted hours as one value backed by the saved entry id. If the user then edits that cell, _updateCell (line 1270) sees entryId and queues an updateTimeEntry PUT with the combined figure, while the pasted createTimeEntry op (different resourceKey, buildNewEntryResourceKey) remains queued. Save All flushes both: the saved entry is overwritten with the summed hours AND a new entry is created — hours double-counted on the Redmine server. Even untouched, the display misrepresents one row where two entries will exist after save.
- **fix:** In the paste branch, never merge into a row whose target cell has entryId !== null; instead create a separate draft row for the pasted hours (mirroring how reload renders two rows post-save).

### 8. [x] src/webviews/timesheet/index.js:336 — parseHours colon branch lets NaN and negative hours through to the extension and draft queue

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** parseHours (src/webviews/timesheet/index.js:332-348) guards the plain-number path with isNaN/Math.max(0), but the `str.includes(":")` branch (lines 336-339) returns `h + (m || 0) / 60` with no validation: ":30" or a typo like "1:3o"... actually "abc:30" yields Number("abc")=NaN -> NaN; "-1:30" yields -0.5. In the day-input blur handler (lines 768-799), `newHours > oldHours` is false for NaN so the 24h guard is skipped, the input displays "NaN", and `oldHours !== newHours` is true (NaN !== anything), so `updateCell` is posted with hours: NaN. The extension's _updateCell (src/webviews/timesheet-panel.ts:1270-1282) stores it with no validation and marks the cell dirty (NaN !== originalHours), queuing a draft op that will be sent to the Redmine API on save; NaN also poisons the totals row. The same unvalidated path feeds updateExpandedEntry (line 2063) and updateAggregatedCell.
- **fix:** In the colon branch: `const [h, m] = str.split(":").map(Number); if (!Number.isFinite(h)) return 0; return Math.max(0, h + (Number.isFinite(m) ? m : 0) / 60);` — i.e. apply the same isNaN/clamp-to-zero treatment the other two branches already have.

### 9. [x] src/webviews/timesheet/index.js:320 — formatHours rounds to one decimal, displaying quarter-hour values wrong and writing rounded values back via undo

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** formatHours (src/webviews/timesheet/index.js:317-321) uses `hours.toFixed(1)`, so the common timesheet increments x.25/x.75 render wrong: 2.25 displays as "2.3", week total 38.75 as "38.8" — everywhere (day cells line 745, row totals 835, group totals 950, totals row 1175/1201, expanded-entry inputs 2053). Worse than display: the focus handler (line 765) recaptures dataset.oldValue by parsing the rounded display ("2.3" -> 2.3), so after editing a 2.25h entry, the undo action stores oldValue=2.3 and Ctrl+Z posts updateCell with 2.3 — silently replacing the saved 2.25 with 2.3 in the draft queue.
- **fix:** Render two decimals without trailing zeros: `return String(Number(hours.toFixed(2)));` (still shows "1.5" for 1.5, but "2.25" stays exact). That also fixes the focus-recapture/undo round-trip since parseHours(display) === stored value.

### 10. [x] src/webviews/timesheet/index.js:1318 — showError messages from the extension are swallowed into console.error — users never see load/save/paste failures

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** The `case "showError"` handler (src/webviews/timesheet/index.js:1318-1321) only does console.error with a comment "Could show a toast notification", even though a full showToast system exists in the same file (line 1902). The extension relies on this message for real failure feedback: failed week load (src/webviews/timesheet-panel.ts:613), failed saveAll (1726), failed paste (1847), "No server configured" (538), "Draft mode not enabled" (1676). Result: a failed save or week load shows nothing — the spinner just disappears and the user sees a stale or empty grid believing everything worked.
- **fix:** Replace the console.error body with `showToast(message.message, null, 8000);` (optionally add an error-styled toast variant). Keep the console.error for diagnostics if desired.

### 11. [x] src/redmine/redmine-server.ts:485 — hasChanges probe uses unsupported Redmine filter operator '>' — change detection silently broken for all three change-aware caches

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** hasChanges() builds `updated_on=>${since}` (line 485) and the comment claims 'strictly greater'. Redmine's query filter grammar has no bare '>' operator for date fields — only '>=', '<=', '><' (see Redmine query.rb OPERATORS; the REST docs document only '>=', e.g. updated_on=%3E%3D2014-01-02T08:12:32Z). Redmine's add_short_filter falls back to operator '=' with value '>2026-...', which fails date validation, so the API returns 422 and doRequest rejects. hasChanges catches and returns null, so every probe at redmine-server.ts:524 (projects), :870 (time entries), :1534 (filtered issues) silently degrades to 'use cache + backoff'. Net effect: the entire change-detection mechanism never detects changes; users see data stale up to the 5-min TTL despite the 10s probe design, and every probe wastes a guaranteed-failing HTTP request. Additionally, /projects.json only honors query filters on Redmine 5.0+ (ProjectQuery); on older servers the param is ignored and total_count counts all projects, making the projects probe always report 'changed' (full refetch every probe window).
- **fix:** Use the supported '>=' operator with a baseline nudged past the cached max (e.g. add 1 second to lastCheckedAt before formatting), or keep '>=' and treat 'changed' as total_count > 0 where the probe result's id/updated_on differs from the cached max. Add one integration test hitting a real/mocked Redmine 422 path so a rejected probe isn't mistaken for 'no change'.

### 12. [ ] src/webviews/gantt/index.js:461 — initializeGantt is a ~1200-line closure mixing a dozen unrelated concerns

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** initializeGantt (index.js:461-1659) owns, in one closure: undo/redo stacks + webview-state persistence (592-655), scroll save/restore geometry (606-680, 1559-1588), the extension message router (701-796), toolbar/filter/sort wiring (799-912), dependency focus mode (919-1009), multi-select state + delegated handlers (1015-1130), relation context-menu picker (1139-1182), lookup-map lifecycle (1187-1205), hover highlighting (1212-1319), arrow selection with its own refresh re-sync (1321-1446), and column resize (1594-1651). Dozens of mutually captured variables (saveState, lookupMaps, focusedConnectedIds, selectedIssues, currentDraftMode) make any change ripple unpredictably; the stray extra indentation from line 546 on shows the function has already outgrown edits. Drag/keyboard/minimap/row-interaction were already extracted to modules — this remainder was not.
- **fix:** Incremental split following the existing module pattern (setupDrag/setupKeyboard take vscode + addDocListener + rowWindow): extract (1) gantt-selection.js (selectedIssues, toggle/range/all, updateSelectionUI), (2) gantt-focus.js (buildBlockingGraph, getAllConnected, applyFocusClasses, arrow-selection block), (3) gantt-scroll-state.js (getCenterDateMs, scrollToCenterDate, saveState, restore rAF). Each is already internally cohesive; pass saveState/announce/lookupMaps as params like the other setup* modules do.

### 13. [x] src/webviews/gantt/gantt-drag.js:1136 — Move-drag on a parent bar's outline throws TypeError every mousemove frame (parent bars have .bar-outline but no drag handles)

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** The bar-body move-drag mousedown (gantt-drag.js:561-567) starts a drag for any element matching '.bar-outline'. Parent bars emit a <path class="bar-outline"> (gantt-html-generator.ts:566) but NO .drag-left/.drag-right handles (only regular bars get them, generator lines 764/772). So for a parent bar, dragState.leftHandle = bar.querySelector('.drag-left') is null (gantt-drag.js:661), and the single-drag mousemove branch unconditionally derefs it: `const leftRect = dragState.leftHandle.querySelector('rect')` (line 1136). Every mousemove RAF throws, dragState.newStartX is never assigned (assignment at 1143 is after the throw), the tooltip never updates, and the user sees a dead, error-spewing drag until mouseup. The parent path's full-width center stroke is an easy hit target. Note gantt-keyboard.js:49 already excludes parent bars (`.issue-bar:not(.parent-bar)`) — this handler doesn't.
- **fix:** In the bar-body mousedown, bail early when the bar is a parent: `if (bar.classList.contains('parent-bar')) return;` (matching the keyboard handler's exclusion). Defensively, also guard `dragState.leftHandle`/`rightHandle` like the bulk path's cached-rect guards (lines 1092-1093).

### 14. [ ] src/webviews/gantt/gantt-drag.js:4 — setupDrag is a 1500-line god-closure mixing 8 unrelated concerns

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** One function holds: issue context menu + clipboard HTML copy (55-132), drag tooltips (151-199), SVG arrow path geometry (206-332), arrow collection/update (344-423), confirm modal (426-488), three drag state machines (resize 497-557, move/bulk 561-698, linking 984-1026), badge arrow-highlighting (871-924), bar keyboard navigation (926-982), and undo/redo command dispatch (1404-1525). They share closure state only incidentally (e.g. undo/redo handlers touch zero drag state; bar keyboard nav touches none either). Every change risks the whole file, and the parallel keyboard-nav implementation in gantt-row-interaction.js (handleNavKeydown) already shows drift.
- **fix:** Incremental split, no rewrite: (1) move calcArrowPath/updateArrowPositions/barCenterY/collectArrows next to computeArrowEndpoints in arrow-utils.js or arrow-svg.js; (2) move the menuUndo/menuRedo click handlers (1404-1525) to a gantt-history.js module taking {vscode, stacks, saveState, isDraftModeEnabled}; (3) move bar keyboard nav (926-982) into gantt-keyboard.js beside the other key handling. Each step is a pure cut-paste with explicit ctx params.

### 15. [x] src/webviews/gantt/gantt-html-generator.ts:954 — buildRowsPayload omits the open-ended-bar fallback, so barEndX disagrees with the rendered bar for issues with start_date but no due_date

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** generateIssueBar (line 440) renders open-ended bars with `dueDate = issue.due_date ?? (hasOnlyStart ? maxDateStr : ...)`, i.e. the bar visually extends to ctx.maxDate. buildRowsPayload (line 954) ports only half of that logic: `const end = issue.due_date ? new Date(issue.due_date) : new Date(issue.start_date!)`, so barEndX = startX + 1 day. These payload values are the geometry source of truth for (a) dependency-arrow endpoints in row-window.js:195-198, (b) drag position stubs for unmounted rows in gantt-drag.js:369-377, and (c) bulk-drag entries for collapse-hidden selected issues in gantt-drag.js:628-633. Consequence: arrows attached to an open-ended bar (class `bar-open-ended` — a supported rendering) anchor near the bar's START instead of its rendered end, and the same issue has two conflicting endX values depending on whether its row is mounted (DOM dataset endX uses maxDate, payload meta uses start+1day), so arrows visibly jump when the row scrolls into the window.
- **fix:** In buildRowsPayload, replicate generateIssueBar's fallback: when issue.start_date && !issue.due_date, compute barEndX from ctx.maxDate (the maxDateStr branch) so payload geometry matches rendered geometry. Better: extract one shared helper (see duplication finding) used by both.

### 16. [x] src/utilities/tree-item-factory.ts:124 — Server-controlled issue text rendered into trusted MarkdownString with HTML support — command-link injection in tooltips

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** createFlexibilityTooltip and createBasicTooltip set md.isTrusted = true and md.supportHtml = true (lines 100-102, 168-170), then appendMarkdown raw server content: issue.subject (107, 175), issue.description (124, 191), cf.name and formatted value (141, 208). With isTrusted, markdown command URIs like [x](command:workbench.action.terminal.sendSequence?...) embedded in an issue subject/description/custom field on the Redmine server become clickable command executors in the tree tooltip; supportHtml additionally renders raw HTML. createProjectTooltip (279-297) correctly uses appendText for the same kind of content, so the unsafe path is an inconsistency, not a deliberate choice. The only thing isTrusted buys here is nothing — the 'Open in Browser' link is a plain https URL that renders without trust.
- **fix:** Drop isTrusted/supportHtml in both issue tooltips, and route subject/description/cf.name/val through md.appendText (as createProjectTooltip already does), keeping appendMarkdown only for the static ** / --- scaffolding and the https link.

### 17. [x] src/utilities/date-picker.ts:187 — validateDateInput accepts nonexistent calendar dates and falsely rejects 'today' for users east of UTC

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** Line 186 regex only checks shape; line 187 new Date(value) parses '2026-02-30' as Mar 2 (verified in Node: valid Date, isNaN false), so the invalid string passes validation and is sent verbatim to Redmine as spent_on/due_date, producing a 422 or wrong write downstream. Separately, line 188 compares UTC-midnight of the entered date against the current instant: for any user in a UTC+ timezone, entering today's date before local (UTC offset) o'clock yields parsed > new Date() and the bogus error 'Cannot log time in the future' (verified: new Date('2026-06-11') > new Date('2026-06-10T21:00:00Z') is true). This blocks legitimate same-day time logging via the 'Pick date...' path in pickDate (line 99).
- **fix:** Validate the calendar date by round-trip (split into y/m/d, build Date.UTC, compare components back to input), and do the future check lexicographically against formatDateISO(new Date()) (value > todayStr) instead of comparing Date instants.

### 18. [x] src/utilities/dependency-graph.ts:56 — Owner-only relation guard drops dependency edges when the relation owner is not in the fetched issue set

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** Redmine relation records are directional and keep their original orientation in both issues' relations arrays: if external issue A 'blocks' fetched issue B, B.relations contains {issue_id: A, issue_to_id: B}. Line 56 `if (rel.issue_id !== issue.id) continue;` skips every relation the iterated issue doesn't own, expecting the owner's iteration to add the edge. When the owner is outside the fetched set (filtered by assignee/project/closed — exactly the case in gantt-panel.ts:2099 which builds the graph from sortedIssues), the edge is silently lost: B.upstream stays empty, getBlockers() returns nothing, allBlockersComplete() in capacity-calculator treats B as unblocked and schedules it too early, and project-health blocked counts miss it.
- **fix:** Delete the line-56 guard entirely: the mapping below uses rel.issue_id/rel.issue_to_id (not issue.id), so processing the same relation from both perspectives produces identical Set.add calls and Sets dedupe for free. If avoiding double work matters, skip only when the counterpart issue is also in the fetched set.

### 19. [x] src/utilities/dependency-extractor.ts:41 — extractSchedulingDependencyIds only collects rel.issue_to_id, missing external dependencies that own the relation

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** For a relation owned by an external issue (e.g., external A 'blocks'/'precedes' my issue B, record {issue_id: A, issue_to_id: B} present in B.relations), line 41 checks only `!ownIds.has(rel.issue_to_id)` — issue_to_id is B (own), so A is never added. Roughly half of external dependency orientations are missed; projects-tree.ts:332 then never fetches those blockers, so the My Work view can't show the external dependency row and the dependency graph never gets the blocker's details. Compounds the dependency-graph.ts:56 bug.
- **fix:** Also collect the owner side: `if (!ownIds.has(rel.issue_id)) dependencyIds.add(rel.issue_id);` alongside the existing issue_to_id check.

### 20. [x] src/utilities/project-health.ts:91 — closed_on used as the is-closed test despite the codebase's own documented reopened-issue pitfall

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** flexibility-calculator.ts:323 explicitly warns: 'Check status.is_closed, NOT closed_on date (reopened issues still have closed_on!)' — yet `issue.closed_on !== null` is the closed test at project-health.ts:91 (reopened issue counted closed, progress forced to 100, excluded from overdue/at-risk → project shows green while late work is open), capacity-calculator.ts:121 and :484 (reopened issues excluded from load and the scheduling simulation → capacity ribbon under-reports), and dependency-graph.ts:171/:218 (reopened blockers hidden from blocker/downstream lists). Related: capacity-calculator.ts:543 seeds completedIssues only via done_ratio === 100, so a genuinely closed blocker with done_ratio < 100 keeps blocking dependents until its due_date passes — or forever if it has no due_date.
- **fix:** Add a shared isIssueClosed(issue) helper that checks issue.status?.is_closed (the Issue model carries IssueStatus) and use it at all five sites; in capacity-calculator also seed completedIssues from isIssueClosed, not just done_ratio === 100.

### 21. [x] src/utilities/configured-context-updater.ts:65 — Unsequenced fire-and-forget draft-queue load races across updater invocations; stale identity can win

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** The returned updater is invoked from multiple sites (extension.ts:298 on every config change, :320 on activation, configure-command.ts:126, view-commands.ts:75). Each invocation spawns `void hashString(serverUrl + apiKey).then(...)` with no generation token or cancellation. Two rapid invocations (e.g. user edits serverUrl then apiKey — each fires a config-change event) interleave: chain A's `deps.draftQueue.load(identityA, { force: true })` (line 83) can resolve AFTER chain B's load, leaving the queue loaded under the stale identity while `setDraftModeServer` (line 61) already points at the new server — drafts recorded against server A can then be flushed to server B. The modal `checkServerConflict` answer can likewise apply to an outdated identity, and a 'Cancel' from a stale chain silently skips the load the newer chain needed. Also: when config becomes unconfigured (lines 120-124) trees are cleared but the previously set DraftModeServer is never cleared (deps.setDraftModeServer accepts only DraftModeServer, not undefined), so stale server state survives deconfiguration.
- **fix:** Add a monotonically increasing generation counter captured at the top of the updater; inside the hashString .then chain, bail out if the captured generation is no longer current before calling checkServerConflict/load. Allow setDraftModeServer(undefined) and call it in the unconfigured branch.

### 22. [x] src/trees/my-time-entries-tree.ts:835 — Trusted markdown tooltip interpolates unsanitized server strings, enabling command-URI injection

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** mapEntriesToNodes builds a vscode.MarkdownString (lines 835-847) interpolating raw server data: entry.comments (line 844), issue subject (837), activity name (842), and user name (831), then sets tooltip.isTrusted = true (line 848). With isTrusted=true, markdown command links execute. Any Redmine user can put `[click me](command:workbench.action.terminal.sendSequence?...)` in a time-entry comment; in showAllUsers mode other users' comments render in this extension's tooltips, so a click runs an arbitrary VS Code command in the victim's editor. supportHtml=false does not block command links.
- **fix:** Set tooltip.isTrusted = { enabledCommands: ["redmyne.openTimeEntryInBrowser"] } instead of true, and escape markdown metacharacters (\, [, ], (, )) in comments/subject/user/activity before interpolation.

### 23. [x] src/trees/my-time-entries-tree.ts:249 — refresh() dropped while load in-flight; stale-filter responses repopulate cleared caches (no load token)

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** refresh() clears caches but guards the reload with `if (!this.isLoading)` (line 249). setShowAllUsers (line 908) calls refresh(); if loadTodayAndThisWeek is in-flight (request already sent with the old allUsers value, line 269), no new load starts, the old response overwrites todayEntries/weekEntries (lines 273-274), and getChildren never re-triggers because todayEntries !== undefined (line 428). The tree then permanently shows the wrong user scope until a manual refresh. Same race for months: an in-flight loadMonthEntries writes old-filter results into the just-cleared loadedMonthEntries (line 399). ProjectsTree solves this exact problem with loadToken (projects-tree.ts:88-89); this provider has no invalidation.
- **fix:** Add a loadToken bumped in refresh()/setServer(); capture it in loadTodayAndThisWeek/loadMonthEntries and discard results (and restart the load) when the token changed, mirroring projects-tree.ts loadRoot.

### 24. [x] src/trees/my-issues-tree.ts:41 — Entire MyIssuesTree module (277 lines) is dead code — no production importer

- **dimension:** complexity | **verdict:** CONFIRMED
- **detail:** Repo-wide grep shows MyIssuesTree/ParentContainer/isParentContainer are imported only by test/unit/trees/my-issues-tree.test.ts. extension.ts wires the status bar and gantt to ProjectsTree.fetchIssuesIfNeeded (extension.ts:228, 281); nothing registers MyIssuesTree as a tree view. The module duplicates hierarchy/container logic that also exists in src/utilities/hierarchy-builder.ts (includeMissingParentContainers path, lines 78-280). It also carries a latent bug: pendingFetch (lines 260-266) is cleared only in .then, so one rejected fetch caches a rejected promise forever — moot once deleted.
- **fix:** Delete src/trees/my-issues-tree.ts and its test file (or wire it into extension.ts if it was meant to ship); docs/PERFORMANCE.md references to it need updating either way.

### 25. [x] src/commands/draft-mode-commands.ts:374 — Temp IDs from draft creates are never remapped to real IDs, so dependent drafts can never apply

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** DraftModeServer.createIssue/createVersion/createRelation/addTimeEntry return stubs with negative numeric IDs (src/draft-mode/draft-mode-server.ts:139-173, 382-428, 485-513, 572-607). Any subsequent draft made against such a stub is queued with that negative ID (e.g. setIssueStatus → resourceKey `issue:-123:status`, path `/issues/-123.json`; createTimeEntry → `issue_id: -123`). On apply, executeOperation discards the create response (`await server.createIssue(issueData, {_bypassDraft: true})` at line 374, same for versions/relations), so the real server ID is never captured and dependent ops replay verbatim against `/issues/-123.json` → 404/422 every time. The user's queued edits on draft-created resources are permanently unapplicable. `TempIdMap` and `DraftApplyResult.realId` (src/draft-mode/draft-operation.ts:62-71) were declared exactly for this and are referenced nowhere in src — the remap was designed but never built.
- **fix:** Capture create responses in executeOperation, build a TempIdMap (tempId → real id) during applyDraftsWithTracking, and rewrite issueId/resourceId/path/payload of remaining ops before executing them (creates already precede dependents in queue order). Alternatively, block queuing edits against negative-ID stubs until then.

### 26. [x] src/commands/draft-mode-commands.ts:155 — toggleDraftMode disables draft mode even when drafts remain queued (cancelled or failed apply)

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** When the user picks 'Apply All' in the toggle prompt (line 145), redmyne.applyDrafts shows its own second modal confirm (line 177); cancelling it returns without applying anything, yet `await manager.toggle()` at line 155 still runs and disables draft mode. Same when the apply finishes with failed/skipped ops — they stay in the queue. With the manager disabled, DraftModeStatusBar.update() hides the status bar (src/draft-mode/draft-mode-status-bar.ts:43-45), so persisted pending drafts become invisible. Re-enabling draft mode weeks later resurrects stale ops; a subsequent 'Apply All' replays outdated writes against the Redmine API.
- **fix:** After the chosen action completes, re-check `queue.count`; if drafts remain (cancelled confirm or failures), abort the toggle and keep draft mode on, or explicitly warn that N drafts remain queued.

### 27. [ ] src/draft-mode/draft-review-panel.ts:789 — Entire row-rendering pipeline duplicated between extension TS and inline webview JS — already drifted

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Six logics, twelve sites, all in src/draft-mode/draft-review-panel.ts: row HTML template (lines 176-196 TS vs 801-814 JS), escapeHtml (905-912 vs 699-706), formatTime (914-925 vs 690-697), formatChangesPreview incl. fieldLabels/priorityFields tables (949-1010 vs 708-741), getTypeVerb (932-938 vs 743-749), getTypeClass (941-947 vs 751-757). Drift has already happened: the TS render leaves data-path unescaped at line 187 while the JS render escapes it at 808, and line 762 looks up a nonexistent '#count' element (dead `countEl`). Every future change must be made twice or the two render paths diverge further.
- **fix:** Consolidate in the webview script as the single render path: ship the static shell from getHtmlForWebview, post one initial 'updateOperations' message after load, and delete the TS-side row template plus the exported escapeHtml/formatTime/formatChangesPreview/getTypeVerb/getTypeClass duplicates.

### 28. [x] src/kanban/kanban-controller.ts:225 — markDone leaves timer running: done task keeps ticking, stays getActiveTask, and later fires a completion prompt to log time

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** markDone (kanban-controller.ts:225-238) only sets completedAt; it never calls stopInterval() or clears timerPhase/timerSecondsLeft. A working-timer task can be marked done via drag-drop to the Done header (kanban-tree-provider.ts:158 -> controller.markDone) or the redmyne.kanban.markDone command (kanban-commands.ts:137) with no guard. Consequences: (a) the 1s interval keeps decrementing the done task and eventually fires onTimerComplete, whose handler (kanban-timer-handlers.ts:38) opens a modal proposing to log the FULL work duration to Redmine for a task the user already finished/abandoned; (b) getActiveTask() still returns the done task, so the status bar shows it as $(pulse) active and toggleTimer pauses a done task. Same gap in the 'Log & complete' path: timer-handlers.ts:91 calls markDone after tick already set timerSecondsLeft=0 with timerPhase still 'working', leaving a permanent '$(pulse) 0:00' status bar entry until reload.
- **fix:** In markDone, mirror stopTimer: if task.timerPhase === 'working' call stopInterval(), and clear timerPhase/timerSecondsLeft/lastActiveAt in the patch. That fixes drag-drop, the command, and the post-completion 'working at 0:00' state in one place.

### 29. [x] src/kanban/kanban-controller.ts:63 — Configured break duration is never honored: break timer is always the hardcoded 15-min default

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** breakDurationSeconds is readonly, set only from constructor options (kanban-controller.ts:37, 63), and setupKanban (kanban-setup.ts:37-39) passes only workDurationSeconds. startBreak (kanban-controller.ts:600) therefore always counts down 15*60. The configureTimer UI (kanban-commands.ts:789-807) advertises 'Break = Unit - Work' and lets the user set a break duration, but it only rewrites workDuration in globalState; no code path ever updates the controller's break length. A user who configures unit=60/work=50 (break should be 10 min) still gets a 15-min break countdown; someone setting break=0 still gets 15 min.
- **fix:** Compute break = (unitDuration - workDuration) * 60 in setupKanban and pass it as breakDurationSeconds; drop readonly and add setBreakDurationSeconds(), calling it from every configureTimer branch that changes unit/work/break (symmetric with the existing setWorkDurationSeconds calls).

### 30. [x] src/kanban/kanban-controller.ts:129 — deferredMinutes is in-memory only: deferred work time is silently lost on window reload

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** addDeferredMinutes (kanban-controller.ts:129-132) mutates this.deferredMinutes and fires onTasksChange but never persists; restore() (line 645) only reads tasks. The deferTime command (kanban-commands.ts:576-578) stops the timer and tells the user 'Deferred Xmin to next task', i.e. the elapsed work is now represented ONLY by deferredMinutes. Any window reload / extension-host restart before the next log drops it, so that worked time is never logged to Redmine — silent loss of tracked billable time, directly contradicting the confirmation message.
- **fix:** Persist deferredMinutes to globalState (e.g. key redmyne.kanban.deferredMinutes) in addDeferredMinutes/consumeDeferredMinutes and restore it in restore(), alongside the existing task persistence.

### 31. [x] src/commands/adhoc-commands.ts:135 — trailingRef regex consumes user prose after mid-text #NNN refs, destroying comment text on the server

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** Both contributeToIssue (lines 130-140) and removeContribution (lines 173-180) use `const trailingRef = /#\d+[^\n]*$/` with code comments stating a mid-text "#NNN" with prose after it "must not be consumed to end-of-line". But `[^\n]*$` matches arbitrary prose to end-of-string, so for a single-line comment like "Investigated #123 root cause and fixed it", trailingRef matches "#123 root cause and fixed it" and replace/remove destroys the user's trailing prose; the clobbered comment is then written to Redmine via updateTimeEntry (lines 143, 183) with no undo. The guard only works for multi-line comments. Compounding it: parseTargetIssueId (src/utilities/contribution-calculator.ts:8, `/#(\d+)/`) extracts the FIRST ref while trailingRef targets the LAST-ref-to-EOL, so for "#100 setup then #200 review" removeContribution reports "Removed contribution to issue #100" but actually deletes the "#200 review" text — wrong segment removed, wrong message shown.
- **fix:** Anchor the regex to the ref this feature actually appends and to the parsed target id: build it per-call as `new RegExp("#" + targetId + "\\b[^\\n]*$")` only when the parsed target is the LAST ref in the comment, or store the appended ref's exact text. Minimal fix: require the trailing segment to start with the parsed target id (`new RegExp('#' + existingTarget + '[^\\n]*$')`) and otherwise fall back to token-only replacement, so unrelated prose and mismatched refs survive.

### 32. [x] src/commands/context-proxy-commands.ts:329 — Sidebar 'Update Issue...' executes unregistered command redmyne.issueActions — menu item silently does nothing

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** redmyne.updateIssue (wired to the projects/my-issues issue context menu, package.json:1492) forwards to vscode.commands.executeCommand("redmyne.issueActions", false, {}, `${issue.id}`). No code registers redmyne.issueActions: grep across src/ and package.json finds only this call site and a unit test asserting the forwarding (test/unit/commands/context-proxy-commands.test.ts:200), which masks the missing target. executeCommand rejects with 'command not found'; the promise is not awaited or caught, so the user gets zero feedback — the menu item is a no-op. Even if the command existed, the {} props argument satisfies the registrar's withPick===false path but lacks .server, so the action would deref undefined.
- **fix:** Forward to the existing canonical command instead: vscode.commands.executeCommand("redmyne.openActionsForIssue", { id: issue.id }) (after fixing that handler to accept an {id} payload — see companion finding), delete the {} legacy-tuple call, and update the test to assert the real target.

### 33. [x] src/commands/open-actions-for-issue.ts:6 — Gantt 'Update Issue...' broken: handler casts {id} payload to string, parseIssueId throws 'issueId.trim is not a function'

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** redmyne.gantt.updateIssue (gantt issueBar context menu, package.json:1829) is forwardIssueIdPayload("redmyne.openActionsForIssue") (context-proxy-commands.ts:96-99), which sends { id: ctx.issueId }. The configured-command registrar preserves that object as args[0]. open-actions-for-issue.ts:6 does `let issueId = args[0] as string | undefined` — the object is truthy so the input-box fallback is skipped, and openActionsForIssueId passes the object to parseIssueId (src/utilities/validation.ts:10), where `issueId.trim()` throws TypeError. The registrar's catch surfaces 'Command failed: issueId.trim is not a function' to the user; the gantt context-menu action never works. Note a raw-string forward can't fix it either: the registrar drops primitive first args (contextArgs only populated for objects), which also makes the string-parsing branch in quick-issue-commands.ts:59-64 unreachable.
- **fix:** In open-actions-for-issue.ts, normalize the arg: if args[0] is an object with numeric id, use String(args[0].id); only treat args[0] as string when typeof === 'string'. Keep the input-box fallback for undefined.

### 34. [x] src/commands/issue-context-commands.ts:227 — setIssueStatus 'in_progress' fallback writes an arbitrary status (second open status by server order) to Redmine

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** For statusPattern 'in_progress', after exact-name and name-contains-'progress' lookups fail, the fallback is `statuses.filter((s) => !s.is_closed)[1]` — whatever status happens to be second in the server's open-status list. On servers with localized or custom status names (e.g. non-English Redmine where no name contains 'progress'), redmyne.setStatusInProgress / redmyne.gantt.setStatusInProgress will call server.setIssueStatus with that arbitrary id — e.g. 'Feedback' or 'Rejected (open)' — a wrong write to the Redmine API. Feedback is only a 2-second status-bar flash showing the name, easy to miss. If only one open status exists, [1] is undefined and the command errors instead.
- **fix:** Drop the [1] index fallback. If neither exact match nor name-contains matches, fall through to the QuickPick picker (the else branch already implements it) so the user explicitly chooses — never write a guessed status id.

### 35. [x] src/controllers/issue-controller.ts:224 — Quick update on unassigned issue sends assigned_to_id:0 and always reports spurious 'Couldn't assign user' partial failure

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** quickUpdate() builds the 'No change' assignee for an unassigned issue as `new Membership(0, "_unassigned_", true)` (line 224-226). RedmineServer.applyQuickUpdate (src/redmine/redmine-server.ts:1437) unconditionally PUTs `assigned_to_id: quickUpdate.assignee.id`, so 0 is written to the API even though the user picked 'No change'. The post-write verification (redmine-server.ts:1461) compares `issue.assigned_to?.id !== quickUpdate.assignee.id` => `undefined !== 0` => true, so EVERY quick update on an unassigned issue with assignee left untouched pops the error 'Issue updated partially; problems: Couldn't assign user' despite the update succeeding. Worse in draft mode: draft-mode-server.ts:308-320 queues an explicit 'Assign #N to _unassigned_' write operation (assigned_to_id:0) plus a 'Set status' op even when both were 'No change' — pending writes the user never requested.
- **fix:** Make QuickUpdate carry optional assignee/status (undefined = no change) using the existing isNoChange flags from the quick-pick items; applyQuickUpdate and the draft-mode interceptor should omit fields that are undefined from the payload/ops and skip their verification checks.

### 36. [x] src/controllers/issue-controller.ts:119 — changeIssueStatus never refreshes trees/workload after a successful status write — UI shows stale status

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** After `await this.redmine.setIssueStatus(...)` succeeds (lines 118-123), the method only shows a status-bar toast. Unlike changeIssuePriority (lines 149-150) and quickUpdate (lines 292-293), it calls neither `this.onIssueUpdated?.()` nor `vscode.commands.executeCommand("redmyne.refreshAfterIssueUpdate")` (which refreshes the projects tree and workload status bar, src/commands/quick-issue-commands.ts:103-106). Consequence: after changing status via 'Change status' the Issues tree, gantt and workload bar keep displaying the old status until a manual refresh; if the issue was closed, it stays listed as open. Looks like a copy-paste omission given the two sibling methods.
- **fix:** Mirror changeIssuePriority: after the toast, call `this.onIssueUpdated?.();` and `vscode.commands.executeCommand("redmyne.refreshAfterIssueUpdate");` in changeIssueStatus's success path.

### 37. [ ] src/kanban/kanban-dialogs.ts:209 — Debounced issue-search QuickPick scaffold (~150 lines) implemented 3x with already-diverging behavior

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Three near-identical createQuickPick scaffolds: src/utilities/issue-picker.ts:711-790 (pickIssueWithSearch), src/utilities/issue-picker.ts:1165-1275 (inside pickIssue), src/kanban/kanban-dialogs.ts:209-360 (link-to-issue dialog). Each repeats: new Promise + createQuickPick<IssueQuickPickItem>; sortByLabel=false (issue-picker uses hasSortByLabel type guard at 716/1169, kanban uses raw unsafe cast at 217); matchOnDescription/matchOnDetail; `resolved` flag + `searchVersion` race counter; identical `handleSelection` (issue-picker.ts:733-762, issue-picker.ts:1179-1195, kanban-dialogs.ts:222-232); debounce(SEARCH_DEBOUNCE_MS) handler with `query.length < 2` guard and busy toggling (issue-picker.ts:764, issue-picker.ts:1197, kanban-dialogs.ts:234); numeric '#id' parse `query.replace(/^#/, "")` + parseInt (issue-picker.ts:771-773, kanban-dialogs.ts:242-244). Drift already happened: SEARCH_DEBOUNCE_MS is 250 in issue-picker.ts:11 but 300 in kanban-dialogs.ts:9; kanban copy lacks recordRecentIssue and the fuzzy/multi-source search differs, so race-guard or selection fixes must be hand-ported to 3 places.
- **fix:** Consolidate in src/utilities/issue-picker.ts: extract a `createSearchQuickPick({ title, placeholder, baseItems, search(query, version): Promise<items>, onPick })` scaffold owning the Promise/resolved/searchVersion/debounce/dispose plumbing; rebuild both issue-picker call sites and kanban-dialogs link dialog on it (search strategy stays a callback). Move SEARCH_DEBOUNCE_MS there as the single constant.

### 38. [x] src/draft-mode/draft-review-panel.ts:905 — escapeHtml implemented 5x with divergent entity coverage (4-8 entities), an XSS-sensitive drift

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Canonical src/webviews/gantt-html-escape.ts:5-20 escapes 8 chars (& < > " ' \ ` $) plus escapeAttr newline handling. Independent copies: src/draft-mode/draft-review-panel.ts:905-912 (TS export, 5 entities, no \ ` $); src/draft-mode/draft-review-panel.ts:699-705 (second copy inlined in the webview <script> string, 5 entities); src/webviews/timesheet/index.js:359-367 (5 entities + falsy guard); src/webviews/gantt/gantt-drag.js:102 (inline `esc` lambda, only 4 entities — does NOT escape apostrophes). All feed user-controlled Redmine data (subjects, descriptions, paths) into innerHTML/SVG. Coverage divergence means an escaping fix (like the backtick/$ additions already made to the canonical) silently misses the other four implementations.
- **fix:** Single home: src/webviews/gantt-html-escape.ts (rename/move to src/shared/html-escape.ts if desired). Webview JS already imports TS modules through esbuild (src/webviews/gantt/arrow-svg.js:12 imports '../gantt-html-escape'), so timesheet/index.js and gantt-drag.js can import it directly; delete the draft-review-panel.ts:905 export and import the canonical, and generate the inline-script copy (line 699) from the same source or move that formatting into extension-side HTML.

### 39. [ ] src/webviews/gantt-panel.ts:1957 — _getRenderPayload is a ~790-line god-method mixing data shaping, layout math, and raw SVG string generation

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** One method (1957-2747) does: config reads (1961), sort comparator (2004-2024), hierarchy selection/caching (2028-2072), expand-all consumption (2077-2094), dependency graph + row flattening (2099-2115), date-range derivation (2139-2161), capacity-simulation map building (2163-2221), column-width/layout constants (2227-2253), top-project-row rewriting (2267-2291), milestone-marker SVG literals (2353-2384), minimap-bar SVG (2386-2430), and render-context assembly with 12 bound closures (2308-2346). Presentation also bleeds into sibling methods: _generateDateMarkers (2811-3042, 230 lines of SVG) and tooltip text builders (3042-3205) live in the panel even though per-row fragment generation was already extracted to gantt/gantt-html-generator.ts. Any change to filtering, capacity, or chart chrome forces edits inside one untestable method on a 3205-line class.
- **fix:** Follow the file's own extraction precedent (buildRowsPayload/buildArrowsPayload in gantt/gantt-html-generator.ts): move the milestone-marker block (2353-2384), minimap-bar block (2386-2430), and _generateDateMarkers (2811-3042) into pure functions in src/webviews/gantt/ taking {minDate, maxDate, timelineWidth, zoomLevel, versions/rows}; then move buildProjectTooltip/formatHealthTooltip/getProjectCustomFieldLines (3042-3205) next to them. Each move is mechanical (inputs already explicit) and shrinks _getRenderPayload to data shaping + payload assembly.

### 40. [x] src/webviews/timesheet-panel.ts:1982 — deleteTimeEntry draft-op envelope hand-built at 8 sites and updateTimeEntry at 4, despite buildCreateEntryOp existing because identical drift already caused a bug

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** The {id, type, timestamp, resourceId, description, http: {method, path, data}, resourceKey: `ts:timeentry:${id}`} envelope is hand-assembled repeatedly. deleteTimeEntry ops: timesheet-panel.ts:1065 (_deleteRow), :1168 (_deleteAggregatedRow), :1360 (_queueCellOperation), :1982 and :2004 (_updateAggregatedCell), :2303 (_restoreAggregatedEntries), :2344 (_deleteExpandedEntry), :2410 (_mergeEntries). updateTimeEntry ops: :1338 (_queueCellOperation), :1960 (_updateAggregatedCell), :2288 (_restoreAggregatedEntries), :2394 (_mergeEntries). The file's own comment at lines 88-92 records that the create op 'was previously hand-built at six call sites and had already drifted (paste included project_id, others didn't)' — the same drift risk now applies to 12 write envelopes that, if inconsistent (e.g. one site omitting activity_id or comments), produce wrong writes to the Redmine API on draft flush.
- **fix:** Add buildDeleteEntryOp({entryId, date, description?}) and buildUpdateEntryOp({entryId, issueId, hours, activityId, comments, date}) next to buildCreateEntryOp (timesheet-panel.ts:93) and replace all 12 sites. Same single-source-of-envelope rationale already proven by buildCreateEntryOp.

### 41. [x] src/webviews/gantt/gantt-drag.js:206 — calcArrowPath (~130 lines) is a verbatim copy of the arrow-routing algorithm in arrow-svg.js, guarded only by a stale comment

- **dimension:** complexity | **verdict:** CONFIRMED
- **detail:** gantt-drag.js:206-332 reimplements every routing case of buildArrowSvg in src/webviews/gantt/arrow-svg.js:50-221 (same-row above-bar routing, centers-aligned vertical, midY S-curves, jogDir/approachDir/minJogRoom jog logic, chevron arrowheads) with identical constants (arrowSize=4, r=4, jogX=8, nearlyVertical<30). The comment at line 202 says 'Must match gantt-panel.ts initial render' — but that source of truth moved: arrow-svg.js's header states it was 'MOVED verbatim from gantt-panel.ts'. Any tweak to arrow routing in arrow-svg.js now silently desynchronizes drag-time arrow updates from mounted arrows (arrows visually jump/kink when a drag starts). Both files are ESM modules in the same webview bundle (gantt-drag.js already exports setupDrag; arrow-svg.js already imports from a TS module), so the copy is pure dead weight.
- **fix:** Extract the geometry core of buildArrowSvg into an exported calcArrowGeometry(source, target, {type|isScheduling, fromStart, toEnd}, barHeight) -> {path, arrowHead} in arrow-svg.js; have buildArrowSvg wrap it; import it in gantt-drag.js and delete calcArrowPath outright.

## MEDIUM (66)

### 42. [x] src/webviews/gantt-panel.ts:1002 — Panel mutates the caller-owned flexibility cache in place, leaking gantt-view-specific scores into ProjectsTree's shared cache

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** updateIssues deep-copies issues explicitly 'to avoid mutating source cache' (lines 730-737) but stores the flexibilityCache Map by reference (line 748: `this._flexibilityCache = flexibilityCache` — callers pass projectsTree.getFlexibilityCache(), see src/extension.ts:260 and src/commands/gantt-commands.ts:36). _loadContributions then overwrites entries via this._flexibilityCache.set(issue.id, newFlexibility) (line 1002) with contribution-adjusted values — including negative effectiveSpent for ad-hoc donors (line 966) and values computed from time entries filtered to the currently viewed person only (userId filter, lines 914-920). Those view-dependent scores silently replace the tree view's flexibility data and persist after the panel closes.
- **fix:** Copy the cache on intake (`this._flexibilityCache = new Map(flexibilityCache)`) so contribution-adjusted scores stay panel-local; if tree enrichment is actually desired, push it through an explicit ProjectsTree API instead of aliased-Map side effects.

### 43. [x] src/webviews/gantt-panel.ts:951 — _loadContributions can write stale data: loadId checked only after the first await, and setLookback force-clears the in-flight guard

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** The stale-load guard `if (loadId !== this._supplementalLoadId) return false` runs once at line 930, but a second await follows (getUserFteBatch, line 951); after it resolves the code mutates _userFteCache, _flexibilityCache (line 1002), and _cachedHierarchy with NO re-validation, so a load superseded mid-flight can clobber caches the newer load just wrote (the newer render then survives, but the next render uses the stale cache). The window is widened by the setLookback handler (line 1326) setting `this._contributionsLoading = false` while a fetch may still be in flight, deliberately defeating the duplicate-fetch guard at line 864 and allowing two _loadContributions to interleave with different fromDate ranges. _contributionData/_contributionSources (lines 940-942) are also written by whichever finishes last.
- **fix:** Re-check `loadId !== this._supplementalLoadId` after the getUserFteBatch await (and before the _contributionData writes); drop the manual _contributionsLoading reset in setLookback — bumping _supplementalLoadId via _refreshSupplementalData already invalidates the in-flight load.

### 44. [x] src/webviews/gantt-panel.ts:407 — Gantt layout constants (column widths, barHeight, headerHeight, stickyLeftWidth formula) re-declared identically in 3 places

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Three sites each re-derive the same layout numbers and the extraColumnsWidth/stickyLeftWidth formulas: (1) _showLoadingSkeleton, src/webviews/gantt-panel.ts:407-421 (labelWidth=250, headerHeight=40, barHeight=22, idColumnWidth=50, startDateColumnWidth=58, statusColumnWidth=50, dueDateColumnWidth=58, assigneeColumnWidth=40, resizeHandleWidth=10, stickyLeftWidth); (2) _getFallbackState, src/webviews/gantt-panel.ts:656-666 (same ten values/formulas); (3) _getRenderPayload, src/webviews/gantt-panel.ts:2229-2252 (same values except idColumnWidth which is auto-fit). The skeleton/fallback/live payloads must stay visually in sync (the file already carries mirror-comments at lines 48-52 about this), so a width tweak today requires three coordinated edits and silently misaligns the skeleton if one is missed.
- **fix:** Hoist a module-level GANTT_LAYOUT constant next to INDENT_SIZE/MIN_BODY_HEIGHT (lines 51-52) holding the fixed widths plus derived extraColumnsWidth/stickyLeftWidth (parameterized on idColumnWidth for the auto-fit case); all three sites read from it.

### 45. [x] src/webviews/timesheet-panel.ts:290 — onDidReceiveMessage discards the async _handleMessage promise — any handler failure is an unhandled rejection with no user feedback

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** The callback at lines 290-294 is `(message) => this._handleMessage(message)` with the returned promise dropped. _handleMessage awaits handlers like _deleteRow, _updateCell, _updateRowField, _updateAggregatedCell, _mergeEntries, _undoPaste, which await this._draftQueue.add/remove and server calls with no try/catch (unlike _loadWeek/_saveAll/_pasteWeek which catch internally). If DraftQueue persistence or a server call rejects, the rejection is unhandled: local _rows state has already been mutated (e.g. _updateCell mutates row.days at line 1279 before the await at 1288), so the UI shows an edit that was never queued — silent state desync. Additionally _postMessage (line 510) never checks _disposed, so late async completions after panel close throw 'Webview is disposed' into the same unhandled path.
- **fix:** Wrap the dispatch: `(m) => { void this._handleMessage(m).catch(err => this._postMessage({type:'showError', message: String(err)})); }` and guard _postMessage with `if (this._disposed) return;`.

### 46. [x] src/webviews/timesheet-panel.ts:1063 — deleteTimeEntry draft-op literal hand-built at 8 sites

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** The identical { id: generateDraftId(), type: 'deleteTimeEntry', timestamp, resourceId, description, http: { method:'DELETE', path:`/time_entries/${id}.json` }, resourceKey:`ts:timeentry:${id}` } envelope is constructed inline at: src/webviews/timesheet-panel.ts:1063 (_deleteRow), :1166 (_deleteAggregatedRow), :1358 (_queueCellOperation), :1980 (_updateAggregatedCell single-entry), :2002 (_updateAggregatedCell multi-entry), :2301 (_updateExpandedEntry), :2342 (_deleteExpandedEntry), :2408 (_mergeEntries). Descriptions have already drifted ('Delete time entry #N' vs 'Delete time entry N' vs 'Delete time entry on ${date}' vs 'Delete merged entry N'). buildCreateEntryOp (line 93) exists precisely because the create op drifted across six call sites — same fix is overdue for delete.
- **fix:** Add buildDeleteEntryOp(entryId, description?) next to buildCreateEntryOp at the top of src/webviews/timesheet-panel.ts and replace all 8 literals.

### 47. [x] src/webviews/timesheet-panel.ts:1336 — updateTimeEntry draft-op literal hand-built at 4 sites, already drifted

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Inline updateTimeEntry construction at: src/webviews/timesheet-panel.ts:1336 (_queueCellOperation), :1958 (_updateAggregatedCell), :2286 (_updateExpandedEntry), :2392 (_mergeEntries). Drift is already present: the first two PUT { hours, activity_id, comments } while :2286 and :2392 PUT only { hours }. For :2286 (expanded-entry hour edit) that means a prior comments/activity edit captured in the row is silently not sent, and the same missing-issue_id gap as the critical finding repeats here. Consolidating would make field coverage a single decision point.
- **fix:** Add buildUpdateEntryOp(entryId, fields) beside buildCreateEntryOp (line 93) and route all 4 sites through it, making included fields explicit per caller.

### 48. [ ] src/webviews/timesheet-panel.ts:129 — TimeSheetPanel is a 2549-line god-class mixing webview transport, draft-op business rules, globalState persistence, and inline HTML

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** One class owns: message routing (_handleMessage, lines 354-508), row/grid domain logic (_entriesToRows, _calculateTotals, _duplicateRow), DraftQueue op construction and reconciliation (_queueCellOperation, _applyPendingDraftChanges lines 835-960 — a 125-line parser for three tempId formats), an entire aggregated-row subsystem (_updateAggregatedCell/_updateAggregatedCellLocal/_updateAggregatedField/_restoreAggregatedEntries/_mergeEntries, lines 1874-2427, ~550 lines), incomplete-row persistence (lines 774-981), clipboard copy/paste, and a 100-line HTML template (_getHtml, lines 2429-2547). Any draft-semantics change forces edits scattered across all of these, and the create/update/delete drift findings above are a direct symptom.
- **fix:** Incremental split, no rewrite: (1) move _getHtml to src/webviews/timesheet-html.ts (pure function of uris/nonce/draftMode); (2) extract op builders + buildNewEntryResourceKey + _applyPendingDraftChanges into src/webviews/timesheet-draft-sync.ts operating on rows+queue; (3) move the aggregated-row handlers (lines 1874-2427) into a collaborator that receives rows, week, and queue.

### 49. [x] src/webviews/timesheet/index.js:72 — Redo of duplicateRow double-pushes the undo stack and leaves a stale entry pointing at a dead rowId

- **dimension:** bug | **verdict:** PLAUSIBLE
- **detail:** redo() (src/webviews/timesheet/index.js:63-75) unconditionally pushes the popped action back onto undoStack (line 72) before applyAction. For type "duplicateRow", applyAction's redo path (lines 121-127) re-sends `duplicateRow` WITHOUT skipUndo, so the extension replies with rowDuplicated and the message handler (lines 1338-1345) pushes a second, fresh action. The stack now holds the stale action (whose newRowId is the row already deleted by the original undo) plus the new one. The next undo deletes the fresh duplicate; the undo after that posts deleteRow for the stale newRowId, which the extension silently ignores (_deleteRow returns at timesheet-panel.ts:1054) — consuming a user undo keystroke as a no-op and desynchronizing the history.
- **fix:** In redo(), special-case duplicateRow like paste already is: don't pre-push the action; let the rowDuplicated reply create the sole undo entry (or drop redo-of-duplicate with a toast, mirroring the paste handling at lines 67-71).

### 50. [x] src/webviews/timesheet/index.js:1554 — Grid arrow-key navigation uses wrong class selector, so ArrowUp/Down dead-stops at group headers

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** handleGridNavigation builds the row list with `document.querySelectorAll("#gridBody tr:not(.group-header-row)")` (src/webviews/timesheet/index.js:1554), but renderGroupHeader assigns class "group-header" (line 916), not "group-header-row". With grouping enabled, header rows are therefore included in allRows; ArrowDown/Enter from the last row of a group resolves nextRow to the header, finds zero `.day-input` elements, leaves targetInput null, and silently does nothing — keyboard navigation cannot cross group boundaries in either direction.
- **fix:** Fix the selector to `#gridBody tr:not(.group-header)` (and optionally `:not(.empty-row)`), or better, filter to rows that actually contain day inputs: `allRows.filter(r => r.querySelector('.day-input'))` so future row types can't regress this.

### 51. [ ] src/webviews/timesheet/index.js:436 — Aggregated-vs-plain field-update postMessage branch duplicated 5 times in renderRow

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** The identical pattern `if (isAggregated && row.sourceRowIds?.length > 0) postMessage({type:"updateAggregatedField", aggRowId, field, value, sourceRowIds, confirmed:false}) else postMessage({type:"updateRowField", rowId, field, value})` appears 5 times: src/webviews/timesheet/index.js:436-452 (parentProject change), src/webviews/timesheet/index.js:501-517 (project change), src/webviews/timesheet/index.js:567-583 (issue change), src/webviews/timesheet/index.js:627-643 (activity change), src/webviews/timesheet/index.js:672-705 (comments blur, which additionally duplicates the matching aggregatedField/field pushUndo pair). Any protocol change (e.g. adding confirmed semantics or a new field) must be edited in 5 places.
- **fix:** Add one helper in src/webviews/timesheet/index.js next to renderRow: `function postFieldUpdate(row, isAggregated, field, value, undoOld)` that builds the correct message (and optional pushUndo when undoOld !== undefined); call it from all five listeners.

### 52. [ ] src/webviews/timesheet/index.js:3 — 2261-line god-file mixes undo manager, aggregation business logic, rendering, two tooltip systems, toasts, and keyboard nav

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** src/webviews/timesheet/index.js contains at least seven separable concerns in one IIFE: undo/redo stack machinery (lines 10-216), flatpickr week-picker wiring (233-292), row/grid rendering with embedded message-sending listeners (384-1224), row-aggregation business logic (aggregateIdenticalRows, 966-1054 — pure data transformation, not presentation), extension message dispatch (1227-1377), grid keyboard navigation (1540-1628), issue tooltip + generic tooltip systems (1630-1896), and the toast system (1898-1956). Everything shares module-level mutable state (lastRenderContext, pendingFocus, tooltip timers), making any change risky and the file effectively unreviewable as a unit.
- **fix:** Incremental split using esbuild's existing bundling (no behavior change): first extract the self-contained leaf utilities — toast.js (showToast/hideToast), tooltips.js (both tooltip systems + clampTooltipPosition), undo-stack.js (pushUndo/undo/redo/applyAction taking postMessage as a dependency) — about 600 lines out. Second pass: move aggregateIdenticalRows + parseHours/formatHours into a pure timesheet-model.js, which also makes them unit-testable.

### 53. [x] src/redmine/redmine-server.ts:1479 — getIssuesByIds builds unbounded comma-joined issue_id URL — large ID sets blow server URL limits

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** getIssuesByIds joins all ids into one query param (`params.set("issue_id", ids.join(","))`, line 1479) with no length cap, then paginate() appends limit/offset. Callers pass arbitrarily large sets: src/trees/my-time-entries-tree.ts:789 (all issue IDs missing from time entries — can be hundreds), src/trees/projects-tree.ts:334 (dependency IDs), src/trees/my-issues-tree.ts:169. A few hundred 6-digit IDs exceeds common proxy/server URL limits (4–8KB) and the whole fetch rejects with an opaque 'Client error (414 …)' — no batching fallback. The sibling method getTimeEntriesForIssues (lines 919–946) already solves exactly this with a 1800-char batching loop, so the failure mode is known in this codebase.
- **fix:** Batch ids by URL length (reuse the MAX_URL_LEN chunking from getTimeEntriesForIssues, ideally extracted as a shared helper) and concat the per-batch paginate results.

### 54. [ ] src/redmine/models/time-entry.ts:11 — TimeEntry.hours typed `string` but Redmine GET responses return a number — type lie forces casts and invites string-concat bugs

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** The model declares `hours: string` (models/time-entry.ts:11), but the API returns hours as a JSON number in GET responses (confirmed by this repo's own docs/API_REFERENCE.md:177 `hours: number`). The codebase works around the lie in three different ways: src/webviews/gantt-panel.ts:821 `parseFloat(entry.hours as unknown as string) || 0`, src/webviews/timesheet-panel.ts:734 `typeof entry.hours === "string" ? parseFloat(entry.hours) : entry.hours`, src/trees/my-time-entries-tree.ts:983 `parseFloat(entry.hours)` (works only because parseFloat coerces). Any new code trusting the declared type and doing `sum + entry.hours` compiles as string concatenation, producing wrong totals at runtime — the compiler actively points authors at the wrong arithmetic.
- **fix:** Type the GET-response field as `hours: number`; introduce a separate write-payload type (e.g. TimeEntryPayload with `hours: string | number`) for addTimeEntry/updateTimeEntry. Then delete the three scattered runtime coercions.

### 55. [x] src/redmine/redmine-server.ts:513 — Change-aware cache check/probe/touch/set ritual hand-rolled three times

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** The identical five-step dance — changeCache.get(key); isExpired(key, CHANGE_CACHE_TTL_MS) guard; shouldProbe(key, MIN_PROBE_INTERVAL_MS) gate; hasChanges(endpoint, cached.lastCheckedAt) with `changed === null || !changed` → touch(key) + return cached; else refetch + changeCache.set(key, data, maxUpdatedOn) — appears at: (1) src/redmine/redmine-server.ts:513–549 getProjects (with an extra cachedProjects mirror field), (2) src/redmine/redmine-server.ts:864–880 getTimeEntries, (3) src/redmine/redmine-server.ts:1528–1554 getFilteredIssues. Three occurrences of subtle async cache-coherency logic means a fix (e.g. the broken probe operator above) must be re-verified in three places, and getProjects already drifted (it null-resets a duplicate field the other two don't have).
- **fix:** Add one private helper on RedmineServer: `private async fetchWithChangeCache<T>(key: string, probeEndpoint: string, fetch: () => Promise<{ data: T; maxUpdatedOn: string }>): Promise<T>` encapsulating get/isExpired/shouldProbe/hasChanges/touch/set; the three methods become one-line fetchers. ChangeAwareCache stays as-is.

### 56. [ ] src/redmine/redmine-server.ts:81 — RedmineServer is a 1727-line god class: HTTP transport + concurrency queue + six independent cache systems + ~40 domain endpoints + search ranking

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** One class owns: raw HTTP execution with TLS/CA handling and error mapping (lines 243–417), a concurrency slot queue (171–193), pagination (423–475), six cache mechanisms with different policies (issueCache TTL map :97, changeCache :100, versionsCache :607, membershipsCache + in-flight dedup map :1396–1397, userFteCache LRU :1204–1219, plus timeEntryActivities/issueStatuses/issuePriorities/cachedProjects/cachedCurrentUser ad-hoc fields), all domain endpoints, and client-side search relevance ranking (1638–1660). Every cache invents its own invalidation idiom, and subclassing for logging required threading 9-arg protected hooks through the transport (199–241). Any transport change risks every domain method and vice versa.
- **fix:** Incremental split, no behavior change: extract transport into `RedmineHttpClient` (doRequest/executeRequest/acquireSlot/releaseSlot/loadCa + the three hooks) that RedmineServer composes instead of inherits; LoggingRedmineServer wraps the client instead of subclassing the whole server. Caches and endpoints stay put for now — this alone halves the blast radius.

### 57. [ ] src/webviews/gantt/index.js:1228 — lookupMaps.isReady() ? maps : document.querySelectorAll fallback repeated at 4 sites (9 expressions)

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** The same 'use lookup map if ready, else DOM query' ternary is hand-rolled at: index.js:1019-1023 (barsForIssueId), index.js:1228-1233 (highlightIssue — bars, labels, arrows: 3 copies), index.js:1240-1243 (highlightProject — labels, aggregate bars: 2 copies), index.js:1373-1378 (arrow click — connectedBars, connectedLabels: 2 copies). The copies have already drifted: barsForIssueId and the arrow-click variants return a NodeList in the fallback branch but an Array from the maps, and index.js:1374 spreads two map results while the fallback is a single combined selector. Any new consumer must re-derive the selector strings that lookup-maps.js already encodes.
- **fix:** Move the fallback into lookup-maps.js: have getIssueBars/getIssueLabels/getArrows/getProjectLabels/getAggregateBars run the equivalent querySelectorAll themselves when !ready and always return an Array. Then delete barsForIssueId and all 4 inline ternaries; callers just call the getters.

### 58. [x] src/webviews/gantt/gantt-drag.js:475 — Escape on the drag-confirm modal leaks into other handlers: clears dependency-chain focus and row selection

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** The modal keydown handler (gantt-drag.js:475-488) preventDefaults but does NOT stopImmediatePropagation, unlike the sibling Escape handler at 1029-1048 which uses stopImmediatePropagation as the priority mechanism. setupDrag registers before setupRowInteraction (index.js:1448 vs 1483), so after the modal cancels, the drag Escape handler still runs clearFocus() when focus mode is active (1042-1046), and gantt-row-interaction.js:133-139 (which never checks e.defaultPrevented) blurs the label and calls setActiveKey(null). Net effect: pressing Escape to cancel a date-change confirmation also silently destroys the user's chain-focus and row selection.
- **fix:** Add e.stopImmediatePropagation() in the modal handler's Escape/Enter branches (it is registered first, so this cleanly wins), and make the row-interaction Escape handler bail on e.defaultPrevented for defense in depth.

### 59. [ ] src/webviews/gantt/gantt-drag.js:594 — Bar DOM-ref bundle (outline/main/handles/grips/labels/arrows/linkHandle) is hand-built 3 times

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Identical ~15-field capture of per-bar drag refs at three sites: (1) handle-resize mousedown, gantt-drag.js:505-548; (2) bulkBars map in bar-body mousedown, gantt-drag.js:594-619; (3) single-move dragState in the same handler, gantt-drag.js:656-690. All three query .bar-outline, .bar-main, .drag-left/.drag-right, grip circles, .bar-labels (+labels-left check), getConnectedArrows, .link-handle and its circles. Site 2 already diverged from sites 1/3 (it additionally caches leftHandleRect/rightHandleRect), which is exactly the drift this duplication invites — and is why the single path re-queries rects per frame at 1136-1137.
- **fix:** Extract `captureBarRefs(bar)` in gantt-drag.js (near getConnectedArrows) returning the full bundle including handle rects; all three sites call it, single-drag paths gain the cached rects for free.

### 60. [ ] src/webviews/gantt/gantt-drag.js:1129 — Bar geometry application (outline/main x+width, handle rects, grip cx, link-handle cx, labels, arrows) repeated 3 times

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** The same write sequence appears at: (1) bulk-move frame update, gantt-drag.js:1083-1109; (2) single-drag frame update, gantt-drag.js:1128-1158; (3) restoreBarPosition, gantt-drag.js:1211-1236. Each sets bar-outline/bar-main x and width, left handle rect x = startX, right handle rect x = endX-14, grip circles cx = startX+9 / endX-9, link-handle circles cx = endX+8, label transform, and updateArrowPositions. The magic offsets (14, 9, 8) are repeated at all three sites, so a handle-size tweak must be found three times (site 3 even re-queries with querySelectorAll instead of using the cached circle refs).
- **fix:** Extract `applyBarGeometry(refs, startX, endX)` in gantt-drag.js handling all element writes with null guards; bulk frame, single frame, and restoreBarPosition all delegate to it (restore passes the original startX/endX).

### 61. [x] src/webviews/gantt/gantt-toolbar-generator.ts:72 — generateProjectOptions silently drops any project whose parent id is not present in the projects array

- **dimension:** bug | **verdict:** PLAUSIBLE
- **detail:** rootProjects = projects.filter(p => !p.parent) (line 73) and children are only reachable by recursing from roots via childrenMap (lines 63-69). A project that HAS a `parent` reference whose id is absent from `projects` (parent lost to API pagination truncation, visibility scoping, or upstream filtering before the toolbar) is neither a root nor anyone's child — it never renders as an <option>. Consequence: the project cannot be selected from the dropdown; worse, if it IS the currently selected project, no option carries `selected`, so the browser displays the first option ("All Projects") while the actual filter state still targets the orphaned project — UI and state silently disagree. generateTitle (line 277) similarly shows an empty title for such a selection.
- **fix:** Build a Set of project ids; classify as root any project with no parent OR a parent.id not in the set (`!p.parent || !idSet.has(p.parent.id)`), keying childrenMap entries only for resolvable parents. Orphans then render at depth 0 instead of vanishing.

### 62. [x] src/webviews/gantt/gantt-html-generator.ts:439 — Date-pair → (startX,endX) bar geometry (null-fallback + Date parse + dateToX + endExclusiveX) is hand-rolled 4 times

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Occurrences: (1) src/webviews/gantt/gantt-html-generator.ts:439-449 (generateIssueBar: startDate/dueDate fallbacks, new Date, dateToX, endExclusiveX, min-width clamp); (2) src/webviews/gantt/gantt-html-generator.ts:485-494 (generateProjectAggregateBar map over childDateRanges — identical fallback+parse+dateToX+endExclusiveX+clamp); (3) src/webviews/gantt/gantt-html-generator.ts:520-529 (generateTimeGroupAggregateBar — byte-for-byte the same block as #2); (4) src/webviews/gantt/gantt-html-generator.ts:952-956 (buildRowsPayload — same pattern, already diverged from #1 by dropping the open-ended fallback, which is the high-severity bug above). Four sites, one of which has already drifted — exactly the failure mode Rule of Three guards against.
- **fix:** Add `barXRange(startDate: string | null, dueDate: string | null, minMs: number, maxMs: number, timelineWidth: number, openEndedMax?: string): {startX, endX} | null` to src/webviews/gantt/gantt-coords.ts (which already owns dateToX/endExclusiveX) and call it from all four sites.

### 63. [ ] src/webviews/gantt/gantt-render-types.ts:31 — GanttRenderContext carries ~12 fields no generator ever reads, plus 3 exported interfaces with zero importers

- **dimension:** complexity | **verdict:** CONFIRMED
- **detail:** Grep across src/ shows no consumer of ctx.rows, ctx.filteredRows, ctx.labelWidth, ctx.startDateColumnWidth, ctx.dueDateColumnWidth, ctx.todayStr, ctx.showIntensity, ctx.showDependencies, ctx.showBadges, ctx.getHealthDot, ctx.donationTargets, or ctx.adHocIssues — gantt-panel.ts:2315-2342 dutifully populates them every render (including binding the getHealthDot callback) but gantt-html-generator.ts reads none of them; the toolbar uses its own separate GanttToolbarContext. ctx.filteredRows is doubly redundant: buildRowsPayload already takes filteredRows as an explicit parameter. Additionally gantt-render-types.ts exports IssuePosition (line 106), GroupRange (line 113, "zebra stripes" — a pre-virtualization concept), and RelationStyle (line 120) with no importers anywhere (arrow-svg.js is untyped JS). Dead payload assembly on a hot render path and a misleadingly fat contract.
- **fix:** Delete the unused GanttRenderContext fields and stop populating them in gantt-panel.ts:_getRenderPayload; delete the IssuePosition, GroupRange, and RelationStyle interfaces outright (re-check test files before removal).

### 64. [ ] src/webviews/gantt/gantt-html-generator.ts:585 — generateRegularBar mixes progress business logic, tooltip text assembly, intensity model selection, and SVG emission; generateBarBadges leaks layout state through 13 positional params

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** generateRegularBar (lines 585-793, ~210 lines) computes effective progress from spent+contributed hours (605-612, business rule), assembles four multi-line tooltip strings (636-690), selects between two intensity models (693-698), computes geometry, and emits the SVG string. Its badge sub-step, generateBarBadges (796-925), takes 13 positional arguments (issue, startX, endX, barY, flexPct, visualDoneRatio, isFallbackProgress, 4 tooltip strings, ctx) — a call-signature that exists only because the parent computed intermediate values the child re-needs; any new badge means threading another parameter through. Tooltip wording also partially duplicates generateIssueLabel's (172-199).
- **fix:** Incremental split: extract a pure `computeBarViewModel(issue, ctx): { visualDoneRatio, isFallbackProgress, effectiveSpentHours, barTooltip, progressTooltip, flexTooltip, blocksTooltip, blockerTooltip }` (no SVG), then pass that single object to generateRegularBar and generateBarBadges. Keeps rendering string-only and makes the progress-fallback rule unit-testable.

### 65. [x] src/utilities/issue-picker.ts:861 — Clearing the query does not invalidate in-flight searches — stale results overwrite the restored base list

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** In pickIssueWithSearch, onDidChangeValue's empty branch (861-866) cancels the pending debounce and resets quickPick.items = baseItems, but never bumps searchVersion. A search already executing (765-858) then passes the guard at 802 (thisSearchVersion === searchVersion, !resolved) and replaces quickPick.items with results for the abandoned query at 840-844. Same defect in pickIssue (clear branch 1288-1293, overwrite 1267-1271). Also typing back down to a 1-char query returns early at 765/1198 without a version bump, leaving the same window open. User sees search results pop in after clearing the box, and the highlighted/active item silently changes right before they press Enter — risking accepting the wrong issue.
- **fix:** Increment searchVersion (or set a cancelled flag) in the onDidChangeValue clear branch and the <2-chars path in both pickers so in-flight completions fail the version check.

### 66. [x] src/utilities/issue-picker.ts:917 — Recent-issue hydration mutates the shared myIssuesCache arrays, polluting 'My Open/My Closed' for all later picker opens

- **dimension:** bug | **verdict:** PLAUSIBLE
- **detail:** getMyIssues returns live references into the module cache (lines 94, 113: myIssuesCache.openIssues / .closedIssues). The hydration block in pickIssueWithSearch (905-925) pushes fetched not-assigned-to-me recent issues directly into myOpenIssues/myClosedIssues (920-921), i.e. into the cache itself. Consequences within the 5-min TTL: (a) unassigned issues render under 'My Open'/'My Closed' sections in subsequent opens even after they leave the recent list; (b) they enter assignedIds (412 via localIssues), getting the assigned ranking boost in fuzzyFilterIssues they should not have; (c) cache contents now depend on UI interaction history, so prewarmIssuePicker and getMyIssues no longer agree on what 'my issues' means.
- **fix:** Have getMyIssues return copies ([...openIssues], [...closedIssues]) or hydrate into picker-local arrays (const open = [...myOpenIssues]) instead of pushing into the cached ones.

### 67. [x] src/utilities/wizard.ts:121 — wizardInput detects Back via label.includes("Back") — typed values containing 'Back' discard input and navigate backwards

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** When the user types, the active item becomes { label: `$(check) Accept: "<value>"` } (107). onDidAccept checks selected?.label.includes("Back") (121); any input containing the substring 'Back' (e.g. comment 'Backend refactor', 'Backport fix') makes the Accept item match, so the wizard resolves WIZARD_BACK: typed text is silently lost and the wizard steps backwards. String-matching a UI label for control flow is the mechanism; the file already defines the right pattern (WizardPickItem.data === WIZARD_BACK, used in wizardPick at 59).
- **fix:** Build the items as WizardPickItem objects with a discriminant (data: WIZARD_BACK vs data: 'accept') and branch on data in onDidAccept instead of label text.

### 68. [ ] src/utilities/issue-picker.ts:1 — issue-picker.ts is a 1371-line god-file mixing search engine, four caching layers, and two full QuickPick UIs

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** One module owns: module-level caches with TTL/invalidation policy (projectPathCache 34, timeTrackingStatusCache 42, myIssuesCache 51, searchResultCache 294, fuseCache 492), the fuzzy-search engine (Fuse config 426, operator parsing 502, ranking/boosts 480-660), project-path domain logic (buildProjectPathMap 441), time-tracking business policy (fail-open semantics 150, trackability splits), and two ~300-line QuickPick orchestrations (pickIssueWithSearch 701, pickIssue 1038) plus activity picking (675, 1323). The __testIssuePicker export (1363-1371) exists precisely because internal search logic can't be tested without dragging in the UI module. Any change to ranking or caching forces edits in a file dominated by vscode UI wiring, and the two pickers already drifted (pickIssue's search bypasses getTimeTrackingStatusCached at 1222-1227 with no fail-open try/catch, so one flaky project rejects the whole Promise.all and shows 'Search failed').
- **fix:** Incremental split: move searchIssuesWithFuzzy, fuzzyFilterIssues, parseSearchOperators, getOrCreateFuse, buildProjectPathMap and the five caches into src/utilities/issue-search.ts (no vscode import needed), leaving QuickPick orchestration here; then point pickIssue's search-time tracking check at getTimeTrackingStatusCached to kill the behavioral drift.

### 69. [x] src/utilities/issue-picker.ts:194 — Issue-to-QuickPickItem mapping (label `#id subject`, assignee description, projectPathMap detail) hand-rolled 12 times

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** The same object literal — label: `${icon} #${issue.id} ${issue.subject}`, description: issue.assigned_to?.name ?? 'Unassigned' (+ optional tag), detail: projectPathMap.get(issue.project?.id ?? 0) ?? issue.project?.name — is repeated at: issue-picker.ts:194-200, 207-213, 220-226, 233-239 (buildIssuePickerItems), 828-835 (pickIssueWithSearch search results), 1091-1097, 1103-1109, 1129-1135, 1141-1147, 1153-1159 (pickIssue base items), 1244-1251 and 1254-1260 (pickIssue search results). Twelve sites; they already drifted in small ways (detail fallback 'Unknown' only at 236/1156, statusTag formats differ between 193 and 827).
- **fix:** Add one issueToQuickPickItem(issue, projectPathMap, { icon?, disabled?, statusTag?, alwaysShow? }) helper beside buildIssuePickerItems in issue-picker.ts (or in the proposed issue-search.ts split) and replace all twelve literals.

### 70. [x] src/utilities/tree-item-factory.ts:160 — Tooltip sections triplicated: custom-fields block and 'Open in Browser' link each appear 3x; the two issue tooltip builders are ~85% identical

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Custom-fields rendering loop appears at tree-item-factory.ts:136-145 (createFlexibilityTooltip), 203-212 (createBasicTooltip), 287-297 (createProjectTooltip, appendText variant). The browser-link block (strip trailing slashes from server.options.address, append link) appears at 148-151, 215-218, 314-317. Beyond those 3x snippets, createBasicTooltip (160-221) duplicates createFlexibilityTooltip (89-154) wholesale — title, tracker/priority/due metadata, description section, relations section — differing only in the Status line and the Progress/Remaining lines.
- **fix:** Extract appendCustomFields(md, fields) and appendBrowserLink(md, server, path) helpers in tree-item-factory.ts, then collapse the two issue tooltips into one createIssueTooltip(issue, server, flexibility?: FlexibilityScore) that branches only on the status/progress lines.

### 71. [x] src/utilities/workload-calculator.ts:61 — Remaining work clamps at the aggregate level, letting overspent issues cancel other issues' remaining hours

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** `remaining = Math.max(totalEstimated - totalSpent, 0)` nets across issues before clamping. Example: issue A est 10h/spent 0h, issue B est 5h/spent 20h → totals 15/20 → remaining 0, though A genuinely has 10h left. buffer = availableThisWeek - remaining then overstates free capacity in the status bar, telling the user they have slack when they are overbooked. capacity-calculator's calculateRemainingWork already does this correctly per-issue.
- **fix:** Sum per-issue clamped remainders: `issues.reduce((s, i) => s + Math.max((i.estimated_hours ?? 0) - (i.spent_hours ?? 0), 0), 0)` (or reuse calculateRemainingWork's done_ratio-aware logic).

### 72. [x] src/utilities/hierarchy-builder.ts:196 — buildProjectNode mixes tree construction with metric aggregation via full-subtree recollection at every nesting level

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** Inside the recursive builder, each project node re-walks its entire subtree twice — collectChildDateRanges (line 193) and collectAllIssues (line 196) — to compute childDateRanges and health. Every ancestor repeats the walk over the same descendants, giving O(n × depth) work, and the identical decorate-after-build block is repeated in the fallback path (lines 245-249). Structure building, date-range aggregation, and health scoring are three concerns interleaved in one closure, so changes to health rules force edits inside the tree builder.
- **fix:** Keep builders structure-only, then add one post-order decoration pass that computes each node's childDateRanges and issue list bottom-up from its children's already-computed values (each node's ranges = own issue range + concat of children's ranges), and calls calculateProjectHealth once per project node. Single pass, O(n), shared by both build paths.

### 73. [x] src/utilities/adhoc-tracker.ts:44 — Config-backed issue-id-set tracker implemented three times (ad-hoc, precedence, auto-update)

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Three near-identical implementations of 'number[] in redmyne.* Global setting + promise-queue serialization + add/remove/toggle': (1) src/utilities/adhoc-tracker.ts:11-77 (loadIds/setIds, enqueue at 44-48, tag/untag/toggle at 54-77); (2) src/utilities/precedence-tracker.ts:5-52 (getIds/setIds at 5-11, enqueue at 15-19, setPrecedence/clearPrecedence/togglePrecedence at 29-52); (3) src/utilities/auto-update-tracker.ts:5-49 (getIds/setIds at 5-11, enqueue at 16-20, enable/disable/toggle at 26-49). The enqueue helper, the duplicate-guard add, the filter-remove, and the read-then-branch toggle bodies are line-for-line copies parameterized only by setting key. Divergence has already started: only adhoc-tracker has the read cache + onDidChangeConfiguration invalidation, so precedence/auto-update re-read config in every isEnabled/hasPrecedence call.
- **fix:** Extract a factory, e.g. src/utilities/issue-id-set-tracker.ts: createIssueIdSetTracker(settingKey, { cache?: boolean }) returning { has, add, remove, toggle, getAll }; reimplement all three modules as one-line instantiations (keeping their public function names as thin re-exports).

### 74. [x] src/utilities/migration.ts:84 — Swallowed secret-migration errors plus unconditional version bump permanently strand the old API key

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** migrateSecretKey wraps all SecretStorage calls in `catch { return false; }` (lines 84-86), and runMigration then writes CURRENT_MIGRATION_VERSION unconditionally (lines 137-140). If secrets.get throws transiently on first activation after upgrade (e.g. OS keychain locked/unavailable at startup — a real failure mode on Linux), the key under 'redmine:global:apiKey:v2' is never copied to 'redmyne:global:apiKey:v2', the migration is marked complete, and it never retries. User-visible effect: extension appears unconfigured and the user must re-enter the API key, while the same V2 settings migration could also half-apply (config.update succeeding for some keys) before a later throw rejects runMigration without version bump but with mixed state.
- **fix:** Only mark the migration version complete when no step errored: have migrateSecretKey distinguish 'nothing to migrate' from 'failed' (return tri-state or rethrow), and skip the version bump (so it retries next activation) when any secret migration failed.

### 75. [ ] src/utilities/configured-context-updater.ts:31 — Single 95-line closure mixes context flag, server construction, draft-conflict UX, tree wiring, and FTE/status-bar logic

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** The updater returned at line 31 performs six unrelated jobs inline: reads config and sets the 'redmyne:configured' context key (32-43), constructs and wraps the server (48-62), runs the draft-queue identity check including a modal user dialog (65-87), wires and refreshes two trees (89-92), pre-warms the issue picker (95), and fetches the current user to parse an 'fte' custom field and trigger a status-bar recalc (98-115). Business rules (FTE custom-field parsing), transport (server creation), persistence (draft queue), and presentation (modal warning, setContext) all live in one function, so every concern's failure handling is ad hoc (`catch {}`, `.catch(() => {})`, showErrorMessage) and none is independently testable.
- **fix:** Incremental split within the same file: extract `loadDraftQueueForIdentity(serverUrl, apiKey, draftQueue)` (lines 65-87) and `applyUserFte(server, setUserFte, updateWorkloadStatusBar)` (lines 98-115) as named functions; the updater body then reads as configure-context -> build server -> wire trees -> kick off the two background tasks.

### 76. [x] src/status-bars/workload-status-bar.ts:57 — update() awaits fetchIssuesIfNeeded with no error handling — network failure becomes unhandled rejection, status bar stuck

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** update() awaits deps.fetchIssuesIfNeeded() (line 57) without try/catch. The wired implementation (extension.ts:281 → projectsTree.fetchIssuesIfNeeded → getChildren → loadRoot) has no catch around server.getProjects/getFilteredIssues (projects-tree.ts:324-327), so any network/auth error rejects the chain. Every call site is `void ...update()` (extension.ts:286, 290, 344, 348; quick-issue-commands.ts:105), so the rejection is unhandled and the status bar silently keeps stale text or never appears.
- **fix:** Wrap the fetch in try/catch inside update(); on error hide the bar or keep last-known text, optionally log via output channel.

### 77. [x] src/trees/my-time-entries-tree.ts:460 — Draft-operation date-range filter predicate repeated 3 times

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** The same predicate — keep op if its time_entry.spent_on falls in [start,end] OR op.resourceId matches an entry in the server set — is inlined three times: src/trees/my-time-entries-tree.ts:460-464 (today, range [today,today]), src/trees/my-time-entries-tree.ts:467-474 (week, [weekStart,weekEnd]), src/trees/my-time-entries-tree.ts:575-581 (month, [start,end]). Each re-implements the `op.http.data?.time_entry` cast and the `.some(e => e.id === op.resourceId)` scan; the three copies have already drifted once (the week version needed the weekEnd fix noted in its comment).
- **fix:** Add `function filterDraftOpsForRange(ops: DraftOperation[], entries: TimeEntry[], start: string, end: string)` next to applyDraftsToEntries in my-time-entries-tree.ts and call it at all three sites.

### 78. [x] src/trees/my-time-entries-tree.ts:760 — mapEntriesToNodes mixes transport, cache management, sorting, and markdown presentation in one ~130-line method

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** Lines 760-887: the method fetches projects (line 765) and batch-fetches issues (line 789) over the API, populates/repairs issueCache including the 'Unknown Issue' negative-caching policy (lines 791-811), sorts (line 815), and then hand-builds per-entry markdown tooltips, labels, contextValues, and icons (lines 818-885). The sibling trees delegate presentation to utilities/tree-item-factory (createEnhancedIssueTreeItem — projects-tree.ts:137, my-issues-tree.ts:77); time entries hand-roll it inline, so presentation changes require editing data-loading code.
- **fix:** Incremental split: extract the cache-fill block (762-812) into a private resolveIssueInfo(entries) method, and move the per-entry label/tooltip/icon construction into utilities/tree-item-factory as createTimeEntryTreeNode(entry, info, opts), keeping mapEntriesToNodes as a thin composition.

### 79. [ ] src/draft-mode/draft-review-panel.ts:165 — Panel class mixes lifecycle, message routing, and a ~700-line inline HTML/CSS/JS app in one method

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** getHtmlForWebview (lines 165-884) embeds the full stylesheet (~310 lines) and a complete webview application (~300 lines of JS: tooltip logic, keyboard nav, rendering, message handling) as a template string inside the extension-host class. Every other webview in this repo (src/webviews/gantt/*.js, src/webviews/timesheet/index.js) keeps webview code in its own JS bundled by esbuild into media/. The inline approach gets no type-checking, no linting, no bundling, and is the direct cause of the duplication drift above.
- **fix:** Incremental split: move the inline script to src/webviews/draft-review/index.js (bundled to media/ like the gantt/timesheet webviews) and the CSS to a media stylesheet; draft-review-panel.ts keeps only panel lifecycle + postMessage plumbing.

### 80. [x] src/draft-mode/draft-mode-server.ts:31 — 31 passthrough methods each hand-written twice (declaration + constructor bind), ~70 lines of boilerplate

- **dimension:** complexity | **verdict:** CONFIRMED
- **detail:** Lines 31-61 declare every read method with definite-assignment (`getIssueById!: ...`), then lines 73-103 repeat each name to bind it. Adding any read method to RedmineServer requires two synchronized edits here; forgetting the bind compiles fine (the `!` suppresses the check) but yields `undefined is not a function` at runtime. Nothing about these 31 methods is intercept-specific — they are pure delegation.
- **fix:** Replace with a single typed readonly array of method names and a constructor loop: `for (const m of PASSTHROUGH_METHODS) { this[m] = inner[m].bind(inner) as never; }` — one place to list each method, and a `satisfies` check can keep the list aligned with the interface.

### 81. [ ] src/kanban/kanban-commands.ts:511 — Timer keeps ticking through logEarly/deferTime dialogs: completion can fire mid-flow, double-logging time to Redmine

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** logEarly computes elapsed (kanban-commands.ts:489-493) then opens custom-field prompt, closed-issue confirm, and a modal (line 511) while the controller interval keeps running. If timerSecondsLeft reaches 0 during those dialogs, tick (kanban-controller.ts:572-582) fires onTimerComplete and the handler (kanban-timer-handlers.ts:38) queues its own modal proposing to log the FULL duration. User confirms both -> two addTimeEntry writes for the same work session (elapsed ~= full duration + full duration again), and deferredMinutes can be consumed twice-counted since both flows read getDeferredMinutes() independently. Same window exists in deferTime (lines 559-577): defer Xmin AND completion-log full duration for one session.
- **fix:** Pause the timer (await controller.pauseTimer(task.id)) at the top of logEarly/deferTime before any prompt, resuming on cancel; or have tick suppress onTimerComplete while a log flow is in progress.

### 82. [x] src/kanban/kanban-commands.ts:518 — Time-logging flow (custom fields -> closed-issue confirm -> addTimeEntry -> addLoggedHours -> consumeDeferredMinutes -> error handling) duplicated 4x

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Occurrences: (1) src/kanban/kanban-commands.ts:500-540 (logEarly: promptForRequiredCustomFields, confirmLogTimeOnClosedIssue, addTimeEntry with activityId ?? 0, addLoggedHours, consumeDeferredMinutes, custom-field-regex error branch); (2) src/kanban/kanban-commands.ts:609-648 (logAndContinue: identical sequence incl. the /custom.?field/i error special-case); (3) src/kanban/kanban-timer-handlers.ts:79-99 ('Log & complete': addTimeEntry, addLoggedHours, consumeDeferredMinutes, catch); (4) src/kanban/kanban-timer-handlers.ts:101-123 ('Log & continue': same again, differing only in the post-log step). The deferred-minutes-to-hours math (deferredMinutes/60 added to a base) is also re-derived at kanban-commands.ts:493, 621 and kanban-timer-handlers.ts:53-54.
- **fix:** Extract a shared async logKanbanTime(server, controller, task, hours): Promise<boolean> in a new src/kanban/kanban-time-log.ts that owns the prompt/confirm/addTimeEntry/addLoggedHours/consumeDeferredMinutes/error-message sequence; the 4 call sites keep only their pre-amble (hours calculation) and post-step (stopTimer / startTimer reset / markDone+startBreak / resetTimer+startBreak).

### 83. [x] src/kanban/kanban-controller.ts:177 — findIndex -> guard -> spread-patch+updatedAt -> persist -> fire skeleton repeated 12x in controller

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Every mutator repeats the same 5-step body: src/kanban/kanban-controller.ts:177-189 (updateTask), 199-212 (updateParentProject), 226-238 (markDone), 241-253 (reopen), 257-269 (addLoggedHours), 360-394 (startTimer), 400-415 (pauseTimer), 421-450 (resumeTimer), 456-475 (stopTimer), 481-505 (moveToTodo), 511-526 (moveToDoing), 532-546 (resetTimer). Each re-implements findIndex, the double null-guard (index === -1 plus !task), the {...task, ...patch, updatedAt: new Date().toISOString()} copy, await this.persist(), and this._onTasksChange.fire(). Twelve copies means any persistence/event change (e.g. fixing the markDone timer bug above) must be applied to many sites.
- **fix:** Add a private async patchTask(id: string, patch: Partial<KanbanTask> | (task: KanbanTask) => Partial<KanbanTask>): Promise<void> in KanbanController that does lookup, merge with updatedAt, persist, and fire; each mutator collapses to its patch (startTimer/resumeTimer keep their auto-pause prelude).

### 84. [ ] src/kanban/kanban-commands.ts:59 — registerKanbanCommands is an 893-line god function mixing command wiring, time-log business flows, and settings UI

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** One function registers ~25 commands and inlines three unrelated concerns: (a) full time-logging business logic (logEarly lines 468-543, logAndContinue 583-651) that semantically belongs with the identical flows in kanban-timer-handlers.ts; (b) a ~120-line settings dialog (configureTimer, lines 724-843) including the unit/work/break arithmetic that mirrors controller state; (c) the 6x repeated 'Redmyne not configured' guard (lines 71, 183, 221, 367, 481, 602). Result: the file is the change hotspot for every kanban feature, and timer-duration invariants (work <= unit) live in a command callback far from the controller that enforces nothing.
- **fix:** Incremental split, no rewrite: move logEarly/logAndContinue into kanban-timer-handlers.ts (or the shared kanban-time-log.ts from the duplication finding), move configureTimer into a new kanban-timer-settings.ts, and add a requireServer(getServer) helper for the 6 configuration guards. registerKanbanCommands then just wires thin callbacks.

### 85. [x] src/commands/monthly-schedule-commands.ts:96 — Identical 5-step persist sequence (setOverrides → saveMonthlySchedules → setTreeSchedules → status message → refreshTree) repeated 4 times

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Occurrences: (1) src/commands/monthly-schedule-commands.ts:96-104 clear-override path; (2) src/commands/monthly-schedule-commands.ts:109-118 copy-from-default path; (3) src/commands/monthly-schedule-commands.ts:148-153 partial-save-on-cancel path; (4) src/commands/monthly-schedule-commands.ts:162-173 full-save path. Each mutates `overrides`, then runs deps.setOverrides(overrides), await saveMonthlySchedules(context.globalState, overrides), deps.setTreeSchedules(overrides), showStatusBarMessage(...), deps.refreshTree() in the same order. Four copies invite drift — e.g., a future fifth path forgetting setTreeSchedules would silently desync the tree.
- **fix:** Add a local helper in this file: `async function persistSchedules(key: string, schedule: WeeklySchedule | undefined, message: string)` that applies/deletes overrides[key] and runs the five steps; all four sites become one-liners. No new module needed — single command, same file.

### 86. [ ] src/commands/time-entry-commands.ts:110 — 863-line module mixes pure paste-domain logic (planning, formatting, execution, retry) with seven command registrations

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** Lines ~110-398 are paste machinery with no command-registration concerns: formatDayLabel/formatClipboardEntryLine (114-126), buildPasteConfirmLines (148-229), buildPasteWorkItems (243-259), executePaste (270-296), fetchFullWeekEntries (304-311), resolvePasteTarget (318-329), runPasteWithRetry (336-386). Several are exported solely so tests can reach them, which forces test imports through the command module and means any registration change touches the same file as pure logic. The actual command handlers (400-863) additionally do arg-shape sniffing, clipboard grouping, and a copy keybinding dispatcher — five distinct jobs in one file.
- **fix:** Incremental split: move lines 110-398 (plus PasteConfirmContext/PasteWorkItem interfaces and the CachedEntry type) into src/utilities/time-entry-paste.ts next to the existing time-entry-clipboard.ts; time-entry-commands.ts keeps only registration and imports the helpers. No behavior change, exports stay test-reachable.

### 87. [x] src/commands/internal-estimate-commands.ts:45 — setInternalEstimate parses with parseFloat, silently truncating '1:30'→1h and '2h 30min'→2h; sibling flow uses parseTimeInput

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** The validateInput at lines 34-40 uses parseFloat, which accepts '1:30' (parseFloat('1:30')=1, not NaN) and '2h 30min' (=2), and line 45 stores that truncated value via setInternalEstimate. The identical 'hours remaining' concept in redmyne.setDoneRatio (issue-context-commands.ts:78-90) explicitly advertises and correctly parses these formats with parseTimeInput ('1:30'→1.5). A user trained by one dialog who types '1:30' in the other silently loses 30 minutes of estimate data in globalState — wrong stored value, no error.
- **fix:** Use parseTimeInput for both validation and parsing here, matching issue-context-commands.ts. The validateInput blocks at issue-context-commands.ts:80-86 and 173-179 are already byte-identical — export a shared validateHoursInput from src/utilities/time-input.ts and use it in all three places.

### 88. [x] src/commands/configure-command.ts:57 — 'Update Redmine URL' choice changes URL but keeps the old server's API key, contradicting its own prompt

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** In the existingUrl && existingApiKey branch, shouldUpdateApiKey is only set for choice.value 'apiKey' or 'both' (line 57). Picking 'Update Redmine URL' writes the new serverUrl (line 54) yet retains the previous server's key — even though promptForUrl's own prompt text (line 134) says 'changing URL will require new API key' and the !existingUrl && existingApiKey branch (lines 83-101) treats exactly this URL/key mismatch as 'Invalid configuration'. Result: every subsequent request authenticates against the new server with the old key — 401s with no hint that configuration is the cause.
- **fix:** When the URL actually changes (url !== existingUrl) under the 'url' choice, set shouldUpdateApiKey = true (or prompt 'Keep existing API key?'), mirroring the invariant the invalid-config branch enforces.

### 89. [ ] src/commands/configured-command-registrar.ts:46 — Registrar's overloaded (withPick|node, props, ...args) wire protocol leaks into every caller and silently drops primitive args

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** parseConfiguration overloads the first command argument three ways: boolean withPick, context-menu node object, or implicit undefined — and only preserves args when the first arg is an object or withPick===false. Callers must hand-encode this tuple: tree-item-factory.ts:78 passes [false, { server }, id] casting { server } (no config!) as ActionProperties, gantt-panel.ts:1273-1278 repeats the same encoding, and context-proxy-commands.ts:329 got it wrong with {} (see bug finding). Primitive first args are silently discarded, which is what strands the dead string branch in quick-issue-commands.ts:59-64 and forces every proxy to wrap ids in objects. The function also interleaves this decoding with config reading, server construction, and LRU cache maintenance.
- **fix:** Incremental split inside the same file: extract decodeInvocation(withPick, props, args) returning {preconfigured?: ActionProperties; forwardedArgs} and getOrCreateServer(url, apiKey, config) holding the LRU logic. Then export a tiny invokeConfigured(name, payload) helper and migrate tree-item-factory/gantt-panel/context-proxy call sites to it so the tuple encoding lives in exactly one place.

### 90. [x] src/commands/quick-create-issue.ts:67 — Wizard step state-machine scaffolding duplicated across 3 wizards (17 near-identical step blocks)

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** The while(step<=N)/switch scaffold with the per-step 4-line tail `if (result === undefined) return undefined; if (isBack(result)) { step--; continue; } state.X = result; step++;` is repeated at three sites: (1) quickCreateIssue, src/commands/quick-create-issue.ts:67-176 (7 steps); (2) quickCreateSubIssue, src/commands/quick-create-issue.ts:236-317 (5 steps); (3) quickCreateVersion, src/commands/quick-create-version.ts:51-131 (5 steps). Also shared per-site: the preselectedProjectId pre-fill (quick-create-issue.ts:59-65, quick-create-version.ts:43-49) and the trailing requireValueOrShowError checks. Any change to back-navigation or cancel semantics must be replicated 17 times; the step-numbered titles ('4/7') are also maintained by hand.
- **fix:** Add a generic runWizard(steps: WizardStep<TState>[]) runner next to wizardPick/wizardInput in src/utilities/wizard.ts that owns the loop, back/cancel handling, and 'i/N' title numbering; each wizard then declares its steps as data.

### 91. [x] src/controllers/issue-controller.ts:169 — API failures in changeStatus/changePriority/addTimeEntry are unhandled rejections — action silently does nothing

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** changeStatus (line 170), changePriority (line 175) and addTimeEntry (line 181) await server calls (`getIssueStatuses`, `getIssuePriorities`, `getProjectTimeEntryActivities`) with no try/catch. listActions invokes them fire-and-forget via `void this.changeStatus()` etc. (lines 352-365), so its surrounding try/catch (lines 305, 369) can never observe their rejections. On any network/auth error the promise rejects unhandled: the user picks an action and nothing happens — no quick pick, no error message. The same applies to confirmLogTimeOnClosedIssue inside the voided chooseTimeEntryType (line 26).
- **fix:** Wrap the bodies of the three private helpers in try/catch with `vscode.window.showErrorMessage(errorToString(error))`, or await them in listActions (e.g. `await this.changeStatus()`) so the existing catch handles failures.

### 92. [x] src/extension.ts:256 — Restored Gantt panel stuck on loading skeleton and filter callback unwired when fetch returns zero issues

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** In the redmyneGantt serializer (lines 251-269), `if (issues.length > 0)` gates BOTH `updateIssues` and `setFilterChangeCallback`. If `fetchIssuesIfNeeded()` yields an empty array (no assigned issues, filter excluding all, or transient fetch returning []), the restored panel stays on the loading skeleton forever and the filter-change callback is never registered, so later filter changes from the webview never reach projectsTree. Additionally a rejection from `fetchIssuesIfNeeded()` propagates out of deserializeWebviewPanel with no catch — panel remains skeleton with no user-facing error.
- **fix:** Always call `updateIssues` (it should render an empty gantt) and always call `setFilterChangeCallback`; wrap the body in try/catch that posts an error state to the panel.

### 93. [x] src/webviews/gantt/gantt-html-generator.ts:43 — H:MM / M:SS duration formatters re-implemented 4x outside canonical time-input.ts, with rounding drift

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Canonical: src/utilities/time-input.ts:65-69 (formatHoursAsHHMM, Math.round), :75-79 (formatMinutesAsHHMM), :84-89 (formatSecondsAsMMSS, clamps negatives). Copies: src/webviews/gantt/gantt-html-generator.ts:43-49 formatHoursAsTime uses Math.ceil — the same hours value renders differently in the gantt vs trees/timesheet (e.g. 1.51h -> '1:31' vs '1:31'? no: 0.501h -> ceil '0:31' vs round '0:30'); src/webviews/timesheet/index.js:324-329 verbatim formatHoursAsHHMM; src/kanban/kanban-tree-provider.ts:341-345 and src/kanban/kanban-status-bar.ts:116-120 verbatim private formatSecondsAsMmSs, both missing the Math.max(0, seconds) clamp the canonical has, so a negative timer renders garbage like '-2:-5'.
- **fix:** Import formatHoursAsHHMM/formatSecondsAsMMSS from src/utilities/time-input.ts in kanban-tree-provider, kanban-status-bar, and timesheet webview (esbuild bundles TS imports into webviews); if ceil-rounding is intentional for gantt, add an opts param `{ round: 'ceil' | 'nearest' }` to the canonical instead of a parallel function.

### 94. [ ] src/webviews/timesheet/index.js:373 — Date -> 'YYYY-MM-DD' formatting hand-rolled at 9+ sites in two incompatible flavors (local vs UTC) despite date-utils.formatLocalDate

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Canonical: src/utilities/date-utils.ts:32-37 formatLocalDate (local TZ, with a comment at date-utils.ts:8-11 explicitly warning that UTC conversion causes off-by-one errors). Local-TZ re-implementations: src/webviews/timesheet/index.js:243-247 (flatpickr onChange), src/webviews/timesheet/index.js:371-379 (getTodayDayIndex), src/webviews/gantt/gantt-keyboard.js:59-63 (addDays pad helper), src/utilities/monthly-schedule.ts:25-29 (YYYY-MM variant). UTC `toISOString().slice(0,10)` variant: src/webviews/gantt/gantt-html-generator.ts:438, src/webviews/gantt/gantt-drag.js:141 and :148, src/webviews/gantt-panel.ts:2160-2161, src/utilities/capacity-calculator.ts:142, :186, :216, :229, src/utilities/flexibility-calculator.ts:171 and :222 (split('T')[0]). capacity-calculator anchors dates at T00:00:00Z so UTC is intentional there, but the gantt webview sites mix both flavors in one feature — drag emits UTC-derived dates while keyboard nudge emits local-derived dates, exactly the off-by-one class date-utils warns about.
- **fix:** Make src/utilities/date-utils.ts the single home: keep formatLocalDate and add formatUTCDateISO(date) for the intentionally-UTC call sites; import into webview JS (arrow-svg.js:12 shows webviews already import TS modules) and replace all inline padStart/toISOString variants, choosing one flavor per feature deliberately.

### 95. [x] src/commands/draft-mode-commands.ts:58 — `error instanceof Error ? error.message : String(error)` inlined at 6 sites although errorToString already exists

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Canonical helper src/utilities/error-feedback.ts:6-24 (errorToString) handles Error, string, and message-bearing objects. The degraded inline ternary is re-typed at: src/redmine/redmine-server.ts:157, src/commands/adhoc-commands.ts:44, src/webviews/timesheet-panel.ts:1709, src/commands/draft-mode-commands.ts:58, src/commands/draft-mode-commands.ts:295, src/commands/configured-command-registrar.ts:137. Varies: nothing — all six are character-identical. Consequence beyond maintenance: String(error) on a plain object (e.g. a parsed Redmine error payload) yields '[object Object]' in user-facing error messages, which errorToString explicitly handles at error-feedback.ts:16-21.
- **fix:** Replace all six with errorToString(error) from src/utilities/error-feedback.ts (already imported in several of these command files' siblings).

### 96. [ ] src/draft-mode/draft-review-panel.ts:896 — Webview HTML shell (DOCTYPE/CSP/nonce/css URIs) hand-rolled in 3 panels; draft panel also forks getNonce onto Math.random

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Three panels each rebuild the same boilerplate — nonce, asWebviewUri for media CSS, CSP meta with default-src 'none' / style-src cspSource 'unsafe-inline' / script-src nonce, DOCTYPE+head+title: src/webviews/gantt-panel.ts:603-634 (_getBaseHtml), src/webviews/timesheet-panel.ts:2449-2461, src/draft-mode/draft-review-panel.ts:165-206. Varies: title, extra CSP directives (img-src only in gantt), css/js file lists, body. Worse, draft-review-panel.ts:896-903 re-implements getNonce using Math.random in a charAt loop, while the canonical src/utilities/webview-nonce.ts:4-9 uses crypto.randomBytes and its doc comment explicitly says 'Must come from a CSPRNG (not Math.random)' — the duplicate silently violates the security property the original encodes, weakening the draft panel's CSP nonce.
- **fix:** Delete draft-review-panel's local getNonce (line 896) and import from src/utilities/webview-nonce.ts (gantt/timesheet panels already do). Then add a small builder next to it, e.g. src/utilities/webview-html.ts `buildWebviewShell(webview, extensionUri, { title, styles, scripts, bodyHtml, cspExtra })`, and have all three panels compose their HTML through it.

### 97. [ ] src/utilities/issue-picker.ts:701 — issue-picker.ts fuses a fuzzy-search engine (4 caches, scoring, operator parsing) with three QuickPick UIs containing repeated item construction

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** The file layers two concerns: (a) a search engine — project cache (PROJECT_CACHE_TTL_MS:12, getProjectPathMap:253), search cache (295-304), Fuse cache + scoring constants (482-566), operator parsing (parseSearchOperators:502), fuzzyFilterIssues (566), time-tracking status cache (127); and (b) three picker UIs: pickIssueWithSearch (701-1037), pickIssue (1038-1317), pickActivityForProject (1323). The two issue pickers duplicate the whole QuickPick wiring (debounced search closure, searchVersion guards, handleSelection, onDidChangeValue/Accept/Selection/Hide: 764-888 vs 1197-1315). Within pickIssue alone, the identical QuickPickItem literal (label icon + '#id subject', description assigned_to ?? 'Unassigned', detail projectPathMap.get(...)) is hand-built 5 times: lines 1091, 1103, 1129, 1141, 1153.
- **fix:** Two incremental steps: (1) extract the engine half (caches, parseSearchOperators, getOrCreateFuse, fuzzyFilterIssues, searchIssuesWithFuzzy, getTimeTrackingStatusCached) into src/utilities/issue-search.ts — it has no vscode.window dependency; (2) inside issue-picker.ts add a makeIssueItem(issue, {icon, projectPathMap, disabled}) helper to replace the 5 literal sites.

### 98. [ ] src/webviews/timesheet/index.js:1838 — Four hand-rolled webview tooltip systems (delayed show/hide timers + viewport-clamped positioning), two of them in the same file

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** The same pattern — pointerover starts a show timer, pointerout schedules a delayed hide, position is clamped to the viewport, scroll hides — is implemented independently 4 times: (1) src/webviews/timesheet/index.js:1649-1835 (showIssueTooltip/clampTooltipPosition/positionTooltip/hideIssueTooltip + tooltipShowTimer/tooltipHideTimer wiring at 1780-1835); (2) src/webviews/timesheet/index.js:1838-1900 (showGenericTooltip/hideGenericTooltip + genericTooltipTimer wiring at 1866-1900, plus its own scroll-hide at 1894); (3) src/webviews/gantt/index.js:66-408 (setupTooltips with its own pointerover/out/scroll/keydown/blur lifecycle); (4) src/webviews/gantt/gantt-drag.js:171-205 (showDragTooltip/updateDragTooltip/positionDragTooltip/hideDragTooltip with its own clamping). Timer-handling and clamping bugs must be fixed 4 times; behaviors have already diverged (delays, hide triggers).
- **fix:** Consolidate into a shared webview module (e.g. src/webviews/shared/tooltip.js exporting createTooltip({el, showDelay, hideDelay}) with show/positionAt/hide) imported by both bundles. Incremental path: first merge the two systems inside timesheet/index.js (the generic one at 1838 is a strict subset of the issue one at 1649), then adopt the helper in the gantt bundle.

### 99. [ ] src/draft-mode/draft-review-panel.ts:28 — Singleton webview-panel lifecycle (currentPanel/createOrShow/restore/onDidDispose/disposables/dispose) reimplemented in all three panels

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Identical infrastructure at three sites: (1) src/webviews/gantt-panel.ts:181-404 (static currentPanel, createOrShow with reveal-or-create, restore, onDidDispose wiring at :287, disposables array) plus dispose at :1941-1950 with re-entry guard; (2) src/webviews/timesheet-panel.ts:129-352 (createOrShow :173-221, restore :230-249, constructor wiring :260-297, _dispose :343-352 with guard); (3) src/draft-mode/draft-review-panel.ts:18-102 (createOrShow :28-51, restore :56-63, onDidDispose :101) and dispose :886-893. All three pass the same webview options {enableScripts, retainContextWhenHidden, localResourceRoots: media}. Drift already exists: draft-review's dispose() lacks the `if (disposed) return` re-entry guard the other two have, so panel.dispose() -> onDidDispose -> dispose() runs the disposal loop twice.
- **fix:** Extract src/shared/singleton-webview-panel.ts: a small base class (or factory) owning currentPanel tracking, createWebviewPanel options, onDidDispose wiring, the disposables array, and a guarded dispose(); each panel keeps only its message handler and render logic. Fixes the draft-review re-entry drift for free.

### 100. [ ] src/webviews/gantt-panel.ts:603 — Webview HTML shell (DOCTYPE/meta/CSP/nonce/webview-common.css link) hand-built three times with diverging CSP

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Three sites build the same scaffold: src/webviews/gantt-panel.ts:603-634 (_getBaseHtml: nonce, CSP array, webview-common.css + panel css/js URIs), src/webviews/timesheet-panel.ts:2429-2547 (_getHtml: same nonce/CSP/common-css boilerplate plus flatpickr URIs), src/draft-mode/draft-review-panel.ts:199-206 (getHtmlForWebview head). CSP has drifted: gantt declares `img-src ${cspSource} data:` and `script-src ${cspSource} 'nonce-…'` (gantt-panel.ts:609-614); timesheet (:2456) and draft-review (:204) omit img-src entirely and allow only the nonce in script-src. Nothing documents why the policies differ; any future CSP fix must be re-applied at three sites.
- **fix:** Add src/shared/webview-html.ts with buildWebviewShell({webview, extensionUri, title, styles, scripts, bodyHtml}) that produces nonce + one canonical CSP (img-src included where needed) and the common-css link; all three panels call it.

### 101. [x] src/webviews/gantt-html-escape.ts:5 — escapeHtml implemented four times across the three stacks, with diverging escape sets

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Four independent implementations: (1) src/webviews/gantt-html-escape.ts:5-15 (TS, extension-side; also escapes \, `, $ and has escapeAttr at :18); (2) src/draft-mode/draft-review-panel.ts:905-912 (TS, standard 5 entities); (3) src/draft-mode/draft-review-panel.ts:699-706 (verbatim JS copy inside the inline webview script); (4) src/webviews/timesheet/index.js:359-365 (JS, additionally returns "" for falsy input). The sets differ: user text rendered via the gantt path is escaped more aggressively than the same Redmine data (issue subjects, comments, draft descriptions) rendered via timesheet/draft-review, so an escaping bug fixed in one copy stays live in the others.
- **fix:** Consolidate to src/shared/html-escape.ts for extension-side TS (gantt-panel, gantt generators, draft-review) and one webview-shared JS module (e.g. src/webviews/shared/html-escape.js) that esbuild bundles into gantt.js, timesheet.js, and a future draft-review bundle; pick the superset escape behavior.

### 102. [x] src/draft-mode/draft-review-panel.ts:896 — Draft review defines its own Math.random() getNonce while gantt/timesheet share the CSPRNG version — divergence with a security consequence

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** Gantt and timesheet both import getNonce from src/utilities/webview-nonce.ts (gantt-panel.ts:32, used :604; timesheet-panel.ts:16, used :2449), whose doc comment states the nonce "Must come from a CSPRNG (not Math.random)". Draft-review-panel.ts:896-903 exports a local getNonce built from Math.random() and uses it at :166 for its CSP `script-src 'nonce-…'`, directly violating the project's own documented requirement. There is no reason for the divergence — the shared util predates nothing here and takes the same zero arguments.
- **fix:** Delete the local getNonce in draft-review-panel.ts and import { getNonce } from "../utilities/webview-nonce"; update test/unit imports accordingly.

### 103. [ ] src/draft-mode/draft-review-panel.ts:172 — Entire row-rendering pipeline maintained twice in one file (TS initial render + inline-JS renderOperations) though the data is already baked into the script

- **dimension:** complexity | **verdict:** CONFIRMED
- **detail:** The same row HTML and four helpers exist in two languages in draft-review-panel.ts: TS side — operationRows template :172-197 plus escapeHtml :905, formatTime :914, getTypeVerb :932, getTypeClass :941, formatChangesPreview :949; JS side inside the inline script — renderOperations :759-837 plus line-for-line copies formatTime :690, escapeHtml :699, formatChangesPreview :708, getTypeVerb :743, getTypeClass :751. The initial operations array is ALREADY serialized into the script at :583-590, so the TS-side row generation is redundant: the script could call renderOperations(operations) at startup and the TS templates/helpers could be deleted. Also dead: `const countEl = document.getElementById('count')` at :762 is never used (element id doesn't exist; code uses count-badge/count-text).
- **fix:** Render an empty tbody in getHtmlForWebview, invoke renderOperations(operations) once at script init, and delete the TS-side operationRows template plus the five TS helper functions (move any test coverage to the surviving JS module when the script is extracted); drop the unused countEl lookup.

### 104. [ ] src/draft-mode/draft-review-panel.ts:580 — Draft review is a god-file mixing panel transport, ~320 lines of CSS, and a full webview app in one TS string, unlike the other two stacks

- **dimension:** soc | **verdict:** CONFIRMED
- **detail:** Gantt and timesheet both separate concerns: extension-host panel (src/webviews/gantt-panel.ts, src/webviews/timesheet-panel.ts), esbuild-bundled webview JS (src/webviews/gantt/*.js, src/webviews/timesheet/index.js), and external CSS loaded via asWebviewUri. Draft-review-panel.ts instead embeds ~320 lines of CSS (:207-518) and a ~300-line webview application (:580-881 — message dispatch, keyboard nav, tooltip engine, DOM rendering) inside a template literal in the panel class. Consequences: no syntax checking/linting/minification of the inline JS, forced 'unsafe-inline' duplication pressure, the TS/JS helper duplication of finding 5, and webview logic that cannot be unit-tested. This is the 2-share/1-diverged near-miss: the third panel skipped the established bundling convention for no recorded reason.
- **fix:** Incremental split, no rewrite: move the inline <script> body to src/webviews/draft-review/index.js and the <style> block to src/webviews/draft-review/styles.css, add them to the esbuild entry points (output media/draft-review.js/.css), and reference via asWebviewUri exactly as timesheet-panel.ts:2434-2448 does.

### 105. [x] src/utilities/configured-context-updater.ts:48 — Every updater run creates a new server and drops the old one without dispose — LoggingRedmineServer's 30s setInterval leaks per reconfiguration

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** createConfiguredContextUpdater's returned function calls deps.createServer (extension.ts:129) on every invocation — activation plus every serverUrl/apiKey change and every redmyne.toggleApiLogging (view-commands.ts:63 calls updateConfiguredContext). When logging is enabled this constructs a LoggingRedmineServer whose constructor starts a setInterval(30s) cleanup timer (logging-redmine-server.ts:32). The previous server is simply overwritten via deps.projectsTree.setServer(server)/timeEntriesTree.setServer(server) with no dispose() call, so each replaced LoggingRedmineServer's interval runs forever, pinning the server object and its six cache systems in memory. The codebase knows this is required: the command-registrar path passes disposeServer (extension.ts:387-391) that calls server.dispose() on cache eviction — the context-updater path, which builds the primary tree/gantt server, has no equivalent.
- **fix:** Track the previous inner server in the closure (or in deps) and call dispose() on it (when instanceof LoggingRedmineServer) before assigning the new one; reuse the same disposeServer callback extension.ts already passes to the registrar.

### 106. [x] src/draft-mode/draft-queue.ts:93 — DraftQueue.load() clears operations on server change or parse failure without firing emitChange — draft count badge and contexts stay stale

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** load()'s success path emits change (line 99), but the two paths that CLEAR the queue do not: the server-identity-changed branch (lines 92-95, this.operations = [] + persist, no emitChange) and the catch branch (line 106, this.operations = [], no emitChange). The force-clear branch is hit in production by configured-context-updater.ts:83 (load(serverIdentity, { force: true }) after the user confirms 'Discard Drafts'). Subscribers — draft-mode-status-bar.ts:35 (badge count), draft-mode-commands.ts:130 (updateContexts gating menus), gantt-panel.ts:329, timesheet-panel.ts:330, my-time-entries-tree.ts:237, draft-review-panel.ts:75 — are never notified, so after switching servers and discarding N drafts, the status bar still shows N drafts and draft-gated menu contexts stay enabled until some unrelated queue mutation.
- **fix:** Call this.emitChange() in both clearing paths of load() (after this.operations = [] in the identity-mismatch branch and in the catch branch), mirroring the success path.

### 107. [x] src/utilities/custom-field-picker.ts:101 — List-format custom fields drop the existing value as default — the edit flow re-prompts with no pre-selection and saving silently overwrites the stored value with the first option

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** pickCustomFieldsInternal computes defaultValue from existing values (lines 56-59) and passes it to pickFieldValue, but the 'list' case (line 79) calls pickListField(field, requiredLabel) without it — pickListField's signature has no defaultValue parameter, so the QuickPick opens with the first option highlighted regardless of the saved value. The only caller that passes existing values is the 'edit custom fields' flow (src/commands/time-entry-commands.ts:545), which then writes ALL picked values via updateTimeEntry(entry.id, { custom_fields: values }) — a user who confirms through an unchanged-looking list field silently replaces the stored value with the first list option on the server. Related: pickBoolField's 'picked: true' pre-selection (lines 139-143) is a no-op because QuickPickItem.picked is only honored with canPickMany.
- **fix:** Thread defaultValue into pickListField and pre-highlight the matching option (set it as the first item or use QuickPick.activeItems); for bool fields, reorder options or use activeItems instead of the ignored picked flag.

## LOW (35)

### 108. [x] src/webviews/gantt-panel.ts:1294 — removeDraft promise chain has no .catch — failed removal yields an unhandled rejection and a silently desynced UI

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** The removeDraft handler runs `void this._draftModeManager.queue.removeByKey(resourceKey).then(() => {...})` (lines 1294-1312). If removeByKey rejects, the rejection is unhandled (void only discards the promise), the success-only .then never restores the issue's dates or re-renders, and the user gets no feedback — the webview believes the draft was undone while the queue still holds it and the badge count is never refreshed.
- **fix:** Append .catch((e) => vscode.window.showErrorMessage(`Failed to remove draft: ${errorToString(e)}`)) and re-post the current queue count there, mirroring the error handling used in _updateIssueDates.

### 109. [x] src/webviews/gantt-panel.ts:2821 — Dead code in render path: never-populated bodyMarkers array, always-zero leftMargin parameter, pointless rows alias, projectIds set used only for an emptiness check

- **dimension:** complexity | **verdict:** CONFIRMED
- **detail:** (1) `bodyMarkers` is declared at line 2821 and joined into the output at line 3034 but nothing ever pushes to it — it is always "". (2) _generateDateMarkers takes `leftMargin` (line 2814) and a `zoomLevel = "day"` default (line 2816); the single caller (line 2537-2543) always passes 0 and an explicit zoom, so the `leftMargin +`/`svgWidth - leftMargin` arithmetic at lines 2870-2872 and 2883 is dead generality. (3) `const rows = allRows;` (line 2256) is a bare alias. (4) _loadContributions builds a projectIds Set over all issues (lines 869-878) solely for `if (projectIds.size === 0) return false` — it is never used afterward.
- **fix:** Delete bodyMarkers and the leftMargin/zoomLevel-default parameters (inline 0), drop the rows alias by using allRows directly, and replace the projectIds block with nothing (the _issues.length check at line 863 already covers the realistic empty case).

### 110. [x] src/webviews/timesheet-panel.ts:852 — weekTotal recomputation `Object.values(row.days).reduce((sum,c)=>sum+c.hours,0)` repeated 9 times

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Identical recalculation after mutating a day cell at: src/webviews/timesheet-panel.ts:852, :866, :888, :944, :955 (_applyPendingDraftChanges), :1285 (_updateCell), :2066, :2102, :2115 (_updateAggregatedCellLocal). weekTotal is fully derivable from row.days; storing it invites the recalc being forgotten at the next mutation site.
- **fix:** Add a module-level recalcWeekTotal(row: TimeSheetRow): void (or setDayCell(row, dayIndex, cell) that updates both) in src/webviews/timesheet-panel.ts and use it at all 9 sites.

### 111. [x] src/webviews/timesheet/index.js:760 — Dead dataset writes: sourceEntries JSON-serialized per cell and dropdown entryId/rowId datasets are never read

- **dimension:** complexity | **verdict:** CONFIRMED
- **detail:** `input.dataset.sourceEntries = JSON.stringify(cell.sourceEntries)` (src/webviews/timesheet/index.js:760) is written for every aggregated day cell on every render but never read anywhere in the codebase (grep confirms the single occurrence); the blur handler uses the `cell` closure (line 782) and only checks dataset.isAggregated. Likewise `hoursInput.dataset.entryId` and `hoursInput.dataset.rowId` (lines 2054-2055) are never read — the blur/delete handlers use the `entry` closure (2074-2089, 2115-2121). This is leftover from a pre-closure design and adds per-render JSON serialization for nothing.
- **fix:** Delete line 760 (keep dataset.isAggregated, which IS read at line 781) and delete lines 2054-2055. No other change needed.

### 112. [x] src/redmine/redmine-server.ts:407 — Timeout handler destroys the request, which re-emits 'error' — onResponseError fires twice and corrupts logging correlation

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** On timeout (redmine-server.ts:407–412) the code calls clientRequest.destroy() then onResponseError + reject. Destroying an in-flight Node ClientRequest emits 'error' (ECONNRESET 'socket hang up'), so handleError (line 374) runs too: onResponseError is invoked a second time with the same requestId symbol (the duplicate reject is harmless). In LoggingRedmineServer the first call logs and deletes the symbol entry (logging-redmine-server.ts:150), so the second call re-enters the pendingByPath fallback at logging-redmine-server.ts:134–144 and shifts metadata belonging to a *different* concurrent request on the same method:path — that request's displayId gets a spurious error logged now, and its real completion later steals yet another entry or logs nothing. Output-channel diagnostics become misattributed exactly when debugging timeouts.
- **fix:** Guard terminal callbacks once per request: `let settled = false;` set in handleEnd/handleError/timeout before invoking hooks, and skip if already settled (or simply pass the error to destroy() and let the single 'error' path do the hook+reject).

### 113. [x] src/redmine/redmine-server.ts:1157 — getPriorities duplicates getIssuePriorities — same endpoint, but uncached, so it re-fetches on every quick-create

- **dimension:** complexity | **verdict:** CONFIRMED
- **detail:** getPriorities (redmine-server.ts:1157–1162) and getIssuePriorities (redmine-server.ts:1372–1382) both GET /enumerations/issue_priorities.json with near-identical response handling; only the latter caches. Both are exported via IRedmineServer (interface lines 155–156). Callers of the uncached variant — src/commands/quick-create-issue.ts:41, :215 and src/commands/create-test-issues.ts:46 — pay a fresh HTTP round-trip for static enumeration data on every invocation, and the IssuePriority `is_default` flag is dropped by the narrower return type.
- **fix:** Delete the standalone implementation: make getPriorities delegate (`return (await this.getIssuePriorities()).issue_priorities;`) or migrate the three call sites to getIssuePriorities and remove getPriorities from the interface.

### 114. [x] src/webviews/gantt/index.js:1027 — refreshSelectionChrome derefs selectionCountEl without a null guard — Ctrl+A on the loading skeleton throws

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** selectionCountEl = document.getElementById('selectionCount') (index.js:1017) is used unguarded at 1027/1031. The loading-skeleton chrome (src/webviews/gantt-panel.ts:490-516) ships a toolbar WITHOUT #selectionCount, yet render() still runs initializeGantt for that payload and registers the document-level keydown handler (index.js:1120). Pressing Ctrl+A while the skeleton is up runs selectAll → updateSelectionUI → refreshSelectionChrome → TypeError on `selectionCountEl.classList`, after preventDefault has already suppressed the native select-all. Every comparable element in this file (draftBadge, confirmBtn, menuUndo, ganttScroll) is null-guarded; this one is not.
- **fix:** Guard it: `if (selectionCountEl) { ... }` inside refreshSelectionChrome, or early-return from refreshSelectionChrome when selectionCountEl is null.

### 115. [x] src/webviews/gantt/index.js:1348 — Arrow-selection keeps three overlapping trackers; the inline clear path never resets two of them

- **dimension:** complexity | **verdict:** CONFIRMED
- **detail:** selectedArrowElements (index.js:1348) only ever mirrors the single selectedArrow (pushed at 1367/1412, read only inside clearArrowSelection at 1388) — it is redundant state. The inline clear in the click handler (1353-1359) duplicates clearArrowSelection but resets neither array, so selectedArrowElements and arrowConnectedElements grow by one arrow + all connected bars/labels on every successive arrow click until the next rowWindow refresh happens to flush arrowConnectedElements (1414-1415). The accumulation also retains refs to unmounted recycled SVG elements that still carry .arrow-connected.
- **fix:** Delete selectedArrowElements (selectedArrow alone suffices for clearing) and replace the inline clear block at 1353-1359 with a call to clearArrowSelection(), which already resets arrowConnectedElements correctly.

### 116. [ ] src/webviews/gantt/index.js:614 — sticky-left width / visible-timeline-width computed inline at 4 sites

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** The 'subtract sticky-left column width from clientWidth' geometry is re-derived at: index.js:614-617 (getCenterDateMs), index.js:627-629 (scrollToCenterDate), index.js:1509-1511 (scrollToToday), and index.js:778-779 (scrollToIssue handler, using a different measurement — getBoundingClientRect().width and the bare '.gantt-sticky-left' selector instead of '.gantt-body .gantt-sticky-left' + offsetWidth). The fourth copy has already drifted in both selector and measurement API.
- **fix:** One helper next to getCenterDateMs, e.g. `function getVisibleTimelineWidth() { const w = document.querySelector('.gantt-body .gantt-sticky-left')?.offsetWidth ?? 0; return ganttScroll.clientWidth - w; }`, used by all four sites.

### 117. [ ] src/webviews/gantt/index.js:752 — scrollToIssue message handler re-implements scrollToAndHighlight; highlight+setTimeout pattern at 4 sites

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** The scrollToIssue handler (index.js:752-795) and scrollToAndHighlight (index.js:1519-1537) both: resolve meta via getRowMetaByIssueId → rowWindow.scrollToKey, query label/bar by data-issue-id, horizontally scroll, and apply the add-'highlighted'-then-setTimeout-remove pattern. That pattern appears 4 times: index.js:768-769, 790-791 (2000ms) and 1525-1527, 1534-1535 (1500ms) — the durations have already diverged. Only the horizontal centering math differs (center-bar vs fixed 100px offset).
- **fix:** Have the scrollToIssue handler call scrollToAndHighlight(issueId, { centerBar: true }) and move the bar-centering math behind that option; extract a tiny flashHighlight(el, ms) used by both for the classList+setTimeout pairs.

### 118. [x] src/webviews/gantt/gantt-keyboard.js:156 — Quick-search debounce timer not cleared on close — stale .search-match highlights re-applied after the overlay is gone

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** The input handler schedules a 50ms debounce (gantt-keyboard.js:127-135) that toggles 'search-match' classes on all .issue-label elements. closeQuickSearch (156-162) removes the overlay and strips existing .search-match classes but never clears searchTimeout. Typing then pressing Escape (or blurring) within the debounce window lets the pending callback run after cleanup: it reads the detached input's value and re-adds .search-match classes, leaving orphaned highlight styling with no overlay and no cleanup path until the next search opens. Same window also makes Enter act on a stale/empty matchedRows.
- **fix:** In closeQuickSearch, call clearTimeout(searchTimeout) (hoist searchTimeout to the showQuickSearch scope it already lives in, and null it); optionally flush the filter synchronously on Enter before reading matchedRows[0].

### 119. [ ] src/webviews/gantt/gantt-drag.js:406 — During bulk drag, arrows linking two co-dragged bars render with one endpoint stuck at its pre-drag position

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** updateArrowPositions (gantt-drag.js:402-423) substitutes new coordinates only for `draggedIssueId`; the other endpoint always comes from `dataset.startX/endX`, which are never updated during a drag. In a bulk move, each selected bar updates its own connectedArrows (1104-1107), so an arrow whose BOTH endpoints are selected is drawn twice per frame, each pass treating the other end as unmoved — whichever bar's pass runs last wins, and the arrow visibly anchors to the other bar's old position for the entire drag. Corrected only after commit/refresh.
- **fix:** For bulk drags, build a Map issueId -> {newStartX, newEndX} covering all bulkBars and pass it to updateArrowPositions so both endpoints resolve through it, falling back to dataset values for unselected bars.

### 120. [ ] src/webviews/gantt/gantt-drag.js:1075 — Assorted dead/derivable code in the drag module

- **dimension:** complexity | **verdict:** CONFIRMED
- **detail:** (1) `snapToDay(delta) - snapToDay(0)` at 1075 — snapToDay(0) is always 0 (index.js:559-560), so this is just snapToDay(delta). (2) `dragState.snappedDelta = snappedDelta` at 1111 is never read. (3) The mouseup destructure at 1244 pulls barOutline/barMain/leftHandle/rightHandle/barLabels/connectedArrows that are never used (restore goes through savedState). (4) `const types = baseTypes;` at 751 is a pointless alias. (5) Vestigial bare `{ ... }` blocks after stopPropagation at 504, 572, 990 (leftovers from removed conditions). (6) collectArrows (349) has exactly one caller, getConnectedArrows (344). (7) updateUndoRedoButtons already calls saveState internally (index.js:654), yet call sites pair them (1277-1278, 1339-1340; gantt-keyboard.js:79+88 even calls saveState before the push), persisting state twice per commit.
- **fix:** Delete items 1-5 outright; inline collectArrows into getConnectedArrows; drop the redundant explicit saveState() calls wherever updateUndoRedoButtons() is invoked (or remove the hidden saveState inside updateUndoRedoButtons and keep explicit calls — pick one convention).

### 121. [x] src/webviews/gantt/gantt-html-generator.ts:93 — calculateDailyIntensity mixes UTC day increments with local-midnight dates and local getDay(), drifting across DST transitions

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** Both loops (lines 91-94 and 106-114) start from parseLocalDate() — local midnight (date-utils.ts:13-18) — but advance with `current.setUTCDate(current.getUTCDate() + 1)` (a fixed +24h step), while getDayKey (line 70) reads the LOCAL weekday via date.getDay(). Across a fall-back DST transition, local midnight +24h lands at 23:00 of the same local day, so getDay() attributes the same weekday twice and skips the next one — schedule capacity is summed against wrong weekdays and intensity segments shift by a day for any bar spanning the transition. The sibling getScheduledIntensity (line 141) correctly uses local `setDate(getDate() + 1)`, proving the two near-identical loops were written in different date frames.
- **fix:** Use `current.setDate(current.getDate() + 1)` in both calculateDailyIntensity loops to match getScheduledIntensity, or normalize both functions to a single shared day-iteration helper.

### 122. [x] src/webviews/gantt/gantt-toolbar-generator.ts:237 — Help-dropdown badge legend describes badges that don't match (or don't exist in) the actual bar rendering

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** The legend (lines 237-241) claims: "+Nd days of slack / -Nd days late" — but the flexibility badge renders PERCENTAGES (`+${flexPct}%`, gantt-html-generator.ts:815); "🚧N blocked by this" — the blocks badge actually renders `⛔N` (gantt-html-generator.ts:827); "⛔N blockers" — the blocker badge actually renders `⏳N` (gantt-html-generator.ts:838); "◆ milestone" — no milestone glyph is rendered anywhere in the generator. Net effect: the one UI element meant to explain badge semantics teaches users the inverse meaning of ⛔ (legend says "blockers", bar means "blocks N others").
- **fix:** Rewrite the legend to match generateBarBadges: `+N%/-N%` flexibility, `⛔N` blocks N tasks, `⏳N` waiting on N blockers; delete the milestone row (or implement it).

### 123. [x] src/webviews/gantt/gantt-html-generator.ts:210 — The data-collapse-key/data-parent-key attribute pair (with the `|| ""` fallback) is hand-interpolated 18 times

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** `data-collapse-key="${row.collapseKey}" data-parent-key="${row.parentKey || ""}"` appears at src/webviews/gantt/gantt-html-generator.ts lines 210, 235, 260, 283, 294, 308, 314, 340, 355, 378, 393, 403, 476, 499, 508, 534, 558, and 737. These attributes are the row-window's identity contract (mount/recycle keying), so a single typo or a future third attribute (e.g., depth) means 18 coordinated edits; emptyCellRow (line 282) already exists as a partial helper but only covers the empty-cell case.
- **fix:** Add `rowKeyAttrs(row: GanttRow): string` next to emptyCellRow in gantt-html-generator.ts returning the attribute pair, and interpolate `${rowKeyAttrs(row)}` at all 18 sites.

### 124. [x] src/utilities/hierarchy-builder.ts:314 — Issue HierarchyNode object literal repeated at six sites

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** The literal { type: 'issue', id: issue.id, label: issue.subject, depth, issue, children, collapseKey: `issue-${issue.id}`, parentKey } is constructed six times in this file: src/utilities/hierarchy-builder.ts:314-323 (root in buildFlatHierarchy), :331-340 (container child), :344-353 (orphan), :404-413 (buildIssueTree), :435-444 (buildIssueTreeFromMap), :567-578 (buildMyWorkHierarchy, plus projectName/isExternal extras). Any added HierarchyNode field for issues must be threaded through all six.
- **fix:** Add a makeIssueNode(issue, depth, parentKey, children, extras?: Partial<HierarchyNode>) helper in hierarchy-builder.ts and use it at all six sites; the My Work site passes { projectName, isExternal } as extras.

### 125. [x] src/utilities/capacity-calculator.ts:176 — generateEmptyCapacity duplicates the main loop and is provably redundant

- **dimension:** complexity | **verdict:** CONFIRMED
- **detail:** With leafIssues empty, the main loop in calculateDailyCapacity already produces exactly what generateEmptyCapacity does: loadHours stays 0, percentage 0, status getCapacityStatus(0) === 'available', same working-day filtering. The early return at lines 123-126 and the entire 29-line helper (lines 176-204) — a copy of the same UTC date-walk — exist only to special-case a path the general code handles identically.
- **fix:** Delete generateEmptyCapacity and the `if (leafIssues.length === 0)` early return; the main loop covers the empty case.

### 126. [ ] src/utilities/adhoc-tracker.ts:35 — Module-scope onDidChangeConfiguration listener registered at import time; Disposable discarded

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** Lines 35-39 register vscode.workspace.onDidChangeConfiguration as an import-time side effect and drop the returned Disposable — it is never added to context.subscriptions, so it cannot be disposed on extension deactivation and leaks for the extension-host lifetime. It also fires (and dereferences cachedIds invalidation logic) for the whole host even after the extension's own state is torn down, and the import-time registration makes the module impossible to load in isolation without a live vscode workspace.
- **fix:** Export an `initAdHocTracker(context)` (or a dispose() on adHocTracker) that registers the listener and pushes the Disposable to context.subscriptions; call it from activate().

### 127. [x] src/utilities/collapse-state.ts:88 — clear() is dead code and a desync trap (mutates state without firing onDidChange)

- **dimension:** complexity | **verdict:** CONFIRMED
- **detail:** clear() (lines 88-91) has zero callers across src/ (verified: only expand/collapse/expandAll/collapseAll/getExpandedKeys/version are used from extension.ts:175-179 and gantt-panel.ts:1207-2096). It duplicates collapseAll() except it skips `_onDidChange.fire`, so any future caller would silently desync every listener-synced view — the exact failure mode this 'shared collapse state manager for syncing views' exists to prevent. isExpanded() (line 33) is likewise uncalled and trivially `!isCollapsed`.
- **fix:** Delete clear() (and isExpanded()); callers needing a reset use collapseAll(), which already clears the set and notifies listeners.

### 128. [x] src/utilities/api-logger.ts:163 — redactQueryParams re-declares the sensitive-field list inline instead of reusing module SENSITIVE_FIELDS

- **dimension:** complexity | **verdict:** CONFIRMED
- **detail:** Line 163 hardcodes a second sensitive-field array inside redactQueryParams while SENSITIVE_FIELDS already exists at lines 3-12 and feeds redactPlainText/redactObject. The two lists have already drifted textually ('apiKey' vs 'apikey'; only coincidentally equivalent because both paths lowercase before comparing). Any future addition (e.g. 'session', 'bearer') to one list silently misses the other, leaving query-string credentials unredacted in the output channel.
- **fix:** Delete the inline array; iterate SENSITIVE_FIELDS (pre-lowercased once at module scope) in redactQueryParams, sharing the same matching helper as isSensitiveField.

### 129. [x] src/utilities/date-utils.ts:42 — formatDateISO is a pure alias of formatLocalDate; callers split between the two names

- **dimension:** complexity | **verdict:** CONFIRMED
- **detail:** formatDateISO (lines 42-44) just calls formatLocalDate, yet both are exported and the codebase is split between them (formatDateISO in src/utilities/date-picker.ts and src/commands/create-test-issues.ts; formatLocalDate everywhere else, e.g. time-entry-clipboard.ts, capacity-calculator.ts). Two names for one behavior forces readers to check whether they differ. Similarly getISOWeekNumber (lines 95-97) is a one-line wrapper over date-fns getISOWeek while getISOWeekYear on line 103 is re-exported directly — inconsistent indirection in the same file.
- **fix:** Delete formatDateISO and update its ~12 call sites to formatLocalDate; either re-export getISOWeek directly (matching getISOWeekYear) or drop the wrapper.

### 130. [x] src/shared/loading-placeholder.ts:32 — Dead export, dead field, and a count parameter that is silently ignored

- **dimension:** complexity | **verdict:** CONFIRMED
- **detail:** createLoadingTreeItem (line 32) is exported, marked @deprecated, and has zero callers repo-wide. LoadingPlaceholder.skeletonIndex (line 10) is never set or read anywhere. createSkeletonPlaceholders(_count) (line 45) ignores its parameter yet callers pass meaningful counts expecting that many rows (projects-tree.ts:238 passes 5, projects-tree.ts:269 passes 3, my-issues-tree.ts:140 passes 5) — misleading API. Separately, my-time-entries-tree.ts ignores this shared module entirely and inlines its own identical spinner node literal at lines 435-440, 545-550, and 563-568.
- **fix:** Delete createLoadingTreeItem and skeletonIndex; change createSkeletonPlaceholders() to take no arguments (or honor the count). Have my-time-entries-tree reuse one local loadingNode() helper for its three inlined literals.

### 131. [x] src/draft-mode/draft-review-panel.ts:187 — data-path attribute interpolated unescaped in initial HTML render

- **dimension:** bug | **verdict:** PLAUSIBLE
- **detail:** Line 187 emits `data-path="${op.http?.path || ""}"` without escapeHtml, while the same path is escaped for the visible span on line 188 and the client-side re-render escapes the attribute at line 808. Paths can contain arbitrary strings: createVersion builds `/projects/${projectId}/versions.json` where projectId is `number | string` (project identifier). A `"` in such a value breaks out of the attribute and injects markup into the webview on first render only.
- **fix:** Wrap with the existing helper: `data-path="${escapeHtml(op.http?.path || "")}"` (and same for data-method for consistency with the JS render path).

### 132. [x] src/kanban/kanban-tree-provider.ts:371 — Falsy-zero projectId: tasks stored with linkedProjectId 0 render a project folder that can never expand

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** redmyne.addIssueToKanban stores projectId ?? 0 and projectName ?? '' when the project can't be resolved (kanban-commands.ts:332-333), and validateAndFilter accepts them. getClientFolders happily creates a project folder keyed 0 with empty name (kanban-tree-provider.ts:444-458), but getChildren's guard `element.status && element.projectId` (line 371) treats projectId 0 as falsy and returns [], so the folder shows '(N)' yet expands to nothing — the task becomes unreachable in To Do/Done columns. The cleanup command (kanban-commands.ts:698) then classifies these same tasks as 'corrupted' via !t.linkedProjectName, confirming the 0/'' sentinel leaks broken state.
- **fix:** Change the guard to element.projectId !== undefined (matching the clientId check on line 365), and in addIssueToKanban refuse to add (or refetch) when projectId is unresolvable instead of fabricating 0/''.

### 133. [x] src/commands/timesheet-commands.ts:47 — Serializer Disposable dropped and returned disposables array discarded by sole caller — commands/serializer never reach context.subscriptions

- **dimension:** bug | **verdict:** PLAUSIBLE
- **detail:** registerWebviewPanelSerializer (line 47) returns a Disposable that is neither pushed to `disposables` nor context.subscriptions. Worse, the function's whole contract is broken at its only call site: src/extension.ts:239 calls `registerTimeSheetCommands(context, {...})` as a bare statement, discarding the returned array, so the redmyne.showTimeSheet and redmyne.refreshTimesheet command disposables (lines 27, 41) are also never registered for cleanup. If activation code ever runs twice (tests, future refactor), re-registering the serializer/commands throws "already registered".
- **fix:** Match the sibling pattern in this file's peers: push all three disposables (two commands + serializer registration) into context.subscriptions inside registerTimeSheetCommands and change the return type to void; drop the local `disposables` array.

### 134. [x] src/commands/time-entry-commands.ts:419 — Two of four arg-sniffing branches in openTimeEntryInBrowser are dead — no caller passes a string or {issue_id} object

- **dimension:** complexity | **verdict:** CONFIRMED
- **detail:** The command has exactly two invocation sources: the tooltip markdown command URI at src/trees/my-time-entries-tree.ts:830/846 which encodes `[issueId]` (first arg is a number, handled by lines 410-412), and package.json context menus (lines 174, 1022, 1417) which pass the tree node with `_entry` (handled by lines 414-417). The `{issue_id: number}` branch (419-423) and the string-parsing branch (424-429) have no callers anywhere in src/ or package.json.
- **fix:** Delete the issue_id-object and string branches; keep the number and _entry-node cases. The getIssueIdOrShowError guard at line 431 already covers any unexpected shape.

### 135. [x] src/extension.ts:194 — Tree+Gantt refresh fan-out repeated at four sites in activate()

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** The same 'refresh dependents after data change' fan-out is hand-rolled four times: (1) src/extension.ts:194-197 kanban refreshAfterTimeLog — myTimeEntriesTree.refresh() + executeCommand("redmyne.refreshGanttData"); (2) src/extension.ts:207-211 time-entry-commands refreshTree — identical pair; (3) src/extension.ts:289-293 projectsTree.onDidChangeTreeData — workloadStatusBar.update() + refreshGanttData; (4) src/extension.ts:441-446 draft-mode refreshTrees — projectsTree.refresh() + myTimeEntriesTree.refresh() + refreshGanttData + refreshTimesheet. Each new consumer re-derives which views must be poked, and sites already drift (some refresh the workload bar, some the timesheet).
- **fix:** Define one `refreshAll({projects?, timeEntries?, gantt?, timesheet?, workload?})` helper in src/extension.ts (or src/utilities/) and pass it to setupKanban/registerTimeEntryCommands/registerDraftModeCommands instead of bespoke closures.

### 136. [ ] src/controllers/domain.ts:31 — Domain IssueStatus duplicates models/common IssueStatus, forcing a parallel getIssueStatusesTyped API and ad-hoc conversion

- **dimension:** complexity | **verdict:** CONFIRMED
- **detail:** domain.ts IssueStatus {statusId, name} is the same data as src/redmine/models/common IssueStatus {id, name} with a renamed field. Its existence forces a second server method getIssueStatusesTyped (src/redmine/redmine-server.ts:1364, interface line 154, draft-mode-server.ts:50+92 rebinding) alongside getIssueStatuses, and a manual conversion in issue-controller.ts:203 (`new IssueStatus(this.issue.status.id, this.issue.status.name)`). Two names for one concept taxes every reader and the field rename (id vs statusId) invites the exact undefined-vs-0 comparison confusion seen in applyQuickUpdate.
- **fix:** Use the models/common IssueStatus directly in QuickUpdate; delete domain.IssueStatus and getIssueStatusesTyped (interface, server, and draft-mode binding), leaving getIssueStatuses as the single source.

### 137. [ ] src/extension.ts:57 — Module-level cleanupResources duplicates context.subscriptions as a second, hand-ordered disposal mechanism

- **dimension:** complexity | **verdict:** PLAUSIBLE
- **detail:** extension.ts maintains a 17-field module-level `cleanupResources` object (lines 57-78) whose only purpose is manual disposal in deactivate() (lines 463-533), while other resources (outputChannel, draftModeStatusBar, listeners) already use context.subscriptions. Two parallel cleanup paths mean every new resource needs a field, an assignment, and a deactivate stanza; several fields (bucket, userFte, monthlySchedules) aren't disposables at all and are only stored there to be readable from closures, which plain local consts already provide since activate() never exits scope for those closures.
- **fix:** Push all Disposables into context.subscriptions (wrap order-sensitive pairs in a single vscode.Disposable.from(view, provider)); keep plain data (bucket, userFte, monthlySchedules) as local lets captured by the closures, shrinking deactivate() to the debounce cancel and disposeStatusBar().

### 138. [ ] src/utilities/issue-picker.ts:195 — Issue label template '#id subject' (with icon/closed/disabled variants) repeated 25+ times across 9 files with inconsistent separators

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Sites: src/utilities/issue-picker.ts:195, :208, :221, :234, :829, :1092, :1104, :1130, :1142, :1154, :1245, :1255; src/kanban/kanban-dialogs.ts:194, :200, :319, :344; src/utilities/tree-item-factory.ts:42, :107, :175; src/commands/time-entry-commands.ts:452, :474, :568; src/commands/quick-create-issue.ts:195, :257; src/commands/quick-log-time.ts:45; src/controllers/issue-controller.ts:346; src/trees/my-issues-tree.ts:110; src/webviews/timesheet/index.js:549, :1671; src/webviews/gantt/gantt-html-generator.ts:678, :688. Varies: codicon prefix ($(archive)/$(circle-slash)/$(history)/$(account)), separator drift — quickpicks/trees use '#id subject' while issue-controller.ts:346, tree-item-factory.ts:107/:175, my-issues-tree.ts:110 and quick-create-issue.ts:195 use '#id: subject' — and ad-hoc truncation (quick-log-time). Same issue is therefore titled differently across pickers, tooltips, and notifications.
- **fix:** Add `formatIssueLabel(issue: {id, subject}, opts?: { icon?: string; separator?: ': ' })` to a new tiny src/utilities/issue-label.ts (or export from tree-item-factory.ts since it already owns issue presentation) and use it at all label/title/tooltip sites; pick one canonical separator.

### 139. [x] src/commands/commons/open-actions-for-issue-id.ts:18 — Fire-and-forget withProgress + 'Waiting for response from {hostname}' + try/await/catch errorToString block copy-pasted verbatim 3x

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** Identical ~16-line pattern (pre-created promise; unawaited vscode.window.withProgress({location: Notification}) reporting `Waiting for response from ${server.options.url.hostname}...` and returning the same promise; then try { await promise } catch { showErrorMessage(errorToString(error)) }) at: src/commands/commons/open-actions-for-issue-id.ts:16-38, src/commands/list-open-issues-assigned-to-me.ts:28-59, src/commands/new-issue.ts:23-53. Varies: only the server call and the post-await quickpick. Side effect of the copy-paste shape: the unawaited withProgress call returns the same rejecting promise, creating a second unhandled-rejection path on API failure in all three places — a fix would currently need to be applied 3x.
- **fix:** Add `awaitWithServerProgress<T>(server: IRedmineServer, promise: Promise<T>): Promise<T>` (wraps withProgress with the hostname message and swallows the duplicate rejection) next to errorToString in src/utilities/error-feedback.ts or a new src/utilities/progress.ts, and replace the three blocks.

### 140. [x] src/webviews/timesheet-panel.ts:510 — _postMessage has no disposed guard — async paths post to a disposed webview and throw as unhandled rejections

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** TimeSheetPanel._postMessage (timesheet-panel.ts:510-512) calls this._panel.webview.postMessage unconditionally. _loadWeek's finally block (:615-621) and _saveAll's finally (:1727-1729) run after awaits on network calls; if the user closes the panel mid-flight, postMessage on the disposed webview throws "Webview is disposed", and the fire-and-forget callers (`void this._loadWeek(...)` at :226, :304, :336) turn it into an unhandled rejection. The panel even tracks _disposed (:164) but only uses it as a dispose re-entry guard. Both sibling panels guard this exact race: gantt-panel.ts:644 (_queueRender early-returns on _disposed; also :1599 for the membership fetch) and draft-review-panel.ts:105/110, :117/122, :130/135 check `this.disposed` around every postMessage.
- **fix:** Add `if (this._disposed) return;` as the first line of _postMessage (timesheet-panel.ts:510), mirroring gantt's _queueRender guard.

### 141. [x] src/webviews/timesheet-webview-messages.ts:461 — buildWeekInfo pairs ISO week number with calendar year — timesheet header shows the wrong year for week 1 spanning a year boundary

- **dimension:** bug | **verdict:** CONFIRMED
- **detail:** buildWeekInfo returns weekNumber: getISOWeekNumber(monday) (ISO-8601 week) but year: monday.getFullYear() (calendar year of the Monday). For ISO week 1 whose Monday falls in late December (e.g. Monday 2025-12-29 is W01 of ISO year 2026), the timesheet header (src/webviews/timesheet/index.js:313 renders `W${week.weekNumber} (… ${week.year})`) shows 'W01 … 2025' instead of 2026. date-utils.ts even re-exports date-fns getISOWeekYear (line 103) with a comment noting exactly this boundary case, but buildWeekInfo doesn't use it.
- **fix:** Use getISOWeekYear(monday) for the year field in buildWeekInfo instead of monday.getFullYear().

### 142. [x] src/kanban/kanban-status-bar.ts:116 — MM:SS timer formatter implemented three times; the two kanban copies lack the canonical version's negative clamp

- **dimension:** duplication | **verdict:** CONFIRMED
- **detail:** The same seconds→'M:SS' formatter exists at: (1) src/utilities/time-input.ts:84 formatSecondsAsMMSS — the canonical exported one, which clamps with Math.max(0, seconds); (2) src/kanban/kanban-status-bar.ts:116 private formatSecondsAsMmSs; (3) src/kanban/kanban-tree-provider.ts:341 private formatSecondsAsMmSs. Both kanban copies omit the negative clamp, so a negative secondsLeft renders as e.g. '-1:-5'-style garbage. Both kanban files already import formatHoursAsHHMM from utilities/time-input, so the import path exists.
- **fix:** Delete both private copies and import formatSecondsAsMMSS from src/utilities/time-input.ts (which both files already import from), gaining the negative-value clamp for free.

