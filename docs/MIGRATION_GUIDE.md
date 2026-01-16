# v4.0.0 Migration Guide

## What Changed

**Breaking**: All extension identifiers renamed from `redmine.*` to `redmyne.*`:

- Settings: `redmine.url` → `redmyne.url`, etc.
- Commands: `redmine.configure` → `redmyne.configure`, etc.
- Views: `redmine-explorer-*` → `redmyne-explorer-*`
- Context keys: `redmine:configured` → `redmyne:configured`

## Automatic Migration

Extension auto-migrates on first v4.0.0 startup:

- API key moved to new secret key
- All globalState keys migrated
- No user action required

## Manual Steps (if needed)

If settings.json has explicit `redmine.*` keys, rename to `redmyne.*`.

---

# v3.0.0 Migration Guide

## Prerequisites

- VS Code 1.106.0+ (check: Help → About)
- Extension v3.0.0

## Migration Steps

1. Update VS Code to 1.106.0+
2. Update extension via Extensions view
3. Get API key from Redmine `/my/account`
4. Run command: `Redmine: Set API Key`
5. Paste key when prompted

Old `redmine.apiKey` settings are deprecated and can be removed.

## Troubleshooting

| Issue               | Solution                   |
| ------------------- | -------------------------- |
| "API key not found" | Run `Redmine: Set API Key` |
| Key disappeared     | Verify VS Code 1.106+      |

## What Changed

- API keys stored in VS Code Secrets (machine-local, not synced)
- VS Code 1.106+ required for Secrets API
- `redmine.apiKey` setting deprecated
