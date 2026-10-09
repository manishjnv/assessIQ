# Smallest public REST API — design note (FU-B9)

**Status: design only, not built.** Date 2026-10-09. Owner input still open: is a REST API part of a plan tier (PT1)? Build nothing before that answer.

## What

Two read-only endpoints for a company's own data, authenticated with the API keys that already exist (`modules/01-auth/src/api-keys.ts`: hashed keys, scopes, `requireScope`, 600/min key tier in the rate limiter). No route uses `requireScope` today, so the mechanism is dormant.

| Route | Scope | Returns |
| --- | --- | --- |
| `GET /api/v1/assessments?status=&cursor=&limit=` | `assessments:read` | id, name, level, status, opens_at, closes_at, question_count, duration_seconds |
| `GET /api/v1/results?assessment_id=&since=&cursor=&limit=` | `attempts:read` | attempt_id, assessment_id, candidate external_id (never email), status, published_at, score_pct, pass, certificate_id |

Results carry only published results (the tenant-visible rule of `TENANT_VISIBLE_ATTEMPT_SQL` in module 09, same as FU-C3). Answers, bands, justifications and candidate names are never returned.

## Why

An HR or LMS system that imports results by polling is the first integration customers ask for. Webhooks (module 13, business events FU-B6) push the ids; this API lets the other side fetch the row. Together they make the embed and the webhooks usable without a login.

## Rules

- Tenant comes from the key row (`req.apiKey.tenantId`), through the same tenant-context middleware as sessions; `withTenant` and RLS apply. No tenant id in the URL.
- Auth chain: `apiKeyAuth` then `requireScope(<scope>)`; a session is not accepted on `/api/v1/*` (keeps browser cookies out of the integration surface).
- Cursor pagination on `(created_at, id)`, max 200 per page. Stable JSON with `snake_case` keys, ISO-8601 UTC times, a version in the path.
- Rate limit: the existing 600/min key bucket. Audit: one `api_key.used` row per day per key, not per request.
- Errors use the global error envelope (`{ error: { code, message } }`), 401 for a bad key, 403 for a missing scope.

## Options considered and rejected

- A full CRUD API (invite candidates, create assessments): rejected for now; writes need idempotency keys and more review, and no customer asked.
- GraphQL: rejected, one more runtime and no consumer.
- Reusing the `/api/admin/*` routes with API keys: rejected, those return admin-only fields and change often.

## Not included

Code, OpenAPI file, SDK, write endpoints, candidate-facing endpoints, per-key IP allowlists.

## Downstream impact when built

`docs/03-api-contract.md` (new section `Public API v1`), module 01 (`requireScope` first real caller, tests), module 19 (tier gate through `tierAllows(tenantId, 'api')`, FU-A3), module 10 (API keys page shows the two scopes), module 16 help (`admin.settings.api_keys.*`), `docs/11-observability.md` (log event per key per day).
