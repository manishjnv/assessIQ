# 01-auth migrations — schema sketches for Window 4

> This directory will hold six SQL migrations created in Window 4 (G0.C Session 4 per `docs/plans/PHASE_0_KICKOFF.md`). Each migration corresponds to one auth-owned table per `docs/02-data-model.md` and the decisions captured in `modules/01-auth/SKILL.md` § Decisions captured (2026-05-01).
>
> **Scope:** sketches only. The actual SQL is Window 4's deliverable. These sketches lock the column set, RLS posture, and FK shape so that the codex:rescue gate focuses on logic (auth flows, signature verification, token lifecycle) rather than schema drift.
>
> **Out of scope here.** `user_invitations` is owned by 03-users and lands as `modules/03-users/migrations/021_user_invitations.sql` per PHASE_0_KICKOFF G0.C-5.

## Migration order

Numbered to land after 02-tenancy's `0001`–`0003` (`tenants`, `tenant_settings`, RLS helpers + tenants RLS). 01-auth uses the `010+` block to leave clear room for 03-users (`020+`) without renumbering later.

| File | Table | `02-data-model.md` lines |
| --- | --- | --- |
| `010_oauth_identities.sql` | `oauth_identities` | 105–114 |
| `011_sessions.sql` | `sessions` | 145–157 |
| `012_totp.sql` | `user_credentials` | 116–123 |
| `013_recovery_codes.sql` | `totp_recovery_codes` | 125–131 |
| `014_embed_secrets.sql` | `embed_secrets` | 173–182 |
| `015_api_keys.sql` | `api_keys` | 159–171 |

Every table carries a direct `tenant_id UUID NOT NULL REFERENCES tenants(id)` column and the standard two-policy RLS template, even on tables `02-data-model.md` originally listed without `tenant_id`. See `01-auth/SKILL.md` § "Schema deviations from 02-DATA requested in same PR" for the rationale.

## Schema sketches

### `010_oauth_identities.sql`

Creates `oauth_identities` linking external IdP subjects (Google `sub` today; Microsoft / Okta / SAML / generic OIDC in Phase 2+) to AssessIQ `users`. Columns: `id` (uuid v7, app-generated), `tenant_id` (uuid, FK `tenants(id)`, NOT NULL — denormalized from `users.tenant_id` for RLS), `user_id` (uuid, FK `users(id) ON DELETE CASCADE`), `provider` (text CHECK IN `'google','microsoft','okta','saml','custom_oidc'`), `subject` (text — the IdP `sub` claim), `email_verified` (bool default false), `raw_profile` (jsonb), `linked_at` (timestamptz default now()). `UNIQUE (provider, subject)` — global; one IdP identity = one AssessIQ user across all tenants. Apply two-policy RLS template per `02-data-model.md:533–542`. Source: `02-data-model.md:105–114`.

### `011_sessions.sql`

Creates `sessions` — Postgres durable mirror of the Redis session cache. Columns: `id` (uuid v7), `user_id` (FK), `tenant_id` (FK — already specified in source), `role` (text CHECK IN `'admin','reviewer','candidate'`, NEW vs `02-data-model.md` to support role-discriminated middleware without a join), `token_hash` (text NOT NULL UNIQUE — sha256 hex of cookie value), `totp_verified` (bool default false), `ip` (inet), `user_agent` (text), `expires_at` (timestamptz NOT NULL), `last_seen_at` (timestamptz default now()), `last_totp_at` (timestamptz), `created_at` (timestamptz default now()). Index `sessions (user_id, expires_at)`. Apply RLS template. Source: `02-data-model.md:145–157`. Deviation: adds `role` column + `last_totp_at` for step-up MFA; both fields appear in the SKILL.md decision §1 Redis schema and need to round-trip through Postgres.

### `012_totp.sql`

Creates `user_credentials` (per-user secret material). Columns: `user_id` (uuid, PK, FK `users(id) ON DELETE CASCADE`), `tenant_id` (uuid, FK `tenants(id)`, NOT NULL — denormalized from `users.tenant_id` for RLS), `totp_secret_enc` (bytea — AES-256-GCM envelope of a **20-byte** SHA-1 TOTP secret per SKILL.md decision §3), `totp_enrolled_at` (timestamptz), `totp_last_used_at` (timestamptz), `password_hash` (text — argon2id, used only when password auth enabled in Phase 3+), `password_set_at` (timestamptz). Apply RLS template. Source: `02-data-model.md:116–123`.

### `013_recovery_codes.sql`

Creates `totp_recovery_codes` — one row per generated recovery code. Columns: `id` (uuid v7), `tenant_id` (uuid, FK `tenants(id)`, NOT NULL — denormalized for RLS), `user_id` (uuid, FK `users(id) ON DELETE CASCADE`), `code_hash` (text NOT NULL — argon2id digest of the 8-char Crockford base32 code per SKILL.md decision §2), `used_at` (timestamptz NULL — atomic single-use marker), `created_at` (timestamptz default now()). Partial index `(user_id) WHERE used_at IS NULL` for fast "live codes for user X" lookup. Apply RLS template. Source: `02-data-model.md:125–131`.

### `014_embed_secrets.sql`

Creates `embed_secrets` — per-tenant signing secrets for embed JWTs. Columns: `id` (uuid v7), `tenant_id` (uuid, FK `tenants(id)`, NOT NULL — already specified in source), `name` (text — admin-visible label), `secret_enc` (bytea NOT NULL — AES-256-GCM envelope of the HS256 signing key), `algorithm` (text default `'HS256'` — informational; verify path hard-codes `["HS256"]` per SKILL.md decision §5), `status` (text CHECK IN `'active','rotated','revoked'`, default `'active'`), `rotated_at` (timestamptz NULL — set when admin clicks rotate, kicks off 90-day grace), `created_at` (timestamptz default now()). Index `(tenant_id, status)` for the verify-path lookup. Apply RLS template. Source: `02-data-model.md:173–182`.

### `015_api_keys.sql`

Creates `api_keys` — server-to-server authentication tokens. Columns: `id` (uuid v7), `tenant_id` (uuid, FK `tenants(id)`, NOT NULL — already specified in source), `name` (text), `key_prefix` (text NOT NULL — first 12 chars `aiq_live_xyz` for admin display), `key_hash` (text NOT NULL UNIQUE — sha256 hex of the full key per SKILL.md decision §6), `scopes` (text[] NOT NULL — see `04-auth-flows.md:238–244` scope catalog), `status` (text default `'active'`), `last_used_at` (timestamptz — async-updated, fire-and-forget), `created_by` (uuid, FK `users(id)`), `created_at` (timestamptz default now()), `expires_at` (timestamptz NULL). Index `(tenant_id, status)`. Apply RLS template. Source: `02-data-model.md:159–171`.

## Acceptance criteria for Window 4

- All six migrations apply cleanly to a fresh Postgres 16 in dependency order (after 02-tenancy's `0001`–`0003`).
- `tools/lint-rls-policies.ts` passes — every table with `tenant_id` has both `tenant_isolation` and `tenant_isolation_insert` policies.
- The cross-tenant isolation testcontainers suite (Window 2's pattern at `modules/02-tenancy/__tests__/`) extends to cover at least one query per new table.
- No raw `tenant_id = $1` filters in repositories — RLS is the enforcement layer (rule per `modules/02-tenancy/SKILL.md`).
- codex:rescue adversarial review accepts the migration + middleware + JWT verify diff before push.
