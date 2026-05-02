# 16-help-system — Tooltip framework, help content, contextual drawer

> Full architecture in `docs/07-help-system.md`. This is the implementation orientation.

## Purpose
Three layers of help (tooltip, inline, drawer) on every page, for every audience, in every locale. Centralized authoring; instant updates; versioned content.

## Scope
- **In:** `help_content` schema + CRUD, `<HelpTip>` and `<HelpDrawer>` and `<HelpProvider>` React components, public read API for embed/anonymous use, admin authoring UI, default content shipped as YAML, i18n hooks, telemetry on help usage.
- **Out:** specific help text per module (each module declares its `help_id`s in its SKILL.md and contributes default copy).

## Dependencies
- `00-core`, `02-tenancy` (tenant-overridable content)
- `17-ui-system` (Tooltip primitive)
- `13-notifications` (Phase 2: notify admins of help they should review based on usage)

## Public surface
```tsx
<HelpProvider page="admin.assessments.create" audience="admin" locale="en">
  ...page content...
</HelpProvider>

<HelpTip helpId="admin.assessments.create.duration">
  <input ... />
</HelpTip>

<HelpDrawerTrigger />   // renders the (?) icon in page header

useHelp("admin.assessments.create.duration"): { shortText, longMd, openDrawer }
```

## API
```
GET  /api/help?page=&audience=&locale=          # bulk fetch for a page
GET  /api/help/:key?locale=                     # single key
GET  /help/:key?locale=                         # public/anonymous (for embed)
PATCH /api/admin/help/:key                      # author content
GET  /api/admin/help/export?locale=             # bulk export for translation
POST /api/admin/help/import?locale=             # bulk upsert
```

**Edge routing note:** the bare-root `GET /help/:key` is mounted **without** the `/api` prefix by design (anonymous embed-friendly URL, parallel to `/embed*`). Production Caddy must forward `/help/*` to `assessiq-api` — captured in `docs/06-deployment.md` § "Current live state" and RCA `2026-05-02 — Caddy /help/* not forwarded`. Any future Phase 1+ module that mounts a non-`/api/*` route must add itself to the same Caddy `@api` matcher.

## Default content seeding
On first migration: load `modules/16-help-system/content/en/*.yml` into `help_content` table with `tenant_id=NULL` (global default). Per-tenant overrides written by admin take precedence at read time.

## Telemetry
- Tooltip shown count per key (sample 10%; aggregate hourly)
- Drawer opens per page
- 👍/👎 feedback per key
Output: "Help health" admin report — pages with high drawer-open rate signal unclear UI; keys with 👎 dominance signal bad copy.

## Help/tooltip surface (meta)
- `admin.help-content.author` — markdown style guide, length limits
- `admin.help-content.locale` — translation workflow
- `admin.help-content.diff` — interpreting version diffs

## Open questions
- AI-assisted help drafting from a screen/component name + description — Phase 3 admin tool
- Embedded screencasts/GIFs in drawer content — supported in markdown; storage in static asset CDN

## Status

**2026-05-02 — Phase 1 G1.A Session 2 shipped.** `@assessiq/help-system` package live with 25 seeded global help_ids covering admin and candidate audiences.

**Resolved decisions** (PHASE_1_KICKOFF.md):
- **#1** — `Tooltip` primitive shipped in `modules/17-ui-system/src/components/Tooltip.tsx` (pure CSS positioning, 4 placements, keyboard-accessible, no floating-ui dep).
- **#2** — `help_content` ships with the **nullable-tenant variant** RLS (`tenant_id IS NULL OR tenant_id = ...`), but split into 4 scoped policies (`SELECT` / `UPDATE` / `DELETE` / `INSERT`) — see RCA_LOG 2026-05-02 for the FOR-ALL footgun that drove the split.
- **#10** — Help-id catalog stable at 25 keys (12 admin, 10 candidate, 3 retroactive admin-page audit). New keys added strictly via the YAML+generator pipeline; renames break tenant overrides and require a versioned migration.
- **#16** — Telemetry sample rate 10%; deterministic djb2-bucket on `key` plus a 1% random jitter. Pino-logged for Phase 1; upgrade to `audit_log` writes is Phase 3 (`14-audit-log`).
- **#17** — Locale fallback: missing `(key, locale)` retries with `locale='en'` and decorates the response with `_fallback: true`. Page-batch reads do not apply per-key fallback (would be N+1); single-key reads do.
- **#18** — YAML→SQL deploy-time seed pipeline via `tools/generate-help-seed.ts`. Idempotent (`ON CONFLICT DO NOTHING`); admins update content via `upsertHelp` (which bumps version), not by editing YAML.

**Public surface:**

```ts
// from @assessiq/help-system
getHelpForPage(tenantId: string | null, page, audience, locale): Promise<HelpReadEnvelope[]>
getHelpKey(tenantId: string | null, key, locale): Promise<HelpReadEnvelope | null>
upsertHelpForTenant(tenantId, key, input): Promise<HelpEntry>
exportHelp(tenantId, locale): Promise<HelpEntry[]>
importHelp(tenantId, locale, rows): Promise<{ inserted, skipped }>
shouldSampleHelpEvent(key, sampleRate): boolean
recordHelpEvent(event, payload): Promise<void>
registerHelpPublicRoutes(app)
registerHelpAuthRoutes(app, { authChain })
registerHelpAdminRoutes(app, { authChain })
registerHelpTrackRoutes(app)

// from @assessiq/help-system/components
<HelpProvider page audience locale> · <HelpTip helpId> · <HelpDrawer> · <HelpDrawerTrigger>
useHelp(key) · useHelpContext()
```

**Tenant override merge semantics:** RLS returns both the global row and the tenant override row in a single SELECT (visible because of the `tenant_id IS NULL OR ...` USING clause). The service layer dedupes by key and prefers the tenant override (`tenantId !== null`).

**Anonymous globals-only reads:** `getHelpKey(null, ...)` uses an internal `withGlobalsOnly` helper that begins a transaction, sets `SET LOCAL ROLE assessiq_app`, and explicitly resets `app.current_tenant` to `DEFAULT`. The RLS policy's `NULLIF(current_setting(..., true), '')::uuid` handles the pg.Pool empty-string GUC leak (RCA 2026-05-02).

**Phase 1 deferrals (NOT in this session — by design):**
- Admin authoring UI (WYSIWYG editor) — Phase 2 admin-dashboard.
- Real `audit_log` writes — Phase 3 (14-audit-log).
- Frontend `<HelpProvider>` wiring on shipped admin pages (login/mfa/users) — pending the assessiq-frontend container build (Phase 1+ deferral). The 3 admin pages carry `data-help-id` attrs marking the elements; HelpTip wrapping lands with the first frontend deploy.
- Admin authoring rotation panel for `GET /api/admin/help/export` + `POST /api/admin/help/import` — Phase 2 admin-dashboard.
- Storybook snapshot infrastructure for the React components — `apps/storybook` does not yet have visual-regression baselines; structural Vitest assertions via testcontainers are the Phase 1 substitute.

**Operational notes:**
- Migration `0010_help_content.sql` was rewritten in-place during integration testing (4-policy structure replaced FOR ALL; NULLIF wrap added to handle pg.Pool empty-string GUC). Migration `0012_fix_rls_empty_string.sql` carries the same fix as a hot-patch for any database deployed before this rewrite — idempotent (`DROP POLICY IF EXISTS` + `CREATE`). On a fresh VPS, applying 0010 is sufficient and 0012 is a no-op.
- Admin help authoring in Phase 1 is via direct `PATCH /api/admin/help/:key` (curl/Postman) or by editing the YAML and redeploying. Admin UI authoring is Phase 2.
