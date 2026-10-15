# RS6 feature review, part B: FR1 to FR6

Date: 2026-10-03. Read-only review, no code change. Local-only file (docs/ is gitignored, the repo is PUBLIC). Do not `git add -f` it.

Scope: FR1 audit viewer, FR2 webhooks, FR3 API keys, FR4 embed, FR5 in-app notifications, FR6 email templates without a sender.
Rules used: Rule A (no delete, result is revive / merge / improve / park) and Rule B (compare with the newer feature). Source: `docs/plans/REVIEW_FIX_PLAN_2026-10-02.md` section 3, 6, 7.
Evidence: file:line at the working tree of 2026-10-03 (`main`, `3911f8b`) or a commit hash. Each "no caller" claim was checked with two different searches (function name, route string).

---

## FR1 Audit log viewer, export, archive

### First purpose
- Phase 3 group G3.A: "HR-grade audit trail". Admins query `/admin/audit`, export CSV and JSONL, and a daily job archives old rows to S3 (`docs/plans/archive/PHASE_3_KICKOFF.md:7`, decisions P3.D10, P3.D11).
- The module spec lists "admin viewer with filters, export (CSV/JSONL), retention policy" as in scope (`modules/14-audit-log/SKILL.md`, section Scope).
- First commit: `43c0e45` (2026-05-03).
- Decision-log entries: 2026-05-03 (G3.A order), 2026-05-14 (G3.D, `auditInTx` everywhere) in `PROJECT_BRAIN.md`.

### What operates today
- The write side is live. 36 non-test source files call `auditInTx`. About 18 call sites use `audit()`.
- `registerAuditRoutes` defines 5 routes: list, `export.csv`, `export.jsonl`, `archives`, `archives/:date/restore` (`modules/14-audit-log/src/routes.ts:76,104,129,155,166`).
- Nothing registers them. Search 1: `git grep registerAuditRoutes` finds only the definition and the re-export (`routes.ts:68`, `index.ts:34`). Search 2: `git grep "admin/audit"` in `apps/` and `modules/` (outside the route file and help) finds nothing. `apps/api/src/server.ts` does not import it.
- No screen exists. No page in `modules/10-admin-dashboard` or `apps/web` calls `/api/admin/audit`. The UI kit has no audit screen (`modules/17-ui-system/AssessIQ_UI_Template/screens/`).
- The help text says the page exists: `modules/16-help-system/content/en/admin.yml:644` ("The audit log at `/admin/audit`...") and `:686` (archives card). This text is untrue today. Rule A allows a text fix.
- The archive job is a skeleton. `registerAuditArchiveJob` has no caller (only `index.ts:26` exports it). It does nothing without `S3_BUCKET`, and the S3 upload code is a Phase 4 comment (`archive-job.ts:158`). It deletes no rows.
- Part of the need is covered. The Activity feed merges `audit_log` rows with other events (`modules/15-analytics/src/activity/feed.ts:5,325`, route `GET /api/admin/activity/feed` at `feed.ts:476`, screen `modules/10-admin-dashboard/src/pages/activity.tsx:226`). It reads only, has filter tabs, and has no export.
- Retention has two ideas. `tenant_settings.audit_retention_years` (migration `0050`, 1 to 10 years, default 7) is read only by the archive job. `retention_days` (tenant settings route `apps/api/src/routes/admin-tenant-settings.ts:116`) drives the data-rights retention cron.

### Overlap with newer feature
- Admin Activity page (module 15): shows who did what, read only. It covers "what happened" but not before/after, filters by entity, or file export.
- Data-rights export (module 20): exports a person's data, not the audit trail.
- Retention cron (`retention_days`) and `audit_retention_years` describe two retention rules for different data. They do not conflict today because the archive job never runs.

### Result
**Revive** the viewer and export, and **merge** the Activity feed entry point into it (a link "Full audit trail" from the Activity page). **Park** the S3 archive until an object store exists. Keep one retention rule per data class and write it in `docs/02-data-model.md`.

### Follow-up tasks
| Id | Task | Size | Modules | Load-bearing | Waits for |
|---|---|---|---|---|---|
| FU-B1 | Register `registerAuditRoutes` in `apps/api/src/server.ts` with the admin chain. Add a test that the 5 routes answer 200/401/403. Check that `restore` works with the archive stub (returns a clean "not available" error). | S | apps/api, 14-audit-log (import only) | Yes (14-audit-log is read by the route, no change inside) | Owner: tier for the feature (PT1) |
| FU-B2 | New admin page "Audit trail": filter bar (actor, action, entity, date), table, CSV and JSONL download. Needs a kit gap check first (no kit screen). Reuse the Activity page table idiom. | M | 10-admin-dashboard, apps/web | No | Owner: kit gap approval; FU-B1 |
| FU-B3 | Correct help text for `admin.audit*` until FU-B2 ships (say "available soon") or ship FU-B2 first. Needs help migration plus seed regeneration. | S | 16-help-system | No | None |
| FU-B4 | Write one retention table (`audit_retention_years` vs `retention_days`) in `docs/02-data-model.md` and mark the archive job "parked" in the module SKILL.md. | S | docs only | No | None |

### Owner decision needed
- Is the audit viewer and export a tier feature (PT1, suggestion: Enterprise)? Until the owner decides, only FU-B3 and FU-B4 can start.
  - **Decided 2026-10-03:** Yes. The audit viewer and export are an Enterprise feature.

---

## FR2 Webhooks

### First purpose
- Product surface 3, "REST API + webhooks, for back-end integrations (Workday, ServiceNow, custom HRMS)" (`PROJECT_BRAIN.md:14`).
- Phase 3 G3.B: webhook delivery plus P3.D16 SIEM forwarding from the audit log (`PROJECT_BRAIN.md:96`; `modules/14-audit-log/SKILL.md:96`).
- First commit: `cae6d37` (2026-05-03).
- The integration guide promises host-side signature checks and "results back" (`docs/09-integration-guide.md` section 6).

### What operates today
- Routes are registered: `registerNotificationsRoutes` at `apps/api/src/server.ts:219`. They are `GET/POST/DELETE /api/admin/webhooks`, `/:id/test`, `/deliveries`, `/deliveries/:id/replay`, `/webhook-failures`, `/webhook-failures/:id/retry` (`modules/13-notifications/src/routes.ts:96,108,169,179,192,211,225,235`).
- Delivery works end to end in code: signed V2 header, SSRF guard, retry schedule 1 m, 5 m, 30 m, 2 h, 12 h; the worker has the `webhook.deliver` job (`apps/api/src/worker.ts:78`). Fixes are recorded in `modules/13-notifications/SKILL.md:166,191`.
- No screen. No page in `modules/10-admin-dashboard`, `apps/web` or `modules/11-candidate-ui` calls `/admin/webhooks` (two searches: route string and `webhook-failures`). Production: 0 endpoints, 0 deliveries (plan section 8).
- The only event producer is the audit fan-out. `emitWebhook` has one non-test caller: `audit-fanout-handler.ts:79`. Event names are always `audit.<action>` (`audit-fanout-handler.ts:66`).
- **The fan-out gap is real and larger than the plan says.** `fanoutAuditEvent` is called in one place only: `audit()` (`modules/14-audit-log/src/audit.ts:117`). `auditInTx` does not fan out; its header says so (`audit.ts:132-134`). 36 non-test files use `auditInTx`.
- **The documented event does not fire.** `docs/09-integration-guide.md:271` tells customers to use `audit.grading.released`. The release is written by `releaseAttemptInTx` with `auditInTx` (`modules/09-scoring/src/release.ts:31,178`). No code calls `fanoutAuditEvent` after it. A customer who subscribes to this event gets nothing.
- Business events `attempt.submitted`, `attempt.graded`, `attempt.released` do not exist (`docs/09-integration-guide.md:271` says so).
- Fan-out forwards no before/after data on purpose (`webhook-fanout.ts` comment). Keep that.

### Overlap with newer feature
- Result release (SP2, SP4, SP10): the release already writes one `grading.released` audit row per attempt (`release.ts:178`). It is the natural source of a `result.released` event.
- The embed `postMessage` events (`aiq.attempt.submitted`) cover the iframe case only, not server to server.
- Pricing page lists "signed webhooks" as a tier item (PT1).

### Result
**Improve.** Keep the delivery engine. Define real events, fix the fan-out for `auditInTx`, add a screen.

### Follow-up tasks
| Id | Task | Size | Modules | Load-bearing | Waits for |
|---|---|---|---|---|---|
| FU-B5 | Fan-out after commit for `auditInTx` rows: return value is already the row, so call `fanoutAuditEvent(row)` after `withTenant` ends. Best way: one helper used by the 36 callers, or a post-commit hook in `withTenant`. Needs design: a rolled-back transaction must send nothing. | M | 14-audit-log, 02-tenancy or callers | Yes (14-audit-log, possibly 02-tenancy). Needs adversarial review | None; design first |
| FU-B6 | Define 3 business events (`result.released`, `attempt.submitted`, `attempt.graded`) with a stable payload (ids only, no scores unless released). Call `emitWebhook` from release and submit, after commit. Update `docs/03-api-contract.md` and the integration guide. | M | 09-scoring, 06-attempt-engine, 13-notifications | No (09, 06 are not on the load-bearing list; check 07 is not touched) | Owner: which events customers need |
| FU-B7 | Admin page "Webhooks": endpoint list, create with secret shown once, test event, delivery log, replay. Kit gap check first. | M | 10-admin-dashboard | No | Owner: kit gap approval |
| FU-B8 | Until FU-B5 ships, correct `docs/09-integration-guide.md:271` ("`audit.grading.released` is not delivered yet"). Docs only. | S | docs | No | None |

### Owner decision needed
- Which business events do customers need first (suggestion: `result.released`)?
  - **Decided 2026-10-03:** `result.released`, `attempt.submitted`, `attempt.graded` (FU-B6 built 2026-10-03).
- Is webhooks a tier feature (PT1)?
  - **Decided 2026-10-03:** Yes. Webhooks are Growth and up.

---

## FR3 API keys

### First purpose
- Phase 0 auth: server-to-server tokens `Authorization: Bearer aiq_live_...`, with scopes and a `requireScope` gate (`modules/01-auth/SKILL.md:155-165`, section 6). First commit `d9cfeb4` (2026-05-01).
- Product surface 3 (REST API for HRMS back ends) needs it (`PROJECT_BRAIN.md:14`).
- Scopes: `assessments:read/write`, `users:read/write`, `attempts:read/write`, `results:read`, `webhooks:manage`, `admin:*` (`modules/01-auth/src/api-keys.ts:18-27`).

### What operates today
- Admin routes exist and are registered: `GET/POST/DELETE /api/admin/api-keys` (`apps/api/src/routes/auth/api-keys.ts:46,60,97`, index at `routes/auth/index.ts:5`). Table has 0 rows (plan section 8). No screen (searches for `api-keys` and `apiKey` in `apps/web` and `modules/10-admin-dashboard` find only an unrelated comment).
- Bearer authentication runs: `apiKeyAuthMiddleware` is in the auth chain (`apps/api/src/middleware/auth-chain.ts:81,120`) and sets `req.apiKey`.
- **A key opens almost nothing.** `requireAuth` rejects an API key whenever a route sets `roles` (`modules/01-auth/src/middleware/require-auth.ts:118-125`). Every admin route uses `authChain({ roles: ['admin'] })`. `requireScope` is exported but no route uses it (`git grep "requireScope("` finds no route caller). Only `whoami` reads `req.apiKey` (`apps/api/src/routes/auth/whoami.ts:90`).
- So a customer can create a key, but the key cannot read assessments, users or results. The feature has a front door and no rooms.
- Known defect in SKILL.md: the `last_used_at` update may do nothing under RLS (`modules/01-auth/SKILL.md:63`). Check it on revival.

### Overlap with newer feature
- Embed secrets (module 12) are a separate, working credential for the iframe flow.
- Webhooks (FR2) need `webhooks:manage` scope if a host manages endpoints by API.
- Plan tiers (PT1): "API access" is a typical tier item.

### Result
**Park**, with a revive path. Research: a key without scoped routes has no use today. The consumer list is empty (0 rows, no integration guide section for keys except a checklist line at `docs/09-integration-guide.md:489`). Decide after FR2 and FR4: if the owner wants a REST API tier, revive it by adding scoped read routes.

### Follow-up tasks
| Id | Task | Size | Modules | Load-bearing | Waits for |
|---|---|---|---|---|---|
| FU-B9 | Write down the target: the smallest REST API (for example `GET /api/v1/results`, `GET /api/v1/assessments`) gated by `requireScope`. Design note only. | S | docs | No | Owner: is a REST API tier wanted (PT1) |
| FU-B10 | Mark the module docs "parked: keys authenticate only `whoami` today" and add one test that documents it. | S | 01-auth docs and test | Yes (01-auth, docs and test only) | None |
| FU-B11 | Later: scoped routes with `requireScope`, plus a screen (same page as webhooks). | L | apps/api, 01-auth, 10-admin-dashboard | Yes (01-auth) | FU-B9 and owner decision |

### Owner decision needed
- Is there any customer who needs server-to-server access? If not, keep parked.
  - **Decided 2026-10-03:** No customer now. Park the REST API.

---

## FR4 Embed

### First purpose
- Product surface 2: "iframe with signed JWT, drops into any host application" (`PROJECT_BRAIN.md:13`). Phase 4 shipped on 2026-05-03: commits `b7dfaa9` (13 decisions), `b20858b` (implementation). Decision-log entry 2026-05-03 (`PROJECT_BRAIN.md:97`).
- Scope: candidate take only (D1), 8 h session cookie (D6), `SameSite=None` (D7), per-tenant CSP `frame-ancestors` (D8), DPDP privacy gate (D13) (`modules/12-embed-sdk/SKILL.md`).
- Consumer guide: `docs/09-integration-guide.md`.

### What operates today
- Server flow: `GET /embed?token=` verifies the JWT, reads origins, sets CSP, calls `resolveJitUser`, mints the cookie, calls `startAttempt`, and redirects to `/take/a/:id?embed=true` (`apps/api/src/routes/auth/embed.ts:40-110`).
- Admin routes are registered: embed secrets (`routes/auth/embed-secrets.ts`, index `routes/auth/index.ts`) and embed origins (`server.ts:250`, `routes/embed-admin.ts`). No admin screen calls them. Production: 1 secret row (plan section 8).
- Front end half exists: `apps/web/src/lib/EmbedLayout.tsx:24` sends `aiq.ready`; `embedBus.ts` is the postMessage bridge; `TakeRoot.tsx` uses embed mode.
- `/embed/sdk.js` serves a 30-line inline stub (`embed.ts:123-160`). Its own comment says the real SDK "is injected by the build pipeline". No such step exists.
- `packages/embed-sdk` (`@assessiq/embed`, 162 lines, `src/index.ts`) is never built or imported: no workspace consumer, no build step in CI. (Search 1: `git grep "@assessiq/embed\b"` outside the package finds none. Search 2: no `dist` reference in `infra/` or `.github`.) Plan RV44 is correct.
- `verifyEmbedOrigin` has no caller (`modules/12-embed-sdk/src/index.ts:7` exports it; no import elsewhere). Plan RV44 is correct. The origin list is used only for the CSP.
- **RV43 is confirmed (new-user path fails).** `jit-user.ts:61-66` inserts `password_hash` and `email_verified`. The `users` table has neither:
  - `modules/03-users/migrations/020_users.sql:16-28`: columns are `id, tenant_id, email, name, role, status, metadata, created_at, updated_at, deleted_at`.
  - `modules/01-auth/migrations/016_super_admin.sql:50-56` only changes the role CHECK.
  - `modules/20-data-rights/migrations/0102_users_erased_at.sql:26-27` adds `erased_at`.
  - The module SKILL.md lists it as "BUG-A, not fixed" (`modules/12-embed-sdk/SKILL.md:339`). A new embed candidate gets a SQL error. An existing user (found by email) still works.
- **New risk, not in the plan: the iframe is probably blocked by Caddy.** The repo copy of the live Caddy file adds `X-Frame-Options "DENY"` and `Content-Security-Policy "frame-ancestors 'none'"` to the whole site (`infra/caddy/assessiq.caddy:24,28`, imported at `:63`). The redirect target `/take/a/:id` is served by the frontend container behind that block. The API's per-tenant CSP applies only to the `/embed` response, which is a 302. Behaviour check pending: needs a real iframe test. infra is load-bearing.
- The take flow was never re-tested in an iframe after sections, integrity v1 (fullscreen, copy-block) and the new question types. Integrity v1 asks for fullscreen; the inline SDK sets `allow="fullscreen"` (`embed.ts` stub), which helps.
- `resolveJitUser` finds a user by email without checking `deleted_at`, `status` or `erased_at` (`jit-user.ts:48-52`). An erased or disabled candidate would get a session. Check this when fixing RV43 (auth-adjacent).

### Overlap with newer feature
- `/try` public demo reuses the real runner (no auth).
- Candidate take flow with magic links: the same runner, a different entry.
- University pilot: a college portal could embed the test instead of sending links (not requested yet).
- Inline SDK versus `packages/embed-sdk`: the package is typed and larger. The inline stub is what customers load today. Rule B: compare both before choosing (see FU-B14).

### Result
**Revive.** Fix RV43, prove the iframe flow in a browser, then pick one SDK. Keep both SDK files until FU-B14.

### Follow-up tasks
| Id | Task | Size | Modules | Load-bearing | Waits for |
|---|---|---|---|---|---|
| FU-B12 | **RV43 minimal fix.** In `resolveJitUser`, write only existing columns: `(id, tenant_id, email, name, role, status, metadata, created_at, updated_at)`. Remove `password_hash` and `email_verified` from the column list and from `VALUES`. Keep `role='candidate'`, `status='active'`, `metadata = {"external_id": sub}`. New SQL: `INSERT INTO users (id, tenant_id, email, name, role, status, metadata, created_at, updated_at) VALUES ($1,$2,$3,$4,'candidate','active',$5::jsonb,$6,$6)`. The `UNIQUE (tenant_id, email)` index at `020_users.sql:26` already protects against double insert; handle a unique violation by selecting the row again (race between two tabs). Also filter the lookup with `deleted_at IS NULL AND erased_at IS NULL AND status = 'active'` and refuse a disabled user. Add a DB-backed test that runs the real insert (the old tests inserted users directly and missed it). | S | 12-embed-sdk | Auth-adjacent (embed session). Needs adversarial review | None |
| FU-B13 | Browser test of the whole iframe flow on a test host page: token, `/embed`, take page, submit, `aiq.attempt.submitted`. Check the Caddy headers on `/take/*` (`X-Frame-Options`, `frame-ancestors`). If blocked, design a per-path header change (additive, VPS shared-host rules apply). | M | infra (Caddy copy), apps/web | Yes (infra) | FU-B12; owner approval for any live Caddy change |
| FU-B14 | Rule B compare: inline stub versus `packages/embed-sdk`. Pick the better one, serve it from one place, and delete nothing until the owner agrees. Decide if `verifyEmbedOrigin` should check `postMessage` origins. | S | 12-embed-sdk, packages/embed-sdk | No | FU-B13 |
| FU-B15 | Admin screen for embed secrets and origins (Settings, Integrations). Kit gap check first. | M | 10-admin-dashboard | No | Owner: near customer? kit gap approval |

### Owner decision needed
- Is there a near customer for embed (for example the university portal)? If yes, FU-B12, FU-B13 first. If no, FU-B12 only (the bug fix is cheap and safe).
  - **Decided 2026-10-03:** No near customer. Do FU-B12 only. NO live Caddy header change.
- Tier placement (PT1, suggestion: Enterprise).
  - **Decided 2026-10-03:** Enterprise.

---

## FR5 In-app notifications

### First purpose
- Phase 3 G3.B, decision P3.D13: short-poll every 60 s for admins, `GET /api/admin/notifications?since=` (`docs/plans/archive/PHASE_3_KICKOFF.md:83`). Kinds in the design include `webhook.failed` and `budget...`. First commit `cae6d37` (2026-05-03).
- Public surface `notifyInApp({tenantId, userId?, role?, message})` (`PHASE_3_KICKOFF.md:33`).

### What operates today
- Service, repository and two routes are registered (`modules/13-notifications/src/in-app/service.ts:38,65,103`; `routes.ts:249,276`; any-role chain). RLS update policy was fixed in migration `0126` (`modules/13-notifications/SKILL.md:191`).
- **No producer.** Search 1: `git grep notifyInApp` outside `13-notifications` finds no caller. Search 2: `git grep in_app_notifications` outside the module and migrations finds none. Production: 0 rows.
- **No reader screen.** No bell, badge or list in `modules/10-admin-dashboard` or `apps/web` (search for `admin/notifications` and for "unread/bell" found only an unrelated icon chip in `apps/web/src/pages/take/ErrorPage.tsx:65`).
- The route allows any role (admin and reviewer). RO7 removes the reviewer role; the audience types `role` and `all` need a check at that time.

### Overlap with newer feature
- SP10: dashboard notice "N results ready to publish" for the tenant.
- SP11: queue alert email (`evaluation_queue_alert`, `modules/13-notifications/src/email/evaluation-queue-alert.ts`) and tenant ETA.
- Reminders (`invitation_reminder`).
- FR2: a failed webhook delivery is the first designed `kind` (`webhook.failed`).

### Result
**Merge** into SP10 and SP11: use this channel for in-product notices. One small bell, one list. Email stays for what must leave the product.

### Follow-up tasks
| Id | Task | Size | Modules | Load-bearing | Waits for |
|---|---|---|---|---|---|
| FU-B16 | Admin bell in `AdminShell` that polls `/api/admin/notifications` every 60 s, shows unread count, marks read. Kit gap check first (no bell idiom in the kit). | M | 10-admin-dashboard | No | Owner: kit gap approval |
| FU-B17 | First two producers: "N results are ready to publish" (SP10) and `webhook.failed` after the final retry (FR2). Call `notifyInApp` after commit. | S | 13-notifications, 07-ai-grading handler or 09-scoring (read the release path first) | Maybe (07 if the notice is sent from a grading handler; prefer calling from 09 or a cron) | FU-B16 |
| FU-B18 | Remove the `reviewer` audience assumption when RO7 lands. Note only. | S | 13-notifications | No | RO7 session (RS8) |

### Owner decision needed
- Confirm that tenant notices go to the in-app channel first and email second (the plan's first idea). Otherwise none.
  - **Decided 2026-10-03:** Confirmed. In-app notices first, email second.

---

## FR6 Email templates without a sender

### First purpose
- P3.D14: 7 templates in Phase 3 G3.B: `invitation_admin`, `invitation_candidate`, `totp_enrolled`, `attempt_submitted_candidate`, `attempt_graded_candidate`, `attempt_ready_for_review_admin`, `weekly_digest_admin` (`docs/plans/archive/PHASE_3_KICKOFF.md:84`). First commit `cae6d37` (2026-05-03). Email kit port later (`7a20ee2`, email i18n).

### What operates today
Templates in `modules/13-notifications/src/email/templates/` (12 names) against the real senders:

| Template | Real sender (non-test) | State |
|---|---|---|
| `invitation_admin` | `legacy-shims.ts:27` | Sent |
| `invitation_candidate` | `legacy-shims.ts:48` | Sent |
| `invitation_reminder` | `invitation-reminder.ts:26` | Sent (newer) |
| `result_released` | `result-released.ts:117` | Sent (newer, SP4) |
| `evaluation_queue_alert` | `evaluation-queue-alert.ts:42` | Sent (newer, SP11) |
| `candidate_login_link` | `apps/api/src/routes/auth/candidate.ts:92` | Sent |
| `admin_email_otp` | `modules/01-auth/src/email-otp.ts:331` | Sent |
| `attempt_submitted_candidate` | none | No sender |
| `attempt_graded_candidate` | none | No sender |
| `attempt_ready_for_review_admin` | none | No sender |
| `weekly_digest_admin` | none | No sender |
| `totp_enrolled` | none | No sender |

For each of the 5 without a sender, a second search (the template name in all code except the template folder, strings, render and policy tables) found only registry entries: `types.ts`, `render.ts`, `delivery-policy.ts`, `strings/en.json`. Confirmed.

Findings per template:
- `attempt_submitted_candidate`: text says "Submission received... You will receive another email when grading is complete" (`strings/en.json:31-36`). Today the candidate sees a pending page with "result will be emailed" (SP3), and `result_released` is the one email. A receipt is still a gap: no email confirms that the test was received.
- `attempt_graded_candidate`: "Your results are ready" (`en.json:37`). This conflicts with the owner rule: students see only a complete, released score. `result_released` replaces it.
- `attempt_ready_for_review_admin`: written for the old reviewer flow. AI evaluation is now by the super admin through the platform queue. `evaluation_queue_alert` (SP11) is the newer one. The reviewer role is to be removed (RO7).
- `weekly_digest_admin`: no cron, no query. The Activity feed and SP10 notice could feed it.
- `totp_enrolled`: its text says "change your password" (`totp_enrolled.txt:7`). The product has no password login (OTP, SSO, magic link), so the text is wrong. The natural sender is `enrollConfirm` in `modules/01-auth/src/totp.ts` (about `:241`). MFA is optional now, to be enabled later (RO4), so this email will matter then.

### Overlap with newer feature
- `result_released` (SP4) overlaps `attempt_graded_candidate`.
- `evaluation_queue_alert` (SP11) overlaps `attempt_ready_for_review_admin`.
- In-app notices (FR5, SP10) overlap `weekly_digest_admin` and `attempt_ready_for_review_admin`.

### Result
Per template (Rule A, no delete):
- `attempt_submitted_candidate`: **revive** as a receipt. Change the sentence to match the release rules (for example "We will email your result when it is released").
- `attempt_graded_candidate`: **merge** into `result_released`. Park the file. Compare the two bodies first.
- `attempt_ready_for_review_admin`: **merge** into `evaluation_queue_alert` and the in-app notice (FR5). Park the file.
- `weekly_digest_admin`: **park**. Revisit with the plan tiers and FR5.
- `totp_enrolled`: **improve**: fix the text, send it from `enrollConfirm` when MFA is enabled.

### Follow-up tasks
| Id | Task | Size | Modules | Load-bearing | Waits for |
|---|---|---|---|---|---|
| FU-B19 | Rule B compare, written: `attempt_graded_candidate` vs `result_released`; `attempt_ready_for_review_admin` vs `evaluation_queue_alert`. List any variable or sentence one has and the other lacks. Docs only. | S | docs | No | None |
| FU-B20 | Wire `attempt_submitted_candidate` as a receipt after a successful submit (after commit, `bulk` class as in `delivery-policy.ts:46`). Update the text. Respect the invite email limits (Brevo daily cap, task A5): add a tenant switch or send only to non-bulk drives. | M | 06-attempt-engine, 13-notifications, email strings | No | Owner: receipt email wanted? (pilot volume, daily cap) |
| FU-B21 | Fix `totp_enrolled` text (remove "change your password"). Send from `enrollConfirm`. | S | 13-notifications, 01-auth | Yes (01-auth) | RO4 (when MFA is enabled); adversarial review |
| FU-B22 | Mark the 3 merged or parked templates "parked, see FU-B19" in a code comment or the module SKILL.md. No code behaviour change. | S | 13-notifications docs | No | FU-B19 |

### Owner decision needed
- Should the candidate get a "we received your test" email (FU-B20)? It adds mail volume on big drives.
  - **Decided 2026-10-03:** No receipt email for now (mail volume).

---

## Summary table

| Item | Result | Follow-up task ids | Owner decision |
|---|---|---|---|
| FR1 Audit viewer, export, archive | Revive viewer and export; merge with Activity entry point; park S3 archive | FU-B1, FU-B2, FU-B3, FU-B4 | Is it a tier feature (PT1)? Kit gap approval |
| FR2 Webhooks | Improve: real events, `auditInTx` fan-out, screen | FU-B5, FU-B6, FU-B7, FU-B8 | Which business events first; tier (PT1) |
| FR3 API keys | Park (keys open only `whoami` today); revive path written | FU-B9, FU-B10, FU-B11 | Is a REST API tier wanted? |
| FR4 Embed | Revive: fix RV43, prove iframe flow, pick one SDK | FU-B12, FU-B13, FU-B14, FU-B15 | Near customer? Caddy change approval; tier |
| FR5 In-app notifications | Merge into SP10 and SP11 notices | FU-B16, FU-B17, FU-B18 | Confirm in-app first, email second |
| FR6 Email templates without sender | Mixed: revive submitted, merge graded and ready-for-review, park digest, improve totp | FU-B19, FU-B20, FU-B21, FU-B22 | Receipt email wanted? |

### Corrections to the plan's register rows (found in this review)
- FR2: the plan says "35 files use `auditInTx`". The count is 36 non-test source files. The larger point: `docs/09-integration-guide.md:271` advises the event `audit.grading.released`, and that event is written by `auditInTx` (`release.ts:178`), so it is never delivered.
- FR3: the register says only "no screen". The keys also authenticate nothing but `whoami`: role-gated routes reject them (`require-auth.ts:118-125`) and no route uses `requireScope`.
- FR4: the register asks if the iframe flow still works. Caddy sets `X-Frame-Options DENY` and `frame-ancestors 'none'` site wide (`infra/caddy/assessiq.caddy:24,28`). Likely blocker, behaviour check pending. Also: embed admin routes are registered (`server.ts:250`), only the screen is missing. RV43 columns confirmed against `020_users.sql:16-28`.
- FR1: the help text (`admin.yml:644,686`) describes a `/admin/audit` page that does not exist.
- FR6: `attempt_submitted_candidate` text promises "another email when grading is complete", which conflicts with the release rules. `totp_enrolled` text mentions a password that does not exist.
