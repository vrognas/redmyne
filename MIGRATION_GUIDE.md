# v3.0.0 Migration Guide

## Quick Start

1. Update extension to v3.0.0
2. Update VS Code to 1.106.0+
3. Run: `Redmine: Set API Key`
4. Enter API key when prompted

## Detailed Steps

### Step 1: Update VS Code
Minimum version: 1.106.0
Check: Help → About

### Step 2: Update Extension
Extensions view → Update "Redmine for Positron"

### Step 3: Migrate API Key

**Manual**:
1. Get API key from Redmine `/my/account`
2. Delete `redmine.apiKey` from `.vscode/settings.json`
3. Run: `Redmine: Set API Key`
4. Paste key when prompted

### Troubleshooting

| Issue | Solution |
|-------|----------|
| "API key not found" | Run "Redmine: Set API Key" |
| Key disappeared | Check VS Code updated to 1.106+ |

## Breaking Changes

- API keys now in VS Code Secrets (machine-local)
- VS Code 1.106+ required
- Old `redmine.apiKey` deprecated
