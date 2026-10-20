# 02 — Data Model

*Type: reference* — This page lists the Postgres tables, conventions and row-level security rules.

**Status:** the Phase 2 tables `grading_jobs` and `prompt_versions` are deferred and not applied. Section "Phase 2 (deferred) — `prompt_versions`, `grading_jobs`" has the details.

> Every domain table has `tenant_id` (UUID, NOT NULL, indexed). Row-Level Security enforces isolation. The application sets `app.current_tenant` at session start. RLS policies reference it.

## Conventions

| Item | Rule |
| --- | --- |
| Primary keys | UUID v7 (time-ordered, monotonic). Better than v4 for index locality |
| Timestamps | `created_at` and `updated_at`, both `TIMESTAMPTZ DEFAULT now()` |
| Soft delete | `deleted_at TIMESTAMPTZ NULL` instead of hard deletes, for any user-visible entity |
| JSONB | Tenant settings, question content, answer payloads, audit before/after, AI grading raw output |
| Enums | Postgres native enums. Where extensibility matters, use `TEXT CHECK (val IN (...))` |
| Money | See the next table |

Money rules (checked against all migrations on 2026-10-03, task N18):

| Item | Detail |
| --- | --- |
| Customer payment data | None. The schema has no prices, invoices or payments |
| Amount columns | Two: `tenant_grading_budgets.monthly_budget_usd` and `used_usd`. Both are `NUMERIC(10,2)` |
| Meaning | An AI cost budget in US dollars (migration `0041`). No code writes them today |
| Module 19-billing | Counts usage in whole credits, not in money: `tenant_plans.included_credits` (`INTEGER`) and one `billing_events` row for each graded attempt |
| New money column | Use `NUMERIC`. Never use a floating-point type |

## Module → tables map

| Module | Owns these tables |
|---|---|
| 02-tenancy | `tenants`, `tenant_settings` |
| 03-users | `users`, `user_credentials`, `user_invitations` |
| 01-auth | `sessions`, `api_keys`, `embed_secrets`, `oauth_identities`, `totp_recovery_codes`, `candidate_login_tokens` |
| 12-embed-sdk | No own tables. It adds columns to `tenants` (`embed_origins`, `privacy_disclosed`), `sessions` (`session_type`) and `attempts` (`embed_origin`) through migrations 0070–0073 (Phase 4, 2026-05-03) |
| 04-question-bank | `question_packs`, `levels`, `questions`, `question_versions`, `tags`, `question_tags`, `frameworks`, `taxonomy_nodes`, `question_taxonomy` (RW-55, migration 0169; also adds `domains.node_id` and `categories.node_id`), `question_imports`, `question_import_rows` (RW-58, migration 0174; also adds `question_packs.source` and `question_packs.import_file_sha256`) |
| 05-assessment-lifecycle | `assessments`, `assessment_invitations` |
| 06-attempt-engine | `attempts`, `attempt_questions`, `attempt_answers`, `attempt_events` |
| 07-ai-grading | **Phase 1 live:** `gradings`, `tenant_grading_budgets`, `generation_attempts`. **Phase 2 deferred (not yet applied):** `grading_jobs`, `prompt_versions` |
| 08-rubric-engine | Service only. No tables. The rubric DSL lives denormalized in `questions.rubric` JSONB, owned by 04. Phase 2 G2.B Session 2 (2026-05-03) confirmed this boundary (PHASE_2_KICKOFF.md § P2.D12). An earlier draft listed `rubrics` and `anchors` tables. That text was dead and the tables never shipped |
| 09-scoring | `attempt_scores` |
| 13-notifications | `webhook_endpoints`, `webhook_deliveries`, `email_log`, `in_app_notifications` |
| 14-audit-log | `audit_log` |
| 15-analytics | `attempt_summary_mv` (materialized view. No RLS. An explicit tenant filter is required) |
| 16-help-system | `help_content` |
| 18-certification | `certificates` |
| 19-billing | `tenant_plans`, `billing_events` |

---

## Tenancy

**Status:** live since 2026-05-01 (Phase 0 Session 2 / G0.B-2). Migration `modules/02-tenancy/migrations/0001_tenants.sql` creates the tables and the `tenant_settings` RLS. Migration `0003_tenants_rls.sql` adds the `tenants` table RLS, special-cased on `id`.

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

| Item | Detail |
| --- | --- |
| What it is | A nullable `TEXT` column. Migration `modules/02-tenancy/migrations/0044_tenant_settings_ai_generate_mode.sql` adds it (applied to production 2026-05-10) |
| Valid values | Exactly `'omnibus'`, `'sharded'` or `NULL`. A SQL `CHECK` constraint and the `TenantSettings` type in `modules/02-tenancy/src/types.ts` enforce them. The default is `NULL` |
| `NULL` meaning | Use the global `AI_GENERATE_MODE` env var for this tenant. There is no implicit string fallback such as `'omnibus'` |
| Resolution | `modules/04-question-bank` resolves it at request time with `tenantSettings?.ai_generate_mode ?? config.AI_GENERATE_MODE` (see `docs/05-ai-pipeline.md` § Phase 2 — Stage 3 promotion) |
| Override effect | A non-`NULL` value overrides the env var for that tenant only. It takes effect on the next request. No container restart is needed |
| Why not `features` JSONB | `features` is an untyped bag for tenant-specific UI experiments. A mode flag there is invisible to TypeScript consumers, fails silently on a misspelled key and needs a runtime cast. The dedicated column has both a Postgres `CHECK` and a TS type. Rationale: `docs/design/2026-05-10-stage-3-promotion-rollout.md` § 3 |
| Write path | Super admin only. The `updateTenantSettings` patch surface (`Pick<>` in `modules/02-tenancy/src/service.ts`) excludes `ai_generate_mode` on purpose |
| Only writer | `updateAiGenerateMode(superAdminUserId, targetTenantId, newMode)` at `modules/02-tenancy/src/service.ts:155`. The route is `PATCH /api/admin/super/tenants/:tenantId/ai-generate-mode` (see `docs/03-api-contract.md` § Admin — Super) |
| Audit | Each write emits a `tenant_settings.ai_generate_mode.updated` row in `audit_log` (the action is in `modules/14-audit-log/src/types.ts` ACTION_CATALOG). It uses `auditInTx` in the same transaction as the `UPDATE`. If the audit INSERT fails, the column UPDATE rolls back |
| Rollback | An operator runs `UPDATE tenant_settings SET ai_generate_mode = 'omnibus' WHERE …` (or `NULL`). Migration 0044 is additive only. Rollback never drops the column |
| Cross-reference | `docs/05-ai-pipeline.md § Phase 2 — Stage 3 promotion: per-tenant ai_generate_mode` has the design context, the runtime resolution path, the cron alert wiring and the "no auto-rollback" decision |

### `uuidv7` vs `gen_random_uuid()` — column DEFAULT

| Item | Detail |
| --- | --- |
| What changed | The canonical `DEFAULT uuidv7()` shown elsewhere on this page is implemented in migrations as `DEFAULT gen_random_uuid()` (from the `pgcrypto` extension, enabled in the same migration) |
| Why | Postgres 16 has no native `uuidv7()` function. A SQL or PL/pgSQL `uuidv7()` would be our own code that every backup and restore must trust. Application code already generates UUIDv7 with `uuidv7()` from `@assessiq/core`, and every API INSERT passes an explicit `id`. The column DEFAULT is only a fallback for raw inserts (psql, ad-hoc tooling), where time-ordered ids are not load-bearing |
| Rejected | (a) A SQL-level uuidv7 implementation: it adds a maintenance surface for a fallback path. (b) `uuid_generate_v4()` from `uuid-ossp`: it is random, it is not v7, and it has no benefit over `gen_random_uuid()` in the lighter `pgcrypto` |
| Not included | A retroactive change to other tables on this page that show `DEFAULT uuidv7()`. Each of those tables moves to `gen_random_uuid()` at its own CREATE TABLE migration, with the same justification copied near each `CREATE EXTENSION pgcrypto` |
| Downstream impact | None on the application, which never relies on the DEFAULT. The migrations linter (`tools/lint-rls-policies.ts`) is unaffected. It scans for the `tenant_id` column and the two RLS policies |

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

### Schema note (2026-05-01): `tenant_id` denormalization on auth tables

| Item | Detail |
| --- | --- |
| What | `oauth_identities`, `user_credentials` and `totp_recovery_codes` first reached tenancy through `user_id → users.tenant_id`. Each table now carries a direct `tenant_id` and the standard two-policy RLS template |
| Reason for the rule | CLAUDE.md hard rule #4 ("Add a domain table without `tenant_id` and an RLS policy → bounce") and `tools/lint-rls-policies.ts` |
| Why | Defense in depth. Transitive RLS through a JOIN subquery fails silently: a missed JOIN reads cross-tenant rows with no error. It also passes the linter and matches `sessions`, `embed_secrets` and `api_keys`, which already carry `tenant_id` |
| Rejected | RLS through a JOIN subquery on `user_id`. The linter does not catch a missing direct policy, and every read pays a subquery cost |
| Not included | A change to `UNIQUE (provider, subject)` on `oauth_identities`. It stays globally unique by product decision: cross-tenant contractors need separate Google accounts |
| Downstream impact | None on app code. The `01-auth` migrations `010_oauth_identities.sql`, `012_totp.sql` and `013_recovery_codes.sql` carry the new column and policies. `tools/lint-rls-policies.ts` validates them in CI |
| Related | `modules/01-auth/SKILL.md` § Decisions captured (2026-05-01) has the full contract. The `sessions` block below shows a `role` column and `last_totp_at`, added in the same Window-4 migration. They support role-based middleware and step-up MFA without a `users` JOIN |

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
-- Changed by 0179 (2026-10-16, Y-1): users_role_check is now role IN ('admin','super_admin','candidate'). The value 'reviewer' is removed (production had 0 rows).
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
  -- Changed by 0180 (2026-10-16, Y-1): sessions_role_check is now role IN ('admin','super_admin','candidate'). The value 'reviewer' is removed.
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

**Status:** live since 2026-05-13. Security hardening applied 2026-05-13 (adversarial review cycle). Migration `modules/01-auth/migrations/0076_candidate_login_tokens.sql` is applied to production. `docs/04-auth-flows.md` § Flow 6 has the sequence diagram. `docs/03-api-contract.md` § Candidate magic-link login has the endpoint contract.

| Item | Detail |
| --- | --- |
| What it is | A short-lived, single-use token table for `POST /api/auth/candidate/request-link` and `POST /api/auth/candidate/verify-link` |
| Request flow | The candidate submits an email and `tenant_slug`. The server resolves the slug to a `tenant_id` (system role only). It then looks up the user under RLS inside `withTenant(tenant_id, …)`. If the user exists, it makes a 32-byte CSPRNG token, stores only the sha256 hex hash, and emails the plaintext |
| Verify flow | The candidate clicks the link. The SPA POSTs the token to the verify endpoint. The server rehashes it, finds the row, marks it consumed in one atomic step, and mints a 30-day `aiq_sess` cookie. The plaintext token is never stored |
| Tenant-scoped writes (Fix 1, 2026-05-13) | Every write (INSERT on request, UPDATE on verify) runs inside `withTenant(tenant_id, client => …)`. The `tenant_id` is known before any write: from the slug on the request path, and from the atomic `UPDATE … RETURNING tenant_id` on the verify path. No write happens outside an RLS-active transaction |
| Why not `user_invitations` | `user_invitations` is assessment-scoped. Its TTL is 72 hours, its single-use rule follows attempt state (`status` past `in_progress`), and `03-users` and `05-assessment-lifecycle` own it. The login token has a 15-minute TTL, is single-use on click (no attempt) and belongs to `01-auth`. A shared table needs either a nullable `assessment_id` (wrong meaning) or a discriminator column that every invitation query must filter around |
| Why not `sessions` directly | The request endpoint must not create a session until the candidate proves they got the email. A pre-session row with a 15-minute TTL avoids orphan sessions. The verify endpoint is then the only place where a session row appears |

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

RLS uses the three-policy NULL-safe template (2026-05-13 pattern):

- The SELECT, INSERT and UPDATE policies use `current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id = current_setting('app.current_tenant', true)::uuid`.
- The `true` argument makes `current_setting` return `NULL` instead of an error when the GUC is unset.
- The `IS NOT NULL AND <> ''` guards cover the unset case (NULL → FALSE) and the `pg.Pool` empty-string GUC leak ('' → FALSE).
- All three evaluate to FALSE when the GUC is absent, so the table fails closed.
- This table needs the separate `tenant_isolation_update` policy (`FOR UPDATE`). The verify `UPDATE … RETURNING` must pass RLS. The standard two-policy template used elsewhere is not enough.

Single-use enforcement. The verify handler runs:

```sql
UPDATE candidate_login_tokens
   SET consumed_at = now()
 WHERE token_hash = $1
   AND consumed_at IS NULL
   AND expires_at > now()
RETURNING user_id, tenant_id
```

- If the UPDATE returns zero rows (token consumed, expired or not found), the handler redirects to `/candidate/login?error=invalid_link`.
- There is no separate SELECT. The atomic UPDATE is both the check and the mark. This prevents a TOCTOU race between a check and a later consume.

Relationship to `sessions`:

- `candidate_login_tokens` has no FK to `sessions`.
- A successful verify creates a `sessions` row (through `01-auth.sessions.create`) with `expires_at = now() + 30 days`.
- The token row stays for audit (`consumed_at`, `requested_ip`, `requested_ua`). Consume does not delete it.
- The session expiry sweeper deletes expired unconsumed tokens (Phase 3 follow-up; the same job purges expired `sessions` rows).

Not included:

- No FK from `candidate_login_tokens` to `sessions`. The verify path does not walk back from session to token, and the FK would create a circular dependency inside `01-auth`.
- No `tenant_id` on the linked `sessions` row beyond what `sessions.create` already receives. Tenancy flows from `candidate_login_tokens.tenant_id` at verify time.
- No per-token rate-limit column. The Redis counter on the request endpoint enforces the rate limit. The DB does not store it.

## Question bank

**Status:** live since 2026-05-01 (Phase 1 G1.A Session 1). Migrations in `modules/04-question-bank/migrations/`: `0010_question_packs.sql` (standard tenant_id RLS), `0011_levels.sql`, `0012_questions.sql`, `0013_question_versions.sql`, `0014_tags.sql` (`tags` standard, `question_tags` JOIN-based) and `0015_questions_level_pack_fk.sql` (defense-in-depth composite FK). All 6 tables are on production `assessiq-postgres`. `tools/lint-rls-policies.ts` enforces both the standard and the JOIN-based RLS variants in CI.

### JOIN-based RLS for child tables

| Item | Detail |
| --- | --- |
| Tables | `levels`, `questions`, `question_versions`, `question_tags`. They have no `tenant_id` column |
| Rule | RLS derives tenancy through the parent `pack_id` FK chain: `EXISTS (SELECT 1 FROM question_packs p WHERE p.id = child.pack_id AND p.tenant_id = current_setting('app.current_tenant', true)::uuid)` |
| Two-hop variant | `question_versions` and `question_tags` join through `questions → question_packs` |
| Fail-closed | A NULL GUC gives `tenant_id = NULL`, which is FALSE. Zero rows are visible |
| Why | A denormalized `tenant_id` on every child can drift. A question moved between packs needs a `tenant_id` update, and a forgotten update leaks rows silently. The JOIN version follows the FK chain |
| Rejected | (a) Denormalized `tenant_id` columns on each child: drift risk. (b) An RLS trigger that sets `tenant_id` on insert: a per-row write path with no defense-in-depth gain |
| Not included | The attempt-engine child tables (`attempt_questions`, `attempt_answers`, `attempt_events`). They use the same JOIN pattern and ship with G1.C |

### Defense-in-depth composite FK (migration 0015)

| Item | Detail |
| --- | --- |
| Constraint | `questions.(level_id, pack_id)` references `levels.(id, pack_id)` |
| Why | Without it, a service-layer regression could let a question reference a level in a different pack (a different tenant) |
| Lines of defense | First: the service guard (`findLevelById`, an RLS-scoped lookup). Second: the composite FK, as the structural backstop |
| Cost | A redundant `UNIQUE (id, pack_id)` on `levels` (`id` is already the primary key) |

### Platform-tenant master library: `domains` and `categories` seed (migration 0083, 2026-05-22)

| Item | Detail |
| --- | --- |
| What | `0083_seed_platform_tenant_taxonomy.sql` seeds the 9-domain taxonomy and its categories into the **platform** tenant (`slug = 'platform'`). Migrations 0019 and 0020 seed the same set for each company tenant |
| Why | Question generation moved to super-admin-only scope (Phase B1). The super admin works inside the platform tenant. `domains` and `categories` are tenant-scoped (RLS). Migration 0019 seeded them per tenant. The platform tenant is bootstrapped by hand after migrations run (README step 5), so it never got the seed. The super admin generate screen showed almost no domains |
| Result | The platform tenant is the canonical master library. The super admin curates it and (Phase 2) grants it to companies through billing entitlements |
| Rejected | (a) The runtime `seedTenantTaxonomy()` for the platform tenant: its guard forbids the platform `tenantId`, and that path is for per-company onboarding only. (b) A hard-coded platform UUID: the UUID is assigned by hand and differs between environments |
| Matching | 0083 matches by `slug = 'platform'`. It seeds the live DB. On a fresh DB without a platform tenant, `SELECT` returns 0 rows and the migration is a harmless no-op |
| Idempotent | `ON CONFLICT … DO NOTHING`. It keeps the hand-created `soc` domain and adds the rest |
| Not included | The cross-tenant content-sharing path. Entitlements today grant a publish permission flag, not read access to platform-tenant questions. Making a granted set usable by a company is deferred to Phase 2 |
| Downstream impact | None for company tenants (0083 only touches `slug='platform'`). The `seedTenantTaxonomy()` guard in `modules/04-question-bank/src/seed.ts` is unchanged and stays per-company |

### Clone-on-use provenance and uniqueness (migrations 0084 and 0085; Step 2, 2026-05-23)

| Item | Detail |
| --- | --- |
| What (0084) | `question_packs` gains nullable `source_pack_id` and `source_version`. `questions` gains nullable `source_question_id`. They record where a clone came from |
| What (0085) | A partial `UNIQUE INDEX question_packs_tenant_source_uniq ON question_packs (tenant_id, source_pack_id) WHERE source_pack_id IS NOT NULL`. A tenant has at most one clone of a given platform source |
| Why | The **standing-license + clone-on-use** model. A company builds an assessment from a licensed platform set (`createAssessmentFromSet` → `materializeSetForTenant`). The set is copied into the company tenant and tagged with its source. The publish gate (`assertPublishEntitled`) then recognises the clone through `source_pack_id`. The "Available sets" catalog flags *already-added* and *update-available* |
| Forgery-safe | Only the system-role clone engine (`modules/04-question-bank/src/clone.ts`) writes `source_pack_id`. No company-accessible API (`createPack`, `updatePack`) sets it. It cannot be forged to pass the publish gate |
| Concurrency | `materializeSetForTenant` takes `pg_advisory_xact_lock(tenant, source)`, so a request burst cannot double-clone. The unique index is the structural backstop (RCA 2026-05-23) |
| Originals | Platform and hand-authored packs carry NULL provenance |
| Not included | Re-sync of an updated source and clone archival on revoke (the publish gate already blocks revoked licenses). Both are deferred follow-ups |

### Question difficulty tags (migration 0086; Phase A, 2026-05-23)

| Item | Detail |
| --- | --- |
| What | `questions` and `question_versions` each gain four nullable columns: `cognitive_level` (TEXT + CHECK; revised Bloom: remember, understand, apply, analyze, evaluate, create), `nice_task_id` (TEXT; NICE Framework work-role or competency), `difficulty_params` (JSONB; the intended per-(type,level) difficulty vector) and `attack_technique` (TEXT[]; MITRE ATT&CK coverage) |
| Why | Intrinsic item difficulty was asserted only in prompt prose and the type-weight mix. The columns let it be tagged, structurally validated (Phase A) and empirically calibrated (Phase C). Bloom (`cognitive_level`) and NICE (`nice_task_id`) are the layered taxonomy decided on 2026-05-23. See `docs/design/2026-05-23-question-difficulty-spec.md` |
| Forward-only | Legacy and human-authored rows stay NULL (untagged). The generation handler stamps new AI-generated rows (Phase A3). No backfill |
| TEXT + CHECK | Repo convention: zero Postgres ENUM types |
| RLS | No change. Tenancy stays JOIN-derived through `pack_id` |
| Rejected | (a) A Postgres ENUM for `cognitive_level`: inconsistent with the TEXT+CHECK pattern and harder to extend. (b) `NOT NULL DEFAULT ''`: it would tag legacy rows falsely instead of leaving them visible as untagged |
| Not included | Model-emitted difficulty (the handler stamps it deterministically, Phase A3). Warn-level embedding checks and `attack_technique` population (Phase B). A `generation_attempts.difficulty_dropped` counter (open item for Phase A3) |
| Downstream impact | `modules/04-question-bank/src/difficulty-spec.ts` is the value source of truth. `insertDrafts` in `modules/07-ai-grading` stamps the columns (Phase A3) |

### Domain slug normalization (migration 0090, 2026-05-24)

Applied to production. Idempotent.

| Item | Detail |
| --- | --- |
| What | `modules/19-billing/migrations/0090_normalize_domain_slugs.sql` lowercases `question_packs.domain` and the domain-scope `scope_id` values in `tenant_entitlements` |
| Why | The licensing resolver (`assertPublishEntitled`) matches entitlement `scope_id` to `question_packs.domain` by exact string. The old free-text Domain field allowed mixed case (for example `'SOC'`), which never matched the lowercase platform slug `'soc'`. Publish was blocked silently even when an entitlement existed |
| Collision rule | Lowercasing `scope_id` can break `UNIQUE (tenant_id, scope_type, scope_id)` when `'SOC'` (active) and `'soc'` (revoked) both exist for a tenant. For each `(tenant, lower(scope_id))` group the migration keeps one winner. It prefers `status='active'`, then the newest `granted_at`. It deletes the other rows, then lowercases the survivors |
| Untouched | Pack-scope rows (`scope_type='pack'`, `scope_id` is a UUID) |
| Idempotent | Safe to re-run. It is a no-op when all values are already lowercase |
| Write-path invariant | `createPack`, `updatePack` and the `POST /admin/sets/:sourcePackId/import` clone engine lowercase `question_packs.domain` before INSERT or UPDATE. `grantTenantEntitlement` and `revokeTenantEntitlement` lowercase domain `scope_id` before they write. The New-Pack domain dropdown and the Grant Entitlement dropdown read the canonical `domains` table (lowercase slugs). This removes the free-text path |
| Rejected | A Postgres `CHECK` that forces lowercase on `question_packs.domain`. It would block migration tooling that inserts any casing during backfill windows. Service-layer enforcement is enough |
| Not included | Re-index of `question_tags` or `attempt_summary_mv`. They never stored `domain` |
| Downstream impact | `GET /api/admin/super/tenants/:tenantId/content-scopes` now reads grantable domain scopes from the `domains` table (canonical slugs), not from target-tenant pack rows (see `docs/03-api-contract.md` § content-scopes). This closes the last known path for a non-canonical slug to reach a grant row |

### Platform domain provenance and cross-tenant management (migration 0091, 2026-05-25)

| Item | Detail |
| --- | --- |
| What | `domains` gains `source` (TEXT + CHECK `IN ('platform','tenant')`, default `'tenant'`). The `status` CHECK widens to `IN ('active','inactive','archived')` |
| Backfill | Marks the platform master tenant's own rows, and every company-tenant row whose slug is in the platform domain set, as `source='platform'`. Every other row (tenant-local creations) stays `'tenant'` |
| Backfill safety | `UNIQUE(tenant_id, slug)` gives one row per slug per tenant, so a platform slug's single row is the seeded platform copy. Tenant-local slugs are not in the platform DOMAIN set and stay `'tenant'` (verified against production) |
| Why | The super-admin platform domain-management feature creates and archives domains and propagates the change into every company tenant. `source` lets propagation flip every platform-origin copy of a slug and never touch a tenant-local domain on the same slug (for example WIPRO-SOC's `threat-hunting`) |
| Archive vocabulary | `'archived'` is the management status. `'inactive'` is unused legacy |
| Catalog-only archive (decided 2026-05-25) | Archiving a platform domain removes it from the selection dropdowns (all filter `status='active'`) and makes it non-grantable from then on. It does not revoke existing `tenant_entitlements` for that domain. It does not untag existing packs or questions. Entitlements are decoupled from domain status by design: the publish and license gates compare slug strings and never JOIN `domains`. Reactivation reverses the archive |
| Rejected | (a) Match propagation by slug alone, with no `source` column: a later tenant-local domain with a platform slug would be overwritten on archive. (b) Cascade-revoke entitlements on archive: it couples a taxonomy operation to the billing and access path and is hard to reverse |
| Not included | Untagging archived-domain content. B3 licensed-set re-sync. Category seeding for new platform domains (a platform domain created through the API gets a domain row only, like a tenant-local create) |
| Downstream impact | `seedTenantTaxonomy()` (`modules/04-question-bank/src/seed.ts`) now seeds a new tenant from the live platform active-domain set (domains and categories copied, tagged `source='platform'`). It no longer uses the static hard-coded 0019 list. The hard-coded baseline stays only as a fresh-DB fallback when no platform tenant exists |
| New endpoints | `GET/POST/PATCH /api/admin/super/domains` (see `docs/03-api-contract.md`) |
| New audit actions | `domain.created`, `domain.archived`, `domain.reactivated` (in the `modules/14-audit-log` catalog) |

### Clone question-version snapshots and B3 licensed-set re-sync (migration 0095, 2026-05-25)

| Item | Detail |
| --- | --- |
| What (1) | `clonePackToTenant` now writes one `question_versions` row (version=1) per cloned question and inserts the question at `version=2`. This mirrors the end state of `publishPack` (`questions.version = MAX(qv.version)+1`) |
| Backfill | `0095_backfill_clone_question_versions.sql` does the same for existing clone questions. It is idempotent (`NOT EXISTS` guard) and scoped to `question_packs.source_pack_id IS NOT NULL` |
| What (2) | New `resyncClonedPack` and `resyncSetForTenant` (`clone.ts`) refresh an existing clone in place from a newer master version |
| Why (1) | Cloned questions had no `question_versions` row. The attempt-start pool (`listActiveQuestionPoolForPick`, module 06) INNER-JOINs `question_versions`. Cloned questions were silently excluded, and a candidate could never start an attempt on a cloned-pack assessment. The bug was latent: cloned-pack assessments had never run end to end in production (licensed pickers empty, platform packs in draft) |
| Re-sync model | Diff master and clone by `questions.source_question_id` |
| Re-sync: add | New master questions are added (version=2 + qv v1). Taxonomy is remapped by slug. Unresolvable ones are skipped |
| Re-sync: version-bump | Changed content or rubric gets a new qv snapshot at the clone question's current version. Future attempts resolve the new content through MAX(qv.version). In-flight attempts stay frozen on the prior snapshot |
| Re-sync: metadata-only | Master changes to level, domain, category, points, topic or type apply with no version bump. They live on the `questions` row, not in qv |
| Re-sync: archive | Questions removed upstream are archived. Then `question_packs.version` is bumped and `source_version = master.version` is set |
| Decided (2026-05-25) | In-flight and started attempts are never disrupted. Future attempts, even on an existing published assessment, get refreshed content. The attempt engine never pins a version per assessment: it serves `MAX(qv.version)` of active questions at attempt start. This matches how editing a pack's questions already behaves |
| Rejected | Per-assessment content freezing. It needs an attempt-engine rewrite that pins selection to `assessments.pack_version` for all assessments. Out of scope |
| Not included | Re-sync of tags on changed questions (only new questions get tags). Hard delete (not archive) of questions removed upstream |
| Downstream impact | New audit action `tenant.pack_resynced` (`modules/14-audit-log`). License-gated endpoint `POST /api/admin/sets/:sourcePackId/resync` (see `docs/03-api-contract.md`) |
| Review | Adversarial review (codex:rescue) gave REVISE, then ACCEPT. It caught a metadata-only-change gap |

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
```

The `answer_guidance` column is deliberately **not** in `question_versions` (migration 0098):

| Item | Detail |
| --- | --- |
| Frozen columns | `content` and `rubric` freeze per attempt. An edit never changes what an in-flight candidate sees |
| `answer_guidance` | A presentational answer-format hint with no grading consequence. The serve step reads it live from the `questions` row, like `topic` and `points` |
| Module 04 | `updateQuestion` treats it as a metadata-only patch (no version bump) |
| Module 06 | The candidate read joins the live `questions` row for it. `answerGuidanceFor()` resolves NULL to a per-type default, so every served question shows a hint |
| Phases | Phase A (foundation) ships the column and the wiring. Phase B fills it with an admin-triggered AI generator |

```sql
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

`log_format` is one of `syslog | json | csv | freeform`. The candidate UI uses it to pick a syntax-aware viewer. `expected_findings` lists the distinct concepts that the answer must contain. Matching is fuzzy (anchor style, like the `subjective` rubric; see `08-rubric-engine`). The Phase 1 importer JSON schema validates this shape with Zod (`modules/04-question-bank/src/types.ts`).

### Question type registry (RW-54b, migration `0167`)

| Item | Detail |
| --- | --- |
| What | `packages/question-types` (`QUESTION_TYPES`) is the one source of question-type ids. `tools/gen-question-type-check.ts` generates the CHECK constraints `questions_type_check` (table `questions`) and `question_versions_type_check` (table `question_versions`) into `modules/04-question-bank/migrations/0167_question_type_check_generated.sql` |
| Lint | `pnpm lint:question-type-check` (part of `lint:repo`) fails if the newest generated migration differs from the registry |
| Test | `modules/04-question-bank/src/__tests__/question-type-check-live.test.ts` applies all migrations to a real Postgres, reads both constraints from `pg_constraint`, and asserts that the allowed set equals `QUESTION_TYPES` |
| Why | Adding a type must be one place to edit. Before, each type needed a hand-written migration (`0129`, `0144`, `0152`, `0156`) that restated the full list, and the two constraints could drift apart |
| Rejected | (a) A `question_types` table with a foreign key: it adds a join or FK check on every write and a seed step per type. (b) A hand-written CHECK in each migration: it drifts from the registry and from the other table |
| Not included | The per-type behaviour switches in `07-ai-grading` and `04-question-bank` stay as they are (a follow-up row; closed by RW-68 below) |
| Downstream impact | Adding a type is one folder in `packages/question-types/src/types/`, one entry in `QUESTION_TYPES` and one generated migration (`pnpm gen:question-type-check`). The registry type is also a key in the two renderer maps (in `10-admin-dashboard` and `apps/web`), so each new type needs an entry in both. Migration `0167` is safe on existing data: it keeps the same 9 values |
| Rollback | None needed. The nine values equal those in 0152 and 0156. To revert before deploy, delete the file |

#### RW-68 (2026-10-11): per-type behaviour lives in the registry

Commits: `5125b3c` (stage 1, hooks), `d0b5bb8` (stage 2A, 04 + tools + apps/api), `b68523c` and `8353109` (stage 2B, 06 + 09), `ffa3eb4` (stage 2D, 10 views + apps/web), `7802b73` (05 typed subset, tools, mint-session mock). Stage 2C (module 07) merged as part of S9. This closes RW-54.

`QuestionTypeDef` in `packages/question-types/src/registry.ts` now holds all per-type behaviour. The earlier "Not included" row (the 07 and 04 switches) is closed.

| Item | Detail |
| --- | --- |
| Flags | `aiGradeable`, `rubricRequired`, `rubricSynthesis` (`none \| expected_findings \| steps_expected`), `shuffleField` (`options \| items \| null`) |
| Hooks | Pure (no DB, no React): `candidateView`, `coerceContent`, `guidanceText`, `rubricText`, `synthConcepts` (only when `rubricSynthesis` is not `none`), `deterministicScore` (only when `scoring` is `deterministic`), `evalStructuralCheck`, `checkAnswer` (optional) |
| Derived arrays | `DETERMINISTIC_IDS`, `AI_GRADEABLE_IDS`, `RUBRIC_REQUIRED_IDS`, `RUBRIC_SYNTHESIS_IDS`. They keep the order of `QUESTION_TYPES` |
| String-typed wrappers | For callers with `type: string` from the DB: `candidateViewFor` (an unknown type returns the question only), `coerceContentFor`, `deterministicScoreFor`, `checkAnswerFor` |
| Deleted | `CONTENT_SCHEMA_MAP` (04 `types.ts`). Use `getQuestionType(id).contentSchema` |

Where each consumer dispatches now:

| Module | Reads from the registry |
| --- | --- |
| 04 | `guidanceText`, `rubricText`, the difficulty-spec map (`satisfies Record<QuestionType, ...>`), rubric-eligible SQL as `= ANY(AI_GRADEABLE_IDS)`, generate route keys and the JSON-schema enum |
| 06 | `candidateViewFor`, `shuffleField`, `checkAnswerFor`, option-type SQL as `= ANY` / `<> ALL` |
| 07 | `coerceContentFor`, `synthConcepts`, `AI_GRADEABLE_IDS`. The eval runner keeps its own Zod schemas and a typed `Record<EvalType, check>` map. It does not call `evalStructuralCheck` (see below) |
| 09 | `deterministicScoreFor`. The scoring primitives are re-exported from the registry |
| 10 and `apps/web` | Typed maps that `satisfies Record<QuestionType, Component>`. The two renderer maps stay (they hold React) |

| Item | Detail |
| --- | --- |
| Lint | `tools/lint-question-type-registry.ts` (`pnpm lint:question-type-registry`) has six rules |
| R1, R2 | Definition keys and folder names |
| R3 | Flags `case`, `===`, `!==`, `==`, `!=`, reversed compares (`'mcq' === x`) and SQL `IN ('<id>'` |
| R4 | The two renderer maps |
| R5 | Flags a re-declared union or array of two or more ids, on one line or one literal per line |
| R6 | Definition completeness: every member present, flags valid, `deterministicScore` and `synthConcepts` present exactly when they apply |
| Allowlist | The registry package, the two renderer maps, `tools/gen-question-type-check.ts`, tests, `e2e/`, migrations, `tools/assessiq-mcp/`, and the 04 `seed.ts` data list |
| End state (S9) | The lint runs strict (`--strict`, zero hits) inside `lint:repo` |
| Why | Adding a type used to touch about 20 files, and a missed `switch` failed silently in production. Now a missing part fails R6 or the typecheck |

Behaviour differences:

- The default `supported_types` for a new category follows registry order.
- `McqAnswerPayloadSchema.selected` max grows from 3 to 7 (options allow 8). No other API shape change.
- The eval runner keeps the old five-type structural subset (`mcq`, `log_analysis`, `scenario`, `kql`, `subjective`) and its own Zod schemas. The registry `evalStructuralCheck` folds some length checks into the structural step and uses a stricter scenario schema. `schemaValid` would shift and baselines would move. The hook exists for new consumers. Module 07 does not call it.
- `deterministicScoreFor` returns 0 for an unknown type. The path is unreachable because the DB CHECK allows only registry ids.

| Item | Detail |
| --- | --- |
| Rejected | (a) Per-type hooks as React components in the registry: it pulls React into a leaf package. The package stays React-free and the two renderer maps hold the components. (b) A `question_types` DB table: the generated CHECK from RW-54b already derives from the registry, and a table adds a join and a seed step. (c) Converting `tools/assessiq-mcp`: it builds standalone on the VPS and cannot import the workspace package. A parity test pins it (`mcp-coerce-parity.test.ts`) |
| Not included | The `assessiq-mcp` coerce copy (parity-tested). The 04 `seed.ts` data list (domain seed data, not dispatch). No migration and no schema change |
| Downstream impact | Adding a type is one folder `packages/question-types/src/types/<id>/` with the definition and hooks, one entry in `QUESTION_TYPES`, the generated CHECK migration, two renderer-map entries and help content. See `modules/04-question-bank/SKILL.md` "How to add a question type" and `packages/question-types/README.md`. Modules 04, 06, 07, 09, 10 and `apps/web` no longer hold per-type literals |
| Rollback | None needed for data. Revert the commits to restore the old switches. The `selected` max of 7 is a widening, so stored answers stay valid |

## Curriculum frameworks (RW-55, migration 0169, 2026-10-11)

| Item | Detail |
| --- | --- |
| Migration | `modules/04-question-bank/migrations/0169_curriculum_frameworks.sql` (commit `6687e22`) |
| Other commits | Linking code, read routes and lint entry: `76daf4c`. Blueprint resolution: `2e23622` |
| What | Three new tables hold curriculum frameworks in the CASE style. Two nullable columns link the old domain and category rows to the new tree |

```sql
CREATE TABLE IF NOT EXISTS frameworks (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = platform-owned
  slug        text        NOT NULL,
  name        text        NOT NULL,
  source      text        NOT NULL DEFAULT 'platform' CHECK (source IN ('platform','tenant')),
  status      text        NOT NULL DEFAULT 'active'   CHECK (status IN ('active','archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS taxonomy_nodes (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = platform-owned
  framework_id      uuid        NOT NULL REFERENCES frameworks(id) ON DELETE CASCADE,
  parent_id         uuid        REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
  kind              text        NOT NULL CHECK (kind IN
                      ('board','stage','grade','subject','unit','outcome','criterion')),
  code              text        NOT NULL,          -- stable short id inside the parent ('soc', 'ch-3')
  label             text        NOT NULL,
  position          int         NOT NULL DEFAULT 0,
  syllabus_edition  text,                          -- '2025-26'
  external_id       text,                          -- CASE identifier or board code
  status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, framework_id, parent_id, code)
);
-- indexes: taxonomy_nodes_parent_idx (framework_id, parent_id, position),
--          taxonomy_nodes_tenant_idx (tenant_id) WHERE tenant_id IS NOT NULL,
--          taxonomy_nodes_external_idx (external_id) WHERE external_id IS NOT NULL

CREATE TABLE IF NOT EXISTS question_taxonomy (
  question_id  uuid NOT NULL REFERENCES questions(id)       ON DELETE CASCADE,
  node_id      uuid NOT NULL REFERENCES taxonomy_nodes(id)  ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, node_id)
);
-- index: question_taxonomy_node_idx (node_id)

ALTER TABLE domains    ADD COLUMN IF NOT EXISTS node_id uuid REFERENCES taxonomy_nodes(id) ON DELETE SET NULL;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS node_id uuid REFERENCES taxonomy_nodes(id) ON DELETE SET NULL;
-- partial indexes domains_node_idx / categories_node_idx WHERE node_id IS NOT NULL
```

### RLS

- `frameworks` and `taxonomy_nodes` use the `help_content` variant (`0010`). Four scoped policies apply.
  - SELECT shows `tenant_id IS NULL` rows and the caller's own rows.
  - INSERT, UPDATE and DELETE need `tenant_id IS NOT NULL AND tenant_id = app.current_tenant`.
  - The app role can never write a NULL-tenant row.
- Writes to NULL-tenant rows go through `withSystemRole` from super-admin code. Those writes are audited.
- **Z-43 draw rule.** An assessment blueprint criterion can select questions by taxonomy node. The shared predicate is `taxonomyDrawPredicate` in `modules/04-question-bank/src/taxonomy-nodes.ts`: a recursive CTE over `taxonomy_nodes.parent_id` (depth cap 10, so it stays inside one framework), joined to `question_taxonomy`, plus an optional `difficulty_est` range. No schema change and no migration. Modules 05 and 06 call it; no new table. Rejected: a closure table (extra table needing tenant_id and RLS for a tree of a few hundred nodes) and storing the resolved question ids in the blueprint (breaks the live pool).
- `question_taxonomy` uses the JOIN variant of `question_tags` (`0014`): `EXISTS (questions JOIN question_packs ... p.tenant_id = app.current_tenant)`. It has one policy for reads and one for INSERT. `tools/lint-rls-policies.ts` lists it in `JOIN_RLS_TABLES`.
- Review hardening (commit `9e6ded9`):
  - The UPDATE policies on `frameworks` and `taxonomy_nodes` carry an explicit `WITH CHECK` with the same own-tenant predicate.
  - The `question_taxonomy` INSERT policy also requires `EXISTS (SELECT 1 FROM taxonomy_nodes n WHERE n.id = question_taxonomy.node_id)`.
  - Without that check, a tenant could attach a question to the node of another tenant, because the foreign key check runs as the table owner.

### Framework 1, `legacy-domains`

The migration inserts one NULL-tenant framework with slug `legacy-domains`. It maps the `0018` tree into that framework:

| Source row | Node |
|---|---|
| Platform domain (`source = 'platform'`) | One NULL-tenant `subject` node for each slug. Label and position come from the `platform` tenant row if it exists |
| Tenant-local domain (`source = 'tenant'`) | One tenant-owned `subject` node (`tenant_id` = that tenant) |
| Category under a platform domain, when the same (domain slug, category slug) exists in the `platform` tenant | One NULL-tenant `unit` node under the platform `subject` node |
| Every other category | A tenant-owned `unit` node under its domain node |
| `questions.domain_id` and `questions.category_id` | One `question_taxonomy` row each, from the matching `node_id` |

`code` is the slug and `position` is `display_order`. An archived row becomes an archived node. Every step is idempotent: `ON CONFLICT DO NOTHING` and `WHERE node_id IS NULL`.

### Live maintenance

- The migration maps only existing rows.
- New rows get a node in the same transaction. The helpers are in `modules/04-question-bank/src/taxonomy-nodes.ts`: `legacyFrameworkId`, `findNodeId`, `ensureNode`, and a link helper for copied platform domains.
- Callers: tenant domain and category create, platform domain create and status change, tenant seed, and clone provisioning.
- If framework 1 is missing, the helper throws `FRAMEWORK_MISSING` (500).

### Blueprint node resolution (module 05)

- A blueprint criterion may name a `unit` node instead of a category: `{ category_id?, node_id?, type, count }`.
- `resolveBlueprintNodes` in `modules/05-assessment-lifecycle/src/service.ts` runs once at write time (create and update), inside `withTenant`. It reads `categories.node_id` to find the tenant's `(domain_id, category_id)`.
- The stored `settings.blueprint` always has the resolved shape (`ResolvedBlueprint` in `types.ts`). `node_id` stays on the criterion for traceability only.
- The live draw, frozen draw, count, preview and `assessment_frozen_pool` read `domain_id` and `category_id`. They do not change.
- A blueprint with no `node_id` takes the old path with no extra query.
- `domain_id` may be absent when every criterion has `node_id`.
- Four error codes (HTTP 400) are in `AL_ERROR_CODES`:

| Code | Cause |
|---|---|
| `BLUEPRINT_NODE_UNRESOLVED` | The node does not exist, is not visible to the tenant, or has no category in this tenant |
| `BLUEPRINT_NODE_KIND_UNSUPPORTED` | The node kind is not `unit` |
| `BLUEPRINT_NODE_MISMATCH` | The criterion `category_id` differs from the category that the node resolves to |
| `BLUEPRINT_MIXED_DOMAINS` | The criteria resolve to more than one domain, or differ from the given `domain_id` |

A golden test (`blueprint-node-golden.test.ts`) proves that a `category_id` blueprint and a `node_id` blueprint give the same stored shape, preview, live draw and frozen draw.

### Decisions and impact

| Item | Detail |
| --- | --- |
| Why | The owner wants one curriculum model for CBSE, ICSE and IB, with stable node ids and CASE ids. The old two-level domain and category tree cannot hold grade, unit or outcome levels. The old tree in framework 1 keeps every current blueprint and pack valid and gives new frameworks a place to land |
| Owner decisions (2026-10-11) | Seven node kinds: `board`, `stage`, `grade`, `subject`, `unit`, `outcome`, `criterion`. The UI keeps the words "Domain" and "Category" (tenants do not see "node"). `cognitive_level` stays a column on `questions` (`0086`) and does not become a node |
| Rejected | (a) Per-tenant copies of nodes, propagated like platform domains: NULL-tenant rows are visible to all tenants, so propagation is implicit and no copy job is needed. (b) A `node_id` column on `assessment_frozen_pool`: it changes the frozen-pool shape and trips the RW-55 abort criterion. (c) Resolving nodes at draw time: a frozen pool must not change after publish, so resolution happens at write time |
| Not included | Write routes for frameworks and nodes (RW-61). The only routes are two reads, in the API contract S9 notes. Framework seeds for CBSE, ICSE and IB (RW-57). Draws by `outcome` or `criterion` nodes. Any UI |
| Impact: lint | `tools/lint-rls-policies.ts` has `question_taxonomy` in `JOIN_RLS_TABLES`. The two nullable-tenant tables follow the `help_content` variant |
| Impact: docs | `modules/04-question-bank/SKILL.md` has an RW-55 section |
| Impact: types | `modules/05-assessment-lifecycle/src/types.ts` exports `ResolvedBlueprint` and the four new codes. Code that reads a stored blueprint must use `ResolvedBlueprint`, not `AssessmentBlueprint` |
| Impact: new inserts | Any new code path that inserts a domain or category must call the `taxonomy-nodes.ts` helpers. Otherwise the row has a NULL `node_id` and a node criterion cannot resolve to it |
| Impact: purge | `tenant_id` has `ON DELETE CASCADE`, so a tenant purge removes the nodes of the tenant |
| Rollback | Stop calling the new helpers. Then drop `question_taxonomy`, `taxonomy_nodes`, `frameworks`, `domains.node_id` and `categories.node_id`. No other table depends on them. Stored blueprints keep working because they hold `category_id` |

### Exam structure and Subject map frameworks (EXP-1, 2026-10-17)

| Item | Detail |
| --- | --- |
| What | Two platform (NULL-tenant) frameworks ship as bundled seeds: `src/frameworks/exam-structure.json` and `src/frameworks/subject-map.json`, both in the `BUNDLED` map of `src/framework-seeds.ts`. No schema change, no migration |
| Exam structure | Slug `exam-structure`. Level `board`: SSC, IBPS, RRB, UPSC, NTA. Level `stage` under each board: SSC CGL Tier 1, SSC CGL Tier 2, SSC CHSL, SSC MTS, IBPS PO Prelims, IBPS Clerk Prelims, RRB NTPC CBT 1, UPSC CSE Prelims GS Paper 1, NTA JEE Main, NTA NEET UG (15 nodes) |
| Subject map | Slug `subject-map`. Level `subject`: Quant, Reasoning, English, General Awareness. Level `unit`: the SSC CGL Tier 1 topics (Quant 7, Reasoning 3, English 4, General Awareness 6). Level `outcome`: 8 subtopics under Quant > Arithmetic (Percentage, Profit and loss, Ratio, Time and work, Time speed distance, Simple and compound interest, Average, Mixture) |
| Edition mark | The seed field `version` is `draft-unverified`. The loader stores it in `taxonomy_nodes.syllabus_edition` on every node (`frameworks` has no edition column). `board` is `EXAMS` and is not stored |
| Idempotent | Same loader as CBSE: framework key `(tenant_id NULL, slug)`, node key `(framework, parent, code)`. A second load creates nothing. Load from Platform > Curriculum frameworks |
| Why | The exam-pack plan (`docs/design/2026-10-17-exam-pack-source-and-taxonomy-plan.md`) needs a place for exam, stage and subject data. Domain stays in data, not in code |
| Not included | Subtopics for any subject except Quant > Arithmetic. Subject maps for stages other than SSC CGL Tier 1. Marks, timing and negative-marking rules. Links from packs or questions to these nodes |
| Unverified | The official exam sites could not be opened. The syllabus comes from general knowledge. The owner must check it against the notice of each exam before any use with candidates |
| Impact | `modules/04-question-bank/src/__tests__/framework-seed-boards.test.ts` has structure checks for both seeds. The seeds list on the Platform page now shows 6 bundled frameworks. Rollback: remove the two JSON files and the two `BUNDLED` entries. Loaded rows stay in the database until a platform admin archives them |

## Question import (RW-58, migration 0174, S10, 2026-10-16)

| Item | Detail |
| --- | --- |
| Migration | `modules/04-question-bank/migrations/0174_question_imports.sql`. Commit: (S10, 2026-10-16) |
| What | Two new tables hold a staged CSV or XLSX import. `question_packs` gains two columns |
| `question_imports` | One row for each uploaded file. Columns: `id`, `tenant_id`, `created_by` (users), `file_name`, `file_sha256`, `format` (`csv` or `xlsx`), `domain`, `pack_name`, `status` (`staged`, `committed`, `discarded`; default `staged`), `row_count`, `error_count`, `committed_pack_id` (question_packs), `created_at`, `updated_at` |
| `question_imports` (EXP-17, migration 0209) | Adds `upload_rights_status` (NULL for a platform import; `original`, `derived_from_source` or `licensed` for an organisation upload), `warranty_accepted_by` (users) and `warranty_accepted_at`. No backfill. |
| `questions.review_state` (Z-52 gap 5) | Every new row (createQuestion, AI draft, import) starts `in_review`. Legacy NULL rows are not backfilled; readers treat NULL as "legacy, not reviewed". Clones copy the master state. |
| `question_import_rows` | One row for each file row. Columns: `id`, `import_id` (cascade delete), `tenant_id`, `row_number`, `raw` (JSONB), `normalized` (JSONB, null when invalid), `content_hash`, `errors` (JSONB array, default empty), `decision` (`ok`, `skip`, `duplicate`, `error`). Unique `(import_id, row_number)` |
| `question_packs.source` | `TEXT NOT NULL DEFAULT 'authored'` with a CHECK for `authored`, `generated`, `import`. The default covers every existing row, so no backfill runs |
| `question_packs.import_file_sha256` | Nullable. Set on a pack created by a commit. It links the pack to its source file |
| Unique index | `question_imports_staged_file_idx` on `(tenant_id, file_sha256)` where `status = 'staged'`. An upload of the same file returns the staged import instead of a second one. A committed or discarded import does not block a new upload |
| RLS | Both tables use the standard `tenant_id` pair of policies: `tenant_isolation` (USING) and `tenant_isolation_insert` (INSERT with check). This mirrors `generation_batches` (0142) |
| Why | An admin must see and fix bad rows before any question exists. Staging in tables keeps the fix loop out of `questions`. Commit then writes only the `ok` rows |
| Rejected | (a) Parse and insert in one step: one bad row would block the file, or bad data would reach `questions`. (b) A `content_hash` column on `questions`: the hash is computed when staging runs, so the extra column is not needed yet. (c) A Postgres ENUM for `source` and `status`: repo convention is TEXT + CHECK |
| Not included | Multipart upload (the body is JSON with base64). Rubrics for imported subjective questions. Category linking. Retention or clean-up of old staged imports. A `source` filter in the pack list UI |
| Downstream impact | Routes and report shape: [03-api-contract.md](03-api-contract.md) § "Question import". Code: `modules/04-question-bank/src/import/`. Audit actions: `question_import.staged`, `question_import.committed`, `question_import.discarded`. A tenant purge deletes the rows of both tables (they have `tenant_id`). A pack with `source = 'import'` is an ordinary draft pack for every other module |
| Rollback | Stop calling the import routes. Then drop `question_import_rows`, `question_imports` and the two `question_packs` columns. No other table depends on them |
| Migration 0173 | `modules/16-help-system/migrations/0173_seed_rw57_frameworks_help.sql` carries one `help_content` row, `admin.platform.frameworks`, for the Curriculum frameworks section of the Platform page. It adds no table or column |
| Migration 0175 | `modules/16-help-system/migrations/0175_seed_rw58_question_import_help.sql` carries five `help_content` rows: `admin.question_import.page`, `.template`, `.upload`, `.report` and `.commit`. It adds no table or column |
| Applying 0173 to 0175 | Production help rows come from forward migrations, not from the seed file. Apply them by hand per [06-deployment.md](06-deployment.md). The two help migrations are idempotent (`ON CONFLICT DO NOTHING`). Migration 0174 is not (plain `CREATE TABLE`), so apply it once |

## Question source and exam columns (EXP-2, migration 0194, 2026-10-17)

Migration `modules/04-question-bank/migrations/0194_question_source_and_exam_columns.sql` adds one table and four columns.

| Item | Detail |
| --- | --- |
| What: `question_source` | One row for each question (`question_id` is `UNIQUE`, `ON DELETE CASCADE`). Columns: `id`, `tenant_id`, `question_id`, `origin`, `rights_status`, `source_ref`, `source_url`, `seed_ref`, `import_id`, `uploaded_by`, `licence_id`, `source_difficulty_raw`, `content_hash`, `normalised_text_hash`, `pyq_year`, `pyq_date`, `pyq_shift`, `pyq_paper_code`, `pyq_qno`, `created_at`. Indexes: `(tenant_id, content_hash)`, `(tenant_id, normalised_text_hash)`, `(tenant_id, rights_status)` |
| `origin` values | `original_human`, `ai_original`, `ai_seeded`, `derived_from_source`, `scraped_raw`, `tenant_upload`, `licensed` |
| `rights_status` values | `original`, `derived_from_source`, `scraped_raw`, `licensed`, `metadata_only`, `withdrawn`. `scraped_raw` blocks pack publish. `withdrawn` is the takedown state: the question is archived and leaves clones at the next re-sync |
| What: new `questions` columns | `difficulty_est` (smallint, 1 to 5, null), `review_state` (`in_review`, `verified`, `disputed`, `needs_fix`, null), `language_primary` (text, default `en`), `content_i18n` (JSONB, null; used by EXP-9) |
| RLS | Standard `tenant_id` variant: `tenant_isolation` (USING) and `tenant_isolation_insert` (WITH CHECK). `question_source.tenant_id` is always the pack tenant. A clone row has the clone tenant |
| No foreign keys | `import_id` and `uploaded_by` have no FK. A cross-module FK in a module-local table breaks per-module test harnesses (RCA 2026-10-17, migration 0183). `tenant_id` keeps its FK to `tenants`, like `question_imports` |
| Backfill, `origin` | From `question_packs.source`: `authored` gives `original_human`, `generated` gives `ai_original`, `import` gives `tenant_upload` when the pack tenant is not the platform tenant (slug `platform`), else `original_human`. Today every import is a platform import, so existing imports are `original_human` |
| Backfill, `rights_status` | `original` for every existing row |
| Backfill, hashes | `content_hash` and `normalised_text_hash` stay NULL. The JS stable-JSON hash used by import staging cannot be computed in SQL. The application fills them later. Nothing reads them yet |
| Grandfather | Every question with `status = 'active'` when 0194 first runs gets `review_state = 'verified'`. This is GRANDFATHERED, not reviewed: nobody checked these keys under the EXP-18 gate. The UPDATE runs only when 0194 creates the column, so a second run never marks later questions |
| Idempotent | `IF NOT EXISTS`, `DROP POLICY IF EXISTS` before `CREATE POLICY`, `ON CONFLICT DO NOTHING`. A test runs the file twice |
| Why | Rights and provenance must be queryable and enforceable (publish gate, takedown). A separate table lets provenance change without a question version bump. `review_state` sits beside `status` because `status` is read by import, clone, the picker and scoring, and a wider CHECK would touch every reader |
| Rejected | (a) Exam columns on `questions`: one question can serve several exams, taxonomy handles that. (b) A measured-difficulty column: a view over `question_stats_mv` is enough. (c) Widening `questions.status`. (d) FKs to `users` and `question_imports`. (e) A SQL hash that differs from the JS hash |
| Not included | The review gate itself (EXP-18), Hindi content (EXP-9), images (EXP-10), import columns (EXP-4), facets and search (EXP-5), a UI. No route edits `difficulty_est`, `review_state` or the rights fields except withdraw |
| Write paths | `insertQuestion` and `insertAiDraftQuestion` (04), the generation insert in `modules/07-ai-grading/src/handlers/admin-generate.ts` (`ai_original`), clone and re-sync (copy the row: new id, target `tenant_id`, `import_id` and `uploaded_by` cleared). `review_state`, `difficulty_est`, `language_primary` and `content_i18n` are copied to the clone too |
| Downstream impact | Audit action `question.withdrawn` (module 14 catalog). Route `POST /api/admin/super/questions/:id/withdraw` ([03-api-contract.md](03-api-contract.md)). Publish error `RIGHTS_NOT_CLEARED`. Withdraw bumps the pack `version` so clones can re-sync. QTI export adds a `provenance.json` file. `question_stats_mv` is unaffected. The assessment picker and blueprint draw need no change: they filter `status = 'active'` and withdraw sets `archived`. Assessments frozen before a withdrawal keep the item in their frozen pool |
| Rights rule (review fix) | The rights gate is an allowlist. A question can go live only when its `question_source` row exists with `original`, `derived_from_source` or `licensed`. `metadata_only`, `scraped_raw`, `withdrawn` and a missing row all block. The same SQL (`RIGHTS_CLEARED_SQL`) guards `publishPack`, `bulkActivateDraftQuestionsForPack` and `bulkUpdateQuestionStatus` (to `active`). Withdraw is idempotent: a second call changes nothing (no version bump, no audit row) |
| Takedown propagation (EXP-19, 2026-10-17) | What: when a PLATFORM question is withdrawn, the same transaction marks every tenant clone (`questions.source_question_id` = the withdrawn id) as `status = 'archived'` with `question_source.rights_status = 'withdrawn'`, and writes one audit row `question.takedown_propagated` per affected tenant (`audit_log.tenant_id` = the clone tenant, actor kind `system`, no actor id, so no platform user id enters a customer log). Why: before this, a clone kept serving a withdrawn item until the next re-sync. Mechanism: `src/clone/takedown.ts` switches the withdraw tx to `assessiq_system` for the cross-tenant write (explicit `tenant_id` predicates), then to `assessiq_app` plus the tenant GUC for each audit row, then restores the caller context. Idempotent: clones already withdrawn are skipped. Rejected: a background job (no ambient work, and it would leave a gap); `withSystemRole` (cannot nest inside `withTenant`, would not share the tx); touching `question_versions` or the clone pack `version`. Not included: pools frozen on an assessment (EXP-20, owner decision pending). Downstream: new audit action in module 14; no schema change; re-sync still marks clones withdrawn as a backstop. |
| Rollback | Stop calling the withdraw route, then drop `question_source` and the four `questions` columns. The code reads the columns in `QUESTION_COLUMNS`, so revert the code first |

### Import v2 writes (EXP-4, 2026-10-17)

No schema change. Import commit and staging now use the EXP-2 columns.

| Item | Detail |
| --- | --- |
| What | Commit writes `question_source` (origin, rights, `source_ref`, `source_url`, `seed_ref`, `source_difficulty_raw`, `content_hash`, `normalised_text_hash`, `import_id`, `uploaded_by`, `pyq_year`, `pyq_shift`) in the same insert as the question. It sets `questions.difficulty_est` and `language_primary`, and inserts `question_taxonomy` rows for the stage node (framework `exam-structure`) and the deepest subject node (framework `subject-map`). Staging stores the resolved node ids, the mapped difficulty and `normalisedHash` in `question_import_rows.normalized.meta` (jsonb), and the duplicate class in `meta.dupClass`. No new column |
| Why | The import is the way thousands of tagged exam items enter the bank (plan 2026-10-17, D4). Rights must be known at the first insert, not patched later |
| Normalised text | NFKC, lower case, a leading option label (`A)`, `(a)`, `1.`) removed from each string, spaces collapsed, every string of `content` except `rationale`, hashed with the shared `sha256Hex`. The JS hash is the only one; SQL never computes it |
| Duplicate sources | Exact and normalised hashes are compared with (a) the non-archived questions of the same domain, hashed from their content on the fly, so rows without stored hashes are caught, and (b) every stored `question_source` hash of the tenant, so other domains are caught only for rows that have stored hashes. Old rows (migration 0194 left both hashes `NULL`) in other domains are caught once their hashes are filled |
| Trigram | `similarity(lower(content->>'question'), text) >= 0.8` against the domain, only when `pg_extension` lists `pg_trgm`. No migration creates the extension. The check is not indexed (one scan per row) |
| Rejected | (a) `CREATE EXTENSION pg_trgm` in a migration (shared Postgres, owner rule). (b) A new `dup_class` column on `question_import_rows` (jsonb meta is enough; no schema change). (c) Treating `similar` as `duplicate` (false positives would hide real questions). (d) Trigram between rows of the same file (O(n squared)) |
| Not included | Backfill of the hash columns of old rows. A per-source difficulty table in the database (the three scales are code in `import/difficulty.ts`). Organisation-admin upload (EXP-17) |
| Downstream impact | Rows staged before this change have no `meta`; commit saves them as `original_human` / `original`. `insertQuestion` and `insertQuestionSource` take optional extra fields. Clone and re-sync already copy `question_source`; `import_id` and `uploaded_by` are cleared there (EXP-2) |

### Question search and facets (EXP-5, migration 0196, 2026-10-17)

Migration `modules/04-question-bank/migrations/0196_exp5_question_search.sql`. It adds no table, so no new RLS policy is needed.

| Item | Detail |
| --- | --- |
| What | Extension `pg_trgm`. Function `aiq_json_leaves(jsonb)`: every string of `questions.content` except the `rationale` key, NFKC and lower case, option label removed, spaces collapsed, joined by a new line. This is the SQL twin of `normalisedText()` in `import/v2.ts`; a test checks that both give the same text. Two columns on `questions`: `search_text` (text) and `search_tsv` (`to_tsvector('simple', search_text)`). Trigger `questions_search_text_trg` (BEFORE INSERT OR UPDATE OF content) fills both, so every write path (service, import, clone, generator) stays in sync. GIN indexes `questions_search_fts_idx` (`search_tsv`) and `questions_search_trgm_idx` (`search_text gin_trgm_ops`). Index `questions_difficulty_est_idx`. Backfill of existing rows in the same file |
| Why | The only list filters were pack, level, type, status, tag, topic prefix, domain and category, and nothing could find a question by its words (plan 2026-10-17, section 6). The `simple` text-search configuration has no stemming and no stop words, so Hindi tokens work like English ones. Trigram word similarity covers typing mistakes |
| Why stored columns | The app role runs under RLS. Postgres does not use an index for an operator that is not leakproof (`@@`, `<%`) on a table with row security, so the app query is a filtered scan. A stored `tsvector` keeps the cost per row small. The GIN indexes serve the table owner and any reader that is not under RLS |
| Search rule | `q` first runs the exact full-text match (`plainto_tsquery('simple', q)`). Only when it finds no row for the current filters does the query add trigram word similarity (`q <% search_text`, default threshold 0.6). Reason: the trigram scan is the slow part (about 130 ms for 5,000 rows) and it also widens results (`zebra12` matches `zebra13`). Results with a search sort by `word_similarity` first |
| Measured | 5,000 rows, local Docker Postgres 16: unique word 72 ms, word on 625 rows 53 ms (list call, including tenant setup). A typo query (trigram path) is about 215 ms |
| Rejected | (a) `SECURITY DEFINER` search function that skips RLS to use the indexes: puts tenant isolation in a function. (b) Marking `@@` or `<%` leakproof: needs a superuser and is false for a security promise. (c) A generated column: the trigger can change later without redefining the column. (d) `ts_headline` snippets and ranking by `ts_rank` (not needed for filtering) |
| Not included | Embeddings, semantic search, candidate-facing search, a has-passage filter (no passage table yet), a materialised facet cache |
| Downstream impact | **EXP-4 import:** that code runs its `similar` duplicate class only when `pg_trgm` is installed (`import/staging.ts`). The migration installs it, so the class is now on everywhere: near-identical stems are flagged `similar` (the row stays `ok`). That check is a per-row scan of the domain and is not covered by the new index. EXP-4 had rejected `CREATE EXTENSION` in a migration; the owner reversed that on 2026-10-17 (the extension is trusted and listed on the VPS). Test `question-imports-v2.test.ts` now drops the extension in its set-up to keep testing the absent state. **Clone and re-sync:** the trigger fills both columns on the clone insert, no code change. **Write cost:** each question insert or content change builds the text and two GIN entries |
| Deploy note | Apply once: `CREATE EXTENSION` needs the database owner role. The backfill updates every question row once (about 5,500 rows) |
| Rollback | Drop trigger `questions_search_text_trg`, function `questions_search_text_fn`, the three indexes, columns `search_text` and `search_tsv`, and function `aiq_json_leaves`. Leave `pg_trgm` installed if the import `similar` class is wanted. Revert the code first (the list reads `search_tsv` and `search_text` only when `q` is set) |

## Assessment lifecycle

**Status:** live since 2026-05-02 (Phase 1 G1.B Session 3). Migrations `0020_assessment_status_enum.sql`, `0021_assessments.sql` and `0022_assessment_invitations.sql` are in `modules/05-assessment-lifecycle/migrations/`.

The `DEFAULT` in the live migrations is `gen_random_uuid()`, not `uuidv7()`. The snippet below keeps the spec-style `uuidv7()` for documentation. Application code generates uuidv7 with `uuidv7()` from `@assessiq/core`.

Additive surface compared with the spec:

| Item | Detail |
| --- | --- |
| `assessments.pack_version INT NOT NULL` | A frozen pointer to `question_packs.version`, snapshotted by `service.createAssessment` from the current pack version. Republishing a pack does not re-bind existing assessments. The `(pack_id, pack_version)` tuple is the immutable content contract. It was not in the original spec. The Phase 1 G1.B Session 3 plan added it |
| `CHECK (opens_at IS NULL OR closes_at IS NULL OR opens_at < closes_at)` | A DB-layer backstop for the service `assertValidWindow` (defense in depth) |
| Indexes | `assessments_tenant_status_idx (tenant_id, status)` for `listAssessments`. Partial indexes `assessments_open_boundary_idx (opens_at) WHERE status='published'` and `assessments_close_boundary_idx (closes_at) WHERE status='active'` for the BullMQ boundary cron. The partial predicates keep the index small: they filter to states that the cron scans |
| `tenants.smtp_config JSONB` | Additive. It lives in `modules/02-tenancy/migrations/0004_tenants_smtp_config.sql`. It holds per-tenant SMTP credentials. The Phase 1 SMTP driver swap-in is deferred. The column is NULL on every tenant today, and the `dev-emails.log` stub still handles invitation sends. SKILL.md decision #12 |
| `smtp_config` shape conflict (FU-A16, 2026-10-06, facts only) | The migration documents `{host, port, secure, user, password_enc, from_address, from_name}` (password encrypted). The code schema that `resolveTransport` and `resolveFromAddress` use (`modules/13-notifications/src/email/transport.ts:56,76`; type at `modules/13-notifications/src/types.ts:195-203`) is `{provider, smtp_url, from_address, from_name, reply_to, template_overrides}`: a full URL with the password in plain text. Neither shape has a writer today (the column is NULL on every tenant; FR15 review, 2026-10-03). No code reads or writes a mismatched shape, because nothing uses the column. FU-A15 is the design note for the one shape to build when a tenant sender ships (Enterprise tier, parked until the first request) |
| JOIN-based RLS for `assessment_invitations` | The table has no `tenant_id` column. Both RLS policies use an `EXISTS` sub-select that joins back to `assessments` and checks `a.tenant_id = current_setting('app.current_tenant', true)::uuid`. This is the same pattern as `levels` and `questions`. The linter `tools/lint-rls-policies.ts` was extended in the same commit to enforce it. `assessment_invitations` is now in `JOIN_RLS_TABLES` |

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
  passing_score_pct SMALLINT NOT NULL DEFAULT 60 CHECK (passing_score_pct BETWEEN 1 AND 100), -- Z-16, 0198; editable only while draft
  max_attempts    SMALLINT CHECK (max_attempts IS NULL OR max_attempts BETWEEN 1 AND 10), -- Z-39, 0203; NULL or 1 = no retake (default); editable only while draft. settings.score_counts ('latest' default | 'best') lives in the settings JSON
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
  extra_attempts  SMALLINT NOT NULL DEFAULT 0 CHECK (extra_attempts BETWEEN 0 AND 10), -- Z-39, 0203; attempts an admin granted this candidate on top of assessments.max_attempts (one audit row per grant)
  UNIQUE (assessment_id, user_id)
  -- JOIN-based RLS — no tenant_id column; tenancy resolves via assessment_id → assessments.tenant_id
);
```

## Attempts

**Status:** live since Phase 1 G1.C Session 4a (2026-05-02). Migrations 0030-0033 are in `modules/06-attempt-engine/migrations/`.

Differences from the original sketch:

| Item | Detail |
| --- | --- |
| (a) `status` CHECK | Aligns with the PROJECT_BRAIN decision: `'draft','in_progress','submitted','auto_submitted','cancelled','pending_admin_grading','graded','released'` |
| (b) Timer columns | Added `ends_at` and `duration_seconds`, so the timer is server-pinned at start |
| (c) `client_revision` | Added `client_revision INT NOT NULL DEFAULT 0` on `attempt_answers` (decision #7) |
| (d) `saved_at` | Added `saved_at` on `attempt_answers`. Dropped `updated_at` |
| (e) `integrity`, `client_meta` | Deferred. Those signals live in `attempt_events` rows for now. Phase 2 may aggregate them into a denormalized column on the row. The original sketch's `integrity` and `client_meta` columns are dropped from the live schema. If Phase 2 wants a denormalized aggregate, the read path can compute it from events in `attempt_scores` |
| (f) Cap-once index | Added a partial UNIQUE index on `(attempt_id) WHERE event_type='event_volume_capped'`. It enforces the cap-once invariant (decision #23) |
| (g) RLS | `attempts` uses the standard variant (tenant-bearing). The three child tables use JOIN RLS |

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
    -- FU-C2 (2026-10-06): 'pending_admin_grading' is RESERVED; last written by
    -- application code before 67ed5e2 (2026-10-01). Submitted attempts now stay
    -- 'submitted'/'auto_submitted' until graded (RCA 2026-10-03 "Attempts tab
    -- Pending grading was always empty", RV58). The value stays in the CHECK
    -- for backward compatibility with old rows and the derived evaluation_status
    -- reader (modules/07-ai-grading/src/repository.ts countGradingQueue); do not
    -- remove it (Rule A).
  )),
  started_at      TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,                            -- pinned at start = started_at + level.duration_minutes
  submitted_at    TIMESTAMPTZ,
  duration_seconds INT,                                    -- snapshot of level.duration_minutes * 60
  embed_origin    BOOLEAN NOT NULL DEFAULT FALSE,          -- Phase 4 (2026-05-03): TRUE when attempt was started via embed JWT flow (D2); used in analytics and admin filters
  ai_proposals    JSONB,                                   -- Migration 0100 (2026-05-29, Bug A robustness): server-side cache of latest GradingProposal[] from handleAdminGrade. Review buffer ONLY — D8 unchanged, no gradings row is written without admin Accept click. Cleared in same tx as the gate-flip status='graded' in admin-accept.ts (true completion). Lets the FE hydrate proposals state on page load even if the original synchronous POST /grade response was dropped by Cloudflare's ~100s edge timeout. Null when no run yet or after a successful accept.
  grading_started_at TIMESTAMPTZ,                          -- Migration 0100 (2026-05-29): in-flight marker. SET by handleAdminGrade on entry (after status + heartbeat + single-flight checks), nulled at batch completion (success or thrown-error catch path). Drives the FE "Grading in progress" banner + 15s auto-poll. FE treats marker > 10 min as stalled (likely API restart mid-batch) — shows "Re-grade (previous stalled)" + caps polling at 12 min. A fresh Grade-all click overwrites a stale marker (no DB-level lock needed; the single-flight mutex is the real lock).
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempt_number  SMALLINT NOT NULL DEFAULT 1 CHECK (attempt_number >= 1), -- Z-39, 0203: 1 = first attempt, 2 = first retake ...
  UNIQUE (assessment_id, user_id, attempt_number)         -- Z-39, 0203 (was UNIQUE (assessment_id, user_id)): the race-proof limit on retakes
);
CREATE INDEX attempts_user_idx ON attempts (tenant_id, user_id);
CREATE INDEX attempts_timer_sweep_idx ON attempts (ends_at) WHERE status = 'in_progress';
CREATE INDEX attempts_assessment_status_idx ON attempts (assessment_id, status);
-- Migration 0150 (2026-10-03, N22): partial index for the tenant dashboard KPI count
-- (countGradingQueue in modules/07-ai-grading/src/repository.ts, polled every 30 s).
-- The WHERE list equals the status list of that query: keep both in sync. 'released'
-- and in-progress attempts are not in the index, so it stays small for a long history.
-- evaluation_released_at is INCLUDEd for an index-only count. Not included: a change
-- of the query. Rejected: a full (tenant_id, status) index (larger, same benefit).
CREATE INDEX attempts_dashboard_count_idx ON attempts (tenant_id, status) INCLUDE (evaluation_released_at)
  WHERE status IN ('submitted', 'auto_submitted', 'pending_admin_grading', 'graded');
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

| Item | Detail |
| --- | --- |
| Frozen-version contract | `attempt_questions.question_version` snapshots `questions.version` at `startAttempt` time. The candidate view JOINs `question_versions ON (question_id, version)`. Admin edits to the live `questions.content` after start are invisible to the in-flight attempt. Test: `modules/06-attempt-engine/src/__tests__/attempt-engine.test.ts § getAttemptForCandidate "returns frozen content even after admin edits live question"` |
| Phase 1 grading-free contract (CLAUDE.md AssessIQ rule #1, decision #6) | `submitAttempt` sets `status` to `'submitted'` and stops. The CHECK accepts `'pending_admin_grading'`, `'graded'` and `'released'` for forward compatibility, but Phase 1 code never wrote them. The candidate endpoint `/api/me/attempts/:id/result` returns `202 grading_pending` until Phase 2 wires modules 07 and 08 |
| Superseded 2026-10-01 | `graded` and `released` are now written (MCQ scoring at submit, the platform evaluation queue, tenant or automatic publishing). `/api/me/attempts/:id/result` returns the released result. See § Scoring and result release at the end of this page |

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

| Item | Detail |
| --- | --- |
| What | A per-assessment snapshot of the eligible question pool, captured at publish |
| Why | Before 0096, an assessment resolved its content live at attempt start (`questions` `status='active'` pinned to `MAX(qv.version)`). Editing or re-syncing a pack changed what future attempts of an already-published assessment drew. Two candidates of one assessment could get different content if the pack changed between their start times. Freezing at publish makes the content of each assessment immutable. Master-pack revisions and clone auto-sync reach only newly published assessments |
| Write path | `freezeAssessmentPool` (module 05 service) runs inside the `withTenant` transaction of `publishAssessment` and `reopenAssessment`. It runs `INSERT … SELECT q.id, MAX(qv.version), q.domain_id, q.category_id, q.type, q.points FROM questions q JOIN question_versions qv … WHERE pack_id=$ AND level_id=$ AND status='active' GROUP BY …`. This mirrors the live pool query byte for byte, so the snapshot equals what a live draw would select |
| Write-once | `ON CONFLICT (assessment_id, question_id) DO NOTHING`. The first publish freezes. A later reopen is a no-op and keeps the original content |
| Read path | Module 06 `startAttempt` resolves `useFrozen = countFrozenPool(assessmentId) > 0`. If frozen, it draws from `assessment_frozen_pool` (the whole pool, or re-filtered by `(domain_id, category_id, type)` for blueprints) instead of the live `questions` queries. The frozen list helpers return the same `{ id, version }` shape and `ORDER BY question_id ASC`, so the shuffle, the size check and the `attempt_questions` snapshot do not change |
| Fallback (forward-only) | An assessment with no frozen rows (legacy, before 0096; pre-launch has no real attempts) falls back to the live query. Behaviour is the same as before. No backfill |
| Relationship to `attempt_questions` | Separate concerns. `assessment_frozen_pool` is the per-assessment eligible set, written at publish. `attempt_questions` is the per-attempt chosen subset, written at attempt start and unchanged. Both pin by `(question_id, version)` |

## Grading & scoring

**Status (2026-05-03, Phase 2 G2.A Session 1.a redesign):** Phase 1 tables are live. `prompt_versions` and `grading_jobs` are deferred to Phase 2 (see the last subsection).

| Item | Detail |
| --- | --- |
| What changed | The `gradings` shape below is the live shape from migration `modules/07-ai-grading/migrations/0040_gradings.sql`. The `tenant_grading_budgets` table is new in migration `0041_tenant_grading_budgets.sql`. Both ship in commit `7eea75b`. `prompt_versions` and `grading_jobs` are not in Phase 1. They wait for Phase 2 and the paid-API runtime |
| Why | The 8 pinned decisions in `docs/05-ai-pipeline.md` § "Decisions captured (2026-05-01)" replaced the Phase-2-leaning shape that this section first documented. D4 stores prompt provenance as three NOT NULL columns on `gradings` (`prompt_version_sha`, `prompt_version_label`, `model`): file-based skill SHA pinning, no FK to a `prompt_versions` table. D3 keeps `grading_jobs` out of Phase 1. The in-process single-flight mutex and `attempts.status` track the work instead. D6 adds `tenant_grading_budgets` as the per-tenant USD ceiling that the Phase 2 anthropic-api runtime checks before each call |
| Rejected | (a) Keep `gradings.prompt_version_id` as a FK to `prompt_versions`: Phase 1 has no such table, and the skill SHA on disk is the durable pin (D4). (b) Add `grading_jobs` in Phase 1 "for symmetry": a synchronous handler that writes and then reads the same row gains nothing (D3). (c) Store the budget as a token count: tenants pay in USD, and tokens are implementation leakage (D6) |
| Not included (deferred to G2.A Sessions 1.b and 1.c) | No `prompt_versions` table (Phase 2, only when the paid API needs a queryable prompt history). No `grading_jobs` table (Phase 2). No `attempt_scores` schema change here: that table belongs to module 09-scoring and ships with G2.B |
| Downstream impact | Module 09-scoring reads `gradings` for per-attempt aggregation and uses `escalation_chosen_stage` for stage badges. Module 10-admin-dashboard reads `tenant_grading_budgets` for the billing UI and reads `prompt_version_sha` to show the "skill drift" badge when the current `skillSha()` differs from the stored SHA. Module 13-notifications fires a `budget_exhausted` template when D6 enforcement trips (Phase 2). `tools/lint-rls-policies.ts` special-cases `tenant_grading_budgets` next to `tenants` (PK=tenant_id RLS variant) |

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

-- grader='deterministic' rows (2026-10-01): written by 09-scoring
-- scoreMcqForAttempt for every MCQ question of an attempt (no AI). Sentinel
-- values satisfy the NOT NULL columns: prompt_version_sha = prompt_version_label
-- = 'deterministic-mcq-v1', model = 'none', escalation_chosen_stage = NULL,
-- graded_by = NULL. status is 'correct' | 'incorrect'; score_max = questions.points;
-- score_earned = points or 0. The D7 unique index above (sentinel sha) is the
-- idempotency guard (INSERT ... ON CONFLICT DO NOTHING). Correctness is judged
-- against attempt_questions.question_version's question_versions.content.correct
-- (frozen), not the live question.
--
-- attempts.status transitions (2026-10-01): no schema change. submitted |
-- auto_submitted | pending_admin_grading -> graded is now also performed
-- directly at submit time for MCQ-only attempts (scoreMcqAndFinalizeIfComplete,
-- same tx as gradings rows + attempt_scores + billing_events + audit row).
-- admin-grade / admin-accept now accept auto_submitted as a pre-graded state.
--
-- RW-41 (migration 0168, 2026-10-11): two nullable provenance columns.
--   cli_version  TEXT   -- claude CLI version that produced the row (claude-code-vps runtime)
--   stage_inputs JSONB  -- raw tool inputs per stage {anchors, band, escalate}, as the model
--                       -- submitted them (submit_anchors / submit_band / escalate)
-- Both are NULL for deterministic, pattern, admin_override and manual rows, and for rows
-- written before 0168. No backfill. Same table, so no RLS change. The stored anchor_hits and
-- reasoning_band are post-processed (coerced, schema-checked, maybe edited by the admin);
-- stage_inputs keeps the raw input so a row can be replayed against a later skill version.
-- stage_inputs is capped at 64 KiB in the proposal schema. Server-side only: admin-accept
-- copies both from attempts.ai_proposals and ignores client values (docs/05-ai-pipeline.md D4).

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
```

### `gradings` side notes

| Item | Detail |
| --- | --- |
| `grader='deterministic'` rows (2026-10-01) | `09-scoring` `scoreMcqForAttempt` writes them for every MCQ question of an attempt (no AI). Sentinel values satisfy the NOT NULL columns: `prompt_version_sha` and `prompt_version_label` are `'deterministic-mcq-v1'`, `model` is `'none'`, `escalation_chosen_stage` and `graded_by` are NULL. `status` is `'correct'` or `'incorrect'`. `score_max` is `questions.points`. `score_earned` is the points or 0. The D7 unique index (sentinel sha) guards idempotency (`INSERT ... ON CONFLICT DO NOTHING`). Correctness is judged against `question_versions.content.correct` at `attempt_questions.question_version` (frozen), not the live question |
| `attempts.status` transitions (2026-10-01) | No schema change. `submitted`, `auto_submitted` or `pending_admin_grading` to `graded` now also happens at submit time for MCQ-only attempts (`scoreMcqAndFinalizeIfComplete`, same transaction as the `gradings` rows, `attempt_scores`, `billing_events` and the audit row). `admin-grade` and `admin-accept` now accept `auto_submitted` as a pre-graded state |
| RW-41 (migration 0168, 2026-10-11) | Two nullable provenance columns: `cli_version TEXT` (claude CLI version that produced the row, `claude-code-vps` runtime) and `stage_inputs JSONB` (raw tool inputs per stage `{anchors, band, escalate}`, as the model submitted them with `submit_anchors`, `submit_band` and `escalate`) |
| RW-41 values | Both are NULL for deterministic, pattern, admin_override and manual rows, and for rows written before 0168. No backfill. Same table, so no RLS change |
| RW-41 rationale | The stored `anchor_hits` and `reasoning_band` are post-processed (coerced, schema-checked, maybe edited by the admin). `stage_inputs` keeps the raw input, so a row can be replayed against a later skill version |
| RW-41 limits | `stage_inputs` is capped at 64 KiB in the proposal schema. Server-side only: `admin-accept` copies both from `attempts.ai_proposals` and ignores client values (`docs/05-ai-pipeline.md` D4) |
| `tenant_grading_budgets` | D6: per-tenant USD ceiling for the Phase 2 anthropic-api runtime. PK = `tenant_id` (special-case RLS variant, same shape as `tenants`). Phase 1 `claude-code-vps` mode does not use the budget. The table ships now, so the module 10 billing UI has a stable target and the future pre-call gate (D6) can read a populated row without a new migration. RLS uses `tenant_id = current_setting('app.current_tenant', true)::uuid` (the PK is the discriminator). The carve-out is at `lint-rls-policies.ts:178-185` |

### `generation_attempts` — AI question-generation observability (Phase 1 / Stage 1, 2026-05-09)

**Status:** live. Migrations `0042_generation_attempts.sql` and `0043_generation_attempts_citation_dropped.sql` (`modules/07-ai-grading/migrations/`). Applied to production in the Stage 1 type-sharded generation release (`f449203`). The table records every `handleAdminGenerate` call. Admins can then diagnose why a "Generate" click produced zero or fewer questions than requested without SSH to the VPS.

| Item | Detail |
| --- | --- |
| Ownership | The INSERT and UPDATE write path is in `modules/07-ai-grading/src/handlers/admin-generate.ts`. The GET read endpoint is in `modules/04-question-bank/src/routes.ts` (read-only projection for the pack-detail UI). 07-ai-grading owns the table because the write path and all observability concepts (`skill_sha`, `model`, `stderr_tail`, `chunks_*`) belong to that module |
| `stderr_tail` privacy gate | Stored only for non-grading skills (`generate-questions`, `generate-rubric`). For grading skills, stderr is captured in memory and never logged or stored. Candidate text must not appear in any durable store. The gate is in `modules/07-ai-grading/src/runtimes/claude-code-vps.ts` |
| `batch_id` (migration 0106, 2026-06-01) | Nullable `UUID`. History grouping. One "Generate question set" wizard action fires one `POST /admin/generate` for each category. Each call writes its own `generation_attempts` row (needed for per-category progress, resume and category tagging). An N-category set produced N history rows |
| `batch_id` wizard | The wizard mints one `crypto.randomUUID()` for each batch. It persists the id on the localStorage `GenBatchPlan`, so a resumed batch keeps the same id. It sends the id on every per-category call |
| `batch_id` server | `handleAdminGenerate` stores it (`$7::uuid`, parameterised). The route parses an optional UUID-validated `batch_id` (`tenantId` always comes from the session). `GET /admin/generation-attempts` adds it to the SELECT projection only (no new WHERE or ORDER BY) |
| `batch_id` UI | The history UI collapses rows with an equal non-null `batch_id` into one expandable parent: rollup status running > partial > success, summed counts and duration, "N runs", and per-category children on expand. NULL or legacy rows render standalone |
| `batch_id` is not a boundary | It is not a tenant or authorization boundary. Isolation stays on `tenant_id` RLS only. The app layer computes grouping over rows that are already tenant-scoped. Adversarial review: ACCEPT |

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

### `attempt_scores` — module 09-scoring

**Status:** live (shipped G2.B Session 3, 2026-05-01). Migration `modules/09-scoring/migrations/0050_attempt_scores.sql`.

| Item | Detail |
| --- | --- |
| What | The aggregated scoring result for one attempt. One row for each attempt (UPSERT on recompute) |
| Writers | `computeAttemptScore()` after each admin-accept grading cycle (non-fatal fire-and-forget from `handleAdminAccept`), and `GET /api/admin/attempts/:id/score` on demand |
| Why | It separates "sum gradings" from "query scores". The reporting and leaderboard endpoints read this table (cheap) instead of re-aggregating `gradings` at query time (expensive). It is also the home of the `archetype_signals` JSONB |
| Rejected | (a) A materialized view: UPSERT semantics allow recomputation on override without a REFRESH. (b) Separate storage for archetype signals: signals and label are always read together, and JSONB avoids 11 nullable float columns |
| Not included | Per-question score breakdown (it is in `gradings`). Section sub-scores (Phase 3+). Threshold pass/fail flag (Phase 3+) |
| Downstream impact | 10-admin-dashboard reads `auto_pct` and `archetype`. 15-analytics reads `auto_pct` and `computed_at` for the export CSV |

```sql
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

**Status:** not applied. These tables ship when `AI_PIPELINE_MODE` flips to `anthropic-api` (D1). They are not in Phase 1.

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
  role        TEXT CHECK (role IN ('admin','reviewer')),   -- set when audience='role'. Changed by 0181 (2026-10-16, Y-1): in_app_notifications_role_check is now role IN ('admin')
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
  audience        TEXT NOT NULL CHECK (audience IN ('admin','reviewer','candidate','all')),  -- 'reviewer' kept on purpose (RW-2, owner decision). 0179 does not change this CHECK
  locale          TEXT NOT NULL DEFAULT 'en',
  short_text      TEXT NOT NULL,                           -- tooltip (<=120 chars)
  long_md         TEXT,                                    -- full help drawer markdown
  version         INT NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'active',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, key, locale, version)
);
```

**Status:** `help_content` is live (2026-05-02). Migration `modules/16-help-system/migrations/0010_help_content.sql`.

| Item | Detail |
| --- | --- |
| RLS variant | Nullable-tenant variant, split into 4 scoped policies (`SELECT`, `UPDATE`, `DELETE`, `INSERT`) |
| Why not one policy | A single `FOR ALL` policy contributes its `USING` clause as an implicit `WITH CHECK` for INSERT. That would let the app role insert global rows (`NULL IS NULL` is TRUE and passes the check). See the `docs/RCA_LOG.md` 2026-05-02 entry |
| Empty-string GUC | `NULLIF(current_setting('app.current_tenant', true), '')::uuid` handles the `pg.Pool` empty-string GUC leak |
| `UNIQUE NULLS NOT DISTINCT` | Needs Postgres 15 or later. With the default `NULLS DISTINCT` mode and a nullable `tenant_id`, the seed migration would insert duplicate global rows on re-runs |

## Row-Level Security policies

For every domain table with `tenant_id`:

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON <table>
  USING (tenant_id = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation_insert ON <table>
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
```

The application sets the tenant context once for each request:

```sql
SET LOCAL app.current_tenant = '<tenant-uuid>';
```

System-level operations (cross-tenant analytics, support tools) use a `BYPASSRLS` Postgres role for explicit elevation, audited separately.

### System-role transactions: `withSystemRole(reason, fn)` (RW-38, 2026-10-11)

`withSystemRole` in `modules/02-tenancy/src/with-tenant.ts` is the one way to run code under the `assessiq_system` role (commit `66a7c50`). It shares a private scaffold with `withTenant`. Steps:

1. Check that `reason` is a non-empty string. Otherwise throw `ValidationError` with code `INVALID_SYSTEM_ROLE_REASON`.
2. Throw `SYSTEM_ROLE_INSIDE_TENANT` if the call runs inside a `withTenant` scope. An `AsyncLocalStorage` marker tracks the scope.
3. Log `system-role.tx` with `{reason, caller}` (stream `app`).
4. `BEGIN`, then `SET LOCAL ROLE assessiq_system`, then run `fn`.
5. `COMMIT` on success or `ROLLBACK` on error. Release the client. Run `onCommit` hooks after commit, as `withTenant` does.
6. If `ROLLBACK` itself fails, the helper destroys the client with `release(true)` (commit `9e6ded9`). No connection returns to the pool in an open elevated transaction. `withTenant` does the same.

Mixed pattern: a caller may read cross-tenant under the system role. The caller may then run `SET LOCAL ROLE assessiq_app` plus `set_config('app.current_tenant', ...)` in the same transaction for an audited tenant write. This is allowed. The caller owns the role switch and comments it at each site.

Raw connects: `tools/pool-connect.allowlist.txt` lists every file that may call `pool.connect()` outside the two helpers. Format: `<path> | <reason>`. Four entries remain:

| File | Reason |
|---|---|
| `modules/15-analytics/src/refresh-mv-job.ts` | `REFRESH MATERIALIZED VIEW` needs the MV owner role. The job uses session `SET ROLE assessiq_system` and `RESET ROLE` |
| `modules/02-tenancy/src/middleware.ts` | The request-scoped client lives across two Fastify hooks. A callback scaffold cannot wrap it |
| `modules/16-help-system/src/service.ts` | `withGlobalsOnly` reads anonymously under `assessiq_app` with the tenant GUC reset to NULL. Neither role fits |
| `modules/18-certification/src/repository.ts` | `withPublicVerifyContext` reads under `assessiq_app` with the `app.public_verify` GUC and the nil-UUID tenant. Neither role fits |

`pnpm lint:rls` (`tools/lint-rls-policies.ts`) fails on any raw `pool.connect()` that is not listed. It also fails on a listed file with no raw connect (a stale entry).

| Item | Detail |
| --- | --- |
| Behaviour change 1 | `verifyCandidateLoginTokenSystem` (`01-auth/src/candidate-login.ts`) now consumes the token inside a transaction. It used a session-level `SET ROLE` and `RESET ROLE` |
| Behaviour change 2 | The email retry count in `13-notifications/src/email/index.ts` now reads `email_log` under `withTenant`. The old raw connect had no tenant role, so RLS hid the row and the count always fell back to attempt 1 |
| Behaviour change 3 | Three local system-role wrappers are deleted. Every hand-rolled system transaction in modules and `apps/api` now calls `withSystemRole` |
| Why | Before, many sites opened the system role by hand. Each had its own error handling and none was logged. One shared helper makes the role switch visible in logs and removes the missed-`RESET ROLE` risk |
| Rejected | (a) Audit every system call automatically: an audit row needs a tenant, and many system reads are cross-tenant. (b) A separate `withSystemReadOnly`: module 07 keeps a thin wrapper that adds `SET TRANSACTION READ ONLY` |
| Not included | `refresh-mv-job` is not converted (it needs the MV owner role). The `02-tenancy` middleware is not converted (it is superseded and not registered) |
| Downstream impact | New code that needs the system role must call `withSystemRole(reason, fn)` with a reason that says why. A new raw connect needs an allowlist line with a reason, or `pnpm lint:rls` fails. See `docs/11-observability.md` for the `system-role.tx` log event and `modules/02-tenancy/SKILL.md` for the contract |

## Indexes worth calling out

| Index | Purpose |
| --- | --- |
| `attempts (assessment_id, user_id)` | Unique. The main lookup for "has this candidate started?" |
| `gradings (attempt_id, question_id)` | Main composite for the results page |
| `audit_log (tenant_id, at DESC)` | Admin audit feed |
| `attempt_events (attempt_id, at)` | Replay for behavioral scoring |
| Partial indexes `WHERE deleted_at IS NULL` | Users and questions |
| `email_log (tenant_id, created_at DESC)` | Timeline feed. Also the partial `(tenant_id, status) WHERE status IN ('queued','failed','bounced')` for retry sweeps |
| `in_app_notifications (tenant_id, audience, created_at DESC) WHERE read_at IS NULL` | Unread short-poll query |
| `billing_events_tenant_idx (tenant_id)` | Tenant-scoped `COUNT(*)` for the used-credit math (module 19-billing) |
| `webhook_deliveries` | No own index. Queries always filter through `endpoint_id`, which maps back to the tenant through the RLS JOIN |
| `assessments_open_boundary_idx`, `assessments_close_boundary_idx` (0021), `attempts_timer_sweep_idx` (0030) | Partial indexes. Since RW-39 (commit `67ad882`) they also serve the two cross-tenant sweep queries that find tenants with due boundaries or expired attempts. No new index was added. See `docs/11-observability.md` section 13.2 |
| `attempt_summary_mv (tenant_id, attempt_id)` | **UNIQUE** composite. Required for `REFRESH MATERIALIZED VIEW CONCURRENTLY` (Phase 3 G3.C) |

---

## Materialized view — `attempt_summary_mv`

**Status:** live. Phase 3 G3.C (migration `0060`, module 15-analytics).

### Why

Heavy analytics queries (cohort reports, heatmaps, exports) join `attempt_scores → attempts → assessments` on every request. At scale the per-request join cost is too high. `attempt_summary_mv` pre-joins these tables into one row for each scored attempt. A nightly job refreshes it.

### What changed vs rejected alternatives

| Choice | Detail |
| --- | --- |
| Considered | TimescaleDB hypertable. Rejected: too much for Phase 3 volume (fewer than 50 k attempts), and it adds operational complexity |
| Chosen | A standard Postgres materialized view with CONCURRENT refresh. No extra infrastructure. `REFRESH CONCURRENTLY` holds no table-level lock, so live reads continue during the refresh |

### Score columns are NULL until the result is released to the tenant (migration `0122`, 2026-10-01)

| Item | Detail |
| --- | --- |
| What changed | `0122_attempt_summary_mv_released_only.sql` drops and recreates the view. Every scored attempt still has a row. `total_earned`, `total_max`, `auto_pct`, `pending_review` and `archetype` are `NULL` unless the tenant can see the result: `status = 'released'` OR (`status = 'graded'` AND `evaluation_released_at IS NOT NULL`). The same migration restores the indexes, the `assessiq_system` owner (0088) and the `SELECT` grants |
| Why | Before, cohort reports, the individual report, archetype counts, the export and Activity stats could show scores of attempts that the platform still evaluated or had sent back. Owner rule: a company sees only complete, released results |
| Rejected | Dropping unreleased rows from the view. The Activity "completions" KPI would then undercount submitted attempts |
| Readers that changed | The two score lists (`individualReport` and admin cohort attempts in `modules/15-analytics/src/repository.ts`) add `auto_pct IS NOT NULL`. `AVG` and `PERCENTILE_CONT` ignore `NULL`, so the aggregate readers do not change. The candidate readers already filter `attempt_status = 'released'` |
| Not included | Refresh timing. The view still refreshes nightly (02:00 UTC) and on the manual refresh route. A result released today shows in reports after the next refresh, as before |
| Z-89 (migration `0219`) | `attempt_summary_mv` and `question_stats_mv` are recreated with `WHERE attempts.delivery_mode = 'real'`. Columns, indexes, owner and grants are unchanged. A mock attempt has no row in either view. Rejected: a `delivery_mode` column filtered in every reader (easy to miss one). The mock dashboard (Z-90) needs its own source |
| Same rule on the live tables (not the view) | Module 09 `TENANT_VISIBLE_ATTEMPT_SQL` (`modules/09-scoring/src/repository.ts`) on cohort, leaderboard and individual reports. The cohort topic breakdown and the home "avg % this week" KPI (`15-analytics/src/repository.ts`). The assessment invitee list join to `attempt_scores` (`05-assessment-lifecycle/src/repository.ts`) |

### RLS caveat

**Postgres does NOT enforce RLS on materialized views.** Every query against `attempt_summary_mv` MUST include:

```sql
WHERE tenant_id = current_setting('app.current_tenant', true)::uuid
```

`tools/lint-mv-tenant-filter.ts` enforces this in CI.

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

A BullMQ job `analytics:refresh_mv` (registered in `apps/api/src/worker.ts`) refreshes the view nightly at **02:00 UTC**. Initial populate at deploy time:

```bash
psql -U assessiq_system -c "REFRESH MATERIALIZED VIEW attempt_summary_mv"
```

## Materialized view — `question_stats_mv`

*Type: reference.* **Status:** live since S15 (2026-10-17). Migration `0189_question_stats_mv.sql`, module 15-analytics. Task RW-60 / FU-C14.

**What changed.**

| Item | Detail |
| --- | --- |
| Grain | One row for each `(tenant_id, question_id)` |
| Columns | `tenant_id`, `question_id`, `pack_id`, `level_id`, `source_question_id`, `exposure_count`, `attempts`, `correct_count`, `correct_rate` NUMERIC(5,4), `mean_band` NUMERIC(5,4), `point_biserial` NUMERIC(6,4), `last_used_at`, `computed_at` |
| `exposure_count` | Count of `attempt_questions` rows whose attempt status is `submitted`, `auto_submitted`, `pending_admin_grading`, `graded` or `released` |
| `attempts` | Attempts that the tenant can see (same rule as migration `0122`: `released`, or `graded` with `evaluation_released_at` set). Each has an effective grading that is not `review_needed`. The effective grading is the newest `gradings` row for the attempt and question |
| `correct_count`, `correct_rate` | Correct means status `correct` or full marks. `correct_rate` is `correct_count / attempts`. It is `NULL` when `attempts` is 0 |
| `mean_band` | Average `reasoning_band` divided by 4. Scale 0 to 1. Only rows with a band count |
| `point_biserial` | `corr(is_correct::int, rest_score)`. `rest_score` is the attempt total earned minus the score of this question (item-rest). `NULL` under 2 attempts or with zero variance |
| `source_question_id` | Copy of `questions.source_question_id` (migration `0084`). A tenant answers a clone of a platform question. This column links the clone to its source |
| Indexes | UNIQUE `question_stats_mv_pk (tenant_id, question_id)` (needed for `REFRESH ... CONCURRENTLY`). `question_stats_mv_pack_idx (tenant_id, pack_id)` |
| Owner and grants | Owner `assessiq_system`. `GRANT SELECT` to `assessiq_app` and `assessiq_system` |

**Visibility rule.** Postgres does not enforce RLS on a materialized view. Every read must filter `tenant_id = current_setting('app.current_tenant', true)::uuid`. The only exception is the super-admin roll-up in `modules/15-analytics/src/question-stats.ts`. It carries the exact marker `-- mv-tenant-filter: allow cross-tenant (super_admin roll-up, RW-60)`. `tools/lint-mv-tenant-filter.ts` now checks both view names and accepts only this marker (self-tested).

**Refresh.** `processRefreshMvJob` (`modules/15-analytics/src/refresh-mv-job.ts`) refreshes `attempt_summary_mv`, then `question_stats_mv`, both `CONCURRENTLY`. It runs in the nightly job `analytics:refresh_mv` (02:00 UTC) and in `POST /api/admin/analytics/refresh`. A result released today shows in the statistics after the next refresh. First populate after deploy: `psql -U assessiq_system -c "REFRESH MATERIALIZED VIEW question_stats_mv"` (the migration creates the view with data).

**Why.** `attempt_summary_mv` has one row for each attempt. A per-question report needs a different grain. The Phase C report of the difficulty spec (`docs/design/2026-05-23-question-difficulty-spec.md` § 6) needs per-item success, discrimination and exposure.

**Considered and rejected.**
- Add question columns to `attempt_summary_mv`. The grain does not match.
- Compute the statistics at request time. The item-rest correlation needs a join over all attempts of the tenant.

**Not included.** Incremental refresh (full recompute each night; the comment `ponytail:` in the migration names the upgrade path). A count of distinct organisations (`clone_count` counts copies). A column for the miscalibrated flag (the service computes it).

**Impact.** API: [03-api-contract.md](03-api-contract.md) § S15 additions, `GET /api/admin/super/questions/:id/stats`. Log: [11-observability.md](11-observability.md) § 40. Tenant purge and question delete code must keep working: the view holds no foreign keys.

---

## 18-certification — `certificates`

**Status:** scaffolded in Phase 5 Session 1 (2026-05-11). Migration `modules/18-certification/migrations/0046_certification_init.sql`. The text said "not yet applied to any database; deployment scheduled for Phase 5 Session 2". <!-- verify --> Later notes on this page (migrations 0074, 0075 and 0076) show that Phase 5 shipped.

A `certificates` row is a point-in-time snapshot of a credential that a candidate earned.

- Fields are frozen at issuance. Profile or score changes after issuance do not update the row (plan §1.1 "snapshot" rule).
- A tier upgrade updates `tier` and `signed_hash` in place. It keeps `credential_id` and `issued_at`, so shared LinkedIn URLs and HMAC signatures stay valid.

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
| `certificates_tenant_candidate_attempt_uniq` | `UNIQUE(tenant_id, candidate_id, attempt_id)` | One certificate for each attempt. Issuance is idempotent. The DB is the race-condition firewall |
| `certificates_credential_id_key` | `UNIQUE(credential_id)` | Globally unique public slug (not tenant-scoped; recruiters look it up without the tenant) |
| `tier CHECK` | `tier IN ('completion', 'distinction', 'honors')` | Enum guard at DB level |
| `revoke_reason CHECK` | `length(revoke_reason) <= 1000` | Bounds admin input |

### Indexes

| Index | Columns | Hot read pattern |
|---|---|---|
| `certificates_candidate_idx` | `(tenant_id, candidate_id)` | "My Certificates" list. Admin list filtered by candidate |
| `certificates_credential_id_idx` | `(credential_id)` | Verify-page slug lookup (O(1) through UNIQUE; named for EXPLAIN clarity) |

### RLS

Public verify-page note (Phase 5 Sessions 3–4):

- Migration `0074_public_verify_policy.sql` added `public_verify_lookup` (FOR SELECT, through the `app.public_verify = 'true'` GUC, set transaction-local). It supports the no-auth recruiter endpoint without a permissive all-tenants policy.
- Migration `0075_tenant_isolation_null_safe_cast.sql` then hardened all three `tenant_isolation` policies with an explicit `IS NOT NULL AND <> ''` guard.
- Reason: Postgres ORs in the `public_verify_lookup` policy. A bare `::uuid` cast on an empty-string GUC would raise a `22P02` exception before the OR can short-circuit. The hardened form turns that crash into `FALSE` (RLS denies, which is safe).
- The hardened predicate is strictly stricter than the original. There is no regression risk.

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

| Decision | Detail |
| --- | --- |
| `attempt_id` replaces `enrollment_id` | AssessIQ has no `enrollments` table. `attempts` (module 06) is the concrete completed entity. `UNIQUE(tenant_id, candidate_id, attempt_id)` gives per-attempt idempotence. Rejected: an `assessment_id` FK, which is too coarse (a candidate could have multiple attempts in one assessment cycle) |
| `candidate_id` ON DELETE SET NULL | Keeps the historical certificate record (snapshotted `display_name`) after GDPR account deletion |
| `credential_id` is globally unique | The slug is used in QR codes and LinkedIn share URLs. Recruiters look it up without the issuing tenant |
| Counters use server-side arithmetic | `UPDATE … SET col = col + 1`. Never read-modify-write. The counters are non-critical analytics, so a lost increment is acceptable |
| `issued_at` truncation | Truncate `issued_at` to second precision before HMAC signing. PostgreSQL keeps microseconds. A drift between the stored value and the re-signing input gives a different digest. See `modules/18-certification/SKILL.md` D6 |

---

## 19-billing — `tenant_plans` + `billing_events`

**Status:** live since Phase A1 (2026-05-17, commit `111dd77`). Migrations in `modules/19-billing/migrations/`: `0078_tenant_plans.sql`, `0079_billing_events.sql` and `0080_backfill_tenant_plans.sql`. Applied to production `assessiq-postgres`.

### `tenant_plans`

One row for each tenant: the billing tier and credit allowance. The `createCompany` hook provisions it (after the `tenant.created` audit entry, inside the `withTenant` context of the new tenant). Migration `0080` backfills existing tenants.

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

No UPDATE or DELETE policy exists in A1. Plan mutation is deferred to A2 and runs only under the `assessiq_system` BYPASSRLS role. A company admin can only read its own row. Provisioning inserts run under the `withTenant` context of the new tenant.

#### Design decisions — `tenant_plans`

| Decision | Detail |
| --- | --- |
| `included_credits IS NULL` means unlimited | Avoids a sentinel integer (for example `-1` or `MAX_INT`). The unlimited check is an explicit `IS NULL` branch at the query layer. In A1 only the `internal` tier has NULL credits |
| `cycle_start` reserved, not queried | Credit cycles (monthly reset, rollover) are an A2 concern. The column exists now, so A2 can add the cycle engine without a schema change |
| No mutable counter column | The used-credit count is derived on read from `billing_events` (`COUNT(*)`). This self-reconciles on re-grade and avoids a class of counter-drift bugs |

---

### `billing_events`

An append-only ledger. One row for each graded candidate attempt (one consumed credit). Migration `0079_billing_events.sql`.

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

#### Migration 0160 — second meter and monthly window (FU-A2 / FU-A4 / FU-A9, 2026-10-06)

| Item | Detail |
| --- | --- |
| What changed | `billing_events` gains `question_id UUID NULL` (no FK: the ledger survives a question delete) and a second `event_type` value `ai_answer_evaluated`. A CHECK ties `question_id` to that type |
| Unique indexes | The table-wide `UNIQUE (tenant_id, attempt_id)` becomes two partial unique indexes: `billing_events_graded_uniq (tenant_id, attempt_id) WHERE event_type = 'assessment_graded'` and `billing_events_ai_answer_uniq (tenant_id, attempt_id, question_id) WHERE event_type = 'ai_answer_evaluated'`. One attempt carries one credit row and one row for each AI-evaluated answer. Each is idempotent |
| Monthly count index | `billing_events_tenant_type_time_idx (tenant_id, event_type, occurred_at)` |
| RLS | Unchanged (SELECT and INSERT policies; UPDATE and DELETE stay revoked from `assessiq_app`) |
| Why | The tier table (`docs/plans/PRICING_TIERS_2026-10-06.md`) meters AI-evaluated answers each month. The ledger had one event type and lifetime counts |
| Writer | `07 admin-accept.ts` calls `recordAiAnswerEvaluated` right after each accepted AI grading insert, in the same transaction (same revenue-leak rule as `recordGradedAttempt`) |
| Monthly window (FU-A2) | SQL derives the current window start as `cycle_start + whole months elapsed` (Postgres month arithmetic, month-end clamped). The app never rolls `tenant_plans.cycle_start` (the app role has no UPDATE policy, and a stored value would duplicate the derivation). Both meters count rows with `occurred_at >= window start` |
| Rejected | A `billing_events` row for each AI run (a re-run of the same answer is not a new billable unit). A counter column on `tenant_plans` (mutable counters drift; the ledger is the source) |
| Not included | Included AI answers for each tenant as a column (a constant for each tier, `TIER_AI_ANSWERS_INCLUDED` in 19). Hard caps (soft reporting only, like credits) |
| Downstream | `getUsage`, `getAllTenantUsage` and `getTenantBillingDetail` return `ai_answers_used`, `ai_answers_included` and `cycle_window_start`. The plan card and the super-admin billing drawer show them. `getRecentBillingEvents` lists graded events only |

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

There is no UPDATE or DELETE policy. The append-only invariant has a second guard at the DB role level, like the `audit_log` pattern:

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON billing_events FROM assessiq_app;
```

#### Usage math (no mutable counter)

```sql
-- used      = COUNT(*) FROM billing_events WHERE tenant_id = ?
-- remaining = included_credits - used          (NULL included_credits ⇒ unlimited)
-- overage   = max(0, used - included_credits)
```

The ledger gives all three values on read. They self-reconcile: a re-grade that removes the old grading row and inserts a new one produces at most one `billing_events` row for each attempt (UNIQUE constraint).

#### Design decisions — `billing_events`

| Decision | Detail |
| --- | --- |
| Same transaction as grade-commit | The `billing_events` INSERT runs in the same Postgres transaction as the attempt → `graded` transition in `07-ai-grading/admin-accept.ts`, like `auditInTx`. A non-conflict DB error rolls back the whole grade (revenue-leak invariant). `billing_events` availability is therefore on the critical path of grade-commit, with the same blast radius as `audit_log` |
| `UNIQUE(tenant_id, attempt_id)` | Idempotency firewall. An operator retry or a duplicate grade-commit RPC cannot charge a tenant twice |
| `attempt_id ON DELETE CASCADE` | A GDPR attempt purge removes the billing row, as in the `certificates` table. Accepted: the credit is effectively refunded on purge. This is correct, because the attempt no longer exists |
| `event_type` extensible through CHECK | Future event classes (for example `ai_question_generated` in A3) extend the enum. The A1 query always filters `WHERE event_type = 'assessment_graded'` |

---

### `tenant_entitlements` (Phase B1)

**Status:** live since Phase B1 (2026-05-18, commits `2ba822d` and `9f073a5`). Migrations in `modules/19-billing/migrations/`: `0081_tenant_entitlements.sql` (schema) and `0082_entitlements_backfill.sql` (data backfill). Applied to production `assessiq-postgres`.

One row for each `(tenant, scope)`. The scope is a domain label (for example `soc`) or a specific pack UUID. This allows coarse domain-level grants and fine-grained per-pack overrides.

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

- There is no UPDATE or DELETE policy, by design.
- Grant and revoke run under `assessiq_system` (BYPASSRLS) in a two-role, same-transaction pattern. The system role writes the entitlement. Then the role switches to `assessiq_app` plus `set_config('app.current_tenant', tenantId, true)` for the `auditInTx` write to `audit_log`.
- This is the same pattern as A2 `updateTenantPlan`.
- A company admin reads its own active rows (read-only) through `GET /api/billing/entitlements` (RLS-scoped, active only).

#### Grant / revoke semantics

- Revoke sets `status` to `'revoked'` with an UPDATE. It never hard-deletes. All rows are append or soft, so the ledger is auditable.
- A re-grant of a revoked `(tenant, scope_type, scope_id)` reactivates the row with `ON CONFLICT (tenant_id, scope_type, scope_id) DO UPDATE SET status='active', granted_by=…, granted_at=now(), revoked_by=NULL, revoked_at=NULL`.
- The `UNIQUE` constraint makes grant idempotent. A second grant on an active scope is a no-op conflict.

#### Backfill — `0082_entitlements_backfill.sql`

The migration backfills domain-level rows for every `(tenant, question_packs.domain)` that has at least one `questions.status='active'` row in a `question_packs.status='published'` pack.

- `granted_by = NULL::uuid`. The explicit cast is required: a bare `NULL` under `SELECT DISTINCT` resolves to `text` and fails uuid coercion on PG16.
- Idempotent: `ON CONFLICT (tenant_id, scope_type, scope_id) DO NOTHING`.
- It ships a zero-NULL verification query. The operator MUST run it before any B2 deploy. A live tenant and domain without an active entitlement would get 403 at publish time in B2.
- Applied to production 2026-05-18: 3 rows inserted (`e2e-walkthrough→soc`, `wipro-soc→soc`, `wipro-soc→phishing`). Verification: PASS.

#### B1↔B2 contract

B2 (publish-time enforcement; now live, see the next subsection) treats a referenced pack as entitled if its domain OR its `pack_id` has an active entitlement row for the session tenant. The `internal` tier bypasses the entitlement check.

#### Phase B2 — publish-time enforcement

**Status:** live since Phase B2 (2026-05-18, commit `5c80aaa`). No schema migrations. B2 is application-layer only and reads the tables from B1.

| Item | Detail |
| --- | --- |
| Read model | At every transition into `assessments.status='published'`, `assertPublishEntitled(client, tenantId, assessment.pack_id)` (exported from `@assessiq/billing`) runs. This covers `publishAssessment` and `reopenAssessment` in `modules/05-assessment-lifecycle/src/service.ts`, inside their existing `withTenant` transaction. It runs BEFORE the `status='published'` write and BEFORE the `assessment.published` audit entry |
| Failure | `AppError 403 NOT_ENTITLED`. The surrounding `withTenant` issues a ROLLBACK. No partial published row and no audit entry remain |
| RLS | Reads on `tenant_plans`, `tenant_entitlements` and `question_packs` run under the `withTenant` RLS SELECT policies of the publishing tenant. No system role is used. Cross-tenant reads are structurally impossible (RLS plus a server-derived `tenantId`) |
| Deploy safety | B2 went live only after a production assertion confirmed that ZERO existing `published` or `active` assessments would fail the gate (an assessment-level check, stronger than the B1 domain-proxy zero-NULL query). 2026-05-18: PASS (`e2e-walkthrough/soc` and `wipro-soc/soc` covered by the `0082` backfill; `wipro-soc` uses the internal bypass) |

The implemented check (B1↔B2 contract):

- `tenant_plans.tier = 'internal'`: **bypass**. Always allowed, whatever the entitlement rows.
- No `tenant_plans` row for the tenant: **fail closed** (enforce, do not bypass).
- Entitled if `assessment.pack_id` is in the active `tenant_entitlements(scope_type='pack')`, OR the `question_packs.domain` of that pack is in the active `tenant_entitlements(scope_type='domain')`.
- The comparison is exact-string. This is intentional. It matches the `0082` backfill, which derives `scope_id` verbatim from `question_packs.domain`.

Known follow-ups (not B2 defects):

- The domain comparison is case-sensitive by design. A future B1-UI hardening should normalize case at grant time, not at query time. (Migration 0090 and the write-path lowercase rule now cover this. See "Domain slug normalization".)
- `pack_id` immutability after draft is enforced at the service layer only. A DB CHECK constraint is a separate hardening task.
- The Docker-less test silent pass (no testcontainer in local-only mode) is an existing repo-wide pattern. A test-harness sweep is tracked separately.

#### Design decisions — `tenant_entitlements`

| Decision | Detail |
| --- | --- |
| Append or soft delete, no hard DELETE policy | Like the `audit_log` and `billing_events` append-only invariants. Revoked rows stay in the table as an immutable audit trail |
| `UNIQUE(tenant_id, scope_type, scope_id)` makes grant idempotent | Concurrent grant calls collapse to one row. A re-grant of a revoked scope updates the row in place |
| `granted_by = NULL` for backfill | A valid sentinel. It separates system-provisioned rows from operator grants in the audit trail without a separate backfill flag column |
| `scope_id` is TEXT (not UUID) | Domain labels (`soc`, `phishing`) are not UUIDs. A TEXT column with a service-layer 256-char cap covers both scope types without two columns or a polymorphic FK |
| `(tenant_id, status)` index | The main B2 query pattern is `WHERE tenant_id = ? AND status = 'active'`. The composite index covers it without a scan of revoked rows |

---

### Phase A2 — plan mutation + audit additions

**Status:** live since Phase A2 (2026-05-17, commit `66ea0ff`). A2 has no schema migrations (A1 created all tables). A2 adds the application-layer mutation path and the `PATCH /api/admin/super/tenants/:id/plan` endpoint.

#### `tenant_plans` mutation path (A2)

`tenant_plans` has SELECT and INSERT RLS policies only. It has **no UPDATE or DELETE policy**, by design (see § RLS — `tenant_plans` above). A plan change through `PATCH /api/admin/super/tenants/:id/plan` therefore runs in a **two-role transaction**:

1. `assessiq_system` (BYPASSRLS) takes the row lock (`SELECT … FOR UPDATE`) and runs the `UPDATE` on `tenant_plans`.
2. In the **same transaction**, the role switches to `assessiq_app` plus `set_config('app.current_tenant', tenantId, true)`. The `auditInTx` write to `audit_log` then runs in the role and GUC context that the INSERT RLS policy of `audit_log` and the contract of `modules/14-audit-log/src/audit.ts` require.

- This mirrors the reviewed `updateAiGenerateMode` precedent in `@assessiq/tenancy`.
- The `UPDATE` and the `audit_log` INSERT are atomic. A rollback reverts both.
- `cycle_start` is **read-only in A2**. It is reserved for a future billing-cycle engine. Usage in A2 is a lifetime `COUNT(*)`, not cycle-windowed.

#### Validation invariants — `updateTenantPlan` (`@assessiq/billing`)

The `updateTenantPlan` service function enforces these before the transaction opens:

- `tier ∈ {free, pro, enterprise, internal}`
- `included_credits` is `NULL` or an integer ≥ 0
- `tier = 'internal' ⇒ included_credits IS NULL` (unlimited; `includedCredits` omitted on transition to `internal` is coerced to `null`)
- `tier ≠ 'internal' ⇒ included_credits IS NOT NULL`

The matching 400 error codes are `INVALID_TIER`, `INVALID_CREDITS`, `INTERNAL_REQUIRES_NULL_CREDITS` and `FINITE_TIER_REQUIRES_CREDITS` (see `docs/03-api-contract.md` § PATCH `.../plan`).

#### `audit_log.action` catalog — A2 addition

- `'tenant.plan_updated'` was appended to `ACTION_CATALOG` in `modules/14-audit-log/src/types.ts` (append-only addition). `updateTenantPlan` emits it through `auditInTx`.
- The existing `'tenant_settings.ai_generate_mode.updated'` action (added in A1) is unchanged.
- The `audit_log.action` column (`TEXT NOT NULL`; see § Audit, notifications, help above) carries free-form action strings. `ACTION_CATALOG` defines the valid values. Known values after A2:

| Action | Emitted by | Module |
|---|---|---|
| `tenant_settings.ai_generate_mode.updated` | `updateAiGenerateMode` | `modules/02-tenancy` |
| `tenant.plan_updated` | `updateTenantPlan` | `modules/19-billing` |
| `tenant.entitlement_granted` | `grantTenantEntitlement` | `modules/19-billing` |
| `tenant.entitlement_revoked` | `revokeTenantEntitlement` | `modules/19-billing` |

---

## Module 20 — data-rights (S1 — 2026-05-29)

### `consent_events` (migration `modules/20-data-rights/migrations/0101_consent_events.sql`)

A per-user, per-purpose consent ledger. It is **append-only**. It has the same RLS and REVOKE posture as `audit_log`: two policies (SELECT and INSERT), and `assessiq_app` has UPDATE, DELETE and TRUNCATE revoked. A withdrawal is a new row with `withdrawn_at` set and `granted_at` NULL. Chronological order reconstructs the ledger.

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

Row-level CHECK: `granted_at IS NOT NULL OR withdrawn_at IS NOT NULL`. A row with both NULL has no meaning.

Indexes:

- `consent_events_user_purpose_idx`: `(tenant_id, user_id, purpose, created_at DESC)`. It answers "what is the current consent of this user for X?"
- `consent_events_tenant_created_idx`: `(tenant_id, created_at DESC)`. It serves the admin ledger view.

### `users.metadata` keys `roll_number`, `branch` (2026-10-01, `1a4f82d`, no migration)

| Item | Detail |
| --- | --- |
| What | The candidate CSV import (`modules/03-users/src/import.ts`) accepts optional header columns. Roll number: `roll_number` (aliases `roll no`, `roll`, `enrollment`). Branch: `branch` (aliases `department`, `dept`) |
| Matching | Ignores case, spaces, `_` and `-`. Values are trimmed and capped at 64 characters. Control or bidi characters drop the value |
| Storage | `users.metadata->>'roll_number'` and `->>'branch'` |
| Re-import | A re-import updates the stored value only from non-empty cells. An empty cell never wipes it |
| Read by | The results CSV (03 § results.csv) |
| Why metadata, not columns | `users.metadata` already exists, is covered by `users` RLS and needs no migration. Rejected: new `users.roll_number` and `users.branch` columns (a schema change for two display-only fields) |
| Not included | Editing roll or branch in the admin UI. Search or filter by branch |
| DPDP | Module 20 erasure removes both keys from `users.metadata` (`modules/20-data-rights/src/erasure.ts`). It was added in the same session, after review found that erasure left `metadata` untouched |

### `assessments.settings.integrity` (2026-10-01, `0d9999e`, no migration)

| Item | Detail |
| --- | --- |
| What | `settings.integrity = { fullscreen?: boolean, block_copy_paste?: boolean }`. Both default to false |
| Validation | A strict Zod schema (`AssessmentIntegritySettingsSchema`, `modules/05-assessment-lifecycle/src/types.ts`) on create and update |
| Set from | The admin create form, in the `Test integrity` box |
| Exposed | To the runner on `CandidateAttemptView.integrity` |
| Events | `fullscreen_enter` and `fullscreen_exit` are new `attempt_events.event_type` values (closed catalog in `modules/06-attempt-engine/src/types.ts`, narrative in `EVENTS.md`). `GET /api/admin/attempts/:id/integrity` and the results CSV read the integrity counts |
| Not included | An edit UI for the switches of an existing assessment (`updateAssessment` replaces `settings` wholesale, so an editor must send the full object). Server-side enforcement: a candidate can exit full screen and bypass clipboard blocking. Both are recorded, not prevented. The help text says so |

### `users.erased_at` (migration `0102_users_erased_at.sql`)

A DPDP and GDPR erasure marker. It is **distinct from `users.deleted_at`** (see `modules/20-data-rights/SKILL.md` D1). When it is set, the `name` and `email` columns of the row hold tombstone values:

- `name → 'deleted_user_' || substring(sha256(id::text), 1, 12)`
- `email → 'deleted+' || <same hash> || '@erased.assessiq.local'`

Partial index for the S5 retention purge cron: `users_tenant_candidate_not_erased_idx ON users (tenant_id, created_at) WHERE role = 'candidate' AND erased_at IS NULL AND deleted_at IS NULL`.

### `tenant_settings.retention_days` (migration `0103_tenant_retention_days.sql`)

- A per-tenant candidate-data retention window in DAYS. CHECK `BETWEEN 1 AND 3650`. Default `730` (2 years, HR-grade).
- It is **distinct from `tenant_settings.audit_retention_years`** (added by `14-audit-log` migration 0050, default 7 years for the audit forensic chain).
- The two windows differ on purpose: PII is minimized at 2 years. Audit is kept for 7 years for compliance forensics.

FU-B4 (2026-10-06): the two retention windows in one table.

| Column | Table | Unit | Default | Range | Governs |
|---|---|---|---|---|---|
| `retention_days` | `tenant_settings` (migration `0103`) | days | 730 (2 years) | 1-3650 | Candidate PII minimization (`20-data-rights` purge cron) |
| `audit_retention_years` | `tenant_settings` (migration `0050`, `14-audit-log`) | years | 7 | 1-10 | Audit-log forensic chain (compliance) |

**Status:** the archive job in `modules/14-audit-log/SKILL.md` § Retention ("daily job archives rows older than retention to cold storage") is parked and not built. See that file for the marker.

### Historical `audit_log` PII redaction (migration `0104_audit_log_pii_redact_backfill.sql`)

- A one-shot recursive redaction of the `before` and `after` JSONB of every existing `audit_log` row.
- It runs as `assessiq_system`, through the exception path documented in `0050_audit_log.sql` § IRREVERSIBILITY NOTE.
- It does not alter the schema. This page lists it for the data-model audit trail.
- See the `docs/RCA_LOG.md` 2026-05-29 entry for the D7 finding that triggered it, and `modules/20-data-rights/SKILL.md` D7 for the rationale.

### Forward-protection extension to `14-audit-log/src/redact.ts`

PII field-name patterns added 2026-05-29. Every future `audit()` or `auditInTx()` write redacts at any depth, recursively:

| Group | Patterns |
| --- | --- |
| Identity | `email`, `_email$`, `name`, `_name$`, `display_name`, `full_name` |
| Contact | `phone`, `_phone$`, `phone_number`, `phone_number_e164`, `mobile`, `whatsapp` |
| URLs | `linkedin_url`, `resume_url` |
| Free text | `answer_text`, `_answer_text$`, `candidate_answer`, `feedback_text`, `comment_text`, `notes_text` |
| Network | `ip`, `_ip$`, `ip_address`, `user_agent`, `_user_agent$` |

- The patterns are broad on suffixes on purpose. Future call sites with new field names (for example `recipient_email`, `candidate_name`) are covered without a new edit of `redact.ts`.
- Over-redaction of non-PII suffixes (`tenant_name`, `pack_name`, `course_name`) is acceptable. `audit_log` serves "did this change?" forensics, not "what was the name?".
- No pattern covers the `correct_answer` rubric ground truth (not candidate PII). It stays in the audit JSONB for grading-event forensics, on purpose.

---

## Scoring and result release (2026-10-01)

**Status:** live. Phase I (SP1-SP4) shipped in the `ecea951` deploy. Phase II (SP9-SP11, the platform evaluation queue) shipped in `a7b4596`.

- Owner rules: a candidate sees only a complete, final score (P1). Each tenant chooses how results are published (P3).
- This section describes the **data**. Behaviour: `docs/03-api-contract.md` § Scoring and result release and `docs/05-ai-pipeline.md` § Platform evaluation queue.

### `attempts` — 4 columns + 1 index (`modules/06-attempt-engine/migrations/0113_attempts_evaluation_release.sql`)

| Column | Meaning |
|---|---|
| `evaluation_released_at timestamptz NULL` | "The tenant may see and publish this result." Set when an auto-scorable (all-MCQ) attempt completes at submit (09 `finalizeAttemptIfComplete(markEvaluationReleased: true)`) and when the platform releases an evaluation to the tenant (07 `handleSuperReleaseToTenant`). The send-back of the tenant clears it. Publishing (`graded` → `released`) requires it |
| `evaluation_released_by uuid NULL` → `users(id)` | Who released the evaluation. NULL means the system (auto-scorable completion). The auto-release sweep uses it as the audit actor when set |
| `evaluation_note text NULL` | The send-back note of the tenant. Free text, so it is never copied into `audit_log` |
| `evaluation_sent_back_at timestamptz NULL` | When the tenant last sent the attempt back to the platform queue |

- **Backfill:** every row already `graded` or `released` got `evaluation_released_at = now()`. Existing finished results stay publishable and do not re-enter the queue.
- **Index:** `attempts_ready_to_release_idx ON attempts (evaluation_released_at) WHERE status = 'graded' AND evaluation_released_at IS NOT NULL` keeps the cross-tenant scan of the auto-release sweep small.
- **`attempts.status` is unchanged** (CHECK list above). Modules 06, 07, 09, 15 and the frontends read it. The new state lives in columns, not in a new enum value. The older note that `graded` and `released` are "never written" is obsolete.

### `tenant_settings` — 2 columns (`modules/02-tenancy/migrations/0114_tenant_settings_result_release_mode.sql`)

| Column | Detail |
| --- | --- |
| `result_release_mode text NOT NULL DEFAULT 'manual' CHECK (IN ('manual','auto'))` | **manual:** a finished result waits until a tenant admin publishes it. **auto:** the worker sweep `result.auto_release` publishes it within about 15 s of the release of the evaluation to the tenant. Default `manual` (safer for hiring tenants) |
| `result_release_auto_since timestamptz NULL` | `now()` on manual → auto. `NULL` on auto → manual. A same-mode request leaves it unchanged |
| `result_feedback_level text NOT NULL DEFAULT 'none' CHECK (IN ('none','right_wrong','with_expected_answer','with_ai_justification'))` | Added by `modules/02-tenancy/migrations/0190_tenant_settings_result_feedback_level.sql` (RW-80, S15). How much per-question detail a candidate sees on a released result. **none:** nothing. **right_wrong:** outcome, the candidate's own answer and a "what to study" line. **with_expected_answer:** adds the expected answer for deterministic types. **with_ai_justification:** adds a plain-words line for AI-graded questions. Default `none`. OWNER GATE: the owner picks the production default later. Only writer: `updateResultFeedbackLevel` (`modules/02-tenancy/src/service.ts`): one `UPDATE` plus one `tenant.settings.updated` audit row (`before` and `after` = `{ result_feedback_level }`) in one transaction. A same-value request is a no-op with no audit row. Rollback: `UPDATE tenant_settings SET result_feedback_level = 'none'`; the column stays. Contract: [03-api-contract.md](03-api-contract.md) § S15 additions. |
| `certificate_show_distinction boolean NOT NULL DEFAULT false` | Added by `modules/02-tenancy/migrations/0205_tenant_settings_certificate_show_distinction.sql` (Z-50). **false:** every certificate shows the wording Completion. **true:** a certificate whose stored tier is `distinction` shows the word Distinction. Display only: `certificates.tier` and `signed_hash` never change. Read at render time, so a change also changes how old certificates look. Changed only through `updateCertificateShowDistinction` (audited). The column lives in module 02 and has no foreign key |

- Automatic publishing needs mode `auto`, this value NOT NULL, and `evaluation_released_at >= result_release_auto_since`. Switching to auto therefore never publishes results that already wait. The admin uses the bulk "publish all ready" for those.
- Only writer: `updateResultReleaseMode` (`modules/02-tenancy/src/service.ts`). It does an UPDATE and writes one `tenant.settings.updated` audit row (`before` and `after` = `{ result_release_mode }`) in one transaction. It is not part of the generic settings patch.

### Effective grade and "complete result"

- **Effective grade** of a question = its newest `gradings` row: `DISTINCT ON (question_id) … ORDER BY graded_at DESC, (grader = 'admin_override') DESC`.
  - The tie-break matters. Rows written in one transaction share `now()`, and an override must win.
  - The same rule is in 09 `finalize.ts`, 09 `repository.getGradingsForAttempt`, 07 `getAttemptProgress` and 15 `results-export.ts`.
- **A result is complete** only when EVERY `attempt_questions` row (all five types, KQL included) has an effective grade with `status <> 'review_needed'`. An attempt with no frozen questions is never complete.
  - One definition, in 09 `finalizeAttemptIfComplete`. It is the only writer of `status = 'graded'` (billing runs in the same transaction).
  - The old gate counted only subjective, scenario and log_analysis, and let flagged grades through (`docs/RCA_LOG.md` 2026-10-01).
- `attempt_scores.total_max` is the sum of the `score_max` of the effective grades. A question with no grade used to vanish from both totals.
- KQL has no grader. A **manual first score** scores it: a `gradings` row with `grader = 'admin_override'`, `override_of NULL`, `prompt_version_sha` and `_label` `manual:v1`, `model` `manual`, `escalation_chosen_stage` `manual`, `score_max = questions.points`. The free-text reason lives in `override_reason`, never in audit.
- 09 `releaseAttemptInTx` re-checks "no effective `review_needed`" when it publishes. A later re-run can add a flagged row to a graded but unpublished attempt.

### Derived evaluation state (never stored)

`deriveEvaluationStatus` (`modules/07-ai-grading/src/repository.ts`) gives three states. Tenants see this state.

| State | Rule |
| --- | --- |
| published | status `released` |
| ready to publish | status `graded` AND `evaluation_released_at` set |
| awaiting evaluation | otherwise (still queued with the platform, or sent back) |

The platform queue holds attempts with at least one non-MCQ question, a non-erased candidate and an active tenant. They are either pre-graded (`submitted`, `auto_submitted`, `pending_admin_grading`) or `graded` with `evaluation_released_at IS NULL`.

### Help seeds and audit actions

| Item | Detail |
| --- | --- |
| `0115_seed_result_release_help.sql` | 3 new global rows (`admin.settings.result_release_mode`, `candidate.results.list`, `candidate.auth.org_code`) and 2 `UPDATE`s of global v1 rows (`candidate.submit.confirm`, `candidate.result.bands`: reworded to "complete result only"; the key name stays, because a rename breaks tenant overrides) |
| `0116_seed_evaluation_queue_help.sql` | 13 new admin rows (`admin.evaluations.*` ×9, `admin.attempts.{awaiting_evaluation,send_back,release_button}`, `admin.assessments.release_all`) |
| Both | Idempotent (`ON CONFLICT DO NOTHING`). `0011` is deliberately not regenerated (checksum-drift guard). Global rows: 136 → 139 → 152. `0109` stays a reserved gap |
| New `audit_log` actions (`modules/14-audit-log/src/types.ts`) | `grading.evaluation_released` (the platform hands an evaluation to the tenant) and `grading.sent_back` (the tenant returns it; the note is never in `after`). Both are written in the **audit log of the tenant of the attempt**, in the same transaction as the UPDATE |
| Changed actions | `grading.released` now carries `after.trigger` (`manual` or `auto`) and `actor_kind = 'system'` when the sweep releases an evaluation that has no releasing user. `grading.claimed` is no longer written (the catalog entry stays for historical rows) |

### Considered and rejected / not included / impact / rollback

| Item | Detail |
| --- | --- |
| Rejected | A new `attempts.status` value (see above). Storing `evaluation_status` (it derives from two columns, so it cannot drift). A `result_release_mode_changed_at` column (first draft of 0114; replaced by `result_release_auto_since`, which is NULL unless auto was switched on through the service, so the sweep releases nothing for a tenant whose mode was edited by hand) |
| Not included | A per-assessment release-mode override (design plan §6). A "result updated" email (a published result is final: 409 `RESULT_ALREADY_PUBLISHED`). Any table for the queue (it is a query) |
| Impact | 06 reads both tables for the candidate result. 07 owns the queue and the tenant review. 09 owns finalize and release. 15 candidate stats and leaderboard count only `status = 'released'`, and the results CSV prints "Awaiting evaluation" for unreleased rows. 13 sends `result_released`. 16 holds the help rows. `attempt_summary_mv` is unchanged |
| Rollback | Additive and nullable. Old code ignores the columns, and the default `manual` mode matches the old "an admin publishes" behaviour. The 0113 backfill is not reversed |

---

## Invitations, notifications and option shuffle (2026-10-01, later the same day)

Commits: `50ebccf` (invites), `def48bb` and `e33f1e6` (notifications), `55023bf` (option shuffle), `809e807` and `23c9f0b` (release on last accept), `88b3b02` (follow-ups). All migrations are additive.

| Item | Detail |
| --- | --- |
| `assessment_invitations.last_resent_at TIMESTAMPTZ NULL` (migration 0117) | Stamped whenever a link is re-issued (resend, bulk resend, re-invite after revoke). Bulk resend skips rows re-issued in the last 10 minutes, so `remaining` shrinks and a double click sends nothing. Original invitations keep NULL |
| Invitation lifecycle (no new status value) | Revoked = `status='expired'`. Lapsed = `pending` or `viewed` with `expires_at` in the past. A re-issue rotates `token_hash` on the same row, so the old link stops resolving. It sets `expires_at = now() + 7 days` and status `pending` |
| Link TTL | The candidate link TTL is now **168 h** (`DEFAULT_INVITATION_TTL_HOURS`), as in the candidate help and the admin guide. Links issued under 72 h were not backfilled |
| `attempt_questions.option_order SMALLINT[] NULL` (migration 0119) | A per-attempt MCQ permutation: `option_order[display position] = original option index` |
| `option_order` write rule | Written once at attempt start, only when `assessments.randomize` is true (the same switch as question order) and the options do not refer to each other. "All of the above", "Both A and B" and options in a non-Latin script stay in authored order |
| `option_order` NULL | NULL means authored order: old or in-flight attempts, and non-MCQ questions |
| `option_order` scope | Server-internal. Never returned to candidates. `attempt_answers.answer.selected` stays in ORIGINAL index space, so scoring (09), admin review, exports and analytics do not change |
| RLS UPDATE policies (migration 0121) | `tenant_isolation_update` on `email_log` (tenant predicate) and on `webhook_deliveries` (EXISTS through `webhook_endpoints.tenant_id`), with `USING` and `WITH CHECK`. Before, both tables had only SELECT and INSERT policies, so status updates as `assessiq_app` matched 0 rows silently (RCA 2026-10-01). `in_app_notifications` has the same gap (mark-read). **Not fixed here.** Migration 0126 fixes it (see Batch 3 below) |
| `attempts.evaluation_released_by` | Now also written by the completing accept, manual score or override of the platform evaluator, in the same statement as the graded flip |
| Help seeds | 0118 rewrites 7 evaluation-release help rows and adds `admin.evaluations.rerun_ai`. 0120 adds 3 invitation-resend keys and fixes `admin.platform.admin_email` (72 h → 7 days). Global help rows: 156 |
| Rejected | A new invitation status for "revoked" (the `expired` status semantics are enough). Storing shuffled answers in display space (it would touch scoring, review, exports and analytics). A per-assessment shuffle toggle (`randomize` already exists) |
| Not included | Invitation reminder emails. A public drive link with self-registration (design-gated). DSAR export translation of option order (it stays in original indexes) |

## Question types numeric and multi_select (2026-10-02)

`questions.type` CHECK is now `('mcq','subjective','kql','scenario','log_analysis','numeric','multi_select')`. Module 04 migration `0129_question_types_numeric_multi_select.sql` drops and re-adds the constraint `questions_type_check` (idempotent).

Content shapes (`questions.content` and `question_versions.content`):

- `numeric`: `{ "question": str, "answer": number, "tolerance"?: number >= 0 (absolute, default 0), "unit"?: str, "rationale"?: str }`.
- `multi_select`: `{ "question": str, "options": [2-10 str], "correct": [unique in-range int, >= 1], "scoring"?: "all_or_nothing" | "partial", "rationale"?: str }`.

| Item | Detail |
| --- | --- |
| Answers (`attempt_answers.answer`) | numeric = a JSON number (or null). multi_select = `{ "selected": [int] }` in original option indexes (the per-student shuffle in `attempt_questions.option_order` is translated at the save seam, as for mcq) |
| Scoring | `gradings` rows with `grader='deterministic'`, status `correct`, `partial` or `incorrect`. Partial multi_select writes `score_earned = round(points x (right - wrong) / \|correct\|, 2)`, floored at 0. No schema change to `gradings` |
| Help ids | Migration `0131` in module 16 |
| Not included | AI generation of these types, unit conversion, numeric ranges |

## Batch 3 schema changes (2026-10-02, migrations 0126-0129)

The numeric and multi_select section above (0129) stays as is. This section adds the rest and the reasoning.

### `attempt_questions.points` (0128, module 06)

| Item | Detail |
| --- | --- |
| What | `points INT NOT NULL`: the value of `questions.points`, frozen when the attempt starts (same INSERT that freezes `question_version`). Backfilled from `questions.points` for existing rows |
| Trigger | A `BEFORE INSERT` trigger `attempt_questions_default_points` fills it from `questions` if an insert omits it |
| NOT NULL | Set only when no row is left NULL |
| Use | The `score_max` source for every grading row. Six readers now use `aq.points`: 09 MCQ and deterministic scoring, and 07 `admin-grade`, `admin-manual-score`, `admin-rerun`, `admin-claim-release` |
| Why (E12) | Scoring read live `questions.points`. Editing the points of a question after a student started moved the score of attempts not yet graded |
| Rejected | Adding `points` to `question_versions` (versions are content snapshots, and points are not part of them today). Reading points lazily at grade time (that is the bug) |
| Not included | `question_versions` still has no points. Rows graded before 0128 keep their old `score_max`. Accepted residuals: the insert-default trigger runs in the RLS context of the caller, so a context mismatch fails loudly instead of writing a wrong value. Points are read a few ms after the version freeze, not in one statement. Commit `1547f2b` made the migration fail loudly on unmatched rows |
| Impact | Any new scoring reader must use `aq.points`, never `questions.points`. 02 `gradings.score_max` and 05 pipeline notes refer here |

### `questions.type` CHECK (0129, module 04)

| Item | Detail |
| --- | --- |
| What | The constraint `questions_type_check` is dropped and re-added with `numeric` and `multi_select` (shapes in the section above) |
| Rejected | A separate table for each type (no benefit; content is JSONB) |
| Not included | AI generation of the new types |
| Impact | 07 evaluation-queue predicates now exclude `numeric` and `multi_select` (see 05) |

### `in_app_notifications` UPDATE policy (0126, module 13)

| Item | Detail |
| --- | --- |
| What | One `FOR UPDATE` policy `tenant_isolation_update`, USING and WITH CHECK on `tenant_id = current_setting('app.current_tenant', true)::uuid` |
| Why | Migration 0056 created only SELECT and INSERT policies. Under RLS an UPDATE with no policy matches 0 rows silently, so mark-read never persisted (same class as 0121 for `email_log` and `webhook_deliveries`) |
| Rejected | A per-user predicate in RLS. The SELECT policy has none, and role or all audiences are shared rows. Per-user scoping stays in the WHERE of `markInAppNotificationRead` |
| Not included | No DELETE policy (nothing deletes rows) |
| Rollback | `DROP POLICY tenant_isolation_update ON in_app_notifications;` |
| Impact (rule) | Any table written with UPDATE under `assessiq_app` needs an explicit UPDATE policy |

### `webhook_deliveries.status = 'failed'` (no migration)

| Item | Detail |
| --- | --- |
| What | The 0058 CHECK already allowed `failed`, but nothing wrote it. Now the final attempt of the job (`attemptsMade + 1 >= opts.attempts`) sets `failed` plus `last_error`, `http_status` and `attempts` for transient errors (5xx, 408, 425, 429, network, timeout) before it throws |
| Backoff | Now indexes `schedule[attemptsMade-1]` (BullMQ counts from 1). Retries wait 1 m, 5 m, 30 m, 2 h |
| Why | Rows stayed `pending` for ever. The first retry used the second schedule entry |
| Rejected | Writing `failed` from a BullMQ `failed` event (needs a second worker hook) |
| Not included | `attempts: 5` means 4 retries, so the 12 h step is defined and never reached. Raising it changes the published contract and waits for a decision |
| Impact | Dashboards that count `pending` will drop. The existing resend path can re-send `failed` rows |

## Batch 4 notes (2026-10-02)

### Migration 0132: `attempt_questions.section_index`, `attempts.section_progress`

| Item | Detail |
| --- | --- |
| What | `attempt_questions.section_index SMALLINT NULL`: an index into `assessments.settings.sections`, frozen at attempt start in the same INSERT that freezes the question version. `attempts.section_progress JSONB NULL`: `{"current": int, "started_at": iso}`. Owned by 06 |
| NULL meaning | `NULL` on both means "no sections" (every existing row) or "still in section 0 since `started_at`" |
| Scope | Column adds only. RLS policies and GRANTs already cover both tables |
| Why | Per-section timers must be server-authoritative. The deadline of each section derives from `section_progress` plus the `minutes` of the section. It advances lazily (the next read or write after a deadline) or on "Finish section". Freezing `section_index` for each question keeps the section draw stable even if the pack changes later |
| Rejected | A separate `attempt_sections` table (more joins and a second RLS surface for two small facts). Stored deadlines for each section (stale as soon as an admin edits minutes, plus extra writes). Client-held timers (not enforceable) |
| Not included | No per-section score column or breakdown. No backfill (old attempts stay `NULL`). No guard on edits of `settings.sections` after attempts started (it would move their deadlines) |
| Impact | 06 `getAttemptForCandidate` returns only the questions of the running section for sectioned attempts. Saves to a locked section return `AE_SECTION_LOCKED` (see 03). `attempts.duration_seconds` and `ends_at` for a sectioned attempt = sum of section minutes. Apply before the code deploy (done by hand 2026-10-02) |

### `assessments.settings.sections` (JSONB, no migration)

| Item | Detail |
| --- | --- |
| What | `sections?: Array<{ name (1-80), category_ids? (uuid[], 1-50), question_count? (1-500), minutes (1-300), calculator? }>`, 1-10 entries, strict zod (`AssessmentSectionsSchema`, module 05). Each section needs `question_count`, `category_ids` or both. `createAssessment` and `updateAssessment` validate it. It cannot combine with `settings.blueprint` |
| Why a parallel structure, not the blueprint | The blueprint is single-domain `(category, type, count)` criteria with no time or order dimension, and only the super admin uses it. Sections need a name, a deadline and a calculator flag for each group. They must also work for the licensed-set path that company admins use |
| `minutes` is required | The first contract said optional. A section without its own deadline would need a second timing mode |
| Not included | `category_ids` are not checked for tenant ownership (a foreign id matches nothing, and the start fails with `POOL_TOO_SMALL`). No section edit UI after creation |
| Impact | The create form has a sections editor (10). The candidate UI shows a section header, timer and optional calculator (11) |

### Migration 0134: `assessment_invitations.reminded_at`

| Item | Detail |
| --- | --- |
| What | `reminded_at TIMESTAMPTZ NULL`, no default (metadata-only on Postgres 16). RLS unchanged. Owned by 05. Migration 0135 only seeds a help row (`admin.assessment.reminders`) |
| Why | The worker job claims a row with `UPDATE ... SET reminded_at = now() WHERE id = $1 AND reminded_at IS NULL RETURNING ...`. Overlapping ticks or two workers can never both send. The column also drives the "Reminder sent <time>" label and the 100-per-24 h platform cap (count of rows reminded in the last 24 h). A failed email clears its own claim |
| Rejected | A `reminders` table (one reminder for each invitation needs no history). BullMQ delayed jobs for each invitation (Redis state, lost on edit; a DB sweep is idempotent and survives deploys) |
| Not included | Multi-offset reminders. Per-tenant caps |
| Impact | `reissueInvitation` (resend or re-invite) resets `reminded_at` to NULL. The fresh 7-day link may earn one new reminder. `GET .../invitations` rows now include `reminded_at` |

### `assessments.settings.reminders` (JSONB, no migration)

| Item | Detail |
| --- | --- |
| What | `reminders?: { enabled: boolean, hours_before?: 1..168 }`, strict zod. Absent = OFF. `hours_before` defaults to 24 when enabled. Written only through `PATCH /api/admin/assessments/:id/reminders` (see 03) |
| Why | Default OFF. Brevo free allows 300 emails/day, shared by several products, and a reminder is the lowest-value mail |
| Not included | Revoked or lapsed links are never reminded. No reminder once a candidate has started. Full design: `docs/plans/INVITATION_REMINDERS.md` |

## Batch 5 schema changes (2026-10-02)

Only one new table (0142). Everything else is a view, help rows, or JSONB settings keys with no migration.

### Migration 0136: help rows for sections follow-ups

| Item | Detail |
| --- | --- |
| What | Seeds help ids for the admin "Section scores" card (`admin.attempts.section_scores`) and the candidate section summary in the final submit dialog. Owned by 16. Regenerates the seed in `0011_seed_help_content.sql` |
| Why | Same-PR rule: every new UI element gets a `help_id` |
| Not included | No schema change |

### Migration 0138: help rows for high-stakes grading

| Item | Detail |
| --- | --- |
| What | Help rows for the high-stakes card and the evaluation badge (E1). Owned by 16 |
| Not included | No column. The flag lives in JSONB (see below) |

### Migration 0140: view `grading_override_quality`

| Item | Detail |
| --- | --- |
| What | `CREATE VIEW ... WITH (security_invoker = true)`. One row for each admin override of an AI grade: `tenant_id, attempt_id, question_id, original_grading_id, override_grading_id, original_prompt_version_sha, original_model, original_reasoning_band, original_score_earned, score_max, override_reasoning_band, override_score_earned, override_reason, override_created_at`. Owned by 07 |
| Source | `gradings o JOIN gradings orig ON orig.id = o.override_of WHERE o.grader = 'admin_override' AND orig.grader = 'ai'` |
| Why | D8 already inserts an override row and keeps the AI row. "How often do humans disagree with prompt version X" is then only a join |
| RLS | `security_invoker = true` makes the view run as the caller, so the `gradings` tenant policy applies to tenant connections. The super-admin aggregate reads it through the read-only `assessiq_system` (BYPASSRLS) transaction. `SELECT` is granted to `assessiq_app` and `assessiq_system` |
| Rejected | A new table or new columns (duplicate data). A materialized view (the volume is tiny) |
| Not included | No candidate answer text in the view. `override_reason` is free admin text, so never export it publicly |
| Impact | Read by 07 `super-grading-quality.ts` and by the `harvest-overrides` CLI (which uses `DATABASE_URL`) |

### Migration 0141: help rows for the eval gate

| Item | Detail |
| --- | --- |
| What | Help rows for the evaluations-page gate banner and quality table. Owned by 16 |

### Migration 0142: table `generation_batches` (E6)

Owned by 07. It holds the durable plan and progress of the question-generation wizard.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | client-minted batch id, same value as `generation_attempts.batch_id` |
| `tenant_id` | UUID NOT NULL | FK `tenants(id)` |
| `user_id` | UUID NOT NULL | FK `users(id)`; the plan is per (tenant, user) |
| `domain_id` | UUID NULL | no FK |
| `level` | TEXT NULL | |
| `categories` | JSONB NOT NULL | the plan, array of category objects |
| `completed_category_ids` | JSONB NOT NULL default `[]` | array of uuid strings, always unioned, never overwritten |
| `status` | TEXT NOT NULL default `active` | CHECK in `active`, `done`, `dismissed` |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

| Item | Detail |
| --- | --- |
| Index | `generation_batches_user_status_idx (tenant_id, user_id, status, updated_at DESC)` |
| RLS | Enabled. Policy `tenant_isolation` (USING `tenant_id = current_setting('app.current_tenant', true)::uuid`, also the UPDATE check) and `tenant_isolation_insert` (WITH CHECK, same expression). Same shape as 0042 `generation_attempts` |
| Why | The wizard kept the plan in localStorage. A device change lost it, and it did not know the categories that the server finished after a tab died |
| Rejected | A table for each category (a plan is small). Storage on `generation_attempts` (that table is per attempt, not per plan) |
| Not included | No archive or cleanup job. Rows stay |
| Impact | Written by 04 routes and by `admin-generate.ts` (best-effort update after a successful category) |

### `assessments.settings.high_stakes` (JSONB, no migration)

| Item | Detail |
| --- | --- |
| What | `high_stakes?: boolean`. Absent or false = off. Zod `high_stakes: z.boolean().optional()` in 05 settings. Written at create, or alone through `PATCH /api/admin/assessments/:id/grading`, which does `jsonb_set(settings, '{high_stakes}', ...)` and keeps every other key |
| Why | The flag must be changeable after publish and must not interact with the sections lock |
| Read by | 07 `loadGradingData` (admin-grade, admin-rerun), live at grading time |
| Audit | `assessment.updated` with `before {high_stakes}` and `after {high_stakes}` |

### `assessments.settings.sections` lock rule (no migration)

| Item | Detail |
| --- | --- |
| What | Once any `attempts` row exists for the assessment, `updateAssessment` rejects a patch whose `settings.sections` differs from the stored value, with 409 `SECTIONS_LOCKED`. The compare uses canonical JSON (key order ignored, undefined equals null) |
| Why | Sections drive the frozen draws of each attempt (`attempt_questions.section_index`) and the deadlines (`attempts.section_progress`) |
| Not included | A DB constraint or trigger. The guard is in the service only. Other settings keys stay editable |

## Question type `ordering` (migration 0144)

| Item | Detail |
| --- | --- |
| What | `questions.type` CHECK is now `('mcq','subjective','kql','scenario','log_analysis','numeric','multi_select','ordering')`. Module 04 migration `0144_question_type_ordering.sql` drops and re-adds `questions_type_check` (idempotent, no table change) |
| Content shape | Zod `OrderingContentSchema`, strict, in `modules/04-question-bank/src/types.ts`: `{ "question": str, "items": [2-10 non-empty str], "correct_order": [int], "scoring"?: "all_or_nothing" \| "partial", "explanation"?: str }`. `correct_order` lists item indexes in the right order. It must be a permutation of `0..items.length-1` (superRefine). No rubric |
| Answer | `attempt_answers.answer = { "order": [int] }`: original item indexes in the order the candidate placed them. The candidate sees the items shuffled. The save seam translates displayed positions to original indexes (same mechanism as mcq and multi_select) |
| Per-attempt display order | `attempt_questions.option_order` (0119) holds the permutation, `order[displayPosition] = originalItemIndex`. For ordering it is ALWAYS drawn. It ignores `assessments.randomize` and the "options refer to each other" detector. It is never equal to `correct_order` (if the draw lands on it, it rotates by one). Reason: authors write the items in the right order, so an unshuffled list would give out the answer key. Function: `buildOrderingOrder` in `modules/06-attempt-engine/src/option-shuffle.ts`, called from `startAttempt` |
| Scoring | `orderingFraction` in `modules/09-scoring/src/mcq.ts`. A malformed answer (not a permutation of the right length) scores 0. `all_or_nothing` (default) scores 1 only when equal to `correct_order`. `partial` = matching positions / n. One `gradings` row, `grader='deterministic'`, points from `attempt_questions.points`, status `correct`, `partial` or `incorrect`. A blank answer scores 0. `finalize.ts` is unchanged |
| Rejected | A separate table (content is JSONB). Letting authors store an arbitrary `correct_order` in the editor (the editor writes the authored order as the key, `correct_order` = identity; the schema still accepts any permutation, for example for import). A drag-and-drop library (Up/Down buttons are accessible and add no dependency) |
| Not included | AI generation of ordering questions (generation type lists and `DIFFICULTY_SPEC` exclude it). Partial credit by adjacent pairs or longest common subsequence. Ordering inside the `/try` demo |
| Impact | The three `non_mcq` predicates (07 `repository.ts`, 07 `handlers/super-evaluations.ts`, 06 `result.ts`) and `apps/api/src/jobs/evaluation-queue-alert.ts` now read `NOT IN ('mcq','numeric','multi_select','ordering')`. Help ids: migration `0145` in module 16 (`admin.question.content.ordering`, `admin.question.ordering.items`, `admin.question.ordering.scoring`) |
| Rollback | Re-add the old CHECK without `'ordering'` after you delete or archive ordering questions. The code paths are inert without such rows |

## Question type `structured_case` (migration 0152, 2026-10-03, SP7)

| Item | Detail |
| --- | --- |
| What | `questions.type` CHECK is now `('mcq','subjective','kql','scenario','log_analysis','numeric','multi_select','ordering','structured_case')`. Module 04 migration `0152_question_type_structured_case.sql` drops and re-adds `questions_type_check` (idempotent, no table change) |
| Content shape | Zod `StructuredCaseContentSchema`, strict, `modules/04-question-bank/src/types.ts`: `{ "title": str, "context": str, "log_excerpt"?: str (max 20000), "steps": [1-12 of { "id": str, "prompt": str, "select": "one" \| "many", "options": [2-8 str], "correct": [unique in-range int, >= 1] }], "scoring"?: "all_or_nothing" \| "partial" (default partial), "explanation"?: str }` |
| Content rules | A `superRefine` requires unique step ids, valid unique `correct` indexes, and exactly one correct index when `select` is `one`. No rubric |
| Answer | `attempt_answers.answer = { "steps": { "<stepId>": [int] } }`. The indexes are ORIGINAL option indexes, because this type is not shuffled. The save seam checks the shape against the FROZEN `question_versions.content` (see 03, answer save rule) |
| Scoring | `structuredCaseFraction` in `modules/09-scoring/src/mcq.ts`. Malformed content or answer, or an unknown step id, gives 0. Step `one`: 1 only when the single pick equals `correct[0]`. Step `many`: `multiSelectFraction` (partial only when the question scoring is `partial`). Question: `all_or_nothing` gives 1 only if every step is 1. `partial` gives the mean of the step fractions. One `gradings` row, `grader='deterministic'`, points from `attempt_questions.points`. `finalize.ts` is unchanged |
| Why | Log-triage and incident-response cases need several linked choices about one shared log or story. Single `mcq` and `multi_select` questions cannot share the context |
| Rejected | (1) Reuse `scenario` with all-mcq steps: whether a question is deterministic would depend on its content, not its type, and the rule "one question never mixes deterministic and AI points" would be hard to prove. (2) Extend `multi_select`: no shared context, one answer only. (3) Shuffle the options: needs one `option_order` for each step id; see the ponytail note in `option-shuffle.ts` |
| Not included | Per-step option shuffle. AI generation (generation type lists and `DIFFICULTY_SPEC` exclude it). The `/try` demo. An e2e case. An edit form for existing questions (the editor is create-only, like `ordering`) |
| Impact | `DETERMINISTIC_TYPES` and both SQL lists in `scoreMcqForAttempt` and `scoreMcqAndFinalizeIfComplete` include the type. The four `non_mcq` predicates (07 `repository.ts`, 07 `handlers/super-evaluations.ts`, 06 `result.ts`, `apps/api/src/jobs/evaluation-queue-alert.ts`) now exclude it from the evaluation queue (commit `860bfc3`). Help ids: migration `0153` in module 16 |
| Rollback | Re-add the old CHECK without `'structured_case'` after you delete or archive such questions. The code paths are inert without such rows |

## Migration numbering facts (RV78, 2026-10-03)

A record of how the migration files are numbered. Nothing is renumbered. Count: 126 migration files.

| Item | Detail |
| --- | --- |
| Numbers used twice (10) | 10, 11, 12, 13, 14, 15, 16, 20, 21, 50. The 3-digit and the 4-digit files share these numbers |
| Numbers missing up to 153 (41) | 5-9, 23-29, 34-39, 45, 47-49, 51-54, 59, 61-69, 109, 124, 137, 139, 151 |
| `0057` | 13-notifications, `tenants_smtp_config`. A comment-only no-op. The column already exists from `02-tenancy/0004` |
| Order | The plain basename order fails on an empty database (`0010` runs before `020` users). The real order is the grouping in `tools/test-support/apply-all-migrations.ts`. The `find \| sort` loop in `docs/06-deployment.md` sorts by path and is wrong for a fresh database (a warning is added there) |
| Why | The review (RV78) found the gaps and doubles |
| Rejected | Renumbering: it would break the applied-migration records on production. Filling the gaps with empty files: no value |
| Not included | Any change to a migration file or to the runner |
| Impact | A new migration must take the next free number above 153 and must be placed in the grouping of `apply-all-migrations.ts` |

### Migration lint (RW-40, 2026-10-11)

`tools/lint-migrations.ts` checks every file in `modules/*/migrations/`. It runs in `pnpm lint:repo`. Commit `9badb1d`.

| Rule | Check |
| --- | --- |
| R1 | No two files share a basename |
| R2 | The prefix has 4 digits. The nine legacy 3-digit files are the only exception: `010`, `011`, `012`, `013`, `014`, `015`, `016`, `020`, `021` |
| R3 | A file does not use a table that a later file creates. The order source is `tools/test-support/apply-all-migrations.ts`, the real apply order, not the basename order |
| R4 | The name matches `^\d{3,4}_[a-z0-9_]+\.sql$` |
| R5 (RW-51c, S10, 2026-10-15) | Every `modules/**/*.sql` file sits at `modules/<n>/migrations/` or `modules/<n>/seeds/`. The `R5_EXEMPT` list is empty. `tools/migrate.ts` reads only those folders, so a `.sql` file one level deeper never ran. The runner now logs a `migration.skipped` warning for such a file |

| Item | Detail |
| --- | --- |
| Why | The RV78 review found gaps, doubles and an order that basename sorting gets wrong. The lint stops new mistakes without a renumber |
| Rejected | Timestamp names: the owner decided on 2026-10-11 to keep 4-digit numbers and add the lint |
| Not included | No migration file is renamed or edited. The lint does not parse function bodies |

## Post-migration seeds (RW-40, 2026-10-11)

| Item | Detail |
| --- | --- |
| What | A seed is a SQL file in `modules/<module>/seeds/*.sql`. `tools/migrate.ts` runs all seeds after all migrations, in basename order, one transaction for each file. The test harness (`tools/test-support/apply-all-migrations.ts`) does the same. A seed is not recorded in `schema_migrations`. Each seed must be idempotent (`ON CONFLICT ... DO NOTHING` or `DO UPDATE`), because it runs on every apply. The flag `--skip-seeds` turns the run off |
| First seed | `modules/16-help-system/seeds/help_content.sql`. It moved from `modules/16-help-system/migrations/0011_seed_help_content.sql` with the same content. Production keeps its applied `0011` row in `schema_migrations`. `migrate.ts --check` ignores rows that exist only in the database, so there is no drift report |
| Why | The old `0011` was a numbered migration that the generator rewrote after it was applied. A numbered migration is checksummed and must not change after apply. A seed has no number and no checksum, so the generator can rewrite it at any time |
| Fresh-database effect | Global help rows go from 255 to 325. The forward help migrations (`0136` to `0166`) now insert before the seed runs. The reader still returns the newest active text: `DISTINCT ON (tenant_id, key, locale) ... ORDER BY version DESC` in `modules/16-help-system/src/repository.ts` (about line 186). Production is not affected |
| Rejected | (1) Renumber (RV78): breaks the applied-migration records. (2) Timestamp names: the owner decision of 2026-10-11 keeps 4-digit numbers plus the lint. (3) Keep `0011` as a migration: every seed would then need a number for ever |
| Not included | The seed is not run again on production. Other seed-like migrations stay migrations: the taxonomy seeds `0019`, `0020` and `0083` are not converted |
| Impact | Hand-applied deploys do not run seeds (see `docs/06-deployment.md`, "Seeds"). New help text still ships as a forward migration plus a YAML edit. The generator `tools/generate-help-seed.ts` now writes the seed path. The CI drift check compares that path |

## Migration 0155: help ids under the page prefix (2026-10-03, N23)

| Item | Detail |
| --- | --- |
| What | `modules/16-help-system/migrations/0155_help_ids_page_prefix_n23.sql` renames 30 `help_content` keys and copies three of them for a second page. There is no schema change: no table, column, index or policy changes. Global help rows go from 200 to 203. Seed `0011` is regenerated to match |
| Why | Keys outside their page prefix never load (see `docs/07-help-system.md`) |
| Rejected | Changing the help API to return other keys (a wider change that needs a tenant-safety review) |
| Not included | No text change |
| Impact | Only module 16 and the admin pages that use the ids |

## Migration 0156: question type frozen per version (2026-10-03, N21)

| Item | Detail |
| --- | --- |
| What | `modules/04-question-bank/migrations/0156_question_versions_type_n21.sql` adds `question_versions.type` (TEXT, NOT NULL). It backfills the column from `questions.type`. It adds `question_versions_type_check`, which allows the same nine types as `questions_type_check` (migration 0152). A `BEFORE INSERT` trigger, `question_versions_default_type`, fills a missing type from the question row. RLS does not change: the policies are row-level, and a new column needs no policy edit |
| Commits | `94fdc4a` (04 writers, 06 and 09 readers) and `9084a53` (07 readers) |
| Writers | The 04 version writers set `type` explicitly. A clone refresh (resync) treats a type change as a content change and writes a new version |
| Readers | 06 (attempt engine, `result.ts`) and 09 (scoring, `mcq.ts`) read the type from `question_versions` through `attempt_questions.question_version`. Module 07 reads `qv.type` too (`9084a53`) in five queries: `repository.ts` queue counts, `admin-grade`, `admin-rerun`, `admin-claim-release` and `super-evaluations`. An attempt now keeps the type it started with |
| Why | Before, the readers used `questions.type` live. A clone refresh that changed a type in the middle of an attempt mixed the rules (for example an MCQ attempt scored under another type). The type belongs next to the content it describes |
| Rejected | A snapshot of the type on `attempt_questions` only (the pool and the review pages would still read the live type). A view that joins both tables (it hides the problem and stores no fact). A NOT NULL column without a trigger (any old writer that omits the column would fail on insert) |
| Not included | No change to `questions.type` rules. No change to the frozen pool table `assessment_frozen_pool` (it keeps its own `type`). No reader outside 06, 07 and 09 |
| Impact | A new type needs both constraints, `questions_type_check` and `question_versions_type_check`. Production check after the migration: 169 rows, 0 NULL types, 0 rows where the version type differs from the question type |
| Rollback (only while no code depends on it) | `DROP TRIGGER question_versions_default_type ON question_versions`; `DROP FUNCTION question_versions_default_type()`; `ALTER TABLE question_versions DROP CONSTRAINT question_versions_type_check`; `ALTER TABLE question_versions DROP COLUMN type`; delete the `0156` row from `schema_migrations`. After the code at `94fdc4a` runs, revert the code first |

**Status:** open follow-ups (minor):

- `restoreVersion` can copy old content onto a row whose type has changed. Write `target.type` or reject the restore.
- Add a guard test that keeps `questions_type_check` and `question_versions_type_check` equal.

## Tenant purge: status `purged` and user tombstones (RW-48b, migration 0170, 2026-10-15)

| Item | Detail |
| --- | --- |
| What changed | `modules/02-tenancy/migrations/0170_tenant_purge.sql` widens `tenants_status_check` to `('active','suspended','archived','provisioning','purged')`. It changes nothing else |
| `purged` state | `purged` is a final state. `TenantStatus` in `modules/02-tenancy/src/types.ts` gains `"purged"`. `assertTenantActive` already rejects it |
| Purge job | `modules/02-tenancy/src/purge.ts` deletes the tenant rows of every public table with a `tenant_id` column. Exceptions: `audit_log`, `tenants`, `users`. Full design: [04-auth-flows.md](04-auth-flows.md) § "Tenant purge" |
| Users tombstone rule | A purged tenant keeps its `users` rows, pseudonymised with the same expressions as `modules/20-data-rights/src/erasure.ts` step 3. `name` and `email` become `deleted_user_<sha12>` and `deleted+<sha12>@erased.assessiq.local`. `metadata` loses `roll_number` and `branch`. `erased_at` is set |
| Why keep users | `audit_log.actor_user_id` has a foreign key to `users(id)`. The audit trail must survive. Dropping the foreign key would weaken the append-only rule, so the code keeps the rows |
| `audit_log` | Unchanged. No column, no constraint and no row is touched. The purge adds one `tenant.purged` row for each tenant |
| Rejected | An `archived_at` column (needs a trigger or a service edit; the job uses `updated_at`). A hand-written table list (stale after the next migration) |
| Not included | Purge of S3 or Redis data. Un-purge. A DB-level guard on the 180-day rule (the job enforces it) |
| Migration 0171 | `modules/16-help-system/migrations/0171_seed_rw45_account_security_help.sql` carries 9 `help_content` rows for the Account security page and the Reset two-factor menu item (`admin.account.security.*` and `admin.users.super.reset_totp`). It adds no table or column. Production help rows come from forward migrations, not from the seed file. Apply 0170 and 0171 by hand per [06-deployment.md](06-deployment.md) |

## S14 additions (2026-10-16)

*Type: reference.* Session S14 added migrations `0183` to `0188` and one JSON shape. Every migration is forward-only. Each block says what changed, why, what we rejected, what is not included, and the impact.

### Table `tenant_logos` (migration 0183, owner 02-tenancy)

| Item | Detail |
| --- | --- |
| What | New table. One row for each organisation. Columns: `tenant_id UUID PRIMARY KEY REFERENCES tenants ON DELETE CASCADE`, `mime TEXT` (CHECK `png` or `jpeg`), `bytes BYTEA`, `sha256 TEXT`, `width INT` and `height INT` (CHECK 32 to 2048), `byte_size INT` (CHECK 1 to 524288), `updated_by UUID NULL`, `updated_at TIMESTAMPTZ` |
| Size rule | `bytes` is at most 512 KB. The first 12 characters of `sha256` are the cache key in the public logo URL |
| RLS | Policies `tenant_isolation` and `tenant_isolation_insert` |
| Audit | `tenant.logo.updated` and `tenant.logo.removed`. The rows hold metadata only, never the image bytes |
| Why | The organisation logo shows on candidate pages, emails, the verify page, the OG image and the certificate PDF. A database row keeps the logo inside the tenant boundary and inside the tenant purge |
| `updated_by` has no foreign key | This is on purpose. Module-local test harnesses apply module 02 before `020_users`. A foreign key would break them. The audit row holds the actor |
| Rejected | An object store (new infrastructure for a file of 512 KB or less). SVG, GIF and WebP (SVG can carry script; the other two add decoder risk). A data URI in emails (Gmail clips messages over 102 KB and blocks `data:` images) |
| Not included | Logo history. Several logos for each organisation. Image resize on the server. Dark-mode variant |
| Impact | The catalog-driven tenant purge deletes the row, because the table has `tenant_id`. API: [03-api-contract.md](03-api-contract.md) § "S14 additions (2026-10-16)". Module notes: `modules/02-tenancy/SKILL.md` |
| Rollback | Drop the table after you remove the logo routes. Nothing else reads it |

### Column `questions.negative_marks` (migration 0184, owner 04-question-bank)

| Item | Detail |
| --- | --- |
| What | `negative_marks NUMERIC(6,2) NULL CHECK (negative_marks >= 0)` |
| Meaning | `NULL` means "use the assessment default". A number is the penalty for a wrong answer that the candidate did attempt |
| Scope | Deterministic types only. AI-graded types ignore the value. Rule detail: [05-ai-pipeline.md](05-ai-pipeline.md) § "Negative marking (EX-1)" |
| Version rule | The column is metadata. Changing it does not create a `question_versions` row |
| Rollback | Drop the column. Frozen copies on `attempt_questions` stay valid |

### Column `attempts.seen_at` (migration 0193, owner 06-attempt-engine)

**History:** added 2026-10-17 (Z-12).

- **What.** `seen_at timestamptz NULL` on `attempts`. NULL means the candidate has not opened the released result yet (the Results page shows a "New" chip). `POST /api/me/attempts/:id/seen` sets it once (`COALESCE(seen_at, now())`). RLS is unchanged (existing `attempts` policy).
- **Why.** The banner used notification read state, which the Results page cleared for all results at once. A per-attempt column gives a per-result marker.
- **Backfill.** Rows already `released` get `seen_at = COALESCE(evaluation_released_at, now())`, so old results do not all show "New". Only results released after this migration start as NULL.
- **Rejected.** A new table (not needed); per-notification read state (marks by kind, not by attempt).
- **Not included.** No index (read only in the per-candidate list). No erasure change: it is a timestamp, not personal data.

### Column `attempt_questions.negative_marks` (migration 0185, owner 06-attempt-engine)

| Item | Detail |
| --- | --- |
| What | `negative_marks NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (negative_marks >= 0)` |
| Freeze rule | The attempt start copies `COALESCE(questions.negative_marks, assessment default, 0)`. This is the same pattern as `attempt_questions.points` (migration `0128`) |
| No trigger | `DEFAULT 0` means "no penalty". An old attempt row therefore needs no backfill and no guard |
| Why | A later edit of a question or of the assessment default must not change a score that a candidate already earned |
| Rollback | Drop the column. The scoring code then reads no penalty |

### `assessments.settings.scoring.negative_marks_default` (JSONB, no migration)

- The key is an optional number from 0 to 1000. It lives in the `settings` JSON, under `scoring`.
- Absent means 0. The attempt start reads it only when the question has no value of its own.
- Known gap: the write route does not validate `settings.scoring`. Module 06 sanitises the value when it reads it, and the UI limits the input to 0 to 1000.

### `structured_case` step marks (no migration)

- This extends the content shape in § "Question type `structured_case`". Each item of `steps[]` may carry `points` (number above 0, at most 1000, default 1) and `negative_marks` (0 to 1000).
- `points` is a relative weight. It is not an absolute mark.
- When a step has no `negative_marks`, the penalty is the question `negative_marks` multiplied by the step `points`, divided by the question points.
- `scoring` (`all_or_nothing` or `partial`) and the 0/25/50/75/100 bands do not change.
- Rule detail: [05-ai-pipeline.md](05-ai-pipeline.md) § "Passage sets (EX-3)".

### Totals can be negative

- `attempt_scores.total_earned` and `attempt_scores.auto_pct` may be below 0 when an attempt has penalties.
- `gradings.score_earned` may be below 0. The column has no CHECK, so no migration was needed.
- The band, certificate and pass or fail code already handle negative values. The band clamps at read time, not at write time. See `modules/09-scoring/SKILL.md`.

### Column `tenant_plans.ai_answers_included_override` (migration 0186, owner 19-billing)

| Item | Detail |
| --- | --- |
| What | `ai_answers_included_override INT NULL CHECK (ai_answers_included_override >= 0)` |
| Meaning | The number of AI answers a tenant gets. The value is `ai_answers_included_override` when set, else the tier default `TIER_AI_ANSWERS_INCLUDED[tier]` |
| Write path | `PATCH /api/admin/super/tenants/:id/plan`, field `aiAnswersIncludedOverride` |
| Not included | The super list `getAllTenantUsage` still shows the tier default |

### Column `tenant_settings.ai_grading_scope` (migration 0188, owner 02-tenancy)

| Item | Detail |
| --- | --- |
| What | `ai_grading_scope TEXT NOT NULL DEFAULT 'written' CHECK (ai_grading_scope IN ('written','none'))` |
| Meaning | `written` allows AI grading of written answers. `none` blocks every AI call for the organisation |
| Write path | Super admin only. Audit action `tenant_settings.ai_grading_scope.updated` |
| Rollback | Set the value back to `written` |
| Impact | Tier order and the cap: [05-ai-pipeline.md](05-ai-pipeline.md) § "Least-AI tier order (P4)" |

### Purged user tombstone shape (LC-2)

The worker job `user-purge-cron` purges a user who was soft-deleted for 180 days or more. The `users` row stays as a tombstone, because `audit_log.actor_user_id` and `attempts.user_id` reference it.

| Column | Value after the purge |
| --- | --- |
| `name` | `deleted_user_<sha12>` |
| `email` | `deleted+<sha12>@erased.assessiq.local` |
| `metadata` | The old value without `roll_number` and `branch` |
| `status` | `disabled` |
| `erased_at` | Set |
| `deleted_at` | Kept |

- The job deletes rows in every table with an `ON DELETE CASCADE` foreign key to `users(id)`. The code finds them from `pg_constraint`. At the time of writing they are `sessions`, `oauth_identities`, TOTP data, recovery codes and `candidate_login_tokens`.
- The job also deletes the user's `in_app_notifications` and any `user_invitations` for the same email in the same tenant.
- The job keeps `attempts`, `gradings`, `assessments`, `certificates`, consent events and audit rows.
- This is the same pseudonym pattern as the tenant purge (migration `0170`) and `modules/20-data-rights/src/erasure.ts`. The person cannot be restored after the purge.
- Behaviour and skips: `modules/03-users/SKILL.md` § "User purge (LC-2, S14, 2026-10-16)".

### Other migrations in S14

- `0187` (module 16): 20 help rows, including `admin.tenant_settings.page` version 2 (logo bullet). No table change.

## Change history

This table indexes every dated change on this page. The sections above hold the detail. Order: by date, then by migration.

| Date | Change | Migration or commit | Section |
| --- | --- | --- | --- |
| 2026-05-01 | Tenancy tables live. `tenant_id` added to `oauth_identities`, `user_credentials`, `totp_recovery_codes`. Question bank live (6 tables) | `0001`, `0003`, `010`, `012`, `013`, `0010`-`0015` | Tenancy; Users & auth; Question bank |
| 2026-05-01 | `attempt_scores` live | `0050_attempt_scores.sql` | `attempt_scores` |
| 2026-05-02 | Assessment lifecycle live. Attempts live (2026-05-02). `help_content` live | `0020`-`0022`; `0030`-`0033`; `0010_help_content.sql` | Assessment lifecycle; Attempts; Audit, notifications, help |
| 2026-05-03 | Grading redesign: `gradings`, `tenant_grading_budgets` | `0040`, `0041`; `7eea75b` | Grading & scoring |
| 2026-05-03 | Embed SDK columns on `tenants`, `sessions`, `attempts` | `0070`-`0073` | Module → tables map |
| 2026-05-09 | `generation_attempts` live | `0042`, `0043`; `f449203` | `generation_attempts` |
| 2026-05-10 | `tenant_settings.ai_generate_mode` | `0044` | `ai_generate_mode` |
| 2026-05-11 | `certificates` scaffolded | `0046` | 18-certification |
| 2026-05-13 | `candidate_login_tokens`. Certificate verify-page RLS | `0076`; `0074`, `0075` | `candidate_login_tokens`; 18-certification RLS |
| 2026-05-17 | `tenant_plans`, `billing_events`, backfill. Plan mutation (A2). `tenants.status` adds `provisioning` | `0078`-`0080`; `111dd77`; `66ea0ff`; `0077` | 19-billing |
| 2026-05-18 | `tenant_entitlements` (B1) and publish-time enforcement (B2) | `0081`, `0082`; `2ba822d`, `9f073a5`; `5c80aaa` | `tenant_entitlements` |
| 2026-05-22 | Platform taxonomy seed | `0083` | Question bank |
| 2026-05-23 | Clone provenance and uniqueness. Question difficulty tags | `0084`, `0085`; `0086` | Question bank |
| 2026-05-24 | Domain slug normalization | `0090` | Question bank |
| 2026-05-25 | Platform domain provenance. Clone version snapshots and re-sync. `assessment_frozen_pool` | `0091`; `0095`; `0096` | Question bank; Attempts |
| 2026-05-29 | Data-rights: `consent_events`, `users.erased_at`, `retention_days`, audit PII backfill. `attempts.ai_proposals` and `grading_started_at` | `0101`-`0104`; `0100` | Module 20; Attempts |
| 2026-06-01 | `generation_attempts.batch_id` | `0106` | `generation_attempts` |
| 2026-10-01 | Scoring and result release. Roll number, branch and integrity settings. Invitations, option shuffle, notification RLS. MV released-only | `0113`, `0114`, `0117`, `0119`, `0121`, `0122`; `1a4f82d`, `0d9999e` | Scoring and result release; Invitations, notifications and option shuffle; `attempt_summary_mv` |
| 2026-10-02 | Types `numeric`, `multi_select`. Batch 3: `attempt_questions.points`, notification UPDATE policy, webhook `failed`. Batch 4: sections, `reminded_at`. Batch 5: views, `generation_batches`, `high_stakes` | `0126`-`0129`; `0132`, `0134`; `0136`-`0142` | Question types numeric and multi_select; Batch 3; Batch 4; Batch 5 |
| 2026-10-03 | Types `ordering`, `structured_case`. Migration numbering facts. Help ids under page prefix. Question type frozen per version. `gradings` index `0150` | `0144`; `0152`; `0155`; `0156`; `0150` | Question type sections; Migration numbering facts; Migration 0155; Migration 0156 |
| 2026-10-06 | `billing_events` second meter and monthly window. `smtp_config` shape facts. Retention table | `0160` | `billing_events`; Assessment lifecycle; `tenant_settings.retention_days` |
| 2026-10-11 | Question type registry and per-type behaviour. Curriculum frameworks. `withSystemRole`. Post-migration seeds. Migration lint. `gradings` provenance columns | `0167`; `0169`; `66a7c50`; `9badb1d`; `0168` | Question type registry; Curriculum frameworks; System-role transactions; Post-migration seeds |
| 2026-10-15 | Tenant purge and user tombstones. Migration lint R5. Help rows for account security | `0170`, `0171` | Tenant purge |
| 2026-10-15 | Help row for the Curriculum frameworks section (RW-57 part 2) | `0173` | Question import |
| 2026-10-16 | Question import: `question_imports`, `question_import_rows`, `question_packs.source`, `question_packs.import_file_sha256` (RW-58). Help rows for the import page | `0174`; `0175` | Question import |
| 2026-10-16 | Role CHECKs on `users`, `sessions`, `in_app_notifications` drop `reviewer` (Y-1), one file per owning module. `help_content.audience` keeps it (RW-2) | `0179` (03-users), `0180` (01-auth), `0181` (13-notifications) | Users; Auth sessions; Notifications |
| 2026-10-16 | S14: tenant logos, negative marking columns, plan AI override, AI grading scope, help rows, user purge tombstone | `0183`; `0184`; `0185`; `0186`; `0187`; `0188` | S14 additions |
| 2026-10-17 | EXP-4 import v2: help rows for the import page (no schema change) | `0195` | Import v2 writes |
| 2026-10-17 | Z-16: per-assessment pass mark. `assessments.passing_score_pct` (SMALLINT, 1 to 100, default 60, backfilled once from `levels.passing_score_pct`) and `attempt_scores.pass_mark_pct` (snapshot of the mark at first score write, never updated by a re-score, backfilled from the assessment). Help row in `0200` (module 16). Why: one pass rule per assessment, and old results must not change when an assessment is edited. Rejected: reading `levels.passing_score_pct` at read time (a level edit would rewrite history). No new table, no FK, RLS unchanged | `0198` (05), `0199` (09), `0200` (16) | Tables `assessments`, `attempt_scores` |
| 2026-10-18 | Z-39: retake policy. `assessments.max_attempts` (SMALLINT, NULL or 1 = no retake, 2 to 10 = attempts allowed, CHECK 1..10), `assessment_invitations.extra_attempts` (SMALLINT 0..10, admin grants), `attempts.attempt_number` (SMALLINT, default 1) and the unique key on `attempts` changes from `(assessment_id, user_id)` to `(assessment_id, user_id, attempt_number)`. Two files carry number `0203` because each is owned by one module and a module-local test harness must not need another module's table: `0203_assessments_max_attempts.sql` (module 05) and `0203_attempts_attempt_number.sql` (module 06); they do not depend on each other. Why: owner decision 2026-10-17 (the organisation admin sets the maximum number of attempts); the unique key makes the limit race-proof, because two simultaneous starts compute the same next number and the second INSERT fails. Considered and rejected: a separate attempt-group table, a counter column on the invitation (a second source of truth), a global retake setting. Not included: cooling-off timers, paid retakes, a different question draw per retake, a per-candidate extra-attempt table (the counter plus one audit row per grant is enough). Downstream: 05 (`grantExtraAttempt`, `reopenInvitationForRetake`), 06 (`startAttempt` with `newAttempt`), 18 (one certificate per assessment and candidate), 15 and 07 readers that join `attempts` on `(assessment_id, user_id)` now see one row per attempt. Forward-only, existing rows are attempt 1. | `0203` | Reads of one attempt per candidate must pick the attempt (latest or best) |
| 2026-10-17 | S15: materialized view `question_stats_mv` for per-question statistics (RW-60 / FU-C14) | `0189` | Materialized view — `question_stats_mv` |
| 2026-10-17 | S15: column `tenant_settings.result_feedback_level` for per-question candidate feedback (RW-80). Help rows come in `0191` (module 16) | `0190` | Table `tenant_settings`, column `result_feedback_level` |
| 2026-10-18 | Z-50: column `tenant_settings.certificate_show_distinction` (boolean, default false). What: an organisation switch for the word Distinction on certificates. Why: the owner decided that every pass earns a certificate and the Distinction wording is the organisation's choice. Considered and rejected: a column on `certificates` (would force a re-sign), a per-assessment setting (the owner chose per organisation), a JSON key in `features` (no CHECK, no typed read). NOT included: an honors tier, a tier upgrade, a change to issued rows. Downstream: module 18 reads it through `getCertificateShowDistinction`; docs/03, docs/14 | `0205` | Table `tenant_settings`, column `certificate_show_distinction` |
### Exam blueprints (EXP-6, migration 0201, 2026-10-17)

Migration `modules/04-question-bank/migrations/0201_exp6_exam_blueprints.sql`.

| Item | Detail |
| --- | --- |
| What | `exam_blueprints` (id, `stage_node_id` FK `taxonomy_nodes` ON DELETE SET NULL, `edition`, `name`, `total_minutes`, `qualifying`, `verification_status` `verified` or `unverified` NOT NULL, `source_note`). `exam_blueprint_sections` (position, name, `subject_node_id` nullable, `question_count` >= 1, `marks_per_question` >= 0, `negative_marks_per_question` 0..marks, `minutes` nullable, `sectional_timing`, `qualifying`, `cutoff_marks` nullable, `calculator_allowed`, `allowed_types` text[]). Unique (stage, edition) when stage is set. Seed: SSC CGL Tier 1, edition `current`, verified by the owner on 2026-10-17: 4 sections of 25 (Reasoning, General Awareness, Quantitative Aptitude (Quant), English), 2 marks, 0.5 negative, 60 minutes in total, no sectional timing, qualifying, MCQ only, no calculator, `cutoff_marks` NULL |
| RLS | **No `tenant_id` column, on purpose.** `taxonomy_nodes` mixes platform and tenant rows. A blueprint is platform data only, so both tables have RLS on and one SELECT policy (`platform_read`; the child policy checks the parent). The app role has **no** insert, update or delete policy, so a tenant session can never write. Writes run as `assessiq_system` from super-admin routes and are audited in the same transaction. `pnpm lint:rls` has nothing to match (no `tenant_id`, not a JOIN table) |
| Seeding | Fixed ids and `ON CONFLICT DO NOTHING`: running the file again changes nothing. The stage and subject node ids are looked up in the platform frameworks `exam-structure` and `subject-map`. The seed frameworks load by a super-admin click, not by a migration, so on a fresh database the ids stay NULL and a super admin sets them with `PUT`. Never invent them |
| Considered and rejected | `tenant_id` plus the taxonomy 4-policy shape (allows tenant-owned blueprints that nobody asked for). A `total_questions` column (derived, cannot drift). A cutoff value in the seed (cutoffs change every year) |
| Not included | Any other exam, UI, normalisation across shifts, rank prediction |
| Rollback | Drop `exam_blueprint_sections` then `exam_blueprints`. Assessments already made from a blueprint keep their `settings` (they hold copies, not references) |

### Whole-test timer and marks per question (Z-42, no migration, 2026-10-18)

New optional keys in `assessments.settings` (JSONB). No column, no table, so migration 0204 was not needed.

| Item | Detail |
| --- | --- |
| What | `settings.whole_test_minutes` (integer 1 to 600): ONE timer for the whole test. With it, no section may carry `minutes` and the candidate moves freely between sections. Without it every section needs `minutes` (one section at a time, unchanged). `sections[].minutes` is now optional in the schema; the rule "all or none" lives in `sectionTimingProblem` (module 05 `types.ts`). `sections[].marks_per_question` and `sections[].negative_marks_per_question` (0 to 1000): at attempt start module 06 writes them into `attempt_questions.points` and `attempt_questions.negative_marks` for every question of that section. |
| Why | A real exam such as SSC CGL Tier 1 has one 60-minute timer and 2 marks per question with 0.5 lost per wrong answer. Section totals must match the notice (25 x 2 = 50 per section, 200 total). |
| Frozen once | The marks are copied into `attempt_questions` in the same INSERT that freezes the question version. Later edits to `settings` (only possible on a draft anyway) or to `questions.points` do not move a started attempt. Module 09 already reads only the frozen columns. `ends_at` is stored at start from the server clock and is the only deadline in whole-test mode. |
| Rules | A section with `marks_per_question` ignores the question's own `points` and `negative_marks`; its penalty is `negative_marks_per_question`, or 0 when absent. A section without `marks_per_question` and every assessment without sections score exactly as before (bank points, own penalty, else `scoring.negative_marks_default`). `questions.points` in the bank is never changed. |
| Considered and rejected | A new column on `attempts` for the mode (the setting is read from `settings`, like `sections`). Scaling by a factor of the bank points (two questions with different points would not total to the blueprint). Splitting the minutes evenly (it never matched the real exam). |
| Not included | Grouped section tabs on the take page in whole-test mode (the page shows one list of all questions with one timer), sectional timing mixed with whole-test timing, normalisation across shifts, rank prediction. |
| Rollback | Remove the keys from `settings` of draft assessments. Started attempts keep their frozen marks. |

### Publish review gate on `questions.review_state` (EXP-18, 2026-10-18)

| Item | Detail |
| --- | --- |
| What | No schema change. `publishAssessment` reads `questions.review_state` for active questions of the assessment's (pack, level). `in_review`, `disputed`, `needs_fix` block publish (`QUESTIONS_NOT_VERIFIED`). NULL and `verified` pass. |
| Why | Owner rule D6: no student invited before review. NULL passes because 0194 grandfathered active questions as verified and no write path sets a state yet. |
| Not included | Moved to the next section (EXP-18 part 2): verify actions, review screen, audit rows, import state. |

### Review actions, import state and invite gate (EXP-18 part 2, 2026-10-18)

| Item | Detail |
| --- | --- |
| What | No schema change and no migration. The column `questions.review_state` (migration 0194) now has writers. (1) Verify sets `verified`. (2) Needs fix sets `needs_fix` and needs a note. (3) Withdraw archives the question and sets `question_source.rights_status = 'withdrawn'`. (4) Bulk "Verify all" sets every `in_review` question of one question set to `verified`. (5) Every import (file import commit and JSON bulk import) inserts questions as `in_review`. (6) A clone keeps the state of its source. (7) Invitations are blocked like publish. |
| Why | Owner rule D6 (EXP-0): a wrong answer key must not reach a candidate. Part 1 added the publish block, but nothing set a state. Part 2 adds the writers and the invite block, so an unverified question cannot reach a candidate by a second route. |
| Owner decisions applied | An EMPTY (NULL) state still passes publish and invite for existing platform questions (no backfill). Every new import starts as `in_review`. Clones keep the source state. |
| State rules | Verify is allowed from `in_review`, `needs_fix`, `disputed` and NULL; a repeat on a `verified` question changes nothing and writes no audit row. Needs fix is allowed from any state except withdrawn. A withdrawn question cannot be verified or flagged (`409 QUESTION_WITHDRAWN`). Bulk verify changes only `in_review`; `needs_fix` and `disputed` need a look at each question. Nothing sets `disputed` yet. |
| Audit | Action `question.review_changed` (module 14 catalog), one row per question: `actor_user_id`, time (`at`), `before.review_state` (previous state, `null` allowed), `after.review_state`, `after.action`, `after.note` (Needs fix), `after.bulk` (true for bulk verify, with `after.pack_id`). Withdraw keeps the action `question.withdrawn`; its `before` now also carries `review_state`. Bulk verify writes one row for each question, not one summary row, so the history of each key stays complete. |
| Write paths | `service/review.ts` (new) writes `review_state` with a conditional `UPDATE` after a `SELECT ... FOR UPDATE` of the question rows in id order. `insertQuestion` takes `reviewState`; `import/commit.ts` and `bulkImport` pass `in_review`. `createQuestion` (one question by hand) and AI drafts still insert NULL. The generic `updateQuestion` route cannot write `review_state`. |
| Race rule | Review writes lock rows `FOR UPDATE` in id order. Module 05 locks the pool rows `FOR SHARE` in id order at publish and invite. A review write that is open while an assessment publishes makes the publish wait; it then reads the new state. `publishAssessment` also re-checks the rows that the freeze captured, in the same transaction. |
| Considered and rejected | (a) A `review_note` column (needs migration 0206 and test-harness changes): the note lives in the audit row. (b) Resetting `review_state` when a question is edited: not in the contract, so a verified question that is edited keeps its state (open point, see Not included). (c) Setting `in_review` in `createQuestion`: it would block every test fixture and every hand-authored platform question; EXP-17 sets it on organisation upload. (d) One summary audit row for bulk verify: loses the per-key history. (e) Blocking NULL: owner decision says it passes. |
| Not included | Organisation upload (EXP-17: it must pass `reviewState: 'in_review'` and origin `tenant_upload`). Reset of `review_state` after a content edit. Setting `disputed`. Showing the Needs fix note on the question editor. Two-person review. Gating `reopenAssessment` (its freeze is a no-op). |
| Downstream impact | Module 14: new action `question.review_changed`. Module 05: `publishAssessment`, `inviteUsers`, `resendInvitation`, `resendInvitations` and `reopenInvitationForRetake` refuse with `QUESTIONS_NOT_VERIFIED`. Module 10: new page `/admin/question-bank/:id/review`. Module 16: 6 help ids. Imported question sets now need a review before an assessment can publish. Clone and re-sync copy the state as before. |
| Rollback | Revert the code. No data change is needed: the state column and its values stay valid. Questions already set to `in_review` by an import stay `in_review` and need a Verify. |

## Passages (EXP-8, migrations 0211 and 0213, 2026-10-19)

A passage is shared stem text used by several question rows (reading text, data set, logic set).

| Item | Detail |
| --- | --- |
| `passages` (0211, module 04) | `id`, `tenant_id` (FK tenants), `title` NULL, `body` TEXT NOT NULL (plain text, rendered like a stem), `language`, `source_passage_id` (clone provenance), `created_at`. RLS: `tenant_isolation` plus `tenant_isolation_insert`, same as `question_source` |
| Immutable | A `BEFORE UPDATE` trigger rejects a change of `body`, `title`, `language` or `tenant_id`. To change a passage, insert a new row and repoint the questions. No tenant policy allows a delete that matters: `questions.passage_id` is `ON DELETE RESTRICT` |
| `questions.passage_id`, `questions.passage_position` (0211) | Nullable. `passage_position` orders the children inside a passage (NULL sorts last, then `created_at`, then `id`). No backfill |
| `attempt_questions.passage_id` (0213, module 06) | UUID, no FK on purpose (module-local harness). Frozen at attempt start by the same INSERT that freezes the question version. Immutable passages make the id a freeze of the text |
| Clone and re-sync | `copyQuestionSource` also copies the passage once per target tenant (unique on `(tenant_id, source_passage_id)`) and keeps `passage_position`. Re-sync copies it for NEW master questions only |
| Not included | Images in passages (EXP-10), AI-graded passages, a passage edit screen, `has_passage` list filter, re-sync of a changed passage link on an existing clone |

## Question review notes and Dispute (Z-52 gaps 6 and 7, migration 0214, 2026-10-19)

| Item | Detail |
| --- | --- |
| What | Migration `modules/04-question-bank/migrations/0214_z52_question_review_notes.sql` adds the append-only table `question_review_notes`: `id`, `tenant_id` (FK tenants), `question_id` (FK questions, `ON DELETE CASCADE`), `version` (question version when the note was written), `state` (`in_review`, `verified`, `disputed`, `needs_fix`, `withdrawn`), `note` (1 to 1000 characters after trim), `author_user_id` (plain UUID), `created_at`. Indexes: `(question_id, created_at DESC)` and `(tenant_id)`. Every review action (verify, needs fix, dispute, withdraw) that carries a note inserts one row in the same transaction. |
| Why | Reviewer notes lived as free text in `audit_log.after.note`. Audit rows must hold ids only, a question page could not show the note, and disputes (EXP-12) need the history. The audit row now carries `note_id` (`question.review_changed` and `question.withdrawn`); the text is never in `audit_log`. |
| `author_user_id` has no FK | The user purge (`modules/03-users/src/purge.ts`) keeps the `users` row as a tombstone and deletes only tables with a cascading FK to `users(id)`. A plain UUID is never touched, so a purge cannot fail on this table. It also keeps module-local test harnesses simple. |
| RLS and append-only | `ENABLE` and `FORCE` row level security. Policies: `tenant_isolation` (`FOR SELECT`) and `tenant_isolation_insert` (`FOR INSERT`), both `tenant_id = current_setting('app.current_tenant')`. No UPDATE or DELETE policy. `UPDATE`, `DELETE`, `TRUNCATE` are revoked from `assessiq_app` (note: `assessiq_app` inherits `assessiq_system`, so RLS is the real barrier: an UPDATE or DELETE as the app role changes 0 rows). A `BEFORE UPDATE OR DELETE` trigger rejects every UPDATE and every DELETE except by `assessiq_system` or a superuser. That exception keeps the tenant purge (`modules/02-tenancy/src/purge.ts`, deletes every table with `tenant_id` as `assessiq_system`) and test cleanup working. |
| Dispute | New review action `dispute` sets `questions.review_state = 'disputed'`; a note is required. A Disputed PLATFORM master reaches tenant clones in the same transaction like Needs fix (`service/review.ts` `propagateBlock`); audit text `disputed_propagated`, ids only. The module 05 gate already blocks every state except `verified` and NULL. No score or band changes. |
| Considered and rejected | A `review_note` column on `questions` (loses history). Keeping the note in the audit row (free text in audit). A FK on `author_user_id` (purge risk). `UPDATE` by the owner role stays possible only by dropping the trigger (a deploy event). |
| Not included | Edit or delete of a note, notes on packs, a UI, candidate-raised disputes, notes on clones of a platform master (a tenant cannot read platform rows), backfill of old audit text (old rows keep their `note` key; no rewrite of audit). |
| Downstream impact | Module 04 routes `GET /api/admin/review-queue` and `GET /api/admin/questions/:id/review-notes` (see `docs/03-api-contract.md`). Module 14: no change (`question.review_changed` and `question.withdrawn` keep their action names; only the `after` payload changed). Module 05: no change. |
| Rollback | Revert the code first, then `DROP TABLE question_review_notes` (the trigger function `question_review_notes_append_only` can be dropped too). Audit rows keep only `note_id`, so the note text is lost on drop. |

## Z-93 credit ledger and Mock/Real delivery mode (migrations 0215, 0216, 0217)

| Item | Detail |
| --- | --- |
| New table `credit_grants` (0215, module 19) | `id`, `tenant_id`, `source` (`purchase`, `free_monthly`, `bonus`, `pilot`), `credits`, `remaining` (0 to `credits`), `granted_at`, `expires_at` (NOT NULL), `invoice_ref`, `note`, `created_by`, `created_at`. RLS: select and update by tenant; insert by the app role only for `source = 'free_monthly'` (new-tenant provisioning). The app role may UPDATE only the `remaining` column (column grant); no DELETE. Purchase, bonus and pilot grants are written under the system role. Partial unique index on `(tenant_id, UTC month of granted_at)` where `source = 'free_monthly'` makes the monthly refill idempotent. |
| New table `credit_burns` (0215, module 19) | `id`, `tenant_id`, `attempt_id` (FK `attempts`, ON DELETE CASCADE), `grant_id` (first grant used, NULL when no grant covered it), `credits` (full cost), `shortfall` (part no grant covered), `test_type` (`mock`, `real`, `real_camera`), `burned_at`. `UNIQUE (tenant_id, attempt_id)`. Append-only: UPDATE, DELETE, TRUNCATE revoked from `assessiq_app`. |
| Backfill (0215) | One grant per tenant plan with finite `included_credits`: source `free_monthly` for tier free, `pilot` otherwise; `remaining` = allowance minus graded attempts in the current cycle window; expires in 12 months. Tenants with `included_credits` NULL (unlimited) get no grant and never burn. |
| `assessments.delivery_mode`, `assessment_invitations.delivery_mode` (0216, module 05) | TEXT NOT NULL DEFAULT `'real'`, CHECK in (`real`, `mock`). Data only: no code reads it yet (Z-89). |
| `attempts.delivery_mode`, `attempts.camera_enabled`, `attempts.readiness` (0217, module 06) | `delivery_mode` as above; `camera_enabled` BOOLEAN NOT NULL DEFAULT false; `readiness` JSONB NULL (result of the pre-test device check). Existing rows become `real`, which is correct. |
| Why | One balance with expiry replaces the monthly counter for pay-per-credit plans; the burn is a ledger row so the balance can be audited and rebuilt. |
| Considered and rejected | A single `balance` column on `tenant_plans` (no expiry, no audit trail, and the app role has no UPDATE on that table). Burn rows per grant (the unique key is one row per attempt, so a split is stored as the first grant plus the total). Refusing grading when the balance is short (grading must never fail; the shortfall is recorded instead). |
| Not included | Prices, invoices, payment, low-balance e-mail, rollover of free credits, refunds, any code that reads `delivery_mode` (Z-89 UI and rules). |
| Downstream impact | `recordGradedAttempt` (module 19) burns in the same transaction as the grade. `GET /api/billing/usage` gains a `credits` object. `erasure-coverage.test.ts` exempts `credit_grants.note`. Audit action `billing.credits_granted` added to the catalog. |
| Rollback | Revert the code first. Then `DROP TABLE credit_burns, credit_grants` and drop the new columns; the credit data is lost. |

## Z-71 (2026-10-20): `tenant_candidate_counted` (migration 0222, module 19)

| Item | Detail |
| --- | --- |
| Table | `tenant_candidate_counted(tenant_id uuid NOT NULL REFERENCES tenants ON DELETE CASCADE, user_id uuid NOT NULL, counted_at timestamptz DEFAULT now(), PRIMARY KEY (tenant_id, user_id))`. No FK on `user_id` on purpose: erased and deleted candidates stay counted. |
| RLS | SELECT and INSERT policies on `app.current_tenant`. `REVOKE UPDATE, DELETE, TRUNCATE` from `assessiq_app`: the table is append-only, so a delete never lowers the count. |
| Backfill | One row for every existing `users` row with `role = 'candidate'` (soft-deleted and erased included). Idempotent (`ON CONFLICT DO NOTHING`). |
| Why | The Free plan cap of 5 candidates was a check then act count of `users` rows. Two parallel creates at count 4 both passed. `countCandidateOrRefuse` (module 19) now takes a per-tenant advisory lock, inserts the user id once, counts the rows and throws `TIER_LIMIT_REACHED` above the cap, inside the transaction that creates the user. A refusal rolls back both rows. |
| Rejected | A row-count check only (race stays). `SELECT ... FOR UPDATE` on `tenant_plans` (the app role has no UPDATE policy there). A lock-free counter column (needs UPDATE rights and a decrement rule). |
| Not included | The AI-attempt allowance guard. The admins cap. |
| Rollback | Revert the code, then `DROP TABLE tenant_candidate_counted`. The cap falls back to `assertCandidateTotalCap` (racy). |
