# 11 — Observability

*Type: reference* — This page describes the log contract, redaction rules, retention and triage steps.

**Status:** some items are not built. The `grading.log` wrapper (§ 10) is deferred to Phase 2. Distributed tracing, metrics and alerting, and external log shipping are deferred to Phase 3 (§ 11). Webhook and email logs go to `app.log` in some paths (§ 8). <!-- verify -->

> **Read this when:** something broke and you need to find out what happened.
> **Read this before:** you add any `log.info(...)` call to a new module.

This page owns the operational logging contract: what the system writes, where it goes, how it is redacted and how to triage from it. Two other records exist. Do not mix the three.

| Record | Where it lives |
| --- | --- |
| Business audit (HR-grade state-change record) | `modules/14-audit-log/SKILL.md` |
| Behavioral telemetry (candidate clicks, attempt events) | `modules/06-attempt-engine` § attempt_events |

---

## 1. Goals & non-goals

| Scope | Items |
| --- | --- |
| In | Structured JSONL logs on disk. Correlation across the request path. A redaction allowlist. A retention policy. Triage runbooks. The convention that every module follows to emit log lines |
| Out (deferred to Phase 3) | Distributed tracing (OpenTelemetry). Metrics and alerting (Prometheus/Grafana). Log shipping to an external aggregator (Loki/Vector). Real-time SIEM forwarding |

The on-disk JSONL files are designed so that Promtail can scrape them later without app code changes.

---

## 2. Three log channels — the boundary

Exactly one of these channels takes the write for an event:

| Channel | Where it lives | What goes here | Retention |
|---|---|---|---|
| **Operational logs** *(this doc)* | `/var/log/assessiq/*.log` (JSONL, on-disk, redacted) | Anything you'd grep when debugging. Request lines, errors, stack traces, info-level signals about what the app did. | 14d hot, gzipped, then deleted |
| **Business audit** | `audit_log` table in Postgres (RLS-scoped, append-only) | State changes a compliance auditor needs to see: login success/fail, role grants, grading overrides, API-key creation/revocation. | 7y (tenant-overrideable 1–10y) |
| **Behavioral telemetry** | `attempt_events` table | Candidate-side noteworthy moments: question viewed, answer typed, autosave fired, integrity-hook triggered. | 90d hot, archived after |

Decision tree:

- If a state change is something an auditor needs to see, write to `audit_log`. Call `audit({...})` from `14-audit-log`.
- If the candidate did something noteworthy, write to `attempt_events`.
- If something went wrong, or you want to grep the event later, write an operational log.

A single event can reach two channels. For example, a failed login writes to `auth.log` and to `audit_log`. This is intentional. The channels answer different questions and have different retention.

---

## 3. Streams & paths

Seven application streams plus one error mirror write under `LOG_DIR`. The default is `/var/log/assessiq` in production. In dev and test, an unset `LOG_DIR` means stdout only. (The table lists ten files because three more streams were added later: `worker.log`, `mcp-rejections.log` and `stage3-watch.log`.)

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
| `mcp-rejections.log` | `tools/assessiq-mcp/src/tools/submit-questions.ts` `logRejection()` — written by the MCP server process inside `assessiq-api` — see § 22 | "Did the model submit malformed questions? Which Zod paths failed? What was the payload?" | ~40 KB after a count=15 smoke campaign; zero on clean runs |
| `stage3-watch.log` | `assessiq-stage3-watch.service` systemd unit (via `tools/stage3-watch.ts`); appended **only on breach** — see § 20 | "Was a Stage 3 threshold crossed? When? What metric?" | Tiny — bytes per breach entry; no writes on clean ticks |
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

Correlation fields (`requestId`, `tenantId`, `userId`) are **auto-attached** by the logger mixin through `AsyncLocalStorage`. Module code does NOT pass them by hand.

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

- The pino logger applies `LOG_REDACT_PATHS` (exported from `@assessiq/core`) to every line before serialization.
- Listed paths become `"[Redacted]"`.
- This is defense in depth, not the primary control. The primary control: do not pass secrets or PII into log calls.

Allowlist coverage (see [modules/00-core/src/log-redact.ts](../modules/00-core/src/log-redact.ts)):

| Group | Paths |
| --- | --- |
| HTTP transport | `req.headers.authorization`, `req.headers.cookie`, `set-cookie` |
| Auth secrets | `password`, `secret`, `token`, `apiKey` / `api_key`, `totpSecret` / `totp_secret`, `recoveryCode` / `recovery_code`, `client_secret` / `clientSecret`, `refresh_token` / `refreshToken`, `id_token` / `idToken` |
| Sessions | `aiq_sess`, `session`, `sessionToken` / `session_token` |
| Candidate PII | `answer`, `answerText` / `answer_text`, `candidateText` |
| Wildcards | `*.password`, `*.secret`, `*.token`, `*.totpSecret`, `*.recoveryCode`, `*.client_secret`, `*.refresh_token`, `*.id_token`, `*.session`, `*.sessionToken` (one level of nesting; pino does not recurse) |

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

- Do not log a request body. Log only specific fields that you have considered, for example `{ userId, action, role }`, not the whole `req.body`.
- The allowlist catches known names. It cannot rescue a careless `logger.info({ body: req.body }, ...)` that includes an answer-text field named `essay_response` (not in the allowlist).

---

## 5. Correlation across the stack — the requestId story

Every operational log line written during an HTTP request carries the same `requestId` value. This thread lets you trace one slow 5xx through Caddy, the API and an outbound API call.

### How the ID flows

1. **Edge (Caddy):** the access log has `%{X-Request-Id}i` in its log format. If a client sends `X-Request-Id`, Caddy logs it. Otherwise the field is empty. Caddy does not generate an id. That is the job of the API.
2. **API entry (`apps/api/src/server.ts`):** Fastify's `genReqId: () => uuidv7()` mints a UUIDv7 if no upstream id exists. The `onRequest` hook then calls `enterWithRequestContext({ requestId, ... })` from `@assessiq/core`. This fills an `AsyncLocalStorage` store for the rest of the request.
3. **Module code:** any `streamLogger(...)` or `childLogger(...)` call picks up `requestId`, `tenantId` and `userId` from ALS through the pino `mixin`. No call site has to opt in.
4. **Outbound calls (Anthropic, webhooks):** read `getRequestContext().requestId` and forward it as `X-Request-Id` on the outbound request.

### Postgres — known gap (Phase 0)

- The system does **not** pass `requestId` into Postgres `pg_stat_statements` or `application_name`.
- To correlate an API line with a slow DB query, match by timestamp and `tenantId`.
- Phase 3 may set `application_name = ${requestId}` on each connection checkout if the gap becomes painful.

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

Each entry gives the symptom, the file to read, what to look for and the likely cause.

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

**Check first:** is one route hot, or are the 5xx scattered? A hot route means a handler bug. Scattered errors mean an infra problem (DB connection pool, Redis, upstream API).

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

- If the `grading.log` entry has `exitCode != 0`, the CLI failed and the band was a fallback.
- If `exitCode == 0`, the CLI ran clean and the band is the verdict of the model. The next step is re-baselining (`modules/07-ai-grading/eval/`). It is not a bug fix.

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

If `auth.log` shows MFA failures clustered in time, check `aiq:auth:lockedout:<userId>` in Redis. The TOTP lockout window is 5 minutes after 5 failures (see `modules/01-auth/src/totp.ts`).

### "Migration applied wrong"

```bash
# Order-of-application audit
jq 'select(.msg == "migration.applied")
    | { file, sha256, durationMs, ts: .time }' /var/log/assessiq/migration.log

# Compare against schema_migrations table
docker exec -it assessiq-postgres psql -c \
  "SELECT version, applied_at, checksum FROM schema_migrations ORDER BY applied_at;"
```

If the log and the table differ, someone applied a migration outside `tools/migrate.ts` (by hand through psql). Recovery: run `git diff` on the file against the recorded checksum. Then decide whether to rebase or accept.

### "Rate of 401s spiking"

```bash
# 401s by route in the last hour
jq -s 'map(select(.stream=="request" and .status==401 and (now - (.time | fromdateiso8601)) < 3600))
       | group_by(.route) | map({route:.[0].route, count:length})' \
   /var/log/assessiq/request.log
```

- If one route dominates, suspect a deploy that broke an auth header.
- If the 401s are scattered, suspect a credential leak or brute force. Check the rate-limit hits in `auth.log` and the Caddy access log for source IPs.

---

## 7. Retention & rotation

| Knob | Value | Reason |
|---|---|---|
| Retention | 14 days hot, then deleted | Operational use only — DB `audit_log` is the durable record. |
| Rotation | daily, gzip after 1 day | Standard `logrotate` cadence. |
| Tool | system `logrotate` (one config at `/etc/logrotate.d/assessiq`) | No in-process rotation library. Avoids inode-handle bugs. |
| Mode | `copytruncate` | **Critical.** Pino holds open file descriptors; without `copytruncate` the rotated file keeps getting written to and the new file stays empty. Same trap class as the Caddy bind-mount inode incident in `RCA_LOG.md`. |

The committed config is `infra/logrotate.d/assessiq` (see § 8). On the VPS, a symlink points `/etc/logrotate.d/assessiq` to it. To force a rotation, run `sudo logrotate -f /etc/logrotate.d/assessiq`.

### "I need older logs than 14 days"

| Need | Source |
| --- | --- |
| Compliance question | `audit_log` table. 7-year default retention |
| Forensics on a bug | Check the git history for the deploy SHA at the time of the incident. Reproduce locally with the same code |
| Phase 3 change | Switch to Loki and S3 archival when the operational need exceeds 14 days. It adds infra and cost, so it is deferred |

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

1. **One `const log = streamLogger(...)` for each file**, right after the imports. Use the stream name of your module (see the § 3 table). Unknown names fall through to `app.log`.
2. **Always use the object form:** `log.info({field}, 'msg')`. Never use `log.info('msg ' + field)`. It kills structured search and bypasses redaction.
3. **Do not pass `requestId`, `tenantId` or `userId` by hand.** The mixin attaches them.
4. **Message strings are short labels**, dot-namespaced where useful (`session.created`, `migration.applied`, `http.request`). Put long prose in fields.
5. **Levels:**
   - `trace` / `debug`: chatty. Off by default in production.
   - `info`: a load-bearing signal that an operator might grep.
   - `warn`: a recoverable surprise. The request still succeeded.
   - `error`: the request failed. Mirrored to `error.log`.
   - `fatal`: ends the process. `migrate.ts` uses it on `main().catch()`.
6. **Anti-patterns** (the PreToolUse hook bounces these; see § 9):
   - `console.log()` / `console.error()`: silent on the on-disk files. Never appears in triage.
   - `log.error(err)` (no object form): pino prints the bare error and the structured fields are lost.
   - `log.info({ body: req.body }, ...)`: leaks the unfiltered request body past redaction.
   - Logging plaintext PEMs, cookies or JWTs.

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

**Log event `system-role.tx` (RW-38, 2026-10-11).**

| Item | Detail |
| --- | --- |
| Emitter | `withSystemRole(reason, fn)` in `modules/02-tenancy/src/with-tenant.ts` logs one info line before it opens each system-role transaction |
| Stream | `app` |
| Fields | `reason` (the string the caller passed) and `caller` (file and line of the call site, or `unknown`) |
| Use | Count and trace cross-tenant reads. Grep `app.log` for `system-role.tx` and group by `reason` |
| Content limits | The line holds no tenant id and no row data. A call with an empty `reason` throws before it logs |

---

## 9. Frontend logging

### Browser side — `apps/web/src/lib/logger.ts`

```ts
import { clientLog, installGlobalErrorHandlers } from './lib/logger';

installGlobalErrorHandlers();         // call once in main.tsx
clientLog('error', 'render failed', { component: 'Login', code: 'X' });
```

Behavior:

- Buffered: debounced 2000 ms, max 20 entries, immediate flush on overflow.
- Per-session rate limit: 200 entries/min. The logger drops excess entries silently and prints one dev-console warning.
- `msg` is truncated to 200 characters. `fields` JSON is at most 1 KB. The logger drops entries that exceed the limits and prints a dev-console warning.
- `BLOCKED_KEY_SUBSTRINGS` (case-insensitive substring match): `password`, `secret`, `token`, `apikey`, `api_key`, `id_token`, `refresh_token`, `cookie`, `authorization`, `auth`, `recovery`, `session`. The logger drops the offending KEY (not the entry). It mirrors the server-side `LOG_REDACT_PATHS`.
- `installGlobalErrorHandlers` wires `window.error` and `window.unhandledrejection` automatically.
- `beforeunload` flushes through `navigator.sendBeacon`.
- Flush failures are swallowed. There are no retries, which avoids a storm. The dropped count carries into the next flush.

### Server ingest — `apps/api/src/routes/_log.ts`

- `POST /api/_log` uses `skipAuth: true`. The frontend logs from the login page before any session exists.
- Strict Fastify schema: `additionalProperties: false` at every level, `maxItems: 50`, `maxLength: 200`, `maxProperties: 20`. Leaf values are `string|number|boolean|null`.
- Per-IP rate limit: 600 req/min, in-memory token bucket. It sweeps stale windows on each request. On overflow it returns `429 RATE_LIMITED`.
- Entries map 1:1 to `streamLogger('frontend').<level>({ ...fields, clientTs, ip, ua, referer }, msg)`. `referer` is truncated to 256 characters.

**Known Phase-0 gap:** the server endpoint does not sanitize field values. A client could write `{ "info_field": "Bearer ey..." }` and the server would log the value as is. The frontend sanitizer and the server-side `LOG_REDACT_PATHS` cover most cases by KEY name. Phase 3 will add a value-pattern check (regex for JWT-shaped tokens) on the ingest path.

---

## 10. Phase-1 AI grading run capture (contract — wrapper deferred)

**Status:** doc only today. `modules/07-ai-grading/` had only `SKILL.md` when this section was written, with no implementation. <!-- verify --> Phase 2 builds the wrapper. This contract is the inheritance.

The Phase-1 grading runtime invokes the `claude` CLI as a subprocess (sync, on admin click; see `docs/05-ai-pipeline.md` § Compliance frame). When that wrapper ships in `modules/07-ai-grading/`, it MUST emit one JSONL line to `streamLogger('grading')` for each CLI run, with this shape:

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

**Why redact `stderrTail`:** model errors sometimes echo the prompt (which holds candidate-answer text) into stderr. Logging stderr as is would leak PII past the redaction allowlist. The wrapper must apply the allowlist patterns to stderr before it logs.

---

## 11. What we are NOT doing (and why)

| Item | Reason |
| --- | --- |
| No tracing (OpenTelemetry) | Listed as a `00-core` open question. Deferred to Phase 3 unless perf debugging needs it. `requestId` correlation handles 90% of triage today |
| No external aggregator (Loki/Vector/SIEM) | File-based logs and `jq` are faster to triage today on a single VPS with a single ops person. Phase 3 can add Promtail to scrape the same JSONL files without app code changes |
| No log-based alerting | No PagerDuty wire-up. The on-call person reads `error.log` when something breaks. Alerting comes in Phase 3 with metrics |
| No PII in logs, even with redaction trust | Redaction is defense in depth. The primary control is "do not include the field". See § 4 |
| No metrics export from logs (logfmt → metrics) | Counter and gauge work belongs in Prometheus/StatsD when added. Logs are for individual events, not aggregates |

---

## 12. Cross-references

- [docs/06-deployment.md](06-deployment.md) § "Log paths": points here for schema and retention. It keeps the deploy doc focused on disk topology.
- [docs/05-ai-pipeline.md](05-ai-pipeline.md) § Phase 1 CLI grading: § 10 above is the inherited logging contract.
- [modules/14-audit-log/SKILL.md](../modules/14-audit-log/SKILL.md): the boundary is documented at § 2.
- [modules/00-core/SKILL.md](../modules/00-core/SKILL.md) § Public surface: `streamLogger`, `childLogger`, `LOG_REDACT_PATHS`, `enterWithRequestContext`.
- [docs/RCA_LOG.md](RCA_LOG.md): the bind-mount inode RCA pattern drives `copytruncate` in § 7.
- [CLAUDE.md](../CLAUDE.md) Definition-of-Done table: "Logging/observability change → docs/11-observability.md" is the canonical doc target.

---

## 13. Worker observability

> **Read this when:** you triage a stuck cron tick, find out why the assessment of a tenant did not auto-close, or design a new BullMQ job.
> **Read this before:** you add a new repeating job to `apps/api/src/worker.ts`.

- The BullMQ scheduler at [apps/api/src/worker.ts](../apps/api/src/worker.ts) runs as a separate container (`assessiq-worker`, second entrypoint on the `assessiq-api` image).
- For each job execution it writes one `worker.job.start` line and one `worker.job.finished` JSONL line to `worker.log`.
- The inner job processors add context lines under the same stream on per-tenant errors. Example: one tenant's `processBoundariesForTenant` throws while the others succeed. These are operational signals. They are not part of the per-job lifecycle schema.
- This subsection inherits the conventions of §§ 4 (redaction) and 5 (correlation). Every line includes `requestId` (synthesized for each tick by the BullMQ job context), `pid`, `time` and `stream: "worker"`.
- It does NOT inherit the request-context ALS chain, because no HTTP request is in flight.

### 13.1 Per-execution schema

Each job execution produces exactly two log lines. `runJobWithLogging` in [apps/api/src/worker.ts](../apps/api/src/worker.ts) writes them.

**`worker.job.start`** (level=info). Written immediately before the inner processor runs:

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

**`worker.job.finished`** (level=info on success, level=error on failure). Written after the inner processor resolves or throws:

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

**`worker.job.failed.permanent`** (level=error). The BullMQ `worker.on("failed", ...)` handler writes it **only when ALL retries are exhausted**. It differs from the per-attempt `worker.job.finished status: "failed"` line:

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

For each truly failed tick at `attempts: 5`: 5 `worker.job.start` lines, 5 `worker.job.finished status: failed` lines and 1 `worker.job.failed.permanent` line. The total is 11 lines. The wrapper line is the diagnostic surface (full schema with stack). The permanent line is the bookkeeping signal.

### 13.2 Why `tenant_id` is null at the wrapper level

- Both shipped jobs (`assessment-boundary-cron`, `attempt-timer-sweep`) cover many tenants in one tick. They do not target one tenant.
- Since RW-39 (commit `67ad882`, 2026-10-11), each tick first finds the tenants that have due work. It then runs the per-tenant work for those tenants only.
- The per-tenant inner work writes its own context line on tenant-specific errors:

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

- A future job may target one tenant for each `Queue.add()` call (for example a per-tenant export or grading job). The wrapper `tenant_id` field MUST then be filled from `job.data.tenant_id`, so triage queries by tenant work the same way.
- The `tenant_id: null` field is present on every line on purpose. A `jq 'select(.tenant_id == "X")'` query then has the same shape for every job type.

#### RW-39: one cross-tenant query per tick (2026-10-11)

| Item | Detail |
| --- | --- |
| What | The `boundary-cron tick` and `timer-sweep tick` log lines now carry `tenants` = the number of tenants WITH due work. Before, `tenants` was the number of active tenants |
| Flow | Each tick runs one query under `withSystemRole`. Then it runs the unchanged `withTenant` mutation for each returned tenant |
| Logging | Each query writes one `system-role.tx` line (section 8). A tick therefore shows two `system-role.tx` lines, one for each query. Filter by `reason` to tell them apart |
| Indexes | Partial indexes `assessments_open_boundary_idx`, `assessments_close_boundary_idx` (0021) and `attempts_timer_sweep_idx` (0030) serve the queries |
| Why | The old tick listed every active tenant and opened a `withTenant` transaction for each, even with nothing due. At about 1000 tenants that is about 1000 empty transactions every 30 or 60 seconds |
| Rejected | (a) Keep the per-tenant loop as a fallback: it makes two code paths to test and keep in step. (b) Run the mutation itself cross-tenant under the system role: the mutation must stay RLS-scoped and audited for each tenant |
| Not included | Auto-release is unchanged. No new index. Idempotency and per-tenant error isolation (the `tenant error` lines above) are unchanged. A suspended tenant is not swept, as before |
| Downstream impact | Modules 05 and 06 export `listTenantsWithDueBoundaries` and `listTenantsWithExpiredAttempts`. `apps/api/src/worker.ts` exports `processBoundaryTick` and `processTimerSweepTick` for tests (`apps/api/src/__tests__/worker-cross-tenant.test.ts`). A dashboard that reads `tenants` as a tenant count must change: it is now a due-tenant count |

Boundary query (reason `boundary-cron: tenants with due assessment boundaries`, `listTenantsWithDueBoundaries` in 05):

```sql
SELECT DISTINCT a.tenant_id
  FROM assessments a
  JOIN tenants t ON t.id = a.tenant_id AND t.status = 'active'
 WHERE (a.status = 'published' AND a.opens_at IS NOT NULL AND a.opens_at <= $1)
    OR (a.status = 'active' AND a.closes_at IS NOT NULL AND a.closes_at <= $1)
 ORDER BY a.tenant_id
```

Timer query (reason `timer-sweep: tenants with expired attempts`, `listTenantsWithExpiredAttempts` in 06):

```sql
SELECT DISTINCT a.tenant_id
  FROM attempts a
  JOIN tenants t ON t.id = a.tenant_id AND t.status = 'active'
 WHERE a.status = 'in_progress'
   AND a.ends_at IS NOT NULL
   AND a.ends_at <= $1
 ORDER BY a.tenant_id
```

### 13.3 Retry policy

`JOB_RETRY_POLICY` in [apps/api/src/worker.ts](../apps/api/src/worker.ts) defines the policy for each job name. The current table:

| Job name | `attempts` | `backoff` | Idempotency basis |
|---|---|---|---|
| `assessment-boundary-cron` | 5 | exponential, base 1000 ms | Bulk `UPDATE WHERE status IN ('published', 'active') AND boundary < now()` — re-running on already-transitioned rows is a SQL no-op. No external side effects (no audit, no notifications, no webhooks). |
| `attempt-timer-sweep` | 5 | exponential, base 1000 ms | Bulk `UPDATE WHERE status='in_progress' AND ends_at < now()` + per-attempt `time_milestone` event insert, all wrapped in a single `withTenant(...)` transaction. Either the whole tick commits (retry sees nothing left to process) or it rolls back (retry processes the same rows fresh). No partial-commit risk. |
| `result.auto_release` | 1 | exponential, base 1000 ms (not used) | Every tick re-selects from the DB and each attempt is released in its own tx under the attempt row lock, so an overlapping or repeated tick cannot publish twice. A retry would only repeat work the next 15 s tick does anyway. See § 34.1. |
| `evaluation.queue_alert` | 1 | exponential, base 1000 ms (not used) | Sends mail, so it is gated by the Redis key `aiq:alert:evaluation_queue` (`SET NX EX 24h`); a tick that sent nothing deletes the key and the next hourly tick retries. See § 34.1. |

BullMQ exponential backoff with `delay: 1000` gives retry delays of about 1 s, 2 s, 4 s and 8 s (with jitter). The worst case from first failure to the permanent-fail mark is about 15 s. This is well under the interval of either job (30 s for timer-sweep, 60 s for boundary).

**Adding a new job — checklist:**

1. Add the job-name constant and a `JOB_RETRY_POLICY[NAME]` entry. **`attempts` MUST reflect the real idempotency**, not "5 by default".
2. If the job is NOT idempotent (for example an outbound webhook that the receiver does not dedupe), set `attempts: 1`. Document the reason in the JOB_RETRY_POLICY comment block.
3. If the job is per-tenant (`job.data.tenant_id` filled), the wrapper `tenant_id: null` field stays the schema. Fill it from `job.data` in a small follow-up to `runJobWithLogging`, not in the inner processor.
4. Update the table in this section in the same PR.

### 13.4 Admin observability surface

Three admin-gated routes in [apps/api/src/routes/admin-worker.ts](../apps/api/src/routes/admin-worker.ts) expose the runtime state of the queue. They remove the need to read `worker.log` files:

| Route | Purpose |
| --- | --- |
| `GET /api/admin/worker/stats` | Current `{waiting, active, delayed, completed, failed}` counts through `Queue.getJobCounts()`. A server-side 5-second TTL cache stops a dashboard that polls every 1 s from overloading Redis |
| `GET /api/admin/worker/failed` | The last 50 failed jobs, with redacted payload and truncated stack tail |
| `POST /api/admin/worker/failed/:id/retry` | Re-enqueue a failed job by id (manual admin recovery) |

- [docs/03-api-contract.md § Admin — Worker observability](03-api-contract.md) has the full route shapes and error contracts.
- The admin auth chain (`authChain({ roles: ['admin'] })`) gates all three routes.
- The redaction blacklist on the `data` payload of `/failed` is a key-substring match that mirrors `LOG_REDACT_PATHS`. **It does not replace the primary control of § 4.** Never put a sensitive field into the `data` payload of a job.

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

If `worker.log` is empty but the container runs, the `LOG_DIR` env var was not set when the container booted. Run `docker exec assessiq-worker env | grep LOG_DIR`. Then recreate the container, per the `restart` ≠ `recreate` rule in [docs/RCA_LOG.md](RCA_LOG.md) `2026-05-01 — env_file reload`.

## 14. Notifications observability (Phase 3 — live 2026-05-03)

> **Read this when:** you triage a missing webhook delivery, find out why an email did not arrive, or check the state of in-app notifications.

Module `13-notifications` writes all observability to **`webhook.log`** (`streamLogger('webhook')`). Email send and webhook delivery are both async. BullMQ queues them and `assessiq-worker` processes them.

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

The webhook retry schedule is **published** in `docs/03-api-contract.md`. Do not change it without an API version bump. The email retry schedule is internal and may change freely.

### 14.3 Stub-fallback (pre-Resend creds)

- When `SMTP_URL` is unset or empty, `sendEmail()` writes a JSONL line instead of failing.
- The file is `~/.assessiq/dev-emails.log` (dev) or `/var/log/assessiq/dev-emails.log` (production).
- The env var `ASSESSIQ_DEV_EMAILS_LOG` can override the path.
- This prevents a deploy break before the Resend credentials exist.

### 14.4 Webhook delivery admin surface

- `GET /api/admin/webhooks/deliveries?status=failed`: all failed deliveries for the tenant.
- `POST /api/admin/webhooks/deliveries/:id/replay`: append-only replay (a new delivery row; the original stays).
- `GET /api/admin/webhook-failures` and `POST /api/admin/webhook-failures/:id/retry`: convenience aliases.

### 13.6 What changed in this revision (2026-05-03)

| Item | Detail |
| --- | --- |
| Why | The worker shipped at SHA `2675e2f` with a working scheduler. It had no per-job structured logging, no retry policy beyond the BullMQ default (which is "no retry") and no admin introspection surface. To triage a stuck cron you had to SSH into the container and read docker logs. There was no on-disk JSONL trail, no admin UI affordance, and no way to retry a failed job without a redeploy |
| What | Added the `runJobWithLogging` wrapper and the `JOB_RETRY_POLICY` table in [apps/api/src/worker.ts](../apps/api/src/worker.ts). Added `"worker"` to `KNOWN_STREAMS` in [modules/00-core/src/logger.ts](../modules/00-core/src/logger.ts). Shipped three admin routes in [apps/api/src/routes/admin-worker.ts](../apps/api/src/routes/admin-worker.ts) |
| Rejected | (a) Per-tenant `worker.job.start` lines from inside the boundary or timer-sweep loop: they would raise log volume 10–100 times and hide the single-tick lifecycle. Tenant-specific errors use separate context lines instead. (b) BullMQ `Queue.getMetrics()` for the stats endpoint: it needs the metrics collector worker, which adds a second BullMQ subscription. `getJobCounts()` is one round trip. (c) Per-tenant queue stats: BullMQ has no per-tenant column on the queue, so it would iterate all jobs, which does not scale |
| Not included | Alerting wire-up (still per § 11: alerting comes with metrics in Phase 3). Per-tenant filtering on `/failed` (deferred until a per-tenant job ships, see § 13.4). A UI panel for the admin routes (Phase 2 G2.C, module 10 admin dashboard). A CI lint that forbids new jobs without `JOB_RETRY_POLICY` entries (manual discipline and the checklist in § 13.3) |
| Downstream impact | [docs/03-api-contract.md § Admin — Worker observability](03-api-contract.md) gains 3 endpoints and an error-contract table. [docs/06-deployment.md § Monitoring](06-deployment.md) gains a queue-depth row that reads `/api/admin/worker/stats`. [infra/logrotate.d/assessiq](../infra/logrotate.d/assessiq) needs no change (the `*.log` glob already covers `worker.log`). When [modules/07-ai-grading](../modules/07-ai-grading/SKILL.md) ships its Phase 2 BullMQ grading worker, it will use the same `runJobWithLogging` wrapper and `JOB_RETRY_POLICY` table and write to the same `worker.log`. This gives one triage surface for all background work |

## 15. Audit-log wiring — 04-question-bank (G3.D slice, 2026-05-11)

Every admin-mutating service method in [modules/04-question-bank](../modules/04-question-bank/SKILL.md) writes one `audit_log` row. The row is written inside the same Postgres transaction as the domain mutation, through `auditInTx(client, ...)` from `@assessiq/audit-log`. The atomicity guarantee is the reason for this slice: a successful state change without an audit row is a compliance violation, and the reverse is also a violation.

### 15.1 Wired sites and action namespaces used

| Service function | `audit_log.action` | `entity_type` | Notes |
|---|---|---|---|
| `createPack` (explicit slug) | `pack.created` | `question_pack` | `after`: slug, name, domain, status |
| `createPack` (auto-slug retry loop) | `pack.created` | `question_pack` | Same shape; one row regardless of retry attempts |
| `publishPack` | `pack.published` | `question_pack` | `before/after`: status + version; `after.question_count` |
| `archivePack` | `pack.archived` | `question_pack` | `before/after.status` |
| `activateAllQuestionsForPack` | `question.updated` | `question_pack` | Summary row: `after.kind=bulk_activate`, counts of activated / already-active / archived |
| `createQuestion` | `question.created` | `question` | `after`: pack_id, level_id, type, topic, points, status, tag_count |
| `updateQuestion` | `question.updated` | `question` | `before/after.version`, `after.changed_fields` (no full content/rubric — JSONB may be KBs) |
| `restoreVersion` | `question.updated` | `question` | `after.kind=restore`, `after.restored_from_version` |
| `bulkImport` | `pack.created` + `question.imported` | `question_pack` | Two rows: one for pack, one summary with `levels_created`, `questions_created`, `tags_created`, `tags_reused`. Per-question rows are intentionally NOT emitted — a 200-question import would dump 200 near-identical rows |
| `saveRubric` | `question.updated` | `question` | `after.kind=save_rubric` |
| `bulkUpdateQuestionStatus` | `question.updated` | `question` | Summary row (no `entity_id` — N rows targeted); `after.kind=bulk_status`, `to_status`, `updated_count`, `not_found_count`, capped `updated_ids` list |

`actor_kind` is always `user`. `actor_user_id` is the session userId of the admin, passed through the service signature. This slice added it to `archivePack`, `activateAllQuestionsForPack` and `bulkUpdateQuestionStatus`.

### 15.2 Action-catalog scope decision

This slice re-uses the existing `pack.*` and `question.*` namespaces from the G3.A action catalog ([modules/14-audit-log/src/types.ts](../modules/14-audit-log/src/types.ts)). The original slice added no entries. RW-37 later added `pack.updated`, `level.added` and `level.updated` to the catalog. It wired `updatePack`, `addLevel` and `updateLevel`.

- **`updatePack` is audit-wired (RW-37).**
  - It emits `pack.updated` (entity `question_pack`) in the same `withTenant` transaction as the write.
  - `before` and `after` hold the name and domain. `after.changed_fields` lists the changed field names.
  - The description text is never stored. Only its name appears in `changed_fields`.
  - Names and domains are stored in audit metadata. They are not secrets.
  - The actor is the required session user id from the route.
  - A PATCH that changes no field writes no audit row. `updateLevel` follows the same rule.
  - A failure in the audit insert rolls back the write. A DB test proves it.
- **`addLevel` and `updateLevel` are audit-wired (RW-37).**
  - `addLevel` emits `level.added` (entity `level`; `after`: pack_id, position, label).
  - `updateLevel` emits `level.updated` (`after`: pack_id, `changed_fields`). `before` and `after` also carry the changed non-free-text fields: label, duration_minutes, default_question_count and passing_score_pct. Description and rubric_defaults appear as names only.
  - Both run in the same transaction as the write.
  - The static guard is [modules/14-audit-log/src/__tests__/audit-writes.test.ts](../modules/14-audit-log/src/__tests__/audit-writes.test.ts). The DB test is in 04 `audit-writes.test.ts`.
- **Remaining gap: several distinct events share `question.updated`.**
  - `restoreVersion`, `saveRubric`, `bulkUpdateQuestionStatus` and `activateAllQuestionsForPack` all use `question.updated`. They differ by `after.kind`. Forensic queries filter on `after->>'kind'`.
  - Promotion to distinct actions (for example `question.restored`, `question.rubric_saved`, `question.bulk_status_updated`, `question.bulk_activated`) is desirable. It needs a catalog expansion.

### 15.3 Atomicity guarantees

- Every audit write uses `auditInTx(client, ...)` inside the same `withTenant(...)` callback that owns the mutation. `withTenant` opens the BEGIN and COMMIT. The domain UPDATE and the audit INSERT commit or roll back together.
- If `auditInTx` throws (catalog mismatch, RLS denial, FK violation), the outer try/catch in `withTenant` triggers a ROLLBACK. The ROLLBACK drops the domain mutation too. This module has no fire-and-forget audit path.
- Failure-injection tests are in [src/__tests__/audit-writes.test.ts](../modules/04-question-bank/src/__tests__/audit-writes.test.ts). The case "publishPack on a non-existent pack throws and writes NO audit row" proves the atomicity contract from the error path.

### 15.4 What's NOT audited here

- GET routes (read-only). These write only to the operational `request.log`.
- Service methods that delegate to other modules (`generateQuestions` → `handleAdminGenerate` in [07-ai-grading](../modules/07-ai-grading/SKILL.md)). The audit wiring lives at the runtime boundary in 07, not in the question-bank service.
- `generateRubricForQuestion` and `bulkGenerateMissingRubrics`. They return rubric proposals and do not persist. The persistence step is `saveRubric`, which is audit-wired.
- Tag CRUD through direct `upsertTag` calls. Tags change as a side effect of question create and update, and ride those audit rows.

## 16. Audit-log wiring — 05-assessment-lifecycle (G3.D slice, 2026-05-11)

Every admin-mutating service method in [modules/05-assessment-lifecycle](../modules/05-assessment-lifecycle/SKILL.md) writes one `audit_log` row inside the same Postgres transaction as the domain mutation, through `auditInTx(client, ...)` from `@assessiq/audit-log`. This mirrors the 04-question-bank G3.D template shipped in `eff0ba2` (see § 15). The atomicity guarantee is the same: a successful state change without an audit row is structurally impossible.

### 16.1 Wired sites and action namespaces used

| Service function | `audit_log.action` | `entity_type` | Notes |
|---|---|---|---|
| `createAssessment` | `assessment.created` | `assessment` | `after`: pack_id, level_id, pack_version, name, question_count, randomize, status |
| `updateAssessment` | `assessment.updated` | `assessment` | `before/after`: name, question_count, randomize, opens_at, closes_at; `after.changed_fields`. Full settings JSONB is NOT logged — may grow arbitrary in Phase 2+ |
| `publishAssessment` | `assessment.published` | `assessment` | `before/after.status`; `after.pool_size` records the question-bank pool count at publish time |
| `closeAssessment` | `assessment.closed` | `assessment` | `before/after.status` |
| `reopenAssessment` | `assessment.published` (`after.kind=reopen`) | `assessment` | Reuses `assessment.published` with marker — same pattern as `restoreVersion → question.updated kind=restore` in 04. Forensic queries filter on `after->>'kind' = 'reopen'` to distinguish initial publish from reopen |
| `inviteUsers` | `assessment.invite` × N | `assessment_invitation` | **One row per invitation issued, not a summary.** Each invitation carries a unique CSPRNG token — granular audit rows answer "when was user X invited to assessment Y?" Skipped users (USER_NOT_FOUND / USER_NOT_CANDIDATE / USER_INACTIVE / INVITATION_EXISTS) produce no audit row |
| `revokeInvitation` | `assessment.invite` (`after.kind=revoke`) | `assessment_invitation` | Reuses `assessment.invite` with marker. Idempotent path (already-expired) writes NO new row — nothing changed, nothing to audit |

`actor_kind` is always `"user"`. `actor_user_id` is the session userId of the admin, passed through the service signature. This slice changed these signatures: `updateAssessment(.., updatedByUserId)`, `publishAssessment(.., publishedByUserId)`, `closeAssessment(.., closedByUserId)`, `reopenAssessment(.., reopenedByUserId)` and `revokeInvitation(.., revokedByUserId)`. `createAssessment` and `inviteUsers` already carried actor params (`createdByUserId`, `invitedByUserId`).

### 16.2 Action-catalog scope decision

This slice adds **one** entry to the G3.A action catalog ([modules/14-audit-log/src/types.ts](../modules/14-audit-log/src/types.ts)): `assessment.updated`. The reopen and revoke events fold under the existing `assessment.published` and `assessment.invite` actions through `after.kind` markers. This is the same minimal-catalog-footprint pattern as `restoreVersion`, `saveRubric` and `bulk_status` under `question.updated` in 04-question-bank. The audit-log module is load-bearing per CLAUDE.md, so catalog growth is conservative on purpose.

Semantic gaps:

1. **`reopen` and `revoke` are markers on shared actions, not first-class events.** Promotion to `assessment.reopened` and `assessment.invite.revoked` would improve queryability (filter on `action` alone, not on `action + after->>'kind'`). It is deferred until a future catalog-expansion slice batches several promotions.
2. **`markInvitationViewedByToken` is NOT audit-wired.** It is a candidate-flow mutation, not an admin mutation. Candidate behavioural telemetry belongs in `attempt_events` (per `14-audit-log/SKILL.md` § Scope), not in `audit_log`.
3. **Cron boundary transitions are NOT audit-wired.**
   - `boundaries.processBoundariesForTenant` advances `published → active`, `active → closed` and `published → closed` based on time only.
   - The cron triggers these changes, not an admin.
   - An audit design needs an `actor_kind="system"` discussion and probably one summary row for each batch, not one row for each assessment.
   - Flagged for orchestrator follow-up.

### 16.3 Atomicity guarantees

- Every audit write uses `auditInTx(client, ...)` inside the same `withTenant(...)` callback that owns the mutation. `withTenant` opens the BEGIN and COMMIT. The domain UPDATE and the audit INSERT commit or roll back together.
- If `auditInTx` throws (catalog mismatch, RLS denial, FK violation), the surrounding `withTenant` rolls back the domain mutation. This module has no fire-and-forget audit path.
- The proof from the error path is in [src/__tests__/audit-writes.test.ts](../modules/05-assessment-lifecycle/src/__tests__/audit-writes.test.ts). The case "publishAssessment on a non-existent id throws and writes NO audit row" exercises the contract. The mutation can never produce an `assessment.published` event when the assessment does not exist.
- A coverage-grep assertion at the bottom of the same test file counts `auditInTx(` occurrences in `service.ts` and expects exactly 7. A new admin-mutating method without an audit write fails this guard.

### 16.4 What's NOT audited here

- Read-only methods: `listAssessments`, `getAssessment`, `getInvitationCounts`, `listInvitations`, `previewAssessment`, `resolveInvitationToken`.
- The candidate-flow mutation `markInvitationViewedByToken` (see § 16.2).
- Cron-driven boundary transitions in `boundaries.ts` and `repo.bulkUpdateBoundaries` (see § 16.2, orchestrator follow-up).

## 17. Audit-log wiring — 03-users (G3.D slice, 2026-05-11)

Every admin-mutating service method in [modules/03-users](../modules/03-users/SKILL.md) writes one `audit_log` row inside the same Postgres transaction as the domain mutation, through `auditInTx(client, ...)` from `@assessiq/audit-log`. This mirrors the 04-question-bank G3.D template shipped in `eff0ba2` (see § 15) and the 05-assessment-lifecycle slice in `08d4b19` (see § 16). The atomicity guarantee is the same.

### 17.1 Wired sites and action namespaces used

| Service function | `audit_log.action` | `entity_type` | Notes |
|---|---|---|---|
| `createUser` | `user.created` | `user` | `after`: email, name, role, status, metadata |
| `updateUser` | `user.updated` | `user` | `before/after`: name, role, status, metadata; `after.changed_fields` + `after.kind` (`status_change` \| `role_change` \| `general`). One row per call regardless of patch size |
| `softDelete` | `user.deleted` | `user` | `before` snapshot; `after.deleted=true` + `after.cascaded_pending_invitations` (count of `user_invitations` rows DELETEd in the same tx by the addendum-§5 cascade) |
| `restore` | `user.restored` | `user` | `before/after.deleted_at` + `before/after.status`. Distinct from `user.deleted` so admin queries on "who restored this account" don't have to filter on a marker field — different from QB/AL where reopen/restore are folded under shared actions with `kind` markers |
| `inviteUser` (new user) | `user.invited` (`after.kind=new`) | `user` | `entity_id` is the newly-created user. Token material (`token_hash`, plaintext token) intentionally NOT logged |
| `inviteUser` (re-invite of pending user) | `user.invited` (`after.kind=reinvite`) | `user` | `entity_id` is the existing user (durable identity). `after.replaced_invitation_count` records the prior pending invitations DELETEd in the same tx |

`actor_kind` is always `"user"`. `actor_user_id` is the session userId of the admin, passed through the service signature. This slice changed these signatures: `createUser`, `updateUser`, `softDelete` and `restore` gain a final `actorUserId: string` parameter. `inviteUser` already carried `invited_by`. The four route handlers in `apps/api/src/routes/admin-users.ts` now pass `req.session!.userId`.

### 17.2 Action-catalog scope decision

- This slice adds **3** entries to the G3.A action catalog ([modules/14-audit-log/src/types.ts](../modules/14-audit-log/src/types.ts)): `user.updated`, `user.restored` and `user.invited`. It reuses `user.created` and `user.deleted` (G3.A).
- This slice does not emit the existing `user.disabled` and `user.role.changed`. They fold into `user.updated` with `after.kind=status_change` or `kind=role_change`, by the minimal-catalog-footprint pattern. The same pattern applies to `restoreVersion → question.updated kind=restore` in 04-question-bank and `reopenAssessment → assessment.published kind=reopen` in 05-AL.
- The existing entries stay in the catalog (append-only) for legacy compatibility. New emit sites should prefer `user.updated + kind` over the specialized strings.
- `user.restored` is first-class on purpose (not folded under `user.updated kind=restore`). Soft delete and restore are an HR-significant lifecycle pair that an auditor searches for. Separate `user.deleted` and `user.restored` actions keep the "lifecycle of user X" timeline queryable without `after->>'kind'` parsing.

### 17.3 Sensitive-field redaction

- A shared `redactUserForAudit()` helper at [modules/03-users/src/audit-redact.ts](../modules/03-users/src/audit-redact.ts) strips known credential-bearing field names from every `before/after` payload built from a user-derived row. The names: `password_hash`, `mfa_secret`, `mfa_recovery_codes_hash`, `mfa_recovery_codes`, `email_verification_token`, `password_reset_token`, `oidc_id_token`, `oauth_refresh_token`.
- Today it is a no-op for every column on `users`. Credential material lives in the separate tables of 01-auth (`oauth_identities`, `user_credentials`, `totp_recovery_codes`).
- The helper insures against schema drift. If a future migration puts a credential column on `users`, the redaction is automatic at every existing call site.
- A redaction-sweep test in `audit-writes.test.ts` runs a representative mix of operations. It asserts that no redacted-field key appears in the `before/after` of any audit row. It flags any leak.
- To add a new credential column, update `USER_AUDIT_REDACTED_FIELDS` AND record the addition here.

### 17.4 Atomicity guarantees

- Every audit write uses `auditInTx(client, ...)` inside the same `withTenant(...)` callback that owns the mutation. `withTenant` opens the BEGIN and COMMIT. The domain UPDATE or INSERT and the audit INSERT commit or roll back together.
- Three failure-injection tests in [src/__tests__/audit-writes.test.ts](../modules/03-users/src/__tests__/audit-writes.test.ts) prove the contract. The tests are named "atomicity: when auditInTx throws inside updateUser / softDelete / inviteUser, the user row is NOT mutated".
  - Each test mocks `@assessiq/audit-log.auditInTx` to throw a one-shot error.
  - Then it reads the user row from a fresh superuser connection and asserts the state before the mutation.
  - This catches a class of regression: calling `auditInTx` on a different client (this breaks transaction sharing), or moving the call outside the `withTenant` callback.
- A coverage-grep assertion at the bottom of the same test file counts `auditInTx(` occurrences in `service.ts` (expects 4) and `invitations.ts` (expects 2). A new admin-mutating method without an audit write fails this guard.

### 17.5 What's NOT audited here

- `acceptInvitation`: the invitee acts on their own pending invitation. An admin does not act on another user. The audit trail of 01-auth session events (`session.created`) covers the session minting that follows. A second record here would confuse.
- `bulkImport`: a Phase-1 stub (throws `BULK_IMPORT_PHASE_1`). The Phase-1 implementation will add its own audit wiring when the route stops returning 501. [Update 2026-10-03: the `POST /admin/users/import` route and bulk import are live since 2026-10-01. See `docs/03-api-contract.md`.]
- `sweepUserSessions`: Redis-side housekeeping that runs AFTER the user-state transaction commits. The transaction that set `status='disabled'` already wrote the `user.updated kind=status_change` audit row. The Redis sweep is operational, not behavioural, and writes to `app.log` only.
- All read-only methods: `listUsers`, `getUser`, `findUserByEmailNormalized`.
- The validators `assertNotLastAdmin` and `assertValidStatusTransition`. They are pure validators and write nothing to the DB.
- Self-service flows in the wider stack (own-profile edit, own-password change). They belong to the session-event audit trail of 01-auth, not to 03-users.

## 18. Audit-log API surface (Phase 3 G3.A + G3.D)

> **Read this when:** you wire a new admin mutation to the audit trail, or triage missing audit rows.
> **Prerequisite:** § 2 documents the boundary between `audit_log` and operational logs.

### 18.1 Two write functions — when to use which

| Function | Transaction ownership | Fanout | Use when |
|---|---|---|---|
| `audit(input)` | Opens its own `withTenant(tenantId, …)` transaction | Yes — calls `fanoutAuditEvent` after commit (best-effort; never throws) | The audit write is a stand-alone operation that can commit independently. Example: session event writes, post-commit side effects. |
| `auditInTx(client, input)` | Caller's already-open `PoolClient` (inside a `withTenant` callback) | No — caller must call `fanoutAuditEvent` post-commit if SIEM delivery is needed | The domain mutation and the audit row **must** commit or roll back together. Correct choice for every admin service function that mutates domain state. |

Both functions:

- Validate `action` against `ACTION_CATALOG` (an unknown action throws immediately).
- Fill `ip` and `userAgent` from the `AsyncLocalStorage` request context when the caller does not supply them.
- Apply `redactPayload()` to the `before` and `after` fields.
- Propagate errors. They **never** swallow errors silently.

Source: `modules/14-audit-log/src/audit.ts`. Public barrel: `modules/14-audit-log/src/index.ts`.

### 18.2 Webhook fanout — `fanoutAuditEvent`

After a successful `audit()` INSERT, `fanoutAuditEvent` (`modules/14-audit-log/src/webhook-fanout.ts`) forwards the event to the matching `webhook_endpoints` through `@assessiq/notifications.handleAuditFanout`.

- **Best effort only.** A fanout failure does NOT propagate. The audit row is committed. The failure is logged at `warn` level to `webhook.log`.
- **`before` and `after` are NOT forwarded.** SIEM webhook consumers receive only `action`, `entity_type`, `entity_id`, `actor_user_id`, `ip`, `user_agent` and `at`. They must call the admin API (with fresh MFA) for the full diff payloads.
- `auditInTx` does NOT trigger fanout. If you need atomicity AND SIEM delivery, call `fanoutAuditEvent(row)` after the enclosing `withTenant` completes.
- There is no dead-letter queue for fanout failures. The system logs them to `webhook.log` and drops them.

### 18.3 Cross-module G3.D sweep — coverage as of 2026-05-12

| Module | Doc section | Commit | Status |
|---|---|---|---|
| `03-users` | § 17 | `057de7d` | Live |
| `04-question-bank` | § 15 | `eff0ba2` | Live |
| `05-assessment-lifecycle` | § 16 | `08d4b19` | Live |
| `09-scoring` | § 19 | `b82e82d` | Live |
| `13-notifications` | — | `6ab8e90` | Live — full doc section pending |
| `18-certification` | — | `190acee` | Live — full doc section pending |
| `16-help-system` | § 26 | pending commit | Live |
| `06-attempt-engine` (cron transitions) | — | — | Pending — needs `actor_kind="system"` design discussion |

### 18.4 Reading the audit table

```bash
# All audit events for a tenant, most recent first
docker exec -it assessiq-postgres psql -c "
  SELECT at, action, actor_user_id, entity_type, entity_id
  FROM audit_log
  WHERE tenant_id = '<tenant-id>'
  ORDER BY at DESC LIMIT 50;"

# Full diff for a specific entity
docker exec -it assessiq-postgres psql -c "
  SELECT at, action, actor_user_id, before, after
  FROM audit_log
  WHERE tenant_id = '<tenant-id>'
    AND entity_type = 'question'
    AND entity_id = '<entity-id>'
  ORDER BY at DESC;"
```

---

## 19. Audit-log wiring — 09-scoring (G3.D slice, 2026-05-11)

Admin-triggered score mutations in `modules/09-scoring` write one `audit_log` row inside the same `withTenant` transaction as the mutation, through `auditInTx`. This mirrors the G3.D template from `eff0ba2` (§ 15).

### 19.1 Wired sites and action namespaces used

| Service function | `audit_log.action` | `entity_type` | Notes |
|---|---|---|---|
| `recomputeOnOverride()` | `attempt_scores.recomputed_by_admin` | `attempt_score` | `before` is null on first compute (INSERT-only; no prior row). `after` captures the score delta. Triggered when an admin grading override causes a score-rollup recompute. |

- `ACTION_CATALOG` addition: `attempt_scores.recomputed_by_admin`, appended in `modules/14-audit-log/src/types.ts` (`b82e82d`).
- Not audited on purpose: `refreshMaterializedView` (operational scheduling, not admin-triggered), BullMQ worker writes, and internal recomputes triggered by upstream data changes.
- Source: `b82e82d`, `modules/09-scoring/src/service.ts`.

---

## 20. Stage 3 watch cron (Phase 2 G3 diagnostic — live 2026-05-10)

> **Read this when:** you investigate a Stage 3 quality regression, or you check whether a threshold breach is recorded.

A read-only systemd timer aggregates `generation_attempts` metrics. It alerts when smoke-campaign quality drops below the thresholds. It is **alert only, with no auto-rollback** (locked decision: `docs/design/2026-05-10-stage-3-promotion-rollout.md` §8 Q4).

### 20.1 Systemd units

| File | Role |
|---|---|
| `infra/systemd/assessiq-stage3-watch.timer` | `OnCalendar=hourly`, `Persistent=true`. At Stage 3.3+ edit to `OnCalendar=daily` (and update `--window 24h` in the service). |
| `infra/systemd/assessiq-stage3-watch.service` | `Type=oneshot`, `User=root`. `ExecStart`: `docker exec -w /app assessiq-api pnpm exec tsx /app/tools/stage3-watch.ts --window 1h`. `SuccessExitStatus=0 1` — exit 1 (breach detected) does NOT mark the unit failed; exit 2 (DB error) does. |

The `tools/` directory is bind-mounted into the container as `/app/tools:ro` (`infra/docker-compose.yml`, `a124812`). A `git pull` on the VPS therefore picks up script changes without an image rebuild.

### 20.2 Metrics and breach thresholds

Script: `tools/stage3-watch.ts` (initial: `05ea435`; path fix: `a124812`). It aggregates from `generation_attempts WHERE chunks_planned IS NOT NULL` (sharded runs only) within the look-back window:

| Metric | Derived from | Breach condition |
|---|---|---|
| `chunks_failed_rate` | `SUM(chunks_failed) / SUM(chunks_planned)` | `> 0.25` (more than 25% of planned chunks failed) |
| `citation_dropped_total` | `SUM(citation_dropped)` | `> 0` (any citation-validation drop) |

### 20.3 Output channels

| Channel | Content |
| --- | --- |
| Stdout (every run) | One JSON line `{ stage3_watch, breach, breach_reasons, metrics }`. The systemd journal captures it |
| `/var/log/assessiq/stage3-watch.log` (breach only) | Appends `{ ts, headline, metrics }`. Env override: `STAGE3_WATCH_LOG` |
| Stderr (breach, interactive) | A human-readable breach summary |
| Exit codes | **0:** clean. **1:** breach logged. **2:** DB error or missing `DATABASE_URL` |

### 20.4 Triage runbook — "stage3-watch.log has a breach entry"

```bash
# Latest breach entries
tail -5 /var/log/assessiq/stage3-watch.log | jq

# Sharded attempts in the breach window
docker exec -it assessiq-postgres psql -c "
  SELECT id, started_at, chunks_planned, chunks_failed, citation_dropped
  FROM generation_attempts
  WHERE chunks_planned IS NOT NULL
  ORDER BY started_at DESC LIMIT 10;"

# If citation_dropped > 0 — which attempts dropped questions?
docker exec -it assessiq-postgres psql -c "
  SELECT id, status, chunks_failed, citation_dropped, stderr_tail
  FROM generation_attempts
  WHERE citation_dropped > 0
  ORDER BY started_at DESC LIMIT 5;"
```

Rollback is a deliberate operator action after root-cause analysis. It is never automatic.

---

## 21. Per-chunk stderr aggregation (Phase 2 G2.B — live 2026-05-10)

When the sharded fan-out runs several chunk subprocesses, `generation_attempts.stderr_tail` aggregates the stderr of all failing chunks. Before, the column held data only on a whole-attempt failure. A chunk-level failure left it NULL.

### 21.1 Column contract

| Item | Rule |
| --- | --- |
| Header for each chunk | `--- chunk: <type> ---` (for example `--- chunk: scenario ---`) |
| Size | The last 1024 bytes across the stderr of all failing chunks, concatenated and then sliced |
| SIGTERM or timeout path | The subprocess is killed before stderr flushes, so the content is `(none)`. The text `--- chunk: scenario ---\n(none)\n` proves that the aggregation code is live (verified on attempt `019e103c`) |
| Successful chunks | They do not contribute. Only chunks with `exit_code != 0` or SIGTERM contribute |
| Source | `b7e5552`, `modules/07-ai-grading/src/handlers/admin-generate.ts` |

### 21.2 Reading

```bash
# Via the inspect-attempt helper (preferred)
docker exec -w /app assessiq-api \
  pnpm exec tsx /app/tools/inspect-attempt.sh --show-stderr <attempt-uuid>

# Directly from DB
docker exec -it assessiq-postgres psql -c "
  SELECT stderr_tail
  FROM generation_attempts
  WHERE id = '<attempt-uuid>';"
```

`NULL` in `stderr_tail` on a partial-failure attempt means the attempt is older than `b7e5552` (before 2026-05-10).

---

## 22. MCP rejection logger (Stage 3 G2 diagnostic — live 2026-05-10)

Every `isError=true` return from `submit_questions` in the AssessIQ MCP server appends a structured JSONL entry to `/var/log/assessiq/mcp-rejections.log`. This is the primary surface to diagnose model retry loops caused by Zod schema violations.

### 22.1 Entry shape (JSONL)

```jsonc
{
  "timestamp": "2026-05-11T17:45:01.234Z",
  "pid": 1234,
  "type": "scenario",   // inferred from questions[0].type; "unknown" if payload malformed
  "issues": "questions[0].content: Unrecognized key(s) in object: 'stem'",
  "payload_excerpt": "{\"questions\":[{\"type\":\"scenario\",\"stem\":\"...\"...}]}"
                     // first 2 048 chars of the raw payload
}
```

Source: `tools/assessiq-mcp/src/tools/submit-questions.ts` lines 15–37, commit `ab39667`.

### 22.2 Operational notes

- **The write is fire and forget** (`fs.appendFile` callback, never `await`ed). A write failure goes to stderr only. It cannot affect the rejection response that the model sees.
- **Path override:** the `MCP_REJECTION_LOG` env var (used in tests; unset in production, so the default path applies).
- **File owner:** `root`. The MCP server runs inside the container as root (see `ls -la /var/log/assessiq/`).
- **Deploy step:** a change to `submit-questions.ts` needs a rebuild of the MCP dist on the VPS. It also needs a recreate of the `assessiq-api` container, so that the bind-mounted MCP dist picks up the new code. The procedure is in `docs/06-deployment.md` § MCP tool rebuild procedure (`f8f62a2`).
- `mcp-rejections.log` is **not relevant** to the Phase 5 verify route. The verify path does not call the MCP server.

### 22.3 Triage runbook — "grading chunk exits 1 with repeated submit_questions calls"

```bash
# Most recent rejections — type and Zod path
tail -20 /var/log/assessiq/mcp-rejections.log | jq '{ timestamp, type, issues }'

# Rejections in a timestamp window
jq 'select(.timestamp >= "2026-05-12T00:00:00Z")' \
  /var/log/assessiq/mcp-rejections.log

# Count rejections by inferred type
jq -s 'group_by(.type) | map({ type: .[0].type, count: length })' \
  /var/log/assessiq/mcp-rejections.log
```

If `issues` names a forbidden field (for example `Unrecognized key(s) in object: 'stem'`), the fix target is the FORBIDDEN list of the matching `generate-<type>/SKILL.md`. The Zod `.strict()` schema in `submit-questions.ts` is the ground truth. The SKILL.md forbidden lists are documentation and must stay in sync with it.

---

## 23. Runtime baseline — operator artifact (`modules/07-ai-grading/eval/runtime-baseline.json`)

`modules/07-ai-grading/eval/runtime-baseline.json` is the living tracker of AI-grading quality across smoke campaigns. It is the canonical answer to "what is known to be broken right now in generation quality?" Docs and commit messages are not.

### 23.1 Structure

| Key | Content |
| --- | --- |
| `smoke_run` | The most recent representative smoke result (attempt UUID, count, type allocation, exit codes and skill SHAs for each type) |
| `known_gaps[]` | An array of tagged entries. Each starts with `RESOLVED`, `PARTIAL`, `OPEN` or `CONFIRMED LIVE`, followed by a date, a commit citation and a description. Entries are never deleted. The full fix history stays in the file |
| `regression_thresholds` | Minimum acceptable quality metrics for future smoke runs. Update only through a deliberate baseline-refresh commit |
| `next_smoke_targets` | Expected results for the next smoke runs (type allocation, insertion count expectations, wall-clock bounds) |

### 23.2 Operational use

Read the file at the start of any session that touches the AI grading pipeline:

```bash
# What's currently broken?
cat modules/07-ai-grading/eval/runtime-baseline.json \
  | jq '[.known_gaps[] | select(startswith("OPEN") or startswith("PARTIAL"))]'
```

- Update the file after every diagnostic session that resolves or partly resolves a gap. The update is a git commit, so the history is traceable.
- A failure mode that is not in this file has no tracking. Add an `OPEN` entry when you find one.

---

## 24. Phase 5 — credential verify-page surfaces (live 2026-05-11)

The public verify page (`GET /verify/:credentialId`) has two behaviors that matter to operators. Source: `7208008`, `modules/18-certification/src/routes-public.ts`.

### 24.1 HMAC check on every render

- `verifyCertificateSignature` (→ `crypto.timingSafeEqual`) runs on every request that finds a non-revoked certificate. The result sets `status` to `"valid"` or `"tampered"`.
- The `tampered` path renders a red "✗ Invalid Signature" badge and returns HTTP 200.
- **No `audit_log` row is emitted on a signature mismatch.** The route is outside the auth and tenant middleware. It has no `audit()` call on the tampered path (confirmed: `routes-public.ts` lines 326–350, no `audit` import).
- Tamper events are observable only in `request.log`. No field in that log separates a tampered-response 200 from a valid-response 200.

**Status:** open follow-up gap. A `warn`-level structured log line (or an `audit()` call) on `status === "tampered"` would create a durable tamper-detection signal. An `audit()` call needs a new `certificate.tamper_detected` entry in `ACTION_CATALOG`. It is not wired today.

### 24.2 `verification_views` counter

- `certificates.verification_views` increments on each unique (IP, credentialId) view within a 1-hour dedup window (cap: 50 000 entries in-process).
- The increment is **fire and forget**. It uses a separate `withTenant()` transaction with `.catch(() => {})`.
- Operational gap: the dedup map is in-process memory. In a multi-replica deployment, each process would count the same view, and the counter may drift. This is accepted for analytics (plan §13 trap #10, non-critical).

```bash
# View counters for a tenant's certificates
docker exec -it assessiq-postgres psql -c "
  SELECT credential_id, verification_views, issued_at, revoked_at
  FROM certificates
  WHERE tenant_id = '<tenant-id>'
  ORDER BY verification_views DESC LIMIT 20;"
```

### 24.3 OG image endpoints (live 2026-05-13, Phase 5 Session 7)

The verify page exposes two image endpoints for social-share previews:

| Endpoint | Format | Used by |
| --- | --- | --- |
| `GET /verify/:credentialId/og.svg` | SVG (1200×630) | Twitter, Facebook, Mastodon, Slack |
| `GET /verify/:credentialId/og.png` | PNG (1200×630), rasterized through `@resvg/resvg-js` | LinkedIn, which rejects SVG previews |

- Both endpoints share the same lookup and `determineStatus()` path as the HTML route. They need no separate DB query optimization at MVP volumes.
- The PNG render is **synchronous on the request thread**. `resvg-js` is pure Rust and finishes in about 10 ms for each render at 1200×630. No thread-pool offload is needed.
- Both responses set `Cache-Control: public, max-age=3600`, so later fetches within the hour skip the render.
- `og:image` in the head of the verify page HTML always points at the PNG endpoint (absolute URL built from `PUBLIC_BASE_URL`). When `PUBLIC_BASE_URL` is unset (test environments), the page omits the OG meta tags silently. The page still renders, and social previews degrade to title only.
- **Operational note:** no separate counter exists for OG-image fetches. The `verification_views` counter increments on HTML-page views only. Crawlers usually fetch the PNG and SVG endpoints without a paired human page view. Treat `verification_views` as a proxy for click-throughs to the verify page, not as raw social impressions.

## 25. G3.D audit-write sweep — module classification (2026-05-13)

> **Read this when:** you triage which modules need a G3.D audit-write slice and which are exempt on purpose. Sections 15–17 and 19 document the wired modules. This section records the modules classified as **no-op** during the cross-module sweep, so future contributors do not re-open them.

### 25.1 No-op classifications

| Module | Classification | Reason |
|---|---|---|
| [`06-attempt-engine`](../modules/06-attempt-engine/SKILL.md) | **NO-OP** | Every exported service function (`startAttempt`, `saveAnswer`, `toggleFlag`, `recordEvent`, `submitAttempt`, `getAttemptForCandidate`, `listAnswersForAttempt`, `sweepStaleTimersForTenant`) is candidate-driven or system-cron-driven. There is no admin-mutating surface in this module: admins do not start attempts on behalf of candidates, do not save answers, do not toggle flags. Admin-side attempt operations (release, override, force-submit) live in 07-ai-grading and 09-scoring, both of which already have G3.D coverage (§19 for 09; 07 covered by a future slice). `sweepStaleTimersForTenant` runs from a cron and is system-attributed, not admin-attributed — operational `app.log` entries are sufficient and audit_log writes would inflate the trail without a real user actor. |
| [`08-rubric-engine`](../modules/08-rubric-engine/SKILL.md) | **NO-OP** | Service-only module — zero migrations, zero DB access, zero Fastify routes. Exports are pure helpers (`validateRubric`, `sumAnchorScore`, `computeReasoningScore`, `finalScore`) operating on inputs already loaded by the caller. Domain state belongs to 04-question-bank (`questions.rubric` JSONB), so audit writes for rubric edits live in 04 under `question.updated`. Adding a no-op `auditInTx` to 08 would write a duplicate row for every rubric save. |
| [`15-analytics`](../modules/15-analytics/SKILL.md) | **NO-OP** | All service exports are read-only — `homeKpis`, `queueSummary`, `cohortReport`, `individualReport`, `topicHeatmap`, `archetypeDistribution`, `gradingCostByMonth`, plus the four export functions. The `refresh-mv-job.ts` materialized-view refresh is a system cron, not admin-mutating. The one admin-bulk-download surface that *is* audit-relevant — CSV/JSONL attempt exports — is intentionally audited by the *caller* (the admin route handler emits `attempt.exported` per the G3.C catalog entry, line 73 of `modules/14-audit-log/src/types.ts`); 15-analytics' export functions just stream rows. Keeping the audit emit at the route layer matches the same pattern used by 03-users `acceptInvitation` (audit lives at the session-creation step in 01-auth, not in 03's service). |

### 25.2 Modules with G3.D slices still pending

**Status:** the `07-ai-grading` slice was pending when this section was written. <!-- verify --> Section 29 documents it later.

- **`07-ai-grading`**
  - It has 5 admin-mutating handlers (`admin-generate`, `admin-rerun`, `admin-grade`, `admin-override`, `admin-accept`) that write `gradings` rows.
  - Audit-write coverage is deferred to a dedicated session. The module is on the CLAUDE.md load-bearing-paths list (security-adjacent classifier). It needs a `codex:rescue` adversarial review before push.
  - Tracking: the PROJECT_BRAIN backlog.
- **`16-help-system`**: shipped 2026-05-13. See § 26.

### 25.3 Audit "ownership" boundary — when the audit row lives in the *caller*, not the service

A module that *performs* a domain mutation is not always the right place to *audit* it. The audit row belongs where the **actor** is known and where the **business action** is named. Examples in this codebase:

| Case | Where the audit row lives |
| --- | --- |
| CSV/JSONL exports | 15-analytics streams rows. The admin route handler emits `attempt.exported`, because "an admin downloaded a cohort" is the auditable business action. "The streamer wrote bytes" is not |
| Invitation acceptance | `acceptInvitation` in 03-users does the user-row INSERT/UPDATE but emits no audit row. The session-creation trail of 01-auth is the auditable surface ("user X started a session", which implies that acceptance succeeded) |
| Rubric validation | `validateRubric` in 08-rubric-engine runs inside a `question.updated` write path in 04. The rubric helper returns ok or err. The existing audit row of 04 carries the rubric `before/after` snapshot |

When you triage a new module, ask "who is the **actor**?"

- If the actor is a candidate, a system cron or a downstream pure helper, the audit row probably belongs upstream, or does not exist.
- If the actor is an admin who acts on tenant data, the module is a G3.D candidate.

---

## 26. Audit-log wiring — 16-help-system (G3.D slice, 2026-05-13)

Every admin-mutating service method in [modules/16-help-system](../modules/16-help-system/SKILL.md) writes one `audit_log` row inside the same Postgres transaction as the domain mutation, through `auditInTx(client, ...)` from `@assessiq/audit-log`. This mirrors the G3.D template from `eff0ba2` (§ 15) and the 03-users slice in `057de7d` (§ 17). The atomicity guarantee is the same.

### 26.1 Wired sites and action namespaces used

| Service function | `audit_log.action` | `entity_type` | `entity_id` | Notes |
|---|---|---|---|---|
| `upsertHelpForTenant` | `help.content.updated` | `help_content` | Returned row `id` (UUID) | `before` is omitted on first insert (no prior active row); on subsequent upserts `before` snapshots the highest-version active row for that `(tenant_id, key, locale)` before the write. `after` captures the new row's id, help_id, audience, locale, short_text, long_md, version, status. Field is named `help_id` (not `key`) because `redactPayload` in `modules/14-audit-log/src/redact.ts` strips fields matching `/key$/i` — using `key` as the field name would silently redact the value. `short_text` / `long_md` are public-facing copy (not credentials); no redaction helper needed. `created_by` column does NOT exist on `help_content` — no PII leak risk from the schema. |
| `importHelp` | `help.content.imported` | `help_content` | omitted (`null`) | One summary row per bulk import call — not one row per key (same pattern as `bulkImport` in § 15 / `question.imported`). `after`: `{ inserted, skipped, locale, total, keys[] }`. `keys` is capped at 50 entries to keep the JSONB payload bounded. `before` is always omitted (bulk import is append-only: new version rows). `entity_id` is omitted because there is no single target entity — the locale string is in `after.locale`. |

`actor_kind` is always `"user"`. `actor_user_id` is the session userId of the admin, passed through the service signature. This slice gave `upsertHelpForTenant` and `importHelp` a final `actorUserId: string` parameter. The route handlers in `modules/16-help-system/src/routes-admin.ts` (PATCH `/:key` and POST `/import`) now pass `req.session!.userId`.

### 26.2 Action-catalog scope decision

- This slice adds **one** new entry to the G3.A action catalog ([modules/14-audit-log/src/types.ts](../modules/14-audit-log/src/types.ts)): `help.content.imported`.
- It reuses the existing `help.content.updated` (catalog line 71, present before this slice) for `upsertHelpForTenant`. There is no semantic gap. Every `upsertHelp` call in the repository is an INSERT of a new version row (the table is append-only for each version).
- There is no separate `help.content.created` action. `before === null` marks a first insert and `before !== null` marks a later update. This keeps the catalog footprint minimal (same pattern as `restoreVersion → question.updated kind=restore` in QB).
- `help.content.imported` is first-class (not folded under `help.content.updated` with a `kind` marker). Its payload shape differs: a summary row for N keys in one event, not a single-key diff row. A query on `action = 'help.content.imported'` answers "when did an admin bulk-import a locale?" without a parse of `after->>'kind'`.

### 26.3 Atomicity guarantees

- Every audit write uses `auditInTx(client, ...)` inside the same `withTenant(...)` callback that owns the mutation. `withTenant` opens BEGIN and COMMIT. The domain INSERT and the audit INSERT commit or roll back together.
- If `auditInTx` throws (catalog mismatch, RLS denial, FK violation), the surrounding `withTenant` rolls back the domain mutation. This module has no fire-and-forget audit path.
- Failure-injection test in [src/__tests__/audit-writes.test.ts](../modules/16-help-system/src/__tests__/audit-writes.test.ts): "when auditInTx throws inside upsertHelpForTenant, the help_content row is NOT mutated". It mocks `@assessiq/audit-log.auditInTx` to throw once. A superuser read of `help_content` after the rejected call asserts that the row was never committed.
- A coverage-grep assertion at the bottom of the same test file counts `auditInTx(` occurrences in `service.ts` and expects exactly 2. A new admin-mutating method without an audit write fails this guard.

### 26.4 What's NOT audited here

- `recordHelpEvent`: fire-and-forget telemetry (tooltip shown, drawer opened, feedback thumbs). It is not an admin mutation. The actor is a candidate or an anonymous user. Telemetry writes to `app.log` (pino) only, per the Phase 1 deferral decision #16 in [SKILL.md](../modules/16-help-system/SKILL.md). An upgrade to `audit_log` writes is a future Phase 3 sub-slice, not this one.
- `getHelpForPage`, `getHelpKey`, `exportHelp`: read-only. They write only to the operational `request.log`. `exportHelp` is a GET route and a read-only bulk fetch for the translation workflow.
- Global (tenant_id IS NULL) seed rows:
  - The Postgres superuser inserts them through the post-migration seed (`modules/16-help-system/seeds/help_content.sql`, run by `tools/migrate.ts`).
  - Log events: `seed.applied`, `seed.failed`, and `seed.list` on `--dry-run`.
  - They are outside the INSERT policy of the `assessiq_app` role on purpose.
  - No audit row is emitted for seed inserts. They are a deploy-time event, not an admin-actor event.

## 27. Audit-log wiring — 13-notifications webhooks (G3.D slice, 2026-05-11)

Every admin-mutating service method on the **webhook-config surface** of [modules/13-notifications](../modules/13-notifications/SKILL.md) writes one `audit_log` row inside the same Postgres transaction as the domain mutation, through `auditInTx(client, ...)` from `@assessiq/audit-log`. This mirrors the G3.D template from `eff0ba2` (§ 15). The atomicity guarantee is the same.

Boundary: only the admin config endpoints (create or delete an endpoint, replay a past delivery) are audited. The delivery-tracking paths (`emitWebhook`, `emitWebhookToEndpoint`, BullMQ `deliver-job`) write to `webhook.log` only. They are operational telemetry that fires from other audited mutations. They are not admin config decisions.

### 27.1 Wired sites and action namespaces used

| Service function | `audit_log.action` | `entity_type` | `entity_id` | Notes |
|---|---|---|---|---|
| `createWebhookEndpoint` | `webhook.created` | `webhook_endpoint` | New endpoint UUID | `before` omitted — INSERT, no prior state. `after`: `name`, `url`, `events[]`, `requires_fresh_mfa`. The HMAC signing secret is NEVER logged (`signing_secret_enc` column is excluded from the payload). |
| `deleteWebhookEndpoint` | `webhook.deleted` | `webhook_endpoint` | Endpoint UUID | `before` snapshots `name`, `url`, `events[]`, `status` via `getWebhookEndpointById` immediately before the DELETE inside the same tx. `after` omitted — DELETE. Used for "who removed which webhook target". |
| `replayDelivery` | `webhook.replayed` | `webhook_delivery` | ID of the **original** delivery being replayed | `after`: `new_delivery_id`, `original_delivery_id`, `endpoint_id`, `event`. `before` omitted — replay is a new transmission, not a state mutation on the original row. The new delivery row itself gets its own lifecycle entries in `webhook.log`; this audit row is the admin-action receipt. |

`actor_kind` is `"user"` when the route handler supplies `actorUserId`. It is `"system"` when the caller is internal (for example a system-initiated webhook secret rotation). All three functions take an optional `actorUserId` parameter, passed through from the admin route handlers in `apps/api/src/routes/admin-webhooks.ts`. System callers omit it, and the audit row is attributed accordingly.

### 27.2 Action-catalog scope decision

This slice adds **0** new entries. `webhook.created`, `webhook.deleted`, `webhook.replayed` and `webhook_secret.rotated` were all added to [modules/14-audit-log/src/types.ts](../modules/14-audit-log/src/types.ts) at G3.A ship time, as part of the foundational webhook event surface (lines 66–69). `webhook_secret.rotated` is reserved for a future rotation slice. It is in the catalog, but no service function emits it yet.

### 27.3 Atomicity guarantees and the circular-dependency dodge

- Every audit write uses `auditInTx(client, ...)` inside the same `withTenant(...)` callback that owns the mutation. The domain INSERT, UPDATE or DELETE and the audit INSERT commit or roll back together.
- `@assessiq/audit-log` is imported **statically** from `13-notifications/src/webhooks/service.ts`. This is safe because the reverse direction (audit-log → notifications) uses a **dynamic import** in `modules/14-audit-log/src/webhook-fanout.ts`. The dynamic import breaks what would be a static circular dependency between the two modules.
- Failure-injection tests are in [src/__tests__/audit-writes.test.ts](../modules/13-notifications/src/__tests__/audit-writes.test.ts). The file has 19 audit-related call sites: a happy path for each action, an atomicity case for each action, and payload-shape assertions. A coverage-grep at the bottom of the file asserts that `auditInTx(` occurs exactly 3 times in `webhooks/service.ts`.

### 27.4 What's NOT audited here

- `emitWebhook` and `emitWebhookToEndpoint`: they queue deliveries in response to state changes in other modules (for example `attempt.submitted` fanout). The audit trail for *why* the webhook fired lives on the audit row of the originating action. A `webhook.dispatched` row for each delivery would inflate the audit trail by orders of magnitude. It would answer no compliance question that the originating row does not already answer.
- BullMQ `deliver-job` (the worker that POSTs the HTTP request and records the HTTP status): purely operational. The outcome lands in `webhook.log` and the `webhook_deliveries` table.
- Email sending (`sendEmail`, `sendAssessmentInvitationEmail`, candidate magic-link emails): the Phase 1 dev fallback writes to `dev-emails.log`. Production routes through Brevo SMTP (`SMTP_URL`, see `docs/06-deployment.md`). The send follows an already audited admin action (for example `assessment.invite`). A second audit row at the email layer adds no compliance signal.
- In-app notifications (`createInAppNotification`): they are user-facing pings, not state changes that auditors need. They persist in `in_app_notifications`. The notification row itself is the lifecycle.

## 28. Audit-log wiring — 18-certification (G3.D slice + Phase 5 Sessions 1/5/6)

Every admin-mutating service method in [modules/18-certification](../modules/18-certification/SKILL.md), and the candidate-lifecycle issuance and upgrade, writes one `audit_log` row inside the same Postgres transaction as the domain mutation, through `auditInTx(client, ...)`. The wiring shipped in steps across Phase 5: issue and upgrade in Session 1 (`1402`/`6ab8e90` era), revoke and reissue in Session 5 (`190acee`). The atomicity guarantee is the same as in § 15.

Certificates carry HMAC integrity signatures (see [modules/18-certification/SKILL.md § Cryptography](../modules/18-certification/SKILL.md) and `docs/plans/archive/CERTIFICATION_PLAN_GENERIC.md`). The audit row is the **administrative receipt** for the lifecycle event. The HMAC `signed_hash` on the `certificates` row is the **cryptographic receipt** for the certificate payload. Both are required. Neither replaces the other.

### 28.1 Wired sites and action namespaces used

| Service function | `audit_log.action` | `entity_type` | `entity_id` | Trigger | Notes |
|---|---|---|---|---|---|
| `issueCertificate` | `certification.cert.issue` | `certificate` | New cert UUID | Candidate completes a passing attempt → admin sync grades it → certificate row inserted | `after`: `credential_id` (the public-facing 26-char base32 ID), `tier` (`completion` \| `distinction` \| `honors`), `candidate_id`, `attempt_id`. `before` omitted — INSERT. `actor_user_id` is the **admin** who clicked "Issue" (Phase 1 single-admin model), not the candidate. |
| `upgrade` | `certification.cert.upgrade` | `certificate` | Existing cert UUID (id changes only if the upgrade re-issues; `credential_id` stays stable per CLAUDE.md "stable shared URL" invariant) | Candidate's tier improves on a later attempt (e.g. completion → distinction) | `before`: `{ tier: existing.tier }`. `after`: full `credential_id`, new `tier`, `candidate_id`, `attempt_id`. Distinct action (not `cert.updated`) because tier upgrades are a compliance-significant lifecycle event auditors search for explicitly. The TOCTOU concern was resolved in Phase 5 Session 2 R3 fix (see RCA log 2026-05-11). |
| `revokeCertificate` | `certificates.revoked` | `certificate` | Cert UUID | Admin clicks "Revoke" on the certificates admin page (`/admin/certificates`) | `before`: `{ revoked_at: null, revoke_reason: null }`. `after`: `revoked_at`, `revoke_reason`. The `revoke_reason` is admin-supplied free text; not redacted because it's already admin-authored and may be needed in the audit trail. |
| `reissue` | `certificates.reissued` | `certificate` | Cert UUID | Admin re-signs a cert after a `display_name` correction (typo fix, legal-name change) | `before`: `{ display_name: cert.display_name }`. `after`: `{ display_name: newDisplayName }`. The cert's `credential_id` and `issued_at` are preserved by invariant — reissue is a snapshot refresh, not a new issuance (see RCA log 2026-05-11 "Revoke is a state flag; reissue preserves credential_id + issued_at invariant"). |

`actor_kind` is always `"user"` for all four sites. Every certificate lifecycle event in Phase 5 has a known admin actor (issuance through the admin grading flow, revoke and reissue through explicit admin clicks). There is no `system` certificate-lifecycle path.

### 28.2 Action-catalog scope decision and the naming-style inconsistency

This module added **4** entries to the G3.A action catalog (lines 82–86 of [modules/14-audit-log/src/types.ts](../modules/14-audit-log/src/types.ts)):

- `certification.cert.issue` (Phase 5 Session 1)
- `certification.cert.upgrade` (Phase 5 Session 1)
- `certificates.revoked` (Phase 5 Session 5; see memory observation 1750, added 2026-05-12)
- `certificates.reissued` (Phase 5 Session 5)

**Status:** the naming-style inconsistency is known and not fixed.

- The issue and upgrade pair uses `certification.cert.*` (module.entity.verb). The revoke and reissue pair uses `certificates.*` (entity_plural.past-tense-verb).
- Session 1 (issue and upgrade: domain-modeled actions) and Session 5 (revoke and reissue: admin-operation-modeled actions) caused it.
- Both styles exist elsewhere in the catalog (`user.created` vs `tenant_settings.ai_generate_mode.updated`), so neither is wrong.
- A consolidation would be a catalog-only rename plus a one-line UPDATE for any deployed audit rows in dev.
- It is tracked as a Phase 5 polish item, not a load-bearing rename. Append-only catalogs tolerate stylistic variation by design.

### 28.3 Atomicity guarantees

- Every audit write uses `auditInTx(client, ...)` inside the same `withTenant(...)` callback that owns the mutation. The certificate INSERT or UPDATE and the audit INSERT commit or roll back together. If the audit row fails (catalog mismatch, RLS denial), the certificate mutation fails too. There is no orphan-certificate path.
- For `issueCertificate`, `upgrade` and `reissue`, the transaction recomputes and stores the `signed_hash` HMAC on the certificate row. Revoke leaves the original signature intact, because revocation is a state flag, not a payload change. The three writes therefore have a triple invariant: audit row, HMAC signature and certificate row are atomic.
- Failure-injection tests are in `modules/18-certification/src/__tests__/`:
  - `service.test.ts`: happy-path audit rows for each lifecycle event.
  - `admin-revoke.test.ts`: revoke-specific audit-row assertions.
  - `admin-reissue.test.ts`: reissue-specific audit-row assertions and the credential_id-preservation invariant.
- No coverage-grep assertion is wired today (the module predates the §15/§17/§26 pattern). The 4 call sites in `service.ts` are stable. A future contributor who adds a lifecycle method without an audit row fails the atomicity assertions of the test suite.

### 28.4 What's NOT audited here

- `getCertificateByCredentialId`, `findCertificatesByCandidate`, `listAdminCertificates`: read paths. No state change.
- `verifyCertificateSignature`: pure HMAC verification, no DB I/O.
- `renderCertificatePdf`: PDF generation. The output is bytes, not state.
- `incrementCounter` (linkedin_shares, pdf_downloads, verification_views): fire-and-forget engagement counters, not audited on purpose per Phase 5 plan §13. Counter writes use UPDATE-as-statement (not read-modify-write) and tolerate row-level lock contention by design. Counter values are analytics, not a compliance signal.
- `POST /api/certificates/:credentialId/share-linkedin`: it calls `incrementCounter('linkedin_shares')` only. The certificate state does not change. The sharer is the certificate owner (known from the certificate row). No audit row.
- The public verify page (`GET /verify/:credentialId`): a public read path that increments `verification_views`. The actor is anonymous. No audit row. The tamper detection signal here lives in `app.log` only (see § 18.1 in the credential-verify surface area).

## 29. Audit-log wiring — 07-ai-grading (G3.D slice, Phase 2 G2.A — backfilled doc 2026-05-13)

Every admin-mutating handler in [modules/07-ai-grading](../modules/07-ai-grading/SKILL.md) writes one `audit_log` row inside the same Postgres transaction as the domain mutation, through `auditInTx(client, ...)`. The wiring shipped in steps with the original Phase 2 G2.A grading-pipeline build (2026-05-03, `971` era) and the per-handler admin endpoints. This section is the doc backfill. The code was live for weeks before it. This section captures the contract.

- The module is on the [CLAUDE.md load-bearing-paths list](../CLAUDE.md). `modules/07-ai-grading/**` is a security-adjacent classifier surface.
- Audit-row atomicity here is **load-bearing** for the compliance frame in [docs/05-ai-pipeline.md § Compliance frame](./05-ai-pipeline.md). Every Phase 1 grading-pipeline write must meet three rules:
  - It is admin-attributable (`actor_user_id` filled, never `system`).
  - It rolls back together with the domain mutation.
  - It references the prompt-version SHA on the certificate.
- `gradings.graded_by`, `gradings.prompt_version_sha` and `audit_log.actor_user_id` are the **three-way receipt** that the inference ran inside the human-in-the-loop boundary.

### 29.1 Wired sites and action namespaces used

| Handler file | Service function | `audit_log.action` | `entity_type` | `entity_id` | Notes |
|---|---|---|---|---|---|
| [`handlers/admin-accept.ts:201`](../modules/07-ai-grading/src/handlers/admin-accept.ts) | `handleAdminAccept` → `acceptProposals` | `grading.accepted` | `attempt` | `attemptId` | **One summary row per accept batch** (mirrors `help.content.imported` precedent — N `gradings` INSERTs, one audit row summarising the batch, not N rows). `after`: `attempt_id`, `grading_count`, `grading_ids[]` (capped at 50), `attempt_status_now: "graded"`. `before` omitted — attempt status change from `submitted`/`pending_admin_grading` to `graded` is part of the summary's implicit context. This is D8 ("Accept before commit"): the audit row is the receipt that the admin clicked Accept. |
| [`handlers/admin-claim-release.ts:169`](../modules/07-ai-grading/src/handlers/admin-claim-release.ts) | `handleAdminClaimAttempt` | `grading.claimed` | `attempt` | `attemptId` | **Conditional emit**: only fires when `wasClaimed === true` (the UPDATE actually transitioned `submitted → pending_admin_grading`). Idempotent second-claim by the same admin is a no-op and writes no audit row — repeated audit rows for a no-op would inflate the trail and answer no compliance question. `before: { attempt_status: 'submitted' }`, `after: { attempt_status: 'pending_admin_grading' }`. |
| [`handlers/admin-claim-release.ts:241`](../modules/07-ai-grading/src/handlers/admin-claim-release.ts) | `handleAdminReleaseAttempt` | `grading.released` | `attempt` | `attemptId` | `before: { attempt_status: 'graded' }`, `after: { attempt_status: 'released' }`. Release is the candidate-visible state flip; the audit row is the compliance receipt for "who made this attempt visible to the candidate, when." |
| [`handlers/admin-override.ts:111`](../modules/07-ai-grading/src/handlers/admin-override.ts) | `handleAdminOverride` | `grading.override` | `grading` | `newRow.id` | `after.new_grading_id` carries the new gradings row's id; the original row's `id` lives in `override_of` on the new row (audit-traceable forward and backward). G3.D atomicity fix: the audit write was previously out-of-transaction; it now commits inside the same `withTenant` as the gradings INSERT. **PII policy (2026-05-13 follow-up):** `override_reason` is free-text admin input and is **NOT** placed in the audit row's `after` payload. The full reason is preserved in `gradings.override_reason` (the immutable D8 INSERT row). Auditors pivot `audit_log.entity_id` → `gradings.id` to read the reason. Keeps `audit_log` free of unbounded free-text PII while preserving forensic traceability via the FK chain. **Retention alignment (V2 from the same adversarial review):** the pivot only resolves while the `gradings` row is reachable. Any future retention sweep that hard-deletes `gradings` rows MUST run on a window ≥ the `audit_log` retention window, or `grading.override` audit rows will outlive their justification chain. Neither table has a retention policy as of 2026-05-13; this paragraph is the load-bearing constraint that the future retention design must satisfy. |
| [`handlers/admin-rerun.ts:262`](../modules/07-ai-grading/src/handlers/admin-rerun.ts) | `handleAdminRerun` | `grading.retry` | `attempt` | `attemptId` | Fires when the admin re-runs the cascade after a failed or `review_needed` proposal. `after` carries `attempt_id`; the new proposal lands via the standard `admin-accept` path which writes its own `grading.accepted` audit row — re-runs that aren't accepted leave the previous gradings row untouched (the `grading.retry` row is the only trace). |
| [`handlers/admin-generate.ts:578`](../modules/07-ai-grading/src/handlers/admin-generate.ts) (per-chunk) | `handleAdminGenerate` (sharded path, chunk-success branch) | `question.ai_generated` | `question` | omitted | One audit row per successful generated-question batch chunk (sharded mode). `after` carries `generation_attempt_id`, `pack_id`, `level_id`, `question_type`, `question_count`. **Not folded under `question.created`** because AI-generated questions and admin-authored questions answer different compliance questions ("did AI produce this?" vs "did an admin manually write this?"). |
| [`handlers/admin-generate.ts:672`](../modules/07-ai-grading/src/handlers/admin-generate.ts) (per-chunk, retry path) | `handleAdminGenerate` (retry-success branch) | `question.ai_generated` | `question` | omitted | Same shape as line 578; fired when a retry of a previously-failed chunk succeeds. |
| [`handlers/admin-generate.ts:839`](../modules/07-ai-grading/src/handlers/admin-generate.ts) (non-sharded) | `handleAdminGenerate` (single-shot, non-sharded mode) | `question.ai_generated` | `question` | omitted | Same shape; fired in the legacy single-shot generation path (pre-Stage-3-sharded default). |

`actor_kind` is always `"user"` for every site. Phase 1 grading is **single-admin-in-the-loop** per the compliance frame. No `system`-attributed grading-pipeline write exists. `actor_user_id` is the session userId of the admin, passed through every handler input (`HandleAdminAcceptInput.userId`, `HandleAdminClaimAttemptInput.userId`, and so on). The Fastify route boundary sets it. Downstream code never rebuilds it.

### 29.2 Action-catalog scope decision

The catalog adds **6** entries for this module (line numbers refer to [modules/14-audit-log/src/types.ts](../modules/14-audit-log/src/types.ts)):

- `grading.override` (line 54, G3.A; existed, reused)
- `grading.retry` (line 55, G3.A; existed, reused)
- `grading.accepted` (line 67, G3.D)
- `grading.claimed` (line 68, G3.D)
- `grading.released` (line 69, G3.D)
- `question.ai_generated` (line 74, G3.D)

| Item | Detail |
| --- | --- |
| `question.ai_generated` | First-class on purpose (not `question.created kind=ai_generated`). Auditors search for AI-generated content as a compliance question separate from manual authoring. The actor and the payload shape both differ |
| Other five `grading.*` entries | They follow the naming pattern of G3.A `grading.override` and `grading.retry`. Rejected: consolidation into `grading.lifecycle kind=*`. The lifecycle events have distinct compliance weight ("who graded" is not "who claimed" and not "who released to candidate") |

### 29.3 Atomicity guarantees

- Every audit write uses `auditInTx(client, ...)` inside the same `withTenant(...)` callback that owns the mutation. The gradings INSERT or UPDATE, the attempts status UPDATE, the generated-questions INSERTs and the audit INSERT commit or roll back together.
- `admin-accept.ts` writes N `gradings` rows, 1 attempts UPDATE and 1 audit row in one transaction.
  - If `auditInTx` throws (catalog mismatch, RLS denial, FK violation, idempotency-key collision on the audit table), the gradings INSERTs AND the attempt status flip roll back.
  - This is the load-bearing case. A graded attempt without its audit row would be a compliance hole.
- `admin-generate.ts` writes N `questions` rows, 1 `generation_attempts` row and 1 audit row for each chunk.
  - Atomicity is per chunk. A 3-chunk sharded run that fails on chunk 2 leaves the questions and the audit row of chunk 1 committed.
  - This is intentional. Retry can recover partial progress.
- The claim site in `admin-claim-release.ts` is **conditional**. The audit row fires only when the UPDATE changed the row. The release site is unconditional: if the UPDATE matched zero rows (release of an already released attempt), the handler throws before it reaches `auditInTx`.
- The coverage-grep guard in [src/__tests__/audit-writes.test.ts](../modules/07-ai-grading/src/__tests__/audit-writes.test.ts) asserts the exact `auditInTx(` count per file: `admin-accept.ts`=1, `admin-claim-release.ts`=2, `admin-override.ts`=1, `admin-rerun.ts`=1, `admin-generate.ts`=3 (total = 8). A new admin-mutating handler without an audit write fails this guard.

### 29.4 What's NOT audited here

- **`gradeSubjective(input)`**: the runtime entry point that the cascade calls. It returns a `GradingProposal` and **never writes** to the DB. Phase 1 compliance means "admin clicks Accept before commit". The proposal is the *recommendation* of the AI, not a state change. The audit row that matters is on `admin-accept` (the human-in-the-loop confirmation), not on the proposal generation.
- **`handleAdminGrade`**: it returns proposals to the admin UI and **never writes**. The reasoning is the same as above. The grading-pipeline lint at `ci/lint-no-ambient-claude.ts` enforces that only an authenticated admin Fastify route can invoke this handler. No ambient invocation path can bypass the Accept step.
- **`handleAdminBudget`, `handleAdminQueue`, `handleAdminGradingJobs`**: read-only admin pages.
- **Per-chunk stderr aggregation and the sharded generation diagnostic**: operational telemetry only. It writes to `grading.log` and `mcp-rejections.log` (see § 21, § 22). The audit row already names the admin who triggered the generation (one row for each successful chunk). The operator workflow surfaces failed chunks, not the audit trail.
- **Skill SHA drift detection**: a Phase 1 admin-UI badge. The skill SHA is recorded on every `gradings` row (`prompt_version_sha`). The `entity_id` chain from the audit row to `attempt` or `grading` lets an auditor pivot from "who clicked accept" to "which skill SHA was active" without a separate audit entry.
- **The `ci/lint-no-ambient-claude.ts` build check**: static-source enforcement that fires at PR time. Per CLAUDE.md it is doubly load-bearing (`codex:rescue` to modify). It is the *gate* on the ambient-AI invariant, not a runtime audit row.

## 30. Audit-log wiring — 02-tenancy (G3.D slice, 2026-05-14)

Every admin-mutating function in [modules/02-tenancy/src/service.ts](../modules/02-tenancy/src/service.ts) writes one `audit_log` row inside the same Postgres transaction as the domain mutation, through `auditInTx(client, ...)`. The module is on the [CLAUDE.md load-bearing-paths list](../CLAUDE.md). `modules/02-tenancy/**` owns RLS policies and tenant context. Audit-row atomicity here is load-bearing for the multi-tenancy compliance boundary.

### 30.1 Wired sites and action namespaces used

| Function | `audit_log.action` | `entity_type` | `entity_id` | `actor_kind` | Notes |
|---|---|---|---|---|---|
| `updateTenantSettings` | `tenant.settings.updated` | `tenant_settings` | `tenantId` | `user` if `actorUserId` supplied, else `system` | `before` = snapshot of current `tenant_settings` row (FOR UPDATE lock prevents TOCTOU race); `after` = the patch object. Sensitive fields (branding URLs, webhook URLs) pass through; callers must not log the patch contents at INFO per CLAUDE.md rule #4. |
| `suspendTenant` | `tenant.suspended` | `tenant` | `tenantId` | `user` if `actorUserId` supplied, else `system` | `after: { status: "suspended", reason }`. `before` omitted — `suspended` state is terminal from the caller's perspective. The `reason` field is admin-supplied free text; it is included in the audit `after` payload because it is the compliance signal ("why was this tenant suspended?") and has no candidate-PII exposure. |
| `updateAiGenerateMode` | `tenant_settings.ai_generate_mode.updated` | `tenant_settings` | `targetTenantId` | always `user` | Super-admin-only path. `before: { ai_generate_mode: previous }`, `after: { ai_generate_mode: newMode }`. Returns `auditRow.id` to caller for receipt. `actorUserId` is the super_admin's UUID, enforced at the API route boundary before calling this function. |

### 30.2 Atomicity guarantees

- All three functions call `auditInTx(client, ...)` inside the same `withTenant(tenantId, async (client) => { ... })` callback that owns the domain mutation. `withTenant` wraps the callback in `BEGIN` and `COMMIT`. On a callback exception it calls `ROLLBACK` and rethrows.
- If `auditInTx` throws (catalog mismatch, RLS denial, FK violation), the domain mutation (UPDATE to `tenant_settings`, UPDATE to `tenants.status`) rolls back atomically. This prevents the ghost-write failure mode: a suspended tenant whose suspension has no audit trail.
- `updateTenantSettings` issues a `SELECT ... FOR UPDATE` before the `UPDATE`. This locks the settings row inside the transaction. It prevents a TOCTOU race between the pre-read (captured as `before`) and the UPDATE when concurrent admin calls race on the same tenant.

### 30.3 Action-catalog scope decision

Two actions were added for this module (lines refer to [modules/14-audit-log/src/types.ts](../modules/14-audit-log/src/types.ts)). The list shows three entries, because one existed before and one is reused:

- `tenant.settings.updated` (line 28, existed in the G3.A catalog; reused)
- `tenant.suspended` (line 30, added G3.D 2026-05-14)
- `tenant_settings.ai_generate_mode.updated` (line 99, existed for the super-admin path; reused)

`tenant.suspended` is separate from `tenant.settings.updated` on purpose. A suspension is a lifecycle event with distinct compliance weight (billing, legal hold, admin-attributable freeze) and a different `entity_type` (`tenant` vs `tenant_settings`). Rejected: folding it into `settings.updated`. Auditors who search for suspension events need one discriminating action, not a filter on `after.status`.

### 30.4 Test coverage

[modules/02-tenancy/src/__tests__/audit-writes.test.ts](../modules/02-tenancy/src/__tests__/audit-writes.test.ts) provides:

- **Static structural tests (Section A):**
  - A coverage-grep asserts exactly one `auditInTx(` call site in each function body.
  - It asserts that the action string exists in `ACTION_CATALOG`.
  - It asserts that each wired function body references both `withTenant` and `auditInTx` (structure-level atomicity guard).
  - A regression guard checks that the old fire-and-forget `audit()` pattern did not return.
- **Live integration tests (Section B):** a testcontainer with real Postgres. The full 02-tenancy, 03-users (020_users.sql only) and 14-audit-log migration chain is applied in order.
  - Happy-path tests verify the `before`/`after` payload shape and `actor_kind` on the written row.
  - Atomicity tests use `ALTER TABLE audit_log ADD CONSTRAINT CHECK (false) NOT VALID` to cause a real DB error on the `auditInTx` INSERT. Then they assert that the domain mutation rolled back. `NOT VALID` is required, because the happy-path tests already wrote rows. A plain `CHECK (false)` would fail with "is violated by some row."

### 30.5 What's NOT audited here

- `getTenantById`, `getTenantBySlug`, `listActiveTenantIds`: read paths or system-role queries that do not mutate state.
- RLS policy enforcement itself: Postgres enforces it. Operator visibility comes from the `pg_audit` extension if enabled on the VPS, not from `audit_log`. (This bullet sat at the end of § 31.7 in an earlier revision. It belongs here.)

---

### 30.6 `tenant.provisioned` (RV59, 2026-10-03, commit `5e5aaa3`)

| Item | Detail |
| --- | --- |
| What | `createTenant` writes one `audit_log` row: action `tenant.provisioned`, `entity_type` `tenant`, `entity_id` the new tenant id, `actor_kind` `user`, actor = the calling super admin. `after = { slug, name }`. The sanitizer redacts `name`. The row lives in the audit log of the NEW tenant, the same rule as `suspendTenant`. It is written with `auditInTx` inside the same transaction that creates the tenant, so a failed audit rolls the tenant back |
| Why | The function ignored its super-admin id and wrote no audit row. The project rule is one audit row for each admin mutation, in the same transaction |
| Rejected | Moving the `tenant.created` row of the route into the service. That row has a different scope and a failure twin, and callers depend on it |
| Not included | The later `tenant.created` row of the route and its failure row are unchanged. One company creation now produces two success rows. `tenant.provisioned` is added to `ACTION_CATALOG` (`modules/14-audit-log/src/types.ts`) |
| Impact | Audit viewers and exports show a new action. Test: `modules/02-tenancy/src/__tests__/audit-writes.test.ts` |

### 30.7 Worker routes are super admin only (FR17, 2026-10-03, commit `59a4816`)

`/api/admin/worker/*` (section 13) now uses `authChain({ roles: ['super_admin'] })` in `apps/api/src/server.ts`. All tenants share the queue, so tenant admins no longer read or retry its jobs. No screen uses these routes. See 03, worker routes.

## 31. Lighthouse CI (Phase 14 — frontend quality gate)

**Status:** advisory. The CI job is not a required check (see § 31.6 and § 31.7).

Lighthouse CI runs on every pull request against the `main` branch through `.github/workflows/lighthouse.yml`. It audits **5 unauthenticated routes** of `apps/web`. These are the only pages that render meaningfully without a session.

### 31.1 What is checked

| Category | Minimum score |
|---|---|
| Performance | ≥ 0.90 (90) |
| Accessibility | ≥ 0.90 (90) |
| Best practices | ≥ 0.90 (90) |
| SEO | ≥ 0.90 (90) |

The PWA category is omitted on purpose. AssessIQ is not a PWA.

### 31.2 Routes covered

| URL | Route in App.tsx | Notes |
|---|---|---|
| `http://localhost:4173/admin/login` | `/admin/login` — `<AdminLogin>` | Main entry point for admins |
| `http://localhost:4173/candidate/login` | `/candidate/login` — `<CandidateLogin>` | Magic-link entry for candidates |
| `http://localhost:4173/take/expired` | `/take/expired` — `<Expired>` | Expired take-link page (also in `a11y.spec.ts`) |
| `http://localhost:4173/take/error` | `/take/error` — `<ErrorPage>` | Take-flow error page (also in `a11y.spec.ts`) |
| `http://localhost:4173/this-is-not-a-page` | `*` — `<NotFound>` | 404 page (also in `a11y.spec.ts`) |

Auth-seeded routes (admin dashboard, candidate certificates, attempt pages) are **not covered here**. They need Playwright session fixtures and are a separate P14 sub-item.

Routes NOT included, and why:

| Route | Reason |
| --- | --- |
| `/` | It redirects to `/admin/login` through `<Navigate replace />`. Lighthouse would score the redirect target and duplicate the admin-login run |
| `/admin/*` protected routes | All are wrapped in `<RequireSession role="admin">`. Without a valid session they redirect to `/admin/login` |
| `/take/:token` | A real token is required. Without one, the page shows an error state identical to `/take/error` |
| `/verify/:id` | No `/verify/` route exists in the current SPA router (`App.tsx`). The 404 `<NotFound>` page covers the "invalid path" case |

### 31.3 Config location and server command

Config: `apps/web/lighthouserc.json` (next to the package it audits).

```json
"startServerCommand": "pnpm --filter @assessiq/web preview --port 4173 --host 0.0.0.0"
```

- The preview server serves the `dist/` output of `pnpm --filter @assessiq/web build`. The CI job runs `build` before `lhci autorun`.
- `lhci collect` starts the preview server and waits for `localhost:4173` to appear in its output (30 s timeout). Then it runs the audits and tears down the server.
- `numberOfRuns: 1`: one audit pass for each URL. This is acceptable for an initial baseline. Raise it to 3 in `lighthouserc.json` if performance scores are noisy across runs (for example variability above 5 points).
- Reports go to `temporary-public-storage`: public but ephemeral (expires after 13 days). The workflow step output prints the link.

### 31.4 How to run locally

```bash
# Build first (required — preview serves dist/)
pnpm --filter @assessiq/web build

# Run Lighthouse CI
pnpm --filter @assessiq/web lhci:run
```

The `lhci:run` script is defined in `apps/web/package.json` as `lhci autorun`. It reads `lighthouserc.json` from the working directory (the repo root when you run it with `pnpm --filter` from the repo root).

### 31.5 How to update thresholds

- Edit `lighthouserc.json` at the repo root. The `assertions` block is the only place where scores are enforced.
- To raise a threshold, all 5 routes must meet the new minimum before the change lands. Run it locally first.
- To lower a threshold below 0.90, add a comment in `lighthouserc.json` that explains why. Add a matching entry in `docs/RCA_LOG.md`.

### 31.6 Promoting to a required status check

The workflow is **advisory only** at first merge. After the baseline run confirms that all 5 routes score ≥ 90 in all four categories, promote it:

> GitHub repo → Settings → Branches → Branch protection rules for `main` → "Require status checks to pass" → add `lighthouse / lighthouse`.

### 31.7 Advisory vs. required

The CI job is not in `needs:` of any other job. It is not in the required checks list of the branch protection. This matches the P14 plan intent: "make the workflow advisory at first — the user will promote it after baselining." The `quality` job in `ci.yml` stays the hard gate.

---

## 32. Visual regression (Playwright snapshots)

**Status:** advisory. Baselines depend on the Docker image (§ 32.3). Added 2026-05-14 as part of the P14 sub-item "Visual regression baseline."

### 32.1 What it does

Playwright `toHaveScreenshot()` captures full-page PNGs of the 5 unauthenticated routes. It diffs them pixel for pixel against committed baseline images. A diff above `maxDiffPixels: 200` fails the test. This catches unintended visual regressions from CSS changes, token updates or component refactors.

Covered routes (the same set as Lighthouse CI and the axe sweep):

| Route | Snapshot file |
|---|---|
| `/admin/login` | `admin-login.png` |
| `/candidate/login` | `candidate-login.png` |
| `/take/expired` | `take-expired.png` |
| `/take/error` | `take-error.png` |
| `/this-route-does-not-exist-aiq-visual` (404) | `404.png` |

### 32.2 Where the config lives

| Artifact | Path |
|---|---|
| Spec | `apps/web/e2e/visual.spec.ts` |
| Playwright project config | `apps/web/playwright.config.ts` → `projects[name="visual"]` |
| Snapshot directory | `apps/web/e2e/visual.spec.ts-snapshots/` |
| CI workflow | `.github/workflows/visual-regression.yml` |
| npm scripts | `apps/web/package.json` → `visual:run`, `visual:update` |

### 32.3 Platform contract — why Docker is mandatory

- Playwright snapshot comparison is byte-sensitive. Font hinting, sub-pixel antialiasing and GPU compositing produce different pixels on Windows, macOS and Linux, even with identical viewport sizes.
- **Snapshots committed from a Windows or macOS machine always fail on Linux CI.**
- The accepted solution: generate and compare snapshots only inside the official Playwright Docker image. It is pinned to one OS and font stack:

```
mcr.microsoft.com/playwright:v1.59.1-jammy
```

Keep this tag in sync with the `@playwright/test` version in `pnpm-lock.yaml`. If you bump `@playwright/test`, update the image tag in `.github/workflows/visual-regression.yml` and regenerate all baselines.

### 32.4 How to update baselines

Run the command **inside the Docker image**, not on a developer workstation:

```bash
# From the repo root on a Linux/macOS host with Docker installed:
docker run --rm \
  -v "$PWD:/work" \
  -w /work \
  mcr.microsoft.com/playwright:v1.59.1-jammy \
  bash -c "corepack enable && pnpm install --no-frozen-lockfile && pnpm --filter @assessiq/web visual:update"

# On Windows (PowerShell), replace $PWD with ${PWD}:
docker run --rm `
  -v "${PWD}:/work" `
  -w /work `
  mcr.microsoft.com/playwright:v1.59.1-jammy `
  bash -c "corepack enable && pnpm install --no-frozen-lockfile && pnpm --filter @assessiq/web visual:update"
```

1. After the run, the PNGs appear in `apps/web/e2e/visual.spec.ts-snapshots/`.
2. Commit them and push. CI then compares against these Linux-rendered baselines.

Alternative: trigger the workflow through GitHub Actions `workflow_dispatch` with the `--update-snapshots` flag. This needs a small workflow edit to pass the flag. You can also run `visual:update` locally in Docker and push the PNGs directly.

### 32.5 How to run in comparison mode (CI)

CI runs `pnpm --filter @assessiq/web visual:run` (`playwright test --project=visual`) inside the same Docker image. If no baseline PNGs exist yet, tests fail with `snapshot doesn't exist`. This is expected on the first run, before you commit baselines.

### 32.6 Local development (non-Linux)

- The spec gates the `visual` project with `process.platform !== 'linux'`. Tests are skipped on Windows and macOS.
- `pnpm --filter @assessiq/web visual:run` on a developer machine prints skip messages, not failures. This prevents accidental baseline pollution.
- The default `pnpm e2e` run (the `chromium` project) has `testIgnore: /visual\.spec\.ts/`. Visual tests are absent from the normal dev workflow.

### 32.7 Promoting to a required status check

The CI workflow (`.github/workflows/visual-regression.yml`) is **advisory only** at first. Promote it after baselines are committed and stable across about 3–5 PRs:

> GitHub repo → Settings → Branches → Branch protection rules for `main` → "Require status checks to pass" → add `Visual regression / visual`.

## 33. Incident runbook and alerting (added 2026-10-01)

**Status:** one alert source is not created and one is not wired (see the Status column). The owner must create the UptimeRobot monitors. <!-- verify -->

All alert sources deliver to `connect@assessiq.in`, which forwards to the Gmail of the owner.

| Signal | Mechanism | Status |
|---|---|---|
| DB backup failed | `ERR` trap in `/etc/cron.daily/assessiq-backup` sends mail via Brevo using the app's `SMTP_URL` (see `docs/06-deployment.md` § Backups) | ✅ live, alert path tested 2026-10-01 |
| Site or API down | External uptime monitor (UptimeRobot free): **HTTP(s)** `https://assessiq.in/api/health`, expect 200, every 5 min, alert after 2 failures. A second monitor on `https://assessiq.in/`. Alert contact: owner Gmail directly, **not** connect@assessiq.in, so a domain or mail outage cannot hide the alert. | ⏳ owner to create (needs an account) |
| App exceptions | `SENTRY_DSN` exists in `modules/00-core/src/config.ts:85`, but no SDK is wired. | ❌ not wired. Deferred: add only if the log-based triage (§ 6) proves too slow. |

**Known ceiling:** if the VPS cron daemon dies, the backup alert cannot fire. An external dead-man ping (healthchecks.io) is the upgrade path.

### 33.1 First 10 minutes of any incident

1. **Scope.** Run `curl -sS -o /dev/null -w '%{http_code}\n' https://assessiq.in/api/health`. Any code other than 200 means the API is down or the edge fails.
2. **Containers.** Run `ssh assessiq-vps 'docker ps --filter name=assessiq --format "{{.Names}} {{.Status}}"'`. You should see 6 containers: api, worker, frontend, marketing, redis, postgres.
3. **Logs.** Run `docker logs --since 30m assessiq-api 2>&1 | tail -100`, and the same for `assessiq-worker`. App JSONL logs are in `/var/log/assessiq/` (see § 6).
4. **Disk and memory.** Run `df -h /` and `free -h`. A full disk kills Postgres writes and backups.
5. **Edge.** Caddy is shared with other apps: `/opt/ti-platform/caddy/`. Never reload shared config without the backup-first pattern in `docs/06-deployment.md`. Also check the Cloudflare dashboard for the zone.
6. **Mail.** If sign-in codes do not arrive, check Brevo. The 300/day of the free plan is **shared by 5 products**. Also check `docker logs assessiq-worker` for SMTP errors.

### 33.2 Standard fixes, all additive and AssessIQ-only

- **Restart one service:** `cd /srv/assessiq && docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate <svc>`.
- **Roll back code:**
  1. `cd /srv/assessiq && git log --oneline -5` to find the last good SHA.
  2. `git checkout <sha> -- .` (or `git reset --hard <sha>` on the VPS clone only).
  3. Rebuild and recreate the affected service.
  4. Record it in `docs/RCA_LOG.md`.
- **Restore the database:** use the § Backups drill pattern in `docs/06-deployment.md`. Restore into a throwaway container first and verify. Only then plan a cut-over. Never run `pg_restore` straight over the live database without approval of the owner.
- **Never** run `docker system prune` or `apt autoremove`. Never stop or restart any non-`assessiq-*` container or unit. The host is shared (CLAUDE.md rule 8).

## 34. Scoring and result release — worker jobs, log events, audit rows (2026-10-01)

> **Read this when:** a result was not published, a candidate says "I never got my result email", the evaluation-queue alert of the owner did not arrive, or you change the release or evaluation path. Design: `docs/05-ai-pipeline.md` § Platform evaluation queue. Data: `docs/02-data-model.md` § Scoring and result release.

### 34.1 Worker jobs (both on the `assessiq-cron` queue, `assessiq-worker` container)

| Job | Schedule | Retry | What it does | `worker.job.finished` `result` |
|---|---|---|---|---|
| `result.auto_release` (`apps/api/src/jobs/auto-release.ts`) | every 15 s | attempts 1 | One cross-tenant read (role `assessiq_system`) for up to 50 attempts that are `graded`, have `evaluation_released_at >= tenant_settings.result_release_auto_since`, belong to an active tenant in mode `auto`, have a non-erased candidate and are not embed attempts. Each is released in its own `withTenant` tx via 09 `releaseAttemptInTx` (trigger `auto`; audit actor = the user who released the evaluation, else `system`), then `sendResultReleasedEmail` after commit. Never throws out of the job. | `{ candidates, released, skipped, failed }` |
| `evaluation.queue_alert` (`apps/api/src/jobs/evaluation-queue-alert.ts`) | hourly | attempts 1 | READ ONLY count of queue items older than 24 h. If the count is above 0 and the Redis key `aiq:alert:evaluation_queue` can be created (`SET NX EX 24h`), it emails every address in `SUPER_ADMIN_EMAILS` (template `evaluation_queue_alert`). A tick that sent nothing deletes the key so the next hour retries. | `{ overdue, oldestAgeHours, alerted, sent }` |

Neither job calls AI or imports `@assessiq/ai-grading` (`lint:ambient-ai` stays green). One publishes an already finished result. The other counts rows and sends mail. The overdue count duplicates the queue predicate of 07 `listSuperEvaluationQueue`. Keep the two in sync.

- **Cooldown.** An attempt that fails or is refused is skipped for 10 minutes (in memory, for each worker process; a restart clears it). One poison attempt then cannot starve the batch. It shows as `skipped` or `failed` in the job result.
- **Mode re-check.** The release re-reads the mode of the tenant inside its own transaction (`FOR SHARE` on `tenant_settings`). A switch back to manual between the read of the sweep and its release wins: that attempt is `skipped`, not published.
- **Quiet ticks.** A tick with no candidates writes no `auto-release tick` line. It writes only the `worker.job.start` and `worker.job.finished` lines of the wrapper (§ 13.1).

### 34.2 Key log events

| Event (`msg`) | Level | Stream | When |
|---|---|---|---|
| `auto-release tick` | info | worker | The sweep found candidates (`candidates`, `released`, `skipped`, `failed`) |
| `auto-release: skipped` | info | worker | Business refusal (`code`, usually `RESULT_NOT_READY`): released by someone else first, candidate erased in between, a grade still `review_needed`, tenant switched back to manual, or the result predates `auto_since` |
| `auto-release: release failed`, `auto-release: candidate query failed` | error | worker | Unexpected error for one attempt / the cross-tenant read failed |
| `auto-release: result email failed` | warn | worker | The email call threw (it normally never does); the result IS published |
| `evaluation-queue-alert: sent` | info | worker | Alert emailed (`overdue`, `oldestAgeHours`, `sent`) |
| `evaluation-queue-alert: SUPER_ADMIN_EMAILS is empty`, `evaluation-queue-alert: no email could be sent` | warn / error | worker | No recipients configured / every send failed (the Redis gate is released for the next tick) |
| `grading.release.complete` | info | grading | A company admin published one result (07) |
| `grading.release.cert_issuance_failed` | warn | grading | Certificate issuance failed and was rolled back to its SAVEPOINT; the release itself committed (09) |
| `grading.release.notification_failed` | warn | grading | The post-commit result email threw; the release stands |
| `grading.release_all.complete`, `grading.release_all.unexpected_error` | info / error | grading | Bulk publish finished (`ready`, `released`, `skipped`) / one attempt failed unexpectedly |
| `grading.evaluation_released.complete` | info | grading | The platform released one evaluation to its company |
| `grading.release_to_tenant.bulk_complete`, `grading.release_to_tenant.unexpected_error` | info / error | grading | Bulk release-to-company finished (`requested`, `released`, `skipped`) / one attempt failed unexpectedly |
| `grading.sent_back.complete` | info | grading | A company sent an evaluation back |
| `grading.manual_score.complete` | info | grading | A manual first score was written |
| `submit.expectation_failed` | warn | app | The "soon / email" lookup at submit failed; the candidate got the safe "emailed" message |
| `result.released_without_score_row` | warn | app | A published attempt had no `attempt_scores` row; the result endpoint answered "pending" instead of a partial score |
| `result_released.email_skipped: <reason>` | info / warn | webhook | No email sent: attempt not found, not released or no score row (warn); candidate erased or embed attempt (info) |
| `result_released.email_failed`, `evaluation_queue_alert.email_failed` | warn | webhook | Building or queueing the email threw. Delivery itself is logged by `email.queued` / `email.sent` (§ 14.1) and `email_log` |

### 34.3 Audit rows (in the attempt's own tenant log, same tx as the change)

| Call site | Action | Note |
|---|---|---|
| `modules/09-scoring/src/release.ts:178` | `grading.released` | `after.trigger` = `manual` \| `auto`; actor `system` when the sweep releases an evaluation that has no releasing user. Moved here from 07 `admin-claim-release.ts`, which now writes no audit row |
| `modules/07-ai-grading/src/handlers/super-evaluations.ts:333` | `grading.evaluation_released` | The super admin is the actor |
| `modules/07-ai-grading/src/handlers/admin-send-back.ts:97` | `grading.sent_back` | The note is NOT in `after` (free text) |
| `modules/07-ai-grading/src/handlers/admin-manual-score.ts:174` | `grading.override` | `after.kind = 'manual_first_score'`; the reason text lives only on the `gradings` row |
| `modules/02-tenancy/src/service.ts` `updateResultReleaseMode` | `tenant.settings.updated` | `before` / `after` = `{ result_release_mode }`; a same-mode request writes nothing |
| `modules/09-scoring/src/mcq.ts:175` | `grading.accepted` | `actor_kind = 'system'`; written only when MCQ scoring actually finalised the attempt |

`grading.claimed` is no longer written (the attempt GET is read-only). The action stays in the catalog for historical rows.

### 34.4 Triage: "a result is waiting but the candidate has nothing"

1. Run `SELECT status, evaluation_released_at, evaluation_released_by, evaluation_sent_back_at FROM attempts WHERE id = '<attempt-id>'`.
   - `graded` with `evaluation_released_at` NULL is still in the platform queue. This is expected: the owner has not released it.
   - `graded` with it set is ready for the company to publish.
2. Check the release mode of the tenant.
   - Manual tenant: an admin must press Publish or "Publish all ready".
   - Auto tenant: run `SELECT result_release_mode, result_release_auto_since FROM tenant_settings WHERE tenant_id = '<tenant-id>'`. Automatic publishing needs mode `auto`, `auto_since` set, and `evaluation_released_at >= auto_since`. Results released before the switch need a manual publish.
3. Run `jq 'select(.msg | startswith("auto-release"))' /var/log/assessiq/worker.log | tail`.
   - A `skipped` line carries the refusal `code`.
   - A `worker.job.finished` result of `candidates: 0` on every tick means that nothing matched step 2.
4. If the result is published but no email arrived, look for `result_released.email_skipped` in `webhook.log` (erased, embed, no score row). Then check `email_log` for `template_id = 'result_released'`. The Brevo daily cap is shared (§ 33.1).
5. If the owner alert is missing, run `redis-cli GET aiq:alert:evaluation_queue` (a value means one was sent in the last 24 h). Then check the `evaluation-queue-alert:` lines in `worker.log`. Then check `SUPER_ADMIN_EMAILS` on the worker container.

Not covered: there is no queue-age metric beyond the platform queue page and the 24 h email.

---

## 35. Notifications hardening, invitation resend, evaluation release (2026-10-01)

| Item | Detail |
| --- | --- |
| Email class: auth | `admin_email_otp`, `candidate_login_link`, `invitation_admin` (`modules/13-notifications/src/email/delivery-policy.ts`). No BullMQ priority, so they run before bulk mail, alongside cron. 5 attempts, exponential 5 s |
| Email class: bulk | Everything else. Priority 100. 11 attempts. Backoff `email-bulk` = 1m, 5m, 15m, 1h, 2h, 4h, 6h, 8h, 12h, 12h (about 45 h) |
| Webhook jobs | Also use priority 100 |
| SMTP 5.1.x | A bad recipient. It is an `UnrecoverableError` and fails at once |
| SMTP timeouts | Connection 10 s, greeting 10 s, socket 30 s. They are appended to `SMTP_URL` unless already set (`withSmtpTimeouts`). A hung SMTP connection can no longer hold the single worker slot (timer sweep, auto-release) |
| `email_log.status` | `queued` between retries, `sent`, `failed` (final). These statuses now persist: migration 0121 |
| Log: `email.send.attempt_failed` | warn. Fields: emailLogId, template, emailClass, attempt, maxAttempts, smtpCode, enhancedCode, errCode, permanent, willRetry |
| Log: other changes | `email.queued` gains `emailClass`. `webhook.delivery.refused` (warn: reason, endpointId, host, address). `webhook.delivery.permanent_fail` now also covers 3xx. Network error text `webhook request timed out after 10000ms` |
| `webhook_deliveries.last_error` values | `blocked_address`, `blocked_url`, `HTTP 3xx: redirects are not followed`, `HTTP 4xx: <snippet>` |
| Audit | `assessment.invitation.resent`. `assessment.invite` rows with `after.kind = reinvite`. `grading.accepted`, `grading.override` and manual score with `after.evaluation_released = true` when that call handed the result to the company |
| Triage: "My link doesn't work" | The admin clicks Resend on the invitation. The old link dies and a new 7-day link is emailed |
| Triage: "Email never arrived" | Check `email_log.status`. `queued` means still retrying (up to about 45 h). `failed` means permanent or exhausted. Then grep the worker logs for `email.send.attempt_failed` and read `smtpCode`. A daily-limit reply means: wait for the reset or upgrade the plan |

**Status:** known follow-ups (open):

- The webhook backoff is off by one (the first retry waits 5 m, not 1 m).
- Webhook deliveries that exhaust retries stay `pending`.
- `in_app_notifications` mark-read has no UPDATE policy.

(`docs/02-data-model.md` § Batch 3 records fixes for these three items: migration 0126 and the `failed` status change. <!-- verify -->)

---

## 36. Marketing Core Web Vitals (F3, 2026-10-02)

| Item | Detail |
| --- | --- |
| Change | The Google Fonts stylesheet on the marketing site loads with `preload` + `onload` swap + `<noscript>` (`6435da9`). It was render-blocking |
| Method | Local Lighthouse 12, single runs, before and after the change. The PageSpeed API quota was exhausted, so the API was not used. Noise is about 5-10% between runs. There is no field data (CrUX) |
| Conclusion | The render-blocking request is gone. Score and LCP changes are within noise. Do not read the `/` mobile score drop as a regression without a repeat run |
| Next step | When the PageSpeed quota resets, read CrUX field data for the marketing origin. Look at `/try` unused JavaScript (code splitting) |

**Render-blocking time from the font stylesheet (ms), before to after**

| Page | Mobile | Desktop |
|---|---|---|
| `/` | 1149 to 0 | 518 to 0 |
| `/pricing` | 1012 to 0 | 382 to 0 |
| guide page | 988 to 0 | 382 to 0 |

**Score and LCP, before to after**

| Page | Form factor | Score | LCP (ms) |
|---|---|---|---|
| `/` | mobile | 94 to 89 (TBT 220 to 360) | 2030 to 2084 |
| `/` | desktop | 98 to 99 | 897 to 738 |
| `/pricing` | mobile | 91 to 92 | 1884 to 1925 |
| `/pricing` | desktop | 96 to 94 | 1159 to 1265 |
| `/try` | mobile | 81 to 85 | 3559 to 3151 |
| `/try` | desktop | 97 to 96 | 1018 to 1041 ms |

- Guide page after-run: n/a (timeout). CLS is about 0 everywhere.
- `/try` is the SPA and was not changed. Its top Lighthouse opportunity is unused JavaScript, about 520 ms.

### `GET /api/ready` readiness probe (RW-9)

`GET /api/ready` answers whether the API can run AI evaluation now. It needs no login.

| Item | Detail |
| --- | --- |
| Checks | Three checks run in parallel, each with a 5 s timeout: `db` (`SELECT 1`), `redis` (`PING`), `claude` (`claude --version`, no shell) |
| Response | `{ "status": "ready" \| "not_ready", "checks": { "db": bool, "redis": bool, "claude": bool } }`. The status is 200 when all checks pass and 503 when one fails. The body holds no versions and no error text |
| Cache | The `db` and `redis` results are cached for 5 s. The `claude` result is cached for 60 s. Concurrent requests share one run. A caller cannot start more than one process each minute |
| Why no login | The body holds only booleans, and the cache caps the process cost. A monitor can call it without a secret |
| Use | Point an uptime monitor at it next to `/api/health`. `/api/health` stays a pure liveness check. The platform evaluation page shows the result as a chip |

## 37. Generation log events and two worker jobs (S10, 2026-10-16)

*Type: reference.* Read this when a generation run shows `failed` with no cause, when the wizard shows a difficulty warning count, or when a nightly job did not run.

### 37.1 Generation log events

| Event (`msg`) | Level | Stream | Emitter | Fields | When |
| --- | --- | --- | --- | --- | --- |
| `generation.detached.start` | info | `app` | `startGenerateDetached`, `modules/04-question-bank/src/service/generation-async.ts` (RW-93) | `attemptId`, `packId`, `levelId`, `count` | `POST /api/admin/generate/start` begins a detached run |
| `generation.detached.end` | info | `app` | same | `attemptId`, `generated` | The detached run finished |
| `generation.detached.failed` | error | `app` | same | `attemptId`, `code`, `err` | The detached run threw. The code marks the attempt row `failed` if it is still `running` |
| `generation.stale_sweep` | warn | `app` | `sweepStaleGenerationAttempts`, same file (RW-94) | `count` | The sweep set at least one `running` row to `failed` with `AIG_STALE_AFTER_RESTART`. No line when the count is 0 |
| `generation.difficulty.warn.failed` | warn | `generation` | `insertDrafts`, `modules/07-ai-grading/src/handlers/admin-generate.ts` (RW-88) | `attemptId`, `topic`, `err` | The `difficulty.warn` function threw. The draft is still inserted, with no warnings |
| `generation.complete` | info | `generation` | same file | includes `generated`, `skillSha` and, since RW-88, `warningCount` | The handler stored the drafts. `warningCount` is the total number of difficulty warnings |

- **Stale rows.** A `generation_attempts` row that stays `running` after an API restart is cleared by the sweep. The sweep runs once at API start and then through the worker job below. Triage: grep `generation.stale_sweep` in `app.log`, then read the rows with `error_code = 'AIG_STALE_AFTER_RESTART'`.
- **Lease loss.** A run that loses the single-flight lease ends as `failed` with `AIG_LEASE_LOST` and writes no drafts (RW-64). See [05-ai-pipeline.md](05-ai-pipeline.md) § "D7".

### 37.2 Worker jobs

Both jobs run on the `assessiq-cron` queue in the `assessiq-worker` container. The wrapper writes the normal `worker.job.start` and `worker.job.finished` lines (§ 13.1). Neither job calls AI.

| Job | Schedule | Retry | What it does | `worker.job.finished` `result` |
| --- | --- | --- | --- | --- |
| `generation-stale-sweep` (RW-94) | every 15 min | attempts 1 | Runs `sweepStaleGenerationAttempts()`. Sets `generation_attempts` rows that are `running` and older than 10 min to `failed` | `{ count, ids }` |
| `tenant-purge-cron` (RW-48b) | daily at 03:30 UTC, after `dsr-retention-cron` | attempts 1 | Purges tenants that were archived for 180 days or more. It is a dry run unless the worker env `TENANT_PURGE_ENABLED=true`. Design: [04-auth-flows.md](04-auth-flows.md) § "Tenant purge" | `{ dryRun, candidates, purged, failed }` |

- **Quiet ticks.** `tenant-purge-cron` writes the line `tenant-purge-cron tick` (`dryRun`, `candidates`, `purged`, `failed`) only when it finds at least one candidate tenant.
- **Not included.** An alert on `generation.stale_sweep`. The count is a signal for a manual look, not a page.

## 38. Audit export, embed SDK and candidate notice events (S13, 2026-10-16)

### 38.1 Key log events

| Event (`msg`) | Level | Stream | When |
|---|---|---|---|
| `audit.exportCsv: starting streaming export` | info | app | An admin started a CSV export (`tenantId`). One line for each call. |
| `audit.exportJsonl: starting streaming export` | info | app | Same for JSONL. The archive route does not stream, so it does not write this line. The follow-up download does. |
| `embed.sdk.fallback_stub` | warn | app | At API start. The built file `apps/api/public/embed/sdk.js` could not be read (`file`). `GET /embed/sdk.js` serves the old inline stub. Fix: rebuild the SDK and redeploy. |
| `in-app.result_released.failed` | error | app | The post-commit candidate notice insert threw. The release stands. The candidate sees no banner. |
| `in-app.result_released.skipped_no_user` | info | app | The attempt has no `user_id`. No notice is written. |
| `in-app.notification.created` | info | app | Unchanged. `notifyInApp()` inserted a row. The candidate notice also writes this line. |

Related warning: `business-event: not inside withTenant, candidate notice not sent` (warn). It means the producer ran outside a tenant transaction. This is a code bug.

### 38.2 Audit actions

| Action | Written by | `after` | Note |
|---|---|---|---|
| `audit.exported` | `GET /api/admin/audit/export.csv` and `.jsonl` (`modules/14-audit-log/src/routes.ts`) | `{ format, filters, limit, truncated }` | One row for each call. Written before the stream starts, in its own short transaction. Holds no audit row contents. |
| `audit.archived` | `POST /api/admin/audit/archive` | `{ from, to, row_count, format, export_path }` | One row for each call. Deletes and changes nothing. |
| `question.updated` | `PUT /api/admin/questions/:id/taxonomy` | `{ kind: 'taxonomy', node_ids }` | `before` has the same shape. Written in the same transaction as the link change. |

### 38.3 Triage

- **A header shows `X-Export-Truncated: true`.** The range holds more than `limit` rows. Narrow the range. This is not an error.
- **The admin sees two audit rows for one archive click.** This is correct: `audit.archived`, then `audit.exported` for the download.
- **A candidate has no "new result" banner.** 1) Search the app log for `in-app.result_released.failed` or `.skipped_no_user` at the release time. 2) Check `in_app_notifications` for a row with `kind = 'result.released'` and the user id. 3) Check that `read_at` is empty.

## Change history

This table indexes every dated change on this page. The sections above hold the detail.

| Date | Change | Commit or migration | Section |
| --- | --- | --- | --- |
| 2026-05-01 | Log contract, streams, redaction, runbooks (Phase 0) | n/a | §§ 1–12 |
| 2026-05-03 | Worker observability. Notifications observability (`webhook.log`) | `2675e2f` (worker SHA) | §§ 13, 14, 13.6 |
| 2026-05-10 | Stage 3 watch cron. Per-chunk stderr aggregation. MCP rejection logger | `05ea435`, `a124812`; `b7e5552`; `ab39667` | §§ 20, 21, 22 |
| 2026-05-11 | Audit wiring: 04-question-bank, 05-assessment-lifecycle, 03-users, 09-scoring, 13-notifications webhooks. Credential verify page | `eff0ba2`; `08d4b19`; `057de7d`; `b82e82d`; `7208008` | §§ 15, 16, 17, 19, 27, 24 |
| 2026-05-12 | Audit sweep coverage table. `certificates.revoked`, `certificates.reissued` | `190acee` | §§ 18.3, 28 |
| 2026-05-13 | Audit wiring: 16-help-system, 18-certification, 07-ai-grading (doc backfill). Sweep classification. OG image endpoints | n/a | §§ 26, 28, 29, 25, 24.3 |
| 2026-05-14 | Audit wiring: 02-tenancy. Lighthouse CI. Visual regression | n/a | §§ 30, 31, 32 |
| 2026-10-01 | Incident runbook and alerting. Scoring and result release (worker jobs, log events, audit rows). Notifications hardening | migration `0121` | §§ 33, 34, 35 |
| 2026-10-02 | Marketing Core Web Vitals | `6435da9` | § 36 |
| 2026-10-03 | `tenant.provisioned`. Worker routes super admin only | `5e5aaa3`; `59a4816` | §§ 30.6, 30.7 |
| 2026-10-11 | `system-role.tx` log event. One cross-tenant query for each tick (RW-39) | `67ad882` | §§ 8, 13.2 |
| unknown | `GET /api/ready` readiness probe (RW-9) | n/a | § 36 |
| 2026-10-16 | Generation log events (`generation.stale_sweep`, `generation.difficulty.warn.failed`, `generation.detached.*`). Worker jobs `generation-stale-sweep` and `tenant-purge-cron` | (S10, 2026-10-16) | § 37 |
| 2026-10-16 | Audit export and archive events and audit actions. Embed SDK fallback log. Candidate result notice log lines | (S13, 2026-10-16) | § 38 |
