# Redmine for Positron

Redmine project management integration for Positron IDE and VS Code.

> **Attribution**: This is a Positron-focused fork of [vscode-redmine](https://github.com/rozpuszczalny/vscode-redmine) by Tomasz Domański, originally licensed under MIT.

## Features

- Sidebar panel
  - List issues assigned to you in sidebar panel
  - List projects and open issues in them
- Create issue (opens redmine create issue in browser)
- List of issues assigned to you
- Open issue by id
- Open issue by selected number in document
- Issue actions:
  - Change status of an issue
  - Add time entry to an issue
  - Open issue in browser
  - Quick update issue

_Missing a feature? Open an issue and let me know!_

### Sidebar panel

![Sidebar panel GIF showcase](./resources/redmine-sidebar-panel.gif)

### Add time entry from action menu

![Add time entry from action menu GIF showcase](./resources/redmine-add-time-entry.gif)

### Change server to other workspace folder in sidebar panel

![Change server to other workspace folder in sidebar panel GIF showcase](./resources/redmine-change-sidebar-server.gif)

## Compatibility

This extension works with both **Positron IDE** and **VS Code**.

## Requirements

- VS Code 1.106.0+
- Redmine with REST API enabled (`/settings?tab=api`, requires admin)
- API key from Redmine account (`/my/account`)

## Quick Start

1. Install extension
2. Run: `Redmine: Set API Key`
3. Enter URL and API key
4. Done!

## Security

API keys stored in VS Code Secrets (encrypted, machine-local).

## Migrating from v2.x

See [Migration Guide](./MIGRATION_GUIDE.md).

## Extension Settings

This extension contributes the following settings:

- `redmine.url`: URL of redmine server (eg. `https://example.com`, `http://example.com:8080`, `https://example.com:8443/redmine`, `http://example.com/redmine` _etc._)
- `redmine.apiKey`: API Key of your redmine account (see `/my/account` page, on right-hand pane)
- `redmine.rejectUnauthorized`: Parameter, which is passed to https request options (true/false) (useful to fix issues with self-signed certificates, see issue #3)
- `redmine.identifier`: If set, this will be the project, to which new issue will be created

  _NOTE: this is an identifier of project, not display name of the project_

- `redmine.additionalHeaders`: Object of additional headers to be sent along with every request to redmine server

## Development Setup

After cloning:

```bash
npm install
npm run install-hooks
```

Git hooks validate commit messages (subject ≤50 chars, body ≤72 chars).

## Contribution

If you want to contribute to the project, please read [contributing guide](./CONTRIBUTING.md) guide.

## Known Issues

No known issues yet. If you found one, feel free to open an issue!

## Release Notes

See [change log](./CHANGELOG.md)

## Contributors

This extension builds upon the excellent work of:

- **Tomasz Domański** ([@rozpuszczalny](https://github.com/rozpuszczalny)) - Original author
- **Doğan Özdoğan** - Tree view feature
- **Markus Amshove** - Quick update feature

## Attributions

### Original Project

This extension is a fork of [vscode-redmine](https://github.com/rozpuszczalny/vscode-redmine) by Tomasz Domański.

Copyright 2018 Tomasz Domański. Licensed under the MIT License.

### Logo

Logo is remixed version of original Redmine Logo.

Redmine Logo is Copyright (C) 2009 Martin Herr and is licensed under the Creative Commons Attribution-Share Alike 2.5 Generic license.
See http://creativecommons.org/licenses/by-sa/2.5/ for more details.
