# Operational Maturity Audit — 2026-05-15

**Scope:** Single-VPS Docker Compose deployment of AssessIQ on `srv1150121.hstgr.cloud`
(shared host with ti-platform, accessbridge, roadmap). Phase 1 — sync-on-click AI grading,
no API budget, first paying customer window.

**Method:** Repo-only static analysis. No VPS access, no live data queried, no claims beyond
what files in this repo confirm.

**Gap counts:** 2 critical · 10 high · 9 medium · 4 low — **25 total**

---

## Domain Table

| # | Domain | Gap | Severity | Evidence |
|---|--------|-----|----------|----------|
| 1.1 | Backup & Restore | Offsite backup target `remote:assessiq-backups-prod` is a placeholder string — rclone remote may not be configured on the VPS; if the VPS fails and this remote is not wired, complete data loss | **Critical** | `docs/06-deployment.md` backup cron; rclone remote not verifiable from repo |
| 1.2 | Backup & Restore | Restore drill has never been run against real backup artifacts; RPO (24 h) is documented but untested; RTO (1 h) claim has no evidence | **High** | `docs/06-deployment.md` § DR procedure; no drill log in any session-state doc |
| 2.1 | Disaster Recovery | Caddyfile not committed to repo — VPS rebuild requires recreating the config from `docs/06-deployment.md` prose and 3 RCA entries; the bind-mount inode constraint makes out-of-band edits fragile | **High** | `docs/06-deployment.md` § "Current live state" — config described in prose, not stored under `infra/caddy/` |
| 2.2 | Disaster Recovery | RTO (1 h) / RPO (24 h) documented but the 1 h estimate has never been timed; DR procedure is "rebuild from scratch" — no standby, no tested run-book | **Medium** | `docs/06-deployment.md` § Disaster recovery |
| 2.3 | Disaster Recovery | Single VPS = no failover; a VPS-level hardware or datacenter event has no automated mitigation | **Medium** | Architecture; Hostinger single-region deployment |
| 3.1 | Load & Capacity | Single Node.js process, no PM2 cluster mode, no load test ever run; throughput ceiling and memory ceiling are unknown | **High** | `infra/docker-compose.yml` — one `assessiq-api` replica; no PM2 config anywhere |
| 3.2 | Load & Capacity | Redis and Postgres not monitored for capacity headroom; no eviction or connection-pool saturation alerts | **Medium** | `docs/11-observability.md` monitoring table is aspirational; no Redis/Postgres metrics wired |
| 3.3 | Load & Capacity | No auto-scaling mechanism | **Low** | Expected at Phase 1 |
| 4.1 | Monitoring & Alerting | No alerting delivery channel wired — `SENTRY_DSN` is empty in `.env.example`, monitoring table in `docs/11-observability.md` is aspirational; operator must read logs manually to know of errors | **High** | `.env.example` `SENTRY_DSN=`; `docs/11-observability.md` § monitoring table |
| 4.2 | Monitoring & Alerting | Logs on disk only (14-day retention), no aggregation or search (Loki/Vector deferred Phase 3) | **Medium** | `docs/11-observability.md` § Phase 3 deferred |
| 4.3 | Monitoring & Alerting | No metrics or dashboards (Prometheus/Grafana deferred Phase 3) | **Medium** | `docs/11-observability.md` § Phase 3 |
| 5.1 | Incident Response | No incident response runbook — no on-call rotation, no escalation path, no severity classification, no tenant communication template | **High** | `docs/` — no IR runbook present |
| 5.2 | Incident Response | Single-person team; no PagerDuty or equivalent alerting rotation | **Low** | Expected at Phase 1 |
| 6.1 | Security Hygiene | MASTER_KEY rotation is physically impossible without full service outage — `decryptEnvelope()` reads a single key (`config.ASSESSIQ_MASTER_KEY`), no dual-key fallback; three independent crypto implementations each embed the same single-key pattern: `modules/01-auth/src/crypto-util.ts:43`, `modules/12-embed-sdk/src/webhook-secret-service.ts:35–66`, `modules/13-notifications/src/webhooks/crypto.ts` — rotating the key today breaks all TOTP logins, all embed integrations, and all webhook deliveries simultaneously | **Critical** | `modules/01-auth/src/crypto-util.ts:20–46`; `modules/12-embed-sdk/src/webhook-secret-service.ts`; `modules/13-notifications/src/webhooks/crypto.ts` |
| 6.2 | Security Hygiene | Zero dependency vulnerability scanning — no Dependabot configured, no `pnpm audit` step in CI | **High** | `.github/workflows/ci.yml` — 12+ checks, none is `pnpm audit`; no `.github/dependabot.yml` |
| 6.3 | Security Hygiene | MFA not enforced in production config — `.env.example` documents `MFA_REQUIRED=true` but session state records production ran with `false` | **Medium** | `.env.example`; session state note from initial deployment |
| 7.1 | Cost & Resource Visibility | No resource cost tracking or budget alerts on VPS/hosting; no chargeback model for AI grading | **Medium** | Architecture |
| 7.2 | Cost & Resource Visibility | No chargeback model for per-tenant AI grading costs | **Low** | Expected Phase 1 |
| 8.1 | Tenant Onboarding & Offboarding | Manual-only tenant creation — `apps/api/src/routes/admin-super.ts` has no `POST /api/admin/super/tenants`; only `PATCH .../ai-generate-mode` exists; onboarding requires direct `psql INSERT` | **High** | `apps/api/src/routes/admin-super.ts` — single route confirmed |
| 8.2 | Tenant Onboarding & Offboarding | No tenant offboarding procedure — no data export, no purge workflow, no audit-log export for a departing tenant | **Medium** | `docs/` — no offboarding runbook found |
| 9.1 | Multi-Tenancy Correctness | `tenantContextMiddleware` production path (`req.session.tenantId`) has never been exercised in tests — Test 7 is `test.todo` blocked on `00-core`'s eager config singleton | **High** | `modules/02-tenancy/src/__tests__/tenancy.test.ts` — T7 is `test.todo` |
| 9.2 | Multi-Tenancy Correctness | No HTTP-layer cross-tenant isolation tests — DB-layer is covered by RLS testcontainers; the Fastify request surface (wrong session token, stale `req.db`, missing tenant header in production mode) has no coverage | **High** | `modules/02-tenancy/src/__tests__/tenancy.test.ts` — all tests use the dev-header path |
| 9.3 | Multi-Tenancy Correctness | No chaos or adversarial RLS testing (e.g. pool connection reuse across tenants, GUC persistence across pooled connections) | **Medium** | Architecture; known failure mode documented in RCA `2026-05-02 — help_content RLS` |
| 10.1 | CI/CD Maturity | No rollback procedure and no staging environment — E2E CI job is guarded with `if: vars.E2E_BASE_URL != ''` and comment "No staging env configured yet" | **High** | `.github/workflows/ci.yml` E2E job; no rollback doc in `docs/06-deployment.md` |
| 10.2 | CI/CD Maturity | `--no-frozen-lockfile` in CI with comment "until the first stable lockfile is committed" — leaves build resolution non-deterministic | **Medium** | `.github/workflows/ci.yml` |
| 10.3 | CI/CD Maturity | Manual deploy procedure with no automation | **Low** | `docs/06-deployment.md` § Deploy procedure; expected Phase 1 |

---

## Minimum Viable Production Punch List

*Smallest set of gaps to close before the first paying customer. Ordered by risk severity.*

### MVP-1 — Verify offsite backup is actually working *(Critical 1.1)*

SSH to VPS, run `rclone listremotes` and `rclone ls remote:assessiq-backups-prod` to confirm at
least one pg_dump artifact exists. If the remote is unconfigured, the 24 h RPO claim is false
and complete data loss follows any VPS hardware failure. If the bucket is empty, trigger a manual
backup and re-verify.

**Blocked on VPS access** — cannot verify from repo alone.

### MVP-2 — Implement MASTER_KEY dual-key fallback *(Critical 6.1)*

Add `ASSESSIQ_MASTER_KEY_PREV` to the `00-core` Zod config schema (optional, same validator).
Update `decryptEnvelope()` in `modules/01-auth/src/crypto-util.ts` to try the current key, catch
GCM auth-tag failure, then retry with the previous key. Consolidate `webhook-secret-service.ts`
and `modules/13-notifications/src/webhooks/crypto.ts` to call `crypto-util.ts` instead of
reimplementing. Write a `docs/06-deployment.md` rotation runbook.

**Load-bearing path — requires Phase 3 Opus diff critique + codex:rescue before push.**

### MVP-3 — Wire one alerting channel *(High 4.1)*

Set `SENTRY_DSN` to a real Sentry project DSN (free tier covers Phase 1 volume). This converts
the system from "read logs to know of errors" to "errors page you." A failed COMMIT in
`tenantContextMiddleware` or a broken grading run currently goes unnoticed until a tenant
complains.

### MVP-4 — Add `pnpm audit` to CI and enable Dependabot *(High 6.2)*

`pnpm audit --audit-level=high` as a CI step exits nonzero on high/critical CVEs. Add
`.github/dependabot.yml` with weekly npm updates. Five minutes of configuration; protects against
a known CVE sitting undetected indefinitely.

### MVP-5 — Commit Caddyfile to repo *(High 2.1)*

Store the live config under `infra/caddy/Caddyfile` with the inode-trap comments already
present in the file on the VPS. A VPS rebuild today requires reconstructing the Caddy config from
doc prose and RCA entries. Risk materialises the moment the VPS dies.

### MVP-6 — Fix Test 7 — tenantContextMiddleware production path *(High 9.1)*

The `req.session.tenantId` path (used by every authenticated request in production) is entirely
untested. The fix requires a config-injection seam in `02-tenancy`'s pool and config access —
analogous to `setPoolForTesting` already in the module. Until this passes, production's primary
auth path has no test coverage.

### MVP-7 — Create-tenant API endpoint *(High 8.1)*

`POST /api/admin/super/tenants` creates a tenant row and schema-seeds defaults. Removes the
manual psql requirement for onboarding paying customers. An audit trail exists for API-created
tenants; it does not exist for psql-direct inserts.

### MVP-8 — Run one restore drill *(High 1.2)*

Download the most recent pg_dump from the offsite backup (once MVP-1 confirms it exists), restore
to a throwaway Postgres container, confirm tenant data is intact, time the process. Update
`docs/06-deployment.md` with the actual RTO/RPO observed. The 1 h RTO claim is currently
unverified.

---

## Production Hardening Punch List

*Second customer / 100+ concurrent users. After MVP gaps are closed.*

### PH-1 — HTTP-layer cross-tenant isolation test suite *(High 9.2)*

Build a Fastify test harness (separate from the RLS testcontainers) that exercises: wrong session
tenant, stale `req.db` after pool recycle, `x-aiq-test-tenant` header rejected in production
mode, COMMIT failure path in `onResponse`. The DB layer is covered; the Fastify lifecycle is not.

### PH-2 — Load test baseline *(High 3.1)*

Run k6 or autocannon against critical paths (session auth, assessment list, grading trigger).
Establish p50/p95/p99 and max throughput. Add a CI regression gate. Without a baseline, a slow
query added in a future PR is invisible until a tenant complains.

### PH-3 — Incident response runbook *(High 5.1)*

A 1-page playbook: severity tiers, initial triage checklist (API logs, Redis health, Postgres
connections, Caddy uptime), customer communication template, escalation path. Even a one-person
team needs a playbook for 2 AM incidents.

### PH-4 — Enforce MFA in production *(Medium 6.3)*

Set `MFA_REQUIRED=true` in the production `.env`. The code enforces it correctly when set; the
production config needs the flag.

### PH-5 — Staging environment *(High 10.1)*

A `docker-compose.staging.yml` on the same VPS (different ports, seeded tenant data) enables
E2E tests in CI and roll-forward validation before production deploys. The E2E CI job is already
wired but guarded because `E2E_BASE_URL` is unset.

### PH-6 — Rollback procedure *(High 10.1)*

Document and test: `git revert`, rebuild image, redeploy. Include a data-migration rollback path
for schema changes. Add to `docs/06-deployment.md`. An untested rollback is not a rollback.

### PH-7 — Consolidate crypto implementations *(Critical → Medium after MVP-2)*

After MVP-2's dual-key fallback lands in `crypto-util.ts`, remove the duplicate implementations
from `webhook-secret-service.ts` and `webhooks/crypto.ts`. All three services then share one
implementation and one key-rotation runbook. A key rotation that misses one of three impls still
causes partial outage.

### PH-8 — Tenant offboarding procedure *(Medium 8.2)*

GDPR/data-handling baseline: export tenant data (assessments, attempts, candidates), verify
RLS-scoped purge deletes only the target tenant, confirm audit log entries are preserved for the
compliance window. Document as a runbook in `docs/`.

### PH-9 — Commit lockfile and remove `--no-frozen-lockfile` *(Medium 10.2)*

Once the package graph stabilises, commit `pnpm-lock.yaml` and switch CI to `--frozen-lockfile`.
Reproducible builds become possible; supply-chain drift between CI and local dev is eliminated.

---

## Mature Operations Punch List

*Year-out: multiple tenants, formal SLA, compliance requirements.*

### MO-1 — Second VPS or cloud failover

The single-VPS architecture means any VPS-level failure is a multi-hour outage. A warm standby
(even a second Hostinger VPS with streaming Postgres replication and Redis replica) reduces RTO
from "rebuild from scratch" to under 15 minutes.

### MO-2 — Observability stack

Ship OTel instrumentation, Loki/Vector for log aggregation, Prometheus/Grafana for metrics. The
`docs/11-observability.md` Phase 3 plan is already specified. This enables anomaly detection,
SLO tracking, and on-call dashboards.

### MO-3 — Automated backup verification

Daily restore smoke test against staging: restore the previous night's backup, run a
schema-version check and row-count spot check, alert if the restore fails. Eliminates the
"we have backups but haven't verified them" risk class permanently.

### MO-4 — PagerDuty or equivalent on-call rotation

As the team grows, alerting must page the right person at the right severity. Wire Sentry →
PagerDuty (or Opsgenie / Alertmanager), define escalation trees, run a fire drill quarterly.

### MO-5 — SOC 2 Type I preparation

Access control review (SSH access, DB access), change management (PR review requirements,
deploy approvals), incident logging with timestamps and post-mortem sign-off. Engage an auditor
6 months before the target certification date. The RCA log is a good foundation.

### MO-6 — CDN edge and geographic read replicas

Candidate assessments are latency-sensitive. A CDN edge for static assets and geographic
Postgres read replicas reduce p99 for candidates far from the VPS datacenter.

### MO-7 — Auto-scaling or Kubernetes migration

k3s or EKS with HPA on CPU/memory metrics. Required before the single-VPS process ceiling
becomes a customer-visible bottleneck.

### MO-8 — Formal SLA + SLO/SLI tracking

Define uptime commitments per tier (e.g. 99.5% starter / 99.9% enterprise). Instrument SLO
burn-rate alerts. SLOs/SLIs measure whether the commitment is being kept.

---

## Next-Session Prompt Outlines — Critical Gaps

### Critical Gap 1: Offsite Backup Verification (gaps 1.1 + 1.2)

**Goal:** Confirm `remote:assessiq-backups-prod` is a real, working rclone remote on the VPS
and that at least one backup artifact exists. If the remote is not wired, establish it and
trigger a manual backup to prove the end-to-end pipeline.

**Context the session needs:**
- `docs/06-deployment.md` § Backups — describes the daily cron: `pg_dump | gzip | rclone copy
  to remote:assessiq-backups-prod/YYYY-MM-DD/...`
- The rclone remote name `assessiq-backups-prod` appears only as a string in the doc; the rclone
  config on the VPS (`~/.config/rclone/rclone.conf`) is not committed to the repo.
- SSH alias: `assessiq-vps` → `srv1150121.hstgr.cloud`. Shared host — obey CLAUDE.md rule #8
  (additive only, enumerate before touching anything, never touch non-`assessiq-*` services).

**Steps:**
1. `ssh assessiq-vps "rclone listremotes"` — confirm the named remote exists.
2. `ssh assessiq-vps "rclone lsd remote:assessiq-backups-prod"` — confirm the bucket is
   reachable and has at least one directory/object.
3. If the remote doesn't exist: `ssh assessiq-vps "rclone config show"` to see what IS
   configured, then set up the correct remote (Backblaze B2 / S3 / Cloudflare R2 per user
   preference). Record the provider and bucket name.
4. If the bucket is empty: reproduce the cron pipeline manually (`pg_dump | gzip | rclone copy`)
   and re-verify that the artifact lands in the bucket.
5. Run one restore drill: copy the artifact to a local temp dir, restore via
   `gunzip | psql -U assessiq -d assessiq_restore`, spot-check row counts on two tenant tables,
   measure elapsed time. Update `docs/06-deployment.md` § DR with actual RTO/RPO.
6. Commit `docs/06-deployment.md` replacing the placeholder remote string with the verified
   remote name + bucket URL + drill date + observed RTO/RPO.

**Hard rules:** `docker ps`, `systemctl list-units --state=running --no-pager`,
`ls /etc/nginx/sites-enabled/` before any VPS action. Never `docker system prune`, never touch
non-`assessiq-*` containers or systemd units.

**Deliverable:** A commit to `docs/06-deployment.md` that replaces the placeholder with verified
evidence. If the remote was not configured, a second commit documenting the newly established
backup remote.

---

### Critical Gap 2: MASTER_KEY Dual-Key Fallback (gap 6.1)

**Goal:** Make `ASSESSIQ_MASTER_KEY` rotation possible without service outage by adding a
`ASSESSIQ_MASTER_KEY_PREV` fallback, then consolidate the three independent crypto
implementations to all use `crypto-util.ts`.

**Context the session needs:**
- `modules/01-auth/src/crypto-util.ts:20–46` — `decryptEnvelope()` calls `masterKey()` which
  reads only `config.ASSESSIQ_MASTER_KEY`. No fallback path exists. On GCM auth-tag failure
  (wrong key), Node throws `ERR_OSSL_BAD_DECRYPT` / the decipher throws on `.final()`.
- Three implementations to touch:
  1. `modules/01-auth/src/crypto-util.ts` — canonical impl, fix here first
  2. `modules/12-embed-sdk/src/webhook-secret-service.ts:35–66` — duplicate AES-256-GCM,
     delete and delegate to `crypto-util.ts`
  3. `modules/13-notifications/src/webhooks/crypto.ts` — third independent impl, same fix
- `modules/00-core/src/config.ts` — Zod schema for env vars. Add `ASSESSIQ_MASTER_KEY_PREV`
  as `z.string().optional()` with the same `is32ByteBase64` validator. Both the current and
  previous key must be 32 bytes base64-encoded when present.
- Encryption uses AES-256-GCM; envelope shape: `nonce(12) || ciphertext || authTag(16)`.
  `encryptEnvelope` always uses the CURRENT key. `decryptEnvelope` tries the current key;
  if the decipher's `.final()` throws (auth-tag mismatch), catches that specific error class
  and retries with PREV key; propagates if PREV is undefined or also fails.

**Acceptance tests (all must pass):**
- Encrypt with KEY_A → set KEY=KEY_B, KEY_PREV=KEY_A → `decryptEnvelope` succeeds (fallback path)
- Encrypt with KEY_A → set KEY=KEY_B, KEY_PREV=undefined → `decryptEnvelope` throws
- Encrypt with KEY_B → set KEY=KEY_B, KEY_PREV=KEY_A → `decryptEnvelope` succeeds (no fallback needed)
- All existing crypto-util tests still pass
- `webhook-secret-service.ts` and `webhooks/crypto.ts` delegate to `crypto-util.ts` (no duplicate AES logic)

**Rotation runbook to document in `docs/06-deployment.md`:**
1. Set `ASSESSIQ_MASTER_KEY_PREV` = current production key in `.env`
2. Set `ASSESSIQ_MASTER_KEY` = new 32-byte random key (base64url)
3. Redeploy — all existing ciphertext decrypts via PREV fallback; new writes use the new key
4. Monitor logs for `decryptEnvelope` errors for 24 h
5. After 24 h: clear `ASSESSIQ_MASTER_KEY_PREV` from `.env`, redeploy

**Load-bearing paths:** `modules/00-core/**` and `modules/01-auth/**` are load-bearing per
CLAUDE.md. `modules/12-embed-sdk/**` and `modules/13-notifications/**` are also load-bearing
(production secrets). **Requires Phase 3 Opus diff critique + codex:rescue adversarial sign-off
before push.** Log the verdict in the session-state agent-utilization footer.

**Deliverable:** Four commits (one per module: 00-core config, 01-auth crypto-util with tests,
12-embed-sdk consolidation, 13-notifications consolidation) + updated
`docs/06-deployment.md` § MASTER_KEY rotation runbook.
