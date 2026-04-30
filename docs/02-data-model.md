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

```sql
CREATE TABLE tenants (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
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
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('google','microsoft','okta','saml','custom_oidc')),
  subject         TEXT NOT NULL,                -- the 'sub' claim from the IdP
  email_verified  BOOLEAN NOT NULL DEFAULT false,
  raw_profile     JSONB,
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

CREATE TABLE user_credentials (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  totp_secret_enc      BYTEA,                  -- AES-256-GCM encrypted with master key
  totp_enrolled_at     TIMESTAMPTZ,
  totp_last_used_at    TIMESTAMPTZ,
  password_hash        TEXT,                   -- argon2id, only if password auth enabled
  password_set_at      TIMESTAMPTZ
);

CREATE TABLE totp_recovery_codes (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash       TEXT NOT NULL,               -- argon2id of the code
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  token_hash      TEXT NOT NULL UNIQUE,        -- sha256 of the cookie value
  totp_verified   BOOLEAN NOT NULL DEFAULT false,
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

## Assessment lifecycle

```sql
CREATE TYPE assessment_status AS ENUM ('draft','published','active','closed','cancelled');

CREATE TABLE assessments (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  pack_id         UUID NOT NULL REFERENCES question_packs(id),
  level_id        UUID NOT NULL REFERENCES levels(id),
  name            TEXT NOT NULL,
  description     TEXT,
  status          assessment_status NOT NULL DEFAULT 'draft',
  question_count  INT NOT NULL,
  randomize       BOOLEAN NOT NULL DEFAULT true,
  opens_at        TIMESTAMPTZ,
  closes_at       TIMESTAMPTZ,
  settings        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- per-assessment overrides
  created_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE assessment_invitations (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  assessment_id   UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','viewed','started','submitted','expired')),
  invited_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, user_id)
);
```

## Attempts

```sql
CREATE TABLE attempts (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  assessment_id   UUID NOT NULL REFERENCES assessments(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted','auto_submitted','abandoned','grading','graded','reviewed','released')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at    TIMESTAMPTZ,
  time_used_seconds INT,
  integrity       JSONB NOT NULL DEFAULT '{}'::jsonb,    -- {visibilityBlurs,copyEvents,...}
  client_meta     JSONB,                                  -- {ip, ua, screen}
  UNIQUE (assessment_id, user_id)                         -- one attempt per user per assessment v1
);

CREATE TABLE attempt_questions (
  attempt_id      UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id     UUID NOT NULL REFERENCES questions(id),
  position        INT NOT NULL,
  question_version INT NOT NULL,                          -- frozen at attempt start
  PRIMARY KEY (attempt_id, question_id)
);

CREATE TABLE attempt_answers (
  attempt_id      UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id     UUID NOT NULL REFERENCES questions(id),
  answer          JSONB,                                  -- shape depends on q type
  flagged         BOOLEAN NOT NULL DEFAULT false,
  time_spent_seconds INT NOT NULL DEFAULT 0,
  edits_count     INT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, question_id)
);

CREATE TABLE attempt_events (
  id              BIGSERIAL PRIMARY KEY,
  attempt_id      UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,                          -- 'question_view','answer_save','flag','tab_blur','copy','paste'
  question_id     UUID,
  payload         JSONB,
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attempt_events_attempt_idx ON attempt_events (attempt_id, at);
```

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
  UNIQUE (tenant_id, key, locale, version)
);
```

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
