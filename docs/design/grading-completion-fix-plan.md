# Plan — Grading never completes: fix Accept contract + Stage-1 resilience

**Status:** PLANNED — not started. Saved 2026-05-26 for a later session.
**Owner model:** Opus orchestrates; load-bearing 07 work stays Opus + codex gate.
**Trigger:** User report "for 943a41a, grading still failing, it does not complete assessment grading at all."

> Resume contract: this doc is self-contained. A future session can execute it
> without re-reading the diff or re-running discovery. Start at Phase 0.

---

## Root cause (code-confirmed, two bugs)

`943a41a` (reasoning-only fallback) fixed grade *generation* — proposals are produced
fine. It never touched the step that *persists* grades, which is broken.

### Bug A (dominant) — Accept silently 422s; grades never persist; attempt never completes
Frontend/backend contract mismatch on `POST /api/admin/attempts/:id/accept`:
- **Backend** requires `{ proposals: [ …full GradingProposal objects… ] }`, non-empty
  array — `ACCEPT_BODY_SCHEMA = z.object({ proposals: z.array(PROPOSAL_WITH_EDITS_SCHEMA).min(1) })`
  at `modules/07-ai-grading/src/routes.ts:116-118`.
- **Frontend** `handleAccept` sends only `{ question_id }` — no `proposals` key —
  at `modules/10-admin-dashboard/src/pages/attempt-detail.tsx:306-309`. Same broken
  shape in the escalation-accept path at `attempt-detail.tsx:560-565`.
- Result: every Accept click fails schema validation → **HTTP 422 "Accept failed."**
  No `gradings` row ever written; `attempts.status` never flips to `graded`.
- Matches prod-log evidence (prior session): **zero `grading.accept` entries ever**.
- The backend `handleAdminAccept` (`admin-accept.ts`) ALREADY supports a batch — it
  loops `proposals`, writes a row each, flips status once. So no backend accept-API
  change is needed for the basic fix; the UI just never sent the right body.
- Note: the E2E test passes because the test sends the correct `{ proposals }` shape;
  the real UI never does. Contract drift uncaught by integration tests.

### Bug B (secondary) — specific anchored questions hard-fail Stage 1 (`AIG_SCHEMA_VIOLATION`)
- For questions WITH an anchor rubric, Stage 1 runs `submit_anchors` and validates with
  a bare `safeParse` (NO coercion) at `claude-code-vps.ts:153-161`; drift → throws
  `AIG_SCHEMA_VIOLATION` → that question becomes a score-0 "failed proposal."
- The `943a41a` reasoning-only fallback only triggers when a rubric has ZERO anchors
  (`admin-grade.ts:378-383`), so anchored questions with a drifted Stage-1 payload slip
  past it.
- The question-*generation* path already got a coercion layer (`coerceQuestionsPayload`,
  commit 4242e..., 2026-05-24 schema-drift incident). Grading Stage 1 never did — asymmetry.
- `AnchorFindingSchema` (`types.ts:17-22`) is lenient: `anchor_id: string, hit: boolean,
  evidence_quote?: string, confidence?: number(0..1)`; wrapper needs `{ findings: [...] }`.
- Known failing prod questions: `019dedd9-a7bd`, `019dedd9-a7e6` (attempt `019e0dd8-…`),
  `b19df776` (attempt `019e60bb-…`). Prior investigation: claude-mem obs 4913–4918, 4924.

---

## Locked decisions (from user, 2026-05-26)
1. **Scope = both A + B this session** (includes the load-bearing 07 change → codex gate).
2. **Accept-all skips AI-failures** — never auto-commit a score-0 / `AIG_*` proposal.
   Failed questions stay flagged for manual Re-run/Override; the attempt is NOT marked
   `graded` until every AI-gradeable question has a committed grading row.

---

## Phased plan

### Phase 0 — confirm two facts before coding (cheap)
1. Pull the prod log `details.issues` for a failing question (`b19df776`) from
   `claude-code-vps.ts:159` logging → classify Bug B's exact drift (string confidence?
   missing `hit`? unwrapped array?) so the coercion targets the real shape. (Haiku ssh.)
2. Confirm whether `mcq`/`kql` get `gradings` rows or are scored separately by module 09,
   so the completion-gate (Phase 2) counts the right denominator. (Quick code read.)

### Phase 1 — Bug A: fix Accept + Accept-all + summary UX  (10-admin-dashboard, non-load-bearing → Sonnet impl, Opus review)
- Fix `handleAccept` to send `{ proposals: [theFullProposal] }` (proposal is already in
  React `proposals` state). Same fix for the escalation-accept path (`attempt-detail.tsx:560`).
- Add **"Accept all"** → posts `Object.values(proposals)` FILTERED to exclude AI-failures
  (`error_class` starts `AIG_`, or `model === "none"`, or `prompt_version_sha === "error:no-sha"`).
- **Grading summary panel**: total score / max, "X of N graded", per-question status chips,
  AI-failures rendered as "needs review — Re-run / Override" (never as a real 0).

### Phase 2 — Bug A backend: completion-gate  (07-ai-grading, load-bearing → Opus owns)
- `acceptProposals` (`admin-accept.ts:191-220`) currently flips `status='graded'` on ANY
  accept. Change to flip (and fire the `graded` audit + `recordGradedAttempt` billing) ONLY
  when every AI-gradeable question has a committed grading row; else stay
  `pending_admin_grading`. Preserve the billing==graded same-tx invariant
  (memory: billing-events-grade-commit-critical-path).

### Phase 3 — Bug B: Stage-1 resilience  (07-ai-grading runtime, load-bearing → Opus owns)
- Add tolerant coercion of the `submit_anchors` payload before `safeParse` (mirror
  `coerceQuestionsPayload` precedent), targeting the Phase-0 drift class.
- If it STILL won't parse, **degrade to reasoning-only band** for that question
  (anchors `[]`, proceed to Stage 2) instead of throwing `AIG_SCHEMA_VIOLATION` — extends
  the `943a41a` philosophy. Unit tests for both coercion + degrade.

### Phase 4 — gates (before push)
- Typecheck touched modules; unit tests (07 handlers + runtime; NEW accept-contract test);
  secret/TODO scan on the diff.
- **codex:rescue adversarial sign-off** on Phase 2+3 (07 = load-bearing classifier +
  billing/audit/status-machine). Fallback ladder if companion down: Sonnet takeover →
  Opus takeover; log verdict as commit trailer.

### Phase 5 — deploy (additive, namespaced — memory: vps-shared-host)
- Commit (noreply pattern) → `ssh assessiq-vps 'cd /srv/assessiq && git pull'` → rebuild
  `assessiq-api` + `assessiq-frontend` (`--no-deps`, neighbors untouched) → `/api/health` 200.

### Phase 6 — docs + handoff (same-PR, Definition of Done)
- RCA_LOG: both bugs. **Prevention**: contract test asserting the FE accept body satisfies
  `ACCEPT_BODY_SCHEMA` so this drift can't silently recur.
- 03-api-contract (accept body), 05-ai-pipeline (Stage-1 coercion/degrade + completion-gate
  + accept-all compliance note: still human-in-the-loop — proposals rendered before the click),
  08-ui-system (summary + accept-all), SESSION_STATE + 5-line agent-utilization footer.

**Verification reality:** confirm accept no longer 422s and logs show `grading.accept.complete`;
full browser round-trip is operator-pending (cannot drive UI / spawn `claude`).

---

## Routing
Phase 0 → Haiku/Opus · Phase 1 → Sonnet + Opus review · Phases 2–3 → Opus (load-bearing) +
codex gate · Phase 5 → Haiku verify sweep.

## Key file references
- `modules/10-admin-dashboard/src/pages/attempt-detail.tsx` — handleGrade 282, handleAccept 302-321, escalation-accept 560-565, Grade-all button 420-429
- `modules/07-ai-grading/src/routes.ts` — ACCEPT_BODY_SCHEMA 116-118, accept route 257-328
- `modules/07-ai-grading/src/handlers/admin-accept.ts` — acceptProposals 101-223, status flip 191-198
- `modules/07-ai-grading/src/handlers/admin-grade.ts` — batch loop 340-434, reasoning-only fallback 378-383, failed-proposal build 414-432
- `modules/07-ai-grading/src/runtimes/claude-code-vps.ts` — Stage-1 safeParse 153-161
- `modules/07-ai-grading/src/types.ts` — AnchorFindingSchema 17-22, GradingProposalSchema 50-68
