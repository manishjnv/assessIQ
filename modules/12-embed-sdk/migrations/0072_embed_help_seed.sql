-- Phase 4: seed help content for the four embed SDK admin help IDs.
-- Spec: modules/12-embed-sdk/SKILL.md § Help/tooltip surface.
-- Follows the same upsert pattern as 0011_seed_help_content.sql.
-- locale='en', audience='admin', tenant_id=NULL (global default).
--
-- Conflict key: UNIQUE NULLS NOT DISTINCT (tenant_id, key, locale, version)
-- from modules/16-help-system/migrations/0010_help_content.sql line 29.
-- Re-running this migration is safe (DO UPDATE is idempotent for same content).
--
-- This migration bypasses RLS (runs as postgres superuser via tools/migrate.ts).

INSERT INTO help_content
  (id, tenant_id, key, locale, audience, short_text, long_md, version, status, updated_at)
VALUES
  (
    gen_random_uuid(), NULL,
    'admin.integrations.embed-secrets.create', 'en', 'admin',
    'Create an embed secret for iframe integration',
    E'## Embed secret\n\nAn embed secret lets your backend sign JWT tokens that AssessIQ accepts to start a candidate session inside an iframe.\n\n**Steps:**\n1. Copy the secret immediately — it is shown only once.\n2. Store it in your backend secret manager (never in frontend code).\n3. Use it server-side to sign embed JWTs (HS256 algorithm, max 10-minute expiry, unique `jti` per token).\n4. Optionally install the `@assessiq/embed` npm package for a typed minting helper.\n\nSee the [Integration Guide](/docs/09-integration-guide.md) for a full code example.',
    1, 'active', now()
  ),
  (
    gen_random_uuid(), NULL,
    'admin.integrations.embed-origins.add', 'en', 'admin',
    'Allowed frame origins for iframe embed',
    E'## Embed origins\n\nOrigins listed here are the only `window.origin` values AssessIQ will accept when verifying postMessage events from the parent iframe. AssessIQ also uses this list to set `Content-Security-Policy: frame-ancestors` on every `/embed` response so browsers enforce framing only from listed origins.\n\n**Format:** `scheme://hostname` or `scheme://hostname:port`\n\nExamples:\n- `https://portal.wipro.com`\n- `https://app.acme.com`\n- `https://localhost:3000` (dev only)\n\nChanges take effect on the next token verification — no restart required.',
    1, 'active', now()
  ),
  (
    gen_random_uuid(), NULL,
    'admin.integrations.test-embed', 'en', 'admin',
    'Test the embed integration in a sandbox page',
    E'## Embed test page\n\nOpen the embed test page to verify your postMessage integration before going live. The page lets you:\n\n- Launch the iframe with a test JWT (minted server-side — no need to build a host app)\n- Send `aiq.theme` and `aiq.locale` messages to the iframe\n- View all incoming `aiq.*` postMessage events in real time\n\n**Requirement:** `ENABLE_EMBED_TEST_MINTER=1` must be set in the API environment. This flag is intentionally off in production.',
    1, 'active', now()
  ),
  (
    gen_random_uuid(), NULL,
    'admin.integrations.npm-package', 'en', 'admin',
    'Install the @assessiq/embed npm helper',
    E'## @assessiq/embed npm package\n\nFor framework-aware hosts, install the npm package:\n\n```bash\nnpm install @assessiq/embed\n```\n\n**Server-side** (Node.js — signs the embed JWT):\n```ts\nimport { mintEmbedToken } from "@assessiq/embed";\nconst token = mintEmbedToken({\n  secret,          // your embed secret from the admin panel\n  tenantId,\n  user: { sub: userId, email, name },\n  assessmentId,\n});\n```\n\n**Client-side** (mounts the iframe):\n```ts\nimport { AssessIQMount } from "@assessiq/embed";\nconst handle = AssessIQMount("#container", {\n  token,\n  onReady: () => console.log("iframe ready"),\n  onSubmit: (result) => console.log("submitted", result),\n  onError: (err) => console.error(err),\n});\n// later: handle.destroy();\n```\n\nAlternatively, for zero-build hosts, use the script tag:\n```html\n<script src="https://assessiq.automateedge.cloud/embed/sdk.js"></script>\n```',
    1, 'active', now()
  )
ON CONFLICT (tenant_id, key, locale, version) DO UPDATE
  SET short_text  = EXCLUDED.short_text,
      long_md     = EXCLUDED.long_md,
      status      = EXCLUDED.status,
      updated_at  = now();
