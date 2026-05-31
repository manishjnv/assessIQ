# 02 — Data Model

> Every domain table has `tenant_id` (UUID, NOT NULL, indexed). Row-Level Security enforces isolation. Application sets `app.current_tenant` at session start; RLS policies reference it.

## Conventions

- **Primary keys:** UUID v7 (time-ordered, monotonic) — better than v4 for index locality
- **Timestamps:** `created_at`, `updated_at`, both `TIMESTAMPTZ DEFAULT now()`
- **Soft delete:** `deleted_at TIMESTAMPTZ NULL` instead of hard deletes for any user-visible entity
- **JSONB** for: tenant settings, question content, answer payloads, audit before/after, AI grading raw output
- **Money:** never used (no payments in v1)
- **Enums:** Postgres native enums, except where extensibility matters — then `TEXT CHECK (val IN (...))`

## Module → tables map

| Module | Owns these tables |
|---|---|
| 02-tenancy | `tenants`, `tenant_settings` |
| 03-users | `users`, `user_credentials`, `user_invitations` |
| 01-auth | `sessions`, `api_keys`, `embed_secrets`, `oauth_identities`, `totp_recovery_codes`, `candidate_login_tokens` |
| 12-embed-sdk | No own tables — adds columns to `tenants` (`embed_origins`, `privacy_disclosed`), `sessions` (`session_type`), and `attempts` (`embed_origin`) via migrations 0070–0073 (Phase 4, 2026-05-03) |
| 04-question-bank | `question_packs`, `levels`, `questions`, `question_versions`, `tags`, `question_tags` |
| 05-assessment-lifecycle | `assessments`, `assessment_invitations` |
| 06-attempt-engine | `attempts`, `attempt_questions`, `attempt_answers`, `attempt_events` |
| 07-ai-grading | **Phase 1 live:** `gradings`, `tenant_grading_budgets`, `generation_attempts` — **Phase 2 deferred (not yet applied):** `grading_jobs`, `prompt_versions` |
| 08-rubric-engine | _service-only — no tables._ Rubric DSL lives denormalized in `questions.rubric` JSONB owned by 04. Phase 2 G2.B Session 2 (2026-05-03) confirmed this boundary per PHASE_2_KICKOFF.md § P2.D12; the prior `rubrics`/`anchors` table reference at this row was dead text from an earlier draft and never shipped. |
| 09-scoring | `attempt_scores` |
| 13-notifications | `webhook_endpoints`, `webhook_deliveries`, `email_log`, `in_app_notifications` |
| 14-audit-log | `audit_log` |
| 15-analytics | `attempt_summary_mv` (materialized view — no RLS, explicit tenant filter required) |
| 16-help-system | `help_content` |
| 18-certification | `certificates` |
| 19-billing | `tenant_plans`, `billing_events` |

---

## Tenancy

> **Status:** live as of 2026-05-01 (Phase 0 Session 2 / G0.B-2). Migrations at `modules/02-tenancy/migrations/0001_tenants.sql` (tables + tenant_settings RLS) and `0003_tenants_rls.sql` (tenants-table RLS, special-cased on `id`).

```sql
CREATE TABLE tenants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- see "uuidv7 vs gen_random_uuid" below
  slug            TEXT NOT NULL UNIQUE,         -- 'wipro-soc'
  name            TEXT NOT NULL,
  domain          TEXT,                         -- 'wipro.com' for SSO domain restriction
  branding        JSONB DEFAULT '{}'::jsonb,    -- logo URL, colors, favicon
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived','provisioning')), -- 'provisioning' added by 0077 (2026-05-17): soft-create state set by super-admin createTenant before activateTenant flips it to 'active'
  embed_origins   TEXT[] NOT NULL DEFAULT '{}',  -- Phase 4 (2026-05-03): allowlisted iframe origins for postMessage D2/D8; GIN index below
  privacy_disclosed BOOLEAN NOT NULL DEFAULT FALSE, -- Phase 4 (2026-05-03): gate on POST /api/admin/embed-secrets (D13); must be TRUE before embed JWTs can be issued
  smtp_config     JSONB,                           -- Phase 1 G1.B Session 3 (0004): per-tenant SMTP credentials; NULL = dev stub / fail-closed when SMTP driver active. Shape: {host, port, secure, user, password_enc, from_address, from_name}. password_enc is AES-256-GCM under ASSESSIQ_MASTER_KEY
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Phase 4 GIN index for @> / <@ array containment on embed_origins
CREATE INDEX tenants_embed_origins_gin_idx ON tenants USING GIN (embed_origins);

CREATE TABLE tenant_settings (
  tenant_id           UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  auth_methods        JSONB NOT NULL DEFAULT '{"google_sso":true,"totp_required":true}'::jsonb,
  ai_grading_enabled  BOOLEAN NOT NULL DEFAULT true,
  ai_model_tier       TEXT NOT NULL DEFAULT 'standard' CHECK (ai_model_tier IN ('basic','standard','premium')),
  features            JSONB NOT NULL DEFAULT '{}'::jsonb,   -- feature flags
  webhook_secret      TEXT,                                  -- for outgoing webhooks (encrypted)
  data_region         TEXT DEFAULT 'in',                     -- for future multi-region
  -- Phase 2 Stage 3 promotion (migration 0044, 2026-05-10): per-tenant override
  -- for AI question generation path. NULL = inherit global AI_GENERATE_MODE env.
  ai_generate_mode    TEXT DEFAULT NULL
    CHECK (ai_generate_mode IS NULL OR ai_generate_mode IN ('omnibus','sharded')),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `ai_generate_mode` — per-tenant AI generation path override (Stage 3 rollout)

**What it is.** Nullable `TEXT` column added by `modules/02-tenancy/migrations/0044_tenant_settings_ai_generate_mode.sql` (applied to production 2026-05-10). Valid values are exactly `'omnibus' | 'sharded' | NULL`, enforced by a `CHECK` constraint at the SQL layer and by the `TenantSettings` TypeScript type in `modules/02-tenancy/src/types.ts`. Column default is `NULL`.

**NULL semantics.** `NULL` means "use the global `AI_GENERATE_MODE` env var for this tenant" — there is no implicit string fallback like `'omnibus'`. Resolution happens in `modules/04-question-bank` at request time via `tenantSettings?.ai_generate_mode ?? config.AI_GENERATE_MODE` (see `docs/05-ai-pipeline.md` § Phase 2 — Stage 3 promotion). Non-`NULL` overrides the env var for that tenant only; takes effect on the next request with no container restart.

**Why not the existing `features` JSONB.** `features` is an untyped bag for tenant-specific UI experiments. A first-class operational mode flag would be invisible to TypeScript consumers, fail silently on key misspelling, and require a runtime cast in the handler. The dedicated typed column is enforced by both Postgres `CHECK` and TS types. Rationale: `docs/design/2026-05-10-stage-3-promotion-rollout.md` § 3.

**Write path is super-admin only.** Tenant admins cannot change this column — the `updateTenantSettings` service patch surface (`Pick<>` in `modules/02-tenancy/src/service.ts`) deliberately excludes `ai_generate_mode`. The only writer is `updateAiGenerateMode(superAdminUserId, targetTenantId, newMode)` at `modules/02-tenancy/src/service.ts:155`, called by the super-admin route `PATCH /api/admin/super/tenants/:tenantId/ai-generate-mode` (see `docs/03-api-contract.md` § Admin — Super). Each write emits a `tenant_settings.ai_generate_mode.updated` row in `audit_log` (action present in `modules/14-audit-log/src/types.ts` ACTION_CATALOG) inside the same Postgres transaction as the `UPDATE` via `auditInTx` — if the audit INSERT fails, the column UPDATE rolls back.

**Rollback path.** Operator-driven `UPDATE tenant_settings SET ai_generate_mode = 'omnibus' WHERE …` (or `NULL`). Migration 0044 is additive-only; the column is never dropped on rollback.

**Cross-reference.** `docs/05-ai-pipeline.md § Phase 2 — Stage 3 promotion: per-tenant ai_generate_mode` carries the full design context, the runtime resolution path, the cron alert wiring, and the explicit "no auto-rollback" decision.

### `uuidv7` vs `gen_random_uuid()` — column DEFAULT

**What changed:** the canonical `DEFAULT uuidv7()` shown elsewhere in this doc is implemented at the migration level as `DEFAULT gen_random_uuid()` (from the `pgcrypto` extension, enabled in the same migration).

**Why:** Postgres 16 has no native `uuidv7()` function. Adding a SQL/PL-pgSQL `uuidv7()` to the database would mean writing one ourselves and trusting it across every backup/restore. Application code already generates UUIDv7 via `@assessiq/core`'s `uuidv7()` — every INSERT from the API passes an explicit `id`. The column DEFAULT is only a fallback for raw inserts (psql, ad-hoc tooling) where time-ordered ids aren't load-bearing.

**Considered and rejected:** (a) shipping a SQL-level uuidv7 implementation — adds a maintenance surface for a fallback path; (b) using `uuid_generate_v4()` from `uuid-ossp` — random, still not v7, no benefit over `gen_random_uuid()` which is already in the lighter-weight `pgcrypto`.

**Not included:** retroactive change to other tables in this doc that show `DEFAULT uuidv7()` — those will be migrated to `gen_random_uuid()` at their CREATE TABLE migration time, with the same justification copied near each `CREATE EXTENSION pgcrypto`.

**Downstream impact:** none on the application. App code never relies on the DEFAULT. Migrations linter (`tools/lint-rls-policies.ts`) is unaffected — it scans for `tenant_id` column presence and the two RLS policies.

`branding` JSONB shape: `{ "logo_url": "...", "primary": "#5eead4", "favicon_url": "...", "product_name_override": "Wipro SOC Skills" }`

`auth_methods` JSONB shape:
```json
{
  "google_sso": { "enabled": true, "allowed_domains": ["wipro.com"] },
  "totp_required": true,
  "magic_link": { "enabled": false, "ttl_hours": 72 },
  "password": { "enabled": false, "min_length": 12 },
  "saml": { "enabled": false, "idp_metadata_url": null },
  "oidc_extra": { "enabled": false, "config": null }
}
```

## Users & auth

> **Schema note (2026-05-01) — `tenant_id` denormalization on auth tables.** `oauth_identities`, `user_credentials`, and `totp_recovery_codes` originally reached tenancy transitively via `user_id → users.tenant_id`. Per CLAUDE.md hard rule #4 ("Add a domain table without `tenant_id` and an RLS policy → bounce") and `tools/lint-rls-policies.ts`, every domain table must carry a direct `tenant_id` and the standard two-policy RLS template. These three tables now do.
>
> *Why:* defense-in-depth (transitive RLS via JOIN-subquery is silent-failure prone — a missed JOIN reads cross-tenant rows with no error); linter compliance; consistency with `sessions`, `embed_secrets`, `api_keys` which already carry `tenant_id`. *Considered and rejected:* RLS-via-JOIN-subquery on `user_id` — the linter doesn't catch the missing direct policy and every read pays a subquery cost. *Not included:* changes to `UNIQUE (provider, subject)` on `oauth_identities` (still globally unique by product decision: cross-tenant contractors need separate Google accounts). *Downstream impact:* none on app code; `01-auth` migrations `010_oauth_identities.sql`, `012_totp.sql`, `013_recovery_codes.sql` carry the new column + policies; `tools/lint-rls-policies.ts` validates in CI.
>
> See `modules/01-auth/SKILL.md` § Decisions captured (2026-05-01) for the full implementation contract. The `sessions` table block below also notes a `role` column + `last_totp_at` added in the same Window-4 migration to support role-discriminated middleware and step-up MFA without an extra users-table JOIN.

```sql
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  email           TEXT NOT NULL,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin','reviewer','candidate')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','pending')),
  metadata        JSONB DEFAULT '{}'::jsonb,    -- employee_id, department, team
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  UNIQUE (tenant_id, email)
);
CREATE INDEX users_tenant_role_idx ON users (tenant_id, role) WHERE deleted_at IS NULL;
CREATE INDEX users_email_lower_idx ON users (tenant_id, lower(email) text_pattern_ops) WHERE deleted_at IS NULL;  -- prefix-search hot path for listUsers (020_users.sql addendum §9)

CREATE TABLE oauth_identities (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),  -- denormalized from users.tenant_id; see § Schema note
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('google','microsoft','okta','saml','custom_oidc')),
  subject         TEXT NOT NULL,                -- the 'sub' claim from the IdP
  email_verified  BOOLEAN NOT NULL DEFAULT false,
  raw_profile     JSONB,
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)              -- global; one IdP identity = one user across all tenants
);

CREATE TABLE user_credentials (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id            UUID NOT NULL REFERENCES tenants(id),  -- denormalized; see § Schema note
  totp_secret_enc      BYTEA,                  -- AES-256-GCM envelope of a 20-byte SHA-1 TOTP secret (RFC 4226 §4)
  totp_enrolled_at     TIMESTAMPTZ,
  totp_last_used_at    TIMESTAMPTZ,
  password_hash        TEXT,                   -- argon2id, only if password auth enabled
  password_set_at      TIMESTAMPTZ
);

CREATE TABLE totp_recovery_codes (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),  -- denormalized; see § Schema note
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash       TEXT NOT NULL,               -- argon2id (m=65536, t=3, p=4) of the 8-char Crockford base32 code
  used_at         TIMESTAMPTZ,                 -- atomic single-use marker; consumed via UPDATE … RETURNING
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Partial index for the "live codes for user X" lookup
CREATE INDEX totp_recovery_codes_user_live_idx ON totp_recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE user_invitations (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  email           TEXT NOT NULL,
  role            TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  invited_by      UUID NOT NULL REFERENCES users(id),
  expires_at      TIMESTAMPTZ NOT NULL,
  accepted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  role            TEXT NOT NULL CHECK (role IN ('admin','reviewer','candidate')),  -- copied from users.role at session create; saves a JOIN in middleware hot path
  token_hash      TEXT NOT NULL UNIQUE,        -- sha256 of the cookie value
  totp_verified   BOOLEAN NOT NULL DEFAULT false,
  last_totp_at    TIMESTAMPTZ,                 -- powers requireFreshMfa(maxAgeMinutes) per docs/04-auth-flows.md flow 1b
  ip              INET,
  user_agent      TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_type    TEXT NOT NULL DEFAULT 'standard' CHECK (session_type IN ('standard', 'embed'))  -- Phase 4 (2026-05-03): 'embed' set by mintEmbedSession; used for audit and embed-mode guard
);
CREATE INDEX sessions_user_idx ON sessions (user_id, expires_at);
-- Phase 4 composite index for embed session queries and expiry sweeps
CREATE INDEX sessions_session_type_idx ON sessions (session_type, tenant_id, expires_at);

CREATE TABLE api_keys (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  name            TEXT NOT NULL,
  key_prefix      TEXT NOT NULL,                -- first 8 chars, for display
  key_hash        TEXT NOT NULL UNIQUE,         -- sha256 of the full key
  scopes          TEXT[] NOT NULL,              -- ['attempts:write','results:read']
  status          TEXT NOT NULL DEFAULT 'active',
  last_used_at    TIMESTAMPTZ,
  created_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ
);

CREATE TABLE embed_secrets (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  name            TEXT NOT NULL,
  secret_enc      BYTEA NOT NULL,               -- AES-256-GCM
  algorithm       TEXT NOT NULL DEFAULT 'HS256',
  status          TEXT NOT NULL DEFAULT 'active',
  rotated_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `candidate_login_tokens` — passwordless candidate sign-in (Phase 5, 2026-05-13)

> **Status: LIVE 2026-05-13. Security hardening applied 2026-05-13 (adversarial review cycle).** Migration `modules/01-auth/migrations/0076_candidate_login_tokens.sql` applied to production. See `docs/04-auth-flows.md` § Flow 6 for the sequence diagram and `docs/03-api-contract.md` § Candidate magic-link login for the endpoint contract.

**What it is.** A short-lived, single-use token table that supports the `POST /api/auth/candidate/request-link` + `POST /api/auth/candidate/verify-link` flow. A candidate submits their email and `tenant_slug`; the server resolves the slug to a `tenant_id` (system-role only), then looks up the user under RLS inside `withTenant(tenant_id, …)`. If the user exists, a 32-byte CSPRNG token is generated, only its sha256 hex hash is stored here, and the plaintext is emailed. The candidate clicks the link, the SPA POSTs the token to the verify endpoint, the server rehashes it, finds and atomically marks the row consumed, and mints a 30-day `aiq_sess` cookie. The plaintext token is never stored.

**Tenant-scoped writes (Fix 1 — 2026-05-13).** All writes to this table (INSERT on request, UPDATE on verify) happen inside `withTenant(tenant_id, client => …)`. The `tenant_id` is always known before any write — on the request path it comes from the slug resolution; on the verify path it is returned by the atomic `UPDATE … RETURNING tenant_id`. No write to this table ever happens outside an RLS-active transaction.

**Why a separate table (not `user_invitations`).** `user_invitations` is assessment-scoped: its TTL is 72 hours, its single-use semantics are tied to attempt state (`status` progressing past `in_progress`), and its ownership belongs to `03-users` / `05-assessment-lifecycle`. The login token has different invariants: 15-minute TTL, single-use-on-click (no attempt involved), and ownership in `01-auth`. Sharing the table would require either a nullable `assessment_id` column (semantically wrong) or a discriminator column that the invitation flow would have to filter around in every query. A dedicated table is cleaner and cheaper.

**Why not `sessions` directly.** The request endpoint must not create a session until the candidate has proved they received the email (by clicking the link). Creating a pre-session row in `candidate_login_tokens` with a 15-minute TTL is the standard pattern; it avoids orphan sessions and lets the verify endpoint be the single place where a session row appears.

```sql
-- Migration: modules/01-auth/migrations/0076_candidate_login_tokens.sql
CREATE TABLE candidate_login_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,           -- sha256 hex of CSPRNG token; plaintext never stored
  expires_at    TIMESTAMPTZ NOT NULL,    -- 15 minutes from creation
  consumed_at   TIMESTAMPTZ,             -- set atomically on verify; NULL = still live
  requested_ip  INET,
  requested_ua  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique lookup by token hash — the verify path's primary access pattern
CREATE UNIQUE INDEX candidate_login_tokens_hash_idx
  ON candidate_login_tokens(token_hash);

-- Fast "live tokens for user X" query (rate-limit check + admin tooling)
CREATE INDEX candidate_login_tokens_user_unconsumed_idx
  ON candidate_login_tokens(user_id) WHERE consumed_at IS NULL;
```

**RLS: three-policy NULL-safe template (2026-05-13 pattern).** SELECT + INSERT + UPDATE policies all use the `current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id = current_setting('app.current_tenant', true)::uuid` form. The `true` parameter makes `current_setting` return `NULL` rather than raising an error when the GUC is unset; the explicit `IS NOT NULL AND <> ''` guards handle both the unset case (NULL → FALSE) and the `pg.Pool` empty-string GUC leak ('' → FALSE). All three evaluate to FALSE when the GUC is absent, making the table fail-closed. A separate `tenant_isolation_update` policy (for `FOR UPDATE`) is required because the verify path's `UPDATE … RETURNING` must be permitted by RLS — unlike the standard two-policy template used elsewhere, the token table needs the explicit UPDATE policy.

**Single-use enforcement.** The verify handler runs:
```sql
UPDATE candidate_login_tokens
   SET consumed_at = now()
 WHERE token_hash = $1
   AND consumed_at IS NULL
   AND expires_at > now()
RETURNING user_id, tenant_id
```
If the UPDATE returns zero rows (token already consumed, expired, or not found), the handler redirects to `/candidate/login?error=invalid_link`. There is no separate SELECT step — the atomic UPDATE is both the check and the mark, preventing a TOCTOU race between a check and a subsequent consume.

**Relationship to `sessions`.** `candidate_login_tokens` has no FK to `sessions`. A successful verify creates a row in `sessions` (via `01-auth.sessions.create`) with `expires_at = now() + 30 days`. The token row is retained for audit purposes (`consumed_at` timestamp + `requested_ip` / `requested_ua` columns); it is not deleted on consume. Expired unconsumed tokens are swept by the session expiry sweeper (Phase 3 follow-up — same job that purges expired `sessions` rows).

**What is NOT included:**
- No FK from `candidate_login_tokens` to `sessions` — the verify path does not need to walk back from session to token, and adding the FK would create a circular dependency within `01-auth`.
- No `tenant_id` on the linked `sessions` row beyond what `sessions.create` already receives — tenancy flows from `candidate_login_tokens.tenant_id` at verify time.
- No per-token rate-limit column — rate limiting is enforced by the Redis counter on the request endpoint, not stored in the DB.

## Question bank

> **Status: live as of 2026-05-01 (Phase 1 G1.A Session 1).** Migrations at `modules/04-question-bank/migrations/`: `0010_question_packs.sql` (standard tenant_id RLS), `0011_levels.sql`, `0012_questions.sql`, `0013_question_versions.sql`, `0014_tags.sql` (`tags` standard + `question_tags` JOIN-based), `0015_questions_level_pack_fk.sql` (defense-in-depth composite FK). All 6 tables on production `assessiq-postgres`; `tools/lint-rls-policies.ts` enforces both standard and JOIN-based RLS variants in CI.
>
> **JOIN-based RLS for child tables** — `levels`, `questions`, `question_versions`, `question_tags` carry no `tenant_id` column. RLS derives tenancy through the parent `pack_id` FK chain via an `EXISTS (SELECT 1 FROM question_packs p WHERE p.id = child.pack_id AND p.tenant_id = current_setting('app.current_tenant', true)::uuid)` predicate. Two-hop variant (`question_versions`, `question_tags`) joins through `questions → question_packs`. Same fail-closed guarantee: NULL GUC → `tenant_id = NULL` → FALSE → zero rows visible. *Why:* a denormalized `tenant_id` on every child would risk drift (a question moved between packs would need its tenant_id updated; a forgotten update silently leaks rows). The JOIN version is structurally consistent with the FK chain. *Considered and rejected:* (a) denormalized `tenant_id` columns on each child table — drift risk; (b) RLS-via-trigger that updates tenant_id on insert — adds a per-row write path with no defense-in-depth gain. *Not included:* attempt-engine child tables (`attempt_questions`/`attempt_answers`/`attempt_events`) — those use the same JOIN pattern but ship with G1.C.
>
> **Defense-in-depth composite FK** (migration 0015) — `questions.(level_id, pack_id)` references `levels.(id, pack_id)`. Without this FK, a service-layer regression could silently let a question reference a level in a different pack (different tenant). The service guard (`findLevelById` RLS-scoped lookup) is the first line of defense; the composite FK is the structural backstop. Cost: a redundant `UNIQUE (id, pack_id)` on `levels` (id is already PK).
>
> **Platform-tenant master library — `domains`/`categories` seed (migration 0083, 2026-05-22).** *What:* the 9-domain taxonomy + categories (the same set 0019/0020 seed per company tenant) is now also seeded into the **platform** tenant (`slug = 'platform'`) via `0083_seed_platform_tenant_taxonomy.sql`. *Why:* question generation moved to super-admin-only scope (Phase B1); the super admin operates inside the platform tenant. `domains`/`categories` are tenant-scoped (RLS), and 0019 seeded them per-tenant — but the platform tenant is bootstrapped by hand *after* migrations run (README step 5), so it never got the seed and the SA generate screen showed almost no domains. 0083 backfills it, making the platform tenant the canonical master library the SA curates and (Phase 2) grants to companies via billing entitlements. *Considered and rejected:* (a) calling the runtime `seedTenantTaxonomy()` for the platform tenant — its guard explicitly forbids the platform tenantId and that path is per-company onboarding only; (b) hardcoding the platform UUID in the migration — the UUID is hand-assigned and not guaranteed across envs, so 0083 matches by `slug = 'platform'` (seeds on the live DB; `SELECT` returns 0 rows → harmless no-op on a fresh DB where the platform tenant isn't bootstrapped yet). *Idempotent:* `ON CONFLICT … DO NOTHING`; preserves the pre-existing hand-created `soc` domain and adds the rest. *Not included:* the cross-tenant *content*-sharing path — entitlements today grant a publish permission flag, not read access to platform-tenant questions; making a granted set actually usable by a company is deferred to Phase 2. *Downstream impact:* none on company tenants (0083 only touches `slug='platform'`); the runtime `seedTenantTaxonomy()` guard in `modules/04-question-bank/src/seed.ts` is unchanged and still per-company.
>
> **Clone-on-use provenance + uniqueness (migrations 0084 + 0085; Step 2, 2026-05-23).** *What:* `question_packs` gains nullable `source_pack_id` / `source_version`, and `questions` gains nullable `source_question_id` (0084), to record where a clone came from; a partial `UNIQUE INDEX question_packs_tenant_source_uniq ON question_packs (tenant_id, source_pack_id) WHERE source_pack_id IS NOT NULL` (0085) guarantees at most one clone of a given platform source per tenant. *Why:* the **standing-license + clone-on-use** model — when a company builds an assessment from a licensed platform set (`createAssessmentFromSet` → `materializeSetForTenant`), the set is copied into the company tenant tagged with its source, so the publish gate (`assertPublishEntitled`) recognises the clone via `source_pack_id` and the "Available sets" catalog flags *already-added / update-available*. *Forgery-safe:* `source_pack_id` is written ONLY by the system-role clone engine (`modules/04-question-bank/src/clone.ts`); no company-accessible API (`createPack`/`updatePack`) sets it, so it can't be forged to pass the publish gate. *Concurrency:* `materializeSetForTenant` takes `pg_advisory_xact_lock(tenant, source)` so a request burst can't double-clone; the unique index is the structural backstop (RCA 2026-05-23). *Originals* (platform + hand-authored packs) carry NULL provenance. *Not included:* re-sync of an updated source and clone-archival on revoke (the publish gate already blocks revoked licenses) — deferred follow-ups.
>
> **Question difficulty tags (migration 0086; Phase A, 2026-05-23).** *What:* `questions` and `question_versions` each gain four nullable columns — `cognitive_level` (TEXT + CHECK; revised Bloom: remember/understand/apply/analyze/evaluate/create), `nice_task_id` (TEXT; NICE Framework work-role/competency), `difficulty_params` (JSONB; the intended per-(type,level) difficulty vector), `attack_technique` (TEXT[]; MITRE ATT&CK coverage). *Why:* intrinsic item difficulty is presently asserted only via prompt prose + the type-weight mix; these columns let it be tagged, structurally validated (Phase A), and empirically calibrated (Phase C). `cognitive_level` (Bloom) + `nice_task_id` (NICE) are the layered taxonomy decided 2026-05-23 — see `docs/design/2026-05-23-question-difficulty-spec.md`. *Forward-only:* legacy + human-authored rows stay NULL (untagged); new AI-generated rows are stamped by the generation handler (Phase A3). No backfill. *TEXT + CHECK, not ENUM:* repo convention (zero Postgres ENUM types). *No RLS change:* tenancy stays JOIN-derived via `pack_id`. *Considered and rejected:* (a) a Postgres ENUM for `cognitive_level` — inconsistent with the universal TEXT+CHECK pattern and harder to extend; (b) `NOT NULL DEFAULT ''` — would falsely tag legacy rows instead of leaving them distinguishable as untagged. *Not included (this migration):* model-emitted difficulty (the handler stamps deterministically — Phase A3), warn-level embedding checks + `attack_technique` population (Phase B), and a `generation_attempts.difficulty_dropped` counter (open item for Phase A3). *Downstream impact:* `modules/04-question-bank/src/difficulty-spec.ts` is the value source of truth; `insertDrafts` in `modules/07-ai-grading` stamps the columns (Phase A3).
>
> **Domain slug normalization (migration 0090, 2026-05-24 — applied to prod, idempotent).** *What:* `modules/19-billing/migrations/0090_normalize_domain_slugs.sql` normalizes `question_packs.domain` and domain-scope `scope_id` values in `tenant_entitlements` to canonical **lowercase** slugs. *Why:* the licensing resolver (`assertPublishEntitled`) matches entitlement `scope_id` against `question_packs.domain` by exact string. Free-text entry via the old Domain field allowed mixed-case values (e.g. `'SOC'`) that never matched the lowercase platform slug `'soc'`, silently blocking publish even when an entitlement existed. *`tenant_entitlements` collision resolution:* lowercasing `scope_id` can produce UNIQUE `(tenant_id, scope_type, scope_id)` collisions when both `'SOC'` (active) and `'soc'` (revoked) exist for the same tenant. The migration resolves each `(tenant, lower(scope_id))` group by keeping one winner — preferring `status='active'`, then breaking ties on newest `granted_at` — deleting the redundant losers, then lowercasing all survivors. Pack-scope rows (`scope_type='pack'`, `scope_id` is a UUID) are untouched. *Idempotent:* safe to re-run; no-op when all values are already lowercase. *Durable invariant enforced at write paths:* `createPack`/`updatePack` and the `POST /admin/sets/:sourcePackId/import` clone engine lowercase `question_packs.domain` before INSERT/UPDATE; `grantTenantEntitlement` and `revokeTenantEntitlement` lowercase domain `scope_id` before writing; the New-Pack domain dropdown and the Grant Entitlement dropdown both source from the canonical `domains` table (lowercase slugs), removing the free-text entry path that caused the drift. *Considered and rejected:* (a) a Postgres `CHECK` constraint forcing lowercase on `question_packs.domain` — would block legitimate future migration tooling from inserting any casing during backfill windows; write-path enforcement at the service layer is sufficient. *Not included:* retroactive re-index of `question_tags` or `attempt_summary_mv` — those never stored `domain` directly. *Downstream impact:* `GET /api/admin/super/tenants/:tenantId/content-scopes` was updated in the same session to source grantable domain scopes from the `domains` table (canonical slugs) rather than from target-tenant pack rows (see `docs/03-api-contract.md` § content-scopes); this closes the last known path by which a non-canonical slug could reach a grant row.
>
> **Platform domain provenance + cross-tenant management (migration 0091, 2026-05-25).** *What:* `domains` gains `source` (TEXT + CHECK `IN ('platform','tenant')`, default `'tenant'`) and the `status` CHECK is extended to `IN ('active','inactive','archived')`. A backfill marks the platform master tenant's own rows and every company-tenant row whose slug is in the platform domain set as `source='platform'`; every other row (tenant-LOCAL creations) stays `'tenant'`. *Why:* the new super-admin platform domain-management feature creates/archives domains and PROPAGATES the change into every company tenant; `source` is what lets propagation flip every platform-origin copy of a slug while NEVER touching a tenant-LOCAL domain on the same slug (e.g. WIPRO-SOC's `threat-hunting`). *Backfill safety:* `UNIQUE(tenant_id, slug)` means exactly one row per slug per tenant, so a platform slug's single row IS the seeded platform copy; tenant-local domain slugs are not in the platform DOMAIN set and correctly stay `'tenant'` (verified vs prod). *Archive vocabulary:* `'archived'` is the management status; `'inactive'` is unused legacy. **Catalog-only archive (decided 2026-05-25):** archiving a platform domain removes it from selection dropdowns (all filter `status='active'`) and makes it non-grantable going forward, but does NOT revoke existing `tenant_entitlements` for that domain and does NOT untag existing packs/questions — entitlements are decoupled from domain status by design (the publish/license gates compare slug strings and never JOIN `domains`). Reversible via reactivate. *Considered and rejected:* (a) matching propagation by slug ALONE with no `source` column — a future tenant-local domain sharing a platform slug would be clobbered on archive; (b) cascade-revoking entitlements on archive — couples a taxonomy operation to the billing/access path and is hard to reverse. *Not included:* untagging archived-domain content; B3 licensed-set re-sync; category seeding for net-new platform domains (a platform domain created via the API gets a domain row only, matching tenant-local create). *Downstream impact:* `seedTenantTaxonomy()` (`modules/04-question-bank/src/seed.ts`) now seeds a NEW tenant from the LIVE platform active-domain set (copying domains+categories, tagged `source='platform'`) instead of the static hardcoded 0019 list, so platform create/archive flows to future tenants; the hardcoded baseline remains only as a fresh-DB fallback (when no platform tenant exists). New endpoints `GET/POST/PATCH /api/admin/super/domains` (see `docs/03-api-contract.md`). Audit actions `domain.created`/`domain.archived`/`domain.reactivated` added to the catalog (`modules/14-audit-log`).
>
> **Clone question-version snapshots + B3 licensed-set re-sync (migration 0095, 2026-05-25).** *What:* (1) `clonePackToTenant` now writes a `question_versions` row (version=1) per cloned question and inserts the question at `version=2` — mirroring publishPack's end-state (`questions.version = MAX(qv.version)+1`). Migration `0095_backfill_clone_question_versions.sql` backfills the same for pre-existing clone questions (idempotent `NOT EXISTS` guard, scoped to `question_packs.source_pack_id IS NOT NULL`). (2) NEW `resyncClonedPack`/`resyncSetForTenant` (`clone.ts`) refresh an existing clone IN PLACE from a newer master version. *Why the (1) fix:* cloned questions previously had NO `question_versions` row, but the attempt-start pool (`listActiveQuestionPoolForPick`, modules/06) INNER-JOINs `question_versions` — so cloned questions were silently EXCLUDED and a candidate could never start an attempt on a cloned-pack assessment. Latent (cloned-pack assessments had never run end-to-end in prod — licensed pickers empty / platform packs draft). *Re-sync model:* diff master↔clone by `questions.source_question_id` — **add** new master questions (version=2 + qv{v1}, taxonomy-remapped by slug, skip-unresolvable), **version-bump** changed content/rubric (new qv snapshot at the clone question's current version → future attempts resolve the new content via MAX(qv.version); in-flight attempts stay frozen on the prior snapshot), **apply metadata-only** master changes (level/domain/category/points/topic/type — these live on the questions row, not in qv, so no version bump), **archive** questions removed upstream; then bump `question_packs.version` + set `source_version = master.version`. *Decided (2026-05-25):* in-flight/started attempts are never disrupted; FUTURE attempts — even on an existing published assessment — get refreshed content, because the attempt engine never per-assessment version-pins (it serves `MAX(qv.version)` of active questions at attempt-start). This matches how editing a pack's questions already behaves. *Considered and rejected:* faithful per-assessment content-freezing (would require an attempt-engine rewrite to pin selection to `assessments.pack_version`, affecting ALL assessments — out of scope). *Not included:* re-syncing tags on changed questions (only new questions get tags); hard-deleting (vs archiving) upstream-removed questions. *Downstream impact:* new audit action `tenant.pack_resynced` (`modules/14-audit-log`); license-gated endpoint `POST /api/admin/sets/:sourcePackId/resync` (see `docs/03-api-contract.md`); adversarially reviewed (codex:rescue REVISE→ACCEPT: caught a metadata-only-change gap).

```sql
CREATE TABLE question_packs (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  slug            TEXT NOT NULL,                -- 'soc-skills-2026q2'
  name            TEXT NOT NULL,
  domain          TEXT NOT NULL,                -- 'soc','devops','cloud-architect',...
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  version         INT NOT NULL DEFAULT 1,
  created_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug, version)
);

CREATE TABLE levels (
  id                      UUID PRIMARY KEY DEFAULT uuidv7(),
  pack_id                 UUID NOT NULL REFERENCES question_packs(id) ON DELETE CASCADE,
  position                INT NOT NULL,         -- 1, 2, 3...
  label                   TEXT NOT NULL,        -- 'L1','L2','L3' or 'Junior','Mid','Senior'
  description             TEXT,
  duration_minutes        INT NOT NULL,
  default_question_count  INT NOT NULL,
  passing_score_pct       INT NOT NULL DEFAULT 60,
  rubric_defaults         JSONB DEFAULT NULL,   -- Stage 1.5 (0017): AI rubric calibration hints {profile, anchorComplexity, bandStrictness}; NULL = ordinal-only fallback
  UNIQUE (pack_id, position)
);
-- Partial index for analytics on rubric calibration profiles (0017)
CREATE INDEX IF NOT EXISTS idx_levels_rubric_defaults_profile
  ON levels ((rubric_defaults->>'profile'))
  WHERE rubric_defaults IS NOT NULL;

CREATE TABLE questions (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  pack_id         UUID NOT NULL REFERENCES question_packs(id),
  level_id        UUID NOT NULL REFERENCES levels(id),
  type            TEXT NOT NULL CHECK (type IN ('mcq','subjective','kql','scenario','log_analysis')),
  topic           TEXT NOT NULL,
  points          INT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived','ai_draft')),  -- 0016: ai_draft = AI-generated, pending admin review
  version         INT NOT NULL DEFAULT 1,
  content         JSONB NOT NULL,               -- type-specific shape, see below
  rubric          JSONB,                        -- for subjective/scenario; null for deterministic types
  answer_guidance TEXT,                          -- 0098: candidate-facing answer-format hint ("HOW to answer"). Instructional/candidate-safe (never a rubric/answer key). NULL → per-type default applied at serve time. Live-read like topic/points — NOT snapshotted to question_versions; editing it does NOT bump version.
  knowledge_base_sources JSONB NOT NULL DEFAULT '[]'::jsonb,  -- Stage 1.5 (0016): KB provenance for AI-generated questions; [] for human-authored
  source_question_id UUID,                      -- 0084: clone provenance (NULL for originals); written only by the system-role clone engine
  cognitive_level    TEXT CHECK (cognitive_level IS NULL OR cognitive_level IN ('remember','understand','apply','analyze','evaluate','create')),  -- 0086: revised Bloom level; NULL = untagged legacy/human-authored (forward-only)
  nice_task_id       TEXT,                       -- 0086: NICE Framework work-role/competency tag; NULL = untagged
  difficulty_params  JSONB,                      -- 0086: intended per-(type,level) difficulty vector stamped at generation; NULL = untagged
  attack_technique   TEXT[],                     -- 0086: MITRE ATT&CK coverage tags; NULL until Phase B extraction
  created_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX questions_pack_level_idx ON questions (pack_id, level_id, status);

CREATE TABLE question_versions (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  question_id     UUID NOT NULL REFERENCES questions(id),
  version         INT NOT NULL,
  content         JSONB NOT NULL,
  rubric          JSONB,
  knowledge_base_sources JSONB NOT NULL DEFAULT '[]'::jsonb,  -- Stage 1.5 (0016): inherited from questions.knowledge_base_sources at snapshot time
  cognitive_level    TEXT CHECK (cognitive_level IS NULL OR cognitive_level IN ('remember','understand','apply','analyze','evaluate','create')),  -- 0086: difficulty tags inherited from questions at snapshot time
  nice_task_id       TEXT,                       -- 0086
  difficulty_params  JSONB,                      -- 0086
  attack_technique   TEXT[],                     -- 0086
  saved_by        UUID NOT NULL REFERENCES users(id),
  saved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (question_id, version)
);

> **`answer_guidance` is deliberately NOT in `question_versions` (0098).** Unlike
> `content`/`rubric` (frozen per attempt so an edit never changes what an
> in-flight candidate sees), the answer-format hint is a presentational
> instruction with no grading consequence. It is read LIVE from the `questions`
> row at serve time — exactly like `topic`/`points`, which are also live-read and
> not snapshotted. Module 04 `updateQuestion` therefore treats it as a
> metadata-only patch (no version bump), and module 06's candidate read joins the
> live `questions` row for it. NULL is resolved to a per-type default by module
> 06's `answerGuidanceFor()` so every served question shows a hint. Phase A
> (foundation) ships the column + wiring; Phase B fills it via an admin-triggered
> AI generator.

CREATE TABLE tags (
  id          UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  category    TEXT,                              -- 'mitre','tactic','tool'
  UNIQUE (tenant_id, name)
);

CREATE TABLE question_tags (
  question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  tag_id      UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, tag_id)
);
```

### `questions.content` shapes by type

**MCQ**
```json
{
  "question": "While monitoring the SIEM dashboard...",
  "options": ["...", "...", "...", "..."],
  "correct": 2,
  "rationale": "L1 must validate context before action..."
}
```

**Subjective** — note `rubric` lives in the separate column for `gradings` join performance
```json
{
  "question": "Describe the steps you would follow when..."
}
```
With `rubric` column:
```json
{
  "anchors": [
    { "id": "a1", "concept": "lateral movement", "weight": 20, "synonyms": ["lateral movement","T1021","east-west"] },
    { "id": "a2", "concept": "credential reuse", "weight": 20, "synonyms": ["credential reuse","credential stuffing","reused passwords"] }
  ],
  "reasoning_bands": {
    "band_4": "All anchors + correct causal chain + correct escalation path",
    "band_3": "All anchors + minor causal gap or escalation imprecision",
    "band_2": "Partial anchors + surface-level reasoning",
    "band_1": "Anchors mentioned without understanding (keyword stuffing)",
    "band_0": "Wrong direction or no answer"
  },
  "anchor_weight_total": 60,
  "reasoning_weight_total": 40
}
```

**KQL**
```json
{
  "question": "Detect Office macro execution leading to outbound network...",
  "tables": [
    "DeviceProcessEvents (Timestamp, DeviceName, FileName, InitiatingProcessFileName, ProcessId)",
    "DeviceNetworkEvents (Timestamp, DeviceName, RemoteUrl, RemoteIP, InitiatingProcessId)"
  ],
  "hint": "Use let to define suspicious-parents filter, project before join...",
  "expected_keywords": ["DeviceProcessEvents","DeviceNetworkEvents","join","InitiatingProcessFileName","winword","ProcessId"],
  "sample_solution": "let SuspiciousParents = dynamic([...])..."
}
```

**Scenario** (multi-step incident chain)
```json
{
  "title": "Suspicious sign-in followed by privilege escalation",
  "intro": "At 02:14 UTC, an alert fires...",
  "steps": [
    { "id": "s1", "type": "subjective", "prompt": "What is your hypothesis?", "rubric_ref": "..." },
    { "id": "s2", "type": "kql",        "prompt": "Pull the sign-in logs for this user...", "expected_keywords": [...] },
    { "id": "s3", "type": "mcq",        "prompt": "Should you escalate now?", "options": [...], "correct": 1, "trap": true },
    { "id": "s4", "type": "subjective", "prompt": "Write the RCA.", "rubric_ref": "..." }
  ],
  "step_dependency": "linear"
}
```

**Log_analysis** (mirrors `kql` shape — `log_excerpt` replaces `tables`, `expected_findings` replaces `expected_keywords`. Pinned 2026-05-01 per Phase 1 plan decision #3.)
```json
{
  "question": "Analyze the following Azure AD sign-in logs and identify the suspicious activity. List your findings.",
  "log_excerpt": "2026-04-30T22:14:01Z user=jane.doe@x.com src_ip=185.220.101.42 result=success mfa=skipped\n2026-04-30T22:14:38Z user=jane.doe@x.com src_ip=185.220.101.42 action=role_assignment role=GlobalAdmin\n2026-04-30T22:15:02Z user=jane.doe@x.com src_ip=185.220.101.42 action=token_mint scope=full",
  "log_format": "syslog",
  "expected_findings": [
    "TOR exit node source IP",
    "MFA was skipped on a privileged sign-in",
    "Privilege escalation via role_assignment",
    "Token minted with full scope minutes after escalation"
  ],
  "hint": "Cross-reference src_ip reputation, MFA enforcement gaps, and the timing between events.",
  "sample_solution": "..."
}
```

`log_format` is one of `syslog | json | csv | freeform` — used by the candidate UI to pick a syntax-aware viewer. `expected_findings` is a list of distinct concepts the candidate's answer must surface; matching is fuzzy (anchor-style, similar to the `subjective` rubric — see `08-rubric-engine`). The Phase 1 importer JSON schema validates this shape via Zod (`modules/04-question-bank/src/types.ts`).

## Assessment lifecycle

> **Status: live as of 2026-05-02 (Phase 1 G1.B Session 3).** Migrations `0020_assessment_status_enum.sql`, `0021_assessments.sql`, `0022_assessment_invitations.sql` shipped under `modules/05-assessment-lifecycle/migrations/`. The Postgres `gen_random_uuid()` is used as the `DEFAULT` (not `uuidv7()`); the snippet below preserves the spec-style `uuidv7()` for documentation but the live migrations match the rest of the schema and use `gen_random_uuid()` as the column default while application code generates uuidv7 explicitly via `@assessiq/core uuidv7()`.
>
> **Additive surface vs spec:**
>
> - `assessments.pack_version INT NOT NULL` — frozen-contract pointer to `question_packs.version` at create time. Snapshotted by `service.createAssessment` from the pack's current version. Republishing a pack does NOT re-bind existing assessments — the `(pack_id, pack_version)` tuple is the immutable content contract. Not in the original spec; added per the Phase 1 G1.B Session 3 plan.
> - `CHECK (opens_at IS NULL OR closes_at IS NULL OR opens_at < closes_at)` — DB-layer backstop for the service's `assertValidWindow` (defence-in-depth).
> - Indexes — `assessments_tenant_status_idx (tenant_id, status)` for `listAssessments`; partial indexes `assessments_open_boundary_idx (opens_at) WHERE status='published'` and `assessments_close_boundary_idx (closes_at) WHERE status='active'` for the BullMQ boundary cron. Index sizes stay small because the partial predicates filter to states the cron actually scans.
> - `tenants.smtp_config JSONB` (additive, lives in `modules/02-tenancy/migrations/0004_tenants_smtp_config.sql`) — per-tenant SMTP credentials shape. Phase 1 SMTP driver swap-in is deferred; the column is empty / NULL on every tenant today and the dev-emails.log stub continues to handle invitation sends. Decision #12 in the SKILL.md.
>
> **JOIN-based RLS for `assessment_invitations`:** the table carries no `tenant_id` column. Both RLS policies use an `EXISTS` sub-select that joins back to `assessments` and checks `a.tenant_id = current_setting('app.current_tenant', true)::uuid` — same pattern as `levels` / `questions`. The linter (`tools/lint-rls-policies.ts`) was extended in this commit to enforce this; `assessment_invitations` is now in `JOIN_RLS_TABLES`.

```sql
CREATE TYPE assessment_status AS ENUM ('draft','published','active','closed','cancelled');

CREATE TABLE assessments (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  pack_id         UUID NOT NULL REFERENCES question_packs(id),
  level_id        UUID NOT NULL REFERENCES levels(id),
  pack_version    INT NOT NULL,                          -- frozen pointer; snapshotted at create time
  name            TEXT NOT NULL,
  description     TEXT,
  status          assessment_status NOT NULL DEFAULT 'draft',
  question_count  INT NOT NULL CHECK (question_count >= 1),
  randomize       BOOLEAN NOT NULL DEFAULT true,
  opens_at        TIMESTAMPTZ,
  closes_at       TIMESTAMPTZ,
  settings        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- per-assessment overrides; empty in Phase 1
  created_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assessments_window_chk
    CHECK (opens_at IS NULL OR closes_at IS NULL OR opens_at < closes_at)
);

CREATE TABLE assessment_invitations (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  assessment_id   UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  token_hash      TEXT NOT NULL UNIQUE,                  -- sha256 of plaintext; plaintext only in email body
  expires_at      TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','viewed','started','submitted','expired')),
  invited_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, user_id)
  -- JOIN-based RLS — no tenant_id column; tenancy resolves via assessment_id → assessments.tenant_id
);
```

## Attempts

> **Status: live** as of Phase 1 G1.C Session 4a (2026-05-02). Migrations 0030-0033 in `modules/06-attempt-engine/migrations/`. Diff vs the original sketch below: (a) `status` CHECK aligns with PROJECT_BRAIN decision (`'draft','in_progress','submitted','auto_submitted','cancelled','pending_admin_grading','graded','released'`); (b) added `ends_at`, `duration_seconds` columns to make the timer server-pinned at start; (c) added `client_revision INT NOT NULL DEFAULT 0` on `attempt_answers` (decision #7); (d) added `saved_at` on `attempt_answers` and dropped `updated_at`; (e) `integrity` and `client_meta` columns on `attempts` deferred — those signals live in `attempt_events` rows for now (Phase 2 may aggregate into a denormalized column on the row); (f) added partial UNIQUE index on `(attempt_id) WHERE event_type='event_volume_capped'` enforcing the cap-once invariant (decision #23); (g) RLS for `attempts` is the standard variant (tenant-bearing), JOIN-RLS for the three child tables.

Live schema (after migrations apply):

```sql
CREATE TABLE attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  assessment_id   UUID NOT NULL REFERENCES assessments(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','in_progress','submitted','auto_submitted','cancelled',
    'pending_admin_grading','graded','released'
  )),
  started_at      TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,                            -- pinned at start = started_at + level.duration_minutes
  submitted_at    TIMESTAMPTZ,
  duration_seconds INT,                                    -- snapshot of level.duration_minutes * 60
  embed_origin    BOOLEAN NOT NULL DEFAULT FALSE,          -- Phase 4 (2026-05-03): TRUE when attempt was started via embed JWT flow (D2); used in analytics and admin filters
  ai_proposals    JSONB,                                   -- Migration 0100 (2026-05-29, Bug A robustness): server-side cache of latest GradingProposal[] from handleAdminGrade. Review buffer ONLY — D8 unchanged, no gradings row is written without admin Accept click. Cleared in same tx as the gate-flip status='graded' in admin-accept.ts (true completion). Lets the FE hydrate proposals state on page load even if the original synchronous POST /grade response was dropped by Cloudflare's ~100s edge timeout. Null when no run yet or after a successful accept.
  grading_started_at TIMESTAMPTZ,                          -- Migration 0100 (2026-05-29): in-flight marker. SET by handleAdminGrade on entry (after status + heartbeat + single-flight checks), nulled at batch completion (success or thrown-error catch path). Drives the FE "Grading in progress" banner + 15s auto-poll. FE treats marker > 10 min as stalled (likely API restart mid-batch) — shows "Re-grade (previous stalled)" + caps polling at 12 min. A fresh Grade-all click overwrites a stale marker (no DB-level lock needed; the single-flight mutex is the real lock).
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, user_id)                         -- one attempt per user per assessment v1
);
CREATE INDEX attempts_user_idx ON attempts (tenant_id, user_id);
CREATE INDEX attempts_timer_sweep_idx ON attempts (ends_at) WHERE status = 'in_progress';
CREATE INDEX attempts_assessment_status_idx ON attempts (assessment_id, status);
-- Phase 4 partial index for embed attempt queries (sparse — most attempts are non-embed)
CREATE INDEX attempts_embed_origin_idx ON attempts (tenant_id, embed_origin) WHERE embed_origin = TRUE;
-- Migration 0100 partial index for the rare "find attempts currently grading" query
CREATE INDEX attempts_grading_started_at_idx ON attempts (grading_started_at) WHERE grading_started_at IS NOT NULL;

CREATE TABLE attempt_questions (
  attempt_id      UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id     UUID NOT NULL REFERENCES questions(id),
  position        INT NOT NULL,
  question_version INT NOT NULL,                          -- frozen at attempt start (JOINs question_versions)
  PRIMARY KEY (attempt_id, question_id)
);

CREATE TABLE attempt_answers (
  attempt_id      UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id     UUID NOT NULL REFERENCES questions(id),
  answer          JSONB,                                  -- shape depends on questions.type
  flagged         BOOLEAN NOT NULL DEFAULT false,
  time_spent_seconds INT NOT NULL DEFAULT 0,
  edits_count     INT NOT NULL DEFAULT 0,
  client_revision INT NOT NULL DEFAULT 0,                 -- decision #7: monotonic via SQL GREATEST + 1
  saved_at        TIMESTAMPTZ,
  PRIMARY KEY (attempt_id, question_id)
);

CREATE TABLE attempt_events (
  id              BIGSERIAL PRIMARY KEY,
  attempt_id      UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,                          -- catalog in modules/06-attempt-engine/EVENTS.md
  question_id     UUID,
  payload         JSONB,
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attempt_events_attempt_idx ON attempt_events (attempt_id, at);
CREATE UNIQUE INDEX attempt_events_capped_unique_idx
  ON attempt_events (attempt_id) WHERE event_type = 'event_volume_capped';
```

**Frozen-version contract:** `attempt_questions.question_version` snapshots `questions.version` at startAttempt time. Reading the candidate's view JOINs `question_versions ON (question_id, version)` so admin edits to the live `questions.content` after start are invisible to the in-flight attempt. Verified by `modules/06-attempt-engine/src/__tests__/attempt-engine.test.ts § getAttemptForCandidate "returns frozen content even after admin edits live question"`.

**Phase 1 grading-free contract** (CLAUDE.md AssessIQ-specific rule #1, decision #6): `submitAttempt` transitions `status` to `'submitted'` and stops. The values `'pending_admin_grading'`, `'graded'`, `'released'` are accepted by the CHECK constraint for forward-compat but never written by Phase 1 code. The candidate's `/api/me/attempts/:id/result` endpoint returns `202 grading_pending` until Phase 2 wires module 07 + 08.

**`integrity` / `client_meta` columns** (in the original sketch above) — explicitly dropped from the live schema. Behavioural signals live in `attempt_events` rows; if Phase 2 wants a denormalized aggregate, the read path can compute it from events in `attempt_scores`.

### `assessment_frozen_pool` — "lock at assignment" (migration 0096, 2026-05-25)

```sql
CREATE TABLE assessment_frozen_pool (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  assessment_id     UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  question_id       UUID NOT NULL REFERENCES questions(id),
  question_version  INT  NOT NULL,                         -- MAX(question_versions.version) at publish
  level_id          UUID NOT NULL REFERENCES levels(id),
  domain_id         UUID,                                  -- for the blueprint per-criterion re-filter
  category_id       UUID,
  type              TEXT NOT NULL,
  points            INT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assessment_frozen_pool_uniq UNIQUE (assessment_id, question_id)
);
-- RLS: tenant_isolation (USING) + tenant_isolation_insert (WITH CHECK), same as assessments.
```

**What:** a per-assessment snapshot of the _eligible_ question pool, captured at publish. **Why:** before 0096, an assessment's content was resolved LIVE at attempt-start (`questions` `status='active'` pinned to `MAX(qv.version)`), so editing/re-syncing a pack changed what FUTURE attempts of an already-published assessment drew — and two candidates of one assessment could even get different content if the pack changed between their start times. Freezing at publish makes each assessment's content immutable: master-pack revisions and clone auto-sync only reach NEWLY-published assessments.

**Write path:** `freezeAssessmentPool` (module 05 service) runs inside `publishAssessment`/`reopenAssessment`'s `withTenant` tx via `INSERT … SELECT q.id, MAX(qv.version), q.domain_id, q.category_id, q.type, q.points FROM questions q JOIN question_versions qv … WHERE pack_id=$ AND level_id=$ AND status='active' GROUP BY …` — mirroring the live pool query byte-for-byte so the snapshot equals what a live draw would have selected. **Write-once** via `ON CONFLICT (assessment_id, question_id) DO NOTHING`: the first publish freezes; a later reopen is a no-op (keeps the original content).

**Read path:** module 06 `startAttempt` resolves `useFrozen = countFrozenPool(assessmentId) > 0`; if frozen it draws from `assessment_frozen_pool` (whole-pool, or re-filtered by `(domain_id, category_id, type)` for blueprints) instead of the live `questions` queries. The frozen list helpers return the identical `{ id, version }` shape + `ORDER BY question_id ASC`, so the existing shuffle/size-check/`attempt_questions` snapshot is unchanged.

**Fallback (forward-only):** an assessment with **no** frozen rows (legacy/pre-0096; pre-launch has no real attempts) falls back to the live query — behaviour identical to before. No backfill. **Relationship to `attempt_questions`:** distinct concerns — `assessment_frozen_pool` is the per-assessment eligible SET (written at publish); `attempt_questions` is the per-attempt chosen subset (written at attempt-start, unchanged). Both pin via `(question_id, version)`.

## Grading & scoring

> **Status note (2026-05-03) — Phase 2 G2.A Session 1.a redesign.**
>
> **What changed.** The `gradings` table shape below is the live shape per migration `modules/07-ai-grading/migrations/0040_gradings.sql`. The `tenant_grading_budgets` table is new per migration `0041_tenant_grading_budgets.sql`. Both ship in commit `7eea75b`. The `prompt_versions` and `grading_jobs` tables are NOT in Phase 1 — they are deferred to Phase 2 with the paid-API runtime, and now appear in the Phase 2 (deferred) subsection at the bottom of this section.
>
> **Why.** The 8 pinned decisions in `docs/05-ai-pipeline.md` § "Decisions captured (2026-05-01)" replaced the Phase-2-leaning shape this section originally documented. D4 stores prompt provenance as three NOT NULL columns on `gradings` (`prompt_version_sha`, `prompt_version_label`, `model`) — file-based skill SHA pinning, no FK to a `prompt_versions` table. D3 keeps `grading_jobs` out of Phase 1 entirely (tracked instead by the in-process single-flight mutex + `attempts.status`). D6 introduces `tenant_grading_budgets` as the per-tenant USD ceiling that the Phase 2 anthropic-api runtime checks pre-call.
>
> **Considered and rejected.** (a) Keeping `gradings.prompt_version_id` as a FK to `prompt_versions` — rejected because Phase 1 has no `prompt_versions` table and the file-on-disk skill SHA is the durable pin (D4). (b) Adding `grading_jobs` in Phase 1 anyway "for symmetry" — rejected because a synchronous handler writing then reading the same row is ceremony without benefit (D3). (c) Storing budget as a token count instead of USD — rejected because tenants pay in USD; tokens are implementation leakage (D6).
>
> **Not included in this session (deferred to G2.A Sessions 1.b / 1.c).** No `prompt_versions` table (Phase 2 only when paid API needs a queryable prompt history). No `grading_jobs` table (Phase 2). No `attempt_scores` schema change here — that table belongs to module 09-scoring and ships with G2.B.
>
> **Downstream impact.** Module 09-scoring reads `gradings` for per-attempt aggregation and consumes `escalation_chosen_stage` for stage badges. Module 10-admin-dashboard reads `tenant_grading_budgets` for billing UI and reads `prompt_version_sha` to surface the "skill drift" badge when current `skillSha()` ≠ stored SHA. Module 13-notifications fires a `budget_exhausted` template when D6 enforcement trips (Phase 2). The `lint-rls-policies.ts` linter (`tools/`) was extended to special-case `tenant_grading_budgets` alongside `tenants` (PK=tenant_id RLS variant).

```sql
-- Phase 1 live shape — modules/07-ai-grading/migrations/0040_gradings.sql
CREATE TABLE gradings (
  id                       UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id),
  attempt_id               UUID NOT NULL REFERENCES attempts(id),
  question_id              UUID NOT NULL REFERENCES questions(id),
  grader                   TEXT NOT NULL CHECK (grader IN (
    'deterministic','pattern','ai','admin_override'
  )),
  score_earned             NUMERIC(6,2) NOT NULL,
  score_max                NUMERIC(6,2) NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN (
    'correct','incorrect','partial','review_needed','overridden'
  )),
  anchor_hits              JSONB,                              -- per-anchor evidence
  reasoning_band           INT,                                -- 0..4
  ai_justification         TEXT,
  error_class              TEXT,                               -- e.g. 'missed_pivot_to_identity'
  -- D4: per-row prompt SHA pinning. NOT NULL — every AI row reproducible.
  prompt_version_sha       TEXT NOT NULL,                      -- 'anchors:<8hex>;band:<8hex>;escalate:<8hex|->'
  prompt_version_label     TEXT NOT NULL,                      -- skill frontmatter `version:`
  model                    TEXT NOT NULL,                      -- concatenated model ids
  -- Which stage of the cascade actually produced the row. NULL for deterministic/pattern.
  escalation_chosen_stage  TEXT CHECK (escalation_chosen_stage IS NULL
                                       OR escalation_chosen_stage IN ('2','3','manual')),
  graded_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  graded_by                UUID REFERENCES users(id),          -- null for AI/automated
  override_of              UUID REFERENCES gradings(id),       -- self-ref for admin overrides
  override_reason          TEXT
);
CREATE INDEX gradings_attempt_idx ON gradings (attempt_id, question_id);

-- D7 idempotency backstop: re-grade with same (attempt, question, sha) returns
-- the existing row instead of writing a duplicate. Phase 1 single-flight is
-- the in-process mutex; this UNIQUE protects against a buggy mutex.
CREATE UNIQUE INDEX gradings_attempt_question_sha_idx
  ON gradings (attempt_id, question_id, prompt_version_sha)
  WHERE override_of IS NULL;

-- Standard tenant_id-bearing RLS (CREATE POLICY tenant_isolation +
-- tenant_isolation_insert per the template at the bottom of this doc).

-- Phase 1 live shape — modules/07-ai-grading/migrations/0041_tenant_grading_budgets.sql
-- D6: per-tenant USD ceiling for Phase 2 anthropic-api runtime. PK = tenant_id
-- (special-case RLS variant; same shape as `tenants` itself). Phase 1
-- claude-code-vps mode does not consume budget; the table ships now so
-- module 10 billing UI has a stable target and the future runtime's
-- pre-call gate (D6) can read from a populated row without a separate
-- migration.
CREATE TABLE tenant_grading_budgets (
  tenant_id            UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  monthly_budget_usd   NUMERIC(10,2) NOT NULL DEFAULT 0,
  used_usd             NUMERIC(10,2) NOT NULL DEFAULT 0,
  period_start         DATE NOT NULL DEFAULT CURRENT_DATE,
  alert_threshold_pct  NUMERIC(5,2) NOT NULL DEFAULT 80,
  alerted_at           TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- RLS uses `tenant_id = current_setting('app.current_tenant', true)::uuid`
-- (PK is the discriminator). lint-rls-policies.ts:178-185 carve-out matches.

### `generation_attempts` — AI question-generation observability (Phase 1 / Stage 1, 2026-05-09)

> **Status:** LIVE — migrations `0042_generation_attempts.sql` + `0043_generation_attempts_citation_dropped.sql` (`modules/07-ai-grading/migrations/`). Applied to production as part of the Stage 1 type-sharded generation release (`f449203`). Records every `handleAdminGenerate` invocation so admins can diagnose why a "Generate" click produced zero or fewer-than-requested questions without SSH'ing the VPS.

**Ownership note.** The INSERT/UPDATE write path lives in `modules/07-ai-grading/src/handlers/admin-generate.ts`. The GET read endpoint is in `modules/04-question-bank/src/routes.ts` (read-only projection for the pack-detail UI). Table is owned by 07-ai-grading because the write path and all observability concepts (`skill_sha`, `model`, `stderr_tail`, `chunks_*`) belong to that module.

**`stderr_tail` privacy gate.** Persisted only for non-grading skills (`generate-questions`, `generate-rubric`). For grading skills, stderr is captured in memory but never logged or persisted — candidate text must not appear in any durable store. Gate lives in `modules/07-ai-grading/src/runtimes/claude-code-vps.ts`.

**`batch_id` history grouping (migration 0106, 2026-06-01).** Nullable `UUID`. One "Generate question set" wizard action fires one `POST /admin/generate` per category — each writes its own `generation_attempts` row (required for per-category progress, resume, and category tagging) — so an N-category set produced N separate history rows. The wizard now mints one `crypto.randomUUID()` per batch (persisted on the localStorage `GenBatchPlan`, so a *resumed* batch keeps the same id) and sends it on every per-category call; `handleAdminGenerate` persists it (`$7::uuid`, parameterised); the route parses an optional UUID-validated `batch_id` (tenantId still always from session); `GET /admin/generation-attempts` adds it to the SELECT projection only (no new WHERE/ORDER-BY). The history UI collapses equal-non-null-`batch_id` rows into one expandable parent (rollup status running>partial>success, summed counts/duration, "N runs", expand → per-category children); NULL/legacy rows render standalone. **`batch_id` is NOT a tenant/authz boundary** — isolation stays solely on `tenant_id` RLS, and grouping is computed in the app layer over already-tenant-scoped rows. Adversarial-reviewed ACCEPT.

```sql
-- modules/07-ai-grading/migrations/0042_generation_attempts.sql +
--   0043_generation_attempts_citation_dropped.sql +
--   0087_generation_attempts_difficulty_dropped.sql
CREATE TABLE generation_attempts (
  id               UUID        NOT NULL PRIMARY KEY,  -- UUIDv7, generated app-side
  tenant_id        UUID        NOT NULL REFERENCES tenants(id),
  pack_id          UUID        NOT NULL,
  level_id         UUID        NOT NULL,
  user_id          UUID        NOT NULL REFERENCES users(id),
  count_requested  INT         NOT NULL,
  count_inserted   INT         NOT NULL DEFAULT 0,
  status           TEXT        NOT NULL CHECK (status IN (
                     'success', 'partial', 'failed', 'running'
                   )),
  error_code       TEXT,
  error_message    TEXT,
  stderr_tail      TEXT,         -- last 1024 bytes of claude stderr; generation skills only
  skill_sha        TEXT,
  model            TEXT,
  chunks_planned   INT,          -- NULL until Option B parallel fanout ships
  chunks_failed    INT,          -- NULL until Option B parallel fanout ships
  dedupe_dropped   INT,          -- NULL until Option B parallel fanout ships
  citation_dropped INT,          -- 0043: questions dropped for hallucinated KB citation IDs; NULL if filter not applied
  difficulty_dropped INT,        -- 0087: questions dropped by the structural difficulty gate (Phase A3, difficulty-spec.ts); NULL if not applied
  batch_id         UUID,         -- 0106: client-minted UUID shared by all per-category rows of ONE "Generate question set" wizard action; NULL = legacy/single-call → renders standalone. NOT a tenant boundary (see note below).
  duration_ms      INT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);

-- Most-recent attempts for a pack+level — drives the pack-detail UI query.
CREATE INDEX generation_attempts_pack_level_idx
  ON generation_attempts (pack_id, level_id, started_at DESC);

-- 0106: group lookups for the history projection; partial keeps it small (batched runs only).
CREATE INDEX generation_attempts_batch_idx
  ON generation_attempts (batch_id, started_at DESC)
  WHERE batch_id IS NOT NULL;

ALTER TABLE generation_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON generation_attempts
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON generation_attempts
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
```

-- attempt_scores — module 09-scoring. LIVE (shipped G2.B Session 3, 2026-05-01).
-- Migration: modules/09-scoring/migrations/0050_attempt_scores.sql
-- What: Stores the aggregated scoring result for one attempt. Single row per
-- attempt (UPSERT on recompute). Written by computeAttemptScore() after each
-- admin-accept grading cycle (non-fatal fire-and-forget from handleAdminAccept)
-- and by GET /api/admin/attempts/:id/score on demand.
-- Why: Decouples "sum gradings" from "query scores" — the reporting and
-- leaderboard endpoints read from this table (cheap) rather than re-aggregating
-- gradings at query time (expensive). Also the home for archetype_signals JSONB.
-- Considered and rejected: (a) materialised view — rejected because UPSERT
-- semantics allow recomputation on override without a REFRESH; (b) storing
-- archetype signals separately — rejected because signals + label are always
-- read together and JSONB avoids adding 11 nullable float columns.
-- Not included: per-question score breakdown (that's in `gradings`), section
-- sub-scores (Phase 3+), threshold pass/fail flag (Phase 3+).
-- Downstream impact: 10-admin-dashboard reads auto_pct + archetype.
-- 15-analytics reads auto_pct + computed_at for export CSV.
CREATE TABLE attempt_scores (
  attempt_id        UUID PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  total_earned      NUMERIC(8,2) NOT NULL,
  total_max         NUMERIC(8,2) NOT NULL,
  auto_pct          NUMERIC(5,2) NOT NULL,       -- total_earned/total_max * 100
  pending_review    BOOLEAN NOT NULL DEFAULT false, -- any grading still review_needed
  archetype         TEXT,                          -- e.g. 'methodical_diligent', null if < 2 prior scored attempts
  archetype_signals JSONB,                         -- full signal bag (P2.D11), null if archetype=null
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Indexes
CREATE INDEX attempt_scores_tenant_computed_idx ON attempt_scores (tenant_id, computed_at DESC);
CREATE INDEX attempt_scores_tenant_archetype_idx ON attempt_scores (tenant_id, archetype) WHERE archetype IS NOT NULL;
-- RLS: direct tenant_id pattern. Two policies — no-FOR clause covers ALL (incl. UPDATE for UPSERT),
-- INSERT WITH CHECK covers insert writes.
ALTER TABLE attempt_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON attempt_scores
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation_insert ON attempt_scores
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
```

### Phase 2 (deferred) — `prompt_versions`, `grading_jobs`

These tables ship when `AI_PIPELINE_MODE` flips to `anthropic-api` (D1). They are NOT in Phase 1.

```sql
-- D4 (Phase 2): durable, queryable prompt history for the paid-API runtime.
-- In Phase 1 this role is filled by the file-on-disk skill SHA; in Phase 2
-- the skill content moves into a row so the SDK call site can reference it
-- by FK and so the eval harness can join across runs.
CREATE TABLE prompt_versions (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  name            TEXT NOT NULL,                              -- 'grade-band'
  version         INT NOT NULL,
  template        TEXT NOT NULL,
  model           TEXT NOT NULL,                              -- 'claude-sonnet-4-6'
  hash            TEXT NOT NULL UNIQUE,                       -- sha256 of template
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

-- D3 (Phase 2): async queue + state machine for the BullMQ worker.
-- Phase 1 has NO `grading_jobs` row — in-flight grading is tracked by the
-- in-process single-flight mutex + `attempts.status = pending_admin_grading
-- → graded`. Manual re-trigger only.
CREATE TABLE grading_jobs (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  attempt_id      UUID NOT NULL REFERENCES attempts(id),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','in_progress','done','failed')),
  attempt_count   INT NOT NULL DEFAULT 0,
  prompt_version_sha TEXT NOT NULL,                           -- D4 idempotency key part
  worker_id       TEXT,
  claimed_at      TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  cost_input_tokens  INT,
  cost_output_tokens INT,
  error_class     TEXT,
  error_message   TEXT,
  raw_output      JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, prompt_version_sha)                     -- D3 idempotency
);
```

## Audit, notifications, help

```sql
CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  actor_user_id   UUID REFERENCES users(id),
  actor_kind      TEXT NOT NULL CHECK (actor_kind IN ('user','api_key','system')),
  action          TEXT NOT NULL,                           -- 'assessment.create','grading.override',...
  entity_type     TEXT NOT NULL,
  entity_id       UUID,
  before          JSONB,
  after           JSONB,
  ip              INET,
  user_agent      TEXT,
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_at_idx ON audit_log (tenant_id, at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);

CREATE TABLE email_log (
  id                  UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  to_address          TEXT NOT NULL,
  subject             TEXT NOT NULL,
  template_id         TEXT NOT NULL,
  body_text           TEXT,
  body_html           TEXT,
  status              TEXT NOT NULL DEFAULT 'queued'        -- 'queued','sending','sent','failed','bounced'
                      CHECK (status IN ('queued','sending','sent','failed','bounced')),
  provider            TEXT,
  provider_message_id TEXT,
  attempts            INT NOT NULL DEFAULT 0,
  last_error          TEXT,
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_log_tenant_created_idx ON email_log (tenant_id, created_at DESC);
CREATE INDEX email_log_tenant_status_idx ON email_log (tenant_id, status)
  WHERE status IN ('queued','failed','bounced');

CREATE TABLE in_app_notifications (
  id          UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  audience    TEXT NOT NULL CHECK (audience IN ('user','role','all')),
  user_id     UUID REFERENCES users(id),                   -- set when audience='user'
  role        TEXT CHECK (role IN ('admin','reviewer')),   -- set when audience='role'
  kind        TEXT NOT NULL,                               -- 'attempt.graded', 'weekly.digest', etc.
  message     TEXT NOT NULL,
  link        TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX in_app_notif_unread_idx ON in_app_notifications
  (tenant_id, audience, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE webhook_endpoints (
  id                UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  name              TEXT NOT NULL,
  url               TEXT NOT NULL,
  secret_enc        BYTEA NOT NULL,                        -- AES-256-GCM encrypted; plaintext returned ONCE on create
  events            TEXT[] NOT NULL,                       -- ['attempt.submitted','audit.*']
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','disabled')),
  requires_fresh_mfa BOOLEAN NOT NULL DEFAULT false,       -- true when events includes audit.*
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id           UUID PRIMARY KEY DEFAULT uuidv7(),
  endpoint_id  UUID NOT NULL REFERENCES webhook_endpoints(id),
  event        TEXT NOT NULL,
  payload      JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'             -- 'pending','delivered','failed'
               CHECK (status IN ('pending','delivered','failed')),
  http_status  INT,
  attempts     INT NOT NULL DEFAULT 0,
  retry_at     TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- webhook_deliveries has no tenant_id — RLS enforced via JOIN to webhook_endpoints:
-- USING (EXISTS (SELECT 1 FROM webhook_endpoints e
--               WHERE e.id = endpoint_id
--                 AND e.tenant_id = current_setting('app.current_tenant')::uuid))

CREATE TABLE help_content (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID,                                    -- NULL = global default
  key             TEXT NOT NULL,                           -- 'admin.assessment.create.duration'
  audience        TEXT NOT NULL CHECK (audience IN ('admin','reviewer','candidate','all')),
  locale          TEXT NOT NULL DEFAULT 'en',
  short_text      TEXT NOT NULL,                           -- tooltip (<=120 chars)
  long_md         TEXT,                                    -- full help drawer markdown
  version         INT NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'active',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, key, locale, version)
);
```

**Status: live (2026-05-02).** Migration at `modules/16-help-system/migrations/0010_help_content.sql`. RLS uses the **nullable-tenant variant** split into 4 scoped policies (`SELECT` / `UPDATE` / `DELETE` / `INSERT`) — a single `FOR ALL` policy contributes its `USING` clause as implicit `WITH CHECK` for INSERT, which would have allowed the app role to insert global rows (`NULL IS NULL` = TRUE passes the check). See `docs/RCA_LOG.md` 2026-05-02 entry. `NULLIF(current_setting('app.current_tenant', true), '')::uuid` handles the pg.Pool empty-string GUC leak. `UNIQUE NULLS NOT DISTINCT` (Postgres 15+) is required because nullable `tenant_id` in default `NULLS DISTINCT` mode would let the seed migration insert duplicate global rows on re-runs.

## Row-Level Security policies

For every domain table with `tenant_id`:

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON <table>
  USING (tenant_id = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation_insert ON <table>
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
```

Application sets the tenant context once per request:
```sql
SET LOCAL app.current_tenant = '<tenant-uuid>';
```

System-level operations (cross-tenant analytics, support tools) use a `BYPASSRLS` Postgres role for explicit elevation, audited separately.

## Indexes worth calling out

- `attempts (assessment_id, user_id)` — unique, the main lookup for "has this candidate started?"
- `gradings (attempt_id, question_id)` — main composite for results page
- `audit_log (tenant_id, at DESC)` — admin audit feed
- `attempt_events (attempt_id, at)` — replay for behavioral scoring
- Partial indexes on `WHERE deleted_at IS NULL` for users and questions
- `email_log (tenant_id, created_at DESC)` — timeline feed; partial `(tenant_id, status) WHERE status IN ('queued','failed','bounced')` for retry sweeps
- `in_app_notifications (tenant_id, audience, created_at DESC) WHERE read_at IS NULL` — unread short-poll query
- `billing_events_tenant_idx (tenant_id)` — tenant-scoped `COUNT(*)` for used-credit math (module 19-billing)
- `webhook_deliveries` — no own index; queries always filter through `endpoint_id` which maps back to tenant via RLS JOIN
- `attempt_summary_mv (tenant_id, attempt_id)` — **UNIQUE** composite required for `REFRESH MATERIALIZED VIEW CONCURRENTLY` (Phase 3 G3.C)

---

## Materialized view — `attempt_summary_mv`

**Status:** LIVE — Phase 3 G3.C (migration `0060`, module 15-analytics).

### Why

Heavy analytics queries (cohort reports, heatmaps, exports) join `attempt_scores → attempts → assessments` on every request. At scale the per-request join cost becomes unacceptable. `attempt_summary_mv` pre-joins these tables into a single row-per-scored-attempt structure, refreshed nightly.

### What changed vs rejected alternatives

- **Considered:** TimescaleDB hypertable. Rejected — overkill for Phase 3 volume (< 50 k attempts), adds operational complexity.
- **Chosen:** Standard Postgres materialized view + CONCURRENT refresh. Zero additional infra; `REFRESH CONCURRENTLY` holds no table-level lock, so live reads continue during refresh.

### RLS caveat

**Postgres does NOT enforce RLS on materialized views.** All queries against `attempt_summary_mv` MUST include:
```sql
WHERE tenant_id = current_setting('app.current_tenant', true)::uuid
```
Enforced by `tools/lint-mv-tenant-filter.ts` in CI.

### Schema

```sql
-- modules/15-analytics/migrations/0060_attempt_summary_mv.sql
CREATE MATERIALIZED VIEW attempt_summary_mv AS
SELECT
  ats.tenant_id,
  ats.attempt_id,
  a.assessment_id,
  a.user_id,
  a.status          AS attempt_status,
  a.submitted_at,
  ats.total_earned,
  ats.total_max,
  ats.auto_pct,
  ats.pending_review,
  ats.archetype,
  ats.computed_at,
  asm.pack_id,
  asm.level_id,
  asm.name          AS assessment_name
FROM attempt_scores ats
JOIN attempts   a   ON a.id   = ats.attempt_id
JOIN assessments asm ON asm.id = a.assessment_id;

-- Required for CONCURRENT refresh
CREATE UNIQUE INDEX attempt_summary_mv_pk
  ON attempt_summary_mv (tenant_id, attempt_id);

-- Analytics query indexes
CREATE INDEX attempt_summary_mv_assessment_idx
  ON attempt_summary_mv (tenant_id, assessment_id, computed_at DESC);
CREATE INDEX attempt_summary_mv_pack_idx
  ON attempt_summary_mv (tenant_id, pack_id, computed_at DESC);
```

### Refresh schedule

Nightly at **02:00 UTC** via BullMQ job `analytics:refresh_mv` (registered in `apps/api/src/worker.ts`). Initial populate at deploy time:
```bash
psql -U assessiq_system -c "REFRESH MATERIALIZED VIEW attempt_summary_mv"
```

---

## 18-certification — `certificates`

> **Status:** SCAFFOLDED — Phase 5 Session 1 (2026-05-11). Migration at `modules/18-certification/migrations/0046_certification_init.sql`. NOT YET APPLIED to any database — deployment scheduled for Phase 5 Session 2.

Point-in-time snapshot of a candidate's earned credential. Fields are frozen at issuance; profile or score changes after issuance do NOT retro-update the row (plan §1.1 "snapshot" rule). Tier upgrades update `tier` + `signed_hash` in place but preserve `credential_id` and `issued_at` to keep shared LinkedIn URLs and HMAC signatures valid.

```sql
CREATE TABLE certificates (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attempt_id       UUID        NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  candidate_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  template_key     TEXT        NOT NULL,
  credential_id    TEXT        NOT NULL,   -- globally unique slug: PREFIX-YYYY-MM-XXXXXX
  tier             TEXT        NOT NULL CHECK (tier IN ('completion', 'distinction', 'honors')),
  display_name     TEXT        NOT NULL,   -- snapshotted from users.name at issuance
  course_title     TEXT        NOT NULL,   -- snapshotted from assessments.name at issuance
  level            TEXT        NOT NULL,   -- snapshotted level label (e.g. "L1")
  signed_hash      TEXT        NOT NULL,   -- HMAC-SHA256 hex; payload: credential_id|candidate_id|issued_at
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at       TIMESTAMPTZ,
  revoke_reason    TEXT        CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 1000),
  pdf_downloads      INT NOT NULL DEFAULT 0,
  linkedin_shares    INT NOT NULL DEFAULT 0,
  verification_views INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Constraints

| Constraint | Definition | Purpose |
|---|---|---|
| `certificates_tenant_candidate_attempt_uniq` | `UNIQUE(tenant_id, candidate_id, attempt_id)` | One cert per attempt — idempotent issuance; DB is the race-condition firewall |
| `certificates_credential_id_key` | `UNIQUE(credential_id)` | Globally unique public slug (not tenant-scoped — recruiters look up without knowing tenant) |
| `tier CHECK` | `tier IN ('completion', 'distinction', 'honors')` | Enum guard at DB level |
| `revoke_reason CHECK` | `length(revoke_reason) <= 1000` | Bounds admin input |

### Indexes

| Index | Columns | Hot read pattern |
|---|---|---|
| `certificates_candidate_idx` | `(tenant_id, candidate_id)` | "My Certificates" list; admin list filtered by candidate |
| `certificates_credential_id_idx` | `(credential_id)` | Verify-page slug lookup (O(1) via UNIQUE, named for EXPLAIN clarity) |

### RLS

**Public verify-page note (Phase 5 Sessions 3–4):** Migration `0074_public_verify_policy.sql` added `public_verify_lookup` (FOR SELECT via `app.public_verify = 'true'` GUC, set transaction-local) to support the no-auth recruiter endpoint without a permissive all-tenants policy. Migration `0075_tenant_isolation_null_safe_cast.sql` then hardened all three `tenant_isolation` policies with an explicit `IS NOT NULL AND <> ''` guard — when the `public_verify_lookup` policy is OR'd in by Postgres, a bare `::uuid` cast on an empty-string GUC would raise a `22P02` exception before the OR can short-circuit; the hardened form converts that crash to `FALSE` (RLS denies, safe). The hardened predicate is strictly stricter than the original — no regression risk.

```sql
ALTER TABLE certificates ENABLE ROW LEVEL SECURITY;

-- Hardened NULL-safe form (migration 0075) — guards against empty-string GUC
-- cast crash when OR'd with the public_verify_lookup permissive policy below.
CREATE POLICY tenant_isolation ON certificates
  FOR SELECT
  USING (
    current_setting('app.current_tenant', true) IS NOT NULL
    AND current_setting('app.current_tenant', true) <> ''
    AND tenant_id = current_setting('app.current_tenant', true)::uuid
  );

CREATE POLICY tenant_isolation_insert ON certificates
  FOR INSERT
  WITH CHECK (
    current_setting('app.current_tenant', true) IS NOT NULL
    AND current_setting('app.current_tenant', true) <> ''
    AND tenant_id = current_setting('app.current_tenant', true)::uuid
  );

CREATE POLICY tenant_isolation_update ON certificates
  FOR UPDATE
  USING (
    current_setting('app.current_tenant', true) IS NOT NULL
    AND current_setting('app.current_tenant', true) <> ''
    AND tenant_id = current_setting('app.current_tenant', true)::uuid
  );

-- Phase 5 Session 3 (migration 0074): GUC-based public verify policy.
-- Satisfies the verify-page query (app.public_verify='true', set transaction-local by
-- withPublicVerifyContext). OR'd with tenant_isolation — normal tenant requests satisfy
-- tenant_isolation; verify-page requests satisfy this policy (no app.current_tenant set).
CREATE POLICY public_verify_lookup ON certificates
  FOR SELECT
  USING (current_setting('app.public_verify', true) = 'true');
```

### Design decisions

- **`attempt_id` replaces `enrollment_id`** — AssessIQ has no `enrollments` table. `attempts` (module 06) is the concrete completed entity. `UNIQUE(tenant_id, candidate_id, attempt_id)` gives per-attempt idempotence. (Rejected: `assessment_id` FK — too coarse; a candidate could have multiple attempts in one assessment cycle.)
- **`candidate_id` ON DELETE SET NULL** — preserves historical cert record (snapshotted `display_name`) after GDPR account deletion.
- **`credential_id` is globally unique** — slug used in QR codes and LinkedIn share URLs; recruiters look it up without knowing the issuing tenant.
- **Counters use server-side arithmetic** — `UPDATE … SET col = col + 1`. Never read-modify-write. Non-critical analytics: a lost increment is acceptable.
- **`issued_at` must be truncated to second precision** before HMAC signing — PostgreSQL preserves microseconds; a drift between persisted value and re-signing produces a different digest. See `modules/18-certification/SKILL.md` D6.

---

## 19-billing — `tenant_plans` + `billing_events`

> **Status:** LIVE — Phase A1 (2026-05-17, commit `111dd77`). Migrations at `modules/19-billing/migrations/`: `0078_tenant_plans.sql`, `0079_billing_events.sql`, `0080_backfill_tenant_plans.sql`. Applied to production `assessiq-postgres`.

### `tenant_plans`

One row per tenant — the billing tier and credit allowance. Provisioned by the `createCompany` hook (after the `tenant.created` audit entry, inside the new tenant's `withTenant` context). Pre-existing tenants are backfilled by migration `0080`.

```sql
CREATE TABLE tenant_plans (
  tenant_id        UUID        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  tier             TEXT        NOT NULL DEFAULT 'free'
                               CHECK (tier IN ('free', 'pro', 'enterprise', 'internal')),
  included_credits INTEGER     CHECK (included_credits IS NULL OR included_credits >= 0),
                               -- NULL = unlimited (internal tier only)
  cycle_start      TIMESTAMPTZ NOT NULL DEFAULT now(),
                               -- reserved for A2 cycle engine; not queried in A1
  status           TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'suspended')),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### RLS — `tenant_plans`

```sql
ALTER TABLE tenant_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON tenant_plans
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON tenant_plans
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
```

No UPDATE or DELETE policy in A1 — plan mutation is deferred to A2 and executed exclusively under the `assessiq_system` BYPASSRLS role. A company admin can only read its own row. Provisioning inserts run under the new tenant's `withTenant` context.

#### Design decisions — `tenant_plans`

- **`included_credits IS NULL` ⇒ unlimited** — avoids a sentinel integer (e.g. `-1` or `MAX_INT`) and makes the unlimited check an explicit `IS NULL` branch at the query layer. Only the `internal` tier ships with NULL credits in A1.
- **`cycle_start` reserved, not queried** — credit cycles (monthly reset, rollover) are an A2 concern. The column is present now so A2 can add the cycle engine without a schema change.
- **No mutable counter column** — used-credit count is derived on-read from `billing_events` (`COUNT(*)`). This self-reconciles on re-grade and avoids a counter drift class of bugs.

---

### `billing_events`

Append-only ledger; one row per graded candidate attempt (= 1 consumed credit). Migration `0079_billing_events.sql`.

```sql
CREATE TABLE billing_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attempt_id   UUID        NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  event_type   TEXT        NOT NULL DEFAULT 'assessment_graded'
                           CHECK (event_type IN ('assessment_graded')),
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, attempt_id)   -- idempotency: re-grade never double-charges
);

CREATE INDEX billing_events_tenant_idx ON billing_events (tenant_id);
```

#### RLS — `billing_events`

```sql
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON billing_events
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON billing_events
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
```

No UPDATE or DELETE policy. Append-only invariant enforced defence-in-depth at the DB role level, mirroring the `audit_log` pattern:

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON billing_events FROM assessiq_app;
```

#### Usage math (no mutable counter)

```sql
-- used      = COUNT(*) FROM billing_events WHERE tenant_id = ?
-- remaining = included_credits - used          (NULL included_credits ⇒ unlimited)
-- overage   = max(0, used - included_credits)
```

All three values are derived on-read from the ledger. Self-reconciling: a re-grade that removes the old grading row and inserts a new one produces at most one `billing_events` row per attempt (UNIQUE constraint).

#### Design decisions — `billing_events`

- **Same transaction as grade-commit** — the `billing_events` INSERT is in the same Postgres transaction as the attempt→`graded` state transition in `07-ai-grading/admin-accept.ts`, mirroring `auditInTx`. A non-conflict DB error rolls back the grade entirely (revenue-leak invariant). `billing_events` availability is therefore in the critical path of grade-commit — identical blast radius to `audit_log`.
- **`UNIQUE(tenant_id, attempt_id)`** — idempotency firewall. An operator retry or a duplicate grade-commit RPC cannot double-charge a tenant.
- **`attempt_id ON DELETE CASCADE`** — a GDPR attempt-purge removes the billing row, consistent with the `certificates` table. Accepted: the credit is effectively refunded on purge; this is correct behaviour (the attempt no longer exists).
- **`event_type` extensible via CHECK** — future event classes (e.g. `ai_question_generated` in A3) extend the enum; the A1 query always filters `WHERE event_type = 'assessment_graded'`.

---

### `tenant_entitlements` (Phase B1)

> **Status:** LIVE — Phase B1 (2026-05-18, commits `2ba822d` + `9f073a5`). Migrations at `modules/19-billing/migrations/`: `0081_tenant_entitlements.sql` (schema), `0082_entitlements_backfill.sql` (data backfill). Applied to production `assessiq-postgres`.

One row per `(tenant, scope)`. Scope is either a domain label (e.g. `soc`) or a specific pack UUID, allowing coarse domain-level grants and fine-grained per-pack overrides.

```sql
CREATE TABLE tenant_entitlements (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_type   TEXT        NOT NULL CHECK (scope_type IN ('domain', 'pack')),
  scope_id     TEXT        NOT NULL,  -- domain label or pack UUID; capped at 256 chars in service layer
  granted_by   UUID,                  -- super-admin user id; NULL for backfill rows
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status       TEXT        NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'revoked')),
  revoked_by   UUID,
  revoked_at   TIMESTAMPTZ,
  UNIQUE (tenant_id, scope_type, scope_id)
);

CREATE INDEX tenant_entitlements_tenant_status_idx ON tenant_entitlements (tenant_id, status);
```

#### RLS — `tenant_entitlements`

```sql
ALTER TABLE tenant_entitlements ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON tenant_entitlements
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON tenant_entitlements
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
```

No UPDATE or DELETE policy by design — grant/revoke run under `assessiq_system` (BYPASSRLS) via the two-role same-transaction pattern: the system role performs the entitlement write, then the role switches to `assessiq_app` + `set_config('app.current_tenant', tenantId, true)` for the `auditInTx` write to `audit_log`. This is the same pattern as A2 `updateTenantPlan`. A company admin reads its own active rows (RO) via `GET /api/billing/entitlements` (RLS-scoped, active-only).

#### Grant / revoke semantics

- **Revoke = status UPDATE to `'revoked'`, never a hard DELETE.** All rows are append/soft — the ledger is auditable.
- **Re-grant of a revoked `(tenant, scope_type, scope_id)`** reactivates the row via `ON CONFLICT (tenant_id, scope_type, scope_id) DO UPDATE SET status='active', granted_by=…, granted_at=now(), revoked_by=NULL, revoked_at=NULL`. The `UNIQUE` constraint makes grant idempotent — calling grant twice on an already-active scope is a no-op conflict.

#### Backfill — `0082_entitlements_backfill.sql`

Domain-level rows are backfilled for every `(tenant, question_packs.domain)` that has ≥1 `questions.status='active'` row in a `question_packs.status='published'` pack. Key implementation details:

- `granted_by = NULL::uuid` — explicit cast required; a bare `NULL` under `SELECT DISTINCT` resolves to `text` and fails uuid coercion on PG16.
- Idempotent: `ON CONFLICT (tenant_id, scope_type, scope_id) DO NOTHING`.
- Ships a zero-NULL verification query that the operator MUST run before any B2 deploy — a live tenant/domain missing an active entitlement would 403 at publish-time in B2.
- Applied to production 2026-05-18: 3 rows inserted (`e2e-walkthrough→soc`, `wipro-soc→soc`, `wipro-soc→phishing`); verification PASS.

#### B1↔B2 contract

B2 (publish-time enforcement, not yet built) must treat a referenced pack as entitled if its domain OR its `pack_id` has an active entitlement row for the session tenant. The `internal` tier bypasses the entitlement check entirely.

#### Phase B2 — publish-time enforcement

> **Status:** LIVE — Phase B2 (2026-05-18, commit `5c80aaa`). No schema migrations — B2 is application-layer only, reading the tables introduced in B1.

**Read model.** At every transition INTO `assessments.status='published'` — both `publishAssessment` and `reopenAssessment` in `modules/05-assessment-lifecycle/src/service.ts`, inside their existing `withTenant` transaction — `assertPublishEntitled(client, tenantId, assessment.pack_id)` (exported from `@assessiq/billing`) runs BEFORE the `status='published'` write and BEFORE the `assessment.published` audit entry. A failure throws `AppError 403 NOT_ENTITLED`; the surrounding `withTenant` issues a ROLLBACK — no partial published row, no audit entry.

**The implemented check (B1↔B2 contract):**

- `tenant_plans.tier = 'internal'` → **bypass** (always allowed regardless of entitlement rows).
- No `tenant_plans` row for the tenant → **fail-closed** (enforce, NOT bypass).
- Entitled iff `assessment.pack_id` ∈ active `tenant_entitlements(scope_type='pack')` OR `question_packs.domain` of that pack ∈ active `tenant_entitlements(scope_type='domain')`.
- Comparison is exact-string; this is intentional and matches the `0082` backfill which derives `scope_id` verbatim from `question_packs.domain`.

**RLS.** Reads on `tenant_plans`, `tenant_entitlements`, and `question_packs` all run under the publishing tenant's own `withTenant` RLS SELECT policies — no system role used; cross-tenant reads are structurally impossible (RLS + server-derived `tenantId`).

**Deploy safety.** B2 went live only after a prod assertion confirmed ZERO existing `published`/`active` assessments would fail the gate (assessment-level check, stronger than the B1 domain-proxy zero-NULL query). 2026-05-18: PASS (`e2e-walkthrough/soc` and `wipro-soc/soc` covered by the `0082` backfill; `wipro-soc` internal-bypass).

**Known follow-ups (not B2 defects):**

- Domain comparison is case-sensitive by design; a future B1-UI hardening should normalise case at grant time rather than at query time.
- `pack_id` immutability post-draft is enforced at the service layer only; a DB CHECK constraint is a separate hardening task.
- The Docker-less test silent-pass (no testcontainer available in local-only mode) is a pre-existing repo-wide pattern; a test-harness sweep is tracked separately.

#### Design decisions — `tenant_entitlements`

- **Append/soft-delete, no hard DELETE policy** — mirrors the `audit_log` and `billing_events` append-only invariants. Revoked rows remain in the table as an immutable audit trail.
- **`UNIQUE(tenant_id, scope_type, scope_id)` makes grant idempotent** — concurrent grant calls collapse to one row; re-grant of a revoked scope updates in place rather than inserting a second row.
- **`granted_by = NULL` for backfill** — legitimate sentinel; distinguishes system-provisioned rows from operator grants in the audit trail without a separate backfill flag column.
- **`scope_id` is TEXT (not UUID)** — domain labels (`soc`, `phishing`) are not UUIDs; a TEXT column with a service-layer 256-char cap covers both scope types without needing two columns or a polymorphic FK.
- **`(tenant_id, status)` index** — the primary query pattern for B2 enforcement is `WHERE tenant_id = ? AND status = 'active'`; the composite index covers this without scanning revoked rows.

---

### Phase A2 — plan mutation + audit additions

> **Status:** LIVE — Phase A2 (2026-05-17, commit `66ea0ff`). No schema migrations in A2 (all tables were created in A1); A2 adds the application-layer mutation path and the `PATCH /api/admin/super/tenants/:id/plan` endpoint.

#### `tenant_plans` mutation path (A2)

`tenant_plans` has SELECT + INSERT RLS policies only — **no UPDATE or DELETE policy** by design (documented in § RLS — `tenant_plans` above). Plan changes via `PATCH /api/admin/super/tenants/:id/plan` therefore run under a **two-role transaction**:

1. `assessiq_system` (BYPASSRLS) performs the row lock (`SELECT … FOR UPDATE`) and the `UPDATE` on `tenant_plans`.
2. Within the **same transaction**, the role switches to `assessiq_app` + `set_config('app.current_tenant', tenantId, true)` so the `auditInTx` write to `audit_log` runs in the role/GUC context that `audit_log`'s INSERT RLS policy and `modules/14-audit-log/src/audit.ts`'s contract require.

This mirrors the reviewed `updateAiGenerateMode` precedent in `@assessiq/tenancy`. The `UPDATE` and the `audit_log` INSERT are atomic — a rollback reverts both.

`cycle_start` is **read-only in A2** — reserved for a future billing-cycle engine. Usage in A2 is lifetime `COUNT(*)`, not cycle-windowed.

#### Validation invariants — `updateTenantPlan` (`@assessiq/billing`)

Enforced in the `updateTenantPlan` service function before the transaction opens:

- `tier ∈ {free, pro, enterprise, internal}`
- `included_credits` is `NULL` or an integer ≥ 0
- `tier = 'internal' ⇒ included_credits IS NULL` (unlimited; `includedCredits` omitted on transition to `internal` is coerced to `null`)
- `tier ≠ 'internal' ⇒ included_credits IS NOT NULL`

Corresponding 400 error codes: `INVALID_TIER`, `INVALID_CREDITS`, `INTERNAL_REQUIRES_NULL_CREDITS`, `FINITE_TIER_REQUIRES_CREDITS` (see `docs/03-api-contract.md` § PATCH `.../plan`).

#### `audit_log.action` catalog — A2 addition

`'tenant.plan_updated'` was appended to `ACTION_CATALOG` in `modules/14-audit-log/src/types.ts` (append-only addition). Emitted by `updateTenantPlan` via `auditInTx`. The existing `'tenant_settings.ai_generate_mode.updated'` action (added in A1) is unchanged.

The `audit_log.action` column (`TEXT NOT NULL` — see § Audit, notifications, help above) carries free-form action strings whose valid values are defined in `ACTION_CATALOG`. Known values after A2:

| Action | Emitted by | Module |
|---|---|---|
| `tenant_settings.ai_generate_mode.updated` | `updateAiGenerateMode` | `modules/02-tenancy` |
| `tenant.plan_updated` | `updateTenantPlan` | `modules/19-billing` |
| `tenant.entitlement_granted` | `grantTenantEntitlement` | `modules/19-billing` |
| `tenant.entitlement_revoked` | `revokeTenantEntitlement` | `modules/19-billing` |

---

## Module 20 — data-rights (S1 — 2026-05-29)

### `consent_events` (migration `modules/20-data-rights/migrations/0101_consent_events.sql`)

Per-user, per-purpose consent ledger. **Append-only** — same RLS + REVOKE
posture as `audit_log` (two-policy: SELECT + INSERT; `assessiq_app` REVOKE'd
UPDATE/DELETE/TRUNCATE). Withdrawal is a NEW row with `withdrawn_at` set
and `granted_at` NULL; the ledger reconstructs by chronological ordering.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | default `gen_random_uuid()` |
| `tenant_id` | UUID NOT NULL | FK `tenants(id)`; RLS keyed on this |
| `user_id` | UUID NOT NULL | FK `users(id)` |
| `purpose` | TEXT NOT NULL | CHECK IN (`data_processing`, `marketing`, `benchmarking`) |
| `policy_version` | TEXT NOT NULL | e.g. `dpdp-v1-2026-05-01` |
| `granted_at` | TIMESTAMPTZ | NULL iff withdrawn-without-grant |
| `withdrawn_at` | TIMESTAMPTZ | NULL iff still active |
| `ip` | INET | captured at write; redacted in exports via SKILL.md D2 |
| `user_agent` | TEXT | captured at write; redacted in exports |
| `lawful_basis` | TEXT NOT NULL | CHECK IN (`consent`, `legitimate_interest`, `contract`, `legal_obligation`) |
| `created_at` | TIMESTAMPTZ NOT NULL | default `now()` |

Row-level CHECK: `granted_at IS NOT NULL OR withdrawn_at IS NOT NULL` — a
row with both NULL is meaningless.

Indexes:
- `consent_events_user_purpose_idx` — `(tenant_id, user_id, purpose, created_at DESC)` for "what is this user's current consent for X?"
- `consent_events_tenant_created_idx` — `(tenant_id, created_at DESC)` for admin ledger view.

### `users.erased_at` (migration `0102_users_erased_at.sql`)

DPDP / GDPR erasure marker. **Distinct from `users.deleted_at`** — see
`modules/20-data-rights/SKILL.md` D1. When set, the row's `name` + `email`
columns hold tombstone values:

- `name → 'deleted_user_' || substring(sha256(id::text), 1, 12)`
- `email → 'deleted+' || <same hash> || '@erased.assessiq.local'`

Partial index for the S5 retention purge cron:
`users_tenant_candidate_not_erased_idx ON users (tenant_id, created_at) WHERE role = 'candidate' AND erased_at IS NULL AND deleted_at IS NULL`.

### `tenant_settings.retention_days` (migration `0103_tenant_retention_days.sql`)

Per-tenant candidate-data retention window in DAYS. CHECK `BETWEEN 1 AND 3650`.
Default `730` (2 years HR-grade). **Distinct from
`tenant_settings.audit_retention_years`** (added by `14-audit-log` migration
0050, default 7 years for audit forensic chain). The two windows are
intentionally different: PII gets minimized at 2y; audit retains 7y for
compliance forensics.

### Historical `audit_log` PII redaction (migration `0104_audit_log_pii_redact_backfill.sql`)

One-shot recursive redaction of every existing `audit_log` row's
`before` / `after` JSONB. Runs as `assessiq_system` per the documented
exception path in `0050_audit_log.sql` § IRREVERSIBILITY NOTE. Not
schema-altering; included here for the data-model audit trail. See
`docs/RCA_LOG.md` 2026-05-29 entry for the D7 finding that triggered it
and `modules/20-data-rights/SKILL.md` D7 for the rationale.

### Forward-protection extension to `14-audit-log/src/redact.ts`

PII field-name patterns added 2026-05-29 (forward protection — every
future `audit()` / `auditInTx()` write recursively redacts at any depth):

- Identity: `email`, `_email$`, `name`, `_name$`, `display_name`, `full_name`
- Contact: `phone`, `_phone$`, `phone_number`, `phone_number_e164`, `mobile`, `whatsapp`
- URLs: `linkedin_url`, `resume_url`
- Free-text: `answer_text`, `_answer_text$`, `candidate_answer`, `feedback_text`, `comment_text`, `notes_text`
- Network: `ip`, `_ip$`, `ip_address`, `user_agent`, `_user_agent$`

The patterns are intentionally broad on suffixes so future call sites
that add new field names (e.g. `recipient_email`, `candidate_name`) are
covered without re-editing `redact.ts`. Over-redaction of non-PII
suffixes (`tenant_name`, `pack_name`, `course_name`) is acceptable:
audit_log is for "did this change?" forensics, not "what was the name
called?". The `correct_answer` rubric ground-truth (NOT candidate PII)
is intentionally NOT covered by any of these patterns and remains in
audit JSONB for grading-event forensics.
