# Session 4 (S38) change record, 2026-10-20

Status: superseded by modules/19-billing/SKILL.md § 2026-10-20 — Session 4 (S38): exact meter, expiry warning, companions
Rows: Z-96, Z-93, Z-15, SP11, Z-84

*Type: reference.* Code commit `5afedc62` (CI green, deployed, sweep 0 failures). Migration 0228 applied.

## What changed

| Area | Files | Change |
| --- | --- | --- |
| Exact meter (Z-96) | `modules/19-billing/src/repository.ts` (`USED_SQL`) | `used` = sum of `credit_burns.credits` in the cycle for any tenant with a ledger row (10/20/30 per attempt). The old counter (graded attempts x 10) is used only when the tenant has no ledger row. One function feeds the banner, `GET /api/billing/usage` and the super-admin screens. |
| Expiry warning (Z-93, Z-96) | migration `0228_credit_expiry_notices.sql`, `credit-repository.ts`, `service.ts` (`sendCreditExpiryNotices`), `apps/api/src/worker.ts`, notifications template `credit_expiring` (html, txt, schema, strings, delivery policy), audit action `billing.credit_expiry_notice` | The daily `credit-expire` tick mails the org admins once for each non-Free grant that has credits left and expires within 30 days. One system-role transaction per grant: notice row (UNIQUE grant_id), audit row, then the mail. If no mail goes out, the transaction rolls back and the next tick retries. No AI call. |
| Result sign-in link (Z-15 a) | `modules/13-notifications/src/email/result-login-token.ts`, `result-released.ts`, `modules/01-auth/src/candidate-login.ts`, `apps/web/src/pages/candidate/CandidateLoginVerify.tsx`, `CandidateLogin.tsx` | The result email button is a one-time link: 7 days, token in the URL fragment. The SPA POSTs it, then clears the address bar. An expired or used link shows a plain message and the email form. |
| Admin ETA notice (SP11) | `modules/07-ai-grading/src/handlers/admin-queue.ts`, `modules/10-admin-dashboard/src/pages/grading-jobs.tsx`, help id `admin.grading.jobs.eta_notice` | `GET /admin/dashboard/queue` gains `evaluationTurnaroundText`. One muted line on the Evaluation status page. Help seed count 574 to 575. |
| Sample quiz (Z-84) | `tools/sample-quiz-report.mjs` | Unpacks to a scratch folder, reports counts and quality, writes normalised JSON to the gitignored `docs/Sample-Quiz/normalised/`. Report: `docs/plans/2026-10-20-sample-quiz-report.md` (gitignored). Counts only, no question text. |
| Load test | `tools/load-test/take-flow.mjs`, `docs/runbooks/load-test-500.md`, `docs/runbooks/pre-pilot-checklist.md` | Script and runbook written. NOT run against any host. |
| Tests | `credit-ledger.test.ts` (+2), `billing-events.test.ts` (2 expectations moved to the real burn), `email-result-copy.test.ts` (16 to 17 templates), `result-login-token.test.ts` (new, 6 cases), `email-result-signin-link.test.ts`, `admin-queue-eta.test.ts` | See How to verify. |

## Why

- The banner showed attempts x 10, but real tests burn 10, 20 or 30. Paid tenants saw 2 to 3 times too little.
- Admins need a warning before bought credits expire.
- The result email forced two emails and three steps (owner live test).

## Gate (Z-15 a, Sonnet takeover, owner approved in chat)

Verdict REVISE. All fixed before push:

1. HIGH: the token was stored in `email_log` and queue data. Fixed with `redactLogBody: true`.
2. MEDIUM: each release left another live 7-day link. Fixed: minting retires older tokens that live longer than 1 hour. A fresh 15-minute login link stays valid.
3. LOW: verify did not check the user. Fixed: the token consume now needs an existing, not erased, not deleted user (`candidate-login.ts`).
4. MEDIUM, accepted: the 7 days start at mint, and bulk-class mail can be late by days.

## How to verify

- `cd modules/19-billing && npx vitest run` (DB tests need Docker).
- `cd modules/01-auth && npx vitest run src/__tests__/result-login-token.test.ts`.
- `cd modules/13-notifications && npx vitest run`.
- `pnpm verify`, then `bash tools/post-deploy-sweep.sh`.
- Live: `select to_regclass('credit_expiry_notices')` returns the table (checked after deploy).

## Roll back

Revert `5afedc62` and redeploy. Then `DROP TABLE credit_expiry_notices` (no other table changed). The help row stays as a seed row (harmless).

## Options rejected

- A flag column on `credit_grants` for the expiry notice (the app role can update that table).
- Marketing in the default deploy list. `tools/deploy.sh` is unchanged: `--services "assessiq-marketing"` already passes its name check (documented in `docs/06-deployment.md`).
- The mint function in 01-auth (01-auth already depends on 13-notifications, so it would be a cycle).
- Editing the approved SP11 wording.

## NOT included

- Revoke the link when a result is withdrawn (needs a per-attempt column). Open follow-up.
- Tenant slug in the fragment: after an expired link the sign-in page may ask for the organisation code.
- Fixed-date test time bombs: the sweep found none open (the bulk-cap one was fixed in S37).
- Load test run, GATE-8, camera, CSP enforce, Caddy or DNS changes.
- IndexNow: the existing script ran once after the check (HTTP 200, 48 URLs).

## Effect on other modules and docs

- 13-notifications: new template (sign-off count test is 17), new `mintResultLoginToken` export.
- 14-audit-log: new action. 16-help-system: one new row.
- Docs updated: 02, 03, 04, 06, 08, billing SKILL, RCA_LOG, ROADMAP.
- Stale help text: `admin.grading.jobs.oldest` and `.page` say no turnaround is promised. They conflict with the new notice (a YAML edit needs a version bump).
- The notice says "Results stay hidden until you release them". This is wrong for auto-release tenants. The owner-approved wording is kept. Owner to decide.

## Sample quiz result (counts only)

| Source | Licence | Questions | Usable now |
| --- | --- | --- | --- |
| Aptitude-Tests-Questions-main | MIT | 1800 (no options) | 0 |
| aptitude-grind-master | CC BY 4.0 | 28 (no options) | 0 |
| aptitude-main | none found | 316 (29 with options) | 0 |
| aptitude-test-platform-public-main | none found | 600 (4 options each) | 0 |

The 600 platform questions repeat stems of the MIT source and look machine-made. The owner must settle rights before any use.

## Load test blockers (from the runbook)

- Invitation tokens are stored as hashes, so 500 raw tokens need a test-only export.
- One source IP is capped near 50 requests a second.
- Invite emails count against the daily cap.
- `tools/deploy.sh` has no image-tag rollback step. The checklist adds it by hand.

## Bugs found

- The old meter test asserted the old counter (400 vs 200). Updated.
- The template count test needs a bump for each new template.

## Migrations, flags, jobs

- Migration 0228 (`credit_expiry_notices`). Next free: 0229.
- No new flag. The daily `credit-expire` job now also sends expiry warnings.

## Owner answers and follow-up (same day, S38 part 2)

- **SP11 wording changed.** Text is now: "Results appear after AssessIQ finishes the evaluation. If your organisation releases results by hand, you release them next." It is true for both release modes. Showing it by mode was rejected: the mode is a tenant setting (`tenant_settings.result_release_mode`) and the queue endpoint would need a second query and field for one sentence.
- **Help text.** `admin.grading.jobs.eta_notice` and `admin.grading.jobs.oldest` are version 2 (new text). The seed adds the v2 rows at the next deploy; no migration needed because `tools/migrate.ts` re-applies the seed after the migrations. `admin.grading.jobs.page` was checked and is not stale. Gates run: `pnpm lint:help-seed-version`, full `modules/16-help-system` tests (116), help-id page prefix test, admin-dashboard tests (262).
- **Withdrawn results.** No action withdraws a released result today (`attempts.status = 'released'` is never reverted). I extracted the existing retire step into `retireResultLoginLinks` and tested it (used, expired, retired, newer link). No column was added. Any future withdraw action must call it in the same transaction. This is a reviewed change in `modules/13-notifications` only (no 01-auth or 09-scoring code changed).
- **Sample quiz sources.** Owner decision: load none of the four sources. Reasons: no licence, no answer options, and the 600-question source copies an MIT source and looks machine-made. Use original items (EXP-15) and AI-written questions that the owner reviews.
- **Load test.** Owner decision: do not run it until after Wave 2 (camera). Blockers to solve first: (a) a test-only token export for a test tenant; (b) no real invite emails; (c) a source-IP plan that does not weaken the production rate limit; (d) an image-tag rollback step in the deploy. Plan: start with 100 users, run off-hours, stop at a set limit.
