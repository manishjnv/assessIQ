# Scoring & Result Release + Platform Evaluation Queue (SP1–SP4, SP9–SP11)

**Status:** LIVE on production (https://assessiq.in) since 1 October 2026.
Phase I = merges `b8163e1`, `7d56d75`, `b41916c` + fix `ecea951`. Phase II = merges `ee8a28f`, `1564489` + fix `a7b4596`. Reference docs = `c896a6b`.
**Owner rules:**
- P1: a student sees only a complete, final score.
- P2: if it can't be ready within about a minute, the student is told it will be emailed.
- P3: each company chooses Auto or Manual publishing.
- P4: use as little AI as possible.

**Owner decision (1 Oct 2026):** AI evaluation is run only by the platform super admin (the owner). Companies review and publish. The product has plan tiers (owner decision, 2 Oct 2026); tier contents and prices are not decided yet.
**Where the detail lives:**

| Topic | Doc |
| --- | --- |
| Columns, migrations, complete-result rule, derived states | `docs/02-data-model.md` § Scoring and result release |
| Every route, auth chain, error code | `docs/03-api-contract.md` (2026-10-01 section) |
| Why only the owner runs AI; flow; queue eligibility | `docs/05-ai-pipeline.md` § Platform evaluation queue |
| Worker jobs, log events, audit rows, triage | `docs/11-observability.md` § 34 |
| Defects found and fixed on the way (11 entries) | `docs/RCA_LOG.md` (2026-10-01) |
| Module internals and invariants | `modules/07-ai-grading/SKILL.md`, `modules/09-scoring/SKILL.md` |
| Manual test script for the owner (local, not in git) | `docs/testing/AssessIQ_Scoring_Release_Test_Script.docx` |

---

## 1. What changed, in plain words

- **Students** see a result only when it is complete and final:
  - **On screen within about a minute** when that is possible: an all-MCQ test and a company in Auto mode. The submit screen polls every 5 s, up to 60 s.
  - **Otherwise a clear message** that the result will be emailed to their masked address. For written tests it also gives the expected turnaround ("within 72 hours" by default).
  - A **"My results"** page (`/candidate/results`) and a **result email** with a link to sign in.
- **Companies** pick **Manual (default)** or **Automatic** publishing in their settings.
  - Manual: the admin publishes one result or all ready results.
  - Automatic: a background sweep publishes finished results within about 15 s.
  - Companies review evaluated answers read-only. They can override a score with a reason, or send it back to AssessIQ with a note.
  - They can **no longer run AI grading**.
- **The super admin (owner)** gets a blind, cross-company **evaluation queue** at `/admin/platform/evaluations`, with no candidate name or email. The steps per attempt are:
  1. run the AI (sync, one at a time);
  2. accept, override or re-run per question, and enter a manual score for KQL;
  3. **release to company**.

  An email alert goes out when anything has waited more than 24 hours.
- **MCQ answers** are scored at submit (no AI). Written answers (subjective, scenario, log analysis) and KQL go to the queue.

## 2. Why

- **Trust.** Partial or provisional scores confuse students and invite disputes (P1). The old "fully graded" check let KQL answers and `review_needed` (unreviewed) grades through. See RCA 2026-10-01 "Fully graded check…".
- **Results never reached students before.** The result endpoint always answered "pending" and the result email was never sent (RCA 2026-10-01).
- **Compliance.** Phase 1 AI runs on the owner's personal Claude subscription through Claude Code on the VPS. Its terms assume ordinary individual use. Letting any company admin click "Grade" put customers' requests behind that subscription. With the owner as the only evaluator, each item gets one human click and one human review (see `docs/05-ai-pipeline.md`).
- **Company control.** Hiring teams want to check scores before candidates see them (Manual). Campus or practice drives want instant results (Auto).

## 3. How it works

### 3.1 One definition of "complete"
- An attempt is complete when **every** question it was served (all 5 types, KQL included) has an effective grade that is not `review_needed`.
- The effective grade is the newest grading row per question; an admin override wins a tie.
- `finalizeAttemptIfComplete` (`modules/09-scoring/src/finalize.ts`) is the only place that decides this.
  - Callers: MCQ scoring at submit, accept, override and manual score.
  - In one transaction it locks the attempt, re-checks completeness, computes the score, sets status `graded`, and records billing (`recordGradedAttempt`, same transaction by design).

### 3.2 States (no new status value)
The `attempts.status` enum is unchanged. New columns (migration 0113) carry the hand-over:

| Status + columns | Derived `evaluation_status` | Who acts next |
| --- | --- | --- |
| `submitted` / `auto_submitted` / `pending_admin_grading`, or `graded` with `evaluation_released_at` NULL | `awaiting_evaluation` | Super admin (queue) |
| `graded` with `evaluation_released_at` set | `ready_to_publish` | Company admin (Manual) or the sweep (Auto) |
| `released` | `published` | Nobody: final (409 `RESULT_ALREADY_PUBLISHED`) |

- All-MCQ attempts set `evaluation_released_at` at submit, so they skip the queue.
- "Send back" clears `evaluation_released_at` and records `evaluation_note` and `evaluation_sent_back_at`. The attempt stays `graded`, so there is no re-billing.

### 3.3 Publishing (release)
- `releaseAttemptInTx` (`modules/09-scoring/src/release.ts`) is the one release path. Manual publish, "publish all" and the Auto sweep all use it. It:
  - refuses erased candidates and unfinished or flagged results;
  - for the Auto trigger, re-reads the company's mode under `FOR SHARE`;
  - writes one audit row;
  - issues the certificate inside `SAVEPOINT release_cert`, so a certificate error never undoes the release.
- The email is sent after commit.
- **Auto mode only publishes results that became ready after the switch to Auto** (`tenant_settings.result_release_auto_since`, migration 0114). This stops old, held results from being published by surprise.
- The sweep `result.auto_release` (worker, every 15 s):
  - reads candidates across companies with a read-only system role;
  - releases each one inside that company's tenant context;
  - skips embedded attempts;
  - cools a failing row down for 10 minutes.

### 3.4 Platform evaluation queue
- **Queue membership:** at least one non-MCQ question, candidate not erased, company active, and status still awaiting evaluation (pre-graded, or graded but not released to the company).
- The same predicate is written in three places and must change together:
  - the queue list;
  - the `grade`/`rerun` guard (`assertInEvaluationQueue`, 409 `NOT_IN_EVALUATION_QUEUE`);
  - the worker alert job.
- **Tenancy:** the only cross-company access is a **read-only** system-role transaction (the queue list and the attempt → company lookup). Every write runs in `withTenant(<attempt's company>)` with RLS applied. Audit rows land in that company's log with the super admin as actor.
- **AI rules unchanged (D2/D7/D8):** the AI runs only on a human click, synchronously, one run at a time, with a 5-minute activity heartbeat. Nothing is committed until accepted. `lint:ambient-ai` is untouched, and neither worker job calls AI.
- **Company routes** that used to run or commit AI now answer 403 `AI_EVALUATION_BY_ASSESSIQ`: grade, accept, re-run, manual score and grading-job retry. Before the hand-over, a company override answers 409 `EVALUATION_NOT_RELEASED`.

### 3.5 Candidate side
- Submit returns:
  - `result_expectation` (`soon` or `email`);
  - the company's release mode;
  - the masked email;
  - the turnaround text (`EVALUATION_TURNAROUND_TEXT`).
- `GET /api/me/attempts/:id/result` returns 200 with the complete result once published, else 202 with what to expect. `GET /api/me/results` lists published results.
- The candidate never sees answers, bands or AI justifications.
- Candidate login reads `?tenant=<slug>` (the result email uses it) and asks for an "Organisation code" when it is missing.
- Activity stats and the leaderboard count only published results.

### 3.6 Notifications
- `result_released`: score, pass/fail, a certificate link when earned, and a sign-in link. Not sent for erased or embedded attempts.
- `evaluation_queue_alert`: count, oldest age and a link to the queue.
  - Sent hourly by worker job `evaluation.queue_alert`, at most once per 24 h (Redis `SET NX EX`).
  - Recipients come from `SUPER_ADMIN_EMAILS`, which defaults to the platform owner's address. An empty value logs a warning and sends nothing.

## 4. Data model and migrations

| Migration | What |
| --- | --- |
| `0113_attempts_evaluation_release.sql` (06) | `attempts.evaluation_released_at`, `evaluation_released_by`, `evaluation_note`, `evaluation_sent_back_at`; backfill so existing graded/released rows count as released to the company; partial index `attempts_ready_to_release_idx` |
| `0114_tenant_settings_result_release_mode.sql` (02) | `tenant_settings.result_release_mode` (`manual` default / `auto`), `result_release_auto_since` (NULL while manual) |
| `0115_seed_result_release_help.sql` (16) | help text for the release setting, My results, organisation code |
| `0116_seed_evaluation_queue_help.sql` (16) | 13 help rows: evaluation queue, evaluate page, company review, publish all |

All four are **additive**: new nullable columns and new help rows. Older code ignores them.

**How they were applied in production:**
1. Each file ran in one transaction: `psql -1 -v ON_ERROR_STOP=1`, from a script copied to the VPS and run with `bash script < /dev/null`. Piping a script into `ssh … bash -s` silently stops, because `docker exec -i` swallows stdin.
2. The script then recorded the file's basename and sha256 in `schema_migrations`.

Help rows went from 146 to 159 after 0116.

## 5. Configuration

| Key | Default | Notes |
| --- | --- | --- |
| `EVALUATION_TURNAROUND_TEXT` | `within 72 hours` | Shown to students whose result will be emailed. Set it to the real turnaround. Not set in prod, so the default applies. |
| `SUPER_ADMIN_EMAILS` | the platform owner's address | Recipients of the queue alert. This key already existed. |

## 6. Files touched (non-test; 144 files incl. tests, +15.5k / −2.2k lines)

- **apps/api:**
  - new `jobs/auto-release.ts`, `jobs/evaluation-queue-alert.ts`, `routes/admin-super-evaluations.ts`;
  - changed `routes/admin-tenant-settings.ts`, `routes/auth/candidate.ts`, `server.ts`, `worker.ts`.
- **apps/web:** `App.tsx` (routes), `pages/candidate/CandidateLogin.tsx`, `CandidateLoginVerify.tsx`, `pages/take/{Attempt,PreTest,Submitted}.tsx`.
- **00-core:** `config.ts` (`EVALUATION_TURNAROUND_TEXT`).
- **02-tenancy:** migration 0114; `service.ts` (`updateResultReleaseMode`), `repository.ts`, `types.ts`, `index.ts`.
- **06-attempt-engine:** migration 0113; new `result.ts`; `routes.candidate.ts`, `service.ts`, `index.ts`.
- **07-ai-grading:**
  - new handlers `admin-manual-score.ts`, `admin-release-all.ts`, `admin-send-back.ts`, `super-evaluations.ts`, and new `routes-super.ts`;
  - changed `admin-accept.ts`, `admin-override.ts`, `admin-grade.ts`, `admin-claim-release.ts`, `repository.ts`, `routes.ts`, `types.ts`, `index.ts`.
- **09-scoring:** new `finalize.ts`, `release.ts`; changed `mcq.ts`, `repository.ts`, `index.ts`.
- **10-admin-dashboard:**
  - new pages `evaluations-queue.tsx`, `evaluation-detail.tsx`;
  - new `components/AttemptGradingPanel.tsx`, `components/useMfaGuard.tsx`, `lib/evaluation.ts`, `lib/band-score.ts`;
  - changed `attempt-detail.tsx` (now the company review page), `assessment-detail.tsx` (publish all), `attempts.tsx`, `dashboard.tsx`, `grading-jobs.tsx`, `tenant-settings.tsx` (Result release), `admin-guide.tsx`, `AdminShell.tsx` (navigation), `ReleaseConfirmModal.tsx`, `lib/status.ts`.
- **11-candidate-ui:** new `MyResults.tsx`, `ResultSummary.tsx`; `CandidateShell.tsx`, `api.ts`, `types.ts`.
- **13-notifications:**
  - new `email/result-released.ts`, `email/evaluation-queue-alert.ts`, and the `result_released` + `evaluation_queue_alert` templates;
  - changed `render.ts`, `strings/en.json`, `index.ts`, `types.ts`.
- **14-audit-log:** `types.ts` (catalog actions `grading.evaluation_released`, `grading.sent_back`).
- **15-analytics:** `activity-candidate/{stats,leaderboard}.ts` (published only), `activity/feed.ts`, `results-export.ts` (CSV shows "Awaiting evaluation").
- **16-help-system:** migrations 0115/0116; `content/en/{admin,candidate}.yml`.
- **18-certification:** `service.ts`, `types.ts` (system actor allowed for auto-release).

## 7. Considered and rejected

- **A new `attempts.status` value for the hand-over.** The enum is read by many modules (06, 07, 09, the analytics MV, both frontends), so new columns were used instead.
- **Company admins triggering AI on the owner's subscription.** This is the compliance problem above.
- **Per-company API keys (BYOK).** Compliant, but not built. Revisit with the paid-API decision (OD2).
- **Background AI grading after submit.** It breaks the no-ambient-AI rule (CLAUDE.md #1) and needs a paid API.
- **Showing a partial MCQ score while written answers wait.** Against P1.
- **Auto mode publishing every waiting result at the moment of the switch.** Replaced by `result_release_auto_since`.

## 8. Not included / follow-ups

- **Owner decisions recorded after this build, not built yet:**
  - release to the company automatically when the super admin accepts the last grade (today it is an explicit "release to company" step);
  - an `AI_PIPELINE_MODE` switch that lets companies run AI themselves once an API key exists (today the company AI routes answer 403 in every mode).
- **SP5–SP8 from the plan:**
  - answer reuse and rule tiers;
  - calibration examples and agreement tracking;
  - more auto-gradable types and a real KQL grader (until then KQL needs a manual score);
  - calibrated auto-commit.
- **Privacy notice and company terms** must disclose that AssessIQ evaluators read answers with AI assistance. The take-test consent copy already does (policy version `2026-10-02`).
- **Email capacity:** the shared Brevo free plan allows about 300 emails a day.

## 9. How to verify

- **Automated:**
  - `pnpm -C modules/07-ai-grading exec vitest run src/__tests__/super-evaluation.test.ts` (7 tests: queue, blind payload, lifecycle across companies, release refusals, route gates, queue eligibility);
  - `modules/09-scoring` finalize/release tests;
  - `modules/10-admin-dashboard` and `apps/web` suites;
  - `pnpm lint:ambient-ai`.
- **Live, quick:**
  - `https://assessiq.in/api/health` returns 200;
  - logged out, `GET /api/admin/super/evaluations` and `POST /api/admin/super/evaluations/<id>/grade` return 401;
  - `/admin/platform/evaluations` serves the app.
  - Use `assessiq.in` directly: `assessiq.automateedge.cloud` answers a 301, and a redirected POST turns into a GET.
- **Worker:**
  - `result.auto_release` ticks in the `assessiq-worker` logs every 15 s;
  - `evaluation.queue_alert` is a repeatable job in Redis (`ZRANGE bull:assessiq-cron:repeat`) and first fires at the next hour boundary after a restart.
- **End to end:** run the owner's test script `docs/testing/AssessIQ_Scoring_Release_Test_Script.docx`. It covers MCQ in Manual and Auto, the written flow through the queue, send back, override, publish all, the company-has-no-AI check, final results and the alert.

## 10. Deploy record (1 October 2026)

Additive only, `assessiq-*` containers only. Before each recreate, a check confirmed that no Claude grading run was in progress inside `assessiq-api`.
1. `ssh assessiq-vps 'cd /srv/assessiq && git pull --ff-only'`.
2. Apply new migrations as in § 4.
3. `docker compose -f infra/docker-compose.yml build assessiq-api assessiq-frontend`. The worker uses the api image.
4. `docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-api assessiq-worker assessiq-frontend`.
5. Wait until api and frontend report healthy (about 18 s), then run the checks in § 9.

Phase I went live at `ecea951` with migrations 0113–0115, and Phase II at `a7b4596` with 0116. Later commits are documentation only and need no rebuild.

## 11. Rollback

- **Stop auto-publishing without a deploy:** set the company back to Manual in its settings. This clears `result_release_auto_since`, and the sweep then ignores it.
- **Silence the owner alert:** set `SUPER_ADMIN_EMAILS` to an empty value and recreate the worker. The job logs a warning and sends nothing.
- **Code:** revert the merges newest first (`a7b4596`, `1564489`, `ee8a28f`, then `ecea951`, `b41916c`, `7d56d75`, `b8163e1`), push, pull on the VPS, rebuild, and recreate api, worker and frontend (§ 10).
  - Rolling back Phase II **re-opens company-side AI routes**. Keep the 403s, or take the compliance decision again, before doing that.
- **Database:** no rollback needed. The migrations are additive, and older code ignores the new columns and help rows. Do not drop the columns while any release history depends on them.
