# 12-embed-sdk — Migration plan

> Phase 4 writes the actual SQL. This file pre-seeds the migration contract so the implementation session starts immediately against a frozen schema plan.
>
> Numbering: Phase 3 used `0055`–`0058`; `0060`–`0069` reserved for G3.A (`14-audit-log`) and G3.C (`15-analytics`). Phase 4 (`12-embed-sdk`) starts at **`0070`**.
>
> All decisions referenced below are in `modules/12-embed-sdk/SKILL.md` § Decisions captured (2026-05-03).

---

## `0070_embed_origins.sql`

**Owns:** `tenants.embed_origins` column.

**Schema sketch:**
```sql
-- Phase 4: add embed_origins to tenants for postMessage origin verification (D2, D8).
-- Referenced in docs/04-auth-flows.md Flow 3 but not yet in the tenants schema.
-- See docs/02-data-model.md § Tenancy (tenants table) for the existing column set.

ALTER TABLE tenants
  ADD COLUMN embed_origins TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX tenants_embed_origins_gin_idx ON tenants USING GIN (embed_origins);
```

**RLS note.** `tenants` uses special-cased RLS (`id = current_setting('app.current_tenant')::uuid`), not the standard two-policy template. This migration adds only a column + index — no new RLS policy needed (the existing tenant-row policy covers the new column automatically).

**Downstream.** The `/embed` handler reads `embed_origins` after JWT verification. The admin UI (Phase 4 `10-admin-dashboard`) adds a Settings → Integrations → Embed Origins management panel. `docs/02-data-model.md` § Tenancy table block needs a same-PR line addition for `embed_origins`.

---

## `0071_tenants_embed_metadata.sql`

**Owns:** `tenants.privacy_disclosed` column (D13) and `sessions.session_type` column (D6).

**Schema sketch:**
```sql
-- Phase 4: two embed-related metadata columns.
-- privacy_disclosed: gate for embed secret creation per DPDP / GDPR / CCPA (D13).
-- session_type: distinguishes standard vs. embed sessions in the sessions table (D6).
-- See docs/02-data-model.md § Tenancy + § Users & auth for the existing column sets.

-- tenants: privacy disclosure gate
ALTER TABLE tenants
  ADD COLUMN privacy_disclosed BOOLEAN NOT NULL DEFAULT FALSE;

-- sessions: session type discriminator
ALTER TABLE sessions
  ADD COLUMN session_type TEXT NOT NULL DEFAULT 'standard'
    CHECK (session_type IN ('standard', 'embed'));

CREATE INDEX sessions_session_type_idx ON sessions (session_type, tenant_id, expires_at);
```

**RLS note.** `sessions` uses the standard two-policy RLS template (SELECT/ALL policy on `tenant_id`). No new policy needed — the existing policies cover the new column.

**Service-layer gate (privacy_disclosed).** `modules/01-auth/src/embed-jwt.ts` `createEmbedSecret()` must check `tenant.privacy_disclosed` before inserting. Throws `403 EMBED_REGISTRATION_REQUIRES_PRIVACY_DISCLOSURE` if `FALSE`. The `PATCH /api/admin/tenant` endpoint (Phase 1 stub in `03-API`) needs to accept `privacy_disclosed: boolean` in its body — a one-field extension of the existing handler.

**Downstream.** `docs/02-data-model.md` § Tenancy and § Users & auth both need same-PR line additions. `modules/01-auth/SKILL.md` sessionLoader section needs a follow-up note on the `session_type` discriminator (not touching `01-auth` SKILL.md in this pre-flight session — Phase 4 handles it).

---

## `0072_embed_help_seed.sql`

**Owns:** `help_content` rows for the four embed help IDs declared in `modules/12-embed-sdk/SKILL.md` § Help/tooltip surface.

**Schema sketch:**
```sql
-- Phase 4: seed help content for the four embed SDK admin help IDs.
-- Follows the same pattern as 0011_seed_help_content.sql in modules/16-help-system/migrations/.
-- locale='en', audience='admin', tenant_id=NULL (global default).
-- See modules/16-help-system/SKILL.md for the help_content table schema and upsert pattern.

INSERT INTO help_content (id, tenant_id, key, locale, audience, short_text, long_md, version, created_at, updated_at)
VALUES
  (gen_random_uuid(), NULL, 'admin.integrations.embed-secrets.create', 'en', 'admin',
   'Create an embed secret for iframe integration',
   E'## Embed secret\n\nAn embed secret lets your backend sign JWT tokens that AssessIQ accepts to start a candidate session inside an iframe.\n\n**Steps:**\n1. Copy the secret immediately — it is shown only once.\n2. Store it in your backend secret manager (never in frontend code).\n3. Use it server-side to sign embed JWTs (HS256 algorithm, max 10-minute expiry, unique `jti` per token).\n\nSee the [Integration Guide](/docs/09-integration-guide.md) for a full code example.',
   1, now(), now()),

  (gen_random_uuid(), NULL, 'admin.integrations.embed-origins.add', 'en', 'admin',
   'Allowed frame origins for iframe embed',
   E'## Embed origins\n\nOrigins listed here are the only `window.origin` values AssessIQ will accept when verifying postMessage events from the parent iframe.\n\n**Format:** `scheme://hostname` or `scheme://hostname:port` — for example `https://portal.wipro.com` or `https://localhost:3000`.\n\nAssessIQ also sets `Content-Security-Policy: frame-ancestors <your-origins>` so browsers only allow framing from these origins.',
   1, now(), now()),

  (gen_random_uuid(), NULL, 'admin.integrations.test-embed', 'en', 'admin',
   'Test the embed integration in a sandbox page',
   E'## Embed test page\n\nOpen the embed test page to verify your postMessage integration before going live. The page lets you:\n- Launch the iframe with a test JWT\n- Send theme / locale messages to the iframe\n- View all `aiq.*` postMessage events in real time\n\nRequires `ENABLE_EMBED_TEST_MINTER=1` in the API environment (development only).',
   1, now(), now()),

  (gen_random_uuid(), NULL, 'admin.integrations.npm-package', 'en', 'admin',
   'Install the @assessiq/embed npm helper',
   E'## @assessiq/embed npm package\n\nFor framework-aware hosts, install the npm package:\n\n```bash\nnpm install @assessiq/embed\n```\n\nServer-side (Node.js):\n```ts\nimport { mintEmbedToken } from "@assessiq/embed";\nconst { url } = mintEmbedToken({ secret, tenantId, user: { sub, email, name }, assessmentId });\n```\n\nClient-side:\n```ts\nimport { AssessIQMount } from "@assessiq/embed";\nconst handle = AssessIQMount("#container", { token, onSubmit: (r) => console.log(r) });\n// later: handle.destroy();\n```\n\nFor zero-build hosts, load the script tag instead: `<script src="https://assessiq.automateedge.cloud/embed/sdk.js"></script>`',
   1, now(), now())
ON CONFLICT (key, locale, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET short_text = EXCLUDED.short_text, long_md = EXCLUDED.long_md,
                version = help_content.version + 1, updated_at = now();
```

**Note on conflict key.** The `help_content` table's unique constraint must support `tenant_id IS NULL` rows. Refer to `modules/16-help-system/SKILL.md` for the actual constraint definition and adjust the `ON CONFLICT` clause to match. The sketch above shows the intent; Phase 4 adapts it to the live schema.

---

## `0073_attempt_embed_origin.sql`

**Owns:** `attempts.embed_origin` column (co-located here per SKILL.md D9, even though `attempts` is owned by `06-attempt-engine`).

**Schema sketch:**
```sql
-- Phase 4: add embed_origin flag to attempts so host apps can identify iframe-sourced attempts
-- in webhook payloads. Owned by 06-attempt-engine; migration co-located in 12-embed-sdk
-- per SKILL.md D9 decision.
-- See docs/02-data-model.md § Attempt engine (attempts table) for the existing column set.

ALTER TABLE attempts
  ADD COLUMN embed_origin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX attempts_embed_origin_idx ON attempts (tenant_id, embed_origin)
  WHERE embed_origin = TRUE;
```

**RLS note.** `attempts` uses the standard two-policy RLS template on `tenant_id`. No new policy needed.

**Service-layer write.** The `/embed` route handler in `modules/12-embed-sdk/src/server/` calls `06-attempt-engine`'s `createAttempt()` with `embed_origin: true`. The `createAttempt()` function signature needs a new optional parameter `embedOrigin?: boolean` (default `false`). Phase 4 must update `modules/06-attempt-engine/src/service.ts` and `modules/06-attempt-engine/src/types.ts` in the same PR.

**Webhook serializer.** `modules/13-notifications/` webhook payload builder must include `embed_origin` from the `attempts` row in the `attempt.submitted`, `attempt.graded`, and `attempt.released` event payloads (as `"embed_origin": true/false`). Phase 4 implementation task.
