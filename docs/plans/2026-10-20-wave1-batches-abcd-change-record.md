# Change record: Wave 1 batches A to D (session S36, 2026-10-20)

*Type: explanation and reference.* This page records every change of session S36 so that a later session can resume without reading the diffs.

**Old task or feature checked:** Z-18, Z-70, Z-71, Z-72, Z-79, Z-80, Z-81, Z-83, Z-85, Z-87, Z-89, Z-90, Z-91, Z-93, EXP-8 (passages), S32 Free-plan limits.
**Code state at close:** see the S36 block at the top of `docs/SESSION_STATE.md` for the final commit and for the state of the flags. Migrations 0215 to 0224 are applied on the server. `PLAN_TIERS_ENFORCED` is ON since the late S36 owner yes (pilot tenants birla and wipro-soc are `pro`); `SIGNUP_ENABLED` is OFF.

## Summary

- A credit ledger now sits beside the old credit counter. Credits expire after 12 months, burn by test type, and refill monthly on Free.
- The organisation admin picks Real exam or Mock test at invite. A real exam needs a laptop or desktop and a passing readiness check. A mock never makes a certificate and stays out of real-exam reports.
- A separate Mock results dashboard exists for admins.
- Public self-serve sign-up is built and CLOSED. It creates a Free organisation with its first admin and records the DPA and Terms acceptance.
- The 5-candidate Free cap is now race-safe.
- The `/dpa` page, the terms and privacy edits and the `/signup` page are in the marketing site.

## What changed, why, and where

### 1. Credit ledger and offline grants (Z-93, Z-79) - migration 0215

- **What.** Tables `credit_grants` (source purchase, free_monthly, bonus or pilot; credits; remaining; expiry after 12 months) and `credit_burns` (one row per graded attempt, test type mock, real or real_camera, a `shortfall` column when the balance is too low). Burn takes the oldest-expiring unexpired grant first and splits across grants. Burn amounts and the monthly Free amount are constants in `modules/19-billing/src/burn-rates.ts`.
- **Why.** The owner decided on credits that expire, burn by test type and refill monthly on Free (decision 2026-10-19).
- **Rules that must stay true.** Burn runs in the same transaction as the grade (`recordGradedAttempt`) and never throws on a low balance, because grading must not fail. A tenant with `included_credits` NULL is unlimited and never burns. A Free tenant with grants is capped by its ledger balance, but only while `PLAN_TIERS_ENFORCED` is true.
- **Hardening after review.** The app role may insert only a `free_monthly` grant of at most 20 credits. A trigger lets `remaining` only decrease. One purchase invoice reference grants once. The backfill gives a Free tenant at most the monthly amount.
- **Jobs (worker, no AI).** `credit-free-refill` runs daily at 00:10 UTC and is idempotent: the first run each UTC month does the work and later runs do nothing, which heals a missed run. `credit-expire` runs daily at 02:20 UTC.
- **Routes.** `POST` and `GET /api/admin/super/tenants/:tenantId/credits` (super admin only, audit action `billing.credits_granted`, same transaction). `GET /api/billing/usage` gains a `credits` object (additive).
- **UI.** A Credits block on the tenant billing page and a Credits card in the super-admin billing drawer.
- **Not included.** Low-balance emails at 20 percent and 10 percent (follow-up row Z-96). Online payment. A tier change does not add or remove grants.
- **Known limits.** The `burn_by_type` view counts all-time burns. A backfilled Free grant is replaced at the next refill.

### 2. Mock or Real test type, desktop-only rule, readiness check (Z-89, Z-87, Z-91) - migrations 0216, 0217, 0219

- **What.** `delivery_mode` ('real' or 'mock') on `assessments`, `assessment_invitations` and `attempts`. `attempts.camera_enabled` (always false until Wave 2) and `attempts.readiness` (JSON). The admin sets the mode at invite. The server copies it to the attempt under the invitation row lock. A candidate request can never set it.
- **Device rule.** `modules/06-attempt-engine/src/device.ts` decides phone or tablet from `Sec-CH-UA-Mobile`, the user agent, or client-reported touch and screen signals. `readiness.ts` needs a screen of at least 1024 by 600, a recent Chrome, Edge, Firefox or Safari, and a network speed when one is reported.
- **Where it is enforced.** `POST /take/start` and `POST /api/me/assessments/:id/start`, including a retake from the result page. The gate lives in `startAttempt` and applies when the request route passes `gate`. A mobile client on a real exam gets 403 `DEVICE_NOT_ALLOWED`. A missing or failing readiness check gets 422 `READINESS_FAILED`. Mock tests and the public `/try` demo are never blocked.
- **Mock effects.** No certificate (guards in `09-scoring/release.ts` and in `18-certification` `issueCertificateOnRelease`). `countingAttemptSql` (00-core) counts real attempts only. Migration 0219 recreates `attempt_summary_mv` and `question_stats_mv` with `delivery_mode = 'real'`. A mock does not use up the real exam's retake allowance.
- **Review result.** The first review found that the second start route skipped the gate (high severity). It was fixed in commit a3a0b337.
- **Accepted gaps.** (a) Embed starts are exempt from the device and readiness gate, because the host app asserts the candidate. (b) Readiness values are client-reported; only the device header and user agent are independent. (c) Camera, photos and video are Wave 2.
- **Rejected.** Trusting only the page check. A per-organisation opt-out of the desktop rule. A lockdown browser.

### 3. Mock results dashboard (Z-90) - no migration

- Five admin-only GET endpoints under `/api/admin/mock/` (summary, topics, students, trend, not-taken) in `modules/15-analytics/src/mock/index.ts`. They read live tables for mock attempts only. The page `/admin/mock-results` has a tab next to Reports. It is read-only and has no export.
- Also fixed: the admin and candidate activity leaderboards, feed and heatmaps now count real exams only.
- Not included: per-question drilldown, export, candidate-started practice tracks.

### 4. Self-serve sign-up (Z-71, Z-81) - migrations 0221, 0223 - CLOSED

- **Routes (public by design).** `GET /api/public/signup/config`, `POST /api/public/signup/request`, `POST /api/public/signup/verify`. They answer 404 unless `PLAN_TIERS_ENFORCED`, `SIGNUP_ENABLED`, both Turnstile keys and Redis all hold. The config route answers `open:false` while closed.
- **Why public is safe.** No tenant data is read or written before the tenant exists. The controls are: Turnstile (single use, bound to action and host); 5 requests a day per source; 3 a day per address; 50 completed sign-ups a day in total; an emailed code with an atomic one-time take in its own Redis key space; one organisation per verified address (`signup_claims`); a brand and look-alike blocklist; and a neutral answer that never shows whether an address has an account.
- **One transaction.** `createSelfServeTenant` (02-tenancy) writes the claim, tenant, settings, first admin (role admin only), Free plan and monthly credit grant, sample pack entitlements, DPA and Terms acceptance rows and audit rows. The tenant starts 'provisioning' and becomes 'active' in the same transaction. The taxonomy seed runs right after the commit.
- **DPA.** The form needs both boxes. The server rejects a request without `dpaAccepted`, `termsAccepted` and the right versions (1.0). The acceptance rows store the version, the time and HMAC hashes of the IP and user agent, not the plain values.
- **Review result.** Verdict revise; no takeover path was found. Fixed: look-alike organisation names, a missing Terms checkbox, an audit row written before a valid code, mail job data kept after completion, a 500 after a burnt code, and the IP source in verify.
- **Accepted residuals.** A Turnstile farm can fill the daily cap. The 3-a-day address bucket can lock out one victim for a day. A spoofed request replaces a pending code. The cap can overshoot by the number of outstanding codes. The plain request IP and user agent sit in Redis for up to 10 minutes. `email_log.to_address` keeps the plain address. Acceptance rows go with the tenant purge and no archive row is written.
- **Owner decision 2026-10-20 (option A).** An address that already exists in ANY organisation, even only as a candidate, cannot start a new organisation. The visitor gets the neutral screen and the mail "You already have an account". Rejected: allowing sign-up when the address is only a candidate (needs a rule for the old candidate record and the sign-in; revisit when a real customer asks).
- **Not included.** The certificate line "Issued by [Organisation], a self-registered AssessIQ customer" (the flag `tenants.self_registered` is set; the certificate text is a follow-up). The 30-day purge of platform-tenant `email_log` rows. `org_verified`. FU-OTP-ATOMIC for the admin sign-in code.
- **Sample sets.** Only one aptitude pack exists, so a new Free organisation gets 1 sample set, not 5. No page may promise 5. Add slugs to `FREE_SAMPLE_PACK_SLUGS` when more packs are published.

### 5. Race-safe candidate cap (Z-71 step b) - migration 0222

- `countCandidateOrRefuse` (19-billing) takes a per-tenant advisory lock. It records each candidate once in `tenant_candidate_counted` (append-only) and refuses above the cap inside the transaction that creates the user. It is wired into user create, CSV import (new users only), role change and the embed JIT user. A delete never lowers the count. A refusal rolls back the user row too. Not wired: `POST /api/admin/invitations` and the assessment invite, because they create no candidates.

### 6. Locked-feature popup (Z-80), UptimeRobot guide (Z-83), Brevo wording (Z-85)

- One shared popup on the webhooks and embed pages. No admin page exists for API keys, own email sender or data export, so the popup is not wired there.
- Guides: `docs/runbooks/uptimerobot-setup.md` and `docs/runbooks/open-signup.md`.

### 7. Marketing site

- New pages `/dpa` and `/signup`. Terms and privacy edits from `docs/design/2026-10-19-legal-texts-v1.md`. The old privacy sentence "does not record webcam" now reads "Except for a real exam with the camera on...". The terms effective date is 20 October 2026.
- **Open for the lawyer (owner accepted the risk).** The liability floor and the breach-notice hours are the defaults from the legal text. A lawyer has not reviewed the text. Review is due before the second or third paying customer.

### 8. Bug fixed on the way

- The passage draw (`takeUnits`) could refuse an attempt start at random when four single questions came up before two passages. See RCA 2026-10-20.

## Migrations and flags

| Migration | Owner module | Purpose |
|---|---|---|
| 0215 | 19-billing | credit_grants, credit_burns, backfill |
| 0216 | 05-assessment-lifecycle | delivery_mode on assessments and invitations |
| 0217 | 06-attempt-engine | delivery_mode, camera_enabled, readiness on attempts |
| 0218 | 16-help-system | help rows (ledger, popup) |
| 0219 | 15-analytics | attempt_summary_mv and question_stats_mv real only |
| 0220 | 16-help-system | help rows (test type, device, readiness) |
| 0221 | 02-tenancy | tenants.self_registered, signup_claims |
| 0222 | 19-billing | tenant_candidate_counted |
| 0223 | 03-users | tenant_legal_acceptances |
| 0224 | 16-help-system | help rows (mock results) |

- New flag `SIGNUP_ENABLED` (default false). Existing flags `PLAN_TIERS_ENFORCED` (default false) and `FREE_PLAN_AI_DISABLED`.
- New audit actions: `billing.credits_granted`, `signup.completed`, `signup.rejected`.
- New rate-limit scopes: `signup_ip`, `signup_email`, `signup_global`.

## How to verify

1. `curl -s https://assessiq.in/api/public/signup/config` answers `open:false`. `POST /api/public/signup/request` answers 404.
2. `bash tools/post-deploy-sweep.sh` shows 0 failures.
3. As super admin, record a credit grant for a test tenant. The tenant billing page shows the balance.
4. Invite a candidate as Mock and open the link on a phone: it is allowed. Invite as Real and open it on a phone: the page shows "Please open this link on a laptop or desktop computer to take this test".
5. `/admin/mock-results` loads and shows the empty state.

## Rollback

- Code: revert the commits and deploy with `tools/deploy.sh`. All migrations are additive and stay in place.
- Sign-up: set `SIGNUP_ENABLED=false` and recreate `assessiq-api`.
- Plan limits: set `PLAN_TIERS_ENFORCED=false` and recreate `assessiq-api`.
- Pilot tier change: set the tier back with the platform plan screen, or with `tools/pilot-tenant-to-paid.sql` and the old tier.

## Downstream impact

- `docs/02-data-model.md`, `03-api-contract.md`, `04-auth-flows.md`, `06-deployment.md`, `08-ui-system.md` and the SKILL files of 01, 02, 05, 06, 15 and 19 carry the detail.
- Z-18 (the flag flip) must follow the pilot tier change. A Free-tier pilot would hit the 5-candidate cap.
- Wave 2 (camera, photos, video) uses `attempts.camera_enabled` and the burn type `real_camera`.

## 9. Credit scale x10 (Z-95)

- **What changed.** All credit amounts are 10 times larger (owner 2026-10-20): mock 10, real 20, real with camera 30; Free monthly refill 200; default Free allowance 250. The monetary value of each test is the same.
- **Where.** `modules/19-billing/src/burn-rates.ts`, `service.ts`, `repository.ts` (old meter reported in credit units, 10 per graded attempt). Migration 0225 (`credit_scale_x10`, scales data once, new insert-policy limit 200). Migration 0226 (help rows `admin.settings.billing.usage` and `.credits_burn`, new version). Sign-up page text: 200 credits each month.
- **Rollback.** Not automatic. Divide `credit_grants`, `credit_burns` and `tenant_plans.included_credits` by 10, restore the policy limit 20, clear the table comment on `credit_grants`, revert the code.
