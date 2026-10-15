# P0 implementation prompt — AssessIQ (university pilot + production safety)

*Type: explanation* — This page is the contract that explains the P0 tasks and the rules for the implementing sessions.

You are implementing the **P0 tasks** for AssessIQ (repo `E:\code\AssessIQ`, prod `https://assessiq.in`). The work spans several sessions and this file is the contract. At the start of every session, re-read this file plus the top entry of `docs/SESSION_STATE.md` to see what is already done, then continue from the next unfinished step.

## 0. Context

- Follow `CLAUDE.md` (project overlay) and the global playbook: Phase 0 warm start, Opus review of load-bearing diffs, a `codex:rescue` gate (fallback: Sonnet takeover), and the Definition of Done (commit → deploy → document → handoff).
- Read first: `PROJECT_BRAIN.md`, `docs/PENDING_TASKS_2026-10-01.md` (§ P0-A, § P0-B), the top entry of `docs/SESSION_STATE.md`, the latest 10 entries of `docs/RCA_LOG.md`, and the memory index.
- State on 2026-10-01: prod is healthy on `09c2c44`. It is pre-launch, and prod holds only test data.
- `docs/` was just added to `.gitignore`; that edit is uncommitted, so **commit it with your first commit**. Already-tracked docs commit normally; **new** doc files need `git add -f`.
- Local Node is v20 but the repo needs **Node ≥ 22**; switch before running anything. **Docker Desktop must be running**, or the testcontainer suites (~773 tests) are skipped.
- Credit is limited: Opus does planning plus diff review of load-bearing code (Steps 3 and 10). Delegate everything else to Sonnet or Haiku subagents per the routing table.

## 1. Hard rules

1. **No ambient AI.** Never wire a `claude` call into cron, BullMQ, webhooks, candidate paths or workers. Deterministic code (no AI) is fine anywhere. `lint-no-ambient-claude` must pass.
2. **Load-bearing paths** (`00-core`, `01-auth`, `02-tenancy`, `07-ai-grading`, `14-audit-log`, `infra/**`) require Opus line-by-line diff review. **Steps 3 and 10 need a `codex:rescue` pass before push.**
3. **Tenancy:**
   - every new table gets `tenant_id` plus an RLS policy;
   - every endpoint goes through tenant-context middleware;
   - every admin mutation writes one `audit_log` row in the same transaction via `auditInTx`;
   - no `if (domain === "...")` in code.
4. **The VPS is shared.** Changes must be additive, `assessiq`-namespaced and enumerated before you touch anything. Never prune, stop or restart non-assessiq services. **Ask me before every VPS write.**
5. **Same-PR docs:**
   - schema → `02-data-model.md`
   - API → `03-api-contract.md`
   - grading → `05-ai-pipeline.md`
   - deploy/ops → `06-deployment.md`
   - bug → `RCA_LOG.md`
   - new UI → `help_id` plus a `16-help-system` seed entry
6. **Commits:** conventional messages, using the noreply author/committer env-var pattern from the global CLAUDE.md. Check `git rev-parse --abbrev-ref HEAD` is `main` before each commit, because parallel sessions share the working tree.
7. Pilot contact details (Rajneesh's email) must **never** appear in a committed file.

## 2. Owner inputs — ask me for all of these ONCE at the start

- **Offsite backup target.** Recommended: a Cloudflare R2 bucket plus access keys; alternatives are Backblaze B2 or Google Drive. Also a passphrase for an `rclone crypt` remote.
- **Monitoring sign-ups:**
  - a healthchecks.io ping URL (backup dead-man switch);
  - an UptimeRobot (or similar) account;
  - a Sentry DSN (optional).
- **Pilot:** the university name (becomes the tenant/company name) and Rajneesh's preferred login (Google or email code).
- **Admin MFA:** turn it on now (Step 10)? Yes or no.

## 3. Steps, in order

⏸ = stop, report, and wait for my OK.

### Step 1 — B1: database backups (VPS) ⏸

- **Problem, verified 2026-10-01 as root:** `docs/06-deployment.md` § Backups (~line 1168) and § Disaster recovery (~1251+) describe a daily `pg_dump` plus an offsite copy, but **none of it is installed**. There is no `/etc/cron.daily/assessiq-backup`, no `/var/backups/assessiq`, and no rclone.
- **Enumerate first, read-only:** `docker ps`, `ls /etc/cron.daily`, `df -h`, and the postgres container, DB and user names (`assessiq-postgres`, `assessiq`).
- **Implement the documented design; don't reinvent it:**
  - Create `/etc/cron.daily/assessiq-backup` (root, 0755, `set -euo pipefail`).
  - The script runs `docker exec assessiq-postgres pg_dump -U assessiq -d assessiq -Fc` and writes to `/var/backups/assessiq/assessiq-<UTC-ts>.dump`.
  - Retention: 14 days, deleting only inside that directory.
  - Offsite: `rclone copy` to an **encrypted crypt remote**.
  - Log to `/var/log/assessiq/backup.log`.
  - Ping healthchecks on success and `/fail` on error. Never `|| true` the offsite step.
- **Install rclone additively** (static binary in `/usr/local/bin`, or apt). Confirm with me first.
- **Secrets are not in the dump.** Without `MASTER_KEY`, encrypted columns can't be read after a restore. Tell me to store the VPS `.env` values in my password manager. Never upload `.env` unencrypted.
- **Restore drill, once:**
  - Start a throwaway `assessiq-restore-drill` postgres:16 container (no published ports).
  - `pg_restore` the latest dump into it.
  - Compare row counts of tenants, users, questions, attempts and gradings with live.
  - Remove **only** that container.
- **Acceptance:**
  - today's dump exists locally and in the bucket;
  - drill counts match live;
  - healthchecks shows green.
- **Docs:**
  - `06-deployment.md`: what is actually installed, the restore steps, and the drill date plus counts.
  - `RCA_LOG.md`: "documented backups were never installed". Prevention is the healthchecks dead-man switch.

### Step 2 — B3: green test baseline

- Run `pnpm install`, `pnpm -r typecheck` and `pnpm vitest run` on Node 22 with Docker up.
- **Known real failures:**
  - `04-question-bank` `admin-domain-create.test.ts` cases (c) duplicate slug → 409 and (e) happy-path create;
  - `04-question-bank` `clone.test.ts` T4 (remap taxonomy by slug);
  - `07-ai-grading` `claude-code-vps.runtime.test.ts:391` ("Unexpected skill: grade-band"). This one is load-bearing, so Opus reviews it.
- Also refresh the stale rate-limit assertions in `01-auth` `middleware.test.ts` to match current behaviour (`e2b54c1`: with `MFA_REQUIRED=false`, `totpVerified` is minted true).
- **For each failure, decide which kind it is:**
  - a stale test → update the test and say why;
  - a real bug → fix the code and add an RCA entry.
- **Acceptance:** 0 failures (any skip has a stated reason) and a clean typecheck. Record the counts in SESSION_STATE.

### Step 3 — A1: MCQ deterministic scoring (pilot blocker, load-bearing) ⏸

- **Problem, verified 2026-10-01:** nothing creates MCQ grades.
  - The only `gradings` writer is `insertGrading` (`modules/07-ai-grading/src/repository.ts:204`), called from `admin-accept.ts:183` and `admin-override.ts:82`.
  - `admin-grade.ts:352-357` skips MCQ.
  - `modules/09-scoring/src/service.ts:35-130` only sums existing rows.
  - `submitAttempt` (`modules/06-attempt-engine/src/service.ts:647-680`) does no scoring.
  - **Result:** MCQ-only attempts never reach `graded`, so they can't be released (`admin-claim-release.ts:362-382` needs `graded`), and no certificate or billing follows. Mixed attempts silently drop MCQ points.
  - The comments at `admin-grade.ts:72,356` and `admin-accept.ts:209` wrongly claim module 09 scores MCQ.
- **Design (decided, don't re-litigate):**
  - Add `scoreMcqForAttempt(client, attemptId)`, deterministic with no AI.
  - For each `mcq` question in the attempt:
    - Read the **frozen** content used for that attempt (attempt_questions → question version snapshot, not the live question) and the saved answer.
    - Correct means the selection equals the answer key. If the schema allows multiple correct options, require an exact set match.
    - Unanswered scores 0. No negative marking.
    - Insert one `gradings` row through the existing repository helper: `grader='deterministic'`, `score_max` = question points, `score_earned` = points or 0.
    - It must be **idempotent**: skip if a deterministic row already exists for that attempt and question.
  - The answer key is read server-side only. Never return correctness or the key to the candidate before release (see memory "question payloads … answer-key leak").
  - **Wiring:**
    1. Call it inside the submit transaction **and** the timer auto-submit path. This is allowed because it makes no AI call.
    2. **MCQ-only attempt** (no AI-gradable questions), all in the same transaction:
       - run `computeAttemptScore`;
       - set status `graded`;
       - call `recordGradedAttempt` (billing is in the grade-commit critical path; see memory);
       - write the audit row.
       - Follow the attempt state machine. If `submitted → graded` isn't allowed, pass through `pending_admin_grading` in the same transaction, or add the transition and document it in `02-data-model.md`.
    3. **Mixed attempts:** MCQ rows are written at submit. The completion gate at `admin-accept.ts:219-240` keeps counting only AI-gradable questions, and final totals include the deterministic rows.
    4. Also call it at the start of the admin Grade handler, so attempts submitted before this fix can be finalised by one admin click. For an MCQ-only attempt that click must finalise it, not return 422 on empty proposals.
  - Fix the false comments. KQL has the same gap but is out of scope; add a one-line note in SESSION_STATE.
- **Tests:**
  - **Unit:** correct, wrong, unanswered, multi-answer (if supported), and "uses the frozen version after the live question is revised".
  - **Integration:**
    - MCQ-only: submit → `graded`, correct total, one billing row, one audit row.
    - Mixed: MCQ rows exist, the attempt stays pending until the AI questions are accepted, and the final total includes MCQ.
    - Idempotency: calling twice creates no duplicates.
- **Review:** Opus line-by-line, then `codex:rescue` with these vectors:
  - answer-key leak to the candidate;
  - double scoring or a race on idempotency;
  - a cross-tenant read inside the scorer;
  - a crafted answer payload (array vs index, out-of-range);
  - bypassing the status transition;
  - billing counted twice.
- **Docs:**
  - `05-ai-pipeline.md`: the deterministic path, and why running it at submit is compliant;
  - `02-data-model.md`;
  - `03-api-contract.md`, if any response changes;
  - `RCA_LOG.md`: "MCQ never scored".
- **Deploy** api (and worker, if it owns auto-submit) per `06-deployment.md` § steady-state procedure. Then ask me to run a quick MCQ-only test on the site.

### Step 4 — A4: bulk candidate CSV import and invite

- **Today:**
  - invites take existing `user_ids` (`POST /admin/assessments/:id/invite`);
  - CSV import is a stub (`modules/03-users/src/import.ts:11-15`; `apps/api/src/routes/admin-users.ts:151` returns not-implemented).
- **Build the endpoint** (keep the existing stub route path).
  - **CSV input:** `name,email` with a header row, up to 1000 rows, UTF-8. Trim values, lowercase emails, dedupe within the file.
  - Create candidate users in the admin's tenant. An email that already exists in the tenant is reused and reported as "existing".
  - A bad row is reported (row number and reason) and never aborts the whole file.
  - **Optional `assessment_id`:** invite everyone through the **existing invite service** (same skip reasons).
  - **Guards:** tenant middleware, admin role, rate limit, and one audit row per import with counts only (no PII list).
  - **Response:** `{created, existing, invited, skipped:[{row,email,reason}]}`.
- **UI:** "Import from CSV" on the assessment detail invite section.
  - Flow: file → preview (first 10 rows plus counts) → confirm → result summary, with a downloadable skip list and a sample CSV.
  - Follow `docs/10-branding-guideline.md` and the UI kit. Add `help_id`s and help seed entries.
- **Email quota:**
  - Confirm invite emails are queued with retry, and that a failed one can be re-sent.
  - Brevo's free plan is **300/day shared across 5 products**. Show a warning when an import would queue more than about 150 emails.
- **Tests and docs:** `03-api-contract.md`, `modules/03-users/SKILL.md`, help seed.

### Step 5 — A6: results for the placement cell

- **Check as an admin:**
  - the assessment report lists every candidate with score, %, status and a per-category breakdown;
  - CSV export includes name, email, score, %, status and submitted_at.
- Fix gaps minimally.
- **Report, don't build unless I say so:**
  - whether a **bulk "release results"** action exists (release emails also use quota);
  - whether `sendResultReleasedEmail` exists (it was missing in the 2026-05-15 walkthrough).

### Step 6 — B2: alerting

- **Uptime:** give me exact monitor settings for `https://assessiq.in/api/health` and `https://assessiq.in/`. I create the monitors.
- **Errors:** if the code already reads `SENTRY_DSN` (check `00-core` and `docs/11-observability.md`), set my DSN in the VPS env (additive), redeploy api and worker, and verify a test event arrives.
- **Backup freshness:** the healthchecks check from Step 1, daily with a 26h grace period.
- **Runbook:** add a one-page "Incident runbook" to `docs/11-observability.md`:
  - who gets alerted;
  - the first 5 checks: `docker ps`, logs, disk, Caddy, Brevo;
  - the rollback command;
  - a pointer to the restore procedure.

### Step 7 — A2: aptitude content ⏸

- **Content model:** the platform only. super_admin authors packs, and tenants get licensed clones (memory: platform-only content model, platform domain management).
- **Create the platform domain "Aptitude"** (slug `aptitude`) using the existing super-admin domain management:
  - categories: Quantitative Aptitude, Logical Reasoning, Verbal Ability;
  - supported types: `mcq` only;
  - no domain logic in code.
- **Check the VPS `generate-mcq` skill** (path per `docs/05-ai-pipeline.md`) for security-specific wording.
  - If it is domain-agnostic, change nothing.
  - If it must change, that is a deploy event: record the sha, re-baseline evals, and tell me.
- **AI generation runs only when I click Generate** in the admin UI; never trigger it from scripts. Give me the exact click path and settings:
  - pack "Campus Placement Aptitude";
  - L1/L2 difficulty;
  - about 30 questions per category.
- **After I approve the drafts:** publish the pack and create a sample assessment (about 30 questions, 45 minutes) for the dry run.

### Step 8 — A7: dry run (me) ⏸

- **Give me a checklist to follow:**
  - import myself as a candidate via CSV;
  - take the test on a phone and a laptop;
  - submit and see the score graded instantly;
  - check the report and CSV export;
  - release, and check the certificate if applicable.
- Fix anything that breaks before Step 9.

### Step 9 — A3: pilot tenant (only after Step 8 passes)

- **Guide me through it:**
  - super-admin → **Create company** (<university name>), which needs fresh MFA;
  - invite **Rajneesh (rajneesh.scorpio@gmail.com)** as company admin;
  - license the Aptitude pack to that tenant (entitlement plus clone-on-grant) so it shows under "Licensed sets";
  - confirm the invite email arrives.
- **Draft a short welcome email** for me to send him, as a greeting plus bullets: how to log in, create an assessment from the licensed pack, import students by CSV, and view or export results.
- Don't put his email in any committed file.

### Step 10 — owner items

- **B4, admin MFA (only if I said yes):**
  - Set `MFA_REQUIRED=true` in the VPS env and treat it as a session-invalidation event (revoke existing admin sessions).
  - Keep the rate-limit bypass predicate in sync (PROJECT_BRAIN decision 2026-05-13).
  - Test my own login plus TOTP enrollment first.
  - Needs a `codex:rescue` gate.
- **B5:** give me the exact eval re-baseline commands to run on the VPS (`pnpm aiq:eval:run` → `bless`; needs Max OAuth).
- **A5:** remind me to upgrade the Brevo plan before inviting a full class.

## 4. Definition of done for every step

- Pre-commit:
  - tests for the touched modules;
  - a `TODO|FIXME|XXX` grep on the diff;
  - a secrets scan.
- Then:
  1. commit to `main` using the noreply pattern;
  2. deploy (code changes only);
  3. update the docs;
  4. add a `docs/SESSION_STATE.md` entry with the agent-utilization footer.

## 5. Final report (when all of P0 is done), for my verification session

Write it in the top entry of `docs/SESSION_STATE.md` and repeat it in chat:
- a table with columns: task | status | commit SHA | deployed Y/N | tests | how to verify on the site;
- VPS HEAD SHA, the newest backup file name and date, the offsite listing, and the restore-drill date plus counts;
- anything skipped or deferred, and why.
