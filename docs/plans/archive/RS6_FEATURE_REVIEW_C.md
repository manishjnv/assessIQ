# RS6 feature review, part C: FR8, FR10, FR11, FR12, FR13, FR20, FR25

**Date:** 2026-10-03
**Type:** read-only review, no code change. No schema, server or git change.
**Local-only file.** `docs/` is gitignored and the repo is PUBLIC. Do not `git add -f` it.
**Rules used:** Rule A (no removal; result is revive, merge, improve or park) and Rule B (compare the old item with the newer one). Both are in `REVIEW_FIX_PLAN_2026-10-02.md` § 3.
**Code state:** `main` at `3911f8b`.
**Evidence key:** `file:line` and commit hashes. Each "no caller" claim was checked with two different searches (route string and function or component name).

---

## FR8. Grading jobs page and status `pending_admin_grading`

### First purpose
- The Phase 2 plan says the admin "clicks Grade on a Phase 1 `pending_admin_grading` attempt" (`docs/plans/archive/PHASE_2_KICKOFF.md:7`).
- So the status meant: submitted, and a person has opened it for grading. The first open moved `submitted` to `pending_admin_grading`.
- The handlers `handleAdminListGradingJobs` and `handleAdminRetryGradingJob` are stubs for a future `grading_jobs` table in `anthropic-api` mode (`modules/07-ai-grading/src/handlers/admin-grading-jobs.ts:7-20`). First commit `5aec6ad` (2026-05-03).
- The page `pages/grading-jobs.tsx` first appeared in `18fece2` (2026-05-03).

### What operates today
- The menu item "Grading" opens `/admin/grading-jobs` (`AdminShell.tsx:261`, `apps/web/src/App.tsx:92`).
- The page is static. It makes no API call. It explains how evaluation works (`grading-jobs.tsx:3-17`, rewritten in `578c0aa` and `4ea20a8`).
- `GET /api/admin/grading-jobs` is registered (`07 routes.ts:526`). It always returns `{ items: [] }`. The page does not call it. No other caller exists.
- `POST /api/admin/grading-jobs/:id/retry` now answers 403 `AI_EVALUATION_BY_ASSESSIQ` for every caller (`07 routes.ts:250-269`). The 503 body in the handler cannot run.
- No code writes `pending_admin_grading` today. The claim-on-open write was removed in `67ed5e2` (2026-10-01), see the header of `admin-claim-release.ts:21-26`. Before that day it was written on every first open.
- Readers of the status stay valid for old rows and for the DB CHECK: `07 repository.ts:562,749`, `07 super-evaluations.ts:141`, `09 finalize.ts:73`, `apps/api/src/jobs/evaluation-queue-alert.ts:82`.
- `handleAdminAccept` returns `"pending_admin_grading"` as a reported value for a partial accept, but it does not write it (`admin-accept.ts:331-332`).
- The tenant already has a queue view that does not need the status. Tenant `GET /api/admin/dashboard/queue` lists attempts and derives `evaluation_status` (`awaiting_evaluation`, `ready_to_publish`, `published`) with `deriveEvaluationStatus` (`07 repository.ts:562-575`). Commit `511e1af` (2026-10-03) added tenant-wide `counts`. The dashboard shows them (`dashboard.tsx:121-123,257`).
- Dead code found: `15-analytics` `homeKpis` and `queueSummary` still count `status = 'pending_admin_grading'` (`15 repository.ts:61,97-107`). Nothing outside module 15 calls them. The dashboard does not use them.

### Overlap with newer feature
- Platform evaluation queue (SP9), `/admin/platform/evaluations`, `apps/api/src/routes/admin-super-evaluations.ts`.
- Derived states in `docs/plans/archive/SCORING_RESULT_RELEASE.md` § 3.2. The doc says there is no new status value, because many modules read the enum.
- Queue alert after 24 hours (SP11): `evaluation-queue-alert.ts`. Tenant-facing expected time: only the env text `EVALUATION_TURNAROUND_TEXT`, default "within 72 hours" (`00-core config.ts:98-106`). It is shown to candidates, not to tenant admins.
- Background grading (SP8) is rejected for now: it breaks the no-ambient-AI rule (`SCORING_RESULT_RELEASE.md` § 7).

### Result
**Improve.** Turn the page into a tenant "Evaluation status" view. Keep the stub handlers and the status value (Rule A). Mark the status "reserved, not written since 2026-10-01" in the docs.

### Follow-up tasks
| Id | Task | Size | Modules | Load-bearing? |
|---|---|---|---|---|
| FU-C1 | Page `grading-jobs.tsx` becomes "Evaluation status": counts from `counts`, age of the oldest waiting attempt, list per assessment, expected time text. Rename the menu item. Reuse `countGradingQueue` (`511e1af`); add oldest age to the same query. | M | 10, 07 (one read query) | Yes, 07 (read-only query; codex gate by rule) |
| FU-C2 | Docs: mark `pending_admin_grading` as "reserved; last written 2026-10-01" in `02-data-model.md` and `SCORING_RESULT_RELEASE.md`. Point `15` `homeKpis` and `queueSummary` at `evaluation_status` or mark them dormant. | S | docs, 15 | No |

### Owner decision needed
- Do tenant admins see an expected time? If yes, which text: the global env text, or a per-company value?
  - **Decided 2026-10-03:** Yes. Show an expected time from the env text.
- Keep the name "Grading" in the menu, or rename to "Evaluation status"?
  - **Decided 2026-10-03:** Rename the tenant menu entry to "Evaluation status".

---

## FR10. Old report routes

### First purpose
- Phase 3 G3.C (`ce041e3`, 2026-05-03) shipped `attempt_summary_mv` and "6 report routes + exports" for managers and L&D (`modules/15-analytics/SKILL.md` Purpose and Scope).
- SKILL decision D4 says module 15 is the service layer for the 09 cohort and individual routes.

### What operates today
- Live pages call only module 09 routes: `/admin/reports/cohort/:assessmentId` and `/admin/reports/individual/:userId` (`cohort-report.tsx:41`, `individual-report.tsx:46`, `09 routes.ts:80-107`).
- The 09 cohort route calls `cohortStats` in module 09 (`09 routes.ts:87`), not the 15 service. SKILL D4 and the comment at `15 repository.ts:121` are stale.
- Module 15 routes with no caller in apps or modules (second search: function names `topicHeatmap`, `archetypeDistribution`, `getAdminCohortReport`, `exportAttemptsCsv`, `exportTopicHeatmapCsv` appear only in module 15 and its tests): `reports/topic-heatmap` (`15 routes.ts:143`), `reports/archetype-distribution/:assessmentId` (`:168`), `reports/cost-by-month` (`:187`), `reports/exports/attempts.csv` (`:216`), `attempts.jsonl` (`:253`), `topic-heatmap.csv` (`:289`), `cycles/:cycleId/cohort-report` (`:342`), `analytics/refresh` (`:376`, super admin; the nightly job `refresh-mv-job.ts` also refreshes the view).
- `reports/leaderboard/:assessmentId` is a module 09 route (`09 routes.ts:110`). No page calls it.
- Live replacement for results export: `GET /api/admin/assessments/:id/results.csv` with rank, branch and sections (`15 routes.ts:115`).
- The live cohort page shows count, percentiles and an archetype bar list. It does not show topics. Module 15 has two richer queries with no UI: `queryCohortReport` (p25/p75, level breakdown, `topicBreakdown`, `15 repository.ts:199-243`) and `queryTopicHeatmap` (hit rate and band per question topic per pack, `:329-375`).
- Safety gap before any revival: `queryTopicHeatmap` (`15 repository.ts:375`) and the counters at `:464` read statuses `submitted`, `pending_admin_grading`, `graded` without the tenant-visible rule. The 09 queries use `TENANT_VISIBLE_ATTEMPT_SQL` (`09 repository.ts:375,385`). The "Activity" pages also use a status list. A tenant admin must not see unreleased scores (migration 0122).

### Overlap with newer feature
- Activity pages: `15/activity/heatmap.ts` is a calendar of attempts per day, not a topic heatmap. The same word means two things. No newer feature covers "hit rate by question topic".
- Activity leaderboard (`15/activity/leaderboard.ts`) overlaps the 09 leaderboard route.
- Results CSV (A6, R9) replaces the old `attempts.csv` for placement use. `attempts.jsonl` has no replacement; it fits an API or SIEM export (FR2, FR3).
- Cohort page (09 route) replaces `cycles/:cycleId/cohort-report` for the headline numbers. The old route also has a per-attempt list and `released_count`.

### Result
**Merge** the old topic data into the live cohort page. **Park** the old exports, the 09 leaderboard route and `cost-by-month` (ties to FR9). **Keep** `analytics/refresh`.

### Follow-up tasks
| Id | Task | Size | Modules | Load-bearing? |
|---|---|---|---|---|
| FU-C3 | Make module 15 queries use the tenant-visible rule (released or evaluation-released) before any UI uses them. Add a test like the one for 0122. | S | 15 (uses 09 SQL helper) | No (security-relevant, so adversarial review) |
| FU-C4 | Cohort page: add "By topic" and level breakdown from `queryCohortReport` and `queryTopicHeatmap` (needs a pack selector). Add help ids. | M | 15, 09 route or new 15 route, 10, 16 | No |
| FU-C5 | Fix stale text: SKILL D4 and `repository.ts:121`. Document in `03-api-contract.md` which report routes have a UI and which are parked. | S | 15, docs | No |
| FU-C6 | Decide the JSONL export: keep as admin data export, add formula guard to `attempts.csv` (same work as RV77). | S | 15 | No |

### Owner decision needed
- Is a topic view useful for the first customers? It shows weak topics per drive.
  - **Decided 2026-10-03:** Topic data merges into the cohort page.
- Should leaderboard output stay admin-only? The 09 route has `anonymize` and `topN` options (DPDP note in `09 service.ts`).
  - **Decided 2026-10-03:** Yes. The leaderboard stays admin-only.

---

## FR11. Behaviour signals and archetype radar

### First purpose
- Phase 2 `09-scoring` (`64a4d28`, 2026-05-03): derive an archetype label and signals from behaviour during the test. The comment says labels are "L&D coaching tools, NOT hiring/firing proxies" and must show a disclaimer (`09 archetype.ts:8-9`, help key `admin.scoring.archetype.disclaimer`).
- The radar (`ArchetypeRadar.tsx`, first in `18fece2`) draws six axes: pace, edits, flags, focus loss, copy/paste, multi-tab (`ArchetypeRadar.tsx:23-30`).

### What operates today
- `computeSignals` counts events from `attempt_events` and answers (`archetype.ts:60-107`). The result is stored in `attempt_scores.archetype_signals` when the attempt is finalized (`09 finalize.ts:98`, `service.ts:125-142`).
- The radar is still live in `individual-report.tsx:131` (one radar per attempt). The cohort page stopped using it in `578c0aa` (RV14); the cohort page shows archetype counts as bars.
- Integrity v1 (A8, R10) records `tab_blur`, `copy`, `paste`, `fullscreen_exit`, `multi_tab_conflict` from the candidate runner (`useIntegrityHooks.ts:118,159,217`; `06 service.ts:816`).
- The attempt page shows a live count card, `AttemptIntegrityCard` (`attempt-detail.tsx:312`, first commit `83ba3ea`). It reads `GET /api/admin/attempts/:id/integrity` (`06 repository.ts:848-863`).
- Both read the same table and the same event types. They differ in four ways:
  - The radar is a snapshot at finalize. The card is live.
  - The radar adds pace, edits and flags. The card adds `fullscreen_exit` and "paste blocked".
  - The radar has no `fullscreen_exit` axis.
  - They sit on different pages (individual report versus attempt detail).

### Overlap with newer feature
- Integrity v1 card (above). Old plan module `32-anti-cheat-integrity` and roadmap X5 (AI cheat detection) are not built.
- `results-export.ts` also carries an integrity summary column (grep `integrity` in `15`).

### Result
**Improve.** One "Behaviour and integrity" block per attempt that uses both data sets. Keep the radar component and the label logic. Do not add a score or an automatic flag.

### Follow-up tasks
| Id | Task | Size | Modules | Load-bearing? |
|---|---|---|---|---|
| FU-C7 | Add `fullscreen_exit` count to `computeSignals` and the signals schema (additive JSONB field, optional). Add the axis to the radar. | S | 09, 10 | No |
| FU-C8 | One card on the attempt page: live counts (existing) plus the radar, with the disclaimer text. Individual report links to it. | M | 10 | No |
| FU-C9 | Check that `individualReport` (09) shows signals only for tenant-visible attempts. Add a test. | S | 09 | No |

### Owner decision needed
- Should tenant admins see the radar and the archetype label at all? The label is a coaching idea; the integrity counts are facts.
  - **Decided 2026-10-03:** Tenant admins see integrity counts only. No archetype label for tenants.
- Wording for candidates and customers: "recorded events", never "cheating".
  - **Decided 2026-10-03:** Use "recorded events".

---

## FR12. Candidate "my assessments"

### First purpose
- Attempt-engine candidate routes `GET /api/me/assessments` and `POST /api/me/assessments/:id/start` (`06 routes.candidate.ts:66-135`). First commit `4b86753` (2026-05-02), before the magic-link flow.
- The client functions `listInvitedAssessments` and `startAttempt` exist in `11 api.ts:105-120`.

### What operates today
- The routes are registered and tested. `POST …/start` records consent (`attempt-engine.test.ts:659`) and is used by the e2e fixture (`apps/web/e2e/fixtures/factories.ts:398,408`).
- No page calls the client functions. Second search: `listInvitedAssessments` and `startAttempt` appear only in `api.ts` and `index.ts`.
- The candidate portal has three tabs: results, certificates, activity (`App.tsx:136-170`, `CandidateShell.tsx:181-184`). Candidates enter a test only through the invitation link `/take/:token`.
- Wire mismatch found: the server returns `assessment_id`, `duration_minutes`, `invitation_status`, `invitation_expires_at` (`routes.candidate.ts:80-110`). The client type expects `id`, `duration_seconds`, `question_count` (`11 types.ts:93-100`). The list would render wrong data if used now.
- The list does not filter by `opens_at`, `closes_at` or invitation expiry.

### Overlap with newer feature
- Candidate portal (`MyResults`, `MyCertificates`, `CandidateActivity`), the magic-link take flow, the email-OTP candidate login (`/candidate/login`), reminders (R7), and the public drive link (R7, still open, design-gated).

### Result
**Merge** into the candidate portal as an "Upcoming" section (on the results page or a new first tab).

### Follow-up tasks
| Id | Task | Size | Modules | Load-bearing? |
|---|---|---|---|---|
| FU-C10 | Fix the wire: align server and client fields; filter by window and invitation expiry; return `question_count` and `duration`. Update `03-api-contract.md`. | S | 06, 11, docs | No (candidate session chain, review the auth gate) |
| FU-C11 | "Upcoming" card list with a Start button. Start goes through consent, sections and the integrity gate like `/take/start`. Check the campus rate limits for this route (R2 keyed by session). | M | 11, apps/web, 06 | No |

### Owner decision needed
- Do candidates have accounts in every drive, or only invitation links? Campus drives use links. The list helps repeat candidates.
  - **Decided 2026-10-03:** Invitation links by default.
- Link with R7 public drive link: decide together.
  - **Decided 2026-10-03:** Candidate accounts are decided together with R7.

---

## FR13. Completion modal

### First purpose
- Phase 5 Session 6 (`2149ac5`, 2026-05-13): a congratulation pop-up with the certificate and a LinkedIn share button. Shown once per credential and tier (`CompletionModal.tsx` storage key `cert-modal-shown:<credential>:<tier>`).
- Help key `candidate.cert.completion_modal` promises it appears "the first time you view each earned certificate" (`16 candidate.yml:346`).

### What operates today
- The component, its test and the exports exist (`11 components/index.ts`, `src/index.ts`). Nothing mounts it. Second search: the name `CompletionModal` appears only in its own file, its test and the two export files.
- The released result carries only `credential_id` and `verify_url` (`11 types.ts:169-172`). The modal needs `tier`, `course_title`, `pdf_url`. These exist in the `listMyCertificates` data used by `MyCertificates`.
- A candidate first sees a new certificate as a "View certificate" link in `ResultSummary` (`ResultSummary.tsx:107-124`), used by the Submitted page (`Submitted.tsx:288`) and `MyResults.tsx:143`.
- LinkedIn share exists on `MyCertificates` (`MyCertificates.tsx:285-300`).

### Overlap with newer feature
- Released-result page and `MyResults` (owner rule P1: students see only complete results).
- `/try/certificate` demo.

### Result
**Revive** on the released-result view and on `MyCertificates` first view.

### Follow-up tasks
| Id | Task | Size | Modules | Load-bearing? |
|---|---|---|---|---|
| FU-C12 | Add `tier`, assessment name and `pdf_url` to the result certificate payload, or load them with `listMyCertificates`. Mount the modal when a certificate is new. Rename "course_title" in the copy to "assessment". | S | 06 (result projection), 18 (read), 11, apps/web | No |

### Owner decision needed
- None blocking. Confirm that the three tiers (completion, distinction, honors) match what the owner wants candidates to see.
  - **Decided 2026-10-03:** Confirmed. Three tiers: completion, distinction, honors.

---

## FR20. Difficulty tags

### First purpose
- Spec `docs/design/2026-05-23-question-difficulty-spec.md`: tag each generated item with Bloom level, NICE task and the full parameter vector (§ 7). Phase A: structure gates and tags (done). Phase B: warning heuristics. Phase C: measured drift report (§ 6).
- Phase A commits: `667286a` (spec module), `fc61718` (migration 0086), `2c102fa` (generation wiring). Forward-only: only new items get tags (§ 7).

### What operates today
- The generator writes `cognitive_level`, `nice_task_id` and `difficulty_params` (`07 admin-generate.ts:253-277`). `attack_technique` is never set.
- The gate runs and the count `difficulty_dropped` is stored and shown on the Generation attempts page (`generation-attempts.tsx:48,413`).
- The tags are never read back: `QUESTION_COLUMNS` omits them (`04 repository.ts:58`) and the `Question` type has no field (`04 types.ts:298-326`). No page or report shows them. Second search: the column names appear only in the migration and `admin-generate.ts`.
- The three newer question types `numeric`, `multi_select`, `ordering` have no entry in the difficulty spec (`difficulty-spec.ts:96`).
- Data volume for Phase C is small: 5 attempts in production (plan § 8). The university pilot may add MCQ data.

### Overlap with newer feature
- Eval harness and the SP6 agreement tracking (they measure grading, not item difficulty). Pack quality checks at publish (`hasAnchorRubric`, `04 service.ts:171`).

### Result
**Improve.** First show the tags. Then schedule Phase C as plain SQL with no AI.

### Follow-up tasks
| Id | Task | Size | Modules | Load-bearing? |
|---|---|---|---|---|
| FU-C13 | Add the four columns to `QUESTION_COLUMNS` and the `Question` type. Show Bloom and NICE chips in the question editor and pack detail. Update `03-api-contract.md`. | S | 04, 10, docs | No |
| FU-C14 | Phase C report: per-item success rate, level gradient L1 > L2 > L3, discrimination, `miscalibrated` flag (spec § 6). Read-only SQL, super admin view. Start when volume exists. | M | 15 or tools script | No |
| FU-C15 | Decide the difficulty targets for `numeric`, `multi_select` and `ordering`, or record "no spec by design". | S | 04, docs | No |

### Owner decision needed
- Is the report platform-wide (super admin only)? Packs are platform-authored, so a cross-company view fits.
  - **Decided 2026-10-03:** Yes. Super admin only.
- What data volume starts Phase C?
  - **Decided 2026-10-03:** Phase C starts at 30+ attempts per question.

---

## FR25. Rubric validation in two places

### First purpose
- Phase 2 `PHASE_2_KICKOFF.md` P2.D12: module 08 owns the rubric DSL. First commit `8600ce9` (2026-05-03) lifted `RubricSchema` out of module 04 and added `validateRubric`.

### What operates today
There are four places, not two.

| Place | What it does | Evidence |
|---|---|---|
| 08 `validateRubric` | Returns `{ valid, errors: string[] }`. No caller outside tests. | `08 validate.ts:15-29`; callers: only `rubric-engine.test.ts` |
| 04 `validateRubric` | Calls the same `RubricSchema`. Returns `{ ok, data \| errors: ZodIssue[] }`. Used by create and update question (live). | `04 types.ts:207-217`, `04 service.ts:153`; schema import `04 types.ts:2-8` |
| 04 save-rubric function | Calls `RubricSchema.safeParse` directly (third copy of the call). | `04 service.ts:1930-1938` |
| 07 mirror `SubmitRubricOutputSchema` | Own Zod copy for generated rubrics. Bands need `min(1)`. | `07 claude-code-vps.ts:914-945` |
| JSON Schema for import | Same shape, no sum rule. | `04 schemas/import.schema.json:287-322` |

- Strictness is equal for 08 and 04: both use the same `RubricSchema` (`08 types.ts:56-72`). The register question "which is stricter" has the answer "same". The 08 comment says the two coexist on purpose (`validate.ts:6-11`).
- The strictest rule set is the 07 mirror: it forbids empty band text. The 07 comment says the copy "avoids dep on `@assessiq/rubric-engine`", but the same file imports `finalScore` from it (`claude-code-vps.ts:50`). The reason is stale.
- Rules that no copy checks:
  - the sum of anchor weights equals `anchor_weight_total`;
  - anchor ids are unique;
  - band text is not empty (08 and 04 accept `""`).
  `finalScore` adds anchor weights for hits (`08 score.ts:28-38`) and takes the maximum from the declared totals (`:62-67`), so a mismatch can give a score above the maximum. The sample pack is consistent (45/45, 40/40, 45/45).
- The e2e fixture rubric uses `anchor_weight_total: 100` and `reasoning_weight_total: 100` (`apps/web/e2e/fixtures/factories.ts:281-282`). The rule "sum = 100" rejects it. This is a stale fixture (task E13).

### Overlap with newer feature
- Grade-time rubric synthesis in module 07 (`admin-grade.ts:185-227`): builds rubrics in code with fixed totals. A single rule set in 08 would also check these.

### Result
**Improve.** Module 08 owns all rubric rules, as planned. Module 04 and module 07 call 08. Keep the 04 export name and the ZodIssue shape for callers.

### Follow-up tasks
| Id | Task | Size | Modules | Load-bearing? |
|---|---|---|---|---|
| FU-C16 | In 08 add `parseRubric` (ZodIssue shape) and build `validateRubric` on it. In 04 re-export it as `validateRubric`; remove the local copy and the direct `safeParse` at `service.ts:1930`. | S | 08, 04 | No |
| FU-C17 | Add rules in 08 once: anchor weights sum to `anchor_weight_total`, unique anchor ids, non-empty band text. First run a read-only query on stored rubrics (owner or a read-only session) to count rows that would fail. Warn before reject. | M | 08, 04 | No, but it changes score math safety: adversarial review |
| FU-C18 | Replace the 07 mirror schema with the 08 schema plus `.strict()` generation rules. Fix the stale comment. | S | 07 | Yes, 07 (codex gate) |
| FU-C19 | Fix the e2e fixture totals (with E13). | S | apps/web e2e | No |

### Owner decision needed
- None for FU-C16. FU-C17 needs approval to reject existing bad rubrics, or only warn, after the row count is known.
  - **Decided 2026-10-03:** Warn on old rubrics, reject on new saves (FU-C17 built 2026-10-03).

---

## Summary table

| Item | Result | Follow-up tasks | Owner decision |
|---|---|---|---|
| FR8 Grading jobs page, `pending_admin_grading` | Improve (tenant "Evaluation status") | FU-C1, FU-C2 | Show expected time to tenants? Menu name |
| FR10 Old report routes | Merge topic data into cohort page; park exports, 09 leaderboard, cost-by-month; keep refresh | FU-C3, FU-C4, FU-C5, FU-C6 | Topic view needed? Leaderboard rules |
| FR11 Behaviour signals and radar | Improve (one behaviour and integrity block) | FU-C7, FU-C8, FU-C9 | Do tenants see radar and label? Wording |
| FR12 Candidate "my assessments" | Merge into candidate portal as "Upcoming" | FU-C10, FU-C11 | Accounts versus links; with R7 drive link |
| FR13 Completion modal | Revive on released-result view and `MyCertificates` | FU-C12 | None blocking |
| FR20 Difficulty tags | Improve (show tags; Phase C later) | FU-C13, FU-C14, FU-C15 | Report scope; data volume to start |
| FR25 Rubric validation | Improve (module 08 owns all rules) | FU-C16, FU-C17, FU-C18, FU-C19 | Reject or warn on old rubrics |
