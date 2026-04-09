---
name: redmine-api
description: >
  Use when writing, modifying, or reviewing code that interacts with the Redmine
  REST API — including files in src/redmine/, API models, endpoints,
  request/response handling, or any curl commands targeting a Redmine server.
---

# Redmine REST API — Correctness Guard

When this skill activates, start by reading the project's API reference docs to understand the current endpoint specs:

1. Read `docs/API_REFERENCE.md` — endpoint specs, request/response shapes, implementation method mapping
2. Read `docs/redmine_api_docs.md` — full Redmine REST API resource list with wiki links for deep-dive

These docs are the **single source of truth** for API behavior. Cross-reference them against any code you write or review.

## Validation Checklist

Run through this checklist when writing or modifying Redmine API code:

- [ ] **Endpoint path** — must end in `.json` (e.g., `/issues.json` not `/issues`, `/issue_statuses.json` not `/statuses.json`)
- [ ] **HTTP method** — correct verb: GET (read), POST (create), PUT (update), DELETE (remove)
- [ ] **Request body nesting** — body must nest under the resource key: `{ "issue": { ... } }`, `{ "time_entry": { ... } }` — never a bare object
- [ ] **Response shape** — list endpoints return a pagination wrapper: `{ "issues": [...], "total_count": N, "offset": N, "limit": N }`. Single-resource endpoints nest under the resource key: `{ "issue": { ... } }`
- [ ] **Required vs optional fields** — check `docs/API_REFERENCE.md` for which fields are required on POST/PUT
- [ ] **Auth header** — must be `X-Redmine-API-Key` (not `Authorization: Bearer`, not Basic auth)
- [ ] **Field types** — journal detail `old_value`/`new_value` are always strings (e.g., `"231"` not `231`); custom field values are strings; `notes` is `""` not `null` when empty
- [ ] **Pagination** — list endpoints have max `limit` of 100; must recurse with `offset` for complete data
- [ ] **Error responses** — 403 and 404 return empty body with `Content-Type: application/json`; 422 returns `{ "errors": ["..."] }`

## Live API Testing

You can verify API behavior against the live Redmine server using curl. Check for these environment variables first:

- `$REDMINE_URL` — base URL (e.g., `https://redmine.example.com`)
- `$REDMINE_API_KEY` — API key for authentication

**If either env var is missing**, warn the user and fall back to doc-only validation. Do not guess or hardcode credentials.

### Curl Templates

```bash
# GET (read)
curl -s -k -H "X-Redmine-API-Key: $REDMINE_API_KEY" "$REDMINE_URL/<endpoint>"

# POST (create)
curl -s -k -X POST \
  -H "X-Redmine-API-Key: $REDMINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"<resource>": {...}}' \
  "$REDMINE_URL/<endpoint>"

# PUT (update)
curl -s -k -X PUT \
  -H "X-Redmine-API-Key: $REDMINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"<resource>": {...}}' \
  "$REDMINE_URL/<endpoint>"

# DELETE
curl -s -k -X DELETE \
  -H "X-Redmine-API-Key: $REDMINE_API_KEY" \
  "$REDMINE_URL/<endpoint>"
```

### Testing Notes

- **`-k` flag is required** — the server may have SSL renegotiation issues with schannel on Windows
- **Test before implementing** — hit the endpoint first, inspect the actual response shape, then write code to match
- **Security** — never log or display the full response of `/users/current.json` or `/my/account.json` as they contain the API key in plaintext
- When in doubt about a response shape, test it live rather than guessing from docs

## Common Pitfalls

Non-obvious behaviors discovered through live testing. Review these before writing new API code.

| Pitfall | Detail |
|---------|--------|
| **Response nesting** | All responses nest under a resource key: `{ "issues": [...] }`, `{ "issue": {...} }` — never a bare array or object |
| **PUT returns empty body** | Successful PUT returns HTTP 200 with empty body, not the updated resource |
| **Pagination max** | `limit` max is 100; must recurse with `offset` for complete data |
| **Subproject exclusion** | Use `subproject_id=!*` to exclude subprojects from issue queries |
| **Custom fields shape** | Array of `{ id: number, name: string, value: string, multiple?: boolean }` — embedded in projects, issues, users, time entries |
| **Journal details are strings** | `old_value` and `new_value` are always strings (e.g., `"231"` not `231`), even for numeric IDs |
| **Journal notes empty string** | Journals without comments have `notes: ""` (empty string), not `null` |
| **No journal pagination** | `?include=journals` returns ALL journals in one array — no pagination available |
| **Journal property types** | `property` values: `"attr"` (standard fields), `"relation"` (issue relations), `"cf"` (custom fields) |
| **403 = admin-only** | `/users.json`, `/groups.json`, `/custom_fields.json` return 403 with empty body for non-admin users |
| **403 = module disabled** | `/projects/{id}/files.json` returns 403 if the Files module is disabled |
| **Wiki is per-project** | `/projects/{id}/wiki/index.json` returns 404 if wiki module disabled; 200 otherwise |

### Access Matrix

Verified against live server (non-admin user):

| Endpoint | Status | Notes |
|----------|--------|-------|
| `GET /projects.json` | 200 | Paginated, includes custom_fields |
| `GET /issues.json` | 200 | Paginated; filters: `status_id`, `assigned_to_id`, `project_id`, `sort` |
| `GET /issues/{id}.json` | 200 | Supports `?include=journals,relations,children` |
| `PUT /issues/{id}.json` | 200 | Empty body on success |
| `GET /issue_statuses.json` | 200 | Not paginated |
| `GET /trackers.json` | 200 | Includes `enabled_standard_fields` |
| `GET /enumerations/time_entry_activities.json` | 200 | Not paginated |
| `GET /enumerations/issue_priorities.json` | 200 | Includes `is_default` |
| `GET /users/current.json` | 200 | **Contains API key** — never log full response |
| `GET /my/account.json` | 200 | Similar to current user |
| `GET /time_entries.json` | 200 | Paginated |
| `POST /time_entries.json` | 201 | Returns created entry |
| `GET /issues/{id}/relations.json` | 200 | Includes `relation_type`, `delay` |
| `GET /projects/{id}/issue_categories.json` | 200 | Paginated |
| `GET /projects/{id}/versions.json` | 200 | Paginated |
| `GET /projects/{id}/memberships.json` | 200 | Paginated, user+roles |
| `GET /roles.json` | 200 | Not paginated |
| `GET /queries.json` | 200 | Paginated |
| `GET /search.json?q=` | 200 | Returns mixed resource types |
| `GET /news.json` | 200 | Paginated |
| `GET /users.json` | 403 | Admin-only |
| `GET /groups.json` | 403 | Admin-only |
| `GET /custom_fields.json` | 403 | Admin-only |
| `GET /projects/{id}/files.json` | 403 | Module may be disabled |
| `GET /projects/{id}/wiki/index.json` | 200/404 | Depends on wiki module |
