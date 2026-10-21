# S37 change record: Wave 1 leftovers and Wave 4 small rows (2026-10-20)

Status: superseded by modules/19-billing/SKILL.md § 2026-10-20 — Wave 4 small rows (S37): low-balance emails and companions
Rows: Z-96, Z-37, Z-20, Z-49, Z-76, RW-1

*Type: reference.* This page lets a later session continue without reading the diff.

**Commits:** `0bc3e5ad` (main change), `be3da797` (page dates), `6862328a` (review fix with trailer), `160e89e5` (CI fixes). The server runs `160e89e5`. The marketing container was rebuilt from `160e89e5`. Migration `0227` is applied.

## What changed

| Area | Files | What |
|---|---|---|
| Low-balance emails (Z-96 part 1) | `modules/19-billing/src/service.ts` (`sendCreditLowBalanceNotices`), `credit-repository.ts`, `burn-rates.ts` (`LOW_BALANCE_LEVELS` 20 and 10), `index.ts`, `apps/api/src/worker.ts`, `modules/19-billing/migrations/0227_credit_lowbalance_notices.sql` | The daily `credit-expire` tick also sends one email to the tenant admins when the balance is at or below 20 percent, and again at 10 percent, of the largest unexpired grant. One email per level per grant (UNIQUE `grant_id, level`). |
| Email template | `modules/13-notifications` (`credit_low_balance` html and txt, `en.json`, `render.ts`, `types.ts`, `delivery-policy.ts`) | Plain mail with balance and level, and a link to the plan tab. No price. |
| Audit catalog | `modules/14-audit-log/src/types.ts` | One additive action: `billing.credit_low_balance_notice`. |
| Wording (Z-37 b) | six templates in `modules/13-notifications/src/email/templates/` | invitation_reminder, invitation_admin, admin_email_otp, totp_enrolled, totp_reset_notice and evaluation_queue_alert use the approved wording. |
| Legal wording (Z-20, Z-49) | `apps/marketing/src/pages/terms.astro`, `privacy.astro` | Terms section 8 uses the approved draft. Privacy says `/try` carries the Cloudflare beacon. |
| Copy | `apps/marketing/src/pages/signup.astro` | The meta description says one sample set (Free gets one today). |
| Pages (Z-76, 1 to 4) | four new files in `apps/marketing/src/pages/resources/`, `resources.astro`, `astro.config.mjs` (sitemap), `src/data/page-dates.json` | See the list below. |
| Router (step 1) | `apps/web/src/App.tsx` | `BrowserRouter future={{ v7_startTransition, v7_relativeSplatPath }}`. No version change. |
| CI fixes | `0227` insert policy, `email-bulk-cap.test.ts`, `totp-reset-notice.test.ts` | See "Bugs found". |

New pages: `/resources/how-to-run-a-campus-aptitude-test`, `/resources/release-campus-test-results`, `/resources/send-test-invitations-to-students`, `/resources/verify-skill-certificate`. Each claim was checked in code: CSV 1,000 rows and 512 KB (`modules/03-users/src/import.ts`), daily mail cap 250 (`bulk-cap.ts`), invite link 7 days, certificate verify fields (`modules/18-certification/src/routes-public.ts`).

## Why

- Z-96: the owner wants admins told before credits run out. Z-93 stayed PARTIAL without it.
- Z-20 and Z-49: the owner approved the wording on 2026-10-19. The privacy page must match what the site does.
- Z-76: the owner approved pages 1 to 4. Each page answers a query that no current page answers.
- Router step 1: the owner approved step 1 only. It removes the v7 behaviour risk before any version bump.

## How to verify

1. `curl -s https://assessiq.in/resources/verify-skill-certificate` answers 200 with one H1. The sitemap lists the four pages.
2. Search `/privacy` for "public demo page at /try". Search `/terms` for "The Customer owns its own data".
3. On the server, table `credit_lowbalance_notices` exists with forced RLS. Worker log lines `credit_low_balance.*` appear after the next daily tick for a tenant at or below 20 percent.
4. `pnpm exec vitest run modules/19-billing/src/__tests__/credit-ledger.test.ts` (10 tests, includes the low-balance test).
5. Owner: open `/admin` signed in and one take page (router flags). The CI signed-in smoke passed.

## How to roll back

- Emails: revert the Z-96 code and redeploy. The table `credit_lowbalance_notices` can stay (additive). To stop only the mail, remove the `sendCreditLowBalanceNotices` call in `worker.ts`.
- Router: remove the `future` prop.
- Wording and pages: revert the files and rebuild `assessiq-marketing`.

## Options rejected

- Sending the mail after the commit (needs an outbox table): rejected. The daily job is simple and at-least-once is acceptable. The code has a `ponytail:` comment.
- A separate worker queue for the notices: rejected. The existing `credit-expire` tick is enough.
- Adding the `future` prop to the 31 `MemoryRouter` test files: rejected. No test behaviour changed.
- Building SP11 with a new admin API field: not done (see below).

## NOT included

- SP11 admin ETA notice. The admin app has no value for `EVALUATION_TURNAROUND_TEXT` (server only). It needs a new admin API field and a short design. Open.
- Z-15 (a) one-time sign-in link. It is a build with an open owner question (validity period, fragment or path).
- Expiry warning email and the exact usage meter (rest of Z-96).
- Z-76 pages 5 to 7. Pages 5 and 6 are later by owner decision.
- IndexNow ping after the marketing deploy.
- Opening sign-up, CSP enforce (Z-77), camera and photos, exam content, GATE-8.

## Effect on other modules and docs

- `docs/02-data-model.md` and `modules/19-billing/SKILL.md` describe the new table and job.
- The notifications template count is now 16 (`email-result-copy.test.ts`).
- The audit catalog grew by one action.
- No API change, so `docs/03-api-contract.md` is unchanged.

## Migrations, flags and jobs

- Migration `0227_credit_lowbalance_notices.sql` (additive). Next free migration: `0228`.
- No new flag. The job runs inside the existing `credit-expire` tick.

## Bugs found

1. `lint:rls` needs a `tenant_isolation_insert` policy on every tenant table, even when the app role cannot insert. Fixed in `0227` (policy plus the existing REVOKE).
2. `email-bulk-cap.test.ts` used the fixed date 2026-10-19. It broke after 06:00 UTC on 2026-10-20. Fixed with `Date.now()`.
3. `totp-reset-notice.test.ts` still expected the old wording after Z-37 b. Fixed.
4. `lint:rls` scans `.claude/worktrees/*`. A stale agent worktree turns the lint red locally. Remove agent worktrees before the final lint run.
5. Review finding, fixed: the audit row now comes before the mail, so an audit failure cannot repeat a sent mail every day.
6. Known and accepted (low): if one admin send fails and another works, the failed admin is not retried. A scan error in the first query fails the job result after `expireCredits` has run. A grant change can allow a few extra mails.

## Branch clean-up (RW-1) — DONE after the owner yes

Proof before deleting: each branch had 0 commits that `main` lacks (`git rev-list --count main..<branch>`), `merge-base --is-ancestor` said yes, no CI file, hook or script named them, no open PR used them. The owner said no one else uses the repo. Deleted locally with `git branch -d` (refuses unmerged work): `autopilot/P01-T01`, `feat/domain-consistency-blueprint-scope`, `feat/question-difficulty`, `worktree-agent-a24d9a579ffd83f94`, `worktree-agent-ac882dada56ed9469`, `worktree-agent-af82986a755cc74be`. Deleted on the remote with `git push origin --delete` (all from 2026-05-24, merged): (`origin/feat/platform-edit-admin`, `origin/feat/platform-edit-company`, `origin/feat/qdiff-admin-ui-followups`, `origin/feat/question-difficulty`). Left alone, outside the approved list and not checked: `autopilot/P01-T01.kept-af67488`, `n7b-react19`, `n7b-vite8`, two other `worktree-agent-*` branches, and the two Dependabot branches.
