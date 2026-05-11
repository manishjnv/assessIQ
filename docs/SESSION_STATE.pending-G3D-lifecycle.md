# Session — 2026-05-11 (pending merge — G3.D 05-assessment-lifecycle)

> **Note to orchestrator:** this file holds the session-state handoff for the
> G3.D 05-assessment-lifecycle audit-write sweep, written to a pending file to
> avoid a merge conflict with the concurrent c356160 (18-certification) revision
> session. Merge the body of this file into `docs/SESSION_STATE.md` after both
> sessions land.

**Headline:** G3.D audit-write sweep landed in `modules/05-assessment-lifecycle` — every admin-mutating service method now writes an atomic `audit_log` row via `auditInTx` inside the same withTenant transaction.
**Commits:** (one local commit — orchestrator pushes after Opus diff review)
**Tests:** 11/11 new audit-writes pass; 84/86 lifecycle.test.ts pass; 5/5 invite-email.test.ts pass. 2 pre-existing failures in `lifecycle.test.ts` § "Dev-email log" (assert `/invite/` and `AssessIQ (Tenant A)` against the OLD invitation_candidate template; in-flight 13-notifications i18n refactor changed the template — unrelated to G3.D).
**Next:** Orchestrator runs Phase 3 diff critique; cron boundary transitions (`boundaries.processBoundariesForTenant`) are a follow-up audit slice with `actor_kind="system"`.
**Open questions:**
- O1: Promote `assessment.invite.revoked` / `assessment.reopened` to first-class catalog entries in a future slice, or keep the `after.kind` marker pattern indefinitely?
- O2: Audit `cron`-driven boundary transitions — single summary row per tick, or per-assessment with `actor_kind="system"`?
- O3: Re-fire the two pre-existing dev-email-log tests once the 13-notifications i18n refactor lands and the template asserts can be updated.

---

## Detail

### Wired sites (7 auditInTx call-sites across 7 admin-mutating service functions)

| # | Function | Action | Catalog status |
|---|---|---|---|
| 1 | `createAssessment` | `assessment.created` | pre-existed |
| 2 | `updateAssessment` | `assessment.updated` | **NEW** (only catalog addition) |
| 3 | `publishAssessment` | `assessment.published` | pre-existed |
| 4 | `closeAssessment` | `assessment.closed` | pre-existed |
| 5 | `reopenAssessment` | `assessment.published` with `after.kind=reopen` | pre-existed (marker pattern) |
| 6 | `inviteUsers` | `assessment.invite` × N invitations | pre-existed |
| 7 | `revokeInvitation` | `assessment.invite` with `after.kind=revoke` | pre-existed (marker pattern) |

Signature changes: `updateAssessment`, `publishAssessment`, `closeAssessment`, `reopenAssessment`, `revokeInvitation` each gained a trailing `xxxByUserId` actor parameter. 5 route handlers in `routes.ts` updated to thread `req.session!.userId`.

### Files touched (all under module 05 + 1 line in 14-audit-log + 1 doc section + this file)

| File | Change |
|---|---|
| `modules/14-audit-log/src/types.ts` | `+1` line: `'assessment.updated'` added to ACTION_CATALOG |
| `modules/05-assessment-lifecycle/src/service.ts` | `auditInTx` import + 7 wired call-sites + 5 new actor params |
| `modules/05-assessment-lifecycle/src/routes.ts` | 5 routes thread `userId` into the new service signatures |
| `modules/05-assessment-lifecycle/src/__tests__/audit-writes.test.ts` | NEW — 11 tests (per-function happy-path + atomicity proof + coverage grep) |
| `modules/05-assessment-lifecycle/src/__tests__/lifecycle.test.ts` | Migration set + role setup extended for `14-audit-log/migrations/0050_audit_log.sql`; all changed-signature call-sites updated to thread `adminA` |
| `modules/05-assessment-lifecycle/src/__tests__/invite-email.test.ts` | `@assessiq/audit-log` added to vi.mock list (pure-mock unit test) |
| `modules/05-assessment-lifecycle/SKILL.md` | New § Audit-write coverage section |
| `docs/11-observability.md` | New § 16 mirroring § 15 (04-question-bank) for the 05-assessment-lifecycle slice |
| `docs/SESSION_STATE.pending-G3D-lifecycle.md` | This file (orchestrator merges into SESSION_STATE.md) |

### Verification gates

- `pnpm --filter "@assessiq/assessment-lifecycle" typecheck`: clean for module 05; the 3 pre-existing `lastSeenAt` errors in `modules/07-ai-grading/src/routes.ts` remain (unchanged count).
- `pnpm --filter "@assessiq/assessment-lifecycle" test -- audit-writes`: **11/11 pass** in ~17.93s.
- `pnpm --filter "@assessiq/assessment-lifecycle" test`: 95/97 pass. 2 failures are pre-existing in `lifecycle.test.ts § Dev-email log` (template-format drift from the in-flight 13-notifications i18n refactor — unrelated to audit wiring).
- `pnpm --filter "@assessiq/ai-grading" exec tsx ci/lint-no-ambient-claude.ts`: **OK** — 325 TS files scanned, 0 violations.
- Coverage grep: `grep -c "auditInTx(" modules/05-assessment-lifecycle/src/service.ts` = **7** (matches the 7 wired admin-mutating functions exactly).

---

## Agent utilization
- Opus: orchestrator (this sub-session was dispatched by Opus); session-state-merge step pending after Opus diff review of the diff produced here.
- Sonnet: this session — implementation + tests + docs for the G3.D 05-assessment-lifecycle slice (single Sonnet subagent, isolated to module 05 + 1-line 14-audit-log catalog add + 1 doc section + this pending file).
- Haiku: n/a — no bulk sweeps needed (the change set is module-local and contract-driven).
- codex:rescue: n/a — this slice does not touch security/auth/AI-classifier code; only audit-coverage of an already-load-bearing module. Wiring follows the eff0ba2 04-question-bank template exactly, with the deviation that `inviteUsers` emits one row per invitation (vs the QB summary-per-bulk-op pattern) — documented inline in service.ts and observability.md § 16.1.
