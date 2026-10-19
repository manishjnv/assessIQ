# Pre-pilot checklist

This how-to checks whether AssessIQ is ready for the pilot. Use it before you invite pilot users. Every check in this list is read-only. Do not change the VPS, Cloudflare or DNS while you run it.

**Checks run:** 2026-10-19, from about 09:04 to 09:20 UTC.

## Status

- Done: 10 checks are complete.
- Owner: 6 checks need an owner decision or action.
- Lawyer: 1 check waits for the lawyer.
- Pending: 1 check waits for a future time (first purge tick, 2026-10-20 03:45 UTC).

## Before you start

- You need SSH access to the host alias `assessiq-vps`.
- You need `curl` on your computer.
- Do not paste secret values into a ticket or a chat. Check only that a name is set.

## Steps

1. Run the public readiness check. Expect `200`.
2. Read each row in the table below.
3. Do the owner actions in the list after the table.
4. Run this checklist again after the owner actions are done.

## Checks

| # | Check | Status | Evidence (command or doc, short result) | Owner action |
|---|---|---|---|---|
| 1 | Public readiness and health | done | `curl https://assessiq.in/api/ready` returned 200 in 0.20 s. `/api/health` returned 200. `docs/11-observability.md` § Readiness says `/api/ready` needs no login. | None |
| 2 | Uptime monitor and alert path | owner | `docs/11-observability.md` § 33 says the UptimeRobot monitors are not created yet. No account evidence exists in the repo or in memory. | Create the UptimeRobot monitors (see Owner actions, item 1). |
| 3 | Error alerts and Sentry | owner | The VPS `.env` has a `SENTRY_DSN` line, but its value is empty. `docs/11-observability.md` § 33 says no Sentry SDK is wired and the work is deferred. | Decide if Sentry is needed before the pilot (item 2). |
| 4 | Rate limits | done | Defaults in `modules/00-core/src/config.ts`: IP admin 100 per min, IP user 30, IP anon 120, API key 600, credential 20, verified admin user 300, tenant 6000, candidate user 120. The VPS sets only `RATE_LIMIT_IP_ADMIN` by name. The rest use defaults. | None. Note: `docs/06-deployment.md` shows `RATE_LIMIT_IP_ANON=30` as an example, but the code default is 120. Fix the doc later. |
| 5 | Pilot tenant and seed data | done | Six tenants: `birla` (University Pilot Account, free), `e2e-walkthrough-2026-05-15` (E2E Walkthrough, free), `foxfiber` (Foxfiber, free), `platform` (AssessIQ Platform, internal), `wipro-crs` (Wipro - CRS, free), `wipro-soc` (IT SOC, internal). Users by role: admin 5, candidate 6, super_admin 1. Question packs with status `published`: 9. Assessments: 3 draft, 3 active, 2 closed. Attempts: 6. | Confirm `birla` is the pilot tenant. Decide if the `e2e-walkthrough` test tenant stays. |
| 6 | Turnstile on the contact form | done | `https://assessiq.in/contact` HTML has the `cf-turnstile` widget with a `data-sitekey` attribute. The API checks the token with the `TURNSTILE_SECRET` name (`apps/api/src/routes/contact.ts`). The VPS `.env` has the `TURNSTILE_SECRET` name set. The value was not read. | None |
| 7 | Email daily cap and sign-in code priority | owner | `docs/06-deployment.md` (S29 note): `EMAIL_BULK_DAILY_CAP` defaults to 250. The VPS does not set it, so the default applies. Sign-in codes are never limited. Conflict: `docs/06-deployment.md` § 1674 says the sender moved to Resend on 2026-05-24. Other docs say Brevo, 300 a day. | Confirm the live email provider and its daily limit (item 3). |
| 8 | Consent flow | owner | `docs/03-api-contract.md` § `/take/start`: the first Begin needs `consent: true`. It writes a `consent_events` row (`purpose=data_processing`). Without consent it returns `422 CONSENT_REQUIRED`. | Run the RV66 table check (item 4). This check belongs to the owner. |
| 9 | Backup state | owner | `/etc/cron.daily/assessiq-backup` exists on the VPS (owner root). `/var/backups/assessiq/` has daily `prompts-skills-*.tgz` files (latest 2026-10-19). Checked by the orchestrator 2026-10-19: a root cron writes one `assessiq-*.dump` a day at 06:25 UTC into the same folder (newest 1.77 MB, 10+ days kept). The dumps are on the same disk, so the provider weekly snapshot is the only off-box copy. Restore drill passed 2026-10-19: all six table counts match, restore took 3 s (`tools/backup-restore-test.sh`). `docs/owner-decisions` Q16 says the weekly provider snapshot is the current state. Daily off-site backup waits for the first paying customer. The restore guide `docs/runbooks/backup-restore.md` is not written yet. | Accept the risk, or add a daily off-site backup (item 5). |
| 10 | MFA optional for tenant admins | done | `MFA_REQUIRED` name is set on the VPS. The value was not read. `docs/04-auth-flows.md` says admin MFA applies when `MFA_REQUIRED=true`. Owner decision Q15 keeps MFA optional. | None. Confirm the value is `false` (item 6). |
| 11 | Security headers on `https://assessiq.in/` | done | Present: `strict-transport-security` (1 year, includeSubDomains, preload), `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy`, `content-security-policy` (`frame-ancestors 'none'`), `content-security-policy-report-only` (full policy). `permissions-policy` is `camera=(), microphone=(), geolocation=()`. | At webcam build time, change `camera=()` (item 7). |
| 12 | DMARC and Postmaster | owner | `nslookup -type=TXT _dmarc.assessiq.in` returned no TXT value. `dig` is not installed. Memory says the DMARC move is later. No Google Postmaster record was found in the docs or memory. | Check the DMARC TXT record in Cloudflare DNS (read-only). Set up Google Postmaster Tools (item 8). |
| 13 | Privacy and terms placeholders | lawyer | `apps/marketing/src/pages/privacy.astro` and `terms.astro`: no `TODO` or `placeholder` text found. The lawyer has not approved the text. Open items: 90-day photo retention, self-declared age, school tests, acceptance-record retention, liability file (`docs/design/2026-10-18-liability-and-dpa-proposal.md`). | Send the proposal to the lawyer and get sign-off (item 9). |
| 14 | Candidate dry-run script | done | `docs/testing/uat/student/01-take-assessment.md` (27 table rows: 3 prerequisites and a step table) and `docs/testing/uat/student/02-view-result.md` (22 table rows). The scoring and release script is `docs/testing/feature-scripts/AssessIQ_Scoring_Release_Test_Script.docx`, with 85 steps (T1-T9). That file is binary, so it was not opened. | None |
| 15 | Container health (`assessiq-*`) | done | `docker ps`: `assessiq-api` healthy (up 6 h), `assessiq-worker` healthy (up 3 min at check time, restarted), `assessiq-frontend` healthy (6 h), `assessiq-marketing` healthy (7 h), `assessiq-postgres` healthy (2 days), `assessiq-redis` healthy (2 days). | None |
| 16 | Disk use on the VPS | done | `/` is 41 percent used: 39 GB of 96 GB, 58 GB free. | None. `NEXT.md` lists an 80 percent guard as an owner decision (item 10). |
| 17 | `USER_PURGE_ENABLED` | pending | The name is set on the VPS. The value was not read. The worker logged 0 `user_purge` lines in the last hour. The first live tick is due at 03:45 UTC on 2026-10-20 (`docs/06-deployment.md`, LC-2). | After the tick, read one `user_purge.tick` line (item 10). |
| 18 | `PLAN_TIERS_ENFORCED` | done | The name is not set on the VPS, so the default (off) applies. It must stay unset until the owner gate Z-18 is passed. Tenant plans: `birla`, `e2e-walkthrough`, `foxfiber`, `wipro-crs` are `free`. `platform` and `wipro-soc` are `internal`. | None. Keep it unset (see `docs/NEXT.md` owner gates). |

## Owner actions

1. Create two UptimeRobot monitors. Point them at `https://assessiq.in/api/health` and `https://assessiq.in/`. Set the alert contact to the owner Gmail, not `connect@assessiq.in`.
2. Decide if Sentry is needed before the pilot. The DSN is empty and no SDK is wired.
3. Confirm the live email provider (Brevo or Resend). Confirm the daily bulk cap (default 250).
4. Run the RV66 check on the `consent_events` table.
5. Accept the risk of a weekly provider snapshot only, or add a daily off-site backup.
6. Confirm `MFA_REQUIRED` is `false` on the VPS. Do not print the value in a shared place.
7. At webcam build time, change the `Permissions-Policy` `camera=()` setting.
8. Check the DMARC TXT record in Cloudflare DNS. Set up Google Postmaster Tools.
9. Send the liability and DPA proposal to the lawyer. Ask for approval of the privacy and terms text.
10. After 03:45 UTC on 2026-10-20, read one `user_purge.tick` line in the worker log. Then accept or stop the purge.

## Not checked

- Sentry account and error inbox: no access. Only the name was checked.
- UptimeRobot account: no access. The docs say it is not created.
- `MFA_REQUIRED` and `USER_PURGE_ENABLED` values: not read. Only the names were checked.
- DMARC with `dig`: not checked. `dig` is not installed. `nslookup` returned no value.
- Google Postmaster Tools: not checked. No access, and no record in the docs.
- Internal health at `127.0.0.1:3000/api/ready`: returned `000`. The port was not confirmed. The public check was used instead.
- `.docx` test scripts: not opened (binary files).
- Consent table (RV66): owner check.
- Lawyer review: no evidence of approval in the repo.
