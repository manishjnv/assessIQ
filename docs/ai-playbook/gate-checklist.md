# Gate checklist

**Type:** Reference, with a short how-to for the prompt.
**Use this page when:** a batch changes a gated path. You need no other page to run the gate.
**Source:** `10-gate-optimizations.md` (GATE-4). Reviewed 2026-10-18.

## Gate rules

> [!IMPORTANT]
> Run a gate only when the batch has a gated row. Do not run it for UI, docs or display-only rows.

- Run one gate for each batch. Do not run one gate for each row.
- Put at most 3 security rows in each batch. Split a larger set into more batches.
- Gated paths:
  - `modules/01-auth/**`
  - `modules/02-tenancy/**`
  - `modules/07-ai-grading/**`
  - `modules/14-audit-log/**`
  - `infra/**`, `Dockerfile`, `docker-compose.yml`, Caddy and `.env*` templates
  - Any row that decides who may sit a test, or gets marks or time.
- Skip the gate for UI, docs and display-only rows.
- Codex has been down since 2026-10-11. The gate is a Sonnet takeover. Use the prompt in section 3.
- This page does not cover GATE-8, the full review before the pilot.

## How to run a gate

1. Find the area table in section 2 for each gated path in the batch.
2. Copy the prompt template in section 3.
3. Paste the vectors of each area into the prompt. Do not remove any vector.
4. Write the diff to a file. Use commit ids, not `HEAD`, because the clone is shared: `git diff <base-sha> <head-sha> -- <paths> > <scratchpad>/gate-diff.patch`.
5. Start the agent: `Agent(model="sonnet", subagent_type="general-purpose")`, with the filled prompt.
6. Fix each finding. Gate again after a fix. Stop after 2 loops and use section 5.
7. Write one findings log line (section 4) in the session footer.

## 2. Attack vectors by area

Each row names one attack. The check column says what the reviewer looks for. The source column names the doc or RCA entry that shows the risk in this repo.

### 01-auth (`modules/01-auth/**`)

| # | Attack vector | Check | Source |
| --- | --- | --- | --- |
| 1 | Session token stored or logged in plain form | `sessions.token_hash` holds a sha256 only. No token value in logs | `docs/04-auth-flows.md` § Token and secret storage |
| 2 | Pre-MFA session passes a full-session route | Only `totp/verify` and `totp/recovery` accept `totp_verified=false`. New routes use `requireAuth` | `docs/04-auth-flows.md` § Auth-bypass route inventory |
| 3 | Fresh-MFA check skipped for a role | The handler checks `totpVerified` and `lastTotpAt`. Do not rely on the middleware alone when `MFA_REQUIRED=false` | RCA 2026-10-16 (TOTP reset) |
| 4 | Client IP taken from a spoofable header | Read the IP only with `extractClientIp` or `extractRateLimitClientIp`. No inline `cf-connecting-ip` in `apps/api/src` | RCA 2026-05-19 (IP spoof); `docs/04-auth-flows.md` § Client IP trust |
| 5 | Magic-link or invite token reused, pre-fetched or enumerated | Token is hashed and single-use. Verify is POST, not GET. Request-link returns 204 for every input | `docs/04-auth-flows.md` § Auth-bypass route inventory |
| 6 | Rate limit with the wrong scope | Auth routes limit by IP and by email. A missing or unverified IP fails closed | RCA 2026-05-15 (admin lockout); RCA 2026-05-30 (user-scope lockout) |
| 7 | Embed or JIT login takes over an existing admin | Lookup uses `lower(email)`. Refuse any row that is not an active candidate | RCA 2026-10-03 (embed JIT user) |
| 8 | Weak cookie or session flags | New cookies set HttpOnly, Secure and SameSite. The session id rotates at login. No RCA in this repo: a standard check | `docs/04-auth-flows.md` § Sessions (standard check) |

### 02-tenancy (`modules/02-tenancy/**`, any new table, any route with a tenant or foreign-key id)

| # | Attack vector | Check | Source |
| --- | --- | --- | --- |
| 1 | New domain table without RLS | The same migration enables RLS and adds both policies (`tenant_isolation`, `_insert`). `pnpm lint:rls` passes | `modules/02-tenancy/SKILL.md` § RLS policy template |
| 2 | RLS policy missing for UPDATE or DELETE | With RLS on, an UPDATE matches 0 rows and raises no error. Each write verb needs its policy | RCA 2026-10-01 (email and webhook status never saved) |
| 3 | Cross-tenant foreign key | Foreign-key checks skip RLS. Check that each id belongs to the tenant. Paired ids are all or nothing | RCA 2026-05-16 (partial-tag bypass) |
| 4 | Endpoint or service without tenant context | The code calls `withTenant`. A raw `pool.connect()` must appear in `tools/pool-connect.allowlist.txt` | `modules/02-tenancy/SKILL.md` § Anti-patterns refused; RCA 2026-10-11 |
| 5 | System role used without a reason, or inside tenant scope | `withSystemRole` gets a non-empty reason. It is not nested inside `withTenant` | `modules/02-tenancy/SKILL.md` § withSystemRole contract |
| 6 | Read without tenant context treated as a true zero | A query with no tenant context returns no rows. Do not read that as "no attempts" or "retry count 1" | RCA 2026-10-11 (email retry count) |
| 7 | Tenant admin reaches a super-admin setting | Chains use `super_admin` for AI grading scope, AI mode, other-company logo, tenant lifecycle and worker routes | `modules/02-tenancy/SKILL.md` § S14 and P4; RCA 2026-10-03 (worker routes) |
| 8 | Tenant id taken from the request body or URL | The tenant comes from the session, JWT or API key, never from the body | `modules/02-tenancy/SKILL.md` § Scope (tenant resolver) |

### 07-ai-grading (`modules/07-ai-grading/**`, `ci/lint-no-ambient-claude.ts`)

| # | Attack vector | Check | Source |
| --- | --- | --- | --- |
| 1 | Ambient AI call | A grading runtime or a `claude` spawn is imported from cron, BullMQ, webhook, candidate or worker code. `pnpm lint:ambient-ai` passes. `exec` and `spawnSync` with `claude` are caught | `modules/07-ai-grading/SKILL.md` § D2; RCA 2026-10-09 (lint, RW-65) |
| 2 | Platform route runs AI on an attempt outside the queue | Each per-attempt route calls `resolveEvaluationTenant` and `assertInEvaluationQueue` first. The payload has no candidate name or email. The queue predicate matches in all three places | `modules/07-ai-grading/SKILL.md` § invariants 7, 8, 9; RCA 2026-10-01 (platform grade) |
| 3 | Grade writer without the attempt-row lock | Accept, override, manual score, send-back and release run `SELECT ... FROM attempts ... FOR UPDATE` first | `modules/07-ai-grading/SKILL.md` § invariant 1; RCA 2026-10-01 (accept after release check) |
| 4 | Billing outside the status flip, or billed twice | Billing runs only in `finalizeAttemptIfComplete`, in the same transaction as the flip to `graded`. Send-back does not bill | `modules/07-ai-grading/SKILL.md` § invariant 2 |
| 5 | Score outside the range | On accept and override: `0 <= score_earned <= score_max`, finite. `score_max` is above 0 and at most 1000 | `modules/07-ai-grading/SKILL.md` § Completion gate; RCA 2026-10-01 (override) |
| 6 | Change after publish | A writer answers 409 `RESULT_ALREADY_PUBLISHED` when status is `released` | `modules/07-ai-grading/SKILL.md` § invariant 4 |
| 7 | AI write after a pause or a lost lease | `assertTenantAiEnabled` runs with `FOR SHARE` in the write transaction. The lease is checked in the write callback. Known gap: draft calls take no lock (RW-63) | RCA 2026-10-09 (pause race); RCA 2026-10-16 (lease loss, RW-95) |
| 8 | Answer key or rubric sent to a candidate | Candidate payloads pass `sanitizeContentForCandidate`. Keys such as `correct`, `rationale`, `expected_findings`, `sample_solution`, `expected` and `expected_keywords` never leave the server | RCA 2026-05-16 (answer-key leak) |

### 14-audit-log (`modules/14-audit-log/**`, any `auditInTx` call, audit export routes)

| # | Attack vector | Check | Source |
| --- | --- | --- | --- |
| 1 | Update or delete allowed on `audit_log` | Grants revoke UPDATE, DELETE and TRUNCATE. No policy allows them. Archive deletes nothing | `modules/14-audit-log/SKILL.md` § Storage discipline; § Export cap |
| 2 | State change without an audit row in the same transaction | Each change calls `auditInTx` inside its `withTenant` transaction. The coverage test counts do not drop | `modules/07-ai-grading/SKILL.md` § Audit-write coverage; RCA 2026-10-03 (createTenant, RV59) |
| 3 | Webhook fan-out before commit | Fan-out runs through `onCommit`. A rollback sends nothing | `modules/02-tenancy/SKILL.md` § withTenant onCommit hook (FU-B5) |
| 4 | PII or free text in `before` or `after` | Redaction covers email, name, phone, answer text, IP and user agent. Override reasons and send-back notes stay out of `after` | RCA 2026-05-29 (PII in audit JSONB); `modules/07-ai-grading/SKILL.md` § invariant 3 |
| 5 | Export without a row cap or without a receipt | Exports apply `EXPORT_ROW_LIMIT`. Each export writes `audit.exported` | `modules/14-audit-log/SKILL.md` § Export cap, self-audit and archive (FR1) |
| 6 | Export or archive without the rate limit, or a limit that fails open | Routes `export.csv`, `export.jsonl` and `archive` take `heavyOpGuard`. A Redis error returns 500 | `modules/14-audit-log/SKILL.md` § Rate limit (S14) |
| 7 | CSV formula injection | A cell that starts with `=`, `+`, `-` or `@` gets a `'` prefix | `modules/14-audit-log/SKILL.md` § CSV formula guard (RV77) |
| 8 | Audit route not mounted, or wrong role | Routes are mounted in `apps/api/src/server.ts`. Admin routes use `adminOnly` | RCA 2026-10-09 (FU-B1: routes answered 404) |

### infra/** (Caddy, Compose, deploy scripts, env templates)

| # | Attack vector | Check | Source |
| --- | --- | --- | --- |
| 1 | Caddyfile edited in place | Back up first, then truncate-write (`cat new > file`). Never `sed -i`, `mv` or `cp` over the live file | RCA 2026-05-03 (`sed -i` inode trap); RCA 2026-05-20 (AOP canary) |
| 2 | New app path missing from a Caddy matcher | Each new path is in `@app` or `@api`. Otherwise it falls through to the marketing site or the SPA | RCA 2026-05-03 (`/take/*`); RCA 2026-05-13 (verify path) |
| 3 | Change that is not additive on the shared VPS | No `docker system prune`, `apt autoremove`, `rm`, or `daemon-reload` after unknown units. Enumerate first. Touch only `assessiq-*` names | Project `CLAUDE.md` rule 8 |
| 4 | Origin reachable without Cloudflare | Production boots only with `ORIGIN_TRUST_MODE=enforce` and `ORIGIN_VERIFY_SECRET`. Caddy keeps `client_auth require_and_verify` | `docs/04-auth-flows.md` § Client IP trust; RCA 2026-05-20 |
| 5 | Secret value in a template or a tracked env file | Templates hold names only. `.env*` files stay out of git | `docs/04-auth-flows.md` § Token and secret storage; `docs/ai-playbook/README.md` |
| 6 | Env change without a recreate | `docker compose restart` does not reload `env_file`. Use `up -d --force-recreate` | RCA 2026-05-01 (empty CLIENT_ID in container) |
| 7 | Deploy from a stale or unchecked build | Deploy from a git clone at a CI-green HEAD. Do not use `--skip-ci-check`. Check the build exit code before a recreate. Do not pipe `docker build` into `tail` | RCA 2026-05-03 (architectural debt); `docs/ai-playbook/06-traps.md` (stale-image recreate) |
| 8 | Deploy diff fails open | The diff base is the last deployed marker. Renames are handled. An unreadable diff stops the deploy | Session S25 findings, Z-61 (`84305460`) |

## 3. Prompt template

Copy this block. Replace each `<...>` value. Paste the vectors of each area in the attack list. The reviewer sees no conversation history, so the block must be complete.

```text
You are a security reviewer for the AssessIQ repository at E:/code/AssessIQ.
You have no prior context. Do not edit files. Do not run git add or git commit.

Threat model: <one sentence, for example: an authenticated tenant admin tries to read or change another tenant's grades.>

Files to review (the diff is in <diff-file-path>, made from <base-sha>..<head-sha>):
- <path 1>
- <path 2>

Hard invariants. Do not flag these. They are intentional:
- <invariant, for example: totpVerified=true is intentional for the pre-MFA session.>
- <invariant, for example: the Phase 1 grading runs only on an admin click (ADR D2).>

Attack list. Check each one against the diff and the code it calls:
<paste the 5 to 8 rows of the area table here, with the check column>

Deliverable: a verdict of accept, revise or reject. Then list each concern as file:line, with the attack number it matches. Maximum 400 words. Do not list style issues.
```

Give the diff as a file path and a commit range. Do not write "review the branch".

## 4. Findings log

Write one line for each gate in the session footer (`docs/SESSION_STATE.md`):

```text
gate · <batch> · rows: <Z-ids, and the row that caused each finding> · <verdict> · findings fixed Y/N
```

Two examples:

```text
gate · S25 batch 2 · rows: Z-61 (deploy build plan; Z-59 only shares deploy.sh) · Sonnet takeover · revise · 4 findings fixed Y: stale diff base, rename, fail-open diff, *.md in app folders (84305460)
gate · RW-91 · rows: RW-91 (tenant-admin TOTP reset route) · adversarial review, reviewer not recorded in RCA · revise · 1 finding fixed Y: fresh-TOTP check skipped when MFA_REQUIRED=false (RCA 2026-10-16)
```

Use the row that wrote the risky code. Do not name the reviewer when none is recorded.

## 5. Timeout and fallback ladder

1. Use the Sonnet takeover first. It is the default gate while Codex is down.
2. If the agent has no result after 5 minutes, call it hung. Tell the user and re-fire once with the same prompt.
3. Use Opus takeover only when the user writes "opus takeover".
4. If the same attack class returns after a fix, stop. The design is wrong. Tell the user and do not run a third loop.
5. Never push security work without a sign-off. If no gate runs, stop and tell the user that the push is blocked.
