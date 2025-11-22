# Lessons Learned

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
- tsconfig: exclude test/, *.config.ts, *.cjs from rootDir
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
