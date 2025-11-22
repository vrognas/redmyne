# Positron-Redmine v3.0.0 Modernization Plan

**Version**: 3.0.0
**Status**: Ready for Implementation
**Breaking Changes**: YES (immediate hard cutoff)
**Estimated Duration**: 3 weeks (16 days)
**Last Updated**: 2025-11-22

---

## Context for New Session

**What**: Complete modernization of positron-redmine VS Code extension
**Why**: Security (Secrets API), compatibility (TS 5.7, VS Code 1.85+), maintainability
**How**: 5 phased TDD approach with MSW testing

**Current State**:
- 22 TypeScript files, 1,135 LOC
- TypeScript 3.9.7 (2020) - 5 years outdated
- No tests
- API keys in plaintext workspace config
- 9 security vulnerabilities

**Target State**:
- TypeScript 5.7, ESM modules
- API keys in VS Code Secrets (machine-local, encrypted)
- 60%+ test coverage with MSW
- 0 vulnerabilities
- Bundle size reduced 80KB (lodash removed)

---

## Design Principles

**Avoided Overengineering**:
- ❌ Repository pattern - overkill for 1,135 LOC
- ❌ Mock repositories - use MSW instead
- ❌ ServiceContainer/DI - unnecessary
- ❌ Docker E2E - use MSW for HTTP mocking
- ❌ Trivial language tests - focus on behavior

**Simplified**:
- 5 phases instead of 7
- Direct implementation over abstraction layers
- MSW for all HTTP testing
- Realistic 60% coverage (not 80%)

**Time**: 16 days (36% reduction from initial plan)

---

## Phase Overview

| Phase | Duration | Focus | TDD |
|-------|----------|-------|-----|
| 0 | 2 days | Foundation fixes | ✓ |
| 1 | 3 days | TypeScript 5.7 | ✓ |
| 2 | 3 days | ESM migration | ✓ |
| 3 | 4 days | Secrets API + VS Code modernization | ✓ |
| 4 | 3 days | Testing with MSW | ✓ |
| 5 | 1 day | Documentation & release | - |
| **Total** | **16 days** | **~3 weeks** | |

---

## Phase 0: Foundation Fixes (2 days)

### Step 0.1: Fix esbuild.js Null Access Bug

**Test First**:
```typescript
// test/unit/build/esbuild-error-handling.test.ts
describe('esbuild error handling', () => {
  it('should handle error with location', () => {
    const error = { text: 'Error', location: { file: 'a.ts', line: 1, column: 5 } };
    expect(formatError(error)).toBe('a.ts:1:5: Error');
  });

  it('should handle error without location', () => {
    const error = { text: 'Error', location: null };
    expect(formatError(error)).toBe('Error');
  });
});
```

**Then Fix**:
```javascript
// esbuild.js:40-45
build.onEnd((result) => {
  result.errors.forEach(({ text, location }) => {
    console.error(`✘ [ERROR] ${text}`);
    if (location) {
      console.error(`    ${location.file}:${location.line}:${location.column}:`);
    }
  });
});
```

---

### Step 0.2: Setup Vitest

**Install dependencies**:
```bash
npm install -D vitest@^2.1.0 @vitest/coverage-v8@^2.1.0 msw@^2.6.0
```

**Create vitest.config.ts**:
```typescript
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    alias: {
      vscode: resolve(__dirname, './test/mocks/vscode.ts'),
    },
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 60,  // Realistic target
        functions: 60,
        branches: 60,
        statements: 60,
      },
    },
    globals: true,
  },
});
```

**Create test/mocks/vscode.ts** (minimal mock):
```typescript
import { vi } from 'vitest';

export const window = {
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  withProgress: vi.fn((opts, task) => task({ report: vi.fn() })),
};

export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: vi.fn(),
    update: vi.fn(),
  })),
  workspaceFolders: [],
};

export const commands = {
  registerCommand: vi.fn(),
  executeCommand: vi.fn(),
};

export const Uri = {
  parse: (url: string) => ({ toString: () => url }),
};

export const EventEmitter = class {
  fire = vi.fn();
  event = vi.fn();
};

export const ProgressLocation = { Notification: 15 };
export const ConfigurationTarget = { WorkspaceFolder: 3 };
```

**Update package.json**:
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

---

### Step 0.3: Remove lodash

**Test** (unnecessary - native JS):
```bash
# Skip trivial tests, just replace
```

**Replace**:
```typescript
// src/trees/projects-tree.ts:60
// BEFORE: if (!isNil(projectOrIssue) && ...)
// AFTER:
if (projectOrIssue != null && projectOrIssue instanceof RedmineProject) {

// src/redmine/redmine-server.ts:85
// BEFORE: if (isNil(this.options.additionalHeaders))
// AFTER:
if (this.options.additionalHeaders == null) {

// src/redmine/redmine-server.ts:381
// BEFORE: isEqual(this.options.additionalHeaders, other.options.additionalHeaders)
// AFTER:
JSON.stringify(this.options.additionalHeaders) === JSON.stringify(other.options.additionalHeaders)
```

**Remove**:
```bash
npm uninstall lodash @types/lodash
```

---

## Phase 1: TypeScript 5.7 Migration (3 days)

### Step 1.1: Update Dependencies

```bash
npm install -D \
  typescript@^5.7.2 \
  @types/node@^22.17.10 \
  @types/vscode@^1.96.0
```

---

### Step 1.2: Fix url.parse() → new URL()

**Test First**:
```typescript
// test/unit/redmine/url-handling.test.ts
import { describe, it, expect } from 'vitest';

describe('URL handling', () => {
  it('should parse http URL', () => {
    const url = new URL('http://example.com');
    expect(url.protocol).toBe('http:');
    expect(url.hostname).toBe('example.com');
  });

  it('should parse URL with port', () => {
    const url = new URL('http://example.com:8080');
    expect(url.port).toBe('8080');
  });

  it('should parse URL with path', () => {
    const url = new URL('https://example.com:8443/redmine');
    expect(url.pathname).toBe('/redmine');
  });

  it('should throw on invalid URL', () => {
    expect(() => new URL('not-a-url')).toThrow();
  });
});
```

**Then Fix** (11 changes):

1. **src/redmine/redmine-server.ts:1** - Remove import:
```typescript
// DELETE: import { Url, parse } from "url";
```

2. **src/redmine/redmine-server.ts:47** - Update type:
```typescript
interface RedmineServerOptions {
  url: URL;  // Was: Url
}
```

3. **src/redmine/redmine-server.ts:72-77** - Update validation:
```typescript
let url: URL;
try {
  url = new URL(options.address);
} catch {
  throw new RedmineOptionsError(`Invalid URL: ${options.address}`);
}
if (!["https:", "http:"].includes(url.protocol)) {
  throw new RedmineOptionsError("Protocol must be http/https");
}
```

4. **src/redmine/redmine-server.ts:83** - Update setOptions:
```typescript
this.options = {
  ...options,
  url: new URL(options.address),
};
```

5. **src/redmine/redmine-server.ts:98-105** - Fix port handling:
```typescript
const options: https.RequestOptions = {
  hostname: url.hostname,
  port: url.port ? parseInt(url.port, 10) : undefined,
  path: `${url.pathname}${path}`,
  // ...
};
```

6-10. **4 command files** - Update display:
```typescript
// src/commands/{open-actions-for-issue,new-issue,commons/open-actions-for-issue-id,list-open-issues-assigned-to-me}.ts
// CHANGE: server.options.url.host
// TO: server.options.url.hostname
```

---

### Step 1.3: Fix Type Safety Issues

**Changes** (no trivial tests needed):

1. **src/extension.ts:44-49** - any → unknown:
```typescript
...args: unknown[]
): Promise<{ props?: ActionProperties; args: unknown[] }>
```

2. **src/extension.ts:146** - Remove non-null assertion:
```typescript
if (props) {
  action(props, ...args);
}
```

3. **src/utilities/error-to-string.ts:13** - Better typing:
```typescript
(error as { message?: string })?.message ??
```

4. **src/redmine/redmine-server.ts:55** - Initialize:
```typescript
options: RedmineServerOptions = {} as RedmineServerOptions;
```

5. **src/redmine/redmine-server.ts:109-110** - Type guard:
```typescript
if (options.headers) {
  options.headers["Content-Length"] = data.length;
  options.headers["Content-Type"] = "application/json";
}
```

6. **src/redmine/redmine-server.ts:143** - statusCode check:
```typescript
if (statusCode && statusCode >= 400) {
```

7. **src/controllers/issue-controller.ts:55-56** - Input validation:
```typescript
if (!input) {
  vscode.window.showErrorMessage('Time entry input required');
  return;
}
const hours = input.substring(0, indexOf);
```

8. **src/trees/projects-tree.ts:62** - Null check:
```typescript
const subprojects = (this.projects ?? []).filter(...)
```

---

### Step 1.4: Update tsconfig.json

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "node",
    "outDir": "out",
    "rootDir": "src",
    "sourceMap": true
  }
}
```

---

## Phase 2: ESM Migration (3 days)

### Step 2.1: Update Build Configuration

**tsconfig.json**:
```json
{
  "compilerOptions": {
    "module": "ES2022",
    "moduleResolution": "bundler",
    // ... rest unchanged
  }
}
```

**Rename esbuild.js → esbuild.cjs**:
```javascript
// Keep CJS output for compatibility
const esbuild = require('esbuild');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs', // Keep CJS initially
    minify: production,
    sourcemap: !production,
    platform: 'node',
    outfile: 'out/extension.js',
    external: ['vscode'],
    plugins: [esbuildProblemMatcherPlugin],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

// Fixed problem matcher (from Phase 0)
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log('[watch] build finished');
    });
  },
};

main().catch(e => {
  console.error(e);
  process.exit(1);
});
```

**package.json**:
```json
{
  "main": "./out/extension.js",
  "scripts": {
    "compile": "node esbuild.cjs --production",
    "watch": "node esbuild.cjs --watch"
  }
}
```

---

### Step 2.2: Test Extension Activation

**Manual test** (no automated test needed):
1. Run `npm run compile`
2. Press F5 in VS Code
3. Verify extension activates
4. Test all commands

---

## Phase 3: Secrets API + VS Code Modernization (4 days)

### Step 3.1: Create SecretManager Utility

**Test First**:
```typescript
// test/unit/utilities/secret-manager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { RedmineSecretManager } from '../../../src/utilities/secret-manager';

describe('RedmineSecretManager', () => {
  let context: vscode.ExtensionContext;
  let manager: RedmineSecretManager;

  beforeEach(() => {
    context = {
      secrets: {
        get: vi.fn(),
        store: vi.fn(),
        delete: vi.fn(),
        onDidChange: vi.fn(),
      },
    } as unknown as vscode.ExtensionContext;

    manager = new RedmineSecretManager(context);
  });

  it('should store API key', async () => {
    const uri = vscode.Uri.parse('file:///home/user/project');
    await manager.setApiKey(uri, 'test-key-123');

    expect(context.secrets.store).toHaveBeenCalledWith(
      expect.stringContaining('redmine:'),
      'test-key-123'
    );
  });

  it('should retrieve API key', async () => {
    const uri = vscode.Uri.parse('file:///home/user/project');
    vi.mocked(context.secrets.get).mockResolvedValue('test-key-123');

    const key = await manager.getApiKey(uri);
    expect(key).toBe('test-key-123');
  });
});
```

**Then Implement**:
```typescript
// src/utilities/secret-manager.ts
import * as vscode from 'vscode';

export class RedmineSecretManager {
  constructor(private context: vscode.ExtensionContext) {}

  private buildKey(folderUri: vscode.Uri, field: string): string {
    const encoded = Buffer.from(folderUri.toString()).toString('hex');
    return `redmine:${encoded}:${field}:v1`;
  }

  async getApiKey(folderUri: vscode.Uri): Promise<string | undefined> {
    const key = this.buildKey(folderUri, 'apiKey');
    try {
      return await this.context.secrets.get(key);
    } catch (err) {
      console.error('Failed to retrieve API key:', err);
      return undefined;
    }
  }

  async setApiKey(folderUri: vscode.Uri, apiKey: string): Promise<void> {
    const key = this.buildKey(folderUri, 'apiKey');
    await this.context.secrets.store(key, apiKey);
  }

  async deleteApiKey(folderUri: vscode.Uri): Promise<void> {
    const key = this.buildKey(folderUri, 'apiKey');
    await this.context.secrets.delete(key);
  }

  onSecretChanged(callback: (key: string) => void): vscode.Disposable {
    return this.context.secrets.onDidChange((event) => {
      if (event.key.startsWith('redmine:')) {
        callback(event.key);
      }
    });
  }
}
```

---

### Step 3.2: Create Set API Key Command

**Test**:
```typescript
// test/unit/commands/set-api-key.test.ts
describe('setApiKey command', () => {
  it('should prompt for API key', async () => {
    // Mock showInputBox
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('test-key');

    await setApiKey(mockContext);

    expect(vscode.window.showInputBox).toHaveBeenCalled();
  });
});
```

**Implement**:
```typescript
// src/commands/set-api-key.ts
import * as vscode from 'vscode';
import { RedmineSecretManager } from '../utilities/secret-manager';

export async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const secretManager = new RedmineSecretManager(context);

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  const folder = folders.length === 1
    ? folders[0]
    : await vscode.window.showWorkspaceFolderPick();

  if (!folder) return;

  const apiKey = await vscode.window.showInputBox({
    prompt: `Enter Redmine API Key for ${folder.name}`,
    password: true,
    validateInput: (value) => {
      if (!value) return 'API key cannot be empty';
      if (value.length < 20) return 'API key appears invalid';
      return null;
    }
  });

  if (!apiKey) return;

  await secretManager.setApiKey(folder.uri, apiKey);
  vscode.window.showInformationMessage(`API key for ${folder.name} stored securely`);
}
```

---

### Step 3.3: Update extension.ts for Secrets

```typescript
// src/extension.ts
import { RedmineSecretManager } from './utilities/secret-manager';

export function activate(context: vscode.ExtensionContext): void {
  const secretManager = new RedmineSecretManager(context);

  // Listen for secret changes
  context.subscriptions.push(
    secretManager.onSecretChanged(() => {
      projectsTree.onDidChangeTreeData$.fire();
      myIssuesTree.onDidChangeTreeData$.fire();
    })
  );

  // Register set API key command
  context.subscriptions.push(
    vscode.commands.registerCommand('redmine.setApiKey', () => setApiKey(context))
  );

  const parseConfiguration = async (
    withPick = true,
    props?: ActionProperties,
    ...args: unknown[]
  ): Promise<{ props?: ActionProperties; args: unknown[] }> => {
    if (!withPick) {
      return Promise.resolve({ props, args });
    }

    const pickedFolder = await vscode.window.showWorkspaceFolderPick();
    if (!pickedFolder) {
      return Promise.resolve({ props: undefined, args: [] });
    }

    const config = vscode.workspace.getConfiguration("redmine", pickedFolder.uri);

    // Try secrets first, fallback to config
    let apiKey = await secretManager.getApiKey(pickedFolder.uri);

    if (!apiKey) {
      apiKey = config.get<string>('apiKey');
      if (apiKey) {
        // Auto-migrate on first use
        await secretManager.setApiKey(pickedFolder.uri, apiKey);
        vscode.window.showInformationMessage('API key migrated to secure storage');
      } else {
        vscode.window.showErrorMessage('No API key configured. Run "Redmine: Set API Key"');
        return Promise.resolve({ props: undefined, args: [] });
      }
    }

    const redmineServer = new RedmineServer({
      address: config.url,
      key: apiKey,
      additionalHeaders: config.additionalHeaders,
      rejectUnauthorized: config.rejectUnauthorized,
    });

    // ... rest of parseConfiguration
  };
}
```

---

### Step 3.4: Remove Deprecated VS Code APIs

**Remove activationEvents from package.json**:
```json
{
  // DELETE ENTIRE SECTION
  // "activationEvents": [...]
}
```

**Replace ProgressLocation.Window** (4 files):
```typescript
// BEFORE
vscode.window.withProgress(
  { location: vscode.ProgressLocation.Window },

// AFTER
vscode.window.withProgress(
  { location: vscode.ProgressLocation.Notification },
```

**Add Resource Cleanup**:
```typescript
// src/extension.ts
export function deactivate(): void {
  myIssuesTree.onDidChangeTreeData$.dispose();
  projectsTree.onDidChangeTreeData$.dispose();
}
```

---

### Step 3.5: Update package.json Configuration

```json
{
  "version": "3.0.0",
  "engines": {
    "vscode": "^1.85.0",
    "positron": "^2025.06.0"
  },
  "contributes": {
    "commands": [
      {
        "command": "redmine.setApiKey",
        "title": "Redmine: Set API Key"
      }
    ],
    "configuration": {
      "properties": {
        "redmine.apiKey": {
          "type": "string",
          "description": "DEPRECATED: Use 'Redmine: Set API Key' command instead",
          "deprecationMessage": "API keys now stored in VS Code secrets. Run 'Redmine: Set API Key'",
          "scope": "resource"
        }
      }
    }
  }
}
```

---

## Phase 4: Testing with MSW (3 days)

### Step 4.1: Setup MSW for HTTP Mocking

**Create test fixtures**:
```typescript
// test/fixtures/redmine-api.ts
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const redmineHandlers = [
  http.get('http://localhost:3000/issues.json', () => {
    return HttpResponse.json({
      issues: [
        {
          id: 123,
          subject: 'Test issue',
          status: { id: 1, name: 'New' },
          tracker: { id: 1, name: 'Bug' },
          author: { id: 1, name: 'John Doe' },
          project: { id: 1, name: 'Test Project' },
        },
      ],
      total_count: 1,
    });
  }),

  http.put('http://localhost:3000/issues/:id.json', () => {
    return HttpResponse.json({ success: true });
  }),

  http.post('http://localhost:3000/time_entries.json', () => {
    return HttpResponse.json({ time_entry: { id: 1 } });
  }),
];

export const mockServer = setupServer(...redmineHandlers);
```

---

### Step 4.2: Write Unit Tests

**RedmineServer tests**:
```typescript
// test/unit/redmine/redmine-server.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { RedmineServer } from '../../../src/redmine/redmine-server';
import { mockServer } from '../../fixtures/redmine-api';

describe('RedmineServer', () => {
  let server: RedmineServer;

  beforeAll(() => mockServer.listen());
  afterEach(() => mockServer.resetHandlers());
  afterAll(() => mockServer.close());

  beforeEach(() => {
    server = new RedmineServer({
      address: 'http://localhost:3000',
      key: 'test-api-key',
    });
  });

  it('should fetch issues assigned to me', async () => {
    const result = await server.getIssuesAssignedToMe();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].subject).toBe('Test issue');
  });

  it('should update issue status', async () => {
    const issue = { id: 123 } as any;
    await expect(server.setIssueStatus(issue, 2)).resolves.not.toThrow();
  });

  it('should add time entry', async () => {
    await expect(
      server.addTimeEntry(123, 9, '1.5', 'Test work')
    ).resolves.not.toThrow();
  });
});
```

**Command tests**:
```typescript
// test/unit/commands/list-open-issues.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import listOpenIssues from '../../../src/commands/list-open-issues-assigned-to-me';

describe('listOpenIssuesAssignedToMe', () => {
  it('should fetch and display issues', async () => {
    const mockServer = {
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [] }),
      options: { url: { hostname: 'test.redmine.com' } },
    };

    const props = { server: mockServer, config: {} };

    await listOpenIssues(props);

    expect(mockServer.getIssuesAssignedToMe).toHaveBeenCalled();
  });
});
```

---

### Step 4.3: Setup CI

**.github/workflows/ci.yml**:
```yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - run: npm ci

      - run: npm run lint

      - run: npx tsc --noEmit

      - run: npm run test:coverage

      - name: Check coverage threshold
        run: |
          if ! npm run test:coverage -- --reporter=json | jq -e '.coverage.lines >= 60'; then
            echo "Coverage below 60%"
            exit 1
          fi

      - uses: codecov/codecov-action@v4
```

---

## Phase 5: Documentation & Release (1 day)

### Step 5.1: Create MIGRATION_GUIDE.md

```markdown
# v3.0.0 Migration Guide

## Quick Start

1. Update extension to v3.0.0
2. Update VS Code to 1.85.0+
3. Run: `Redmine: Set API Key`
4. Enter API key when prompted

## Detailed Steps

### Step 1: Update VS Code
Minimum version: 1.85.0 (released Aug 2023)
Check: Help → About

### Step 2: Update Extension
Extensions view → Update "Redmine for Positron"

### Step 3: Migrate API Key

**Automatic** (recommended):
- Extension detects old config
- Prompts to migrate on first use
- Moves key to secure storage

**Manual**:
1. Get API key from Redmine `/my/account`
2. Delete `redmine.apiKey` from `.vscode/settings.json`
3. Run: `Redmine: Set API Key`
4. Paste key when prompted

### Troubleshooting

| Issue | Solution |
|-------|----------|
| "API key not found" | Run "Redmine: Set API Key" |
| Key disappeared | Check VS Code updated to 1.85+ |

## Breaking Changes

- API keys now in VS Code Secrets (machine-local)
- VS Code 1.85+ required
- Old `redmine.apiKey` deprecated
```

---

### Step 5.2: Update CHANGELOG.md

```markdown
## [3.0.0] - 2025-11-22

### BREAKING CHANGES

- **API keys in Secrets**: Machine-local, encrypted storage
- **VS Code 1.85+ required**: For Secrets API support
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
```

---

### Step 5.3: Update README.md

```markdown
## Requirements

- VS Code 1.85.0+
- Redmine with REST API enabled
- API key from Redmine account

## Quick Start

1. Install extension
2. Run: `Redmine: Set API Key`
3. Enter URL and API key
4. Done!

## Security

API keys stored in VS Code Secrets (encrypted, machine-local).

## Migrating from v2.x

See [Migration Guide](./MIGRATION_GUIDE.md).
```

---

### Step 5.4: Release

```bash
# Update version
npm version 3.0.0

# Package
npm run compile
npx @vscode/vsce package

# Publish
npx @vscode/vsce publish

# Tag
git tag v3.0.0
git push origin v3.0.0
```

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| TypeScript 5.7 breaks build | Incremental migration, extensive testing |
| url.parse() edge cases | Comprehensive URL test suite |
| Secrets unavailable (Linux) | Error handling, fallback prompts |
| Lost API keys | Auto-migration with notification |

---

## Success Metrics

- [ ] 0 TypeScript errors
- [ ] 60%+ test coverage
- [ ] Bundle size <200KB
- [ ] All tests passing
- [ ] 0 npm vulnerabilities
- [ ] Migration guide complete

---

## Timeline

**Week 1**: Phases 0-1 (Foundation + TypeScript)
**Week 2**: Phases 2-3 (ESM + Secrets/Modernization)
**Week 3**: Phases 4-5 (Testing + Release)

**Total: 16 days**

---

## Quick Reference for Implementation

### Key Files to Modify

**Phase 0-1**:
- `esbuild.js` (fix null check, rename to .cjs)
- `package.json` (deps, scripts)
- `tsconfig.json` (ES2022, bundler)
- `src/redmine/redmine-server.ts` (url.parse → new URL)
- `src/extension.ts` (type fixes)
- 4 command files (url.host → url.hostname)

**Phase 3**:
- New: `src/utilities/secret-manager.ts`
- New: `src/commands/set-api-key.ts`
- Update: `src/extension.ts` (secrets integration)
- Update: `package.json` (deprecate apiKey config)

**Phase 4**:
- New: `test/mocks/vscode.ts`
- New: `test/fixtures/redmine-api.ts`
- New: `test/unit/**/*.test.ts`
- New: `.github/workflows/ci.yml`

**Phase 5**:
- New: `MIGRATION_GUIDE.md`
- Update: `CHANGELOG.md`, `README.md`

### Critical Commands

```bash
# Phase 0
npm install -D vitest@^2.1.0 @vitest/coverage-v8@^2.1.0 msw@^2.6.0
npm uninstall lodash @types/lodash

# Phase 1
npm install -D typescript@^5.7.2 @types/node@^22.17.10 @types/vscode@^1.96.0

# Testing
npm run test
npm run test:coverage

# Build & verify
npm run compile
npm run lint
npx tsc --noEmit

# Release
npm version 3.0.0
npx @vscode/vsce package
npx @vscode/vsce publish
```

### Breaking Changes Summary

1. **API keys** → VS Code Secrets (machine-local)
2. **VS Code** → 1.85.0+ required
3. **TypeScript** → 5.7 (5-year jump)
4. **Module** → ESM source, CJS output
5. **Dependencies** → lodash removed

### Test Pattern (TDD)

```typescript
// 1. Write test first
describe('Feature', () => {
  it('should do X', () => {
    expect(actual).toBe(expected);
  });
});

// 2. Run test (should fail)
npm test

// 3. Implement feature
// ... code ...

// 4. Run test (should pass)
npm test
```

### MSW Setup Pattern

```typescript
// test/fixtures/redmine-api.ts
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const mockServer = setupServer(
  http.get('http://localhost:3000/issues.json', () => {
    return HttpResponse.json({ issues: [...] });
  })
);

// In tests
beforeAll(() => mockServer.listen());
afterEach(() => mockServer.resetHandlers());
afterAll(() => mockServer.close());
```

### Secrets API Pattern

```typescript
// Build key
const key = `redmine:${Buffer.from(uri.toString()).toString('hex')}:apiKey:v1`;

// Store
await context.secrets.store(key, apiKey);

// Retrieve
const apiKey = await context.secrets.get(key);

// Delete
await context.secrets.delete(key);

// Listen
context.secrets.onDidChange((event) => {
  if (event.key.startsWith('redmine:')) {
    // refresh
  }
});
```

---

## End of Plan

Next step: Begin Phase 0 implementation
