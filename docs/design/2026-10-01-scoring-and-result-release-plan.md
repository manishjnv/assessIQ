# Scoring and result-release plan

**Date:** 2026-10-01 · **Status:** superseded 2026-10-16 — open items are tracked in docs/ROADMAP.md § P0-Z (rows kept here for history). Was: PARTLY DONE 2026-10-01. SP1-SP4 shipped (b8163e1), SP9-SP11 shipped (1564489, ee8a28f). SP5-SP8 not started. Local only (docs/ is gitignored; public repo).
**Inputs:** owner rules (2026-10-01), grading research `docs/design/research-2026-10-01/D-grading-methods.md`,
product review `docs/design/2026-10-01-product-review-competitive-strategy.md`, current code (cited below).
**Read first:** `docs/05-ai-pipeline.md` (Phase 1 vs Phase 2 and the D8 compliance frame).

## 1. Owner rules (2026-10-01)

| # | Rule |
|---|---|
| P1 | A student sees **only a complete, final score**: never a partial or provisional one (no "MCQ part so far", no "pending-review band"). |
| P2 | If the result can't be ready within **about 1 minute** of submit, tell the student right away that it will be **emailed to their registered address**. |
| P3 | Each tenant admin chooses **Auto release** (publish when complete) or **Manual release** (admin publishes). |
| P4 | Grade with the **least AI** that keeps accuracy: answer keys first, AI only for written judgment, humans only for flagged cases. |

Interpretation used here: "full score" means *complete* score. A complete result shows total, percentage, pass/fail and
certificate. A section breakdown is an optional tenant toggle (default off). Answer keys and per-question model answers
are never shown (item security).

## 2. Definition of a "complete" result (the P1 gate)

An attempt's result may be published only when **all** of these hold:
1. Every question in the attempt, of **every** type, has one final grade.
2. No grade has status `review_needed` or an `AIG_*` failure class.
3. `attempts.status = 'graded'`.
4. The candidate is not erased (existing gate, `admin-claim-release.ts:336-358`).
5. (Phase 2) Each AI grade was either human-accepted or auto-committed under the calibration rule in §4.

**Gaps in today's code that break P1** (fix first, item SP1):
- KQL is outside the completion gate: the gate counts only `subjective/scenario/log_analysis`
  (`07-ai-grading/src/handlers/admin-accept.ts:212,231`) and KQL has no grader (`admin-grade.ts:381-384`), so an attempt
  with KQL becomes `graded` with KQL silently missing from the total.
- `review_needed` grades count toward the gate (`admin-accept.ts:241-244` filters only `override_of` and `grader`), and
  release checks only erasure. A manual admin can see the flag; auto-release would publish it.
- MCQ is already safe: finalise happens only when every question is MCQ and every MCQ has its row
  (`09-scoring/src/mcq.ts:135-145`).

## 3. Scoring cascade (P4) — stop at the first confident step

| Tier | What | AI? | Status |
|---|---|---|---|
| 0 Deterministic | MCQ (live); multi-select, numeric (R9); KQL by running the query on a sample dataset and comparing results (X4); log analysis as "select the suspicious lines / list the IOCs" matched to the key; scenario steps as structured choices + short reason | No | MCQ live, rest to build |
| 1 Reuse | Same normalized answer + same rubric version + same model → reuse the stored grade (consistency; also flags copying) | No | Build |
| 2 Rules | Blank, too short, or no rubric keyword/synonym at all → band 0. Keywords **never** award high marks on their own (stops keyword stuffing); they go to the AI as hints | No | Build |
| 3 AI | Haiku finds rubric points, Sonnet sets the 0-4 band (live). Add 2-3 human-graded example answers per question; wrap the answer as data and ignore instructions inside it; cache the rubric prompt prefix; Batch API when not time-critical | Yes | Live, add examples + guard |
| 4 Human | Low confidence, ≥2-band AI disagreement, within ±5% of the pass mark, `review_needed`, plus a 5-10% random audit | No | Partly (admin review) |

KQL until Tier 0 exists: the admin must score KQL items manually (override path) before the result counts as complete.
Warn when an assessment containing KQL is created: "KQL answers need manual scoring before results can be released".
Later, optional: embedding-similarity tier between 2 and 3 (needs an embedding model — defer).

## 4. Accuracy controls
- Rubric written once at authoring time, versioned with the question (not invented at grade time).
- Per-question calibration: before AI grades on a question are auto-committed (Phase 2), compare AI vs human on a small
  graded set; auto-commit only above an agreement target (e.g. QWK ≥ 0.70, tune); otherwise a human confirms each grade.
- Track AI-vs-human agreement over time from the random audit; alert on drift.
- Same answer → same grade (Tier 1) fixes AI rerun randomness.
- Freeze question points per attempt (E12) so a published score can't shift.
- Grow the eval set and bless a baseline (B5; today 1 case, no baseline).

## 5. Submit screen — the 1-minute rule (P2)

At submit, estimate `ready_in_seconds`:
- All items deterministic → about 0-5 s.
- Any AI item: **Phase 1** (AI only on admin click) → treat as "more than 1 minute". **Phase 2** (background AI) →
  per-item median from logs (measured 2026-10-01: ~36 s per written answer = anchors 15.6 s + band 20.2 s), items in
  parallel, plus queue wait.
- Any item needing a human (KQL manual, review) → more than 1 minute.

Then:

| Release mode | Estimate | Student sees |
|---|---|---|
| Manual | any | "Submitted. Your result will be emailed to r\*\*\*@gmail.com after <institution> releases it." |
| Auto | ≤ 60 s | "Scoring your answers (under a minute)…" with a progress indicator → the complete result. **Hard cap 60 s**: if not complete by then, switch to the email message. Never a partial number. |
| Auto | > 60 s | "Your result will be emailed to r\*\*\*@gmail.com as soon as it's ready." |

The email links to the candidate portal result page (magic-link login). The registered email is masked on screen.

## 6. Release modes (P3)
- **Setting:** tenant default `result_release_mode` = `manual` | `auto` (default **manual** for new tenants — safer for
  hiring; set **auto** for campus/practice tenants such as the pilot). Optional per-assessment override (inherit / auto /
  manual), chosen when the assessment is created.
- **Auto:** when an attempt becomes complete (§2), release it in the same flow, using the **same release service** (erasure
  gate, certificate issue, audit row with actor "system: auto-release", result email queued). For a test with written
  answers, "complete" means the super admin has evaluated it: accepting the **last** grade (§2 complete) releases the
  evaluation to the tenant **automatically** (§11, owner 2026-10-01 — no separate release click), and the student then
  gets the result with no tenant click. Auto-scored tests publish at completion.
- **Manual:** results stay hidden; the admin sees "Ready to release" and uses Release or **Release all ready** (A9).
- **Switching modes:** affects only results not yet released. Switching to Auto offers "also release the N results that
  are ready now?" (bulk). Nothing is ever released retroactively without that click.
- **After release:** if an override later changes a released score, the student gets a "your result was updated" email;
  every change is audited.

## 7. Result email (P2)
- Build `sendResultReleasedEmail` (A9 — today it is never exported, so release emails are silently skipped).
- Content: assessment name, final score/percentage, pass/fail, certificate link if issued, portal link. No answers, no
  partial data. One email per release, retried and logged in `email_log`.
- Capacity: a campus cohort can exceed Brevo free (300/day, shared) — upgrade or stagger (A5); split the email queue from
  the cron queue (R7).

## 8. Phases
- **Phase 1 (now, no API budget):** Tier 0 at submit; Tiers 1-3 run when the **super admin** clicks Evaluate in the
  platform queue (§11; Tiers 1-2 cut AI calls); Tier 4 = super-admin review, then tenant review in Manual mode; release modes, the 1-minute screen, result page and email all work — Auto release involves no AI
  call, so it stays inside the D8 compliance frame.
- **Phase 2 (after OD2 — paid API):** Tiers 0-3 run automatically after submit in the background; Tier 4 queue for flagged
  items; calibration rule decides auto-commit. Requires updating CLAUDE.md rule #1 and the ambient-AI lint
  (`lint-no-ambient-claude.ts`, codex gate) — the documented Phase 2 path in `docs/05-ai-pipeline.md`.

## 9. Work items (SP = scoring plan; IDs chosen not to clash with S/N/X/L/OD or P1-D)

| ID | Item | Depends on | Load-bearing |
|---|---|---|---|
| SP1 | Completion gate covers **all** question types and excludes `review_needed` / `AIG_*` grades; KQL needs a manual score | — | 07 (codex gate) |
| SP2 | Release-mode setting (tenant default + per-assessment override). Auto = publish to the student when the super admin releases the evaluation (written-answer tests, §11) or at completion (auto-scored tests); through the existing release service + audit | SP1, SP10 | 07, 02 |
| SP3 | Candidate submit screen (≤60 s wait vs email message) + result page + `/result` returns the complete result only after release (replaces R3's result-page part) | SP1, SP2 | 06, 11 |
| SP4 | Result email + "result updated" email (A9) + capacity (A5) + queue split (R7) | SP2 | 13 |
| SP5 | Tiers 1-2 (reuse cache + rules) in the grading flow | — | 07 (codex gate) |
| SP6 | Calibration examples per question + agreement tracking + eval set growth (B5) | — | 07 |
| SP7 | Tier 0 expansion: multi-select, numeric (R9), KQL execution (X4), structured log/scenario items | — | 04, 06, 09 |
| SP8 | Phase 2 background grading with calibration-gated auto-commit (X1) | OD2 | 07 (codex gate) |
| SP9 | Platform evaluation queue (§11): who may trigger AI evaluation is a **switch on `AI_PIPELINE_MODE`** (owner 2026-10-01): `claude-code-vps` (today, no API key) → super_admin only, tenant Evaluate button hidden; `anthropic-api` (when there is API budget) → tenant admins may evaluate too — not a hard-coded role check; cross-tenant queue page; evaluate inside `withTenant(attempt.tenant_id)` with tenant audit rows. Implements R6/N10 | SP1 | 07, 01, 02 (codex gate) |
| SP10 | Release-to-tenant is **automatic** when the super admin accepts the last grade (owner 2026-10-01; keep a manual "release all complete" only as a recovery action) + tenant dashboard notice ("N new results published" in Auto, "N results ready to publish" in Manual) + tenant review screen: publish (single/bulk), override with reason, send back for re-evaluation; `evaluation_released_at/_by` columns | SP9 | 07, 10 (codex gate) |
| SP11 | Queue service levels: age badges, owner alert past 24 h, expected-turnaround text in the student email message, tenant-facing ETA | SP9 | 13, 10 |

**Order:** SP1 → SP9 → SP10 → SP2/SP3/SP4 → SP11; SP5-SP8 after.

Docs to update when each item ships: `docs/02-data-model.md` (settings, columns), `docs/03-api-contract.md` (`/result`,
release endpoints), `docs/05-ai-pipeline.md` (gate, auto-release, Phase 2), `docs/13-email-system.md`, help-system entries
for the new setting (`help_id`), audit action catalog (auto-release).

## 11. Platform evaluation queue — AI grading only by the super admin (owner decision 2026-10-01)

**Decision.** AI evaluation is done only by the super admin (the owner, whose Claude subscription runs Claude Code on the
VPS), from the super-admin console. Tenant admins never trigger AI. They review evaluated results and publish them.
**Compliance note (stated once, owner accepted the residual risk):** Anthropic's Claude Code legal page says products
should use API keys and Pro/Max limits assume "ordinary, individual usage". Owner-only, per-item reviewed evaluation is
the lowest-risk way to keep using the subscription. **AssessIQ is free — no customer payments (owner, 2026-10-01)**, so
nothing is resold. Switch the engine to an API key (OD2) if paid plans start (D2/D3) or volume grows well beyond one
person's ordinary use. The workflow below does not change when the engine changes (`AI_PIPELINE_MODE`).

**Flow**
1. **Submit.** Auto-scorable-only attempts are complete at submit and skip the queue (tenant release mode applies
   directly). Attempts with written answers go to the queue (`pending_admin_grading`, existing status); the student is
   told the result will be emailed (§5).
2. **Super-admin queue** (new page in the platform console): every tenant's attempts awaiting evaluation, oldest first;
   columns tenant, assessment, submitted time, number of written answers, age badge; filters by tenant / assessment /
   age. No answer text in the list. "Evaluate next" walks the queue one attempt at a time (single-flight, heartbeat).
3. **Evaluate.** Opens the existing grading review UI in the attempt's tenant context: Evaluate (AI) → per-question
   Accept / Override / Re-run with Opus. Complete only when §2 holds (all types graded, nothing flagged).
4. **Release to tenant — automatic** (owner decision 2026-10-01): when the super admin accepts the last grade and the
   attempt is complete (§2), the evaluation is released to the tenant in the same transaction
   (`evaluation_released_at/_by` set, audit row). No separate click — accepting each grade is already the super admin's
   review. A manual "release all complete" stays only as a recovery action. The tenant dashboard shows a notice:
   "N new results published" (Auto) or "N results ready to publish" (Manual).
5. **Tenant side**, by the tenant's release mode:
   - **Auto:** the student's result is published the moment the evaluation completes, i.e. when the super admin accepts
     the last grade (email with score, pass/fail and certificate + portal).
   - **Manual:** the tenant admin reviews scores, evidence and justification, then **Publish** (single or bulk), or
     **Override** a question's score with a reason (manual, no AI, fresh MFA — existing override path), or **Send back
     for re-evaluation** with a note (returns the attempt to the queue).
6. **Student:** complete score only, by email and in the portal (§1, §5, §7).

**States.** `pending_admin_grading` (in queue) → `graded` (evaluation complete) → evaluation released to tenant → `released`
(student sees). Prefer new columns `attempts.evaluation_released_at` / `evaluation_released_by` over a new status value:
the status enum is read in many modules (06, 07, 09, the 15-analytics MV, the frontends). Auto-scorable attempts set
`evaluation_released_at` at completion. "Send back" clears it and returns the attempt to the queue, with an audit row.

**Security and privacy**
- AI grade/generate routes become **super_admin only while `AI_PIPELINE_MODE=claude-code-vps`** (no API key; implements
  R6/N10 and hides the tenant Grade button). **When API budget exists (`anthropic-api`), tenant admins may trigger
  evaluation themselves** (owner 2026-10-01): gate on the mode, not a hard-coded role. Same review/release flow either way.
- Cross-tenant queue list: the existing system-role read pattern (`apps/api/src/routes/admin-super.ts:379-414`), minimal
  fields only. Each evaluation runs inside `withTenant(attempt.tenant_id)`; every evaluate/accept/override/release writes
  an audit row in that **tenant's** audit log with the super admin as actor. No new cross-tenant write path.
- Candidates' answers are read by AssessIQ staff with AI assistance: disclose this in the privacy notice and tenant terms
  (with the AI sub-processor — R5, D1).

**Capacity.** One person on one subscription handles about 50-150 attempts a day; a written answer takes about 36 s of AI
time plus review. A 100-student drive with 5 written answers each is about 5 hours of AI time. Give tenants an expected
turnaround (e.g. "results within 48-72 hours"), show it in the student's email message, alert the owner when items age
past 24 h, and use tiers 1-2 (§3) to cut AI calls.

## 12. Not included
- Showing per-question answers or answer keys to students (never).
- Provisional or "MCQ part so far" scores (owner rule P1 overrides the research suggestion in appendix A).
- Embedding similarity (deferred), AI interviewer, appeals workflow beyond the update email.
