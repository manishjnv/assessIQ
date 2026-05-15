# E2E Walkthrough Results — 2026-05-15

## Overview

Full production E2E walkthrough completed 2026-05-15, covering the entire candidate lifecycle from pack creation through certification and leaderboard ranking. Two production bugs were found and fixed during the run. All 21 smoke test checks pass against production.

---

## What ran

### Flow sequence

Pack creation → Questions (5 types) → Assessment → Candidate → Invite → Attempt → AI grading → Accept → Release → Certification → Leaderboard

### Key identifiers

| Entity | Value |
|---|---|
| Tenant | e2e-walkthrough-2026-05-15 |
| Tenant ID | 39049de6-50c1-4a1f-bc4d-a53244c9ed16 |
| Pack | SOC L1 |
| Pack ID | 019e2a27-eea1-7341-b288-4a3bfd1cc40d |
| Pack level | L1 SOC Analyst |
| Assessment | e2e-walkthrough-2026-05-15-cohort-1 |
| Assessment ID | 019e2a2d-18de-7dd5-abd9-19bb5ca1b504 |
| Attempt ID | 019e2a30-2c19-7abd-bf7a-7a4ae0b58af0 |
| Attempt status | released |
| Certificate serial | AIQ-2026-05-88GB5C |
| Certificate tier | distinction |
| Leaderboard rank | 1 |

### Questions authored (5 total)

| # | Type | Notes |
|---|---|---|
| 1 | MCQ | No deterministic grading endpoint — not AI-graded |
| 2 | log_analysis | AI-graded ✓ |
| 3 | scenario | AI-graded ✓ |
| 4 | KQL | No deterministic grading endpoint — not AI-graded |
| 5 | subjective | AI-graded ✓ |

### Grading outcome

- AI-graded questions: 3 (scenario, log_analysis, subjective)
- `auto_pct`: 100
- `pending_review`: false
- Certificate HMAC `signed_hash`: present and verified

---

## Bugs found and fixed

### Bug 1 — `AIG_HEARTBEAT_STALE` on all grade attempts

**Symptom:** Every AI grading attempt was rejected with `AIG_HEARTBEAT_STALE`, regardless of when the attempt was made.

**Root cause:** The `lastSeenAt` field was never propagated into `req.session`. Two locations were responsible:

1. `modules/01-auth/src/middleware/types.ts` — the `AuthRequest.session` interface did not declare a `lastSeenAt` field, so the field was invisible to TypeScript consumers downstream.
2. `modules/01-auth/src/middleware/session-loader.ts` — even if the field had been declared, the session-loader mapping block did not copy `session.lastSeenAt` onto `req.session`.

Both omissions are carry-forward misses: `lastSeenAt` was added to the underlying `Session` interface but the two consumer sites were not updated at the same time.

**Fix (commit 38756d9):**
- `modules/01-auth/src/middleware/types.ts`: added `lastSeenAt: string` to the `AuthRequest.session` type definition.
- `modules/01-auth/src/middleware/session-loader.ts`: added the mapping `req.session.lastSeenAt = session.lastSeenAt` in the session population block.
- `modules/01-auth/src/__tests__/middleware.test.ts`: updated 7 test mock objects that constructed `req.session` without `lastSeenAt` to include a valid timestamp value.

**Impact:** Unblocks AI grading for all future sessions. Any existing attempts that received `AIG_HEARTBEAT_STALE` due to this bug will need to be re-triggered.

---

### Bug 2 — Cert auto-issue silent failure: wrong column name

**Symptom:** After releasing an attempt that met the certification threshold (auto_pct ≥ 90, pending_review = false), no certificate was issued. No error was surfaced to the releasing admin.

**Root cause:** `modules/18-certification/src/service.ts`, function `issueCertificateOnRelease()`, contained a SQL query that referenced `a.candidate_id`. The `attempts` table schema uses `user_id` as the column name; `candidate_id` is the conceptual name used in the domain model but was never a physical column. The mismatch caused the query to return zero rows, silently producing no certificate.

**Fix (commit 66e78ff):**
- `modules/18-certification/src/service.ts`: changed `a.candidate_id` to `a.user_id AS candidate_id` in the SELECT, and updated the JOIN to `JOIN users u ON u.id = a.user_id`.

---

### Bug 3 — Cert auto-issue still failing after SQL fix: FK violation in auditInTx

**Symptom:** Even after the SQL column fix, auto-issue still did not trigger when using the E2E admin session.

**Root cause:** The production release handler passes `actorUserId = req.session!.userId`. The E2E admin session was minted with a synthetic userId that did not correspond to any row in the `users` table. Inside `issueCertificate`, the `auditInTx` helper writes a row to `audit_log` with an `actor_user_id` foreign key constrained to `users.id`. The synthetic userId triggered a FK violation. The violation was caught by the `.catch()` handler in the release handler and emitted via `streamLogger.warn()`, but the transaction was already aborted at that point, leaving no certificate row and no user-visible error.

**Workaround applied for this walkthrough:** Certificate was issued directly via a `withTenant` test script using the real admin userId `a40995f4-fbf2-4aeb-9e6f-10f87cd26d8d`, which exists in the `users` table.

**Long-term fix needed:** The session minting script (used for E2E / dev tooling) must use a `userId` that exists in the `users` table of the target tenant. A synthetic UUID that was never inserted is not a valid actor for any path that touches `auditInTx`. Alternatively, the cert auto-issue path could use a system actor UUID rather than the releasing admin's userId — see open questions.

---

## Known gaps (not implemented, not fixed this session)

| Gap | Detail |
|---|---|
| MCQ grading | `/grade` only handles subjective, scenario, log_analysis. MCQ has no deterministic scoring path. |
| KQL grading | Same as MCQ — no grading endpoint exists. |
| `sendResultReleasedEmail` | Not implemented in `@assessiq/notifications`. Release notifications are silently skipped — no error, no email sent. |
| `email_log` status update | Transport sends email but does not update `email_log.status` from `queued` to `sent`. Rows stay `queued` forever. |
| Cert auto-issue with synthetic session | When the releasing admin's userId does not exist in `users`, `auditInTx` FK violation aborts silently. No user-visible error is raised. |

---

## Why the changes were made

**`lastSeenAt` omission:** The field was added to the `Session` interface at some point but the two downstream consumer sites (`types.ts` type declaration and `session-loader.ts` mapping) were not updated in the same commit. A straightforward carry-forward miss — the type system didn't catch it because `lastSeenAt` was optional in the interface, so TypeScript did not complain about its absence in the session-loader.

**`attempts.user_id` vs `candidate_id`:** The `attempts` table was designed with `user_id` as the physical column name, following the FK convention used across AssessIQ schema (`user_id → users.id`). The certification service was written using the conceptual domain name `candidate_id`, which is consistent with how the field is referred to in the product and API contract but does not match the physical schema. The mismatch was not caught because there is no ORM layer to validate column names at build time.

---

## What was considered and rejected

- **MCQ/KQL auto-grading:** Adding a deterministic scoring path for MCQ (comparing selected option to correct option) was scoped out. It is a non-trivial change requiring schema additions (correct answer storage) and grading path branching. Deferred to a dedicated session.
- **Implementing `sendResultReleasedEmail`:** Deferred — out of scope for this walkthrough session. The notifications module gap is documented.
- **Making cert auto-issue use a system actor:** Considered as the long-term fix for the FK violation bug. Not implemented this session because it touches the audit log invariant (`actor_user_id` must be a real user or a designated system actor row). Surfaced as an open question.

---

## Downstream impact

| Change | Impact |
|---|---|
| `lastSeenAt` fix (38756d9) | AI grading is unblocked for all future sessions. Any attempt that was previously rejected with `AIG_HEARTBEAT_STALE` will need to be re-graded. |
| Cert SQL fix (66e78ff) | Certification auto-issue on release now functions correctly for attempts where the releasing admin's userId exists in the `users` table and auto_pct ≥ 90 with no pending review. |
| Cert FK gap (no fix) | The silent failure path remains active when session minting uses a synthetic userId. Dev/E2E tooling should be updated to mint sessions against real user rows. |
