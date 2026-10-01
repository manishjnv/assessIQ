# Pilot readiness batch (2026-10-01): invites, email + webhook hardening, release on last accept, option shuffle

**Status:** LIVE on production (https://assessiq.in) since 1 October 2026, at commit `a86bce2`. Reference docs are in `3593bec`; this file was added in the commit after it.
**Scope.** These are the five tasks from `docs/PENDING_TASKS_2026-10-01.md` that a Claude session could build without the owner:
- R7 core (invites);
- A5, code side (email delivery);
- R8, webhook part;
- the owner's SP10 decision (release on the last accept), plus the sent-back Re-run gap;
- R9, option shuffle.

**Not included:**
- The owner's own tasks: test runs, the email plan upgrade and pilot company creation.
- The `AI_PIPELINE_MODE` switch, deferred to OD2.

**Where the detail lives:**

| Topic | Doc |
| --- | --- |
| Columns, migrations 0117–0121, invitation lifecycle, `option_order` | `docs/02-data-model.md` § "Invitations, notifications and option shuffle" |
| New and changed routes, error codes, webhook URL rules and headers | `docs/03-api-contract.md` § "2026-10-01 (later)" + the updated webhook section |
| Webhook receiver sample (V2 signature, unix timestamp) | `docs/09-integration-guide.md` § "Signature verification" |
| Release on the last accept, Re-run AI, D7 supersede rule | `docs/05-ai-pipeline.md` § "Update 2026-10-01 (later)" |
| Email classes, retries, SMTP timeouts, log events, triage | `docs/11-observability.md` § 35, `docs/13-email-system.md` § 7 |
| Applying migrations by hand on the VPS | `docs/06-deployment.md` § "Applying new migrations by hand" |
| Defects found and fixed | `docs/RCA_LOG.md` (five entries, 2026-10-01) |
| Module internals | `SKILL.md` of modules 05, 06, 07, 09, 13 |
| Owner's manual test (T10 resend, T11 shuffle; T3/T4 updated) | `docs/testing/AssessIQ_Scoring_Release_Test_Script.docx` (local, not in git) |

---

## 1. What changed, in plain words

1. **Invites.**
   - Candidate invitation links last **7 days**, as the help text always said; they used to last 72 h.
   - Company admins can press **Resend** on one invitation, or **Resend to everyone who hasn't started**. The old link stops working at once and a fresh 7-day link is emailed.
   - Inviting a student again after a revoke (by hand or by CSV import) now works.
2. **Email delivery.**
   - If the provider's daily limit is hit, invitation and result emails are retried for about 45 hours instead of being lost after about 2 minutes.
   - Sign-in codes and sign-in links are sent before bulk mail.
   - A hung SMTP connection can no longer block the background worker, which also runs the test timer and auto-publish, for minutes.
   - Email and webhook delivery statuses are now actually saved.
3. **Webhooks.**
   - A company cannot point a webhook at an internal or private address. This is checked when the webhook is registered and again at the moment each delivery connects.
   - Redirects are not followed.
   - Every delivery carries a signed timestamp, so a captured delivery cannot be replayed.
4. **Evaluation flow.**
   - When the owner accepts the **last** grade of an attempt, the result is handed to the company in the same step, and the page shows "Released to <company>.". There is no separate click.
   - A result the company **sent back** now has a **Re-run AI** button. After the new grades are accepted, it is released with "Release to company".
5. **Option shuffle.**
   - Each student sees the multiple-choice options of each question in their own random order. The order stays the same if the page is reloaded.
   - Scoring, admin review and exports are unchanged.
   - Questions whose options refer to each other ("All of the above", "Both A and B") keep their order.
   - It follows the assessment's existing `randomize` setting (on by default).

## 2. Why

- **Invites:** the campus pilot invites 100+ students at once. Some will miss a 72-hour window, and nobody could fix that from the UI. The help text and the code also disagreed (RCA 2026-10-01).
- **Email:** the provider's free plan allows 300 emails a day, shared with other products. One class's invites, results and sign-in codes can hit that, and every failure was a lost email.
  - The same queue also carries the cron jobs, so a large CSV import delayed sign-in codes.
  - While checking this, production showed that every `email_log` row stayed `queued`: the table had no UPDATE RLS policy (RCA).
- **Webhooks:** the server is shared with other apps and with our own Postgres and Redis. Before an outside company admin gets access, a tenant-controlled URL must not reach internal addresses. No company had a webhook yet, so the timestamp format could change safely.
- **Release on the last accept:** this is the owner's decision. Accepting each grade already is the review, so a separate "Release to company" click added nothing for a first evaluation.
- **Re-run AI:** sent-back attempts could only be fixed with manual overrides.
- **Option shuffle:** students in a lab sit side by side, and the marketing site already claimed this feature.

## 3. How it works

### 3.1 Invitations (`modules/05-assessment-lifecycle`)
- **TTL.** `DEFAULT_INVITATION_TTL_HOURS = 168` (`src/tokens.ts`).
- **Re-issue.** A re-issue rotates `token_hash` on the same row, sets `expires_at = now() + 7 days`, `status = 'pending'` and `last_resent_at = now()`, and writes one audit row, all in one transaction. The email is sent after commit.
- **Resend checks.** Resend locks the invitation row, then checks that the candidate has not started and that the assessment is published or active.
- **Attempt start takes the same lock.** `findInvitationForCandidate` in module 06 reads the row `FOR UPDATE` (`a86bce2`, from the Codex review), so the two take turns:
  - if the start wins, the resend sees the attempt and answers 409;
  - if the resend wins, the start re-validates the fresh row.
- **Bulk resend:**
  - one transaction per row, at most 200 per call;
  - it skips revoked rows and rows re-issued in the last 10 minutes, so `remaining` shrinks and a double click sends nothing.
- **Re-invite.** Re-inviting a revoked (`status='expired'`) or lapsed (pending/viewed with a past expiry) row re-activates it, using the same steps as a resend.
- **Expired-link page.** The candidate landing page says the link "has expired or was replaced by a newer invitation" and to ask for a resend.

### 3.2 Email delivery (`modules/13-notifications`, `apps/api/src/worker.ts`)
- **Two classes by template** (`email/delivery-policy.ts`, `EMAIL_CLASS: Record<EmailTemplateName, …>`):
  - **auth** (`admin_email_otp`, `candidate_login_link`, `invitation_admin`): no BullMQ priority. BullMQ pops the `wait` list before the `prioritized` set, so auth mail and cron jobs run before any bulk mail. 5 attempts, exponential from 5 s.
  - **bulk** (every other template): priority 100, 11 attempts, custom backoff `email-bulk` (1m, 5m, 15m, 1h, 2h, 4h, 6h, 8h, 12h, 12h; about 45 h). `webhook.deliver` jobs use the same priority.
- **Permanent recipient errors.** SMTP 5.1.x (not on MAIL FROM) is thrown as `UnrecoverableError` and fails at once.
- **SMTP timeouts.** Connection 10 s, greeting 10 s, socket 30 s are appended to the SMTP URL unless already set (`email/transport.ts` `withSmtpTimeouts`). nodemailer's `createTransport(url)` ignores other option objects, so URL query parameters are the only way to pass them.
- **Status.** `email_log.status` is `queued` between retries, `sent` on delivery and `failed` only when final. These writes persist only since migration 0121.

### 3.3 Webhooks (`modules/13-notifications/src/webhooks`)
- **Create-time check** (`url-policy.ts`):
  - https only (http only outside production);
  - no userinfo;
  - not `localhost`;
  - not a blocked IP literal (IPv4 and IPv6, including mapped, compatible, NAT64 and zone-id forms).
  - Otherwise 400 `WEBHOOK_URL_NOT_ALLOWED` with a `reason`.
- **Delivery** (`safe-post.ts`) uses Node core `http`/`https` with a custom `lookup`:
  - The hostname is resolved by the call that opens the socket, and ANY blocked answer refuses the delivery. This means there is no gap between the check and the connect for DNS rebinding.
  - `agent: false`, so no proxy and no pooling.
  - No redirect handling, so a 3xx is a permanent failure.
  - One 10 s deadline; at most 2 KB of the response is kept.
  - Refusals are recorded `failed` (`blocked_address` / `blocked_url`) and never retried.
- **Signing.**
  - `X-AssessIQ-Timestamp` is unix seconds.
  - `X-AssessIQ-Signature-V2 = sha256=HMAC(secret, "<ts>.<raw body>")`; `verifySignatureV2` in `signature.ts` is the reference receiver.
  - The V1 body-only signature is still sent.

### 3.4 Release on the last accept + Re-run AI (`modules/07-ai-grading`, `modules/09-scoring`, `modules/10-admin-dashboard`)
- **Release.** The super-admin accept, manual-score and override routes pass `markEvaluationReleased: true`, and `finalizeAttemptIfComplete` takes `releasedBy`.
  - finalize flips only PRE-GRADED attempts. The call that completes an attempt therefore sets `evaluation_released_at` and `_by` in the same statement as the `graded` flip, with billing still in that transaction.
  - A sent-back attempt (already `graded`) is never auto-released; it uses "Release to company".
  - An erased candidate's attempt is never handed over (`isAttemptCandidateErased`).
  - The hand-over is recorded in the existing audit row (`after.evaluation_released: true`). There is no new audit call site.
- **Re-run AI** (attempt-level, on a sent-back attempt):
  - it reuses the existing super `rerun` route, which accepts `graded`;
  - it sets the grading marker and caches `ai_proposals` like Grade all, and clears the marker on failure;
  - it uses the same rubric resolution as Grade all (`resolveGradingRubric`).
- **D7 refinement (accept).** On an already-graded attempt, a proposal generated after the question's newest grading is a new verdict.
  - It is written as a new row with `override_of` = the superseded same-SHA row. The newest row wins; the D7 partial unique index only covers `override_of IS NULL`.
  - Replays and stale tabs are still skipped.
  - Totals pick the newest row per question (`09-scoring/src/repository.ts` `getGradingsForAttempt`).
- **UI.**
  - A notice before the last accept: "Accepting the last grade releases this result to <company>…".
  - "Released to <company>." and "Back to the queue" afterwards.
  - "Re-run AI" (and "Re-running…") on sent-back attempts; per-question label "re-run ready".
- **Help.** Help seed 0118 rewrites the 7 release-related help rows and adds `admin.evaluations.rerun_ai`.

### 3.5 Option shuffle (`modules/06-attempt-engine`)
- **Storing the order.** `startAttempt` is the only writer of `attempt_questions`; standard and embed starts both arrive there. It stores `option_order` (display position → original index) for each eligible MCQ when `assessments.randomize` is true.
- **What is not shuffled.** `option-shuffle.ts` refuses options that refer to each other (all/none/both/neither/either/nor, letter references) and non-Latin options; when unsure, it does not shuffle.
- **Mapping.**
  - `saveAnswer` (the only save path) maps the displayed index to the original before storing.
  - `getAttemptForCandidate` and `listAnswersForAttempt` map back to display order.
  - The permutation and `correct` are never sent to the candidate. Stored answers stay in original-index space.

## 4. Data model and migrations

| Migration | What |
| --- | --- |
| `0117_invitation_last_resent_at.sql` (05) | `assessment_invitations.last_resent_at TIMESTAMPTZ NULL` |
| `0118_update_evaluation_release_help.sql` (16) | 7 help rows rewritten for release-on-last-accept; adds `admin.evaluations.rerun_ai` |
| `0119_attempt_questions_option_order.sql` (06) | `attempt_questions.option_order SMALLINT[] NULL` (NULL = authored order) |
| `0120_seed_invite_resend_help.sql` (16) | 3 resend help keys; `admin.platform.admin_email` fixed (72 h → 7 days) |
| `0121_notifications_update_policies.sql` (13) | `tenant_isolation_update` (USING + WITH CHECK) on `email_log` and `webhook_deliveries` |

- **All additive and safe to re-run** (`ADD COLUMN IF NOT EXISTS`, `DROP POLICY IF EXISTS` + `CREATE`, `ON CONFLICT DO NOTHING`).
- **Applied in production on 2026-10-01**, in number order, BEFORE the image rebuild. The new `saveAnswer` reads `option_order`.
- **Method:** see `docs/06-deployment.md`.
- **Result:** help rows went from 159 to 163.

## 5. API summary (details in `docs/03-api-contract.md`)

| Route | Who | Change |
| --- | --- | --- |
| `POST /api/admin/invitations/:id/resend` | company admin | new: 200 / 404 `INVITATION_NOT_FOUND` / 409 `INVITATION_ALREADY_STARTED`, `ASSESSMENT_NOT_ACTIVE`, `USER_INACTIVE` / 502 `INVITATION_EMAIL_FAILED` |
| `POST /api/admin/assessments/:id/invitations/resend` | company admin | new: `{ resent, skipped, remaining }` |
| `GET /api/admin/assessments/:id/invitations` | company admin | rows gain `can_resend`; the response gains `resendable` |
| `POST /api/admin/assessments/:id/invite`, CSV import | company admin | revoked/lapsed rows are re-activated |
| `POST /api/admin/webhooks` | company admin | URL rules, 400 `WEBHOOK_URL_NOT_ALLOWED` |
| Webhook delivery | — | `X-AssessIQ-Timestamp` in unix seconds; new `X-AssessIQ-Signature-V2`; no redirects; private destinations refused |
| `POST /api/admin/super/evaluations/:id/{accept,manual-score,…/override}` | super admin | releases to the company when it completes the attempt |
| `POST /api/admin/super/evaluations/:id/rerun` | super admin | on a sent-back attempt: marker + cached proposals |
| `GET /api/me/attempts/:id`, `POST /api/me/attempts/:id/answer` | candidate | MCQ options and `selected` in display order |

## 6. Files touched

67 files including tests; about 6,350 lines added and 480 removed. Non-test files:
- **apps:** `api/src/worker.ts` (bulk backoff routing); `web/src/pages/take/TokenLanding.tsx` (expired/replaced copy).
- **05:** migration 0117; `src/{tokens,types,repository,service,routes,index}.ts`; `SKILL.md`.
- **06:** migration 0119; new `src/option-shuffle.ts`; `src/{repository,service,types}.ts`; `SKILL.md`.
- **07:** `src/handlers/{admin-accept,admin-grade,admin-manual-score,admin-override,admin-rerun,super-evaluations}.ts`; `src/{repository,routes-super}.ts`; `SKILL.md`.
- **09:** `src/finalize.ts` (`releasedBy`); `SKILL.md`.
- **10:**
  - `src/components/AttemptGradingPanel.tsx`;
  - `src/lib/evaluation.ts`;
  - `src/pages/{assessment-detail,evaluation-detail,evaluations-queue,admin-guide}.tsx`.
- **11:** `src/components/CandidateHelp.tsx`.
- **13:**
  - migration 0121;
  - new `src/email/delivery-policy.ts`, `src/webhooks/{safe-post,url-policy}.ts`;
  - `src/email/{index,transport}.ts`, `src/webhooks/{deliver-job,service,signature}.ts`, `src/index.ts`;
  - `SKILL.md`.
- **14:** `src/types.ts` (`assessment.invitation.resent`).
- **16:** migrations 0118 and 0120; `content/en/admin.yml`.

## 7. Considered and rejected

- **Invites:**
  - a new "revoked" status (the existing semantics are enough);
  - a per-assessment link lifetime setting (one 7-day value, matching the copy);
  - automatic reminder emails (they would spend the shared email quota).
- **Email:**
  - an AssessIQ-side daily email cap that defers bulk mail to the next day. It could silently delay a same-day drive; the retry window plus a plan upgrade is the better trade.
  - a separate email queue (priorities cover the urgent case for now).
- **Webhooks:**
  - resolve-then-fetch with a pre-check: it is open to DNS rebinding, hence the connect-time `lookup`;
  - a new HTTP dependency: Node core was enough.
- **Release:**
  - a second audit row for the automatic hand-over (it would break the audit call-site pins; the existing row records it);
  - auto-releasing sent-back attempts (the owner may make several changes before handing back).
- **Shuffle:**
  - storing answers in display order (it would have touched scoring, review, exports and analytics);
  - a new toggle (`randomize` already exists).

## 8. Not included / follow-ups

- **Owner tasks:**
  - run the updated Word test script (T1–T11);
  - decide on the email plan upgrade;
  - create the pilot company after the tests pass.
- **Deferred:**
  - `AI_PIPELINE_MODE` switch for company-run AI (OD2);
  - invitation reminders;
  - a public drive link with self-registration (design-gated);
  - an admin invitation list beyond 100 rows;
  - DSAR export of option order (it shows original indexes).
- **Small fixes found:**
  - `in_app_notifications` mark-read has no UPDATE policy (same defect as 0121);
  - webhook backoff is off by one (first retry 5 m);
  - webhook deliveries that exhaust retries stay `pending`;
  - the `inviteUsers` audit stores `after.expires_at` as `{}` (Dates are flattened by `redactPayload`).

## 9. How to verify

- **Automated:**
  - `modules/05-assessment-lifecycle` `invitation-resend.test.ts` (14);
  - `modules/06-attempt-engine` (236, including `option-shuffle*.test.ts`);
  - `modules/07-ai-grading` `super-evaluation.test.ts` + `completion-gate.test.ts` (80);
  - `modules/09-scoring` (90); `modules/10-admin-dashboard` (95);
  - `modules/13-notifications` (240, including `webhook-safety`, `email-delivery-policy`, `smtp-timeouts`, `notifications-update-policies` on real Postgres);
  - `modules/16-help-system` (help-row count 156 in the test DB).
  - Typecheck is clean in 11 packages; `pnpm lint:ambient-ai` and `pnpm lint:rls` are OK.
- **Live, quick:** on `https://assessiq.in` (not the old domain, which 301-redirects a POST into a GET):
  - `/api/health` returns 200;
  - when logged out, both resend routes and the super `rerun` return 401;
  - the frontend bundle contains "Resend to everyone who hasn't started", "Re-run AI", "Released to" and "re-run ready";
  - the worker shows `result.auto_release` ticking;
  - Redis holds the 6 repeatable jobs.
- **End to end:** the owner's Word test script.
  - T3: the last accept shows "Released to <company>.".
  - T4: Re-run AI on a sent-back result, then "Release to company".
  - T10: resend; the old link is dead and the new one works.
  - T11: the option order is stable on reload, and the company sees the same chosen text.

## 10. Deploy record (1 October 2026)

All steps were additive and touched only `assessiq-*` resources.
1. `git pull --ff-only` (`3e57ea2` → `a86bce2`).
2. Migrations 0117–0121 applied and recorded in `schema_migrations`.
3. `build assessiq-api assessiq-frontend`.
4. A check that no Claude process was running in `assessiq-api`, then `up -d --no-deps --force-recreate assessiq-api assessiq-worker assessiq-frontend`. Healthy after about 18 s.
5. Live checks as in § 9: 0 api errors after the restart; claude 2.1.286.
6. Later commits are docs only (no rebuild).

## 11. Rollback

- **Database:** no rollback needed. All five migrations are additive, and older code ignores the new columns and policies. Do not drop `tenant_isolation_update` (0121): status writes would silently stop again.
- **Code:** revert `a86bce2`, then the merges `ef5285f`, `842d75f`, `88b3b02`, `753512a`, `71b4f04` (newest first). Push, pull on the VPS, rebuild and recreate.
- **Side effects of a code rollback:**
  - invitation links issued at 7 days keep their expiry, and resent links stay valid;
  - attempts started with a shuffle keep `option_order`, but old code would serve and store them in authored order. Their stored answers are in original order, so scoring stays correct;
  - webhook receivers would get ISO timestamps again.
- **Quick switches without a deploy:**
  - to stop option shuffling for one assessment, set its `randomize` to false (affects new attempts only);
  - to hold results back, set the company's release mode to Manual.
