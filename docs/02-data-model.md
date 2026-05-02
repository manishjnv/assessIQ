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
| 01-auth | `sessions`, `api_keys`, `embed_secrets`, `oauth_identities`, `totp_recovery_codes` |
| 04-question-bank | `question_packs`, `levels`, `questions`, `question_versions`, `tags`, `question_tags` |
| 05-assessment-lifecycle | `assessments`, `assessment_invitations` |
| 06-attempt-engine | `attempts`, `attempt_questions`, `attempt_answers`, `attempt_events` |
| 07-ai-grading | `grading_jobs`, `prompt_versions` |
| 08-rubric-engine | `rubrics`, `anchors` (per-question rubrics live denormalized inside `questions.content`) |
| 09-scoring | `gradings`, `attempt_scores`, `archetypes` |
| 13-notifications | `webhook_endpoints`, `webhook_deliveries`, `email_log` |
| 14-audit-log | `audit_log` |
| 16-help-system | `help_content` |

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
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenant_settings (
  tenant_id           UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  auth_methods        JSONB NOT NULL DEFAULT '{"google_sso":true,"totp_required":true}'::jsonb,
  ai_grading_enabled  BOOLEAN NOT NULL DEFAULT true,
  ai_model_tier       TEXT NOT NULL DEFAULT 'standard' CHECK (ai_model_tier IN ('basic','standard','premium')),
  features            JSONB NOT NULL DEFAULT '{}'::jsonb,   -- feature flags
  webhook_secret      TEXT,                                  -- for outgoing webhooks (encrypted)
  data_region         TEXT DEFAULT 'in',                     -- for future multi-region
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

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
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id, expires_at);

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

## Question bank

> **Status: live as of 2026-05-01 (Phase 1 G1.A Session 1).** Migrations at `modules/04-question-bank/migrations/`: `0010_question_packs.sql` (standard tenant_id RLS), `0011_levels.sql`, `0012_questions.sql`, `0013_question_versions.sql`, `0014_tags.sql` (`tags` standard + `question_tags` JOIN-based), `0015_questions_level_pack_fk.sql` (defense-in-depth composite FK). All 6 tables on production `assessiq-postgres`; `tools/lint-rls-policies.ts` enforces both standard and JOIN-based RLS variants in CI.
>
> **JOIN-based RLS for child tables** — `levels`, `questions`, `question_versions`, `question_tags` carry no `tenant_id` column. RLS derives tenancy through the parent `pack_id` FK chain via an `EXISTS (SELECT 1 FROM question_packs p WHERE p.id = child.pack_id AND p.tenant_id = current_setting('app.current_tenant', true)::uuid)` predicate. Two-hop variant (`question_versions`, `question_tags`) joins through `questions → question_packs`. Same fail-closed guarantee: NULL GUC → `tenant_id = NULL` → FALSE → zero rows visible. *Why:* a denormalized `tenant_id` on every child would risk drift (a question moved between packs would need its tenant_id updated; a forgotten update silently leaks rows). The JOIN version is structurally consistent with the FK chain. *Considered and rejected:* (a) denormalized `tenant_id` columns on each child table — drift risk; (b) RLS-via-trigger that updates tenant_id on insert — adds a per-row write path with no defense-in-depth gain. *Not included:* attempt-engine child tables (`attempt_questions`/`attempt_answers`/`attempt_events`) — those use the same JOIN pattern but ship with G1.C.
>
> **Defense-in-depth composite FK** (migration 0015) — `questions.(level_id, pack_id)` references `levels.(id, pack_id)`. Without this FK, a service-layer regression could silently let a question reference a level in a different pack (different tenant). The service guard (`findLevelById` RLS-scoped lookup) is the first line of defense; the composite FK is the structural backstop. Cost: a redundant `UNIQUE (id, pack_id)` on `levels` (id is already PK).

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
  UNIQUE (pack_id, position)
);

CREATE TABLE questions (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  pack_id         UUID NOT NULL REFERENCES question_packs(id),
  level_id        UUID NOT NULL REFERENCES levels(id),
  type            TEXT NOT NULL CHECK (type IN ('mcq','subjective','kql','scenario','log_analysis')),
  topic           TEXT NOT NULL,
  points          INT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft',
  version         INT NOT NULL DEFAULT 1,
  content         JSONB NOT NULL,               -- type-specific shape, see below
  rubric          JSONB,                        -- for subjective/scenario; null for deterministic types
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
  saved_by        UUID NOT NULL REFERENCES users(id),
  saved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (question_id, version)
);

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
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, user_id)                         -- one attempt per user per assessment v1
);
CREATE INDEX attempts_user_idx ON attempts (tenant_id, user_id);
CREATE INDEX attempts_timer_sweep_idx ON attempts (ends_at) WHERE status = 'in_progress';
CREATE INDEX attempts_assessment_status_idx ON attempts (assessment_id, status);

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

## Grading & scoring

```sql
CREATE TABLE prompt_versions (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  name            TEXT NOT NULL,                          -- 'subjective_grader_v3'
  version         INT NOT NULL,
  template        TEXT NOT NULL,
  model           TEXT NOT NULL,                          -- 'claude-sonnet-4-6'
  hash            TEXT NOT NULL UNIQUE,                   -- sha256 of template
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

CREATE TABLE grading_jobs (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  attempt_id      UUID NOT NULL REFERENCES attempts(id),
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','retrying')),
  attempt_count   INT NOT NULL DEFAULT 0,
  prompt_version_id UUID REFERENCES prompt_versions(id),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  cost_input_tokens  INT,
  cost_output_tokens INT,
  error           TEXT,
  raw_output      JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE gradings (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  attempt_id      UUID NOT NULL REFERENCES attempts(id),
  question_id     UUID NOT NULL REFERENCES questions(id),
  grader          TEXT NOT NULL CHECK (grader IN ('deterministic','pattern','ai','admin_override')),
  score_earned    NUMERIC(6,2) NOT NULL,
  score_max       NUMERIC(6,2) NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('correct','incorrect','partial','review_needed','overridden')),
  anchor_hits     JSONB,                                   -- per-anchor evidence
  reasoning_band  INT,                                     -- 0..4
  ai_justification TEXT,
  error_class     TEXT,                                    -- e.g. 'missed_pivot_to_identity'
  prompt_version_id UUID REFERENCES prompt_versions(id),
  graded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  graded_by       UUID REFERENCES users(id),               -- null for AI/automated
  override_of     UUID REFERENCES gradings(id),            -- self-ref for admin overrides
  override_reason TEXT,
  PRIMARY KEY (id)
);
CREATE INDEX gradings_attempt_idx ON gradings (attempt_id, question_id);

CREATE TABLE attempt_scores (
  attempt_id      UUID PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  total_earned    NUMERIC(8,2) NOT NULL,
  total_max       NUMERIC(8,2) NOT NULL,
  auto_pct        NUMERIC(5,2) NOT NULL,
  pending_review  BOOLEAN NOT NULL DEFAULT false,
  archetype       TEXT,                                    -- e.g. 'methodical_diligent'
  archetype_signals JSONB,                                 -- which signals fired
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
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

CREATE TABLE webhook_endpoints (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  url             TEXT NOT NULL,
  secret_enc      BYTEA NOT NULL,
  events          TEXT[] NOT NULL,                         -- ['attempt.submitted','attempt.graded']
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  endpoint_id     UUID NOT NULL REFERENCES webhook_endpoints(id),
  event           TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL,                           -- 'pending','delivered','failed'
  http_status     INT,
  attempts        INT NOT NULL DEFAULT 0,
  next_retry_at   TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
