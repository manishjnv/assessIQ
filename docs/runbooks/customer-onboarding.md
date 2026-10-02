# Customer onboarding runbook

**Reader:** the product owner (platform super admin, manishjnvk@gmail.com).
**Last checked against the code:** 2026-10-02.
**Live site:** https://assessiq.in

Each step names the screen (a path after `https://assessiq.in`). A small "Behind the scenes" note names the API call. You do not need the API notes to do the work. They help when you ask Claude to check something.

Words used here:
- **Company** = a tenant. One company = one customer.
- **Pack / set** = a group of questions the platform owns.
- **Licence** = an "entitlement". It lets a company use a domain or a pack.

---

## 1. Before you start

Collect these items first:

1. Company name (for example "Rajneesh University").
2. Slug. This is a short code: lowercase letters, numbers and hyphens only (for example `rajneesh-univ`).
3. Admin email. The first company admin gets the invite here.
4. Optional: the company email domain.
5. Which domains or packs the company may use (the licence).
6. Exam date, opening time and closing time.
7. Candidate list as a CSV file (see section 8).
8. Result release choice: Manual or Automatic (see section 5).

Also check:
- You can sign in at `/admin/login` and finish the authenticator (TOTP) step at `/admin/mfa`. Super admin always needs TOTP.
- Email capacity is about 300 emails a day on the shared plan. For a large exam, plan the sends over more than one day.

---

## 2. Create the company

**Screen:** `/admin/platform` (Platform page). Super admin only.

1. Sign in. Complete the TOTP code. Your code must be fresh (under 15 minutes old). If it is older, the app asks for a new code.
2. Open `/admin/platform`.
3. Click **New company** (the plus button).
4. Fill in: **Company name**, **Slug**, **First-admin email**. Optional: **Domain**, **Admin display name**.
5. Click the confirm button.
6. Make sure the new company appears in the list with the chip **Invite pending**.

What the app does for you in this one step:
- Creates the company.
- Loads the default taxonomy.
- Invites the first admin by email (role `admin`).
- Sets the company active.
- Gives it the default free plan.

If a step fails after the company is created, the company stays in "provisioning". Tell Claude. Do not create it again with the same slug (you get a "slug already used" error).

**About MFA for the new company admin.** There is no per-company MFA setting in the screens. One server setting controls it for all companies: `MFA_REQUIRED` in `/srv/assessiq/.env` on the VPS.
- `MFA_REQUIRED=false` (documented as the production value): company admins sign in with Google and go straight to `/admin`. They can add TOTP later.
- `MFA_REQUIRED=true`: every company admin must enrol TOTP at `/admin/mfa` at first sign-in.
- Super admin always needs TOTP, whatever this setting says.
- To see the live value, ask Claude to run a read-only check on the VPS. Do not guess.

*Behind the scenes:* `POST /api/admin/super/companies` (needs super admin and fresh TOTP).

---

## 3. Give the company its licence (domains and packs)

The company clones your question sets. It never writes its own packs. The licence decides what it can pick.

**Screen:** `/admin/platform`. Click the company row to open its drawer. Find the card **Entitlements**.

1. In **Entitlements**, choose the type: **Domain** or **Question set** (single pack).
2. For a domain, type the domain code (example hint in the box: `soc`). For a set, pick the pack.
3. Click the grant button.
4. Make sure it shows in the active list.
5. To remove a licence, click **Revoke** on that row. Revoke stops new use. Assessments already built are not deleted.

If the pack you want does not exist, create it first (domains at `/admin/platform`, packs at `/admin/question-bank`). Authoring is outside this runbook.

*Behind the scenes:*
- `GET /api/admin/super/tenants/:tenantId/entitlements` (list)
- `POST /api/admin/super/tenants/:tenantId/entitlements` (grant)
- `DELETE /api/admin/super/tenants/:tenantId/entitlements` (revoke)
- `GET /api/admin/super/tenants/:tenantId/content-scopes` (what the company can see)

---

## 4. Invite the company admin

The invite goes out in step 2. The link is valid for **7 days**.

**Check the status:** `/admin/platform`. The company row shows one of:
- **Invite pending** with "expires <date>".
- **Accepted** (the admin has joined).

**If the admin did not get the email, or the link expired:**
1. Open `/admin/platform`.
2. On the company row, click **Resend invite**. A new 7-day link is sent.
3. Resend only works while the admin is still pending. If the admin already accepted, the app says so.

**If the email address was wrong:**
1. On the company row, open **Manage**, then **Edit admin**.
2. Change the email. The app re-invites the new address.

**To cancel an invite (revoke):** open `/admin/platform/<tenantId>/users` (the company's user list). Cancel the pending invitation there. To invite again after a revoke, use **Edit admin** (change or re-save the email) or ask Claude. There is no separate button named "re-invite" on the Platform row.

**What the admin does:** opens the link (`/admin/invite/accept`), signs in with Google, and lands on `/admin`.

*Behind the scenes:*
- `POST /api/admin/super/tenants/:tenantId/invitations/resend`
- `PATCH /api/admin/super/users/:userId` (edit admin)
- `DELETE /api/admin/super/users/invitations/:invitationId` (cancel)
- `POST /api/invitations/accept` (the admin's accept step)

---

## 5. Result release mode and what students see

Rule: a student sees **only a complete, final score**. Never a partial score. If a result is not ready, the student sees a message and later gets an email.

**Who sets it:** the company admin, not you. Screen `/admin/tenant-settings`, section **Result release**.

| Mode | What happens |
| --- | --- |
| **Manual (default)** | The admin publishes results by hand. One result at a time, or **Publish all ready** on the assessment page. |
| **Automatic** | A background job publishes ready results about every 15 seconds. It publishes only results that became ready **after** the switch to Automatic. |

Steps for the company admin:
1. Open `/admin/tenant-settings`.
2. In **Result release**, pick **Manual (default)** or **Automatic**.
3. Enter the 6-digit authenticator code if asked.
4. Save.

What students see:
- All-MCQ test, Automatic mode: the result appears on screen in about a minute.
- Otherwise: a message that the result will be emailed to a masked address. For written answers it says "within 72 hours" (setting `EVALUATION_TURNAROUND_TEXT`; change it on the VPS if your real time is different).
- After publishing: a result email, and the **My results** page at `/candidate/results`.
- Candidates never see answers, bands or AI notes.

Tell the company: results only reach students after you publish (Manual). Written answers also wait for AssessIQ to evaluate them first (section 11).

*Behind the scenes:* `PATCH /api/admin/tenant-settings/result-release-mode`; `GET /api/admin/tenant-settings`; publish one result: `POST /api/admin/attempts/:id/release`.

---

## 6. Integrity settings

**Who:** company admin. **Screen:** an assessment page `/admin/assessments/<id>`, card **Test integrity**.

1. Tick **Require full screen** if you want it.
2. Tick **Block copy and paste** if you want it.
3. Click **Save integrity settings**. It applies to attempts that start after the save.

Tab warnings are automatic. There is no switch. When a student leaves the test window and comes back, the screen shows "You left the test window N times". The count is recorded and shown to the organiser on the attempt page.

You can also set full screen and copy-block when you create the assessment (the form has a **Test integrity** group).

*Behind the scenes:* `PATCH /api/admin/assessments/:id/integrity`.

---

## 7. Build and publish the assessment

**Who:** company admin. **Screen:** `/admin/assessments`.

1. Click to create an assessment. Keep the method **From a set** (use a licensed platform set). Only sets licensed in section 3 appear.
2. Fill in **Name**, **Opens**, **Closes**, the set, and how many questions to draw.
3. Optional: add **Test sections**, each with a name and minutes. With sections, each section has its own timer. With no sections, the test is one timed test.
4. Click **Create assessment**. The assessment is a draft.
5. On the assessment page (`/admin/assessments/<id>`) check the cards: **Test integrity**, **Test sections**, **Reminders**.
6. Click **Publish**.

Important:
- **Edit sections is hidden after publish, and after the first attempt.** Set sections before you publish. If you must change them later, ask Claude.
- The timer starts when the student clicks Begin and gives consent.
- If a set is missing, go back to section 3.
- Optional **High stakes** card turns on a two-model vote for written answers.

*Behind the scenes:*
- `GET /api/billing/available-sets` (licensed sets)
- `POST /api/admin/assessments/from-set`
- `POST /api/admin/assessments` (blueprint method)
- `PATCH /api/admin/assessments/:id` (settings and sections)
- `POST /api/admin/assessments/:id/publish`
- Later: `/close`, `/reopen`, `/cancel` on the same path.

---

## 8. Import candidates by CSV

**Screen:** `/admin/assessments/<id>`, section **Invitations**, button **Import from CSV**. (Candidates can also be added one by one at `/admin/users`, button **Invite**, role candidate.)

**CSV format.** The first row is the header. Header names are not case sensitive.

| Column | Required | Notes |
| --- | --- | --- |
| `name` | Yes | The candidate's full name |
| `email` | Yes | Must be a valid email |
| `roll_number` | No | Also accepted: `roll`, `roll no`, `enrollment` |
| `branch` | No | Also accepted: `department`, `dept` |

Example (3 rows, fake names):

```
name,email,roll_number,branch
Asha Verma,asha.verma@example.com,21CS001,CSE
Rohan Mehta,rohan.mehta@example.com,21ME014,Mechanical
Meera Iyer,meera.iyer@example.com,21EC027,Electronics
```

Limits and rules:
- Maximum 1000 rows and 512 KB for one file.
- Save as UTF-8 CSV. Wrap a cell in double quotes if it has a comma.
- Duplicate emails and bad rows are skipped. The result screen lists them and you can download the skipped rows.

Steps:
1. Click **Import from CSV** and pick the file.
2. Read the preview (first 10 rows and the row count).
3. Click confirm.
4. Read the summary: created, existing, invited, skipped.

*Behind the scenes:* `POST /api/admin/users/import` with `{ csv, assessment_id }`.

---

## 9. Send invites, bulk email and reminders

The import in section 8 also invites the candidates. To invite more people later:

1. On `/admin/assessments/<id>`, click **+ Invite candidates**.
2. Tick the candidates and click the **Invite** button.
3. Each invite link is valid for **7 days**. Candidates open it at `/take/<token>`.

Resend:
1. One person: on the invitation row, click **Resend**. This also works after a revoke or an expiry, and gives a new 7-day link.
2. Everyone who has not started: click **Resend to everyone who hasn't started**. It sends up to 200 per click. Click again for the rest. The assessment must be active (not draft, closed or cancelled).
3. Bulk email is retried for about 45 hours. Sign-in codes go first.

Reminders (default off):
1. In the **Reminders** card, tick **Send automatic reminders**.
2. Set the hours before the deadline (1 to 168; default 24).
3. Click **Save reminder settings**.
4. A reminder is sent once per candidate who has not started. It gives a new link. Maximum 100 reminders in 24 hours on the whole platform.

*Behind the scenes:*
- `POST /api/admin/assessments/:id/invite`
- `GET /api/admin/assessments/:id/invitations`
- `POST /api/admin/invitations/:id/resend`
- `POST /api/admin/assessments/:id/invitations/resend`
- `PATCH /api/admin/assessments/:id/reminders`

---

## 10. During the exam: what to watch

1. **Health:** open https://assessiq.in/api/health. It must answer 200.
2. **Attempts:** `/admin/attempts` and the assessment page show who started and who submitted.
3. **Integrity:** on each attempt page, read the integrity card (tab leaves, multi-tab).
4. **Rate limits:** a campus shares one network address. If students get "too many requests", go to section 15.
5. **Email:** watch the daily email limit (about 300).
6. **Stuck students:** ask Claude to check the worker logs on the VPS. Do not restart containers yourself.

---

## 11. Evaluation: platform queue to release

Only you (super admin) run AI evaluation. Company admins cannot. MCQ answers are scored at submit with no AI. Written answers, scenario, log analysis and KQL go to your queue.

**Screen:** `/admin/platform/evaluations` (blind queue: no candidate names). Cards show count, oldest, and "Older than 24 h".

1. Open `/admin/platform/evaluations`. Filter by **Company** if needed.
2. Click **Evaluate next** (opens the oldest) or click one row. This opens `/admin/platform/evaluations/<attemptId>`.
3. Click **Grade all**. The AI runs once, on your click, and you wait. Nothing is saved yet.
4. Read each proposal. Accept it, override it with a reason, or re-run. KQL answers need a manual score (no AI grader yet).
5. Accept the last grade. The app **releases the attempt to the company by itself** (owner decision).
6. If an attempt is finished but still in the queue, use **Release to company** on the page, or tick several and click **Release selected to company** in the queue. This needs a fresh authenticator code.
7. The company then sees "ready to publish". In Manual mode they publish. In Automatic mode the job publishes within about 15 seconds.

Notes:
- The company can send a result back with a note. It returns to your queue with a **Sent back** chip.
- You get an email alert when anything waits more than 24 hours.
- Run one grade at a time.
- If Grade says the AI login expired, see section 15.
- The eval gate is in warn mode and no baseline is blessed yet. This does not stop grading.

*Behind the scenes:*
- `GET /api/admin/super/evaluations` (queue)
- `GET /api/admin/super/evaluations/:attemptId`
- `POST /api/admin/super/evaluations/:attemptId/grade`
- `POST /api/admin/super/evaluations/:attemptId/accept`
- `POST /api/admin/super/evaluations/:attemptId/rerun`
- `POST /api/admin/super/evaluations/:attemptId/release-to-tenant`
- `POST /api/admin/super/evaluations/release-to-tenant` (bulk)

---

## 12. Results CSV download (ranked)

**Who:** company admin or reviewer. **Screen:** `/admin/assessments/<id>`, section **Invitations**.

1. Pick **Sort by**: **Name**, **Rank**, or **Branch then rank**.
2. Click **Download results (CSV)**.
3. The file includes roll number and branch (from the import).
4. Results not yet released show "Awaiting evaluation" instead of a score.

*Behind the scenes:* `GET /api/admin/assessments/:id/results.csv?sort=name|rank|branch`.

Other exports: attempts CSV under `/admin/reports` (`GET /api/admin/reports/exports/attempts.csv`).

---

## 13. Backups

What runs:
- Script `/etc/cron.daily/assessiq-backup` on the VPS, once a day (about 06:25 server time).
- It writes a Postgres dump to `/var/backups/assessiq/assessiq-<time>.dump`.
- It also saves the AI prompt skills as `prompts-skills-<time>.tgz` in the same folder.
- It keeps 14 days.
- It writes one line per run to `/var/log/assessiq/backup.log` (`OK <file> <bytes>` or `FAIL`).
- On failure it emails connect@assessiq.in.
- Offsite: the Hostinger weekly VPS backup. Worst loss is about 1 day, or up to 7 days if the whole VPS is lost.

How to check (ask Claude, or run it yourself):

```
ssh assessiq-vps "tail -n 5 /var/log/assessiq/backup.log; ls -lh /var/backups/assessiq | tail -n 5"
```

The newest line must say `OK` and be less than 26 hours old. Restore steps are in `docs/06-deployment.md` (Disaster recovery). Do not restore without asking Claude.

---

## 14. Erasure and data-rights requests

**Who:** the company admin does it for their own candidates. **Screen:** `/admin/users`. Open the candidate row menu.

1. Search the candidate (name or email).
2. First click **Export data**. It downloads a JSON file. Give it to the candidate if they asked for a copy.
3. Click **Erase personal data**.
4. Type a **reason** (required) and tick "I understand this permanently erases the candidate's personal data".
5. Confirm. Only candidate accounts can be erased. The action cannot be undone.
6. To list past erasures: ask Claude. The API is `GET /api/admin/erased-candidates` (no screen for it today).

Erased candidates are removed from the evaluation queue and never get result emails.

If a company asks you directly: ask the company admin to do steps 1 to 5, or ask Claude to run it against the API. Super admin has no tenant-wide erase screen.

Retention: companies can set data retention days at `/admin/tenant-settings` (`PATCH /api/admin/tenant-settings/retention-days`). A manual run is `POST /api/admin/retention/run-now`.

*Behind the scenes:* `GET /api/admin/users/:userId/data-export`; `POST /api/admin/users/:userId/erase`.

---

## 15. Quick troubleshooting

| Problem | What to do |
| --- | --- |
| **429 "too many requests"** | Read the `scope` field in the error first. It says which limit was hit: `ip`, `user`, `tenant` or `credential`. Fix that one. A campus shares one network address, so expect `ip`. Tell Claude the scope value. |
| **Invite expired or lost** | Candidate: click **Resend** on the row (section 9). Company admin: **Resend invite** on `/admin/platform` (section 4). |
| **Admin email wrong** | **Manage**, **Edit admin**, fix the email. |
| **Grade fails with "OAuth session expired" or the AI cannot log in** | 1. On the VPS, sign in to Claude Code again (owner `/login`). 2. Ask Claude to restart **both** `assessiq-api` and `assessiq-worker`. The login file mount goes stale until both restart. |
| **Student cannot see a score** | Check the company release mode (section 5). Check the attempt is released from the queue (section 11). Check it was published. |
| **Edit sections button missing** | Expected after publish or first attempt. Ask Claude. |
| **Company cannot pick a set** | The licence is missing. Section 3. |
| **Slug already used** | Pick another slug. |
| **Old browser or lab PC fails** | The web build targets Chrome 87 and up. Ask Claude with the browser name. |

---

## One-page checklist

**Before**
- [ ] Company name, slug, admin email, domain(s)/pack(s), exam date and times
- [ ] Candidate CSV ready (`name,email,roll_number,branch`)
- [ ] Release mode chosen (Manual or Automatic)
- [ ] TOTP code fresh (under 15 minutes)

**Set up**
- [ ] `/admin/platform`: company created, chip shows **Invite pending**
- [ ] Entitlements granted (domain or set)
- [ ] Admin accepted the invite (**Accepted**); if not, **Resend invite**
- [ ] Company admin set **Result release** in `/admin/tenant-settings`
- [ ] Assessment created **From a set**
- [ ] Integrity saved (full screen, copy block)
- [ ] Sections and timers set **before** publish
- [ ] Reminders set (optional)
- [ ] **Publish** clicked

**Candidates**
- [ ] CSV imported, skipped rows checked
- [ ] Invites sent; **Resend to everyone who hasn't started** if needed
- [ ] Email limit (about 300 a day) is enough

**Exam day**
- [ ] `/api/health` is 200
- [ ] Attempts and integrity checked
- [ ] Any 429: scope field read

**After**
- [ ] `/admin/platform/evaluations`: Grade all, accept, release (written answers)
- [ ] Company published results (Manual) or Automatic ran
- [ ] Results CSV downloaded (sort: Rank or Branch then rank)
- [ ] Backup log shows `OK` today
- [ ] Erasure requests handled (export first, then erase)
