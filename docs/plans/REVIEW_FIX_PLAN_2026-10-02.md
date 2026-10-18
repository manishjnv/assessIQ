# Review fix plan — findings of the 2026-10-02 full project review, in fix order

**Status:** superseded 2026-10-16 — open items are tracked in docs/ROADMAP.md § P0-Z (rows kept here for history). Was: PLAN (revision 2, 2026-10-02 late evening). RS1, RS2, RS3 and RS5 were worked on 2026-10-02 (session n); see the marks in section 5 and section 12. RS6, RS8, RS9, RS11 were done 2026-10-03 (session p). Session q (2026-10-03): RS10 partly done (`e645d81`) and RS4 code done (`9b541ba`, deploy waits for owner). Session r (2026-10-03): RS4 live (`f9473d5`, `67919ce`, `e11cb5b`), RS10 done except owner steps (`60477e0`, `ea906d4`, `e65b993`, `90a9ddb`), plus FU-B6 (`28ab66f`), FU-C17 (`f0884bd`), N21 (`94fdc4a`, `9084a53`), E4 G4 patch (deployed). The review itself made no code, doc or server change.
**Code state at review time:** `main` at `b3dbd7e`. Production: server at `d0977eb`, API and worker image built 18:53 IST.
**Local-only file.** `docs/` is gitignored and the repo is PUBLIC. This file lists defects that are not fixed. Do not `git add -f` it.
**Roadmap entry:** `docs/PENDING_TASKS_2026-10-01.md` § P0-V (rows RS1 to RS11 point here).
**Full review tables:** `C:\Users\manis\.claude\plans\need-to-reivew-entire-piped-crane.md`.

**Revision 2 — what changed.** The owner answered three decisions and set two standing rules (section 3). The plan no longer removes dormant features. Old sessions "remove dormant code" (RS7, RS8) became a **feature review register** (section 6, items FR1 to FR25). Task IDs RV1 to RV78 did not change; some now say "review" where they said "remove".

---

## 1. Why this file exists

The owner asked for a review of all code, docs and features. The owner suspected that much code does not operate. The owner also asked for contradictions between plans, roadmaps and old/new tasks, and for stale UI in production.

Two read-only review passes ran on 2026-10-02 (9 review agents, direct checks, production row counts, live fetches).

**Verdict.** The suspicion is partly correct. The core flows operate (login, invite, take, deterministic scoring, AI evaluation by the super admin, release, certificate, billing events, data rights). Dormant code is concentrated in a few areas: the audit read side, in-app notifications, the embed package, the AI runtime stubs, the tenant grading budget and jobs, webhook delivery, and about 35 server routes with no screen. Stale text is widespread in the admin UI, the help content, the marketing site and the docs.

## 2. How to use this file

1. Do the sessions in order: RS1, RS2, … RS11. One session is one unit of commit, deploy, docs and handoff (project rule 9).
2. Before each task, **check the finding again**. Line numbers are from `b3dbd7e` and move fast. A second session was active during the review (it split `platform.tsx` and added an 8th question type, `ordering`).
3. Evidence key: **V** = verified directly by the review lead. **A** = reported by a review agent and not checked again. Check every **A** row before you act on it.
4. When a task is done, mark it here (`✅ DONE <date> <sha>`) and in `PENDING_TASKS` § P0-V.

## 3. Standing rules

### 3.1 Owner rules set on 2026-10-02 (apply to every future session)

**Rule A — Do not remove a stale or dormant feature. Mark it for review.**
Owner's reason (2026-10-02): early-stage features were built for a reason. A feature that was built long ago and is not used can still be meaningful. "It is stale for some time" is never a reason to delete it.
For each dormant feature, the review must answer:

1. What was its first purpose? (Read the design doc, the decision log, the module `SKILL.md`, the help text and the first commit.)
2. What part operates today, and what part is missing?
3. Is there a better option now?
4. Can it be improved, or joined with a newer feature?
5. Result: **revive**, **merge** into a named newer feature, **improve**, or **park** (keep the code, and mark it "parked" in the docs).

**The bar for a delete (stale UI or code).** A delete is possible only when all three conditions are true:

- (a) Detailed research is done and written down in section 6 (answers 1 to 4 above, with sources), and it shows that the feature is not needed.
- (b) The item is absolutely useless, or it does not make sense on a professional product of this kind.
- (c) The owner approves the delete of that specific item.

If any condition is not met, keep the item. The default result is "park", not "retire".

Until a feature has a review result: no delete of its code, routes, help keys, templates, tables or columns. Small dead code that belongs to a feature waits for that feature's review too (section 5, RS11 "held items").
This rule does not stop a correction of untrue or internal text that customers see. Correct the text. Keep the feature.

**Rule B — Before you implement any new task, look for a similar older task or feature.**
If one exists: read both, compare them, and implement the better version. The better version can be the old one, the new one, or a combination. Write in the task notes which old items you compared and why you chose the result.
Where to look: section 6 (feature register) and section 7 (old ↔ new pairs) of this file, `docs/PENDING_TASKS_2026-10-01.md`, `docs/plans/`, `docs/design/`, `assessiq-skill-plan.md`, module `SKILL.md` files, the help content keys, and a `git grep` of the code for the same idea.

### 3.2 Engineering rules for fix sessions

- **Parallel sessions share one work tree.** Run `git rev-parse --abbrev-ref HEAD` and `git status --short` before each commit. Do not stage files that another session changed.
- **Load-bearing paths** (project `CLAUDE.md`): `modules/00-core`, `01-auth`, `02-tenancy`, `07-ai-grading`, `14-audit-log`, `infra/`, `.env*` templates. Changes there need a line-by-line diff review and an adversarial sign-off before push.
- **Help text changes** need the seed regenerated (`pnpm help:seed:regen`) and a new migration. CI fails on seed drift.
- **Production migrations** are applied by hand and recorded one by one. `schema_migrations` has 74 rows, fewer than the migration files. Do not run the migrate tool blindly.
- **Do not drop tables or columns.**
- **Behaviour check, not bundle check.** After a UI fix, click the path in a browser. If no browser is available, write "behaviour check pending".
- **Deploy state.** At review time the API and worker image did not contain `ea869ca` (MASTER_KEY rotation) or the later code commits. Check the image build time against `git log` before you trust production behaviour.

## 4. Owner decisions

| # | Decision | Status | Effect on this plan |
|---|---|---|---|
| RO1 | Free product, or plan tiers? | **DECIDED 2026-10-02: plan tiers.** | The pricing page tiers, the paid terms and the words "plan tier" and "credits" in the admin UI are correct in principle (RV17, RV29 are no longer "stale"). Statements that "AssessIQ is free" are now the stale ones. New task PT1 (section 6): define the tiers from the old and new pieces that exist. Still open: tier contents, prices (task D2) and the payment provider (Razorpay in task D3, Stripe in `assessiq-skill-plan.md`). |
| RO2 | Dormant product surfaces: build or remove? | **REPLACED by Rule A.** No removal. Each surface gets a review (FR1 to FR25). | Old RS7 and RS8 removal work is cancelled. |
| RO3 | Keep "Organisation code" on the candidate portal login? | **DECIDED 2026-10-03: keep it for now.** | RV23: no text change on the login. |
| RO4 | MFA for tenant admins | **DECIDED 2026-10-02: optional now. To enable later.** | Keep all TOTP code. Text must say "optional" (admin guide, `PROJECT_BRAIN.md`, help). Task B4 (flip in production) stays open for a later date that the owner sets. Review lead's reading, not yet confirmed by the owner: "enable later" means one production flip; a per-tenant switch (`tenant_settings.auth_methods` exists) is an option to examine then. |
| RO5 | Keep Storybook? | **Covered by Rule A.** Review as FR18. | Do not upgrade to Storybook 10 (task N10) before the review. |
| RO6 | Three attempt emails with no sender | **Covered by Rule A.** Review as FR6. | Compare with the newer result emails. |
| RO7 | Reviewer role | **DECIDED 2026-10-02: remove the role, to keep the product simple.** | RV60 is now "remove the reviewer role" (RS8). This is the only removal in the plan. |

Also open from older sessions (owner only): approve the push-gate hook fix (N3); confirm that the Gmail app password was rotated after the 2026-05-21 leak (status unknown); recheck Google Postmaster DMARC (C6, overdue).

---

## 5. Sessions in order

### RS1 — Candidate-facing defects (do before the first real pilot drive)

Scope: `apps/web`, `modules/10-admin-dashboard`, `modules/11-candidate-ui`, `modules/16-help-system`. Not load-bearing. Deploy: frontend image only.

| # | Finding | Evidence | Ev. | Fix | Check |
|---|---|---|---|---|---|
| RV1 | **Numeric answer box keeps the text of the previous question.** `NumericAnswerArea` holds a local draft in `useState`. `AnswerArea` is rendered with no `key`. When two numeric questions follow each other, React reuses the component. The box shows the old text. The new question stays unanswered (null) until the candidate types. The aptitude pilot uses numeric questions. | `apps/web/src/pages/take/Attempt.tsx:1388-1394` (no key); `apps/web/src/pages/take/NumericAnswerArea.tsx:30` | V | Add `key={currentQuestion.question_id}` on `<AnswerArea>`. This resets local state for every answer area. Check the other answer areas for local state too (scenario, log analysis, ordering). | New unit test: render question A, type, rerender with question B, expect an empty box. Browser: two numeric questions in a row. **✅ DONE 2026-10-02 `0d02ea9`** |
| RV2 | Invite dialog says the link is "valid for 72 hours". The server gives 7 days. | `modules/10-admin-dashboard/src/pages/users.tsx:283`; server `modules/03-users/src/invitations.ts:76` | V | Say "7 days". Better: read the expiry from the API response. | Read the dialog. **✅ DONE 2026-10-02 `0d02ea9`** |
| RV3 | Invite accept page shows "Token #… · 72 h TTL", "Single-use · 72 h TTL" and "Phase 0 · 2026". MFA page footers show "Phase 0 · 2026". | `apps/web/src/pages/invite-accept.tsx:173,189,191`; `apps/web/src/pages/admin/mfa.tsx:338,340,617,619` | V / A | Remove the internal text. Say "7 days". | Read both pages. **✅ DONE 2026-10-02 `0d02ea9`** |
| RV4 | Three help IDs use a hyphen in the UI and an underscore in the content. The help never shows. A fourth ID lacks ".list". | UI `candidate.auth.expiring-soon` (`CandidateSessionBanner.tsx:108`), `candidate.cert.completion-modal`, `candidate.cert.share-linkedin`; content `candidate.yml:354,458`; UI `admin.assessments.content_source` vs content `admin.assessments.list.content_source` | V | Change the UI IDs to match the content keys. | Help tip opens with text. **✅ DONE 2026-10-02 `0d02ea9`** |
| RV5 | Admin certificate drawer shows and links the old domain `assessiq.automateedge.cloud`. | `modules/10-admin-dashboard/src/pages/certificates.tsx:1214,1224` | V | Build the URL from the configured public base URL or `window.location.origin`. | The link opens `assessiq.in/verify/<id>`. **✅ DONE 2026-10-02 `0d02ea9`** |

### RS2 — Brand and untrue text on admin screens

Scope: `apps/web`, `modules/10-admin-dashboard`, `modules/17-ui-system/src`. Not load-bearing. Read `docs/10-branding-guideline.md` and load the `ui-design-workflow` skill first. Deploy: frontend image. **Rule A applies: correct text, keep features.**

| # | Finding | Evidence | Ev. | Action | Check |
|---|---|---|---|---|---|
| RV6 | The live web manifest says `"name": "AccessIQ"`. | `modules/17-ui-system/AssessIQ_UI_Template/brand/favicon/site.webmanifest:2-3`, copied by `apps/web/scripts/copy-brand-assets.mjs`; live at `https://assessiq.in/brand/favicon/site.webmanifest` | V (live) | Project rule 7: do not rewrite kit files, update the consumer. Ship a corrected manifest from `apps/web/public` and point `index.html:14` to it. | `curl` the live manifest. **✅ DONE 2026-10-02 `578c0aa`** |
| RV7 | The app link-preview image shows "AccessIQ" and the domain "accessiq.io". It is live for every app page. The marketing site uses its own image and is correct. | `…/brand/social/og-image.png` and `.svg:24`; `apps/web/index.html:18` | V (live) | Make a corrected image (AssessIQ, assessiq.in) in `apps/web/public`. `try-og.png` is a model. | Open the live PNG. **✅ DONE 2026-10-02 `578c0aa`** |
| RV8 | Settings page: a card "Your monthly grading limit: 100 grading runs per month" that names a "Grade all" button; a "Why a limit?" card; a "Coming soon: per-tenant billing" card; a "Technical details" box with "Phase 2 — Max OAuth", "Claude Max", "Anthropic API key", `tenant_grading_budgets`, "Phase 3". | `modules/10-admin-dashboard/src/pages/billing.tsx:113-114,334-437` | V | Correct the untrue and internal text now (tenant admins cannot start AI; no budget is enforced). **Keep the card area**: the budget idea is under review as FR7 and is a natural home for the plan-tier usage limit (PT1). | Read `/admin/settings` as a tenant admin. **✅ DONE 2026-10-02 `578c0aa`** |
| RV9 | Menu item "Grading" opens a page with a "Coming soon" card and engineer notes. No API call. | `AdminShell.tsx:261`; `apps/web/src/App.tsx:92`; `pages/grading-jobs.tsx:149-198` | V | **Do not remove.** Remove only the engineer notes and say what is true today (AssessIQ evaluates written answers; results come to "Ready to publish"). The page is under review as FR8 (possible tenant "evaluation status" page). | Read the page. **✅ DONE 2026-10-02 `578c0aa`** |
| RV10 | Admin guide: steps 1 to 5 tell a tenant admin to author packs (super admin only); "TOTP MFA enrolled" as a prerequisite; 4 old question types and "Code paste"; "audit log page is coming soon". | `pages/admin-guide.tsx:371,397,424-495,458-461,654,673-674,721` | V | Write the guide again: licensed sets, clone, build an assessment, sections, calculator, integrity, invite, release modes; the 8 current types; MFA "optional, recommended" (RO4); plan and credits wording stays (RO1). Keep the audit sentence neutral until FR1 has a result. | Owner reads the guide. **✅ DONE 2026-10-02 `578c0aa`** |
| RV11 | The "Help content" admin page calls 4 routes that do not exist. The server has other paths (`/api/admin/help/export`, `PATCH /api/admin/help/:key`, `POST /api/admin/help/import`). No menu links to the page. | `pages/help-content.tsx:51,72,87,105`; `modules/16-help-system/src/routes-admin.ts:45,64,90`; route `App.tsx:99` | V | **Do not remove.** Review as FR14 (help authoring and translation). No interim change: no menu reaches the page. | — **OPEN: waits for feature review FR14** |
| RV12 | Tenant settings has a fallback call to `/admin/me`. That route does not exist. | `pages/tenant-settings.tsx:263-265` | V | Rule B first: find what `/admin/me` was meant to return (probably replaced by `whoami`). Then point the fallback to the current route, or drop only the dead call. | Typecheck. **✅ DONE 2026-10-02 `578c0aa`** |
| RV13 | Pack detail sends one `generation-attempts` request for each level. For a tenant admin each returns 403. | `pages/pack-detail.tsx:347-370`; server `modules/04-question-bank/src/routes.ts:1081-1082` (A) | V (code) | Send the request for the super admin only. | Network tab: no 403. **✅ DONE 2026-10-02 `578c0aa`** |
| RV14 | Cohort report: the radar chart always shows zero. It gets `archetype_distribution` (label → count). The chart reads behaviour signal keys (`tab_blur_count` and others). | `pages/cohort-report.tsx:139`; `components/ArchetypeRadar.tsx:23-30` | V | Give the chart the right data, or show the distribution as bars. Keep the radar component: it is under review as FR11 (behaviour and integrity profile). | The chart shows real numbers. **✅ DONE 2026-10-02 `578c0aa`** |
| RV15 | All tenants use the demo fixture `TENANT_FIXTURES['wipro-soc']` as theme. | `apps/web/src/App.tsx:57`; `modules/17-ui-system/src/fixtures/tenants.ts:11-13` | V | Rename to a neutral default. Note for FR15: the fixture shows that per-tenant theming was planned (white-label). | `grep -i wipro` on the build output. **✅ DONE 2026-10-02 `578c0aa`** |
| RV16 | Smaller items: dashboard counters stop at 50; attempt detail shows "details pending backend enrichment"; generation history and the wizard list 5 types and miss the new ones; a role mismatch sends the user to the login page with no message. | `pages/dashboard.tsx:91,108-110`; `pages/attempt-detail.tsx:178`; `pages/generation-attempts.tsx:192`; `pages/generate-wizard.tsx:705`; `apps/web/src/lib/RequireSession.tsx:71-76` | A | Fix when the file is open for another task. | — **✅ DONE 2026-10-03 `511e1af`, `4ea20a8`.** Dashboard counters come from the server (`counts`). The attempt-detail text is now "Candidate details are not available". The role mismatch shows "You do not have access to this page." The type-list item needed no change: AI generation supports exactly five types by design (`modules/04-question-bank/src/difficulty-spec.ts:96`); the history table now also shows any other type the server returns. |
| RV17 | "Plan tier", "Credits used", "Included", "Over limit" in the Settings page, the usage banner and the dashboard. | `billing.tsx:273-320`; `components/UsageBanner.tsx:42-60`; `dashboard.tsx:233` | V | **Not stale (RO1 = plan tiers).** Make the words the same as the tier names from PT1 and the pricing page. | — **no change needed (wording is correct now)** |

### RS3 — Help content: correct text, keep keys

Scope: `modules/16-help-system/content/en/*.yml` plus a new help migration and the regenerated seed.

| # | Finding | Evidence | Ev. | Action |
|---|---|---|---|---|
| RV18 | Help text shows internal words to customers: "Claude", "Opus", "Sonnet", "Stage 2/3", table names, a raw SQL `UPDATE`, repo paths, "Phase 1/2/3". | `admin.yml:44-61,71,77,1236-1237,1257-1270,1274,1281,1302-1318,1341,1496-1520,1644-1678,3087-3102` | A | Rewrite in plain product words. **✅ DONE 2026-10-02 `8113192`, `8cc46c2`** |
| RV19 | Untrue entries for screens that exist: a tenant AI budget that blocks grading, tenant "re-run with Opus", Google-only sign-in, an email template editor. | `admin.yml:488-489,989-1005,1236-1318,1496-1520` | A | Correct the text. "Credits" and "plan tier" wording stays (RO1). **✅ DONE 2026-10-02 `8113192`, `8cc46c2`** |
| RV20 | 44 content keys have no screen: audit log, worker, webhooks, cost report, CLI operations, generate questions, skill drift, grading queue, short-poll notifications, tenant slug sign-in. | `admin.yml:16-29,116-150,591-605,647-761,1141-1164,1320-1331,1731-1788,1817-1883,2139-2393` | A | **Do not remove (Rule A).** These entries describe the first purpose of the dormant features. Use them as input for FR1, FR2, FR5, FR8, FR9, FR17. Remove the word "wipro" only. **✅ DONE 2026-10-02 `8113192`, `8cc46c2`** |
| RV21 | 10 UI keys and 12 page prefixes have no content. Examples: `admin.attempts.release_confirm`, `admin.attempts.print_review`, `admin.activity.feed`; prefixes `admin.attempts.list`, `admin.dashboard.home`, `admin.users.list`, `admin.tenant-settings`, `admin.evaluations.queue`. | Key comparison in review pass 2 | A | Write the content. **✅ DONE 2026-10-02 `8113192`, `8cc46c2` (10 keys written).** **Remainder ✅ DONE 2026-10-03 `2a15ce5` (migration 0148): ids renamed to `admin.tenant_settings` and `admin.generate_wizard`; 8 `<page>.page` entries added (production help rows 195 to 203). Follow-up N20: help ids outside their page prefix.** |
| RV22 | Content errors: a paragraph pasted into the wrong entry (`platform.mfa_code`); two certificate revoke entries contradict each other; candidate text says KQL gets "AI rubric review"; consent text says the "assessment admin" reviews answers. | `admin.yml:1030-1031,1991-2001,2051-2057`; `candidate.yml:9-24,71-73,87-90,131-132` | A | Correct. **✅ DONE 2026-10-02 `8113192`, `8cc46c2`** |
| RV23 | Candidate portal login asks for "Organisation code". | `apps/web/src/pages/candidate/CandidateLogin.tsx:127-131,326-340` | V | RO3 DECIDED 2026-10-03: keep "Organisation code" for now. **No change needed on the login.** |

### RS4 — Marketing truth pass 2

**Status 2026-10-03: ✅ DONE and LIVE (`9b541ba`, RV24 to RV28; RV27 completed in `f9473d5`; page dates `67919ce`; PT1-6 terms `e11cb5b`; marketing rebuilt twice, IndexNow 200, 42 URLs).** Earlier note: code DONE. Integrity v1 claims fixed; CSV limits 1,000 (200 with invitations); 12 coming-soon pages `noindex,follow` and out of the sitemap; unsourced competitor numbers removed; privacy page RV28 paragraphs are DRAFT. The marketing container is NOT rebuilt: it waits for owner approval of the text. Some competitor figures stay with "publicly states" (for example hackerearth 40,000+). Owner decides.

Scope: `apps/marketing`. Deploy: marketing image, then page-dates regeneration and the IndexNow ping (`docs/06-deployment.md`).

| # | Finding | Evidence | Ev. | Action |
|---|---|---|---|---|
| RV24 | About 25 places say AssessIQ has no tab-switch detection or no lockdown, or call integrity "coming soon". The product has integrity v1: fullscreen gate, copy block, tab-switch warning. | `alternatives/{amcat,hackerrank,imocha,mettl,hackerearth}.astro`, `compare/assessiq-vs-{mettl,hackerearth,imocha}.astro`, `glossary/proctoring.astro:91`, `methodology.astro:325,334`, `resources/remote-proctoring-integrity.astro:268,341,375,409`, `security.astro:66-83`, `pricing.astro:64,96,120,138,163`, `alternatives.astro:249`, `solutions/*` | V (5 pages) / A | State what integrity v1 does. Keep "no webcam proctoring, no lockdown browser". Also correct the FAQ JSON-LD copies. |
| RV25 | "CSV import (up to 200 per import)". The real limit is 1,000. | `alternatives.astro:267`, `compare/assessiq-vs-hackerearth.astro:332`, `compare/assessiq-vs-imocha.astro:163`, `solutions/*`, `tests/aptitude.astro:36`; code `modules/03-users/src/import.ts:16` | V | Say 1,000. |
| RV26 | 12 "coming soon" pages are in the sitemap with no `noindex` (7 test pages, 5 role pages). | `astro.config.mjs:50-70`; `tests/*.astro`, `tests/role/*.astro` | A | Keep the pages (Rule A). Add `noindex` until the packs exist. Rule B: join with task F2 (new SEO pages). |
| RV27 | Competitor numbers have no source next to them. | `alternatives.astro:82,96,103`; `compare/assessiq-vs-mettl.astro:129`; `alternatives/mettl.astro:81` | A | Add the source or remove the number. **✅ DONE 2026-10-03 (`9b541ba`; follow-up `ac39f6e`: "publicly states" figures removed by owner decision; open: iMocha "3,000+" on alternatives/imocha.astro).** |
| RV28 | Privacy page does not say that integrity events are recorded. Clarity is not in the sub-processor list. Google Fonts loads from a third party. | `privacy.astro:~105,277-280`; `layouts/BaseLayout.astro:120-139` | A | Add the statements. Owner approves legal text (task D1). |
| RV29 | Pricing page: 3 tiers. Terms page: paid plans that renew. `llms.txt` repeats it. | `terms.astro` §7; `pricing.astro:80-145,232`; `public/llms.txt` | V / A | **Not stale (RO1 = plan tiers).** After PT1: make the tier contents true (each listed feature must exist or say "coming soon"). |
| RV30 | "Signed webhooks" is listed as a feature. Webhooks send only part of the audit events and have no screen. | `pricing.astro:115,316`; `terms.astro:140` | A | Wait for FR2. Until then say "coming soon". |
| RV31 | Smaller items: the About page button "Try the platform" links to `/admin/login` (should be `/try`); "score, band and rationale" promised to each team member; terms say the customer keeps "questions it creates"; three vendors have both an "alternatives" page and a "compare" page with shared text. | `about.astro:157`; `solutions/team-skill-gap.astro:123`; `terms.astro` §5 | A | Correct the text. For the page pairs: Rule B, compare both and keep the better one as the main page. |

Checked and clean: no customer logos, no testimonials, no invented ratings or prices in JSON-LD, no SOC 2 or ISO claim, no sign-up button, no "expert-verified" claim. The contact form posts to `/api/contact`, which exists.

### RS5 — Docs truth pass

Scope: root docs, `docs/`, module `SKILL.md` files, `.env.example`, memory notes. No deploy. `.env.example` is a load-bearing path. Edit the project `CLAUDE.md` only with owner approval. Tracked docs are public: describe behaviour as built.

| # | File | Stale statement → current fact | Ev. |
|---|---|---|---|
| RV32 | `PROJECT_BRAIN.md` | React 18 → React 19.3, Vite 8 (line 34). "nginx + Let us Encrypt" → Caddy + Cloudflare (38). BullMQ for "async grading jobs" → no AI on a queue (31). "TOTP MFA mandatory" → optional for tenant admins, to enable later; always on for the super admin (36). Module map stops at 18 → add 19-billing, 20-data-rights (44-62). "SOC pack ships first", `tenant: wipro-soc` → first use is the aptitude pilot (9, 18). Prompt path → prompts are on the server only (115). Email: Resend → Brevo, `connect@assessiq.in` (85). Build-phase table stops at Phase 5 → add the pilot batches and SP1 to SP11. "Admin remains desktop-only" → admin is responsive (106). Role list "admin/reviewer/candidate" → reviewer role to be removed (RO7). **Add the decision-log rows of 2026-10-02: plan tiers; MFA optional; reviewer role removed; Rule A; Rule B.** Add Rule A and Rule B to "Working agreements". | V **✅ DONE 2026-10-02 `f40400c`** |
| RV33 | Project `CLAUDE.md` (owner approval) | Folder `{docs,modules,infra}` no longer exists (153). SDK path lacks `src/` (61). "nginx configs", "single nginx site file" (31, 81). Footer "4-line" → sessions write 6 lines. **Proposal: add Rule A and Rule B to "AssessIQ-specific hard rules".** | V **OPEN: needs owner approval (proposal: remove the stale `{docs,modules,infra}` caveat, fix the SDK path, say Caddy for nginx, footer line count, add Rule A and Rule B)** |
| RV34 | `README.md` | "Get an Anthropic API key for production AI grading" (135) conflicts with the hard rule in `.env.example:165`. "No bootstrap script exists" (46). Map lists docs 01-10 and modules 00-17. | V **✅ DONE 2026-10-02 `f40400c`** |
| RV35 | `.env.example` (load-bearing) | Missing: `CERT_SIGNING_SECRET`, `SUPER_ADMIN_EMAILS`, `PLATFORM_TENANT_ID`, `LOG_DIR`, `STAGE3_WATCH_LOG`, `MCP_REJECTION_LOG`. Stale: Resend text and `EMAIL_FROM=noreply@assessiq.in`. `SENTRY_DSN` is declared and never used (keep: alerting task B2). | V (first item) / A **✅ DONE 2026-10-02 `f40400c`** |
| RV36 | `docs/03-api-contract.md` | Certification endpoints "501 Not Implemented" (1988-1989) → live. Candidate `/result` "202 grading_pending" rows (1281, 1445) keep old text beside a superseded note. "Release on the last accept" as an explicit call (2716) → built (`809e807`, `23c9f0b`). | A **✅ DONE 2026-10-02 `f40400c`** |
| RV37 | `docs/06-deployment.md` | Skill deploy: "A `git pull` alone is sufficient" (483-484) → deploy is by `scp`. Email blocks at 246 and ~812 show old senders. | A **✅ DONE 2026-10-02 `f40400c`** |
| RV38 | `docs/01`, `docs/08` | React 18 (`01:80`, `08:248,504`). `ViewportLock` "fully implemented" (`08:755-771`) → deleted in `c8349df`. Old token colour values (`08:54-56`). Task E10 says DONE, but these remain. | A **✅ DONE 2026-10-02 `f40400c`** |
| RV39 | `docs/05`, eval README, `docs/09`, `docs/11`, `docs/12`, `docs/13`, `docs/14`, `docs/plans/SCORING_RESULT_RELEASE.md` | Eval set "250 cases in the repo" → 150 cases, 3 types, on the server only. Integration guide promises `attempt.submitted` and `attempt.graded` webhooks → only `audit.*` events exist (input for FR2). Observability says "SMTP/SES". Test coverage doc audits 19 of 21 modules. Email system doc says "before Phase E1 starts". Credentialing doc lists shipped parts as "not in this doc". **"AssessIQ is free; there are no customer payments" → plan tiers (RO1).** | A **✅ DONE 2026-10-02 `f40400c`** |
| RV40 | Module `SKILL.md` files | 06: "apps/worker does not exist yet", `/result` 202. 07: "Pattern-match KQL" → no KQL grader (input for FR21). 02: `tools/migrate.ts` "deferred". 10: "12 live pages". 13: "Resend as default". 17: four components "deferred" that exist. 19: status "A1 complete" → B1, B2 shipped. 01: invite TTL "72 hours". 05: `SmtpNotConfigured` 503 that does not exist (input for FR15). 11: "Deferred to Session 4b". 18: "Sessions 1–8". | A **✅ DONE 2026-10-02 `f40400c`** |
| RV41a | Plan and design headers | Add "DONE <sha>" to 12 files whose header says draft, proposed or not started. Add "SUPERSEDED" to `docs/design/global-competitiveness-roadmap.md`. Rename `BATCH_7_PROMPT.md` to batch 8. | A **✅ DONE 2026-10-02 `f40400c`** |
| RV41b | `docs/PENDING_TASKS_2026-10-01.md` | Close rows that are done but read as open: A8, R10, A9, R3, R5, R6, D7, R7, R9, D4, F1, F3, F4, F5, part of E8. Correct SP10. Open E10 again. Close B5 as a duplicate of N5. Add rows for items that disappeared (section 7). Give every task one ID that is used once (N1 to N10 and `H1` are used two times; OD8 is not defined). Replace line-number references to `SESSION_STATE.md` with entry titles. | A **✅ DONE 2026-10-02 `f40400c`** |
| RV41c | Memory notes | Check and correct about 10 notes (`auto-stash-hook`, kit folder name notes, `clone-attempt-version-model`, `entitlement-b1-b2-contract`, `scoring-release-rules`, `billing-events-grade-commit-critical-path`, `grading-proposals-cache`, `vps-shared-host`, `origin-verify-ip-spoof`). Owner must confirm three: orchestration model, OpenRouter Tier 2, "no real candidate data". | A **OPEN: memory notes pass not done** |

### RS6 — Feature review (read-only; replaces the old "remove dormant code" sessions) — DONE 2026-10-03 (read-only; results in RS6_FEATURE_REVIEW_A–D.md)

Do the reviews in section 6, in the order given there. Each review is a short read-only study with a written result in section 6. No code change in this session. Expect 2 to 3 sessions. Start with PT1 (plan tiers), because RS2 and RS4 wording and several features depend on it.

### RS7 — Work that the feature review releases

A task enters RS7 only after its feature has a result of "revive", "merge" or "improve". Known first entry:

RS7 candidate list = the follow-up tasks FU-A*, FU-B*, FU-C*, FU-D* whose result is revive, merge or improve; see PENDING_TASKS § P0-V.

| # | Finding | Evidence | Ev. | Action |
|---|---|---|---|---|
| RV43 | **Embed cannot create a new candidate.** The JIT user insert writes `password_hash` and `email_verified` into `users`. The production `users` table has neither column. A new embed candidate gets a SQL error. The module's own SKILL.md lists this as "BUG-A, not fixed". | `modules/12-embed-sdk/src/jit-user.ts:61-66`; production `information_schema` check 2026-10-02; `modules/12-embed-sdk/SKILL.md:339` | V | After FR4: correct the insert and add a DB-backed test that runs the real insert. Auth-adjacent: adversarial review. |
| RV44 | `packages/embed-sdk` (`@assessiq/embed`) is never built or imported. `/embed/sdk.js` serves a small inline SDK that works. `verifyEmbedOrigin` has no caller. Embed admin routes have no screen. | `apps/api/src/routes/auth/embed.ts:123-160`; `modules/12-embed-sdk/src/origin-verifier.ts` | A | Decide in FR4 (Rule B: compare the inline SDK and the package; keep the better one). |

### RS8 — Load-bearing modules: decided change and defects — DONE 2026-10-03

Every change here needs a line-by-line diff review and an adversarial sign-off before push.

| # | Finding | Evidence | Ev. | Action |
|---|---|---|---|---|
| RV60 | **✅ DONE 2026-10-03 (`4cd6c8d`, `4374344`, `7ca7cfb`, `a50d573`; adversarial review Sonnet takeover: accept, 5 LOW; follow-ups in N26; record in `docs/04-auth-flows.md` § Reviewer role removed).** **Remove the reviewer role (owner decision RO7).** Today a reviewer cannot open any admin page: `RequireSession` passes only an exact role match or the super admin, and every admin route asks for `role="admin"`. Production has 0 reviewers. | `apps/web/src/lib/RequireSession.tsx:64-78`; `apps/web/src/App.tsx:87-117`; `AdminShell.tsx:227,258-286`; email-OTP eligibility `role∈{admin,reviewer}` in `modules/01-auth/src/email-otp.ts`; role types in `modules/03-users`; rate-limit bypass text "admin/reviewer"; help `admin.yml:71,77`; docs `04-auth-flows.md`, `PROJECT_BRAIN.md` | V | Rule B first: write down the first purpose (a person who reviews grades and reads reports, with no admin rights) and confirm that the tenant admin "review, override, publish" screen (SP10) covers it. Then: stop new reviewer invites, remove the role from the UI (menu, guards), the server role lists and the help text. **Leave the value in the database CHECK constraints.** Before the change, check production again for reviewer users; if any exist, ask the owner (convert to admin or disable). |
| RV59 | **✅ DONE 2026-10-03 `5e5aaa3`.** `createTenant` ignores its `_createdBySuperAdminUserId` parameter and may write no audit row. Rule: every admin mutation writes one audit row in the same transaction. | `modules/02-tenancy/src/service.ts:149` | A | Confirm. If true, it is a defect: fix it. |
| RV58 | **✅ DONE 2026-10-03 `487707d`.** Status `pending_admin_grading` is never written. It is in the DB CHECK, the types and about 15 status lists. The dashboard counter for it is always 0. | No `UPDATE … pending_admin_grading`; readers: `06 service.ts:1036`, `09 finalize.ts:73`, `07 repository.ts:562,719`, `handlers/admin-grade.ts:399`, `15 repository.ts:61,97,375`, `10 pages/attempts.tsx:20` | V | **Do not remove (Rule A).** Review as part of FR8: the status was meant for "submitted, waits for a person to start grading". It can be the right state for the platform evaluation queue. Interim: correct the dashboard counter so it counts the real waiting attempts. |
| RV54, RV55, RV56, RV57, RV61 | Audit read side, webhook fan-out, tenant grading budget, grading-jobs handlers, AI runtime stubs. | See FR1, FR2, FR7, FR8, FR9 | V | **No removal.** Moved to the feature register. |

### RS9 — Function defects that need a check first — DONE 2026-10-03

| # | Finding | Evidence | Ev. | Action |
|---|---|---|---|---|
| RV62 | **✅ DONE 2026-10-03 `b0c09fd`, `a7ea234`.** Generate wizard "topic focus" only narrows the knowledge sources. It does not reach the AI prompt. | `04 service.ts:1639,1695,1751-1765`; `07 handlers/admin-generate.ts:72-144,530,764`; `runtimes/claude-code-vps.ts:598,765` | A | Confirm. Then pass it to the prompt variables. Module 07: gate. |
| RV63 | Assessment preview counts the live pool. Candidates draw from the frozen pool. | `05 service.ts:2257,2304` vs freeze at `:1113,1353` | A | Confirm. Then read the frozen pool when one exists. **✅ DONE 2026-10-03 (`afc5069`).** |
| RV64 | **✅ DONE 2026-10-03 `8723dc4`, `a7ea234`.** Question generation has three near-copies of the same steps, about 220 lines, and they have drifted. A sharded run where all chunks fail finalizes the same row two times. | `07 handlers/admin-generate.ts:604-615,618-750,776-861,927-1043,1069` | A | Rule B applies inside the code: compare the three copies, keep the best behaviour of each (topic de-duplication is in two of three), and make one shared function. Module 07: gate. |
| RV65 | Known gap, status not confirmed: `GET /api/admin/attempts/:id/score` may show totals that are graded but not released. | `PENDING_TASKS` § P0-S known gaps | A | Confirm. Migration 0122 fixed the reports view only. **checked 2026-10-03: not a defect — release rule already enforced in `09-scoring` `getTenantVisibleAttemptScore` and every other tenant read path.** |
| RV66 | `consent_events` has 0 rows and 0 inserts in production. The consent step shipped with task R4. | Production table statistics 2026-10-02 | V | Confirm where consent is recorded. If nowhere, it is a defect for the pilot (DPDP). **checked 2026-10-03: not a code defect — the consent writer exists (`06` `service.ts` `recordTakeConsent`); 0 rows because no attempt started since the consent step shipped.** |
| RV67 | `sharded` generation is on for 2 tenants; 3 tenants and the global default use `omnibus`. | Production `tenant_settings`, `AI_GENERATE_MODE=omnibus` | V | No fix. Input for task E4. Keep both paths until E4 decides. |

### RS10 — Guards that were promised and never added

Source: `docs/RCA_LOG.md` "Prevention" lines against the repo (check each before work). Rule B: for each guard, look for an older partial tool first.

| # | Promised guard | State |
|---|---|---|
| RV68 | Push-gate hook parses JSON without `jq`, or fails closed (task N3) | ✅ DONE 2026-10-03 (`60477e0`): jq or node parse, fails closed; self-test with 5 cases. |
| RV69 | React `rules-of-hooks` lint in CI | ✅ DONE 2026-10-03 (`e645d81`): error level, only that rule; React Compiler rules not adopted. |
| RV70 | `apps/web` unit tests in CI (11 files run nowhere) | ✅ DONE 2026-10-03 (`e645d81`). |
| RV71 | Lints: data-model anchors, vitest configs, skill mount, `public/` names against SPA routes | ✅ DONE 2026-10-03 (`ea906d4`): doc-anchors, vitest-coverage, skill-mount, public-collisions lints with self-tests. |
| RV72 | `tools/lint-mv-tenant-filter.ts` in CI | ✅ DONE 2026-10-03 (`e645d81`): CI step + `pnpm lint:mv-tenant-filter[:self-test]`. |
| RV73 | Backup dead-man alarm; daily offsite backup (task R8); k6 load run | 🟡 Code DONE 2026-10-03 (`e65b993`, `90a9ddb`): k6 script kept at `tests/load/scenarios/candidate-drive.js`; `tools/ops/assessiq-backup-check.sh` with self-test and systemd units. NOT installed; heartbeat account and offsite backup R8 are owner steps. Earlier note: Two k6 scripts exist (`tests/load`, `tools/load`): compare and keep the better one. |
| RV74 | A general guard for the most frequent incident class, "UI and server contract mismatch" (8 or more incidents) | ✅ DONE 2026-10-03 (`ea906d4`): `ui-api-contract` check (167 UI calls, 225 routes, 4 allowlist entries = FR14/FU-D1). Original note: Proposal: a CI test that checks every `adminApi("/…")` path against the registered routes. |
| RV75 | A check that `.env.example` and `modules/00-core/src/config.ts` list the same variables | ✅ DONE 2026-10-03 (`e645d81`): CHECK C of `lint-deploy-procedure` extended (old tool reused, Rule B); self-test C-5. |
| RV79 | **New (Rule B support):** a short "old task or feature checked" line in each task note and each session handoff. | Not done. Add to the handoff template in RS5. |

### RS11 — Last: end-to-end tests, duplicates, held items — DONE 2026-10-03

| # | Finding | Evidence | Action |
|---|---|---|---|
| RV76 | **✅ DONE 2026-10-03 (`09595fa`).** `admin-workflow.spec.ts` has 18 skips. Its fixture grades and creates packs as a tenant admin; both now return 403. Two take specs are skipped for a reason that is no longer true. The visual baseline folder is empty. | `apps/web/e2e/admin-workflow.spec.ts`; `fixtures/factories.ts:482`; `take-happy-path.spec.ts:3`; `take-timer-expiry.spec.ts:4` | Do with task E13 (LAST). Rule B: compare with the old manual script `tests/e2e/walkthrough*.ts` and reuse its steps. |
| RV77 | **🟡 PARTLY 2026-10-03: CSV guard done (`7accd3f`); AES helpers and Lua copies moved to N24 (load-bearing, codex gate).** Duplicate code: three AES-256-GCM helpers; the same rate-limit Lua script in three files of module 01; five CSV escape functions, and only one has a formula-injection guard (`15-analytics/src/results-export.ts:24`). | `01-auth/src/crypto-util.ts`, `13-notifications/src/webhooks/crypto.ts`, `12-embed-sdk/src/webhook-secret-service.ts`; `01-auth` rate-limit, candidate-login, email-otp | Rule B inside the code: compare the copies, keep the best one. The crypto merge is load-bearing. Give every CSV export the formula guard early (small security fix). |
| RV78 | **✅ DONE 2026-10-03 (facts recorded in `docs/02-data-model.md`).** Migration numbers: five numbers are used by two files each; some numbers are missing; `0057` is a no-op. | `git ls-files 'modules/*/migrations'` | Do not renumber. Record the facts in `docs/02-data-model.md`. |
| Held | Small dead code that waits for its feature review (Rule A): unused private functions (`_notImplemented`, `_rethrowUnique`), legacy guards in `03-users/src/invitations.ts:54-68`, `email-stub.ts` bodies, about 15 unused workspace dependencies, three stale comments, `ProgressBar` / `Placeholder` / `useReducedMotion`, `auto-weight.ts` in module 10, stray files (`google-sso.ts.p1bak`, `BingTrackingCode.md`). | First report tables A and B; pass 2 | Touch each item only after the review of the feature it belongs to. Stray files: owner confirms. |

---

## 6. Feature review register (Rule A)

**How to do one review.** Read-only. (1) Read the first design: the decision log in `PROJECT_BRAIN.md`, the phase kickoff plan, the module `SKILL.md`, the help keys (RV20), the first commit. (2) Run or trace what operates today. (3) Name the newer feature that overlaps. (4) Write the result here: revive, merge into X, improve, or park. A delete needs the three conditions of Rule A (written research, absolutely useless or not fit for a professional product, owner approval). (5) Add the follow-up task to `PENDING_TASKS`.

The column "First idea" is the review lead's guess, not a decision.

| # | Dormant feature | What exists today | First purpose (source) | Newer feature it overlaps | Questions for the review | First idea |
|---|---|---|---|---|---|---|
| PT1 | **Plan tiers (define them)** | `19-billing` usage events, entitlements, "credits used / included / over limit" UI; pricing page with Starter, Growth, Enterprise; terms §7 | Monetization spec `docs/superpowers/specs/2026-05-17-platform-monetization-entitlement-design.md`; tasks D2, D3; `assessiq-skill-plan.md` module 21 | FR7 budget, FR2 webhooks, FR3 API keys, FR4 embed, FR1 audit viewer, FR15 tenant SMTP, FR9 paid AI mode | What does each tier include? Which dormant features become tier features? Which provider (Razorpay or Stripe)? | One tier table that maps each feature to a tier, written from the old pieces. Do first. **Result 2026-10-03:** improve — see RS6_FEATURE_REVIEW_A.md § PT1. |
| FR1 | Audit log viewer, export, archive | Write side is live (952 rows). Read routes exist but are never registered (`14-audit-log/src/routes.ts:68`). Archive job never starts and has no S3 code. Help keys `admin.audit*`. | Phase 3 G3.A: "HR-grade audit trail", list, CSV/JSONL export, S3 archive | Admin Activity page (`15-analytics` activity feed); data-rights export (module 20); retention cron (`retention_days`) vs `audit_retention_years` | Does the Activity page cover the need? Is an export needed for compliance buyers? Two retention ideas: which one wins? | Revive the viewer and export as an Enterprise tier feature. Merge the two retention ideas. **Result 2026-10-03:** revive viewer and export, merge with Activity entry point, park S3 archive — see RS6_FEATURE_REVIEW_B.md § FR1. (register correction: help text describes a `/admin/audit` page that does not exist) |
| FR2 | Webhooks | Endpoints, deliveries, replay, test event, signed V2, SSRF guard, retry. Fan-out only from `audit()`; 35 files use `auditInTx`, which does not fan out. Event names are always `audit.<action>`. No screen. Production: 0 endpoints. | Phase 3 G3.B and P3.D16 "SIEM forwarding"; product surface 3 "REST API + webhooks"; integration guide promises `attempt.submitted`, `attempt.graded` | Result release events (SP2, SP10), invitation reminders, pricing "signed webhooks" | Which business events do customers need? Fan out after commit for `auditInTx`? A screen for endpoints and deliveries? | Improve: define real events (result released, attempt submitted), fix fan-out, add a screen. Growth tier. **Result 2026-10-03:** improve — see RS6_FEATURE_REVIEW_B.md § FR2. (register correction: 36 non-test files use `auditInTx`, not 35; `docs/09-integration-guide.md:271` advises an event that is never delivered) |
| FR3 | API keys | Routes `/api/admin/api-keys`, table (0 rows), help text. No screen. | Phase 0 auth: "API keys" for server-to-server use | Embed secrets; plan tiers | Is there any consumer of the REST API? Which scopes? | Park until FR2 and FR4 decide. Same screen as webhooks. **Result 2026-10-03:** park (revive path written) — see RS6_FEATURE_REVIEW_B.md § FR3. (register correction: keys also authenticate nothing but `whoami`) |
| FR4 | Embed | Module 12 server side, inline SDK at `/embed/sdk.js`, JWT, origins, secrets (1 row). New-user insert is broken (RV43). npm package never built. No admin screen. | Phase 4 (shipped 2026-05-03): product surface 2, "iframe with signed JWT, drops into any host application", 13 decisions in `modules/12-embed-sdk/SKILL.md` | `/try` public demo (reuses the real runner); candidate take flow; university pilot (a college portal could embed the test) | Is there a near customer? Does the take flow inside the iframe still work after sections, integrity v1 (fullscreen in an iframe) and the new types? | Revive: fix RV43, test the take flow in the iframe, then decide the SDK package. Enterprise tier. **Result 2026-10-03:** revive — see RS6_FEATURE_REVIEW_B.md § FR4. (register correction: Caddy sets `X-Frame-Options DENY` site wide, a likely iframe blocker; embed admin routes are registered, only the screen is missing) |
| FR5 | In-app notifications | Table (0 rows), service, list and mark-read routes. No producer, no bell in the UI. | Phase 3 G3.B: "in-app short-poll" notices for admins | SP10 dashboard notice ("N results ready to publish"), queue alert email (SP11), reminders | Should the "ready to publish" notice and other admin notices use this channel? | Merge: make it the channel for SP10 and SP11 notices. **Result 2026-10-03:** merge into SP10 and SP11 notices — see RS6_FEATURE_REVIEW_B.md § FR5. |
| FR6 | Email templates with no sender | `attempt_submitted_candidate`, `attempt_graded_candidate`, `attempt_ready_for_review_admin`, `weekly_digest_admin`, `totp_enrolled` (text says "change your password") | Phase 3 notifications and the email kit port | `result_released` email (SP4), "result will be emailed" message (SP3), `evaluation_queue_alert` (SP11), reminders | For each: is the newer email better, or does the old one fill a gap (for example a "we received your test" email)? | Compare one by one. Probably: revive "submitted" as a receipt; merge "graded" into "released"; merge "ready for review" and "weekly digest" into the tenant notice (FR5). **Result 2026-10-03:** mixed: revive submitted, merge graded and ready-for-review, park digest, improve totp — see RS6_FEATURE_REVIEW_B.md § FR6. (register correction: `attempt_submitted_candidate` text promises a grading email that conflicts with the release rules) |
| FR7 | Tenant AI budget and AI settings | Table `tenant_grading_budgets` (0 rows, no writer), budget handler and route with no caller, Settings card; tenant settings `ai_grading_enabled`, `ai_model_tier` (stored, never read) | Phase 2 P2.D6 "budget guard" (100 runs a month); Phase 0 tenant settings | `19-billing` credits and entitlements; plan tiers (RO1); FR9 paid AI mode | Is the budget the same thing as "included evaluations" of a plan tier? Should `ai_model_tier` choose the model by plan? | Merge into the plan tiers: one usage limit, enforced in one place (`19-billing`). **Result 2026-10-03:** merge into plan tiers — see RS6_FEATURE_REVIEW_A.md § FR7. (register correction: the Settings budget card no longer shows a budget) |
| FR8 | Grading jobs page, handlers, and status `pending_admin_grading` | Menu item and page ("Coming soon"); list handler returns empty; retry returns 503; the status is never written | Phase 2 design for asynchronous grading with a job list | Platform evaluation queue (SP9), queue service levels and tenant ETA (SP11, ETA not built), background grading (SP8) | Do tenant admins need to see where their attempts are in the AssessIQ queue? Is `pending_admin_grading` the right name for "waits in the platform queue"? | Improve: turn the page into "Evaluation status" for the tenant (count, age, expected time). **Result 2026-10-03:** improve (tenant "Evaluation status") — see RS6_FEATURE_REVIEW_C.md § FR8. |
| FR9 | Paid AI mode | `anthropic-api` runtime stub (503), `open-weights` stub, cost report route that returns `[]` and reads a table that was never created (`grading_jobs`), help key for cost | Phase 2 AI design: budgeted API key, cost by month; owner decision OD2 | Plan tiers (paying tenants); SP8; `AI_PIPELINE_MODE` switch (SP9 text, not built) | When paying tenants exist, does AI move to the API? Then the cost report and budget become real. | Park. Mark every doc "not built". Revisit with PT1. **Result 2026-10-03:** park — see RS6_FEATURE_REVIEW_A.md § FR9. |
| FR10 | Old report routes | `topic-heatmap`, `archetype-distribution`, `reports/leaderboard/:assessmentId`, `cycles/:cycleId/cohort-report`, three `exports/*`, `analytics/refresh`. No caller. | Phase 3 G3.C analytics | Newer Activity pages (feed, leaderboard, heatmap for admin and candidate); results CSV with rank and sections (A6, R9); cohort report page | These look like the old and the new version of the same ideas. Which has the better data (topic heatmap by question topic is not in the new pages)? | Compare pair by pair. Probably: merge topic heatmap and archetype distribution into the cohort report; the old exports are replaced by the results CSV. **Result 2026-10-03:** merge topic data into cohort page, park exports, 09 leaderboard and cost-by-month, keep refresh — see RS6_FEATURE_REVIEW_C.md § FR10. |
| FR11 | Behaviour signals and archetype | `09-scoring` archetype; `ArchetypeRadar` with axes pace, edits, flags, focus loss, copy/paste, multi-tab; wrong data on the cohort page (RV14) | Phase 2 `09-scoring`: "archetype" from behaviour during the test | Integrity v1 events and the integrity summary per candidate (R10); AI-cheat detection (roadmap X5); old plan `32-anti-cheat-integrity` | Can the radar be the per-candidate integrity and behaviour profile? | Improve: one "behaviour and integrity" view per candidate that uses both data sets. **Result 2026-10-03:** improve (one behaviour and integrity block) — see RS6_FEATURE_REVIEW_C.md § FR11. |
| FR12 | Candidate "my assessments" | Routes `/me/assessments` and `/me/assessments/:id/start`; client functions with no caller | Phase 1 candidate flow before magic links | Candidate portal (results, certificates, activity); magic-link take flow; public drive link (R7, design-gated) | Should the portal show "upcoming tests" with a start button? | Merge into the candidate portal as "Upcoming". **Result 2026-10-03:** merge into candidate portal as "Upcoming" — see RS6_FEATURE_REVIEW_C.md § FR12. (register correction: the routes are registered, tested and used by the e2e fixture) |
| FR13 | Completion modal | `CompletionModal` component and test; help key | Phase 5 certificates: a moment of success with the certificate and a share button | Result page after release; LinkedIn share; `/try/certificate` | Where does the candidate first see a new certificate today? | Revive on the released-result page. **Result 2026-10-03:** revive on released-result view and `MyCertificates` — see RS6_FEATURE_REVIEW_C.md § FR13. |
| FR14 | Help content authoring | Admin page with wrong API paths (RV11); working routes for export, patch, import; tenant-level help rows are possible (`help_content.tenant_id` can be null or a tenant) | Module 16: "admin authoring UI — Phase 2", translation export and import | Platform-authored help; future languages (roadmap X8) | Who edits help: the platform only, or tenants too? | Improve: fix the paths and make it a super-admin tool; decide tenant overrides later. **Result 2026-10-03:** improve — see RS6_FEATURE_REVIEW_D.md § FR14. |
| FR15 | Per-tenant email sender | `tenants.smtp_config` column (no writer, no reader with a value), `resolveTransport(tenantSmtpConfig)`, `resolveFromAddress()` | Phase 3 design: each company sends from its own mail server | Brevo shared daily limit (task A5); white-label (old plan module 31); per-tenant theme fixtures (RV15) | Would a tenant sender solve the email capacity problem for large drives? | Park, then revive as an Enterprise tier feature together with white-label. **Result 2026-10-03:** park, revive as Enterprise feature — see RS6_FEATURE_REVIEW_A.md § FR15. (register correction: `smtp_config` has no writer and no value) |
| FR16 | Tenancy middleware | `modules/02-tenancy/src/middleware.ts` (156 lines), not registered | Phase 0: set the tenant context for each request | The auth chain in `apps/api` that sets the tenant now | Is every route covered by the new chain? Does the old file have a check that the new one lacks? | Compare (security-relevant). Then mark "superseded" in the file header. **Result 2026-10-03:** park (superseded; no security gap) — see RS6_FEATURE_REVIEW_D.md § FR16. (register correction: removed from the server on purpose in the campus-scale fix) |
| FR17 | Worker admin routes | `/api/admin/worker/*` (3 routes), help keys `admin.worker*` | Phase 3: see and retry failed background jobs | Super-admin Platform page; queue alert; observability doc | Does the owner need a "background jobs" tab on the Platform page? | Improve: a small tab for the super admin. **Result 2026-10-03:** improve (super-admin tab, tighten gate) — see RS6_FEATURE_REVIEW_D.md § FR17. (register correction: routes are registered with the admin role gate) |
| FR18 | Storybook and unused UI parts | `apps/storybook` (4 config files, 16 stories in module 17), not built anywhere; `ProgressBar`, `Placeholder`, `useReducedMotion` | UI system workflow: see and test components alone | The UI kit reference folder; visual regression tests (empty baselines); task N10 upgrade | Does anyone open Storybook? Could it give the visual baselines? | Park. Decide with E13. No Storybook 10 upgrade before that. **Result 2026-10-03:** park (re-check at E13) — see RS6_FEATURE_REVIEW_D.md § FR18. |
| FR19 | Question import by CSV | `bulkImport` accepts JSON only; the CSV branch throws | Phase 1 question bank: bulk import of questions | JSON import; `tools/aiq-import-pack.ts`; AI generation; candidate CSV import (works) | Do authors want a spreadsheet import? | Park. **Result 2026-10-03:** park — see RS6_FEATURE_REVIEW_A.md § FR19. |
| FR20 | Difficulty tags | `questions.cognitive_level`, `nice_task_id`, `difficulty_params` are written and never read; `attack_technique` is never set | Question difficulty spec, Phase A done; Phases B and C not started (warnings, measured difficulty) | Reports; SP6 agreement tracking; pack quality checks | Start Phase B/C, or show the tags in the question editor and reports first? | Improve: show the tags; schedule Phase C (pure SQL, no AI). **Result 2026-10-03:** improve (show tags; Phase C later) — see RS6_FEATURE_REVIEW_C.md § FR20. |
| FR21 | KQL answers | Plain text box (`TODO: Monaco editor`); old design "pattern-match KQL"; no grader; a person gives the score | Phase 1 and 2 KQL design | KQL execution design `docs/design/2026-10-02-kql-execution-grading.md` (X4); SP7 | Combine: editor, keyword pre-check, execution? | Merge the three designs into one KQL plan. **Result 2026-10-03:** merge three designs into one plan (manual, keyword hint, execution) — see RS6_FEATURE_REVIEW_D.md § FR21. |
| FR22 | Consent and batch tables | `consent_events` (0 rows), `generation_batches` (0 rows, shipped 2026-10-02) | R4 consent step; E6 durable generation batches | — | Are they wired? (RV66) | Check first. **Result 2026-10-03:** improve (verify wiring) — see RS6_FEATURE_REVIEW_D.md § FR22. (register correction: the `generation_batches` writer is wired) |
| FR23 | Old test scripts | `tests/e2e/walkthrough*.ts` (manual, May), k6 scripts in two folders | E2E walkthrough of May; load test plan R2 | E13 e2e in CI; RV73 | Reuse the steps? | Merge into E13 and the k6 run. **Result 2026-10-03:** merge into E13 and the k6 run — see RS6_FEATURE_REVIEW_D.md § FR23. |
| FR24 | Generation modes | `omnibus` (default) and `sharded` (2 tenants); stage 3 watch timer runs | Stage 3 rollout design | Task E4 | Finish the rollout? | Active work, not dormant. Listed so that nobody removes `omnibus` early. **Result 2026-10-03:** improve (finish rollout) — see RS6_FEATURE_REVIEW_D.md § FR24. |
| FR25 | Rubric validation in two places | `08-rubric-engine` `validateRubric` (tests only) and `04-question-bank` `validateRubric` (live), different shapes | Phase 2: module 08 was to own all rubric rules | Grade-time rubric synthesis in module 07 | Which one is stricter and better? Should 08 own it as planned? | Compare; keep the better one in module 08 and call it from 04. **Result 2026-10-03:** improve (module 08 owns all rules) — see RS6_FEATURE_REVIEW_C.md § FR25. (register correction: both validators use the same `RubricSchema`, so strictness is equal) |
## 7. Old ↔ new pairs to check before work (Rule B)

Known overlaps between old tasks or plans and newer ones. Read both sides before you implement either.

| Topic | Old item | Newer item | Note |
|---|---|---|---|
| Tenant notice of new results | In-app notifications (Phase 3) | SP10 "N new results published" notice; SP11 tenant ETA | FR5 |
| Background grading | Grading jobs page, `grading` status, BullMQ grading (Phase 2 design) | SP8 background grading; SP9 `AI_PIPELINE_MODE` switch | FR8, FR9. The switch has no task row. |
| Usage limits | P2.D6 tenant budget | `19-billing` credits and entitlements; plan tiers | FR7, PT1 |
| Payments | `assessiq-skill-plan.md` module 21 (Stripe Connect); `19-billing` "Phase C" | Task D3 (Razorpay); product review X2 | Provider not decided |
| Anti-cheat | Old plan module `32-anti-cheat-integrity`; roadmap P0 "AI-cheating detection" | Integrity v1 (A8, R10, shipped); X5 | FR11 |
| KQL | "Pattern-match KQL" (module 07 SKILL), Monaco editor TODO | X4 execution design; SP7 | FR21 |
| Reports | Phase 3 report routes | Activity pages; results CSV; cohort page | FR10 |
| Candidate entry | `/me/assessments` flow | Magic-link flow; public drive link (R7) | FR12 |
| Eval set | Task B5 (target 250 cases) | Task N5 (150 cases on the server) | Close B5 |
| Grade quality | Eval harness, override quality view (E2) | SP6 human-graded examples and agreement tracking | Combine |
| Result emails | Phase 3 templates (FR6) | SP3, SP4 emails | FR6 |
| White-label | Old plan module 31; tenant theme fixtures; tenant SMTP | — (vanished from the newer roadmap) | FR15. Add a roadmap row. |
| Vanished items | Plagiarism check (roadmap P0); search discovery (old plan module 22); AI interview question generator design | Not in the newer lists, with no decision | Add rows or record a rejection (owner) |
| SEO pages | 12 "coming soon" test pages | Task F2 (new pages from search data) | RV26 |
| E2E | May walkthrough script; `admin-workflow.spec.ts` | Task E13 | RV76, FR23 |
| Docs refresh | Task E10 (marked done) | RS5 | E10 is not complete |
| MFA | Operational audit PH-4; `MFA_ENROLLMENT_UX` plan | Task B4; RO4 | Optional now; flip later |

## 8. Facts from production (checked 2026-10-02, about 22:00 IST)

- Size: 6 tenants, 11 users (5 admin, 5 candidate, 1 super admin, 0 reviewer), 5 attempts (3 released, 2 auto-submitted). The data is still test data.
- Tables with 0 rows and 0 inserts since creation: `api_keys`, `webhook_endpoints`, `webhook_deliveries`, `in_app_notifications`, `tenant_grading_budgets`, `consent_events`, `generation_batches`.
- Flags in the API container: `NODE_ENV=production`, `AI_PIPELINE_MODE=claude-code-vps`, `AI_GENERATE_MODE=omnibus`, `MFA_REQUIRED=false`, `AI_EVAL_GATE=warn`, `ORIGIN_TRUST_MODE=enforce`, sender `connect@assessiq.in`, both test minters off.
- The stage 3 watch timer is installed and runs each hour. One BullMQ queue exists (`assessiq-cron`) with 7 repeat jobs.
- Frontend and marketing images matched their source. The API and worker image was older than `ea869ca` and the later code commits.

## 9. What the review did not examine

- Bodies of incident log entries between lines 190 and 2020. Old session entries, except their open questions.
- Ten large admin pages were read in part. The split `platform/` files were not read.
- Marketing glossary, resources, alternatives and compare pages: searched, not read in full.
- Repository files of modules 03 to 06. Modules 01, 12, 14, 16 at table level. All test folders.
- The new `ordering` question type (added during the review).
- No browser session, no test run, no build. Every UI finding is from source, plus `curl` for three live items.

## 10. Related records

- Roadmap: `docs/PENDING_TASKS_2026-10-01.md` § P0-V.
- Review report with all tables: `C:\Users\manis\.claude\plans\need-to-reivew-entire-piped-crane.md` (its "remove" recommendations are replaced by Rule A).
- Memory: `full-review-2026-10-02`, `feedback-keep-dormant-features-review`, `feedback-check-old-task-before-new`, `owner-decisions-2026-10-02`.
- Handoff: `docs/SESSION_STATE.md`, entry "2026-10-02 (m)". That file is tracked and public, so it has the summary only. This file has the detail.

---

## 11. Session record — 2026-10-02 (m), full project review

This section is the detailed record of the session that made this plan. A later session can continue from here and does not have to read the chat.

### 11.1 What the owner asked, in order

1. Review the entire project (code, docs, features). Find code that does not operate. Find contradictions in plans, roadmaps and old vs new tasks. Find stale UI in production. Give a recommendation for each item, in tables, in ASD-STE100. No coding.
2. Run a second research pass to verify the findings and to cover the items that were not examined. A second session was active.
3. Add the final findings, with full context, to the roadmap and a plan, in fix order.
4. Decisions: plan tiers; remove the reviewer role; MFA for tenant admins optional, to enable later. Two standing rules: keep dormant features and review them (Rule A); check for a similar old task before each new task (Rule B). The owner then made Rule A stricter: a delete only after detailed research, only if the item is absolutely useless for a professional product, and only with approval.
5. Save, document in detail, and hand off.

### 11.2 What was done

| Step | Work | Result |
|---|---|---|
| Pass 1 | 3 read-only review agents (backend, UI, docs and plans). Then about 45 scoped searches, 2 server checks and 5 live page checks by the review lead. | Report tables A to G (backend dormant code, UI dormant code, stale UI in production, doc contradictions, plan file status, old vs new tasks, stale memory notes). |
| Pass 2 | 6 read-only review agents: verify the backend rows; read 8 large service files in full; read admin pages and the test-taking page; read all help, email and marketing text; verify the doc contradictions; read the incident log, old sessions and memory notes. Then direct checks: code reads, production row counts and flags, the live link-preview image. | 5 corrections to pass 1. 12 new function defects (7 verified directly). 10 new stale-text items. Production facts (section 8). |
| Plan | This file, revision 1: 78 tasks in 11 sessions. | — |
| Owner input | Decisions RO1, RO4, RO7 and Rules A and B. | Revision 2: no removal of dormant features; feature review register PT1 and FR1 to FR25 (section 6); old ↔ new pairs (section 7). |
| Roadmap | `docs/PENDING_TASKS_2026-10-01.md` § P0-V added, and line 0 of "Suggested order". | Rows RS1 to RS11, the two rules, the decisions. |
| Memory | 3 new notes, 8 corrected notes, index updated. | See 11.4. |

### 11.3 What was NOT done

- No code change, no schema change, no deploy, no server write. The production checks were read-only (`docker ps`, `systemctl list-*`, `SELECT` counts, `curl`).
- No test run and no build. No browser session (the browser tool disconnected). Every UI finding comes from source, plus `curl` for three live items.
- No fix of any finding. No row of `PENDING_TASKS` outside § P0-V and "Suggested order" line 0 was edited; the stale rows are listed for RS5.
- The project `CLAUDE.md` and `PROJECT_BRAIN.md` were not edited. Rules A and B are in this plan, the roadmap and the memory notes. Adding them to those two files is task RV32 / RV33 (owner approval for `CLAUDE.md`).
- No entry in `docs/RCA_LOG.md`: no defect was fixed.

### 11.4 Files written by this session

| File | Tracked? | Content |
|---|---|---|
| `docs/plans/REVIEW_FIX_PLAN_2026-10-02.md` | No (gitignored, keep local) | This plan. |
| `docs/PENDING_TASKS_2026-10-01.md` | No (gitignored, local) | § P0-V and "Suggested order" line 0. |
| `docs/SESSION_STATE.md` | Yes (public) | Handoff entry (m), summary only. |
| `C:\Users\manis\.claude\plans\need-to-reivew-entire-piped-crane.md` | Outside the repo | Full review tables, both passes. |
| Memory, new | Outside the repo | `full-review-2026-10-02`, `feedback-keep-dormant-features-review`, `feedback-check-old-task-before-new`, `owner-decisions-2026-10-02`. |
| Memory, corrected | Outside the repo | `grading-completion-fix-plan`, `seo-audit-followups-plan`, `login-tenantless-identity-flow`, `question-difficulty-spec`, `product-review-2026-10-01`, `project-onboarding-tenancy-model`, and index lines (pilot pool sizes; "app is free" superseded). |

### 11.5 How to verify this record

- The findings: run the search or read the file and line given in each row. Rows marked V were checked this way on 2026-10-02.
- The production facts: `docker ps` with creation times, `systemctl list-timers`, and row counts from `pg_stat_user_tables` (read-only).
- That nothing was changed in code: `git log --since=2026-10-02T19:30 --author-date-order` shows only commits of the other session, plus one docs commit for the handoff entry.

### 11.6 Rollback

Nothing to roll back in code or on the server. To undo the notes: delete this file, remove § P0-V and "Suggested order" line 0 from `docs/PENDING_TASKS_2026-10-01.md`, and revert the handoff commit of `docs/SESSION_STATE.md`.

### 11.7 Agent use and what it taught

| Agent run | Task | Rework |
|---|---|---|
| Sonnet, pass 1 | Backend dormant code | Yes: 3 rows corrected in pass 2 (stage 3 timer, embed inline SDK, two tools that are in use). |
| Sonnet, pass 1 | UI dormant code and stale UI | Yes: 6 of 9 "unused UI parts" are used; "CSV limit 200 matches the server" was wrong (limit is 1,000). |
| Sonnet, pass 1 | Docs and plan contradictions | No. |
| Sonnet, pass 2 (6 runs) | Verify and extend | No. |

Process notes for the next session:

- A "no caller found" result from one agent is not enough to call code unused. Pass 2 found callers that pass 1 missed (internal use inside the UI system, a caller in another module). Check with a second, independent search.
- Tell read-only agents: "no temporary files anywhere; use shell pipes". Two agents of pass 1 wrote small files to `/tmp`.
- In a script sent through `ssh … 'bash -s' <<EOF`, a `docker exec -i` reads the remaining script as its input and the script stops. Use `docker exec` with no `-i`, or add `</dev/null`.
- In Git Bash on Windows, an argument that starts with `/` is rewritten as a Windows path. Set `MSYS_NO_PATHCONV=1` for such commands.
- `docs/` is gitignored, so the Grep tool skips it. Read doc files by path, or use plain `grep`.
- Line numbers in this plan were correct at `b3dbd7e`. The other session changed code during and after the review (`platform.tsx` split, `ordering` type, fixes in module 06). Search for the text, not the line.

### 11.8 First action for the next session

1. Read this file (sections 3, 4 and 5 RS1) and `PENDING_TASKS` § P0-V.
2. Start **RS1**. RV1 (numeric answer box) is first; check that the `ordering` answer area has no similar local state.
3. Apply Rule B before each task and write "old task or feature checked: …" in the handoff.

## 12. Session record — 2026-10-02 (n), RS1, RS2, RS3, RS5 and N10 to N12

Commits on `main`, all pushed (`274bbc6..c788ed7`): `0d02ea9` RS1, `ac531c5` N11, `578c0aa` RS2, `8113192` and `8cc46c2` RS3, `f40400c` RS5, `48e1cfb` N10, `c788ed7` N12.

### 12.1 What was done, per task

- **RS1 (`0d02ea9`).** RV1: `key={currentQuestion.question_id}` on `<AnswerArea>` in `apps/web/src/pages/take/Attempt.tsx` (a reset effect inside `NumericAnswerArea` was rejected: it fixes one area only). RV2/RV3: "7 days" in the invite dialog and the invite-accept page; "Phase 0" and "72 h TTL" footers removed (also `admin/mfa.tsx`). The text is static; it does not read the expiry from the API. RV4: four UI help ids now match their content keys. RV5: certificate verify link uses `window.location.origin`.
- **N11 (`ac531c5`).** Scenario `mcq` steps keep `type`, `id` and string `options` in the candidate view (allowlist). Sonnet adversarial review: accept; LOW notes only.
- **RS2 (`578c0aa`).** RV6/RV7: consumer copies `app.webmanifest`, `app-og.png`, `app-og.svg` under `apps/web/public/brand/` (force-added; kit untouched). RV8 Settings page text, RV9 grading-jobs page text, RV10 admin guide rewritten, RV12 dead `/admin/me` call removed, RV13 super-admin-only `generation-attempts` requests, RV14 radar not rendered in the cohort report, RV15 fixture key `default`. No feature removed.
- **RS3 (`8113192`, `8cc46c2`).** 29 entries corrected, 10 new keys (178 to 188), none removed or renamed. Migrations 0146 and 0147. Seed regenerated.
- **RS5 (`f40400c`).** Root docs, numbered docs 01/03/05/06/08/09/11/12/13/14, 11 module SKILL files, 13 plan and design headers, `docs/PENDING_TASKS_2026-10-01.md`.
- **N10 (`48e1cfb`).** argon2 `^0.40.0` to `^0.45.1` in `modules/01-auth/package.json`. New test `modules/01-auth/src/__tests__/argon2-compat.test.ts`. codex adversarial review: accept, 1 LOW. Held back: `astro-og-canvas` 0.13 and `canvaskit-wasm` 0.42 (need Astro 5; marketing is on Astro 4.16); Storybook 10 (owner review FR18).
- **N12 (`c788ed7`).** `apps/web/e2e/take-runner-mocked.spec.ts`: real app in headless Chromium, HTTP API mocked. 3 tests pass: ordering, two numeric questions in a row, scenario mcq step.

### 12.2 What was NOT done

- RV11 (waits for FR14), RV23 (RO3), RV33 (owner approval), RV41c (memory notes). (RV16 and the RV21 remainder were done on 2026-10-03: `511e1af`, `4ea20a8`, `2a15ce5`.)
- `docs/02-data-model.md` line about "Money: never used": checked on 2026-10-03 (N18). The line was wrong and is corrected.
- Stale header comments in `billing.tsx` and `grading-jobs.tsx`, and an unused `_Code` helper in `admin-guide.tsx`: fixed on 2026-10-03 (N17, `4ea20a8`).
- N12 did not check the admin authoring screen for ordering, server scoring on a real backend, publish or the admin view. These need an operator check.
- The N10 run reported `pnpm audit --audit-level high` = 42 high and 2 critical before and after. Batch 6 recorded 0 high. This needs a check.

### 12.3 Files

`apps/web/src/pages/take/Attempt.tsx`, `AttemptSections.test.tsx`, `modules/06-attempt-engine/src/repository.ts`, `modules/16-help-system/content/en/{admin,candidate}.yml`, migrations 0146 and 0147, `apps/web/public/brand/*`, `apps/web/index.html`, `modules/01-auth/package.json`, `apps/web/e2e/take-runner-mocked.spec.ts`, and the pages named in RS1 and RS2.

### 12.4 How to verify

1. Deploy stage 1 is recorded in `docs/06-deployment.md` (section "RS1–RS5 + N10–N12 deploy").
2. Run the mocked spec from `apps/web`: `pnpm exec playwright test e2e/take-runner-mocked.spec.ts --project=chromium`.
3. Run the help check query from `docs/07-help-system.md`. Expect 0.

### 12.5 Rollback

Code: use the rollback procedure in `docs/06-deployment.md` with the previous SHA `6336f61`. Migrations 0146 and 0147 change help text only and need no rollback.

### 12.6 Old task or feature checked (Rule B)

- **RS1:** RCA 2026-05-24 (help prefix mismatch) and RCA 2026-10-01 (invite TTL) compared. Same classes; the 7-day TTL stays the server value.
- **N11:** the old option "drop the step type" was rejected under Rule A. The step type stays.
- **RS2 RV12:** `/admin/me` and `/api/auth/whoami` compared. `/admin/me` does not exist and `whoami` has no retention field, so the fallback call was removed.
- **RV14:** the radar component is kept for FR11; only its use in the cohort report stopped.
- **RS3:** keys kept. The 44 keys with no screen are untouched.
- **N10:** the batch 7 notes (N7 leftovers) were read. N10 finishes the argon2 part.
- **N12:** the old skipped take specs (`take-happy-path`, `take-timer-expiry`) were compared. They need a real backend. The new spec mocks the API.

### 12.7 Stage 2, CI, RV41c and the public record

- **Deploy stage 2 (about 00:00 IST 2026-10-03).** VPS pull `8cc46c2` to `c788ed7`; 0 `claude` processes; built `assessiq-api` only; recreated api and worker; 24 containers before and after; 0 error lines; `/api/health` 200. `argon2` in the image 0.40.3 before and 0.45.1 after; a hash made by 0.40.3 verifies in the container and a wrong input is rejected. Clone later pulled to `5f258d4` (docs only).
- **CI on `main`.** Success for `f40400c`, `8cc46c2`, `c788ed7`, `5f258d4`. CI failed on the four commits before (`6336f61` to `274bbc6`); the stale help seed `0011_seed_help_content.sql`, regenerated in `8113192`, is the likely cause (not proven).
- **RV41c.** Done in part: six memory notes corrected (outside the repo). Three notes wait for the owner.
- **Open task N18.** Check the "Money: never used" line in `docs/02-data-model.md` against the billing tables. **DONE 2026-10-03:** the line was wrong; the doc is corrected.
- **Public record.** `docs/plans/REVIEW_FIXES_RS1_RS5_N10_N12.md` (tracked). It holds only fixed items; open items there carry a task id and a neutral line.
