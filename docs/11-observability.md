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

Seven application streams plus one error mirror, all under `LOG_DIR` (default `/var/log/assessiq` in production; unset in dev/test → stdout-only).

| File | Who writes | Operator question it answers | Approx volume/day |
|---|---|---|---|
| `app.log` | default sink for `streamLogger('app')`, fallback for unknown stream names, per-module CRUD logs (tenancy, users) | "What did the app do today?" | ~30 MB |
| `request.log` | Fastify `onResponse` hook | "Which request was slow / 5xx? Who hit which route?" | ~5 MB at 50 req/min |
| `auth.log` | `01-auth/*` + `03-users/invitations.ts` (session minting on accept) | "Who logged in / failed MFA / had a session revoked?" | ~1 MB |
| `grading.log` | `07-ai-grading` per-CLI-run wrapper *(Phase 2 — see § 10)* | "Why did this AI grade fail? What prompt SHA? Token cost?" | tiny in Phase 1 |
| `migration.log` | `tools/migrate.ts` (self-contained JSONL writer) | "Which migrations applied to prod, when, in what order, hash matches?" | tiny |
| `webhook.log` | `13-notifications` outbound webhook delivery + email queue — **live 2026-05-03** | "Did our webhook to host X fire? What did they return? Was the email queued?" | varies |
| `frontend.log` | `apps/api/routes/_log.ts` ingest, fed by `apps/web/src/lib/logger.ts` | "What broke in the browser? Which client saw it?" | varies |
| `worker.log` | `apps/api/src/worker.ts` BullMQ scheduler (`runJobWithLogging` wrapper) — see § 13 | "Did the cron tick? How long did it take? What failed and how many retries?" | ~200 KB at the current 60s + 30s cadence; one start + one finished line per tick |
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
| BullMQ scheduler / cron job lifecycle | `worker` (see § 13) |
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

---

## 13. Worker observability

> **Read this when:** triaging a stuck cron tick, investigating why a tenant's assessment didn't auto-close, designing a new BullMQ job.
> **Read this before:** adding any new repeating job to `apps/api/src/worker.ts`.

The BullMQ scheduler at [apps/api/src/worker.ts](../apps/api/src/worker.ts) runs as a separate container (`assessiq-worker`, second entrypoint on the `assessiq-api` image) and emits one `worker.job.start` + one `worker.job.finished` JSONL line per job execution to `worker.log`. Per-tenant errors emitted by the inner job processors (e.g. one tenant's `processBoundariesForTenant` throwing while others succeed) emit additional context lines under the same stream — those are operational signals, not part of the per-job lifecycle schema.

This subsection inherits the conventions in §§ 4 (redaction) and 5 (correlation) — every line includes `requestId` (synthesized per tick by BullMQ's job context), `pid`, `time`, and `stream: "worker"`. It does NOT inherit the request-context ALS chain because no HTTP request is in flight.

### 13.1 Per-execution schema

Every job execution produces exactly two log lines emitted by `runJobWithLogging` in [apps/api/src/worker.ts](../apps/api/src/worker.ts).

**`worker.job.start`** (level=info) — emitted immediately before the inner processor runs:

```jsonc
{
  "level": 30,
  "stream": "worker",
  "msg": "worker.job.start",
  "job_id": "1234",                          // BullMQ job id (string)
  "job_name": "assessment-boundary-cron",    // matches JOB_RETRY_POLICY key
  "queue": "assessiq-cron",
  "started_at": "2026-05-03T00:01:00.000Z",  // ISO8601 UTC
  "tenant_id": null,                         // null at the wrapper level — see § 13.2
  "retry_count": 0                           // BullMQ attemptsMade BEFORE this run (0 on first attempt, 1 on second, etc.)
}
```

**`worker.job.finished`** (level=info on success, level=error on failure) — emitted after the inner processor resolves or throws:

```jsonc
// Success case
{
  "level": 30,
  "stream": "worker",
  "msg": "worker.job.finished",
  "job_id": "1234",
  "job_name": "assessment-boundary-cron",
  "queue": "assessiq-cron",
  "started_at": "2026-05-03T00:01:00.000Z",
  "finished_at": "2026-05-03T00:01:00.123Z",
  "duration_ms": 123,
  "status": "succeeded",
  "tenant_id": null,
  "retry_count": 0,
  "result": { "tenants": 12, "activated": 1, "closed": 0 }
                  // ↑ structured per-tick counts only — never raw row data
}

// Failure case
{
  "level": 50,
  "stream": "worker",
  "msg": "worker.job.finished",
  "job_id": "1234",
  "job_name": "assessment-boundary-cron",
  "queue": "assessiq-cron",
  "started_at": "2026-05-03T00:01:00.000Z",
  "finished_at": "2026-05-03T00:01:00.456Z",
  "duration_ms": 456,
  "status": "failed",
  "tenant_id": null,
  "retry_count": 0,
  "error_class": "TypeError",
  "error_message": "Redis connection lost",
  "stack": "TypeError: Redis connection lost\n    at processBoundaryTick (..."
}
```

**`worker.job.failed.permanent`** (level=error) — emitted by the BullMQ `worker.on("failed", ...)` handler **only when ALL retries are exhausted**. Distinct from the per-attempt `worker.job.finished status: "failed"` line:

```jsonc
{
  "level": 50,
  "stream": "worker",
  "msg": "worker.job.failed.permanent",
  "jobName": "assessment-boundary-cron",
  "jobId": "1234",
  "attemptsMade": 5,                         // total attempts before giving up
  "err": { /* serialized Error */ }
}
```

For each truly-failed tick at `attempts: 5`: 5 `worker.job.start` + 5 `worker.job.finished status: failed` + 1 `worker.job.failed.permanent` = 11 lines. The wrapper line is the diagnostic surface (full schema with stack); the permanent line is the bookkeeping signal.

### 13.2 Why `tenant_id` is null at the wrapper level

Both currently-shipped jobs (`assessment-boundary-cron`, `attempt-timer-sweep`) iterate ALL active tenants in a single tick rather than targeting one. The per-tenant inner work emits its own context line on tenant-specific errors:

```jsonc
{
  "level": 50,
  "stream": "worker",
  "msg": "boundary-cron tenant error",
  "tenantId": "wipro-soc",
  "job": "assessment-boundary-cron",
  "err": { /* serialized Error */ }
}
```

When a future job ships that targets one tenant per `Queue.add()` call (e.g. a per-tenant export, a per-tenant grading job), the wrapper schema's `tenant_id` field MUST be populated from `job.data.tenant_id` so triage queries by tenant work uniformly. The `tenant_id: null` field is intentionally present on every line so a `jq 'select(.tenant_id == "X")'` query has consistent shape regardless of job type.

### 13.3 Retry policy

Defined per-job-name in `JOB_RETRY_POLICY` at [apps/api/src/worker.ts](../apps/api/src/worker.ts). The current table:

| Job name | `attempts` | `backoff` | Idempotency basis |
|---|---|---|---|
| `assessment-boundary-cron` | 5 | exponential, base 1000 ms | Bulk `UPDATE WHERE status IN ('published', 'active') AND boundary < now()` — re-running on already-transitioned rows is a SQL no-op. No external side effects (no audit, no notifications, no webhooks). |
| `attempt-timer-sweep` | 5 | exponential, base 1000 ms | Bulk `UPDATE WHERE status='in_progress' AND ends_at < now()` + per-attempt `time_milestone` event insert, all wrapped in a single `withTenant(...)` transaction. Either the whole tick commits (retry sees nothing left to process) or it rolls back (retry processes the same rows fresh). No partial-commit risk. |

BullMQ's exponential backoff with `delay: 1000` produces approximate retry delays of 1s, 2s, 4s, 8s (with jitter). The total worst-case time from first failure to permanent-fail mark is ~15s, well under either job's interval (30s for timer-sweep, 60s for boundary).

**Adding a new job — checklist:**

1. Add the job-name constant + add a `JOB_RETRY_POLICY[NAME]` entry. **`attempts` MUST reflect actual idempotency**, not "5 by default".
2. If the job is NOT idempotent (e.g. an outbound webhook the receiver doesn't dedupe), set `attempts: 1` and document the rationale in the JOB_RETRY_POLICY comment block.
3. If the job is per-tenant (`job.data.tenant_id` populated), the wrapper's `tenant_id: null` field stays the schema; populate it from `job.data` in a small follow-up to `runJobWithLogging` rather than in the inner processor.
4. Update the table in this section in the same PR.

### 13.4 Admin observability surface

Three admin-gated routes in [apps/api/src/routes/admin-worker.ts](../apps/api/src/routes/admin-worker.ts) expose the queue's runtime state without requiring access to `worker.log` files:

- `GET /api/admin/worker/stats` — current `{waiting, active, delayed, completed, failed}` counts via `Queue.getJobCounts()`. Server-side 5-second TTL cache so a misbehaving dashboard polling every 1s can't hammer Redis.
- `GET /api/admin/worker/failed` — last 50 failed jobs with redacted payload + truncated stack tail.
- `POST /api/admin/worker/failed/:id/retry` — re-enqueue a failed job by id (admin manual recovery).

Full route shapes + error contracts in [docs/03-api-contract.md § Admin — Worker observability](03-api-contract.md). The admin auth chain (`authChain({ roles: ['admin'] })`) gates all three.

The redaction blacklist on `/failed`'s `data` payload is a key-substring match mirroring `LOG_REDACT_PATHS`. **It is not a substitute for §4's primary control** — never put a sensitive field into a job's `data` payload in the first place.

### 13.5 Triage runbook — "the cron stopped advancing"

```bash
# 1. Are jobs running at all? Look for any worker.job.start in the last 10m.
jq 'select(.msg == "worker.job.start" and (now - (.time | fromdateiso8601)) < 600)' \
   /var/log/assessiq/worker.log | head -10

# 2. If yes — are they finishing?
jq 'select(.msg == "worker.job.finished" and (now - (.time | fromdateiso8601)) < 600)
    | { job_name, status, duration_ms, retry_count }' \
   /var/log/assessiq/worker.log

# 3. Any permanent fails in the last hour?
jq 'select(.msg == "worker.job.failed.permanent" and (now - (.time | fromdateiso8601)) < 3600)' \
   /var/log/assessiq/worker.log

# 4. Per-tenant errors masking the headline result?
jq 'select(.msg == "boundary-cron tenant error" or .msg == "timer-sweep tenant error")' \
   /var/log/assessiq/worker.log | tail -20

# 5. Queue depth — is the worker drowning?
curl -sS -b "aiq_sess=<admin-session>" \
  https://assessiq.automateedge.cloud/api/admin/worker/stats | jq
# `waiting > 50` sustained over 10 minutes is the alert threshold per
# docs/06-deployment.md § Monitoring.

# 6. Inspect failed jobs by id, then retry:
curl -sS -b "aiq_sess=<admin-session>" \
  https://assessiq.automateedge.cloud/api/admin/worker/failed | jq '.jobs[] | { id, name, failed_reason }'
curl -sS -X POST -b "aiq_sess=<admin-session>" \
  https://assessiq.automateedge.cloud/api/admin/worker/failed/<job-id>/retry | jq
```

If `worker.log` is empty but the container is running, the `LOG_DIR` env var was not set when the container booted — `docker exec assessiq-worker env | grep LOG_DIR` and recreate the container per the `restart` ≠ `recreate` rule in [docs/RCA_LOG.md](RCA_LOG.md) `2026-05-01 — env_file reload`.

## 14. Notifications observability (Phase 3 — live 2026-05-03)

> **Read this when:** triaging a missing webhook delivery, investigating an email that didn't arrive, or checking in-app notification state.

Module `13-notifications` emits all observability to **`webhook.log`** (`streamLogger('webhook')`). Email send and webhook delivery are both async — queued via BullMQ, processed in `assessiq-worker`.

### 14.1 Key log events

| Event | Level | Stream | When |
|---|---|---|---|
| `email.queued` | info | webhook | `sendEmail()` enqueued the `email.send` BullMQ job |
| `email.sent` | info | webhook | SMTP `sendMail()` returned without error |
| `email: SMTP_URL not configured — falling back to dev-emails.log` | warn | webhook | No SMTP configured — stub fallback active |
| `in-app.notification.created` | info | app | `notifyInApp()` inserted a row |
| `webhook.delivery.delivered` | info | webhook | 2xx from endpoint |
| `webhook.delivery.permanent_fail` | warn | webhook | 4xx (not 408/425/429) from endpoint — no retry |
| `webhook.delivery.retry` | warn | webhook | 5xx / 408/425/429 from endpoint — BullMQ will retry |
| `webhook.delivery.network_error` | warn | webhook | fetch threw before response — BullMQ will retry |
| `webhook.delivery.not_found` | warn | webhook | delivery row missing — dropped silently |
| `webhook.endpoint.not_found` | warn | webhook | endpoint deleted after delivery enqueued |
| `webhook.secret.missing` | error | webhook | AES-decrypt failed — endpoint unusable |
| `audit-fanout: @assessiq/audit-log not available — skipping fanout` | info | webhook | G3.A not yet merged — expected pre-Phase-3 |

### 14.2 Retry schedules

| Job | Schedule | BullMQ backoff type |
|---|---|---|
| `email.send` | exponential, base 5000 ms, 5 attempts | BullMQ built-in exponential |
| `webhook.deliver` | literal `[1m, 5m, 30m, 2h, 12h]` (P3.D12 — published API contract) | custom strategy (`webhookBackoffStrategy`) |

The webhook retry schedule is **published** in `docs/03-api-contract.md` — do not change it without an API version bump. The email retry schedule is internal and may change freely.

### 14.3 Stub-fallback (pre-Resend creds)

When `SMTP_URL` is unset or empty, `sendEmail()` writes a JSONL line to `~/.assessiq/dev-emails.log` (dev) or `/var/log/assessiq/dev-emails.log` (production) rather than failing. The path can be overridden via `ASSESSIQ_DEV_EMAILS_LOG` env var. This prevents deploy breakage before Resend credentials are provisioned.

### 14.4 Webhook delivery admin surface

- `GET /api/admin/webhooks/deliveries?status=failed` — all failed deliveries for the tenant
- `POST /api/admin/webhooks/deliveries/:id/replay` — append-only replay (new delivery row, original preserved)
- `GET /api/admin/webhook-failures` + `POST /api/admin/webhook-failures/:id/retry` — convenience aliases

### 13.6 What changed in this revision (2026-05-03)

- **Why:** the worker shipped at SHA `2675e2f` with a working scheduler but no per-job structured logging, no retry policy beyond BullMQ defaults (which is "no retry"), no admin introspection surface. Triaging a stuck cron required SSHing into the container and reading docker logs — no on-disk JSONL trail, no admin UI affordance, no way to retry a failed job without redeploying.
- **What:** added the `runJobWithLogging` wrapper + `JOB_RETRY_POLICY` table in [apps/api/src/worker.ts](../apps/api/src/worker.ts), added `"worker"` to `KNOWN_STREAMS` in [modules/00-core/src/logger.ts](../modules/00-core/src/logger.ts), shipped three admin routes in [apps/api/src/routes/admin-worker.ts](../apps/api/src/routes/admin-worker.ts).
- **Considered and rejected:** (a) emitting per-tenant `worker.job.start` lines from inside the boundary/timer-sweep loop — rejected because it would 10–100× the log volume and obscure the single-tick lifecycle; tenant-specific errors are emitted as separate context lines instead. (b) BullMQ's `Queue.getMetrics()` for the stats endpoint — rejected because it requires the metrics collector worker which would add a second BullMQ subscription; `getJobCounts()` is one round-trip. (c) Per-tenant queue stats — rejected because BullMQ has no per-tenant column on the queue; would require iterating all jobs which doesn't scale.
- **Explicitly NOT included:** alerting wire-up (still per § 11 — alerting comes with metrics in Phase 3); per-tenant filtering on `/failed` (deferred until a per-tenant job ships, see § 13.4); a UI panel for the admin routes (Phase 2 G2.C — module 10 admin dashboard); a CI lint forbidding new jobs without `JOB_RETRY_POLICY` entries (manual discipline + the checklist in § 13.3).
- **Downstream impact on other modules:** [docs/03-api-contract.md § Admin — Worker observability](03-api-contract.md) gains 3 endpoints + an error-contract table; [docs/06-deployment.md § Monitoring](06-deployment.md) gains a queue-depth row reading from `/api/admin/worker/stats`; [infra/logrotate.d/assessiq](../infra/logrotate.d/assessiq) needs no change (the `*.log` glob already covers `worker.log`). When [modules/07-ai-grading](../modules/07-ai-grading/SKILL.md) ships its Phase 2 BullMQ grading worker, it will use the same `runJobWithLogging` wrapper + `JOB_RETRY_POLICY` table and emit to the same `worker.log` — single triage surface for all background work.
