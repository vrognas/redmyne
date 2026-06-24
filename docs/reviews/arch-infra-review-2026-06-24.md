# Architecture & Infrastructure Review — Redmyne v4.40.0

Redmyne is a healthy, actively-maintained codebase that has already invested in good DRY infrastructure (single-owner heuristics, shared trackers, hook-based decorators, interface seams) — most low-hanging duplication is gone. The remaining issues cluster into five recurring patterns: (1) a schedule/date-math duplication cluster where the canonical `remaining-work` heuristic has been silently re-implemented and has drifted; (2) two large webview panels that reimplement identical lifecycle/CSP/messaging boilerplate with no shared base; (3) a handful of god-files whose extraction seams are already half-cut; (4) wiring that has degraded into "callback soup" with `ProjectsTree` acting as a de-facto service locator; and (5) pervasive documentation drift, most acutely a `src/timer/` directory that no longer exists but is still documented in three places. **Overall verdict: structurally sound and improving, but carrying maintainability debt in webview symmetry, date-math DRY, and stale docs that a new contributor would trip on within their first day.** None of the 69 findings are correctness bugs; the highest-priority item (the capacity/remaining-work drift) is correctness-*adjacent*.

## Top Themes

**Schedule & date-math duplication (the highest-leverage cluster).** A documented single-owner heuristic has been copied and has drifted: `capacity-calculator.ts` reimplements `remainingHours()` from `remaining-work.ts` and returns different results for `done_ratio>0, spent=0` (findings #0). Around it, the weekday-key array is defined 4× across 3 files (twice in one file, #1), the per-day "walk dates and sum schedule hours" loop is copy-pasted 4+ times with inconsistent UTC-vs-local handling (#2), and the `YYYY-MM` month-key formatter exists 3× despite a canonical `getMonthKey()` (#63). `flexibility-calculator` is the de-facto scheduling kernel but isn't recognized as such.

**Webview panel asymmetry.** `gantt-panel.ts` (3519 LOC) and `timesheet-panel.ts` (2595 LOC) independently reimplement the same VS Code webview lifecycle — singleton `currentPanel`, `createOrShow`, `dispose()` re-entry guard, identical panel options — with no shared base, even though a `BaseTreeProvider` precedent already exists for the tree pair (#4). The CSP/nonce/HTML scaffold is duplicated and has security-relevantly drifted (timesheet drops `img-src`, #5); the two panels use divergent message envelopes (`command` vs `type`, #6); gantt fires 22 ungated `postMessage` calls vs timesheet's one guarded helper (#7); serializer registration lives in two different layers (#8); and client-side HTML escapers are re-inlined in `gantt-drag.js` and `draft-review-panel.ts` despite a shared module (#9, #65).

**God-files with half-cut seams.** The extraction pattern already exists, so these are finishing jobs, not greenfield splits: `GanttPanel._getRenderPayload` is one ~836-LOC method mutating ~10 instance fields mid-computation (#11), plus `_generateDateMarkers` (~248 LOC, #12) and a self-contained relation-CRUD collaborator (#13). `redmine-server.ts` (1788 LOC) fuses HTTP transport + 6 caching strategies + ~50 endpoints (#14, #31), and `kanban-commands.ts` is a 900-LOC registration function spanning four command families (#15).

**Wiring degraded into callback soup.** `extension.ts` threads 52 closure props through `register*` calls, most just re-exposing `ProjectsTree` internals one lambda at a time; `ProjectsTree` has become a service locator (14 members, 33 references) and the canonical holder of the active server via a public mutable `server?` field read everywhere as `() => projectsTree.server` (#16, #21). The documented MVC layering is aspirational — `controllers/` holds one class used at 3 sites while 15 command files call `server.*` directly (#17). Supporting smells: an import cycle (#18), two layering inversions in `utilities/` (#20), and duplicated server-construction config reads (#19).

**Manifest/code drift.** 36 context-only commands leak into the global palette with broken titles like "0%"/"Copy Issue ID" (#56); `additionalHeaders` is read and watched by code but undeclared in `contributes.configuration` (#57); gantt/sidebar command-twins double whole submenu blocks (#58); and `category` is applied to only 2 of 160 commands (#59).

**Documentation drift.** `docs/ARCHITECTURE.md` is ~21 releases stale (v4.19.1), documents a deleted `src/timer/` directory, states a 60% coverage target (actual 88) with `isolate:false` (actual `true`), and omits the 2nd-largest file entirely (#22, #45, #49–#54). The dead `src/timer/` reference propagated to `AGENTS.md`, `AESTHETIC_USABILITY_ANALYSIS.md`, and the kanban state namespace (#52, #53, #62).

**Build/CI repetition & gaps.** 5 esbuild contexts duplicate option blocks (#32); checkout+setup-node+npm ci is copy-pasted across 4 jobs (#38); the 250KB size gate runs in CI but not in the release that actually publishes (#41); 11 shipped webview `.js` files are excluded from both eslint and tsc (#35); and `@vscode/vsce` is invoked via npx unpinned (#34).

## Prioritized Roadmap

### Quick wins (trivial/small, high leverage)
- **Fix capacity/remaining-work drift** — replace `calculateRemainingWork` body with a call to `remainingHours()` · `capacity-calculator.ts`, `remaining-work.ts` · small · #0
- **Delete stale coverage exclude `src/timer/**`** · `vitest.config.ts` · trivial · #44
- **Fix ARCHITECTURE.md timer/version/coverage/isolate drift + omitted timesheet** · `docs/ARCHITECTURE.md` · trivial–small · #22/#45/#49/#50/#51/#54
- **Remove `src/timer/` from AGENTS.md & AESTHETIC doc** · `AGENTS.md`, `docs/AESTHETIC_USABILITY_ANALYSIS.md` · trivial · #52/#53
- **Declare `additionalHeaders` in contributes.configuration** · `package.json` · trivial · #57
- **Add `@vscode/vsce` as pinned devDependency** · `package.json` · trivial · #34
- **Delete dead `esbuild.js` line** · `.vscodeignore` · trivial · #33
- **Pin node version once; add concurrency cancellation** · `ci.yml`, `release.yml` · trivial · #39/#40
- **Replace 2 raw `Buffer.from(JSON.stringify())` with `encodeJson`** · `redmine-server.ts` · trivial · #28
- **Reuse canonical `getMonthKey()` (delete 2 copies)** · `monthly-schedule.ts`, `my-time-entries-tree.ts`, `capacity-calculator.ts` · trivial · #63
- **Import shared `escapeHtml` in gantt-drag.js** · `gantt-drag.js` · trivial · #9
- **Drop/complete `@deprecated` tags on live API** · `redmine-server.ts` · trivial · #68
- **Move `docs/plan.md` to archive** · `docs/plan.md` · trivial · #55

### Near-term (small/medium)
- **Add commandPalette `when:false` for 36 leaking commands** · `package.json` · small · #56
- **Reuse CI VSIX artifact (or add size check) in release** · `release.yml` · small · #41
- **Add size check + duplicate-removal via composite action** · `ci.yml`, `release.yml` · small · #38/#39
- **Extract `patchIssue()` helper for single-field PUTs** · `redmine-server.ts` · small · #25
- **Consolidate weekday-key array + `getDayName` to one module** · `flexibility-calculator.ts`, `capacity-calculator.ts`, `gantt-html-generator.ts` · small · #1
- **Centralize server-options assembly into one helper** · `configured-command-registrar.ts`, `configured-context-updater.ts`, `extension.ts` · small · #19
- **Move `RedmineServerConnectionOptions` to interface (break cycle)** · `redmine-server.ts`, `redmine-server-interface.ts` · small · #18
- **Add guarded typed `_postMessage` to gantt; route 22 sites** · `gantt-panel.ts` · small · #7
- **Promote/delete dead `redmine-api.ts` fixture; share `createMockRequest`** · `test/fixtures/`, 3 redmine tests · small · #46
- **Extract `mockStatefulSettingsArray()` test helper** · 4 tracker tests · small · #47
- **Centralize kanban state keys/defaults; rename off `timer.*`** · `kanban/*` · small · #62
- **Extract `baseOpts` factory for esbuild contexts** · `esbuild.cjs` · small · #32
- **Define one `RedmineUser` interface (remove 5 inline copies)** · `redmine-server.ts`, `-interface.ts` · small · #27
- **Dedup logger hook bodies via `resolveMetadata()`** · `logging-redmine-server.ts` · small · #29
- **Share commit-msg length rules between hook & validator** · `scripts/commit-msg`, `scripts/validate-commits.sh` · small · #43
- **Add typed config accessor layer** · ~6 files · medium · #3
- **Extract `eachWorkingDay` iterator; funnel schedule sums** · 4 files · medium · #2
- **Extract shared webview HTML/CSP helper** · both panels · medium · #5
- **Extract `GanttRelationController`** · `gantt-panel.ts` · medium · #13
- **Move date-marker/tooltip helpers out of GanttPanel** · `gantt-panel.ts` → `gantt/` · medium · #12
- **Split `kanban-commands.ts` into 4 family registrars** · `kanban-commands.ts` · medium · #15
- **Move gantt-only calculators out of `utilities/` into `gantt/`** · 4 files · medium · #23
- **Add `BaseStatusBar`; standardize `implements Disposable`** · 3 status-bar files · small · #66
- **Extract shared live-search QuickPick scaffold** · `issue-picker.ts`, `kanban-dialogs.ts` · medium · #64
- **Unify relation-type label map** · 3 files · small · #61
- **Move serializer registration to a `gantt-commands.ts`** · `extension.ts` · medium · #8

### Larger refactors (high effort, do incrementally)
- **Extract `BaseWebviewPanel`** mirroring `BaseTreeProvider` · both panels · large · #4
- **Extract `buildRenderPayload()` pure function from `_getRenderPayload`** · `gantt-panel.ts` · large · #11
- **Split `RedmineServer` transport from endpoints; consolidate caches** · `redmine-server.ts` · large · #14/#31
- **Introduce `AppContext`/`IssueDataService`; demote `ProjectsTree` to a View** · `extension.ts`, trees · large · #16/#21
- **Lint/typecheck the 11 webview `.js` files (or migrate to `.ts`)** · eslint/tsconfig · large · #35
- **Standardize one webview message envelope** · both panels · large · #6
- **Resolve MVC framing: pick commands-orchestrate OR migrate to controllers** · docs + commands · medium · #17
- **Move `configured-context-updater` out of `utilities/`; invert `tree-item-factory` dep** · #20

## Findings

### DRY — schedule & date math
- **capacity-calculator reimplements the single-owner remaining-work heuristic (drifted)** · medium·small · `capacity-calculator.ts`, `remaining-work.ts`, `flexibility-calculator.ts` · Replace `calculateRemainingWork` body with `remainingHours(...)`, coalescing null→0. (#0)
- **Weekday key array duplicated 4× across 3 files + identical day-name helper** · medium·small · `flexibility-calculator.ts`, `capacity-calculator.ts`, `gantt-html-generator.ts` · Export one `DAY_KEYS`/`getDayName` and import everywhere. (#1)
- **Per-day schedule-summation loop copy-pasted 4+ times with inconsistent UTC handling** · medium·medium · `gantt-html-generator.ts`, `capacity-calculator.ts`, `monthly-schedule.ts`, `flexibility-calculator.ts` · Extract `eachWorkingDay(start,end,schedule,cb)`; funnel simple sums through `countAvailableHours`. (#2)
- **Month-key (`YYYY-MM`) formatter reimplemented 3× despite canonical `getMonthKey()`** · low·trivial · `monthly-schedule.ts`, `my-time-entries-tree.ts`, `capacity-calculator.ts` · Reuse `getMonthKey`; delete copies. (#63)

### DRY — webview & client
- **Client HTML escaper re-inlined in `gantt-drag.js`** · low·trivial · `gantt-drag.js`, `gantt-html-escape.ts` · Import shared `escapeHtml`; delete local `esc`. (#9)
- **Client `escapeHtml` re-inlined in draft-review webview** · low·small · `draft-review-panel.ts`, `gantt-html-escape.ts` · Ship one canonical escaper snippet to all webviews. (#65)
- **Relation-type label map duplicated across 3 files (drifted)** · low·small · `tree-item-factory.ts`, `gantt-panel.ts`, `gantt-drag.js` · Define one `RELATION_TYPE_LABELS`; pass labels into the gantt payload. (#61)

### DRY — Redmine API layer
- **Single-field issue PUT + invalidate pattern copy-pasted 5×** · medium·small · `redmine-server.ts` · Add private `patchIssue(id, fields)` and delegate. (#25)
- **URL-length comma-batching loop duplicated (drifted guards)** · medium·medium · `redmine-server.ts` · Extract `chunkIdsByUrlLength`/`fetchByIdBatches`. (#26)
- **Current-user shape typed inline 5×** · low·small · `redmine-server.ts`, `redmine-server-interface.ts` · Define `interface RedmineUser`. (#27)
- **2 mutations bypass `encodeJson` with raw `Buffer.from`** · low·trivial · `redmine-server.ts` · Use `this.encodeJson(...)`. (#28)
- **Logger `onResponseSuccess`/`onResponseError` ~95% identical** · low·small · `logging-redmine-server.ts` · Extract `resolveMetadata()`. (#29)

### DRY — config, server construction & tests
- **~20 scattered vscode config reads, no typed accessor** · low·medium · gantt-panel, view-commands, flexibility-calculator, monthly-schedule-commands, command-guards, context-proxy-commands · Introduce a typed `config.ts`. (#3)
- **Server-options assembly duplicated across 2 construction sites** · medium·small · `configured-command-registrar.ts`, `configured-context-updater.ts`, `extension.ts` · One `buildServerOptionsFromConfig` helper. (#19)
- **Dead shared HTTP-mock fixture while 3 tests hand-roll scaffolding** · low·small · `test/fixtures/redmine-api.ts` + 3 redmine tests · Promote the fixture or delete it; share `createMockRequest`. (#46)
- **Inline `vi.mock("vscode")` config-stub duplicated across 4 tracker tests** · low·small · adhoc/config-id-set/precedence/auto-update tracker tests · Extract `mockStatefulSettingsArray()`. (#47)
- **Kanban state under stale `redmyne.timer.*` namespace, ~14 literal keys + repeated defaults** · medium·small · `kanban-commands.ts`, `kanban-setup.ts`, `kanban-status-bar.ts`, `kanban-timer-handlers.ts` · Centralize `KANBAN_KEYS`/`KANBAN_DEFAULTS`; consider migration. (#62)
- **Commit-message length rules duplicated between hook & CI validator (drifted)** · low·small · `scripts/commit-msg`, `scripts/validate-commits.sh` · Share one validator script. (#43)

### Webview structure
- **No shared `BaseWebviewPanel`: lifecycle boilerplate duplicated** · medium·large · both panels, `base-tree-provider.ts` · Extract `shared/base-webview-panel.ts` mirroring `BaseTreeProvider`. (#4)
- **getNonce + CSP + HTML scaffold reimplemented per panel (CSP drifted)** · medium·medium · both panels, `webview-nonce.ts` · Add `utilities/webview-html.ts`; reconcile `img-src`/`script-src`. (#5)
- **Divergent message envelope: gantt `{command}` vs timesheet `{type}`** · low·large · the 4 message/index files · Standardize on one discriminant + shared envelope type. (#6)
- **Gantt posts via 22 raw `postMessage`; timesheet centralizes through guarded `_postMessage`** · low·small · both panels · Add guarded typed `_postMessage` to gantt; route all sites. (#7)
- **Serializer registration wired inconsistently (gantt inline, timesheet in commands module)** · low·medium · `extension.ts`, `timesheet-commands.ts` · Add `gantt-commands.ts`; move gantt serializer out of the root. (#8)

### God-files
- **`GanttPanel._getRenderPayload` ~836 LOC mixing state mutation + map building + geometry** · medium·large · `gantt-panel.ts` · Extract pure `buildRenderPayload(state, deps)`; push field mutations to caller. (#11)
- **`_generateDateMarkers` (~248 LOC) + tooltip builders wedged into panel** · medium·medium · `gantt-panel.ts` · Move to `gantt/gantt-date-markers.ts` and `gantt-html-generator.ts`. (#12)
- **Relation CRUD (~354 LOC) is a self-contained collaborator in the panel** · medium·medium · `gantt-panel.ts` · Extract `GanttRelationController`. (#13)
- **`RedmineServer` fuses transport/concurrency/caching with ~50 endpoints (1788 LOC)** · medium·large · `redmine-server.ts` · Extract `RedmineHttpClient`; split endpoint modules; facade delegates. (#14)
- **`redmine-server.ts` co-locates 6 caching strategies + transport + endpoints** · low·large · `redmine-server.ts` · Incrementally consolidate read-through caches behind `cachedFetch`. (#31)
- **`kanban-commands.ts` is a 900-LOC registration function spanning 4 families** · medium·medium · `kanban-commands.ts` · Split into task/timer/config/filter-sort registrars. (#15)

### Layering & coupling
- **`ProjectsTree` is a de-facto service locator; 52 callbacks in `activate()`** · medium·large · `extension.ts`, `gantt-commands.ts`, `projects-tree.ts` · Introduce `AppContext`/`IssueDataService`; pass slices, not lambdas. (#16)
- **MVC claim aspirational: `controllers/` near-empty, commands call server directly** · medium·medium · `issue-controller.ts`, `domain.ts`, `issue-context-commands.ts`, `draft-mode-commands.ts`, `ARCHITECTURE.md` · Drop the MVC framing or commit to the layer. (#17)
- **Import cycle: `redmine-server` ↔ `redmine-server-interface`** · medium·small · both files · Move `RedmineServerConnectionOptions` into the interface/types module. (#18)
- **Layering inversion: `utilities/` imports `trees/` + `draft-mode/` + `commands/`** · medium·medium · `configured-context-updater.ts`, `tree-item-factory.ts` · Move the orchestrator to `composition/`; invert the factory dep. (#20)
- **`ProjectsTree.server`/`MyTimeEntriesTree.server` are public mutable global server source** · medium·medium · both trees, `extension.ts` · Make private behind `setServer`; add a `ServerProvider`. (#21)
- **Gantt domain logic (~2,041 LOC) in generic `utilities/` with a single gantt consumer** · low·medium · capacity/hierarchy/dependency-graph/project-health, `webviews/gantt/` · Move into `webviews/gantt/`; leave `flexibility-calculator` shared. (#23)
- **Org-specific role names hardcoded in `domain.ts` `ROLE_ORDER`** · low·trivial · `domain.ts` · Lift to a setting or document as a deliberate default. (#67)

### Build & bundling
- **5 esbuild contexts duplicate identical option blocks** · low·small · `esbuild.cjs` · Extract `baseOpts` + a target factory/table. (#32)
- **`.vscodeignore` lists nonexistent `esbuild.js`** · low·trivial · `.vscodeignore` · Delete the line. (#33)
- **`@vscode/vsce` used via npx but absent from devDependencies (unpinned)** · medium·trivial · `package.json`, both workflows · Pin it; call `vsce` directly. (#34)
- **11 browser `.js` webview files excluded from both eslint and tsc** · medium·large · `eslint.config.mjs`, `tsconfig.json`, both `index.js` · Lint with a browser-globals block and/or migrate to `.ts`. (#35)
- **CLAUDE.md F5-spawns-`esbuild --watch` note stale vs launch.json** · low·small · `CLAUDE.md`, `.vscode/launch.json` · Restore a watch preLaunchTask or fix the note. (#36)

### CI & release
- **checkout+setup-node+npm ci duplicated across 4 jobs** · low·small · `ci.yml`, `release.yml` · Extract a composite action. (#38)
- **Node version hardcoded in 4 places; drifts from `engines`** · low·trivial · both workflows, `package.json` · Single source of truth; test the floor or raise `engines`. (#39)
- **No concurrency cancellation on either workflow** · low·trivial · both workflows · Add `concurrency` (cancel PR runs; don't cancel publish). (#40)
- **250KB size gate in CI but not in release publish** · low·small · both workflows · Reuse CI VSIX artifact or duplicate the check before publish. (#41)

### Manifest
- **36 context-only commands leak into the global palette** · medium·small · `package.json` · Add `when:"false"` palette entries (or generate them at build). (#56)
- **`redmyne.additionalHeaders` read by code but undeclared in configuration** · low·trivial · `package.json` + 3 readers · Add the property to `contributes.configuration`. (#57)
- **Gantt/sidebar command-twins double manifest command + submenu blocks** · medium·medium · `package.json`, `context-proxy-commands.ts` · Make commands accept either id shape; reuse one submenu via `when`. (#58)
- **`category` applied to only 2 of 160 commands** · low·small · `package.json` · Standardize on one convention. (#59)

### Documentation
- **ARCHITECTURE.md documents deleted `src/timer/` directory** · medium·trivial · `ARCHITECTURE.md` · Delete the tree entry and Timer section (or relocate under Kanban). (#49)
- **ARCHITECTURE.md version header stale (v4.19.1 / VS Code ≥1.105.0)** · low·trivial · `ARCHITECTURE.md`, `package.json` · Update or drop the version stamp. (#50)
- **ARCHITECTURE.md test config wrong (60% target, `isolate:false`)** · medium·trivial · `ARCHITECTURE.md`, `vitest.config.ts` · Fix to 88/78/72/88 and `isolate:true`. (#51, #45)
- **ARCHITECTURE.md describes the 48-file `utilities/` as one "Helpers" bucket** · low·trivial · `ARCHITECTURE.md` · Add sub-group map + placement rule. (#24)
- **ARCHITECTURE.md omits timesheet webview (2nd-largest file)** · medium·small · `ARCHITECTURE.md`, `timesheet-panel.ts` · Add timesheet to the webviews tree + a Key-Components entry. (#10, #54)
- **ARCHITECTURE.md RedmineServer description stale (pagination + caching)** · low·trivial · `ARCHITECTURE.md`, `redmine-server.ts`, `change-aware-cache.ts` · Describe batched pagination + change-aware cache. (#30)
- **ARCHITECTURE.md build/bundling coverage is one line** · low·small · `ARCHITECTURE.md` · Add a Build/Bundling section (5 targets, media split, prepublish, size gate). (#37)
- **ARCHITECTURE.md understates where commands are registered** · low·trivial · `ARCHITECTURE.md` · Document registrar modules + twin/`when:false` conventions. (#60)
- **CI/release workflows undocumented; AGENTS.md commit convention wrong** · low·small · `ARCHITECTURE.md`, `AGENTS.md` · Add a CI/CD subsection; fix AGENTS.md commit types. (#42)
- **AGENTS.md lists deleted `src/timer/` as a feature area** · low·trivial · `AGENTS.md` · Remove it; add `controllers/`+`draft-mode/`. (#52)
- **AESTHETIC_USABILITY_ANALYSIS.md cites 3 deleted `src/timer/` files** · low·small · `AESTHETIC_USABILITY_ANALYSIS.md` · Remap to `src/kanban/` or archive. (#53)
- **`docs/plan.md` is a stale v3.6.0 "Phase 2" artifact** · low·trivial · `docs/plan.md` · Move to `docs/archive/`. (#55)
- **`@deprecated` tags mislabel the live `getIssuesAssignedToMe`/`getAllOpenIssues` API** · low·trivial · `redmine-server.ts`, `issue-picker.ts`, `list-open-issues-assigned-to-me.ts` · Complete the migration or drop the tags. (#68)

### Test infra
- **Stale coverage exclusion `src/timer/**`** · low·trivial · `vitest.config.ts` · Delete the entry; add a zero-match-glob CI guard. (#44)
- **vscode-mock QuickPick simulator over-clever/brittle** · low·medium · `test/mocks/vscode.ts` · Leave as-is; if touched, move accept/Back logic into a test-local driver. (#48)

### Structure (cross-cutting)
- **3 status-bar classes duplicate lifecycle; one omits `Disposable`** · low·small · kanban/draft-mode/workload status bars · Add `BaseStatusBar`; standardize `implements Disposable`. (#66)
- **Live-search QuickPick scaffolding duplicated (debounce drifted 250 vs 300)** · medium·medium · `issue-picker.ts`, `kanban-dialogs.ts` · Extract `pickIssueViaLiveSearch`; unify the constant. (#64)

## What's already good

- **Documented single-owner heuristics.** `remaining-work.ts` is an explicit, well-commented sole owner of the "work left" rule, correctly consumed by `flexibility-calculator` and the gantt generator — the one holdout (capacity) is the exception that proves the pattern works. Preserve this and finish enforcing it.
- **Hook-based decorators and drift-proof passthrough.** `LoggingRedmineServer` overrides only 3 protected hooks (not a re-list trap), and `DraftModeServer`'s passthrough list is guarded by `satisfies readonly (keyof IRedmineServer)[]` so it cannot silently drift. Do not refactor these.
- **Established base-class precedent.** `shared/base-tree-provider.ts` already proves the abstract-base pattern for paired providers — the blueprint for the proposed `BaseWebviewPanel` and `BaseStatusBar` exists in-repo.
- **Clean DI seams.** `IRedmineServer` is a real dependency seam that Draft/Logging servers slot into; HTTP is mocked via injected `requestFn` rather than module mocks; `register*Commands` take explicit deps objects.
- **Well-factored trackers and solid extractions.** The four config trackers share a clean `config-id-set-tracker` base (20–40 LOC of naming sugar each); `paginate`/`getChangeAwareCached`/`normalizeServerUrl`/`getNonce`/`getWeeklySchedule` are all properly centralized.
- **Strong, modern infra.** Strict `tsconfig`, flat eslint config, vitest mirroring `src/` (128 files, 121 served by one alias mock), cross-platform CI matrix, an enforced 250KB size gate, fully-automated tag-triggered dual-store release, and the correctly-enforced media generated-vs-vendored split.