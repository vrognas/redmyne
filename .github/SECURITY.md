# Security Policy

## Supported Versions

| Version | Supported  |
| ------- | ---------- |
| 4.x     | ✓ Yes      |
| < 4.0   | ✗ No       |

**Recommendation**: Use latest 4.x release for security fixes.

## Reporting a Vulnerability

**DO NOT** open public issues for security vulnerabilities.

**Preferred**: Use [GitHub Security Advisory](https://github.com/vrognas/positron-redmine/security/advisories/new) for private reporting.

**Alternative**: Email maintainers through GitHub profile.

Include:
- Extension version
- VS Code/Positron version
- Operating system
- Detailed description
- Reproduction steps (if applicable)
- Proof of concept (if applicable)

**Response Time**: Typically 48-72 hours for acknowledgment.

## Security Features

### API Key Storage
- **v3.0+**: VS Code Secrets API (encrypted, platform-native)
  - Windows: Credential Manager
  - macOS: Keychain
  - Linux: libsecret/gnome-keyring
- **v2.x**: Plaintext settings.json (deprecated, insecure)

### Migrate to v3.0
Run: `Redmine: Set API Key` command to migrate from plaintext storage.

See [Migration Guide](../docs/MIGRATION_GUIDE.md).

### TLS/HTTPS Enforcement (v3.5+)

- **HTTPS Required**: HTTP connections are rejected
- **Certificate Validation**: Always enabled, no opt-out
- **Self-signed certs**: Not supported - use valid certificates (Let's Encrypt is free)

**Rationale**: Protects API keys from man-in-the-middle attacks.

## Known Security Considerations

1. **API Key Scope**: Redmine API keys grant full account access. Extension only performs read operations and limited updates (time entries, status changes).

2. **Network Traffic**: All requests use HTTPS with certificate validation. No data sent to third parties.

3. **Local Storage**: Server URLs stored in workspace settings (may sync via Settings Sync). API keys never sync.

## Security Best Practices

- Rotate API keys regularly
- Use read-only Redmine accounts if possible
- Review `redmyne.additionalHeaders` for sensitive data (it syncs, unlike API keys)
- Disable Settings Sync for workspaces with sensitive URLs
