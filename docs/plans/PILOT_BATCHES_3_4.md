# Pilot batches 3 and 4 (2026-10-02): question types, score stability, load hardening, sections, reminders, least-AI grading, public demo, client IP

**Status:** LIVE on production (https://assessiq.in).
- **Batch 3:** deployed at `273e2bc`; docs in `f8715a5`.
- **Batch 4:** deployed at `e752be6`; docs in `ab5c884`.

**Scope:** ten tasks from `docs/PENDING_TASKS_2026-10-01.md` that a Claude session could build without the owner.

**Not included:** owner tasks (test runs, tenant creation, email plan, MFA flip, legal), and e2e in CI (E13, deliberately last).

**Where the detail lives:**

| Topic | Doc |
| --- | --- |
| Columns and migrations 0126–0135 | `docs/02-data-model.md` § "Batch 3 schema changes", § "Batch 4 notes" |
| Routes, payloads, error codes | `docs/03-api-contract.md` (batch 3 + batch 4 sections) |
| Session-status cache, client-IP trust, prod boot rule | `docs/04-auth-flows.md` |
| Frozen points, least-AI tiers, evaluation-queue types | `docs/05-ai-pipeline.md` |
| Migrations by hand, Caddy `/try`, reminders worker job | `docs/06-deployment.md` § "Batch 4 deploy", § "/try" |
| Defects found and fixed | `docs/RCA_LOG.md` (2026-10-02 entries) |
| Module internals | `SKILL.md` of modules 01, 03, 04, 05, 06, 07, 09, 10, 11, 13, 16, 18, 20 |
| Reminders design | `docs/plans/INVITATION_REMINDERS.md` |

---

## Batch 3

### 1. Numeric and multi-select questions (`273e2bc`)
- **What:** two new question types, scored deterministically on the same path as MCQ.
  - `numeric`: `{question, answer, tolerance?, unit?}`. Correct when `|given − answer| ≤ tolerance`.
  - `multi_select`: `{question, options[2..10], correct[], scoring: all_or_nothing|partial}`. Partial = points × max(0, (right − wrong)/|correct|).
  - Migration 0129 widens the `questions_type_check` constraint.
- **Candidate side:** the candidate view sends an allowlist of fields only (`question`+`options`, or `question`+`unit`), so answer keys never leave the server. Option shuffle covers multi-select, up to 10 options.
- **Why:** campus aptitude tests need "enter the value" and "select all that apply".
- **Rejected:**
  - AI generation of these types (skills unchanged).
  - Field-by-field editor forms; content stays the JSON editor plus help.
- **07 change:** two evaluation-queue predicates widened to treat the new types as deterministic. Opus-reviewed.

### 2. Freeze question points per attempt (`390e39c`, `1547f2b`; E12)
- **What:**
  - Migration 0128 adds `attempt_questions.points`, backfilled and NOT NULL, plus a BEFORE INSERT default trigger.
  - Attempt start writes the points.
  - Six readers now use `aq.points`: 09 `mcq.ts`, 06 frozen list, 07 grade / rerun / claim-release / manual-score.
- **Why:** editing a published question's points used to change the scores of students who hadn't been graded yet.
- **Codex review: revise.**
  - Fixed: the backfill now fails loudly instead of leaving NULLs.
  - Accepted and documented:
    - The trigger runs under the inserting role's RLS, so a failure there is loud, never a wrong value.
    - Points are read a few ms after the version freeze. `question_versions` has no points column.

### 3. Load hardening (`d9a0813`; R11)
- **Cache:**
  - A 30 s Redis cache of positive session-status checks (user active, tenant active). The user key stores the tenant it was verified under.
  - Never caches a negative.
  - Falls back to the database if Redis fails.
  - Invalidated on suspend, archive, disable, delete and erase.
- **Erasure:** the session loader now also rejects `erased_at`, and the admin erase route revokes sessions. Before this, erased candidates kept access.
- **DB connection budget:** api 40, worker 15, against `max_connections` 100.
- **Codex review:** accept.

### 4. Edit integrity switches after creation (`13eeebb`)
- **API:** `PATCH /api/admin/assessments/:id/integrity` merges only the `integrity` key (`jsonb_set`), in any status, and is audited.
- **UI:** a "Test integrity" card on the assessment page. Help migration 0130.

### 5. Fix batch (`0d5557a`)
- **Mark-read:** migration 0126 adds an UPDATE RLS policy for `in_app_notifications`. Mark-read never persisted before.
- **Webhooks:**
  - Backoff is now 1-based, so retry N uses `schedule[N-1]`.
  - Exhausted deliveries are marked `failed` instead of staying `pending`.
- **Audit:** Date values are written as ISO strings (they were stored as `{}`). `redactPayload` is unchanged; the callers were fixed.
- **Invitations list:** paged, "Showing x–y of N" with Previous / Next. Help migration 0127.
- **Also fixed:** the attempt Integrity card moved to its own file, because its fetch consumed the page test's ordered mocks.

## Batch 4

### 6. Test sections, per-section timers, calculator (`4ff4112`)
- **What:**
  - Setting `settings.sections[]`: name, question count and/or categories, minutes, calculator flag.
  - Questions are frozen per section (`attempt_questions.section_index`), with progress in `attempts.section_progress`; migration 0132.
- **Server enforcement:**
  - Each section has its own deadline.
  - Answers to a closed section are rejected with `AE_SECTION_LOCKED`.
  - `POST /api/me/attempts/:id/finish-section` moves to the next section, with no way back.
  - The candidate receives only the current section's questions.
- **Calculator:** a tokenizer plus precedence evaluator, no `eval`. Keyboard only works inside the panel, and it works with copy/paste blocking.
- **Why:** campus aptitude drives run as timed sections (Quantitative / Logical / Verbal).
- **Rejected:** reusing the blueprint, which is single-domain, untimed and super-admin only.
- **Not included (now PENDING N1):**
  - Per-section score breakdown.
  - A guard on editing sections after attempts start.
  - A final submit dialog that counts all sections.
  - A section edit UI.

### 7. Invitation reminders (`4b82e0e`)
- **What:**
  - Setting `settings.reminders {enabled, hours_before}`, **off by default**.
  - Worker repeatable `invitation.reminders` every 30 min. Limits: 25 per run, 100 per trailing 24 h across the platform, bulk lane.
  - Migration 0134 adds `assessment_invitations.reminded_at`.
  - Each reminder is claimed in its own transaction.
  - The token is rotated, as with resend, and expiry is never extended.
  - If the send fails, the claim is released and the next run retries.
- **Why:** students who haven't started miss drives. The cap protects the shared Brevo quota of 300/day.

### 8. Least-AI grading tiers 1–2 (`4ff2577`, `dea16b4`; SP5)
- **Tier 1:** an answer with fewer than 3 non-space characters gets a band-0 "No answer given" proposal, with no AI call.
- **Tier 2:** reuse the band of an identical answer. "Identical" means trimmed and whitespace-collapsed, **case kept**. The source must be:
  - a final, accepted AI grade;
  - in the same tenant;
  - for the same question_version and score_max;
  - under the same prompt skill shas.

  Matches that disagree on score or band block reuse.
- **D8 unchanged:** both tiers produce proposals only. `insertGrading` is still called only from accept and override.
- **Rubric binding:** grading reads `qv.rubric` of the frozen version, so the same version means the same rubric.
- **Codex review: revise.** Both points fixed: case-folding removed, and band ambiguity now blocks reuse.

### 9. Public "Try a sample test" demo (`4e59b18`, `e426760`; H1)
- **What:**
  - `/try`: 7 fixed questions, a 10-minute timer, client-side scoring, zero network requests (nothing stored, no AI).
  - `/try/certificate`: a static sample marked SAMPLE.
  - A share image, and a home-page CTA.
- **Edge:** the shared Caddy `@app` matcher gained `/try /try/*`. The owner approved; backup `Caddyfile.bak.20261002T034840Z`; edited inode-safe.
- **Bug found:** a `public/try/` folder made nginx answer 301 → 403. The image moved to `/brand/social/try-og.png`.

### 10. Client IP, invitation brake, erased-candidate guards (`f624775`, `e752be6`; D5, E3)
- **Client IP:**
  - `CF-Connecting-IP` must be a valid IP (`validCfIp`), and is honoured only on origin-verified requests.
  - 06 take/consent and 18 `/verify` now use `extractClientIp`.
  - Production refuses to boot unless `ORIGIN_TRUST_MODE=enforce`.
- **Invitation brake:** `POST /api/invitations/accept` has a failure-only brake per IP, 30 per 60 s. **A valid accept is never blocked**, so a campus behind one IP is safe.
- **Erased candidates:** `409 CANDIDATE_ERASED` on invite / resend (05), manual-score / override (07), certificate reissue (18) and data export (20).
- **Codex review: revise.** Both points fixed: the prod enforce boot rule, and the NAT lockout.

---

## Verify on the live site
Owner scripts (local, in `docs/testing/`):
- `AssessIQ_Pilot_Batch2_Test_Script.docx` covers batch 2.
- No dedicated script for batches 3 and 4 yet. Quick checks:
  - Create a numeric and a multi-select question, take a test and check the score.
  - Create an assessment with two sections (one with the calculator): the section timer, "Finish section", and that a finished section can't be reopened.
  - Turn reminders on for an assessment.
  - `/try` end to end.
  - Edit integrity switches on an existing assessment.

## Rollback
- **Code:** redeploy the previous image tag (`git checkout <sha>` on the VPS, then rebuild).
- **Migrations:** additive. Rollback notes are in each migration header.
- **Caddy:** `cat Caddyfile.bak.20261002T034840Z > Caddyfile`, then reload.
- **Reminders:** untick them per assessment.

## Downstream impact / open items
- **N1:** sections follow-ups (see item 6).
- **N2:** the `apps/api` test suite isn't run by CI, and 6 old route tests fail there.
- **N3:** the push-gate hook's jq-less fallback misses `git push` after a quoted env var. Fix awaits owner approval; until then push as its own command.
- **E13:** e2e in CI, last.
