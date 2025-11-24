# Lessons Learned

## Code Quality Assessment (2025-11-24)

### Error Handling

**Use errorToString() utility**

- Don't cast errors with `reason as string` - fails if error is object
- Import and use `errorToString()` from utilities for safe conversion
- Handles: Error instances, strings, objects with message property

**Don't swallow errors silently**

- `catch (_error) { /* empty */ }` hides failures from users
- At minimum show error message: `catch (e) { showErrorMessage(errorToString(e)) }`

### Network Resilience

**Add request timeouts**

- HTTP requests without timeout can hang indefinitely
- Add `clientRequest.setTimeout(30000, ...)` to prevent UI freeze
- Check if `setTimeout` exists before calling (mocks may not have it)

### Code Deduplication

**Export shared utilities**

- If same function exists in multiple files, export from one and import
- Example: `countWorkingDays`, `countAvailableHours` were in 2 files
- Centralizing adds caching benefits (memoization in one place)

**Don't dedupe prematurely**

- Similar code may have different requirements (type strictness, locale handling)
- `WeeklySchedule` in tree uses `Record<string, number>` for VS Code config compat
- `WeeklySchedule` in calculator uses strict day-name type for internal logic

### Git Hooks

**Auto-install via prepare script**

- Add `"prepare": "bash scripts/install-hooks.sh"` to package.json
- Runs after `npm install`, ensuring hooks are always installed
- Script should exit 0 silently if not in git repo (for CI)

## v3.0.0 Modernization (2025-11-22)

### TypeScript 5.7 Migration

**EventEmitter Type Safety**

- Use `EventEmitter<void>` for events with no payload data
- Calling `fire()` without args requires `void` type, not `T | undefined`
- VS Code TreeDataProvider refresh events typically use `void`

**URL Migration (url.parse � new URL)**

- `new URL()` throws on invalid URLs - wrap in try/catch
- `url.port` returns string, not number - use `parseInt(url.port, 10)`
- `url.host` includes port, use `url.hostname` for host only
- Test edge cases: URLs with/without ports, paths, protocols

**HTTP Headers Type Safety**

- `OutgoingHttpHeaders | readonly string[]` union needs type assertion
- Safe when headers initialized as object: `as OutgoingHttpHeaders`
- Alternative: use `!Array.isArray()` type guard (doesn't narrow correctly in TS 5.7)

**Command Registration with Rest Parameters**

- Use `...args: any[]` instead of `...args: unknown[]` for flexibility
- Destructured params in arrow functions don't type-check well with rest params
- Accept `Promise<void>` for async commands

### Testing Strategy

**Vitest over Jest**

- Faster, better ESM support, simpler config
- MSW 2.x doesn't support native Node.js http/https - use vitest mocks instead
- Coverage target 60% realistic for VS Code extensions (exclude UI-heavy code)

**Test Organization**

- Unit: Pure logic (RedmineServer, domain models, utilities)
- Exclude: extension.ts, tree providers, commands (VS Code-dependent)
- Mock vscode module via vitest alias, not actual VS Code test environment

### Build Configuration

**esbuild + TypeScript 5.7**

- Rename esbuild.js � esbuild.cjs for CJS compatibility
- tsconfig: exclude test/, _.config.ts, _.cjs from rootDir
- Keep bundled output as CJS (`format: 'cjs'`) for VS Code compatibility
- ES2022 modules in source, CJS in bundle works fine

### VS Code Secrets API

**Key Storage**

- Hash URI to hex for storage key: `Buffer.from(uri.toString()).toString('hex')`
- Namespace keys: `redmine:${hash}:${field}:v1` for versioning
- Workspace-scoped: different keys per workspace folder
- No auto-migration - force manual setup to avoid security issues

**Error Handling**

- Secrets API fails silently on Linux without keyring - show clear error
- Check `secrets.get()` returns undefined before prompting user
- Listen to `onDidChange` to refresh trees when keys updated externally

### Deprecated APIs Removed

**ProgressLocation.Window**

- Replaced with `ProgressLocation.Notification` (Window removed in VS Code 1.85+)
- 4 files affected (commands with progress UI)

**activationEvents**

- No longer required in package.json (VS Code infers from contributes)
- Remove entire section to reduce maintenance

**EventEmitter Disposal**

- Add `deactivate()` export to dispose EventEmitters
- Prevents memory leaks in development (extension reload)

### Dependencies

**Removed**

- lodash � native JS (`isNil` � `!= null`, `isEqual` � `JSON.stringify`)
- Bundle size reduced ~80KB
- No behavioral changes

**Updated**

- TypeScript 3.9.7 � 5.7.2 (5-year jump)
- @types/vscode 1.x � 1.96.0
- @types/node 12.x � 22.17.10

**Added**

- vitest, @vitest/coverage-v8, msw (dev only)

### Configuration

**Engines**

- vscode: ^1.85.0 (Secrets API minimum)
- node: >=20.0.0 (modern LTS)

**Breaking Changes**

- redmine.apiKey deprecated (use Secrets)
- Manual migration only (no auto-fallback to config)
- Users must run "Redmine: Set API Key" command

### Avoided Overengineering

**Rejected Patterns**

- Repository pattern (overkill for 1,135 LOC)
- Dependency injection container
- Mock repositories (use MSW/vitest mocks)
- Docker for E2E (use HTTP mocking)
- 80%+ coverage target (60% realistic)

**Kept Simple**

- Direct RedmineServer usage (no abstraction layer)
- Vitest mocks over MSW for Node.js http
- Minimal test fixtures
- Pragmatic type assertions over complex type guards

### CI/CD

**GitHub Actions**

- lint � typecheck � test � coverage check � codecov
- Fail on <60% coverage
- Node 20.x only (no matrix)
- Cache npm for speed

### Documentation

**Migration Guide**

- Quick start (4 steps)
- Manual migration only
- Troubleshooting table
- Breaking changes summary

**No Auto-Migration**

- Security risk (plaintext config � encrypted secrets)
- Force explicit user action
- Clear error messages pointing to command

## v3.0.1 UX Improvements (2025-11-22)

### Tree Refresh Guards

**Problem**: Dozens of fetch requests when extension not configured
**Solution**: Guard tree refresh with server existence check

- Only fire `onDidChangeTreeData` when server set
- Clear server from trees when config removed
- Call `updateConfiguredContext()` from event listeners instead of direct refresh

### Configuration Change Handling

**onDidChangeConfiguration**

- Listen for `affectsConfiguration('redmine')` events
- Re-run `updateConfiguredContext()` to sync state
- Automatically clear/set servers in trees

### SVG External DTD Fetch Spam

**Problem**: 50+ simultaneous `GET "<URL>"` fetches when extension loads
**Root Cause**: `logo.svg` contained external DTD/entity references

```xml
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
  <!ENTITY ns_svg "http://www.w3.org/2000/svg">
  <!ENTITY ns_xlink "http://www.w3.org/1999/xlink">
]>
```

**Solution**: Removed XML declaration, DOCTYPE, and entity declarations

- Replaced `xmlns="&ns_svg;"` with direct URI
- Replaced `xmlns:xlink="&ns_xlink;"` with direct URI
- Reduced size from 2.28 KB to 1.98 KB
  **Investigation**: Subagent traced fetches to browser attempting DTD resolution on every SVG parse
  **Note**: Fetches persisted with extension disabled → Positron/browser cache issue, not extension bug

## Key Takeaways

1. **TDD works**: Write tests first caught URL edge cases early
2. **TypeScript strict mode**: Catches real bugs (null checks, type assertions)
3. **Simple > clever**: Native JS > lodash, mocks > MSW
4. **60% coverage realistic**: Don't test VS Code UI integration without real env
5. **Breaking changes OK**: Security/modernization justifies v3.0.0 bump
6. **No auto-migration**: Explicit user action better for security
7. **Vitest fast**: 46 tests in 1.17s
8. **Parallel agents**: 5 phases in 2 hours (vs 3 weeks estimate)
9. **Guard tree refreshes**: Check server exists before firing events
10. **SVG DTD spam**: External entity refs in SVG cause browser fetch spam - use inline namespaces
11. **Isolate issues**: Disable extension to prove source - if persists, not extension's bug

## v3.0.3 Modernization (2025-11-23)

### Async/Await Refactoring

**Pattern Consistency**
- Replaced 10+ `.then()` chains with async/await in IssueController
- Standardized promise handling in RedmineServer (3 methods)
- Reduced code from 283→264 lines in issue-controller.ts (-19 lines)
- Improved readability with linear flow vs nested callbacks

**Subagent Coordination**
- Used parallel subagents for complex refactoring tasks
- Each subagent focused on single file/concern
- Verified compilation after each change (npx tsc --noEmit)
- All 46 tests passed - no behavior changes

### TypeScript Strictness

**noUnusedLocals/Parameters/ImplicitReturns**
- Found unused `server` param in RedmineProject constructor
- Removed unused code per CLAUDE.md (no backwards-compat hacks)
- Breaking change acceptable for internal API
- Constructor: `(server, options)` → `(options)` - simpler

**ESLint ecmaVersion**
- 2020→2023 for Node 20+ syntax (optional chaining, nullish coalescing, top-level await)
- Aligned with package.json engine requirement

### Build Scripts

**Developer Experience**
- Added `npm run typecheck` for explicit TS validation
- Added `npm run clean` for artifact cleanup
- Added `npm run ci` for full validation pipeline
- Enables local pre-commit checks matching CI

### Lessons

1. **Delete unused code**: Don't prefix with `_` - remove entirely per CLAUDE.md
2. **Async/await > .then()**: Easier to read, debug, maintain
3. **Subagents scale**: Parallel refactoring faster than manual
4. **Strict TS catches issues**: noUnusedLocals found dead code
5. **Test coverage validates**: 75.56% coverage confirmed no regressions

## v3.0.4 Bug Fix (2025-11-23)

### Package.json "type": "module" Conflict

**Problem**: Extension failed to activate with error: `module is not defined in ES module scope`

**Root Cause**:
- package.json had `"type": "module"` (line 8)
- esbuild.cjs outputs CJS (`format: 'cjs'`)
- Node.js treated bundled output as ESM due to package.json setting
- CJS code (`module.exports`) invalid in ESM context

**Solution**: Remove `"type": "module"` from package.json

**Why It Existed**: Likely added during TypeScript 5.7 migration for source ESM support, but unnecessary - TS/esbuild handle module resolution independently

**Key Insight**:
- package.json `"type"` affects bundled output, not source code
- VS Code extensions require CJS output (per LESSONS_LEARNED.md:52)
- Source can use ESM (import/export) while bundle outputs CJS
- NEVER add `"type": "module"` when bundling to CJS

### Lessons

1. **package.json type affects runtime**: `"type": "module"` changes how Node.js interprets bundled .js files
2. **Match type to bundle format**: CJS bundle = no type field (or `"type": "commonjs"`)
3. **Source ≠ output format**: TypeScript source can be ESM even with CJS output
4. **Verify extension loads**: Test activation after package.json changes

## v3.0.6 Git Hooks (2025-11-23)

### Commit Message Validation Hook

**Problem**: CI checks commit messages but gives no immediate feedback to agentic AI

**Solution**: Pre-commit hook validates before commit completes

**Implementation**:
- `scripts/commit-msg`: Bash hook validates subject ≤ 50 chars, body ≤ 72 chars
- `scripts/install-hooks.sh`: Copies hook to `.git/hooks/`
- Tested with Vitest (7 tests, executes hook script)
- Exception handling for merge/revert commits

**Shell Script Gotchas**:
- `#!/bin/sh` vs `#!/usr/bin/env bash`: Process substitution `< <(...)` requires bash
- `wc -l` counts newlines, not lines: Use `grep -c ^` for reliable line counting
- `read -r` without newline: Use `while read -r line || [ -n "$line" ]` pattern
- Pipeline subshell: `tail | while` creates subshell, exit codes lost - use `< <(tail)`

**Testing Strategy**:
- Node.js tests (Vitest) execute bash script via `execSync`
- Test both success (exit 0) and failure (exit 1) cases
- Files without trailing newlines handled correctly
- 98 total tests pass (91 existing + 7 new)

**Benefits**:
- Immediate feedback (< 1s vs CI ~30s)
- Agentic AI learns from errors before push
- Reduces CI failures
- Enforces team conventions automatically

### Lessons

1. **Bash != POSIX sh**: Process substitution, arrays need `#!/usr/bin/env bash`
2. **wc -l misleading**: Counts newlines, fails on files without trailing newline
3. **read -r edge case**: Returns false on last line without newline - use `|| [ -n "$var" ]`
4. **Pipeline exit codes**: Subshell in `pipe | while` loses exit status - use process substitution
5. **Git hooks in repo**: Store in `scripts/`, install via script - can't track `.git/hooks/`
6. **Test shell scripts from Node**: `execSync` throws on non-zero exit - wrap in `expect(() => ...).toThrow()`
7. **Pre-commit > CI**: Hooks give faster feedback than CI checks (1s vs 30s)

## v3.2.0 MVP-2 Time Entry Viewing (2025-11-24)

### Module Mock Hoisting Timing Issues with Getters

**Problem**: Tests passed locally but failed in CI with empty arrays. RedmineServer methods returned `[]` instead of mocked data.

**Root Cause**: Module mock hoisting interacted poorly with getter pattern

```typescript
// src/redmine/redmine-server.ts
get request() {
  return this.options.url.protocol === "https:"
    ? https.request  // ← Evaluated at runtime, not import time
    : http.request;
}
```

**The Failure Sequence**:

1. Test file: `vi.mock("http")` hoisted to top
2. **CI Environment** (slower module resolution):
   - `import * as http` resolves → caches reference to **real** `http.request`
   - Mock applies too late → getter already captured unmocked version
   - Real `http.request` tries network calls → fails/times out → `doRequest` returns `null`
   - `response?.projects || []` correctly returns `[]`
   - Tests expecting data fail: `expect(result.issues).toHaveLength(1)` got `[]`

3. **Local Environment** (faster):
   - Mock applies → `import * as http` gets mocked version
   - Getter uses mocked `http.request` ✓

**Why It's Non-Deterministic**:
- Module cache timing varies by:
  - CPU speed
  - Parallel test execution
  - File system I/O
  - Node.js version
  - Import graph complexity

**The Fix - Dependency Injection**:

```typescript
// src/redmine/redmine-server.ts
export interface RedmineServerConnectionOptions {
  // ...
  requestFn?: typeof http.request; // ← Optional injected dependency
}

get request() {
  if (this.options.requestFn) {
    return this.options.requestFn; // ← Use injected mock
  }
  return this.options.url.protocol === "https:"
    ? https.request
    : http.request;
}
```

```typescript
// test/unit/redmine/redmine-server.test.ts
const createMockRequest = () => vi.fn(/* ... */);

beforeEach(() => {
  server = new RedmineServer({
    address: "http://localhost:3000",
    key: "test-api-key",
    requestFn: createMockRequest(), // ← Direct injection
  });
});
```

**Why DI Works**:
- No reliance on module mock hoisting order
- No dependency on import resolution timing
- No getter evaluation timing issues
- Explicit, deterministic, works in all environments
- Tests control exactly what code runs

**Alternative Failed Attempts**:

1. ❌ `queueMicrotask()` instead of `setTimeout()` in mock - didn't fix race
2. ❌ Removing custom mock tests - symptom not cause
3. ❌ Fixing mock endpoint paths - unrelated issue
4. ❌ Adding null checks with optional chaining - good practice but didn't fix root cause

### Lessons

1. **Avoid module mocking for stateful/getter patterns**: Hoisting timing is non-deterministic
2. **DI makes tests deterministic**: Explicit injection bypasses module resolution entirely
3. **Local pass ≠ CI pass**: Environment differences expose timing-dependent code
4. **Getters evaluated at runtime**: Unlike imports, getters don't benefit from hoisting
5. **Test robustness principle**: If it works differently in CI, the test is fragile
6. **Null safety hides symptoms**: `response?.projects || []` masked the real issue (null responses)
7. **Debug from first principles**: "Why would doRequest return null?" led to network call discovery

## v3.4.0 MVP-4 Status Bar (2025-11-24)

### Async Disposal Race Conditions

**Problem**: `TypeError: Cannot read property 'hide' of undefined` when status bar disposed during async fetch

**Root Cause**: Status bar reference captured before `await`, disposed by config change during fetch

```typescript
// BAD: Race condition
const statusBar = cleanupResources.workloadStatusBar;
const issues = await myIssuesTree.fetchIssuesIfNeeded(); // User toggles off during this
statusBar.hide(); // undefined!

// GOOD: Re-check after await
const issues = await myIssuesTree.fetchIssuesIfNeeded();
if (!cleanupResources.workloadStatusBar) return; // Disposed? Bail
cleanupResources.workloadStatusBar.hide(); // Safe
```

### Concurrent Fetch Prevention

**Problem**: Multiple rapid tree refreshes triggered dozens of API requests simultaneously

**Solution**: Promise deduplication pattern

```typescript
private pendingFetch: Promise<Issue[]> | null = null;

async fetchIssuesIfNeeded(): Promise<Issue[]> {
  if (this.cachedIssues.length > 0) return this.cachedIssues;
  if (this.pendingFetch) return this.pendingFetch; // Reuse in-flight

  this.pendingFetch = this.getChildren().then(issues => {
    this.pendingFetch = null;
    return issues;
  });
  return this.pendingFetch;
}
```

### Config Listener Filtering

**Problem**: Tree "blinks" when toggling status bar config

**Root Cause**: `event.affectsConfiguration("redmine")` matches ALL `redmine.*` changes, triggering unnecessary server reinit

```typescript
// BAD: Any redmine.* change triggers full reinit
if (event.affectsConfiguration("redmine")) {
  await updateConfiguredContext(); // Clears cache, causes blink
}

// GOOD: Filter out UI-only configs
if (
  event.affectsConfiguration("redmine") &&
  !event.affectsConfiguration("redmine.statusBar") &&
  !event.affectsConfiguration("redmine.workingHours")
) {
  await updateConfiguredContext();
}
```

**Insight**: Categorize configs as server-related (url, apiKey, headers) vs UI-only (statusBar, workingHours). Only server-related changes need reinit.

### Lessons

1. **Re-check state after await**: Async gaps allow external state changes
2. **Promise deduplication**: Prevent concurrent duplicate requests
3. **Config categorization**: UI-only vs server-related - different handling
4. **Event-driven > polling**: Subscribe to tree changes, not timers
5. **Opt-in patterns**: Default false for non-essential features
