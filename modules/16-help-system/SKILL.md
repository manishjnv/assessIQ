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

## Audit-write coverage (G3.D, 2026-05-13)

Both admin-mutating service functions are now wired to `auditInTx` inside the same `withTenant` transaction as the domain mutation. Full documentation in [`docs/11-observability.md` § 26](../../docs/11-observability.md).

| Function | Action | Notes |
|---|---|---|
| `upsertHelpForTenant` | `help.content.updated` | `before=null` on first insert; before-snapshot on update |
| `importHelp` | `help.content.imported` | One summary row per bulk call; `keys[]` capped at 50 |

Atomicity + coverage tests: `src/__tests__/audit-writes.test.ts` (4 tests). Coverage-grep asserts exactly 2 `auditInTx(` call-sites in `service.ts`.

Not audited: `recordHelpEvent` (fire-and-forget telemetry), all read paths (`getHelpForPage`, `getHelpKey`, `exportHelp`).

**Operational notes:**
- **Adding or rewording a global help row after deploy (2026-10-01, `0115_seed_result_release_help.sql` is the pattern):** edit `content/en/*.yml` AND ship a forward migration — `INSERT … ON CONFLICT (tenant_id, key, locale, version) DO NOTHING` for new keys, `UPDATE help_content SET short_text, long_md, updated_at = now() WHERE tenant_id IS NULL AND key = … AND locale = 'en' AND version = 1` for existing ones (migrations run as the superuser, so RLS is bypassed; tenant overrides are untouched). Bump the global-row count in `src/__tests__/help-system.test.ts` per new key. Generate the SQL from the YAML so the two cannot drift. `0011_seed_help_content.sql` is NOT regenerated: `tools/migrate.ts` aborts a deploy on checksum drift of an applied migration, while the CI "Help-seed drift check" (regenerate 0011 + `git diff --exit-code`) fails on a clean main today — regenerating emits every YAML key, i.e. 136 rows before 0115, versus the committed file. Pick one policy (e.g. exempt the check, or `--force-rerun 0011_seed_help_content.sql` at deploy) before relying on it.
- Migration `0010_help_content.sql` was rewritten in-place during integration testing (4-policy structure replaced FOR ALL; NULLIF wrap added to handle pg.Pool empty-string GUC). Migration `0012_fix_rls_empty_string.sql` carries the same fix as a hot-patch for any database deployed before this rewrite — idempotent (`DROP POLICY IF EXISTS` + `CREATE`). On a fresh VPS, applying 0010 is sufficient and 0012 is a no-op.
- Admin help authoring in Phase 1 is via direct `PATCH /api/admin/help/:key` (curl/Postman) or by editing the YAML and redeploying. Admin UI authoring is Phase 2.

## 0131 question-type help (2026-10-02)

Two new admin help ids, `admin.question.content.numeric` and `admin.question.content.multi_select`, in `content/en/admin.yml` and migration `0131_seed_question_types_help.sql` (idempotent INSERTs; 0011 is not regenerated). Seeded global count 160 -> 162 (`help-system.test.ts`).

## Page help key form (N16, 2026-10-03)

A page-level help entry has the key `<page>.page`. `AdminShell helpPage` mounts `HelpProvider page=...`; the API returns the keys `LIKE '<page>.%'`; the header (?) button opens the drawer at `<page>.page`. A page id must use only `[a-z0-9_]` in each segment (the seed generator and `HelpEntrySchema` reject a hyphen). `admin.tenant-settings` and `admin.generate-wizard` were renamed to `admin.tenant_settings` and `admin.generate_wizard` (help ids only; routes unchanged). Eight page entries were added in migration `0148_seed_page_help.sql` (seed 0011: 196 rows; production: 203 global rows). **Open (task N20):** some `data-help-id` values are outside the prefix of their page (`admin.settings.company_name`, `admin.settings.result_release_mode`, `admin.question.content.*`, `admin.question.ordering.*`), so their text cannot load.

## Structured case help keys (SP7, 2026-10-03)

Migration `0153_seed_structured_case_help.sql` (idempotent, `ON CONFLICT DO NOTHING`) adds four keys, mirrored in `content/en/admin.yml` and `candidate.yml`: `admin.question.editor.content.structured_case`, `admin.question.editor.structured_case.steps`, `admin.question.editor.structured_case.scoring`, `candidate.attempt.structured_case`. All sit under their page prefix (see N20 and the guard test `help-id-page-prefix.test.ts`). Seed `0011` is regenerated: the row count assertion in `help-system.test.ts` went from 196 to 200.

## Admin authoring routes (FU-D1/FU-D2/FU-D3, 2026-10-06)

**What changed.** `GET /api/admin/help?locale=` lists the newest active version per (tenant arm, key, locale) (globals + the caller's overrides); `PATCH /api/admin/help/global/:key` (super_admin) writes a new version of the GLOBAL row via `service.upsertGlobalHelp`, which runs `SET LOCAL ROLE assessiq_system` because the `help_content` INSERT policy forbids `tenant_id IS NULL` for `assessiq_app`; the audit row (`help.content.updated`, `after.scope = "global"`) is written in the same tx under the actor's tenant. `exportTenantHelp` now returns one row per (tenant arm, key, locale) with `DISTINCT ON ... version DESC`; `listHelpForPage` and `getHelpKey` order by `version DESC` so a bumped global row wins on read (before, two active global versions had an undefined winner). The admin page `help-content.tsx` uses these routes; the "Help content" menu entry is super-admin only (FR14).

**Why.** RV74 found the page calling four non-existent paths; FR14 decided help editing is platform only; globals could not be edited at all after deploy without a migration.

**Rejected.** An UPDATE in place of the global row (loses history, and `assessiq_app` has no UPDATE policy for NULL rows); a new `help_content_global` table (one table with a nullable tenant is the existing design).

**Not included.** Archiving old versions (status stays `active`, the read side picks the newest); a version diff view; tenant-side menu entry.

**Downstream.** `audit-writes.test.ts` expects 3 `auditInTx` call sites in `service.ts`. `help-system.test.ts` Block 4b covers the global bump. Seed count 208 (migration `0157_seed_help_content_admin_help.sql`, 5 keys under `admin.settings.help_content.*`; `0011` regenerated).

