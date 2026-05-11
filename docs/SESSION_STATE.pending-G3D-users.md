# Session — 2026-05-11 — G3.D 03-users audit-write sweep (PENDING merge)

> Pending file per orchestrator coordination — three parallel G3.D windows wrote concurrent session-state. Orchestrator merges into `docs/SESSION_STATE.md` post-hoc.

**Headline:** modules/03-users now writes one audit_log row per admin mutation atomically; 13/13 new audit-writes tests pass; pre-existing acceptInvitation token-regex test still fails (not introduced).
**Commits:** `057de7d — feat(users): G3.D audit-write sweep — atomic auditInTx wiring`
**Tests:** pass (46/48 + 1 todo + 1 pre-existing acceptInvitation regex failure unrelated to this slice)
**Next:** orchestrator: merge §17 ordering with window 2's §16 in docs/11-observability.md (already appended after §16, no merge conflict expected); window 1 (certification) and window 2 (lifecycle) committed independently
**Open questions:**
- Should the legacy `user.disabled` and `user.role.changed` ACTION_CATALOG entries be deprecated or kept? This slice folds them under `user.updated kind=...` per minimal-catalog-footprint.
- The 42-char token in `users.test.ts:649` predates the 2026-05-09 INVITATION_TOKEN_RE regex; it consistently throws INVALID_INVITATION_TOKEN instead of NotFoundError. One-line fix (extend the literal to 43+ chars) is out of scope for this slice but worth a follow-up RCA entry.

---

## Agent utilization
- Opus: orchestrator pre-flight + Phase 0 reads + dispatch into this Sonnet session; will Phase 3 diff-review the commit before push.
- Sonnet: this entire G3.D 03-users implementation (this session).
- Haiku: n/a — no bulk grep/triage delegated.
- codex:rescue: n/a — non-load-bearing path (03-users is a domain table, not in CLAUDE.md load-bearing list); audit-log/types.ts append is a 3-line additive change to an already-load-bearing module's catalog and matches the QB/AL slices' precedent.

---

## Detail — wired sites

| Service function | `audit_log.action` | Catalog entry status |
|---|---|---|
| `createUser` | `user.created` | existed |
| `updateUser` | `user.updated` (`kind=status_change \| role_change \| general`) | NEW |
| `softDelete` | `user.deleted` | existed |
| `restore` | `user.restored` | NEW |
| `inviteUser` (new) | `user.invited` (`kind=new`) | NEW |
| `inviteUser` (reinvite) | `user.invited` (`kind=reinvite`) | NEW |

## Detail — out-of-scope (per spec)

- `acceptInvitation`: invitee acting on own pending row → 01-auth session audit
- `bulkImport`: Phase-1 stub (throws BULK_IMPORT_PHASE_1)
- `sweepUserSessions`: post-commit Redis housekeeping; the `updateUser status=disabled` audit row already covers the user-state transition
- `assertNotLastAdmin`, `assertValidStatusTransition`: pure validators, no DB write
- All read-only methods: `listUsers`, `getUser`, `findUserByEmailNormalized`

## Detail — coordination notes

- **modules/14-audit-log/src/types.ts:** appended 3 entries (`user.updated`, `user.restored`, `user.invited`) at the END of ACTION_CATALOG, after window 1's certification entries and window 2's `assessment.updated`. Append-only, no reordering.
- **docs/11-observability.md:** appended §17 after window 2's §16. No conflict expected with concurrent windows.
- **docs/SESSION_STATE.md:** intentionally NOT touched — this pending file workaround per the dispatch prompt's coordination clause.
- **docs/RCA_LOG.md:** intentionally NOT touched — no bug fix in this slice.
- **modules/14-audit-log/src/audit.ts** + audit migrations: NOT touched — only catalog appends are allowed per spec.

## Detail — pre-existing failures NOT introduced by this slice

`src/__tests__/users.test.ts > acceptInvitation > rejects unknown token with INVITATION_NOT_FOUND` — the test passes a 42-char token literal but `INVITATION_TOKEN_RE = /^[A-Za-z0-9_-]{43,64}$/` (added in the 2026-05-09 invite-accept 500 fix) rejects with `INVALID_INVITATION_TOKEN` ValidationError before reaching the SQL hash lookup. Verified to fail on the stashed pre-change working tree. One-line fix (extend literal to 43 chars or change expectation to `ValidationError + INVALID_INVITATION_TOKEN`) is out of scope for this slice.
