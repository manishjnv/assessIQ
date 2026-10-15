# RS6 feature review, part D (FR14, FR16, FR17, FR18, FR21, FR22, FR23, FR24)

Date: 2026-10-03. Read-only review, no code change. Rule A: nothing is deleted. Rule B: each item names the newer feature that overlaps.

Method: first design, code trace (two independent searches for each "no caller" claim), newer overlap, one result, follow-up tasks. Production facts come from § 8 of `REVIEW_FIX_PLAN_2026-10-02.md` (checked 2026-10-02). No server was contacted. Nothing was built or run.

---

## FR14 — Help content authoring (also covers RV11)

### First purpose
- PROJECT_BRAIN decision log, 2026-04-29: "Help system as separate module", "centralized authoring + i18n-ready". The server routes came first (`eceebe7`, 2026-05-02).
- `modules/16-help-system/SKILL.md:100-103,122`: the admin authoring UI and the export/import panel are "Phase 2 admin-dashboard". Phase 1 authoring is by `PATCH` with curl, or by YAML plus redeploy.
- The page came later (`18fece2`, 2026-05-03, task P2.D14). It was written for a different API (`modules/10-admin-dashboard/src/pages/help-content.tsx:5-10`).

### What operates today
- Server routes are registered: `apps/api/src/server.ts:282` calls `registerHelpAdminRoutes`. They are `GET /api/admin/help/export`, `PATCH /api/admin/help/:key`, `POST /api/admin/help/import` (`modules/16-help-system/src/routes-admin.ts:45,64,90`). The role gate is `roles: ["admin"]` (`routes-admin.ts:36`).
- The page calls four other paths: `GET /admin/help-content`, `PUT /admin/help-content/:id`, `GET .../export`, `POST .../import` (`help-content.tsx:51,72,87,105`). The server has none of them. All four fail with 404.
- The page also expects another data shape: `{entries:[{id, help_id, title, body}]}` (`help-content.tsx:23-34`). The server uses `key`, `short_text`, `long_md` and returns an array.
- Route `/admin/settings/help-content` exists (`apps/web/src/App.tsx:99`). Second search (`help-content` in apps/web and module 10): only `App.tsx` and `index.ts:53` reference the page. No menu entry. Nobody reaches it without typing the URL.
- Server writes go to tenant rows only: `upsertHelpForTenant` reads and writes `WHERE tenant_id = $1` (`service.ts:200-216`). A tenant admin can override a help key for its own tenant. The API cannot edit a global row (`tenant_id IS NULL`). Global rows come from migrations and `content/en/*.yml` (166 admin keys, 29 candidate keys).
- The read path prefers the tenant row over the global row (`service.ts:88-93`). So a tenant override shows to that tenant's users.
- Import writes an audit row (`help.content.imported`, `service.ts` import function). Module tests cover audit writes (`__tests__/audit-writes.test.ts`).
- Help text ships by migration. Latest: 0148 (live), 0149 (in the working tree, not committed).

### Overlap with newer feature
- Platform-authored help through migrations and YAML is the real authoring path now (0146, 0147, 0148). It needs a deploy for each text change.
- Roadmap X8 (languages) needs export and import to work.
- Newer page-help rule: a page shows only keys that start with its page id (SESSION_STATE (o), process note 4). An authoring UI must enforce this rule.

### Result
**Improve.** Keep the page. Fix the four paths and the data shape. Make the first version a super-admin tool for global rows, plus export/import for translators. Hide tenant overrides until the owner decides.

### Follow-up tasks
- FU-D1 (M; modules 10, 16; not load-bearing): Align the page to the real routes (`key`, `short_text`, `long_md`, audience, locale). Add a list route, because export is the only list today.
- FU-D2 (M; module 16, uses 14 `auditInTx`; 16 is not on the load-bearing list, 14 is touched only as a caller): Add a super-admin-only route that edits global rows with a version bump.
- FU-D3 (S; module 10): Add a Platform menu entry for super admin, after FU-D1 and FU-D2.
- FU-D4 (S; module 16): Add a test that a saved key matches a page prefix, so the editor cannot create a hidden key (extend `help-id-page-prefix.test.ts`).

### Owner decision needed
- OD-D1: Who edits help? Platform only (recommended first), or tenants too? If tenants too: which keys, and may a tenant override block a later platform fix?
  - **Decided 2026-10-03:** Platform only.

---

## FR16 — Tenancy middleware (security comparison)

### First purpose
- Added with the tenants table in `7923492` (2026-05-01), "feat(tenancy): tenants table + RLS isolation + middleware".
- `modules/02-tenancy/SKILL.md:24,38`: two Fastify hooks. `preHandler` opens a transaction, runs `SET LOCAL ROLE assessiq_app`, sets `app.current_tenant`, and attaches `req.db` and `req.tenant`. `onResponse` commits or rolls back.

### What operates today
- **No route uses the old middleware.** Two independent searches:
  1. `grep tenantContextMiddleware` in apps, modules, tools, infra. The only non-test, non-comment hits are the export `modules/02-tenancy/src/index.ts:4` and the definition `middleware.ts:88`. All other hits are comments or test mocks.
  2. `grep "req.db|req.tenant"` in apps and modules. Only the old middleware and its own test (`tenancy.test.ts:192-209`) use them. `apps/api/src/server.ts:88-89` states the same.
- It was removed from the server in the campus-scale fix (2026-10). The open `BEGIN` pinned one pool connection per request (`middleware.ts:7-12`, `auth-chain.ts:32-34`). Test `server.test.ts:181` asserts it is not registered.
- What every route uses instead:
  - `authChain` (`apps/api/src/middleware/auth-chain.ts`): session loader, API key, rate limit, `requireAuth`, extend-on-pass. It sets `req.assessiqCtx.tenantId` from the session or API key (`auth-chain.ts:89-92`).
  - Every DB access goes through `withTenant(tenantId, fn)` (`modules/02-tenancy/src/with-tenant.ts:30-55`): `BEGIN`, `SET LOCAL ROLE assessiq_app`, `set_config('app.current_tenant', $1, true)`, commit or rollback. 867 `withTenant` mentions across `apps/api/src` and `modules/*/src`.
  - The tenant id is a function argument. A route outside the auth chain (public help `routes-public.ts:19`, certification `routes-public.ts:13`, take routes by token) must derive the tenant id itself, or use the globals-only path for `help_content`.

### Comparison: does the old file check something the new chain lacks?
| Check | Old middleware | Current chain |
|---|---|---|
| Role switch to `assessiq_app` (RLS on even for a superuser URL) | yes, `middleware.ts:101` | yes, in `withTenant` (`with-tenant.ts:37`) |
| Tenant setting per transaction | yes | yes |
| Fail when no tenant resolved | yes, throws `AuthnError` (`middleware.ts:93`) | `requireAuth` rejects a request without a session; `withTenant` itself does not check for an empty id |
| Test header `x-aiq-test-tenant` outside production | yes (`middleware.ts:62-81`) | no (removed; a gain, not a gap) |
| Tenant status (suspended or archived) | no | yes, `session-loader.ts:96-104` |
| User status (disabled, deleted, erased) | no | yes, `session-loader.ts:65-81`, 30 s positive-only cache |
| One transaction for the whole request | yes (pinned connection) | no. Each `withTenant` call is its own transaction |

Finding: the old file has **no check that the new chain lacks**. The only property that the old file had and the new chain does not have is "one transaction per request". Nothing relies on it (no reader of `req.db`).

### Overlap with newer feature
- `withTenant` plus `authChain` fully replace it. Same transaction shape, plus status checks.

### Result
**Park (superseded).** Keep the file and its test as an exported helper, as the file header already says. Do not register it again. No security gap found.

### Follow-up tasks
- FU-D5 (S; module 02 comment only; load-bearing): Add "SUPERSEDED, see `with-tenant.ts` and `auth-chain.ts`" to the header of `middleware.ts`.
- FU-D6 (S; modules 01, 02 comments and SKILL files; load-bearing, Opus review): Fix text that still says the middleware runs: `modules/01-auth/src/middleware/index.ts:12-13`, `modules/01-auth/SKILL.md:215,230`, `modules/02-tenancy/SKILL.md:24,38,74`, `modules/01-auth/src/sessions.ts:10`, `modules/01-auth/src/types.d.ts:5`.
- FU-D7 (S; module 02; load-bearing; optional hardening): Make `withTenant` throw on an empty or non-UUID `tenantId`. Today an empty string reaches `set_config` and RLS then fails closed (cast error), so this is hardening, not a fix. Needs `codex:rescue` before push.

### Owner decision needed
None. FU-D7 is optional.

---

## FR17 — Worker admin routes

### First purpose
- Commit `f8a1cf6` (2026-05-03): "structured logs + retry policy + admin queue stats". File header: three admin routes to see queue depth, list failed jobs and retry one (`apps/api/src/routes/admin-worker.ts:1-9`).
- Help text promises a page: `admin.worker` says "The **Worker** page (`/admin/worker`)" (`modules/16-help-system/content/en/admin.yml:2123-2231`, keys `admin.worker`, `.failed`, `.retry`).

### What operates today
- Routes are registered: imported at `apps/api/src/server.ts:29`, registered at `server.ts:211` with `authChain({roles:['admin']})`.
- Queue name `assessiq-cron`. Stats are global, not per tenant (`admin-worker.ts:11-17`). Payloads are redacted before output.
- No screen. Searches for `admin/worker` and `adminWorker` in `apps/web/src`, module 10 and module 17 found nothing. `App.tsx` has no `/admin/worker` route.
- Gate issue: any tenant admin passes `roles:['admin']`. A tenant admin can read global queue counts and **retry any failed job** of the shared queue. The file calls this "by design" (infra-global). With many tenants this exposes job names and counts, and allows a write action.
- BullMQ runs non-AI jobs only (CLAUDE.md rule 1). The jobs today are the boundary cron and the timer sweep (`admin-worker.ts:14-16`).

### Overlap with newer feature
- Platform page for super admin (after the E9 split): evaluation queue, tenants, settings. It has no infra tab.
- Evaluation queue alert (SP11) emails the owner when AI work waits. That is the platform evaluation queue, not BullMQ.
- `docs/11-observability.md`.

### Result
**Improve.** Make a small super-admin tab "Background jobs": depth cards, failed list, retry button. Tighten the route gate to `super_admin` at the same time.

### Follow-up tasks
- FU-D8 (S; `apps/api/src/routes/admin-worker.ts`; auth-adjacent, not on the load-bearing path list): Change the gate from `admin` to `super_admin`. Test that a tenant-admin session gets 403.
- FU-D9 (M; modules 10, 17): Add the "Background jobs" tab on the Platform page. Reuse the three routes.
- FU-D10 (S; module 16): Update the three help rows to the tab location (migration).

### Owner decision needed
- OD-D2: Confirm that tenant admins must NOT see queue data. (Recommended: super admin only.)
  - **Decided 2026-10-03:** Confirmed. Queue data is for the super admin only.

---

## FR18 — Storybook

### First purpose
- Scaffold `f21ac4d` (2026-05-01): "vite spa scaffold + design tokens + base components". `docs/08-ui-system.md:249,440-451`: one story per component, a theme decorator, "ships as part of the dev environment, not deployed".
- `modules/17-ui-system/SKILL.md:39,65`: "Storybook story with all variants" is part of the component checklist.

### What operates today
- `apps/storybook` has `package.json`, `tsconfig.json`, `.storybook/main.ts`, `.storybook/preview.tsx` (theme decorator `withThemeByDataAttribute`, `preview.tsx:2,12`).
- 16 story files in `modules/17-ui-system/src`: ActivityHeatmap, Button, Card, Chip, ErasedChip, Field, Icon, LeaderboardList, Logo, Num, Placeholder, ProgressBar, Spinner, StackedBarChart, Tooltip, ThemeProvider. Module 17 has 28 component files, so about 12 have no story.
- Installed version: 8.6.18 (`apps/storybook/node_modules/storybook/package.json`). Declared ranges: Storybook `^8.3.0`, vite `^5.4.0`, react `^19.3.0` (`apps/storybook/package.json`).
- Build state: a local `storybook-static/` folder dated 2026-05-03 exists (gitignored, `.gitignore:15`). No later build is known. I did not run a build (read-only rule). **"It builds today" is NOT confirmed.**
- Nobody calls it: no CI step (`.github/workflows/ci.yml` has no `storybook`), no deploy (excluded from images, `infra/docker/assessiq-frontend/Dockerfile.dockerignore:38-39`). The root `package.json` has no `storybook` script, but `docs/08-ui-system.md:442` says "Run `pnpm storybook`". The working command is `pnpm --filter @assessiq/storybook dev`.
- Audit: Storybook 8.6 is on the dev-tool list in task N19 (42 high, 2 critical without `--prod`; production-only audit is 0 high). It is not in the production image, so the risk is local only.
- Visual regression is empty: `apps/web/e2e/visual.spec.ts` has 3 skips and no app baselines.

### Overlap with newer feature
- The UI kit reference folder (`modules/17-ui-system/AssessIQ_UI_Template`) is the canonical design reference, not Storybook (memory rule "kit is canonical").
- Playwright `visual.spec.ts` (empty baselines) and `a11y.spec.ts` overlap with what Storybook could give at component level.
- `ProgressBar`, `Placeholder` and `useReducedMotion` are unused in the app. Their stories are the only place that shows them. Rule A: keep.

### Result
**Park**, with a re-check at E13. Reasons: no user, no CI, dev-only, and the plan says no upgrade before E13. It is not useless: it is the only component catalogue, and it could feed the visual baselines.

### Cost of an upgrade to Storybook 10
This part is from general knowledge of the Storybook 9 and 10 migrations. I did not check the registry. Confirm before the task.
- Run `npx storybook@10 upgrade` in `apps/storybook`. Storybook 10 is ESM-only and needs a recent Node.
- `@storybook/addon-essentials` is not a separate package from version 9. Remove it and its entry in `main.ts`. `@storybook/addon-themes` stays.
- Raise the local vite pin (`^5.4.0`) to a version that `@storybook/react-vite` 10 supports.
- Code change: `main.ts`, maybe `preview.tsx`, `package.json`. About 3 files. Size S to M, plus a first real build and a look at 16 stories.
- Benefit: removes the Storybook share of the N19 findings. Risk: low, because nothing ships.

### Follow-up tasks
- FU-D11 (S; root `package.json` or `docs/08-ui-system.md:442`; dev-only): Add the root script `"storybook": "pnpm --filter @assessiq/storybook dev"`, or correct the doc line.
- FU-D12 (S): Run `pnpm --filter @assessiq/storybook build` once on a branch and record the result. Needs an owner go (not allowed in this review).
- FU-D13 (M; apps/storybook): Upgrade to Storybook 10 after E13 and FU-D12.
- FU-D14 (M; module 17): Add stories for the 12 components that have none. Use the build as one source for the visual baselines (merge with E13).

### Owner decision needed
- OD-D3: Keep Storybook as a dev tool and fund the upgrade after E13, or leave it parked and stop listing it in N19. (Not a delete.)
  - **Decided 2026-10-03:** Storybook stays parked until E13.

---

## FR21 — KQL answers (three designs)

### First purpose
- Phase 1 decision #11 (`PHASE_1_KICKOFF.md`, quoted in `apps/web/src/pages/take/Attempt.tsx:21,244`): no Monaco editor, a textarea.
- `docs/05-ai-pipeline.md:239`: "For KQL: pattern match in v1, expand to in-browser KQL simulator in v2." Help key `admin.questions.type.kql.expected_keywords` (`modules/04-question-bank/SKILL.md:55`).
- Third design: `docs/design/2026-10-02-kql-execution-grading.md` (X4, design only, 72 lines).

### What operates today
- The candidate sees a textarea and answers `{query: string}` (`Attempt.tsx:244-252`).
- Content schema: `question, tables[], hint, expected_keywords[], sample_solution` (`modules/04-question-bank/src/types.ts:85-91`, as cited in the X4 note). A second, generation-side schema also requires `expected_keywords` (`types.ts:131-136`).
- **No grader.** `docs/05-ai-pipeline.md:79` and `modules/07-ai-grading/SKILL.md:6` say so. Second search: `expected_keywords` appears in generation and display only: `coerce-question-content.ts:229`, `runtimes/claude-code-vps.ts:534`, `eval/runner.ts:129,257` (structure check only), `ExpectedAnswerView.tsx:178`. **No scoring code reads it.** `05-ai-pipeline.md:239` is stale: the keyword match was never built.
- A person gives the score: `POST /api/admin/attempts/:id/questions/:questionId/manual-score` (`modules/07-ai-grading/SKILL.md:210`). An attempt stays incomplete until every KQL question has a score (SP1, `05-ai-pipeline.md:1278`).
- `generate-kql` writes questions (`prompts/skills/generate-kql`). The omnibus path invented Sentinel tables (`05-ai-pipeline.md:1016`).

### Overlap with newer feature
- MCQ deterministic scoring (`modules/09-scoring/src/mcq.ts`) and the `ordering` type (SP7): the pattern to copy is "score from data, write a `gradings` row with `grader='deterministic'`".
- The manual-score path (SP1) is the fallback that every design keeps.

### Comparison of the three designs
| | Keyword match (old) | Manual score (live) | Execution (X4) |
|---|---|---|---|
| Built | no | yes | no |
| Deterministic | yes | no | yes |
| Cost | none | owner time per question | container, about 2 GB RAM (not measured) |
| Weakness | wrong answers that contain the words pass; right answers with other words fail | does not scale to a campus drive | VPS capacity; emulator coverage; new attack surface |
| Authoring data | `expected_keywords` (exists) | none | dataset plus frozen expected result (new) |

### Result
**Merge into one KQL plan.** One design, three layers. Each layer is optional and falls back to the layer before it.
1. Layer 0 (live): manual first score. It stays as the permanent fallback.
2. Layer 1 (new, cheap, no container): use `expected_keywords` as a **hint only**. Show the admin which keywords the query contains, next to the manual-score box. Never score from it. This gives the old design a safe use and speeds up manual work.
3. Layer 2 (X4): execution grading with `assessiq-kusto`. Only after the owner capacity decision. `expected_keywords` stays as an authoring aid (X4 note § 5).
The Monaco editor is a candidate-side add-on for layers 1 and 2. Keep it separate and optional (bundle size on lab PCs; Vite build target chrome87).

### Follow-up tasks
- FU-D15 (S; module 10; not load-bearing): The admin attempt view shows keyword hits for a KQL answer beside the manual-score input.
- FU-D16 (S; docs): Correct `docs/05-ai-pipeline.md:239` to "manual score today; execution grading is design only".
- FU-D17 (S; VPS read-only measure): Measure neighbour memory (`docker stats`, `free -m`) as X4 § 6 requires. The owner runs it or approves it.
- FU-D18 (L; modules 04, 06, 07, 09 and infra; **load-bearing: 07, infra**): X4 execution grading. Waits for OD-D4. Needs `codex:rescue` (it runs candidate text) and the shared-VPS additive-only check.
- FU-D19 (M; apps/web, module 10): Optional Monaco KQL editor, lazy loaded, textarea fallback.

### Owner decision needed
- OD-D4: Is about 2 GB RAM for `assessiq-kusto` available on the shared VPS? Until the answer, only FU-D15 and FU-D16 go ahead.
  - **Decided 2026-10-03:** NO. The VPS has about 4 GB free of 7 GB and is shared (checked 2026-10-03). FU-D18 stays blocked.

---

## FR22 — Consent and batch tables with 0 rows

### First purpose
- `consent_events`: module 20 data rights (`modules/20-data-rights/migrations/0101_consent_events.sql`, `1f737a8`, 2026-05-29). Pre-test consent came with R4 (pilot, 2026-10-01).
- `generation_batches`: E6, durable generation batches (`d7123d4`, 2026-10-02; migration `modules/07-ai-grading/migrations/0142_generation_batches.sql`).

### What operates today
- `consent_events`: the writer exists and is wired. `insertConsentEvent` (`modules/06-attempt-engine/src/repository.ts:278-295`) is called at `service.ts:587` (Begin + consent, under an advisory lock). The start path **requires** a row, else error `CONSENT_REQUIRED` 422 (`service.ts:245-270`). Embed attempts are exempt (host-asserted consent). The comment at `repository.ts:259-262` says module 20 has no writer of its own. Zero rows is expected: the 5 test attempts began before R4 went live.
- `generation_batches`: the writer is wired. `modules/04-question-bank/src/generation-batches.ts:53,106` (upsert, status update) and `modules/07-ai-grading/src/handlers/admin-generate.ts:1104` (completed ids). Routes: `registerGenerationBatchRoutes` (`modules/04-question-bank/src/routes.ts:87`). The UI calls `PUT /admin/generation-batches/:id`, `GET .../active` and `PATCH` (`modules/10-admin-dashboard/src/api.ts:245-254`; `generate-wizard.tsx:105,109,505`). Those calls swallow errors (`.catch(() => {})`), so a failure would also give 0 rows. Zero rows fits "no wizard run since deploy", but I cannot prove it without production access.
- Other tables with 0 rows (plan § 8) and their writers:

| Table | Writer code | Caller or screen |
|---|---|---|
| `api_keys` | `modules/01-auth/src/api-keys.ts:101,143,227` | admin routes `/api/admin/api-keys`; no screen (FR3) |
| `webhook_endpoints` | `modules/13-notifications/src/repository.ts:201` | routes exist; no screen (FR2) |
| `webhook_deliveries` | `repository.ts:325,358` | fan-out from `audit()` only (FR2) |
| `in_app_notifications` | `repository.ts:455,522` | no producer, no bell (FR5) |
| `tenant_grading_budgets` | **none**: no INSERT or UPDATE in apps, modules or tools. Reads only: `modules/07-ai-grading/src/repository.ts`, `handlers/admin-budget.ts` | FR7. A row can never appear |

### Overlap with newer feature
- None for consent (new and required). `generation_batches` replaced a browser-only plan store (`generation-batches.ts:2`).

### Result
**Improve (verify).** Two tables are wired and need a live check. `tenant_grading_budgets` has no writer; that belongs to FR7 (merge into plan tiers).

### Follow-up tasks
- FU-D20 (S): After the next pilot attempt, check that `consent_events` has one row for each candidate. Check that a module 06 test covers "start without consent returns 422"; add it if missing.
- FU-D21 (S; module 10): Stop swallowing errors in `generate-wizard.tsx:105,109`. Show a small "not saved" notice, so an empty table is not silent.
- FU-D22 (S): Run one wizard generation, then check that `generation_batches` has a row.
- The writer for `tenant_grading_budgets` is handled in FR7 and PT1, not here.

### Owner decision needed
None.

---

## FR23 — Old test scripts

### First purpose
- `tests/e2e/walkthrough.ts` and `walkthrough-questions.ts` (`ee67fc8`, 2026-05-15): "documents the full production run" and checks the database state after a manual walkthrough, phases A to F: pack and assessment, attempt, AI grading, certification, leaderboard, email (`walkthrough.ts:2-12`, 153 lines).
- `tests/load` (`4a07e3f`, 2026-05-15): k6 smoke and auth-flow scenarios, local only (`tests/load/README.md`).
- `tools/load/candidate-drive.k6.js` (`38a1f34`, 2026-10-01, R2): 300 candidates in one lab, magic link to submit.
- `tools/test-invite.ts` (fixed ids from May; checks `email_log`) and `tools/test-issue-cert.ts` (`bea339a`, 2026-05-13; one-shot certificate issue inside the api container).

### What operates today
- `walkthrough.ts` is **not** a UI test. It reads fixed ids and asserts rows in a database that holds the May run. It cannot run against a fresh database. It is not in CI.
- Playwright (`apps/web/e2e`): `admin-workflow.spec.ts` (16 steps, 18 skips), `take-happy-path` (3 skips), `take-timer-expiry` (2), `visual` (3), `a11y`, `take-error-pages`, `take-runner-mocked`, `cert-prod-safety`. The CI job `e2e` (`.github/workflows/ci.yml:360-391`) runs only `admin-workflow.spec.ts`. Its repo variables were deleted, so the job is paused (SESSION_STATE, owner decision 2026-10-02).
- The skips are stale (RV76): the fixtures grade and create packs as a tenant admin (`fixtures/factories.ts`), and both now return 403.
- Map from walkthrough phase to Playwright factories: A (pack, assessment) = `createPack`, `createAssessment`, `publishAssessment` (exist). B (attempt) = `startAttempt`, `answerQuestion`, `submitAttempt` (exist). C (grading) = `getAdminAttempt`, `GradingProposal` (exist, but use the old tenant route). D (certificate) = inside the admin-workflow steps. E (leaderboard) and F (email check) = **not covered** by Playwright.
- k6: `tools/load/candidate-drive.k6.js` is the only load script that matches the current campus flow. `tests/load/scenarios/smoke.js` and `auth-flow.js` target the old dev-mint login on a local stack, from before the session-keyed rate limits (R2).
- `tools/test-invite.ts` and `test-issue-cert.ts` hold fixed ids from May. They are one-off smoke tools.

### Overlap with newer feature
- E13 (e2e, last), RV76, RV73 in the plan. The R2 k6 campus run.

### Result
**Merge into E13 and the k6 run.**
- From `walkthrough.ts`, reuse the six phases as the checklist for the new spec, and the "database state" assertions (rows in `gradings`, `certificates`, `email_log`) as a final check step.
- Keep `tools/load/candidate-drive.k6.js` as the campus run. Treat `tests/load` as the older local smoke set. Fold its smoke checks into the same folder with the R2 limits.
- Keep `test-invite.ts` and `test-issue-cert.ts` as ops examples. Move the fixed ids to environment variables when someone touches them.

### Follow-up tasks
- FU-D23 (M; apps/web/e2e; not load-bearing): In E13, add steps for the leaderboard and the email log, taken from walkthrough phases E and F.
- FU-D24 (S; tests/load): Update `lib/auth.js` to the current login or session mint. Add a note in `tests/load/README.md` that `tools/load/candidate-drive.k6.js` is the campus scenario.
- FU-D25 (S; local docs): One index page `docs/testing/` that lists all test scripts, what each proves and which are stale.

### Owner decision needed
None. (E13 timing is already set by the owner: last.)

---

## FR24 — Generation modes: omnibus and sharded

### First purpose
- Sharded design: `docs/design/2026-05-09-type-sharded-generation.md`. Five type skills run in parallel with strict per-type schemas. Stage 1 `f449203` (2026-05-09). Reason: omnibus invented Sentinel tables (`docs/05-ai-pipeline.md:1016`).
- Stage 3 rollout: `docs/design/2026-05-10-stage-3-promotion-rollout.md` (approved). Per-tenant flag first, then the default flip (Stage 3.1), then removal of omnibus (Stage 4, explicitly later: design § 1 non-goals).

### What operates today
- Two layers decide the mode. `admin-generate.ts:491-497`: `tenant_settings.ai_generate_mode` (NULL, `omnibus` or `sharded`; migration `modules/02-tenancy/migrations/0044_tenant_settings_ai_generate_mode.sql:26`) wins over the global env `AI_GENERATE_MODE` (`modules/00-core/src/config.ts:120-122`, **default `omnibus`**). Production env is `omnibus` (plan § 8). The plan says 2 tenants are on `sharded`.
- A control writes the flag: `PATCH /api/admin/super/tenants/:tenantId/ai-generate-mode` (`apps/api/src/routes/admin-super.ts:87`, service `modules/02-tenancy/src/service.ts:467-523`, audited). UI: a select labelled "Super-admin only" in `modules/10-admin-dashboard/src/pages/billing.tsx:126-170` (route `/admin/settings`, `App.tsx:96`). The UI shows "Current global default: omnibus" as fixed text, not read from the server.
- `tools/stage3-watch.ts` is read-only and alert-only: no auto-promotion, no rollback (header `:15-19`, design § 8 Q4). It is mentioned as an ops script at `infra/docker-compose.yml:129`.
- **Doc conflict:** the PROJECT_BRAIN decision row of 2026-05-10 says the cron "auto-promotes tenants meeting G1 criteria". The code and design § 8 Q4 say alert-only. The code is right.
- What decides the default: Stage 3.1 is gated on G1, G2 and G4. G4 is the `generate-subjective` skill patch, task E4 (`ROADMAP.md:85`): "Wrong-type questions block the sharded default." PROJECT_BRAIN line 73 still says "Stage 3.1 default flip pending G1/G2/G4".
- Prompts are skills on the VPS (CLAUDE.md rule 6), so E4 is a deploy event with eval re-baselining.

### Overlap with newer feature
- E4 is the same item as Stage 3.1. There is no duplicate. E1 (high-stakes vote) and E2 (eval gate) are about grading, not generation.

### Result
**Improve (active work, not dormant).** Finish the rollout. Keep `omnibus` until Stage 4. Nobody removes `omnibus` before then.

### Follow-up tasks
- FU-D26 (S; docs): Correct the PROJECT_BRAIN decision row of 2026-05-10 ("auto-promotes") to "alert-only". Owner approves the edit, because PROJECT_BRAIN is a protected doc.
- FU-D27 (S; module 10): In `billing.tsx:168` read the real global default from the server instead of the fixed text.
- FU-D28 (L; **load-bearing: module 07 skills on the VPS**): E4 / G4 `generate-subjective` patch and eval re-baseline. Skill deploy by scp. Waits for the owner eval run (bless).
- FU-D29 (S; module 07 test): One test that the tenant flag beats the env value and NULL uses the env value (`admin-generate.ts:495-497`). Check first whether one exists.

### Owner decision needed
- OD-D5: Which tenants stay on `sharded`, and when is the Stage 3.1 flip allowed (after E4 and a blessed eval)?
  - **Decided 2026-10-03:** All tenants stay on `sharded`. The Stage 3.1 flip waits for E4 and a blessed eval.

---

## Summary table

| Item | Result | Follow-up tasks | Owner decision |
|---|---|---|---|
| FR14 Help authoring (RV11) | Improve | FU-D1 to FU-D4 | OD-D1: platform only or tenant edits |
| FR16 Tenancy middleware | Park (superseded); no route uses it; no security gap | FU-D5 to FU-D7 (load-bearing comment and hardening) | none |
| FR17 Worker routes | Improve (super-admin tab, tighten gate) | FU-D8 to FU-D10 | OD-D2: tenant admins out |
| FR18 Storybook | Park (re-check at E13) | FU-D11 to FU-D14 | OD-D3: fund upgrade after E13 |
| FR21 KQL | Merge three designs into one plan (manual, keyword hint, execution) | FU-D15 to FU-D19 | OD-D4: VPS capacity |
| FR22 Consent and batch tables | Improve (verify wiring) | FU-D20 to FU-D22 | none |
| FR23 Old test scripts | Merge into E13 and the k6 run | FU-D23 to FU-D25 | none |
| FR24 Generation modes | Improve (finish rollout) | FU-D26 to FU-D29 | OD-D5: sharded tenants and flip date |
