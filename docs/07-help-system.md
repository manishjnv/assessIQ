# 07 — Help System

*Type: reference* — This page describes the help system: `help_id` rules, audience tracks and content versions.

**Status (2026-05-02):** Phase 1 G1.A Session 2 shipped. Frontend wiring on existing admin pages lands with the `assessiq-frontend` container deploy (Phase 1+ deferral).

- `@assessiq/help-system` is live.
- Server side: routes for public, auth, admin and track; service; repository; 25 seeded globals.
- Client side: `HelpProvider`, `HelpTip`, `HelpDrawer` and `HelpDrawerTrigger` React components.
- 17 of 17 integration tests pass against testcontainers Postgres, including the cross-tenant override invariants.
- `data-help-id` attributes are already on `login.tsx`, `mfa.tsx` and `users.tsx`.

> Tooltip and inline help is a **first-class module**, not an add-on. Every UI element with a non-obvious meaning carries a `help_id`. Central authoring changes the copy in one place. Localization comes with it.

## Goals

| # | Goal |
| --- | --- |
| 1 | A tooltip on every non-obvious UI control |
| 2 | A contextual help drawer (fuller markdown content) in the page header of every page |
| 3 | Audience tracks: `admin`, `reviewer` and `candidate` see different help content for the same screen |
| 4 | Authoring without redeploy: an admin edits help content in the admin UI, and each change is versioned |
| 5 | i18n-ready from day one: one locale (`en`) ships first, and the structure supports `hi-IN`, `kn-IN` and others |

## Three layers of help

| Layer | Trigger | Display | Content length |
| --- | --- | --- | --- |
| **Tooltip** | Hover or focus on an element with `help_id` | Floating popover, 200 ms delay, closes on blur | ≤ 120 chars |
| **Inline note** | Always visible next to the control | Subtle muted text below the input, with a `?` icon link to the drawer | 1–2 sentences |
| **Help drawer** | `?` icon in the page header or `Cmd/Ctrl+/` | Right-side drawer with full markdown, links and screenshots | Unbounded |

- The drawer is keyed by *page*, not by element.
- The "Open full help →" link in an element tooltip opens the drawer at the matching section.

## Help ID convention

A help id is hierarchical, dot-separated and audience-prefixed:

```
<audience>.<area>.<page>.<element>
```

| Example | Meaning |
| --- | --- |
| `admin.assessments.create.duration` | Tooltip on the duration input on the assessment-create page |
| `admin.assessments.create.page` | Full drawer for that page |
| `candidate.attempt.kql.editor` | Tooltip on the KQL editor when taking an assessment |
| `candidate.attempt.flag` | Tooltip on the flag-for-review button |
| `candidate.attempt.key_shortcuts` | Tooltip on the take-page checkbox that turns the P and N keys on or off (Z-41, WCAG 2.1.4; migration 0202) |
| `admin.grading.override.button` | Tooltip on the "Override AI score" button (also documents the MFA step-up) |

- Audience-agnostic content uses `all.*`.
- Tenant-overridable content can be authored per tenant. Without an override, the global default applies.

## Content schema

Table: `help_content` (see `docs/02-data-model.md`).

```typescript
type HelpEntry = {
  key: string;             // 'admin.assessments.create.duration'
  audience: 'admin' | 'reviewer' | 'candidate' | 'all';
  locale: string;          // 'en'
  short_text: string;      // tooltip / inline; <= 120 chars
  long_md?: string;        // drawer content (markdown)
  related_keys?: string[]; // sibling links surfaced in drawer
  version: number;
  status: 'active' | 'archived';
};
```

Storage rules:

- One row for each `(tenant_id NULL OR tenant_id, key, locale, version)`.
- `tenant_id NULL` is the global default. A tenant-specific row overrides it.
- Any content edit creates a new version. Old versions stay for audit.

## Frontend integration

### `<HelpTip>` component

`<HelpTip>` wraps any element with a tooltip and an optional drawer link.

```tsx
<HelpTip helpId="admin.assessments.create.duration">
  <label>Duration (minutes)</label>
  <input type="number" name="duration" />
</HelpTip>
```

| Item | Behavior |
| --- | --- |
| Children | Rendered unchanged |
| `(?)` icon | Adjacent. Hover or focus shows a popover with `short_text` |
| Click on the icon | Opens the drawer at the matching key |
| Keyboard | Tab to the icon. Enter or Space opens the drawer. Escape closes it |

### `<HelpProvider>`

`<HelpProvider>` is a top-level context. It loads the help content for the current page on mount.

```tsx
<HelpProvider page="admin.assessments.create" audience="admin" locale="en">
  <AssessmentCreatePage />
</HelpProvider>
```

- Fetches `/api/help?page=admin.assessments.create&audience=admin&locale=en` once.
- Caches in memory and `localStorage` (TTL 1 hour).
- Subscribes to SSE for live updates if an admin edits help in another tab.

### Help drawer

Trigger: the page header `(?)` button or `Cmd/Ctrl + /`.

- Right-side panel, 480 px wide.
- Markdown rendered with safe HTML, anchored links, code blocks and embedded screenshots.
- "Was this helpful? 👍 / 👎" feedback, recorded for analytics.
- Search within the page-level help.

### Help authoring (admin UI)

Path: *Settings → Help Content*.

- Tree view by area (admin, reviewer, candidate).
- Click a key to open the markdown editor (side-by-side preview).
- Save creates a new version.
- Diff view between versions.
- Bulk export and import as JSON for translation workflows.
- Permission: only the admin role can edit. Edits are audit-logged.

## Default content shipped with v1

The catalog has about 120 help entries that cover every screen. Examples:

```yaml
# admin.assessments.create.duration
short_text: "How long candidates have to complete the assessment. Timer starts when they click Begin."
long_md: |
  ## Duration

  This is the total time a candidate has from clicking **Begin Assessment** to
  the auto-submit. Once started, it cannot be paused.

  **Recommendations:**
  - L1 / triage-style: 30–45 min
  - L2 / investigation: 45–60 min
  - L3 / detection engineering: 60–90 min

  Candidates can navigate freely between questions during this window.
  Auto-submit fires the moment the timer hits zero — partial answers are saved.

  > **Note:** Time-based behavioral signals (per-question time spent, edits)
  > are captured regardless of duration. Don't compress duration to "force
  > speed"; the platform measures speed separately.
related_keys:
  - admin.assessments.create.question_count
  - admin.attempts.timing_signals
```

```yaml
# candidate.attempt.flag
short_text: "Mark this question for review. You can come back to it before submitting."
long_md: |
  ## Flag for review

  Use this when you want to come back to a question before final submission —
  for instance, if you're not sure of your answer or want to verify a query.

  Flagged questions appear with a star in the navigation panel. You can flag
  multiple questions; the **Review** screen lists all flagged + unanswered
  items together so you don't miss anything.

  Flagging has no scoring impact. It's just a personal bookmark.
```

```yaml
# admin.grading.override.button
short_text: "Override the AI score with manager judgement. Requires fresh MFA."
long_md: |
  ## Override AI grading

  When you disagree with the AI grading on a subjective question, you can
  override the score. The AI's verdict is **kept on record beside your
  override** — your override does not erase it. This protects you in audit
  if questioned later.

  **What's required:**
  - Fresh TOTP verification within the last 15 minutes
  - A written reason (free text, stored in `gradings.override_reason`)
  - Optional: change the band (0–4) and the score; both are recorded

  **What happens after:**
  - The candidate sees the final (override) score
  - The audit log records actor, before/after, IP
  - If the AI confidence was already < 0.7, the override is also flagged for
    AI prompt-tuning review (helps us improve the rubric)
```

## API

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/help?page=<page>&audience=<a>&locale=<l>` | Not stated | List the entries for a page |
| `GET /api/help/<key>?locale=<l>` | Not stated | Get one entry |
| `GET /help/<key>?locale=<l>` | Public (anonymous) | Get one entry for the embedded help drawer in the candidate UI |
| `PATCH /api/admin/help/<key>` | Admin only | Write a new version |
| `GET /api/admin/help/export?locale=<l>` | Not stated (admin path) | Export all rows of a locale as JSON |
| `POST /api/admin/help/import?locale=<l>` | Not stated (admin path) | Bulk upsert rows of a locale |

### Read

```http
GET /api/help?page=admin.assessments.create&audience=admin&locale=en
→ 200 [
  { "key":"admin.assessments.create.duration", "short_text":"...", "long_md":"...", "related_keys":[...] },
  { "key":"admin.assessments.create.question_count", ... },
  ...
]

GET /api/help/admin.assessments.create.duration?locale=en
→ 200 { ... }
```

Public (anonymous) variant for the embedded help drawer in the candidate UI:

```http
GET /help/candidate.attempt.flag?locale=en
→ 200 { ... }
```

### Write (admin only)

```http
PATCH /api/admin/help/admin.assessments.create.duration
{ "short_text": "...", "long_md": "...", "locale": "en" }
→ 200 { "key":"...", "version": 4 }
```

## Telemetry

Candidate-side events go to `attempt_events`. Admin-side events go to a separate `help_usage` table. The MVP can log to `audit_log` instead.

| Event | Use |
| --- | --- |
| `help.tooltip.shown` | Shows which keys are hovered most (priority for refinement) |
| `help.drawer.opened` | Shows which pages need the most explanation |
| `help.feedback` | 👍 / 👎 for each key |

Output: a "Help health" admin report.

- Screens where users often open the drawer: the UI is unclear. Refine it.
- Screens where 👎 dominates: the content is unhelpful. Rewrite it.

## i18n hooks

- All help content carries a `locale`.
- The frontend reads the locale from `<HelpProvider locale="en">` (to be wired to the user preference).
- A missing translation falls back to `en`.

Translation workflow:

1. Export all `en` rows: `GET /api/admin/help/export?locale=en` returns JSON.
2. The translator returns JSON with new locale rows.
3. Import with `POST /api/admin/help/import?locale=hi-IN` (bulk upsert).

## What lives where

```
modules/16-help-system/
├── SKILL.md
├── components/
│   ├── HelpTip.tsx              # tooltip + (?) icon
│   ├── HelpDrawer.tsx           # right-side panel
│   ├── HelpProvider.tsx         # context + fetcher
│   └── HelpAuthor.tsx           # admin authoring UI
├── content/
│   ├── en/
│   │   ├── admin.yml            # default content shipped with v1
│   │   ├── reviewer.yml
│   │   └── candidate.yml
│   └── seed.ts                  # loads YAML → DB on first migration
├── api/
│   ├── routes.public.ts         # GET /help/:key
│   ├── routes.admin.ts          # CRUD
│   └── service.ts               # caching, version mgmt
└── docs/
    └── authoring-guide.md       # how to write good help (style, length, examples)
```

## DOM wiring coverage (2026-05-14)

`data-help-id` attributes link the backend `help_content` table to visible UI elements. The full audit ran on 2026-05-14.

| Scope | Total YAML keys | Wired to DOM | Deferred (UI not yet built) |
|---|---|---|---|
| `admin.*` (admin.yml) | 75 | 46 | 29 |
| `candidate.*` + `public.*` (candidate.yml) | 19 | 11 | 8 |
| **Total** | **94** | **57** | **37** |

- **Deferred keys** wait for features not yet shipped. Each key becomes wireable when its DOM element lands.
- Blocking features:
  - assessment creation wizard (duration, question_count, randomize, close_early)
  - grading-jobs queue UI
  - skill-drift and session-idle session banners
  - cohort heatmap color legend
  - archetype disclaimer block
  - report export-format selector
  - audit log page
  - CLI ops UI
  - candidate result and band display page
  - candidate profile page
  - public verify SPA page
  - the 9 admin keys salvaged from stash on 2026-05-13 (audit, worker, webhooks groups)
- Per-key verdict table: `docs/design/2026-05-14-phase-14-reduced-motion-audit.md` § Help-key wiring audit.

## Schema normalization (2026-05-15)

The integrity audit ran on 2026-05-14 against all 94 keys. One pass fixed the findings.

| Finding | Count | Fix |
| --- | --- | --- |
| Key-format violations | 14 keys | `HelpEntrySchema` requires `[a-z0-9_]` segments (no hyphens). All 14 hyphenated keys are renamed, for example `admin.analytics.cohort-report` to `admin.analytics.cohort_report`. Six coordinated `data-help-id` DOM renames were needed (`cohort-report.tsx`, `generation-attempts.tsx`, `pack-detail.tsx`, `attempt-detail.tsx`, `CandidateLogin.tsx` ×2) |
| `short_text` overflows | 5 keys | `admin.webhooks`, `admin.webhooks.events`, `admin.webhooks.deliveries`, `candidate.activity` and `candidate.profile.name_callout` exceeded 120 chars. All are trimmed to ≤ 120 |
| Broken `related_keys` | 1 key | `admin.settings.ai_generate_mode` referenced the non-existent `admin.settings.billing`. It now references `admin.settings.billing.budget` |
| Systemic gap | 1 | `admin-help-keys.test.ts` Block A now enforces the key-format regex. The new `candidate-help-keys.test.ts` gives parity coverage for `candidate.yml`. `STAGE_1_5_KEYS` in the admin test uses underscore spellings. Total test count: 90 (was 73) |

## Help text correction pass (2026-10-02)

| Item | Detail |
| --- | --- |
| What changed | `content/en/admin.yml` and `candidate.yml`: 29 entries corrected and 10 new entries. Keys go from 178 to 188. No key is removed or renamed |
| Seed | `0011_seed_help_content.sql` is regenerated (188 rows) |
| Migration `0146_update_help_text_corrections.sql` | Updates the global v1 row of each changed key. Adds `INSERT … ON CONFLICT DO NOTHING` for it. Inserts the 10 new keys. It is idempotent |
| Migration `0147_help_text_corrections_followup.sql` | Corrects two rows that are not in the YAML |
| Why | Help text named internal tools, models and tables. Some entries described behaviour that no longer exists. One MFA entry said recovery codes were unsupported, but the code gives 10 one-time recovery codes at enrolment |
| Impact | Four UI help ids were corrected to match their keys (see `docs/RCA_LOG.md`, 2026-10-02). No API or schema change |
| Not included | The 44 keys that have no screen stay: they record the first purpose of dormant features. The key names `admin.grading.rerun.opus` and `admin.reports.cost.empty_in_claude_code_vps_mode` keep their names, and their text is clean. The candidate login still asks for an "Organisation code"; that text waits for an owner decision |

**Rule: help rows can exist outside the YAML.** Older module migrations seeded rows such as `admin.grading.rerun` and `admin.integrations.embed-origins.add`. A migration built from the YAML does not touch them. After every help-text migration, run this on production and expect 0:

```sql
SELECT count(*) FROM help_content WHERE tenant_id IS NULL AND (long_md ~* '(opus|sonnet|wipro|anthropic|claude)' OR short_text ~* '(opus|sonnet|wipro|anthropic|claude)');
```

**Generator limit (closed 2026-10-03, see "Page help for eight pages" below).** The seed generator allows only `[a-z0-9_]` in key segments. The page prefixes `admin.tenant-settings` and `admin.generate-wizard` contain a hyphen, so they had no content. The UI id had to change first.

**Page prefixes with no content (closed 2026-10-03):** `admin.attempts.detail`, `admin.evaluations.detail`, `admin.grading.jobs`, `admin.question.editor`, `admin.reports.individual`, `admin.reports.landing`.

## Page help for eight pages (2026-10-03)

| Item | Detail |
| --- | --- |
| What changed | Both items above are closed (commit `2a15ce5`, migration `0148_seed_page_help.sql`) |
| Page ids | `admin.tenant_settings` and `admin.generate_wizard` (were hyphenated). These are help ids only: the routes `/admin/tenant-settings` and `/admin/generate-wizard` do not change |
| Content | Eight `<page>.page` entries are in `content/en/admin.yml`. The seed `0011` has 196 rows |
| Production | 203 global rows (migration 0148 applied by hand on 2026-10-03) |

**Key form.**

- `AdminShell helpPage` mounts `HelpProvider page=...`.
- The API returns the keys `LIKE '<page>.%'`.
- The (?) button in the header opens the drawer at the key `<page>.page`.
- A page id uses only `[a-z0-9_]` in each segment.

**Open (task N20).** Some help ids on a page are outside the prefix of that page, so their text cannot load.

- `admin.settings.company_name` and `admin.settings.result_release_mode` (in `tenant-settings.tsx`; pages `admin.settings.billing` and `admin.tenant_settings`).
- `admin.question.content.*` and `admin.question.ordering.*` on the question editor (page `admin.question.editor`).
- Fix: rename the ids or add keys under the page prefix. The lint RV71 would catch this class.

## N20: help ids under the page prefix (2026-10-03)

**Rule.** An element help id (`data-help-id` or `HelpTip helpId`) must start with the `helpPage` id of its page. The API returns only keys `LIKE '<page>.%'`, so other ids never get text.

Eight keys were renamed (text unchanged, migration `0149_rename_help_ids_page_prefix.sql`, idempotent for production and fresh databases). Each key is used by one page only, so none was copied.

| Old key | New key |
| --- | --- |
| `admin.settings.company_name` | `admin.tenant_settings.company_name` |
| `admin.settings.result_release_mode` | `admin.tenant_settings.result_release_mode` |
| `admin.question.content.{numeric,multi_select,ordering}` | `admin.question.editor.content.*` |
| `admin.question.ordering.{items,scoring}` | `admin.question.editor.ordering.*` |
| `admin.questions.type.subjective.rubric` | `admin.question.editor.subjective.rubric` |

**Guard.** `modules/16-help-system/src/__tests__/help-id-page-prefix.test.ts` scans admin pages. It listed 32 more violations in its ALLOWLIST with the reason "N20 follow-up". Fix each by rename (single page) or copy (shared key), then remove the entry.

## N23: the remaining 30 ids renamed (2026-10-03)

**Rule (unchanged from N20).** An element help id must start with the `helpPage` id of its page. The API returns only keys `LIKE '<page>.%'`.

| Item | Detail |
| --- | --- |
| Commit | `4ad6cc0` |
| What changed | 30 keys were renamed so that each starts with the id of its page. That covers the 32 allowlist entries: `print_review`, `sent_back` and `high_stakes.edit` are used on two pages, so the text is copied once for the second page |
| Pages | The admin pages in `modules/10-admin-dashboard/src/pages/` (assessments, assessment-detail, attempt-detail, billing, cohort-report, evaluation-detail, evaluations-queue, generation-attempts, individual-report, pack-detail, question-bank, users) and `HighStakesCard.tsx` |
| Migration | `modules/16-help-system/migrations/0155_help_ids_page_prefix_n23.sql` (renames and copies, no schema change) |
| Content | `modules/16-help-system/content/en/admin.yml`. Seed `0011_seed_help_content.sql` is regenerated. Global help rows: 200 to 203 |
| Guard | The ALLOWLIST in `help-id-page-prefix.test.ts` is empty. A new id outside its page prefix fails the test |
| Considered and rejected | Renaming the page ids instead (many more call sites). Keeping the allowlist (the text stays unloaded) |
| Not included | No text change. No new ids |

## S3 glossary pass (2026-10-09)

| Item | Detail |
| --- | --- |
| Commit and tasks | `505031a` (RW-12, RW-15) |
| What changed | 154 global keys are reworded in `modules/16-help-system/content/en/admin.yml` and `candidate.yml` to follow `docs/10-branding-guideline.md` section 2.5. 9 `short_text` values are trimmed to the 120-character cap. The seed `0011_seed_help_content.sql` is regenerated (fresh databases) |
| Migration | `0165_glossary_help_text.sql` inserts a new version for each changed key. It is idempotent (`NOT EXISTS` on identical text) |
| Shared sentence | The key `candidate.submit.confirm` uses the shared after-submit sentence |
| Tests | The help test count constant changes from 223 to 253 (fresh database) |
| Production | 0165 was applied by hand with `psql -1 -v ON_ERROR_STOP=1` and recorded with its sha256. Global help rows went from 230 to 384. `0011` is not recorded in `schema_migrations` on production (it pre-dates tracking), so it was not run again |
| Why | Help text used the old words (company, pack, evaluation, anchor, band). The page text now uses the new words, so mixed words would confuse users |
| Considered and rejected | Edit the old version rows in place (a same-key fix is a new version row). Run the seed again on production (it is not tracked there) |
| Not included | No new help ids. No change to `help_id` names |
| Downstream impact | The help test constant is 253. A fresh database and production now show the same text for the changed keys |

**Rule.** Help text follows section 2.5 of the branding guideline. Use "organisation", "question set", "assessment", "grading", "key point", "send to organisation" and the other glossary words. A new or changed key needs a word check against that table.

## Seed moved to a post-migration script (RW-40, 2026-10-11)

| Item | Detail |
| --- | --- |
| What | The global help seed is now `modules/16-help-system/seeds/help_content.sql`. Older sections above name `0011_seed_help_content.sql`: read that as this file |
| Runner | `tools/migrate.ts` runs it after all migrations (log events `seed.applied`, `seed.failed`, `seed.list`). Details: `docs/02-data-model.md`, "Post-migration seeds" |
| Why | A seed has no number and no checksum, so the generator can rewrite it |
| Not included | No change to help text or keys |
| Impact | Fresh databases have 325 global rows (was 255). Production is unchanged |

## Anonymous help on the token landing (2026-10-17)

**What changed.** `GET /api/help/public?page=<page>&locale=en` answers without a session. The route lives in `src/routes-public.ts`. `HelpProvider` retries on it when `GET /api/help` returns 401 and `page` is `candidate.take` or `candidate.attempt`.

**Why.** `GET /api/help` needs a session. The `/take/<token>` landing has none before Begin, so the tips stayed empty (RW-79 tail).

**Allowlist rule.** `page` must equal `candidate.take` or `candidate.attempt` exactly (no wildcards). Each page returns only keys that start with `<page>.`. Any other value gets 400 before the database is read. The server fixes the audience to `candidate` (the SQL adds `all`), so `admin` rows never match. Reads run in `withGlobalsOnly`, so only `tenant_id IS NULL` rows return. The caller cannot set `audience` or a key.

**Hardening.** Parameterised SQL (existing `listHelpForPage`). A short public cache header. No cookies. The route registers only when `apps/api` injects a rate limiter (`registerHelpPublicRoutes(app, { rateLimit })`); without it the route does not exist.

**Rejected.** Making `GET /api/help` itself anonymous: it would change the authenticated route and drop tenant overrides. Fastify also allows one handler per method and path.

**Not included.** Single-key anonymous reads on the new path. Other candidate pages. `TakeRoot` requests `candidate.attempt`, which the allowlist now covers; `candidate.take` keys need a second provider or call.

## Admin guide as help rows, S16 (Z-21, 2026-10-17)

**What changed.** The admin guide text now lives in help rows, not in `admin-guide.tsx`. Migration `modules/16-help-system/migrations/0192_s16_admin_guide_help.sql` adds 26 global rows. They are the `admin.guide.*` family plus `admin.activity.page`. The seeded global count goes from 462 to 488. `/admin/guide` reads the rows through the help API and renders them in order. The admin help drawer (`AdminHelp.tsx`) shows the same rows on its "Guide" tab.

**Why.** The guide was a second copy of help text inside a page file. A text fix needed a code deploy, and the drawer could not reuse it. One source means one place to edit, and tenant overrides apply.

**Considered and rejected.** Use the help-system `HelpDrawer`: it shows one entry only, and the admin drawer needs two tabs. Keep the guide in code and link to it: it keeps two copies.

**Not included.** Hindi rows. A tenant-level guide editor. New help ids for pages other than `admin.activity.page`.

**Downstream impact.** Edit guide text with a forward migration (new version row). `AdminShell` always wraps its children in `HelpProvider` with the fallback page `admin.shell`, so the drawer works on every admin page. See `docs/08-ui-system.md` section "AdminShell help drawer and account card (Z-21, S16)". `users.tsx` now wires `admin.users.list.reset_totp` through `data-help-id` (line 788).
