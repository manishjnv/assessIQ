# Pilot batch 8 (2026-10-02): SEO dates + IndexNow, ops (Caddy copy, key rotation), ordering question type, refactors

**Status:** LIVE on production (https://assessiq.in), deployed 2026-10-02 at `6336f61` (`dcded5e..6336f61`).
**Deploy:** migrations 0144 and 0145 by hand; marketing, api, worker, frontend rebuilt. Detail: `docs/06-deployment.md` § Batch 8 deploy. Adversarial review: E8 codex revise (addressed); SP7 codex revise (HIGH fixed, re-check accept).
**Scope:** the `docs/plans/BATCH_7_PROMPT.md` plan minus N7 and N9 (done in batch 7). Not browser-checked: the ordering flow.

## What changed

### F1 IndexNow (`ba51e8b`)
Key file `apps/marketing/public/51c5d2964f070d2482eecaaa2ef236e7.txt` and `apps/marketing/scripts/indexnow-submit.mjs`. The script reads the live sitemap and posts all URLs to `api.indexnow.org`. First submit: HTTP 202, 54 URLs.

### F4 JSON-LD dates and F5 sitemap lastmod (`ba51e8b`)
All 54 pages get `datePublished` and `dateModified` in JSON-LD. The sitemap gets one `lastmod` per page. Both read `apps/marketing/src/data/page-dates.json`, made by `scripts/page-dates.mjs` from git history and committed. The build throws if a sitemap URL has no entry. Live lastmod after deploy: 7 pages 2026-05-23, 1 page 05-24, 45 pages 10-01, 1 page 10-02. The 45 share one site-wide edit date in git.

### F3 Google Fonts (`6435da9`)
The stylesheet loads with `preload` + `onload` swap + `<noscript>` fallback. It was render-blocking. It already had `display=swap` and no `@import`. Numbers: `docs/11-observability.md` § 36 Marketing Core Web Vitals.

### E10 stale docs (`317cabf`)
`01-architecture-overview.md` now says Docker Compose + Caddy/Cloudflare, Claude Code CLI sync grading, PM2 removed. The api AND the worker bind-mount the claude CLI; the worker must never call it. `grading-completion-fix-plan.md` is marked DONE (`defb9f9`). The tenant-lifecycle and question-difficulty headers are updated.

### D4 onboarding runbook (`e004bd9`)
`docs/runbooks/customer-onboarding.md` (403 lines). Every step cites a live route. Gaps it records: no per-company MFA setting (env `MFA_REQUIRED`), no erased-candidates screen, no super-admin erase screen, tab warnings are automatic, release mode is set by the company admin, backups are checked over SSH only.

### E8 ops (`ea869ca`, `d0977eb`)
- `infra/caddy/assessiq.caddy`: reference copy of the AssessIQ blocks from `/opt/ti-platform/caddy/Caddyfile` (shared container `ti-platform-caddy-1`). Diff against live = 0. No secrets in it.
- Optional `ASSESSIQ_MASTER_KEY_PREVIOUS`: decrypt fallback in `modules/01-auth/src/crypto-util.ts` and `modules/13-notifications/src/webhooks/crypto.ts`. Encrypt always uses the current key.
- `tools/rotate-master-key.ts`: dry-run by default, `--apply` writes. Four columns: `user_credentials.totp_secret_enc`, `embed_secrets.secret_enc`, `webhook_endpoints.secret_enc` (layout iv|tag|ct), `tenant_settings.webhook_secret`. 9 tests.
- `docs/06-deployment.md`: "Rollback and staging" and "MASTER_KEY rotation".
- codex:rescue verdict revise: rows written under the old key behind the pass-2 cursor could be stranded. Fixed in procedure step 7 (repeat until `would_rotate=0` before removing the old key).
- Also fixed: the script path must be `/app/tools/...` (tools are mounted ro at `/app/tools`, workdir `/app/apps/api`). The old doc row listed columns that do not exist (`oauth_identities.refresh_token_enc`, `tenants.embed_secret_enc`); corrected.
- **The live key was NOT rotated.** Owner go-ahead required.

### SP7 ordering question type (`1c5ad6f`, `b3dbd7e`, `6336f61`) and X4 (`041c974`)
- Content: `{question, items 2..10, correct_order (permutation), scoring all_or_nothing|partial, explanation}`. Answer: `{order:[...]}`.
- Scoring: `orderingFraction` in `modules/09-scoring/src/mcq.ts`. Deterministic, no AI.
- Items are always shuffled per attempt and never shown in the correct order (rotate by one if the shuffle lands on it). The sanitizer sends only `question` and `items`.
- UI: Up/Down buttons in `apps/web/src/pages/take/OrderingAnswerArea.tsx`; admin views and editor (create-only; the authored order is the correct order).
- Help ids: `admin.question.content.ordering`, `admin.question.ordering.items`, `admin.question.ordering.scoring`. Migrations 0144 (type CHECK) and 0145 (help rows).
- "Pick the log line" = author as `multi_select` with log lines as options. No new type.
- Fix `6336f61`: codex:rescue found a HIGH. `remapSelected` chose the translated key from the answer's shape. A crafted MCQ answer `{selected, order:[..]}` skipped the display-to-original translation (score manipulation on shuffled MCQs). An ordering answer `{order, selected}` stored the order untranslated (identity `correct_order` = full marks). The key now comes from the question type (`listOrderingQuestionIds`). MEDIUM: an ordering question with no usable order now serves no items (fail closed). The `MAX_SHUFFLE_OPTIONS` cap in `buildOrderingOrder` is removed. This never reached prod. codex re-check: accept.
- X4 (`041c974`): design note only, KQL execution grading. NOT built. KQL is scored by hand today (`admin-manual-score`). The note recommends a Kusto emulator container.

### E9 refactors (`af33319`, `7d6f7b6`)
- 10-admin-dashboard `platform.tsx`: 2,978 to about 571 lines. Components moved to `pages/platform/{CreateCompanyForm,EditAdminModal,LifecycleConfirmModal,BillingDrawer,ManageMenu,PlatformDomainsSection,shared}.tsx`. Verified moves-only.
- 18-certification: 36 `as any` removed (all in test files) to 0.
- `44be09e`: `no-console` disable in the two marketing CLI scripts (root lint showed 6 errors); E1 evaluation-detail test timeout 15 s.

## SEO: existing work vs new work (F1/F3/F4/F5)

Rule used: keep what exists and reuse it. Add only what is missing. Never keep two copies of the same SEO data.

| Item | Before batch 8 | Batch 8 action |
|---|---|---|
| Sitemap | Inline integration in `apps/marketing/astro.config.mjs` (54 hand-written URLs, `lastmod` = build day for every URL) | Kept the integration and the URL list. Only `lastmod` changed: the real per-page date from `src/data/page-dates.json`. Build fails if a URL has no date. `@astrojs/sitemap` not used (crashes with `trailingSlash: 'never'`). |
| JSON-LD dates | 17 pages had an Article/BlogPosting node with hand-typed dates (2026-05-23 / 2026-05-24); 37 pages had no dated node | Kept the 17 existing nodes; only their date values now come from `getPageDates()` (`src/lib/page-dates.ts`). They pass `hasDatedNode`, so `BaseLayout.astro` does not add a second node. The other pages get one layout `WebPage` node with dates. `noindex` pages get none. |
| Visible dates | "Published 23 May 2026" (3 resource pages), "Updated May 2026" (3 compare pages) | Kept the same lines; value now from the helper (`formatDate`). Compare pages now read "October 2026" because git shows they changed 2026-10-01. No new visible text anywhere. |
| Fonts | `preconnect` + `display=swap` already present; no CSS `@import` | Kept both. Only the stylesheet `<link>` became non-blocking (preload + onload + noscript). Fixed the stale "@import" comment. |
| Canonical, OG, Twitter, robots meta, `robots.txt`, `llms.txt`, `BingSiteAuth.xml`, OG images, page copy | Present | Not touched. |
| IndexNow | Absent | New: key file `public/51c5d2964f070d2482eecaaa2ef236e7.txt` + `scripts/indexnow-submit.mjs` (post-deploy ping). |

Checks done: no marketing page was deleted in this batch or ever (`git log --diff-filter=D -- apps/marketing/src/pages` is empty); the sitemap had 54 URLs before and 54 after; the only lines removed from the 16 edited pages are hand-typed date values.

## Why
SEO items were open since the product review (no dates, no IndexNow, blocking font). Ops gaps (key rotation, Caddy only on the box, no rollback text) were open since the 2026-05-15 audit. Placement tests need more auto-gradable types: ordering needs no AI. Stale docs misled sessions.

## Considered and rejected
- **Build-time page dates:** the Docker context has no `.git`. Dates are generated and committed.
- **Staging on the shared VPS:** not purely additive (fixed container names, fixed ports, shared Caddy). Build off-box if wanted.
- **Sub-parts inside `log_analysis` or `scenario` for deterministic points:** breaks the one-grading-row-per-question model. One question never mixes deterministic and AI points.
- **Rewriting history for the push-gate trailer:** denied. `d0977eb` carries the trailer instead.
- **PageSpeed API for F3:** quota exhausted; local Lighthouse 12 used.

## Not included
- Live MASTER_KEY rotation (owner decides the date).
- Staging environment; KQL execution (X4); AI generation of ordering questions.
- E9 leftovers: `04-question-bank/src/service.ts`, `apps/api/src/routes/admin-super.ts`.
- Field (CrUX) web-vitals data.
- Browser click-through of the ordering flow.

## Known gaps (not fixed)
- Scenario `mcq` steps lose their options in the candidate sanitizer. 0 real items use them. The generated scenario shape `{prompt, expected}` differs from the bank schema `{id, type, ...}`. Tracked as N11.

## Downstream impact
- Marketing: edit a page, then run `scripts/page-dates.mjs` and commit the JSON, or the build fails.
- New encrypted column: add it to `TARGETS` in `tools/rotate-master-key.ts`.
- `questions_type_check` includes `ordering`; any new question-type code must handle it. Help rows 182 to 185.
- Docs updated: 02-data-model, 03-api-contract, 05-ai-pipeline (ordering), 06-deployment, 01-architecture-overview.

## How to verify on site
1. `/`, `/pricing`, `/try`, `/admin`, `/api/health` return 200. `/sitemap-0.xml` shows per-page `lastmod`.
2. `https://assessiq.in/51c5d2964f070d2482eecaaa2ef236e7.txt` returns the key.
3. Admin: create an `ordering` question (the editor shows Up/Down items), put it in a test, take the test as a candidate. Items start shuffled, never in the correct order. Submit and check the score (N12).
4. Platform page (super admin): all sections still work after the split.
