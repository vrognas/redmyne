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
