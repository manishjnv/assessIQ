# 11 — Observability

> **Read this when:** something broke and you need to figure out what happened.
> **Read this before:** adding any `log.info(...)` call to a new module.

This doc owns the operational logging contract — what we write, where it goes, how it's redacted, how to triage from it. Business audit (HR-grade state-change record) lives in `modules/14-audit-log/SKILL.md`. Behavioral telemetry (candidate clicks, attempt events) lives in `modules/06-attempt-engine` § attempt_events. **Don't mix the three.**

---

## 1. Goals & non-goals

**In:** structured JSONL logs on disk, correlation across the request path, redaction allowlist, retention policy, triage runbooks, the convention every module follows when emitting log lines.

**Out (deferred to Phase 3):** distributed tracing (OpenTelemetry), metrics + alerting (Prometheus/Grafana), log shipping to an external aggregator (Loki/Vector), real-time SIEM forwarding. The on-disk JSONL files are designed to be Promtail-scraped later without app code changes.

---

## 2. Three log channels — the boundary

When something happens in AssessIQ, exactly one of these takes the write:

| Channel | Where it lives | What goes here | Retention |
|---|---|---|---|
| **Operational logs** *(this doc)* | `/var/log/assessiq/*.log` (JSONL, on-disk, redacted) | Anything you'd grep when debugging. Request lines, errors, stack traces, info-level signals about what the app did. | 14d hot, gzipped, then deleted |
| **Business audit** | `audit_log` table in Postgres (RLS-scoped, append-only) | State changes a compliance auditor needs to see: login success/fail, role grants, grading overrides, API-key creation/revocation. | 7y (tenant-overrideable 1–10y) |
| **Behavioral telemetry** | `attempt_events` table | Candidate-side noteworthy moments: question viewed, answer typed, autosave fired, integrity-hook triggered. | 90d hot, archived after |

**Decision tree:**

- "Did a state change in a way an auditor would want to know about?" → `audit_log` (call `audit({...})` from `14-audit-log`).
- "Did the candidate do something noteworthy?" → `attempt_events`.
- "Did something go wrong, or do I want to be able to grep this later?" → operational log.

A single event sometimes hits two channels (e.g., a failed login writes to `auth.log` *and* `audit_log`). That's fine and intentional — they answer different questions and have different retention.

---

## 3. Streams & paths

Six application streams plus one error mirror, all under `LOG_DIR` (default `/var/log/assessiq` in production; unset in dev/test → stdout-only).

| File | Who writes | Operator question it answers | Approx volume/day |
|---|---|---|---|
| `app.log` | default sink for `streamLogger('app')`, fallback for unknown stream names, per-module CRUD logs (tenancy, users) | "What did the app do today?" | ~30 MB |
| `request.log` | Fastify `onResponse` hook | "Which request was slow / 5xx? Who hit which route?" | ~5 MB at 50 req/min |
| `auth.log` | `01-auth/*` + `03-users/invitations.ts` (session minting on accept) | "Who logged in / failed MFA / had a session revoked?" | ~1 MB |
| `grading.log` | `07-ai-grading` per-CLI-run wrapper *(Phase 2 — see § 10)* | "Why did this AI grade fail? What prompt SHA? Token cost?" | tiny in Phase 1 |
| `migration.log` | `tools/migrate.ts` (self-contained JSONL writer) | "Which migrations applied to prod, when, in what order, hash matches?" | tiny |
| `webhook.log` | `13-notifications` outbound HTTP *(Phase 3)* | "Did our webhook to host X fire? What did they return?" | varies |
| `frontend.log` | `apps/api/routes/_log.ts` ingest, fed by `apps/web/src/lib/logger.ts` | "What broke in the browser? Which client saw it?" | varies |
| `error.log` *(mirror)* | every stream, level ≥ error only | **"What broke?"** — single file to scan first, regardless of source | ~1 MB |

### Common shape

Every line carries:

```jsonc
{
  "level": 30,                          // pino numeric: 10=trace 20=debug 30=info 40=warn 50=error 60=fatal
  "time": "2026-05-01T09:33:21.815Z",   // ISO8601 UTC
  "pid": 1234,
  "stream": "request",                  // which file it's in
  "requestId": "019de1c3-...",          // when an HTTP request is in flight
  "tenantId": "wipro-soc",              // when the request has authenticated
  "userId": "u_abc",                    // ditto
  "msg": "http.request",                // human-readable label
  // ... handler-specific fields below ...
}
```

Correlation fields (`requestId`, `tenantId`, `userId`) are **auto-attached** by the logger mixin via `AsyncLocalStorage`. Module code does NOT pass them manually.

### Per-stream sample lines

```jsonc
// request.log
{ "level": 30, "stream": "request", "requestId": "019de1c3-…", "tenantId": "wipro-soc",
  "userId": "u_admin", "method": "POST", "url": "/api/admin/users",
  "route": "/api/admin/users", "status": 201, "latencyMs": 47,
  "ip": "203.0.113.5", "ua": "Mozilla/5.0…", "msg": "http.request" }

// auth.log
{ "level": 30, "stream": "auth", "requestId": "019de1c3-…", "userId": "u_admin",
  "msg": "session.created" }

// migration.log
{ "level": 30, "stream": "migration", "file": "020_users.sql",
  "sha256": "9af2…", "durationMs": 84, "action": "apply", "msg": "migration.applied" }
```

---

## 4. Redaction allowlist — read this before adding any log call

The pino logger applies `LOG_REDACT_PATHS` (exported from `@assessiq/core`) to every line before serialization. Listed paths get replaced with `"[Redacted]"`. **This is defense-in-depth, not the primary control.** Primary control: don't pass secrets/PII into log calls.

Allowlist coverage (see [modules/00-core/src/log-redact.ts](../modules/00-core/src/log-redact.ts)):

- **HTTP transport** — `req.headers.authorization`, `req.headers.cookie`, `set-cookie`
- **Auth secrets** — `password`, `secret`, `token`, `apiKey` / `api_key`, `totpSecret` / `totp_secret`, `recoveryCode` / `recovery_code`, `client_secret` / `clientSecret`, `refresh_token` / `refreshToken`, `id_token` / `idToken`
- **Sessions** — `aiq_sess`, `session`, `sessionToken` / `session_token`
- **Candidate PII** — `answer`, `answerText` / `answer_text`, `candidateText`
- **Wildcards** — `*.password`, `*.secret`, `*.token`, `*.totpSecret`, `*.recoveryCode`, `*.client_secret`, `*.refresh_token`, `*.id_token`, `*.session`, `*.sessionToken` (one level of nesting; pino does not recurse)

### Categories the platform handles (mental model)

| PII category | Where it lives | Logging rule |
|---|---|---|
| Candidate-answer text | `attempts.answers` JSON column | NEVER include `answer*` fields in log calls. They're allowlisted as a backstop, but assume the allowlist is broken — don't depend on it. |
| Recovery codes (TOTP) | `recovery_codes` table, hashed | The plaintext only exists at generation time and is shown to the user once. Never log either form. |
| TOTP secrets | `user_credentials.totp_secret_enc` (encrypted) | Same. |
| Embed JWTs | `tenant_embed_secrets`. JWTs themselves are short-lived bearers. | Log the JWT's `kid`, `iss`, `exp` claims if needed; never the raw token. |
| Session cookie value | Redis-keyed by sha256 of cookie. | Cookie value is allowlisted at the header level; never log directly. |
| Email addresses | `users.email` | Acceptable to log when it's already part of the operational signal (e.g., invitation accept). NOT acceptable to bulk-log on cron sweeps. |

### When in doubt, don't log it

If you find yourself logging a request body, dump only specific fields you've thought about (`{ userId, action, role }`), not the whole `req.body`. The redaction allowlist will catch known names but cannot rescue you from a careless `logger.info({ body: req.body }, ...)` that happens to include an answer-text field named `essay_response` (not in the allowlist).

---

## 5. Correlation across the stack — the requestId story

Every operational log line that happens during an HTTP request carries the same `requestId` value. This is the load-bearing thread that lets you trace one slow 5xx through Caddy → API → outbound API call.

### How the ID flows

1. **Edge (Caddy):** the access log has `%{X-Request-Id}i` in its log format. If a client sends `X-Request-Id`, Caddy logs it; otherwise the field is empty (Caddy does not generate one — that's the API's job).
2. **API entry (`apps/api/src/server.ts`):** Fastify's `genReqId: () => uuidv7()` mints a UUIDv7 if no upstream id is present. The `onRequest` hook then calls `enterWithRequestContext({ requestId, ... })` from `@assessiq/core`, populating an `AsyncLocalStorage` store for the rest of the request.
3. **Module code:** any `streamLogger(...)` or `childLogger(...)` call automatically picks up `requestId`, `tenantId`, `userId` from ALS via the pino `mixin`. No call site has to opt in.
4. **Outbound calls (Anthropic, webhooks):** propagate by reading `getRequestContext().requestId` and forwarding as `X-Request-Id` on the outbound request.

### Postgres — known gap (Phase 0)

We do **not** propagate `requestId` into Postgres `pg_stat_statements` or `application_name`. To correlate an API line with a slow DB query, match by timestamp + tenantId. Phase 3 may set `application_name = ${requestId}` per connection-checkout if the gap becomes painful.

### Worked example — trace one 5xx

```bash
# Find the failed request in error.log
jq 'select(.status >= 500)' /var/log/assessiq/request.log | tail -1
# → { "requestId": "019de1c3-...", "route": "/api/admin/users/:id", "status": 500, ... }

# Pull every line that touched it
grep '019de1c3' /var/log/assessiq/*.log | jq

# Cross-check the DB during that window
docker exec -it assessiq-postgres psql -c "
  SELECT query, calls, mean_exec_time
  FROM pg_stat_statements
  WHERE last_call > now() - interval '10 seconds'
  ORDER BY mean_exec_time DESC LIMIT 10;
"
```

---

## 6. Triage runbooks

The most-used section. Each entry: symptom → which file → what to look for → likely cause.

### "5xx in production"

```bash
# Last 50 errors across all streams
jq 'select(.level >= 50)' /var/log/assessiq/error.log | tail -50
```

Group by route, then by error class:

```bash
jq -s 'map(select(.stream=="request" and .status >= 500))
       | group_by(.route)
       | map({route: .[0].route, count: length, sample_req: .[0].requestId})' \
   /var/log/assessiq/request.log
```

**Check first:** is one route hot, or are 5xx scattered? Hot route → handler bug. Scattered → infra (DB connection pool, Redis, upstream API).

### "AI grading produced wrong band"

```bash
# Find the grading row in DB, get attemptId + promptSha
docker exec -it assessiq-postgres psql -c \
  "SELECT attempt_id, question_id, band, prompt_sha256
     FROM grading_results WHERE id = '<grade-id>';"

# Pull the CLI run's structured log
jq --arg q "<question_id>" \
   'select(.questionId == $q)' /var/log/assessiq/grading.log
```

If the grading.log entry has `exitCode != 0`, the CLI failed and the band was a fallback. If `exitCode == 0`, the CLI ran clean and the band is the model's verdict — re-baselining is the next move (`modules/07-ai-grading/eval/`), not a bug fix.

### "Login failing for one tenant"

```bash
# auth.log filtered to this tenant
jq --arg t "<tenant-id>" \
   'select(.tenantId == $t and (.msg | startswith("login")))' \
   /var/log/assessiq/auth.log | tail -50

# Cross-check business audit (compliance view)
docker exec -it assessiq-postgres psql -c "
  SELECT created_at, action, actor_user_id, ip, user_agent
  FROM audit_log
  WHERE tenant_id = '<tenant-id>'
    AND action LIKE 'auth.login%'
  ORDER BY created_at DESC LIMIT 50;"
```

If `auth.log` shows MFA failures clustered in time, check `aiq:auth:lockedout:<userId>` in Redis — TOTP lockout window is 5 minutes after 5 failures (see `modules/01-auth/src/totp.ts`).

### "Migration applied wrong"

```bash
# Order-of-application audit
jq 'select(.msg == "migration.applied")
    | { file, sha256, durationMs, ts: .time }' /var/log/assessiq/migration.log

# Compare against schema_migrations table
docker exec -it assessiq-postgres psql -c \
  "SELECT version, applied_at, checksum FROM schema_migrations ORDER BY applied_at;"
```

Drift between log and table → someone applied a migration outside `tools/migrate.ts` (manually via psql). Recovery: `git diff` the file vs the recorded checksum, decide whether to rebase or accept.

### "Rate of 401s spiking"

```bash
# 401s by route in the last hour
jq -s 'map(select(.stream=="request" and .status==401 and (now - (.time | fromdateiso8601)) < 3600))
       | group_by(.route) | map({route:.[0].route, count:length})' \
   /var/log/assessiq/request.log
```

If one route dominates, suspect a deploy that broke an auth header. If scattered, suspect a credential leak / brute force — check rate-limit hits in `auth.log` and the Caddy access log for source IPs.

---

## 7. Retention & rotation

| Knob | Value | Reason |
|---|---|---|
| Retention | 14 days hot, then deleted | Operational use only — DB `audit_log` is the durable record. |
| Rotation | daily, gzip after 1 day | Standard `logrotate` cadence. |
| Tool | system `logrotate` (one config at `/etc/logrotate.d/assessiq`) | No in-process rotation library. Avoids inode-handle bugs. |
| Mode | `copytruncate` | **Critical.** Pino holds open file descriptors; without `copytruncate` the rotated file keeps getting written to and the new file stays empty. Same trap class as the Caddy bind-mount inode incident in `RCA_LOG.md`. |

The committed config is at `infra/logrotate.d/assessiq` (see § 8). On the VPS it's symlinked into `/etc/logrotate.d/assessiq`. To force a rotation: `sudo logrotate -f /etc/logrotate.d/assessiq`.

### "I need older logs than 14 days"

- **Compliance question** → `audit_log` table. 7-year default retention.
- **Forensics on a bug** → check git history for the deploy SHA at the time of the incident; reproduce locally with the same code.
- **Phase 3 change** — switch to Loki + S3 archival when the operational need exceeds 14d. Adds infra and cost, deferred for now.

---

## 8. How a module emits logs — the convention

```ts
// modules/01-auth/src/sessions.ts
import { streamLogger } from '@assessiq/core';
const log = streamLogger('auth');     // ← writes to /var/log/assessiq/auth.log

export async function createSession(input) {
  // …
  log.info({ userId: input.userId, mfa: 'totp' }, 'session.created');
  //                                                ^^^^^^^^^^^^^^^^
  //                                                 short, dot-namespaced
}
```

### Rules

1. **One `const log = streamLogger(...)` per file**, immediately after imports. Use the stream name for your module (see § 3 table). Unknown names fall through to `app.log`.
2. **Object-form ALWAYS:** `log.info({field}, 'msg')`. Never `log.info('msg ' + field)` — kills structured search and bypasses redaction.
3. **Don't pass `requestId`/`tenantId`/`userId` manually** — the mixin attaches them.
4. **Message strings are short labels**, dot-namespaced where useful (`session.created`, `migration.applied`, `http.request`). Long human prose goes in fields.
5. **Levels:**
   - `trace` / `debug` — chatty, off by default in production
   - `info` — load-bearing signal an operator might grep
   - `warn` — recoverable surprise; the request still succeeded
   - `error` — the request failed; mirrored to `error.log`
   - `fatal` — process-ending; `migrate.ts` uses this on `main().catch()`
6. **Anti-patterns** (PreToolUse hook bounces these — see § 9):
   - `console.log()` / `console.error()` — silent on the on-disk files; never appears in triage
   - `log.error(err)` (no object form) — pino prints the bare error; structured fields are lost
   - `log.info({ body: req.body }, ...)` — leaks unfiltered request body past redaction
   - logging plaintext PEMs / cookies / JWTs

### Stream-name table (when in doubt)

| If you're emitting from… | Use stream |
|---|---|
| HTTP request lifecycle (Fastify hooks) | `request` |
| Login, MFA, sessions, embed JWTs, API keys, invitation accept | `auth` |
| AI grading runs (Phase 2 wrapper) | `grading` |
| Migration apply / drift detection | `migration` |
| Outbound webhooks / email send | `webhook` (Phase 3 — currently goes to `app`) |
| Frontend ingest endpoint | `frontend` |
| Anything else | `app` |

---

## 9. Frontend logging

### Browser side — `apps/web/src/lib/logger.ts`

```ts
import { clientLog, installGlobalErrorHandlers } from './lib/logger';

installGlobalErrorHandlers();         // call once in main.tsx
clientLog('error', 'render failed', { component: 'Login', code: 'X' });
```

Behavior:

- Buffered (debounced 2000 ms, max 20 entries, immediate flush on overflow).
- Per-session rate limit: 200 entries/min. Excess silently dropped, single dev-console warning.
- `msg` truncated to 200 chars; `fields` JSON ≤ 1 KB; entries exceeding limits are dropped with a dev-console warning.
- `BLOCKED_KEY_SUBSTRINGS` (case-insensitive substring match): `password`, `secret`, `token`, `apikey`, `api_key`, `id_token`, `refresh_token`, `cookie`, `authorization`, `auth`, `recovery`, `session`. Offending KEY (not entry) dropped; mirror of server-side `LOG_REDACT_PATHS`.
- `window.error` and `window.unhandledrejection` auto-wired by `installGlobalErrorHandlers`.
- `beforeunload` flushes via `navigator.sendBeacon`.
- Flush failures swallowed (no retries — avoids storm); dropped count carried into next flush.

### Server ingest — `apps/api/src/routes/_log.ts`

- `POST /api/_log` — `skipAuth: true` (frontend logs from the login page before any session).
- Strict Fastify schema: `additionalProperties: false` at every level, `maxItems: 50`, `maxLength: 200`, `maxProperties: 20`, leaf values constrained to `string|number|boolean|null`.
- Per-IP rate limit: 600 req/min, in-memory token bucket, sweeps stale windows on each request. Returns `429 RATE_LIMITED` on overflow.
- Entries map 1:1 to `streamLogger('frontend').<level>({ ...fields, clientTs, ip, ua, referer }, msg)`. `referer` truncated to 256 chars.

**Known Phase-0 gap:** the server endpoint does not value-sanitize fields (e.g., a client could write `{ "info_field": "Bearer ey..." }` and the server would log the value verbatim). The frontend sanitizer + the server-side `LOG_REDACT_PATHS` cover most cases by KEY name. Address in Phase 3 by adding a value-pattern check (regex for JWT-shaped tokens) on the ingest path.

---

## 10. Phase-1 AI grading run capture (contract — wrapper deferred)

The Phase-1 grading runtime invokes the `claude` CLI as a subprocess (sync, on admin click — see `docs/05-ai-pipeline.md` § Compliance frame). When that wrapper ships in `modules/07-ai-grading/`, it MUST emit one JSONL line to `streamLogger('grading')` per CLI run, with this shape:

```jsonc
{
  "level": 30,
  "stream": "grading",
  "requestId": "019de1c3-…",
  "tenantId": "wipro-soc",
  "userId": "u_admin",         // the admin who clicked "grade"
  "attemptId": "att_abc",
  "questionId": "q_xyz",
  "promptSha256": "9af2…",     // matches modules/07-ai-grading/prompts/*.sha256
  "model": "claude-sonnet-4-6",
  "tokensIn": 1842,
  "tokensOut": 412,
  "latencyMs": 4123,
  "exitCode": 0,
  "stderrTail": "[Redacted]",  // last 512 bytes, candidate-text passed through LOG_REDACT_PATHS
  "msg": "grading.run"
}
```

**Why redact `stderrTail`:** model errors sometimes echo the prompt (which contains candidate-answer text) into stderr. Logging stderr verbatim would leak PII past the redaction allowlist. The wrapper must apply the allowlist patterns to stderr before logging.

**Why this is doc-only today:** `modules/07-ai-grading/` has only `SKILL.md` — no implementation yet. Phase 2 builds the wrapper; this contract is the inheritance.

---

## 11. What we are NOT doing (and why)

- **No tracing (OpenTelemetry).** Listed as `00-core` open question; deferred to Phase 3 unless perf debugging needs surface. `requestId` correlation handles 90% of triage today.
- **No external aggregator (Loki/Vector/SIEM).** File-based + `jq` is faster to triage today on a single VPS with a single ops human. Phase 3 can add Promtail to scrape the same JSONL files without app code change.
- **No log-based alerting.** No PagerDuty wire-up. On-call human reads `error.log` when something breaks. Alerting comes in Phase 3 with metrics.
- **No PII-in-logs even with redaction trust.** Redaction is defense-in-depth. The primary control is "don't include the field." See § 4.
- **No metrics export from logs (logfmt → metrics).** Counter/gauge work belongs in Prometheus/StatsD when added. Logs are for individual events, not aggregates.

---

## 12. Cross-references

- [docs/06-deployment.md](06-deployment.md) § "Log paths" — points here for schema + retention; keeps deploy doc focused on disk topology.
- [docs/05-ai-pipeline.md](05-ai-pipeline.md) § Phase 1 CLI grading — § 10 above is the inherited logging contract.
- [modules/14-audit-log/SKILL.md](../modules/14-audit-log/SKILL.md) — boundary documented at § 2.
- [modules/00-core/SKILL.md](../modules/00-core/SKILL.md) § Public surface — `streamLogger`, `childLogger`, `LOG_REDACT_PATHS`, `enterWithRequestContext`.
- [docs/RCA_LOG.md](RCA_LOG.md) — bind-mount inode RCA pattern is what drives `copytruncate` in § 7.
- [CLAUDE.md](../CLAUDE.md) Definition-of-Done table — "Logging/observability change → docs/11-observability.md" is the canonical doc target.
