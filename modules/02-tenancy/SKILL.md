# 02-tenancy — Multi-tenant isolation

## Purpose
Tenant CRUD, settings, branding, and the runtime mechanism that pins every request and DB query to the correct tenant. Enforces isolation at three layers: service call sites (`withTenant`, request scope), repository (query is RLS-only — no double filter), and database (RLS policies). **FU-D6 (2026-10-06):** the request-scope layer is `withTenant` called from each route/service, not a registered Fastify middleware — see `src/middleware.ts` header (SUPERSEDED) and `apps/api/src/middleware/auth-chain.ts` for the real chain.

## Scope
- **In:** `tenants` and `tenant_settings` CRUD; tenant resolver from session/JWT/API key; `set_config('app.current_tenant', ...)` per request; RLS policy management; tenant lifecycle (suspend, archive); branding upload + serving; embed-origin allow-list management.
- **Out:** users (03), assessments (05), the visual theming pipeline (17 reads `tenants.branding` but does not write).

## Dependencies
- `00-core` (config, logger, errors)
- `14-audit-log` (every tenant settings change is audited — landing in Phase 3)

## Public surface
```ts
// service
getTenantById(id): Promise<Tenant>
getTenantBySlug(slug): Promise<Tenant>      // Phase 1 — requires withSystemRole
updateTenantSettings(id, patch): Promise<TenantSettings>
suspendTenant(id, reason): Promise<void>
renameTenant(adminUserId, tenantId, rawName): Promise<RenameTenantResult>  // tenant-admin renames OWN company; normalizeTenantName (2-120, collapse ws, no control chars); UPDATE tenants.name + 1 tenant.renamed auditInTx in one tx; same-name = noOp. Route: PATCH /api/admin/tenant. Display-only: never touches slug/id/status.

// middleware — Fastify hook pair (preHandler + onResponse) — SUPERSEDED, NOT REGISTERED (FU-D5/FU-D6, 2026-10-06): see src/middleware.ts header
tenantContextMiddleware(): TenantContextHooks
//   .preHandler  : acquire pg client, BEGIN, SET LOCAL ROLE assessiq_app,
//                  set_config('app.current_tenant', $1, true), attach req.tenant + req.db
//   .onResponse  : COMMIT (2xx/3xx) or ROLLBACK (4xx/5xx), release client

// repo helper — programmatic equivalent of the middleware for worker/CLI/cron
withTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>

// system-role helper (RW-38, 2026-10-11) — the only sanctioned way to run under assessiq_system
withSystemRole<T>(reason: string, fn: (client: PoolClient) => Promise<T>): Promise<T>

// pool — singleton, lazy
getPool(): pg.Pool
closePool(): Promise<void>
setPoolForTesting(connectionString): Promise<pg.Pool>   // test escape hatch, not exported via index.ts
```

`tenantContextMiddleware` returns the two Fastify hook functions (`preHandler`, `onResponse`) rather than a single `preHandler`. **FU-D6 (2026-10-06): corrected — this hook pair is SUPERSEDED and not registered anywhere.** The 01-auth session loader does not register these hooks; tenant context is established per call site via `withTenant`. Phase 0 deliberately avoids a hard `fastify` dependency — hooks are structurally typed against `TenantRequest` / `TenantReply` interfaces so tests exercise them without booting the framework.

## Data model touchpoints
Owns: `tenants`, `tenant_settings`. Migrations at `modules/02-tenancy/migrations/`:
- `0001_tenants.sql` — `pgcrypto` extension; `tenants` and `tenant_settings` tables; RLS + two policies on `tenant_settings`.
- `0002_rls_helpers.sql` — `assessiq_app` (no BYPASSRLS) and `assessiq_system` (BYPASSRLS) roles; baseline GRANTs and `ALTER DEFAULT PRIVILEGES` so future tables inherit.
- `0003_tenants_rls.sql` — RLS + two policies on `tenants` itself (custom: `id = current_setting(...)`).

Migrations apply via `psql` on the VPS. The generic runner `tools/migrate.ts` exists, but production does not use it (state 2026-10-02): older migrations were applied by hand and `schema_migrations` is incomplete. New migrations are applied by hand, one by one, in number order, before the image rebuild. See `docs/06-deployment.md` § "Applying new migrations by hand".

## Critical: RLS policy template
```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <table>
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation_insert ON <table>
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
```

The `, true` second arg to `current_setting` makes it return NULL instead of erroring when the GUC is unset. The comparison `tenant_id = NULL` evaluates FALSE (SQL three-value logic), so an unauthenticated session sees zero rows — fail-closed. Without `, true` an un-set context throws "unrecognized configuration parameter", a worse failure mode.

Every new domain table MUST get this two-policy template in the **same migration file** as the `CREATE TABLE`. The linter (`tools/lint-rls-policies.ts`) enforces this per-file. The `tenants` table is a documented special case — its own `id` is the tenant key (see `0003_tenants_rls.sql`).

## System-level escapes
`assessiq_system` has `BYPASSRLS`. Used only for: cross-tenant analytics, support tooling, backups, **and tenant creation** (the `tenants_isolation_insert WITH CHECK (id = current_setting(...))` policy means a non-bypass role cannot insert a new tenant before its own context exists). Every use goes through `withSystemRole(reason, fn)` (RW-38, commit `66a7c50`).

**`withSystemRole(reason, fn)` contract.**
- `reason` must be a non-empty string. Otherwise it throws `ValidationError` (`INVALID_SYSTEM_ROLE_REASON`).
- It runs `BEGIN`, then `SET LOCAL ROLE assessiq_system`, then `fn`. It uses `COMMIT` on success and `ROLLBACK` on error.
- It logs `system-role.tx` with `{reason, caller}` (stream `app`) before the transaction starts.
- It uses the same `onCommit` hook model as `withTenant`. Hooks run after `COMMIT`.
- It throws `SYSTEM_ROLE_INSIDE_TENANT` when called inside a `withTenant` scope (`AsyncLocalStorage` marker). Open the system transaction first, or use two separate calls.
- Mixed pattern: read under the system role, then `SET LOCAL ROLE assessiq_app` plus `set_config('app.current_tenant', ...)` for an audited tenant write in the same transaction. This is allowed. Comment the switch at each site.

**Raw connects.** `tools/pool-connect.allowlist.txt` lists the files that may call `pool.connect()` directly (four entries, each with a reason). `pnpm lint:rls` fails on an unlisted raw connect and on a stale entry. Details: `docs/02-data-model.md` § "Row-Level Security policies".

**Audit.** The helper does not write an audit row. An audit row needs a tenant, and many system reads are cross-tenant. A caller that changes tenant data writes its own `auditInTx` row in the tenant part of the transaction.

`getTenantBySlug` is part of the public surface but throws in Phase 0 — slug-lookup happens before tenant context is established (login flow), so it requires `withSystemRole`. The helper now exists (RW-38); `getTenantBySlug` itself is still not wired.

## Connection / role posture
- Production `DATABASE_URL` should connect as `assessiq_app` (created by `0002_rls_helpers.sql`, no password — set via `ALTER ROLE` from a Docker secret post-migration). Migrations run as the postgres superuser (`POSTGRES_USER` from compose).
- `withTenant` and the middleware both run `SET LOCAL ROLE assessiq_app` defensively inside the per-call transaction. If `DATABASE_URL` accidentally connects as the superuser (dev mistake), this re-engages RLS within the transaction. In production where the URL already targets `assessiq_app`, it is a cheap no-op.

## Anti-patterns refused (CLAUDE.md hard rule #4)
- `WHERE tenant_id = $1` in `tenant_settings` queries — RLS is the enforcement layer; double-filtering masks RLS bugs (a misconfigured BYPASSRLS role would still return the right row via WHERE — silent regression).
- `pg_set_session_authorization` — only `SET LOCAL ROLE` + `set_config(..., true)`.
- INFO-level logging of `tenant_settings` JSONB — may leak branding URLs, webhook URLs.
- Importing from this module without first establishing a tenant context — the API surface is built around `withTenant` / `tenantContextMiddleware`.

## Help/tooltip surface
- `admin.settings.tenant.branding` — how branding fields propagate to UI
- `admin.settings.tenant.domain` — how domain restriction works with SSO
- `admin.settings.embed-origins` — what origins to add and why
- `admin.settings.data-region` — implications for compliance

## Open questions
- Tenant deletion (vs archive) — deferred; keeps things simpler
- Per-tenant custom domains (`assess.client.com`) — Phase 3 with TLS via ACME-DNS

## Status

**Implemented — 2026-05-01 (Phase 0 Session 2 / G0.B-2).**

- 3 migrations applied to ephemeral testcontainer postgres + integration tests passing.
- 11/11 vitest cases passing (1 documented `test.todo` for production-NODE_ENV header rejection — blocked by 00-core's eager config singleton, unblocks in Phase 1 with config injection).
- Public surface: `getTenantById`, `updateTenantSettings`, `suspendTenant`, `tenantContextMiddleware`, `withTenant`, `getPool`/`closePool`. `getTenantBySlug` deferred to Phase 1. `withSystemRole` landed later (RW-38, 2026-10-11).
- codex:rescue verdict: **accepted** with one Phase 4 revision (INSERT-policy test added) — see `docs/SESSION_STATE.md` agent-utilization footer.


## Tenant result release mode (SP2, 2026-10-01)

Migration `0114` adds `tenant_settings.result_release_mode` (`manual` default | `auto`) and `result_release_auto_since` (NULL while manual). `updateResultReleaseMode(adminUserId, tenantId, mode)` is the only mutator (not part of the generic settings patch): UPDATE + one `tenant.settings.updated` audit row in one tx; manual→auto stamps `result_release_auto_since = now()`, auto→manual clears it; a same-mode request is a no-op (no write, no audit). The auto-release sweep (apps/api worker) only publishes attempts whose evaluation was released at/after `result_release_auto_since`, so switching to auto never releases results already waiting (the admin uses bulk release for those).

## `createTenant` audit row (RV59, 2026-10-03)

`createTenant` now uses its super-admin id and writes one `tenant.provisioned` audit row with `auditInTx` inside its own transaction, in the NEW tenant's audit log (same rule as `suspendTenant`). Actor = the super admin, entity = the new tenant, `after = { slug, name }` (`name` is redacted by the sanitizer). The route's later `tenant.created` row and its failure row are unchanged. Tests: `audit-writes.test.ts`, `create-tenant.test.ts`. See docs/11 section 30.6.

## `withTenant` `onCommit` hook (FR2 FU-B5, 2026-10-03)

`onCommit(client, hook)` in `src/with-tenant.ts` registers a function that runs after COMMIT and after `client.release()`. It never runs on rollback. It returns `false` and drops the hook if the client is not inside an open `withTenant`. A hook error is swallowed (the work is already committed); the hook owns its own logging, as `fanoutAuditEvent` does. Used by `auditInTx` (module 14) for webhook fan-out. Other transaction helpers (raw `BEGIN`) have no hooks. Test: `src/__tests__/with-tenant-on-commit.test.ts`.

## Archived-tenant purge (RW-48b, 2026-10-15)

`purgeArchivedTenants({ now, enabled, minDays })` in `src/purge.ts`. Nightly job `tenant-purge-cron` (03:30 UTC, `apps/api/src/worker.ts`, no AI). Selects `status='archived'` tenants whose `updated_at` is at least 180 days old (`minDays` clamps to 180 or more; `updated_at` is the archive time, there is no `archived_at`). Skips the platform tenant. Per tenant, in one `withSystemRole` tx: deletes every `tenant_id` row from all public tables except `audit_log`, `tenants` and `users`, plus rows of no-`tenant_id` tables that FK to the tenant's users (table list and FK order come from the catalog); users stay as pseudonymised tombstones (as in 20-data-rights erasure), counted as `users_pseudonymised`, sets `status='purged'` (tombstone, migration `0170_tenant_purge.sql`), writes one `tenant.purged` audit row with per-table counts. A failure rolls back only that tenant. Gate: `TENANT_PURGE_ENABLED=true`; otherwise dry run (lists candidates, changes nothing). `0170` only widens the `tenants.status` CHECK; the `audit_log` FK is untouched. Test: `src/__tests__/purge.test.ts`.

## withSystemRole and the pool.connect allowlist (RW-38, 2026-10-11)

**What.** `withTenant` and `withSystemRole` share one private transaction scaffold in `src/with-tenant.ts`. Every hand-rolled system-role transaction in modules and `apps/api` now calls `withSystemRole`. Three local wrappers are deleted. Four raw `pool.connect()` sites stay, each listed with a reason in `tools/pool-connect.allowlist.txt`: `15-analytics/refresh-mv-job.ts`, `02-tenancy/middleware.ts`, `16-help-system/service.ts` (`withGlobalsOnly`) and `18-certification/repository.ts` (`withPublicVerifyContext`).

**Why.** The old sites differed in error handling, none logged why the system role was used, and one could miss `RESET ROLE`. One helper with a mandatory `reason` fixes all three.

**Considered and rejected.** (1) Audit every system call by construction. The audit row needs a tenant, and many system reads are cross-tenant. This is why the old "deferred until 14-audit-log" plan was dropped. (2) A separate `withSystemReadOnly`. Module 07 keeps a thin wrapper that adds `SET TRANSACTION READ ONLY`.

**Not included.** `refresh-mv-job` stays a raw connect because `REFRESH MATERIALIZED VIEW` needs the MV owner role. The superseded, unregistered `middleware.ts` is not converted.

**Behaviour changes.** Candidate-login token consume (`01-auth`) now runs in a transaction. Before, it used a session-level `SET ROLE`. The `13-notifications` email retry count now reads `email_log` under `withTenant`. Before, the read was RLS-blind and always fell back to attempt 1.

**Downstream impact.** New system-role code must use `withSystemRole` with a reason. A new raw connect needs an allowlist line. Log event: `system-role.tx` (`docs/11-observability.md`). Test: `src/__tests__/with-system-role.test.ts`.

## S14 (2026-10-16)

### Tenant logo storage (Logo L1, migration 0183)

- **What.** The module owns the table `tenant_logos` ([docs/02-data-model.md](../../docs/02-data-model.md) § "S14 additions (2026-10-16)"). Public API from `src/index.ts`: `setTenantLogo`, `removeTenantLogo`, `getTenantLogoMeta`, `getTenantLogoBytes` and `tenantLogoUrl` (`src/service.ts`). `src/logo.ts` holds `validateLogo`. It reads the image header itself (PNG `IHDR`, JPEG `SOF0` to `SOF2`) and does not trust the declared MIME type.
- **Who may write.** A tenant admin for their own organisation, with a fresh MFA step-up of 15 minutes. A super admin for any organisation. Both paths call the same service functions. Routes: [docs/03-api-contract.md](../../docs/03-api-contract.md) § "Tenant logo (Logo L1 to L4)".
- **Rules.** PNG or JPEG only. At most 512 KB. 32 to 2048 pixels on each side. A bad file throws before any write. A write, or a remove of an existing logo, writes one audit row (`tenant.logo.updated` or `tenant.logo.removed`) in the same transaction. The row holds metadata only.
- **No foreign key on `updated_by`.** This is on purpose. Module-local test harnesses apply module 02 before `020_users`, so a foreign key to `users` would break them. The audit row holds the actor.
- **Cache key.** `tenantLogoUrl` returns `/api/public/tenant-logo/<id>?v=<sha12>`. `getTenantLogoBytes(tenantId)` is the read path for modules 13 and 18. Module 18 calls it after it loads the certificate row, because the public verify page has no tenant context.
- **Considered and rejected.** An object store. SVG. A data URI in emails.
- **Not included.** Logo history. Resize on the server.

### `ai_grading_scope` setter (P4, migration 0188)

- **What.** `getAiGradingScope(tenantId)` and `updateAiGradingScope(targetTenantId, scope, actorUserId)` in `src/service.ts`. The scope is `written` (default) or `none`. `getTenantSettings` returns the field.
- **Super admin only.** The route enforces the role. The function is not part of the generic settings patch. This is the same pattern as `updateAiGenerateMode`. A tenant admin cannot change it.
- **One transaction.** The `UPDATE` and the `tenant_settings.ai_grading_scope.updated` audit row (`before` and `after` hold the scope) share one `withTenant` transaction. A missing settings row throws `NotFoundError`.
- **Reader.** Module 07 `handleAdminGrade` reads the scope once for each run. See [docs/05-ai-pipeline.md](../../docs/05-ai-pipeline.md) § "Least-AI tier order (P4)".
- **Not included.** A tenant-admin switch. A per-question scope. Rollback: set the value back to `written`.

## S15 (2026-10-17) - result feedback level (RW-80, migration 0190)

- **What.** `getResultFeedbackLevel(tenantId)` (returns `'none'` without a row) and `updateResultFeedbackLevel(adminUserId, tenantId, level)` in `src/service.ts`. Types `ResultFeedbackLevel` and `RESULT_FEEDBACK_LEVELS` are exported from `src/index.ts`.
- **One transaction.** Enum check (`ValidationError`, code `INVALID_RESULT_FEEDBACK_LEVEL`), then `SELECT ... FOR UPDATE`, then `UPDATE ... WHERE tenant_id`, then `auditInTx` (`tenant.settings.updated`, `before` and `after` = `{ result_feedback_level }`). The same value is a no-op with no audit row.
- **Owner gate.** Default `none`. The owner picks the production default later. Not part of the generic settings patch.
- **Not included.** A per-assessment override. Rollback: set the value to `none`. Details: `docs/02-data-model.md` (`tenant_settings`), `docs/03-api-contract.md` § S15 additions.

## Z-50 (2026-10-18) - certificate_show_distinction (migration 0205)

- **What.** `getCertificateShowDistinction(tenantId)` (false without a row) and `updateCertificateShowDistinction(adminUserId, tenantId, enabled)` in `src/service.ts`. Same shape as the feedback level: boolean check (`ValidationError`, code `INVALID_CERTIFICATE_SHOW_DISTINCTION`), `SELECT ... FOR UPDATE`, `UPDATE ... WHERE tenant_id`, `auditInTx` (`tenant.settings.updated`). Same value is a no-op with no audit row.
- **Why.** Module 18 shows the word Distinction only when the organisation turns it on. Details: `docs/14-credentialing.md`.
- **Not included.** A per-assessment switch. Rollback: set the value to `false`. Not part of the generic settings patch.

## Z-71 / Z-81 (2026-10-20) - createSelfServeTenant (migrations 0221 and 0223)

- **What.** `src/self-serve.ts`: `createSelfServeTenant`, `signupEmailTaken`, the keyed hashes (`signupHmac`, `signupEmailKey`, `foldSignupEmail`), the input rules (`isValidOrgName`, `isValidAdminName`), `slugFromName` and `RESERVED_SLUGS`. Tables `signup_claims` (0221) and `tenant_legal_acceptances` (0223, owned by 03-users because it references `users`) and column `tenants.self_registered` (0221) (`docs/02-data-model.md` § "Self-serve sign-up tables").
- **One transaction** under `withSystemRole("self-serve sign-up")` (never inside `withTenant`): claim insert (`ON CONFLICT DO NOTHING`, 0 rows = refuse), re-check of super-admin address and existing user, tenant insert as `provisioning` (slug loop of 5 tries with `ON CONFLICT (slug) DO NOTHING RETURNING`), `tenant_settings`, first user (role `admin`), the cross-module `provision` callback (Free plan, credit grant, sample sets from 19-billing, passed in by apps/api because 19-billing depends on this module), two acceptance rows, audit `tenant.provisioned` and `signup.completed`, then status `active`. Any failure rolls all of it back.
- **Why.** The create step must be all-or-nothing and race-safe: the claim primary key gives one organisation for each folded address even for parallel verifies.
- **Considered and rejected.** Calling `createTenant` (needs a super-admin actor and a separate tx per step). Importing 19-billing here (dependency cycle). Seeding the taxonomy in the same tx (`seedTenantTaxonomy` opens its own tx; it runs after commit).
- **Not included.** The sign-up page. `org_verified`. The pre-purge archive row for acceptance evidence.
- **Downstream.** `purge.ts` deletes `tenant_legal_acceptances` rows with the tenant (system role) and ignores `signup_claims` (column `claimed_tenant_id`).

## Camera settings (Batch A, migration 0230, 2026-10-20)

New exports (`src/camera.ts`): `getCameraTenantSettings(tenantId)` returns `{isSchool, cameraEnabled, photosEnabled, noticeConfirmedVersion}`. `setTenantIsSchool(tenantId, isSchool, actorUserId)` is for the super admin (the caller checks the role). `updateCameraSettings(tenantId, {cameraEnabled?, photosEnabled?}, actorUserId)` and `confirmCameraNotice(tenantId, version, actorUserId)`. Each write makes one `tenant.settings.updated` audit row in the same transaction. `purgeArchivedTenants` also removes the tenant camera folder (`removeCameraTenantDir`) before the row deletes. Test: `camera-settings.test.ts`.

## Org accent colour (Z-119, 2026-10-22)

`setTenantAccent(actorUserId, tenantId, hex | null)` (`src/service.ts`) validates with `validateAccent` (`src/accent.ts`: `#rrggbb` only, contrast on white 4.5:1 or more), then updates `tenants.branding.primary` through `repo.updateBrandingPrimary` (row lock, `jsonb_set`, or key removal for null) and writes one `tenant.branding.updated` audit row in the same tx (none when unchanged). Tenant and actor come from the session in the route. Errors: `ACCENT_INVALID_HEX`, `ACCENT_LOW_CONTRAST` (both 400 `VALIDATION_FAILED`). `GET tenant-settings` and `whoami` read `tenant.branding.primary`. Rejected: storing OKLCH or named colours (more validation surface, no need). Not included: per-org fonts, favicon. Downstream: `apps/web/src/App.tsx`, `10-admin-dashboard` tenant settings, help key `admin.tenant_settings.accent_colour` (migration 0241).

## `tenants.is_platform` (EXP-14 phase 1, migration 0276, 2026-10-29)

Exactly one tenant (slug `platform`) has `is_platform = true` (unique partial index). The licensed-read function (phase 2) reads this column to know the owner of the master question store. Do not use a session setting for this. A startup assert that this row equals `PLATFORM_TENANT_ID` comes with phase 2.

## `app.licensed_read` (EXP-14 phase 2, 2026-10-29)

`withTenant` and the tenant middleware set a second transaction setting, `app.licensed_read` ('on' when env `LICENSED_READ=true`, else 'off'), in the same `set_config` call as `app.current_tenant`. It only switches the `licensed_read` SELECT policies of the question store on or off; who may read is decided by the entitlement functions. Never use it as an authorisation check in code.
