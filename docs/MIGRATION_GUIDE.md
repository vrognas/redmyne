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
