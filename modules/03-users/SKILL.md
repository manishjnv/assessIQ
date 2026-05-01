# 03-users — User records, roles, invitations

## Purpose
Manage the `users` table: who exists in a tenant, what role they hold, lifecycle (invite → active → disabled → soft-delete). Pure record management — does NOT handle authentication (01-auth) or auth methods (01-auth).

## Scope
- **In:** user CRUD, role assignment, invitation issuance + tracking, bulk import (CSV), soft delete + restore.
- **Out:** authentication, password/TOTP credentials (01), tenant settings (02), permission checks beyond role (handled by `req.requireAuth(roles)`).

## Roles
- `admin` — full tenant control
- `reviewer` — can review and override AI grades, cannot change tenant settings or invite admins
- `candidate` — can take assigned assessments only

Future: `analyst` (read-only reports), `pack_author` (question-bank only). Add via DB enum extension + role check helper.

## Dependencies
- `00-core`
- `02-tenancy` — every user belongs to one tenant
- `13-notifications` — invitation emails

## Public surface
```ts
listUsers({ tenantId, role?, status?, search?, page, pageSize }): Promise<PaginatedUsers>
getUser(id): Promise<User>
createUser({ email, name, role, metadata }): Promise<User>
updateUser(id, patch): Promise<User>
softDelete(id): Promise<void>
restore(id): Promise<User>

inviteUser({ email, role, assessmentIds? }): Promise<{ user, invitation }>
acceptInvitation(token): Promise<{ user, sessionToken }>
bulkImport(csv: Buffer): Promise<ImportReport>
```

## Data model touchpoints
Owns: `users`, `user_invitations` (record-only fields; auth-bound fields like `token_hash` lifecycle in 01-auth).

## Help/tooltip surface
- `admin.users.role` — what each role can do
- `admin.users.status.disabled` — what happens to active sessions when disabled
- `admin.users.invite.bulk` — CSV format expected
- `admin.users.metadata.external_id` — how external_id flows through to webhooks

## Open questions
- SCIM 2.0 provisioning — Phase 3, when first enterprise client requires it (the IntelWatch pattern applies here)
- Role granularity — keep coarse for v1; add capability-based permissions in v2 only if needed

## Status

**Implemented — 2026-05-01 (Phase 0 G0.C-5 / Window 5).** Workspace package `@assessiq/users` live.

- **Migrations applied to `assessiq-postgres` on the VPS:** `020_users.sql` (users table + 2 RLS policies + 2 indexes including `users_email_lower_idx (tenant_id, lower(email)) text_pattern_ops` for the addendum § 9 prefix-search hot path), `021_user_invitations.sql` (user_invitations + 2 RLS policies + partial index on `(tenant_id, lower(email)) WHERE accepted_at IS NULL` for re-invite lookup). RLS-policy linter passes (11 migrations, 9 tenant-bearing tables matched).
- **Public surface:** `listUsers`, `getUser`, `createUser`, `updateUser`, `softDelete`, `restore`, `inviteUser`, `acceptInvitation`, `bulkImport` (501 stub), `sweepUserSessions` (Redis), `normalizeEmail`. All match the addendum-pinned contract; `bulkImport` and candidate-role `inviteUser` are Phase-1 stubs that throw with `details.code` = `BULK_IMPORT_PHASE_1` / `CANDIDATE_INVITATION_PHASE_1` / `ASSESSMENT_INVITATION_PHASE_1` and `details.httpStatus = 501`.
- **Tests:** 27 vitest cases pass against a `postgres:16-alpine` testcontainer (covers cross-tenant isolation, last-admin invariant, status-transition matrix, case-insensitive uniqueness, soft-delete cascade to invitations, invitation token shape, accept happy + expired + already-used + not-found, candidate-role 501). 1 `test.todo` for Redis sweep integration (deferred to Phase 1).
- **Cross-module integration.** `acceptInvitation` mints sessions via `@assessiq/auth.sessions.create` (the addendum § 12 contract; matches `01-AUTH-DEC` § 10 signature exactly). The mock seam at `__mocks__/auth-sessions.ts` was removed once Window 4 (01-auth) shipped on `origin/main` (commit `d9cfeb4`).
- **codex:rescue verdict — revised + accepted.** Adversarial review (2026-05-01) found 4 must-fix issues that were applied before push: (1) cookie-only session token in `POST /api/invitations/accept` response (no body bearer leak), (2) `sessions.create` moved AFTER the user-state transaction commits (no orphaned session on commit failure), (3) tight Fastify request schema on `/api/invitations/accept` (token length 43–64), (4) error-handler maps Fastify schema/parser errors to 4xx instead of 500. The HIGH "swap mock for real `@assessiq/auth.sessions`" finding is intentionally deferred because Window 4 (01-auth) is not yet on `origin/main`; the swap is the documented post-merge follow-up.

---

## Decisions captured (2026-05-01)

This addendum pre-flights Window 5 (G0.C-5: `03-users` + admin login screen) by freezing every implementation ambiguity surfaced by the Phase 0 plan plus the deep-read of `docs/02-data-model.md`, `docs/03-api-contract.md`, `docs/04-auth-flows.md`, and `modules/01-auth/SKILL.md` § Decisions captured (the Window-4 boundary contract). Each entry: **Decision · Source · Rationale · Considered & rejected · Downstream impact**. Source shorthand: `PLAN` = `docs/plans/PHASE_0_KICKOFF.md`, `02-DATA` = `docs/02-data-model.md`, `03-API` = `docs/03-api-contract.md`, `04-AUTH` = `docs/04-auth-flows.md`, `01-AUTH-DEC` = `modules/01-auth/SKILL.md` § Decisions captured (2026-05-01), `PHASE-1-PLAN` = `docs/plans/PHASE_1_KICKOFF.md`.

`user_invitations` (this module) and `assessment_invitations` (05-assessment-lifecycle, Phase 1) are **two distinct tables and two distinct flows**. `user_invitations` issues identity grants (admin/reviewer onboarding); `assessment_invitations` issues task grants (candidate magic-link to take a specific assessment). They share the SHA256-of-base64url-32-byte token primitive but have different TTLs, different routes, and different consumer modules. Do not conflate.

### 1. `bulkImport(csv)` — Phase 1 deferral, format pinned now

**Decision.** Window 5 ships `bulkImport(csv: Buffer)` as a Phase-0 stub that throws `NotImplementedError` with code `"BULK_IMPORT_PHASE_1"`. The route `POST /admin/users/import` is also a stub (`501 Not Implemented`, no body parsing). The CSV contract below is pinned now so that Phase 1 implementation is mechanical even if the Phase-1 file format pivots to JSON per `PHASE-1-PLAN` decision #4 (still user-blocking as of 2026-05-01); the column→field mapping transposes 1:1 onto a JSON object schema with no field renames.

**CSV header (exact, lowercased; column order strict).**

```
email,name,role,employee_id,department,team
```

| Column | Required | Type | Validation |
|---|---|---|---|
| `email` | yes | string | trimmed + lowercased before write (per § 10); RFC 5322 simple-regex shape |
| `name` | yes | string | non-empty after trim, max 200 chars |
| `role` | yes | enum | exactly one of `admin`, `reviewer`, `candidate` (lowercase) |
| `employee_id` | no | string | flows into `users.metadata.employee_id` |
| `department` | no | string | flows into `users.metadata.department` |
| `team` | no | string | flows into `users.metadata.team` |

Unknown columns are rejected (`UNKNOWN_COLUMN` row error — no silent ignore). UTF-8 only. CRLF or LF line endings. Embedded quotes per RFC 4180 (`""` escape).

**Limits.** Max 1000 rows per import (single-transaction memory ceiling, fits comfortably under `tools/migrate.ts` connection budget).

**Dedupe behavior on `(tenant_id, email)`.**

| Existing row state | Behavior |
|---|---|
| Active (`deleted_at IS NULL`, `status='active'`) | Row error `USER_EMAIL_EXISTS`; **not** updated |
| Soft-deleted (`deleted_at IS NOT NULL`) | Restored: `deleted_at = NULL`, `metadata` merged, `role` updated; returned in `updated[]` |
| Pending (`status='pending'`, `deleted_at IS NULL`) | `metadata` merged, `role` updated; returned in `updated[]` |
| Disabled (`status='disabled'`, `deleted_at IS NULL`) | Row error `USER_DISABLED`; **not** auto-reactivated |
| Not present | Created as `pending`; returned in `created[]`. **No invitation email is sent by `bulkImport`** — admin follows up via `POST /admin/invitations` (or a Phase-1 `?invite=true` flag) |

**`ImportReport` shape.**

```ts
type ImportReport = {
  totalRows: number;            // excludes header
  succeeded: number;
  failed: number;
  created: User[];              // newly inserted, status='pending'
  updated: User[];              // restored or merged
  errors: Array<{
    row: number;                // 1-indexed, header is row 1
    email: string | null;       // null when the row had no parseable email
    code:
      | 'INVALID_EMAIL'
      | 'INVALID_ROLE'
      | 'USER_EMAIL_EXISTS'
      | 'USER_DISABLED'
      | 'MISSING_REQUIRED'
      | 'NAME_TOO_LONG'
      | 'UNKNOWN_COLUMN'
      | 'TOO_MANY_ROWS';
    message: string;
  }>;
};
```

The transaction is **atomic only at the row level** — rows succeed or fail independently. A 1000-row import with 3 invalid rows produces 997 successes + 3 errors; it does not roll back the 997.

**Source.** SKILL public surface line 33; `PLAN` G0.C-5 line 282; `PHASE-1-PLAN` decision #4 (still user-blocking).

**Rationale.** Pinning the CSV contract now means Phase 1 implementation is type-driven (Zod parses the row → `User` insert). Per-row error reporting beats all-or-nothing because in HR-data imports the typical error is "one bad email in 200 good rows" — atomic rollback would force admins to fix and re-upload the whole file. 1000-row cap matches "a quarterly cohort import" without forcing pagination.

**Considered & rejected.** (a) **JSON file format** — `PHASE-1-PLAN` default; better wire-type-safety but the SKILL surface is `bulkImport(csv: Buffer)` and HR systems export CSV natively. Phase 1 may pivot per decision #4; Window 5 ships only a stub so the choice doesn't bind Window 5. (b) **All-or-nothing transaction** — worse UX as noted. (c) **Auto-invite on import** — defaulting `invite=true` would surprise admins doing dry-run imports. (d) **Auto-reactivate disabled users** — could mass-restore users an admin already explicitly disabled.

**Downstream impact.** Window 5: Phase-0 stub only; route returns 501 with no body parsing. Phase 1 implementation lands in `modules/03-users/src/import.ts` with Zod schema + per-row try/catch. If `PHASE-1-PLAN` decision #4 resolves to JSON, the type definitions in this section transpose 1:1.

### 2. Invitation token shape & email dispatch

**Decision.**

- **Token generation:** `crypto.randomBytes(32).toString('base64url')` → 43-character URL-safe string. Same primitive as 01-auth assessment magic-link tokens (`01-AUTH-DEC` § 8), but written to a different table with a different TTL.
- **Storage:** `user_invitations.token_hash = sha256(token).hex` (`02-DATA:149`). Plaintext token is **never persisted** in DB.
- **TTL:** 7 days from creation (`expires_at = now() + interval '7 days'`). Distinct from candidate magic-link TTL (72h per `04-AUTH:151`) — admin/reviewer onboarding is asynchronous and tolerates longer windows; candidate magic-links sit in tighter assessment windows.
- **Single-use:** consumed via atomic `UPDATE user_invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL RETURNING id`. Zero-row UPDATE → `ConflictError` code `"INVITATION_ALREADY_USED"` (HTTP 409). Expired (token row exists but `expires_at < now() AND accepted_at IS NULL`) → `ConflictError` code `"INVITATION_EXPIRED"` (HTTP 409). Token-hash miss → `NotFoundError` code `"INVITATION_NOT_FOUND"` (HTTP 404).
- **Email dispatch.** `inviteUser()` calls **13-notifications stub directly** — does NOT return the plaintext token to the caller. `inviteUser()` returns `{ user: User; invitation: { id, email, role, expires_at } }` — note **no `token` field**. The plaintext token flows only through (a) the email body, (b) the dev-emails JSONL log in Phase 0 (per § 8), (c) SMTP delivery in Phase 3 onward.

**Source.** SKILL public surface line 31 (`inviteUser`); `02-DATA:144–154` (`user_invitations` schema); `01-AUTH-DEC` § 8 (token primitive); `PLAN` G0.C-5 line 284 (13-notifications stub); user pin 2026-05-01 (TTL 7d for `user_invitations`).

**Rationale.** Not returning plaintext to the caller closes a leak vector: admin UI logs, browser dev-tools, audit-trail breadcrumbs, customer-support session recordings would all otherwise capture a single-use bearer credential. Email-only flow is the same posture banks use for password reset. 7-day TTL is the standard professional onboarding window — balances "admin invited me but I was on PTO" with "a stale invitation lying around for a month is a security smell."

**Considered & rejected.** (a) **Return token to caller** — admin UI could show a "copy invite link" button; convenient but bleeds plaintext into too many systems. Phase 2 may add an explicit "regenerate + show once" admin action (mirrors API-key rotation UX). (b) **TTL 24h** — too tight for PTO/holidays. (c) **TTL 30d** — too long; idle bearer credential. (d) **Two tokens (low-entropy display + hashed check)** — adds complexity without solving the leak.

**Downstream impact.** Window 5: 13-notifications stub at `modules/13-notifications/src/email-stub.ts` (see § 8). Phase 3 SMTP wiring keeps `inviteUser()` signature unchanged; only the stub adapter swaps. Admins recovering a lost invitation use a future Phase-1 "resend" endpoint that issues a fresh token + new email and lets the old `token_hash` expire naturally (TTL eviction is fine; explicit revocation deferred).

### 3. `createUser` vs `inviteUser` — distinction

**Decision.** Two distinct entry points with non-overlapping use cases:

| Function | Endpoint | Sends email? | Creates `user_invitations` row? | Resulting `users.status` |
|---|---|---|---|---|
| `createUser({ email, name, role, metadata })` | `POST /admin/users` | **No** | No | `pending` |
| `inviteUser({ email, role, assessmentIds? })` | `POST /admin/invitations` | **Yes** | Yes | `pending` (or unchanged if user already active) |

`createUser` is for system imports / programmatic provisioning (and the current `bulkImport` stub); `inviteUser` is the admin-UI happy-path that creates+invites in one shot.

**Re-invite semantics.** If `inviteUser` is called with an email that maps to an existing **active** user, the existing user is returned with `invitation = null` and no email is sent. If the existing user is **pending** (already invited but not yet accepted), the existing pending invitation row is **replaced** in a transaction (old `token_hash` deleted, fresh row inserted, fresh email sent); the old token immediately stops working. If the existing user is **disabled** → `ConflictError` code `"USER_DISABLED"` (HTTP 409); admin must re-enable first. If **soft-deleted** → `ConflictError` code `"USER_DELETED"` (HTTP 409); admin must `restore` first.

**Source.** `03-API:43–48` (separate `POST /admin/users` and `POST /admin/invitations`); SKILL public surface lines 26 + 31.

**Rationale.** Two-endpoint design avoids overloading `POST /admin/users` with a `?invite=true` flag — easier to reason about side effects in audit logs and easier to authorize differently if needed. Re-invite-replaces-invitation is the "fix the bad-email typo" path: the old invitation must die or it becomes a parallel valid path with the wrong email shown.

**Considered & rejected.** (a) **Single endpoint with flag** — works, but two flags in one mutation (`invite=true`, `assessmentIds=[…]`) bloat the payload and bury the side effect. (b) **`inviteUser` always creates a new user** — would create duplicate (tenant, email) collisions on re-invite. (c) **`createUser` defaults `status='active'`** — would let admins side-step the invitation flow and skip MFA enrollment. (d) **Auto-restore-on-invite** — would bypass the explicit admin restore step.

**Downstream impact.** Phase 1 admin-dashboard UI surfaces one "Invite user" button (the happy path). `createUser` is back-end-only / used by import. SCIM provisioning in Phase 3 will call `createUser`.

### 4. Last-admin invariant

**Decision.** Every tenant must always have ≥1 user satisfying `role = 'admin' AND status = 'active' AND deleted_at IS NULL`. Enforced by a single `assertNotLastAdmin(userId, mutationKind)` helper in `modules/03-users/src/invariants.ts`, called at three sites:

1. `softDelete(id)` — checks before flipping `deleted_at` when the target user is currently an active admin.
2. `updateUser(id, patch)` — checks when `patch.role` transitions away from `'admin'` OR `patch.status` transitions to `'disabled'` AND the target is currently an active admin.
3. `02-tenancy.suspendTenant` — out of 03-users scope, but flagged here as a cross-module concern: suspending the only-admin tenant makes the tenant unrecoverable. Window 5 does NOT modify 02-tenancy; this row only documents the boundary so a future 02-tenancy revision picks it up.

The check runs **inside** the same database transaction as the mutation. RLS already scopes to the current tenant, so the count is tenant-local without an explicit `WHERE tenant_id`:

```sql
SELECT count(*) FROM users
 WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL
   AND id <> $targetUserId
FOR NO KEY UPDATE;
```

If the count is 0 → throw. The `FOR NO KEY UPDATE` lock-hint blocks concurrent demotions of the other admins for the duration of the transaction.

**Error contract.** `ConflictError` from `00-core`:

```ts
new ConflictError({
  code: 'LAST_ADMIN',
  message: 'Cannot remove or disable the last active admin in this tenant. Promote another user to admin first.',
  details: { mutationKind: 'softDelete' | 'roleChange' | 'statusChange', userId },
});
```

HTTP status: **409 Conflict** (per `00-core` `ConflictError.httpStatus`).

**Source.** `PLAN` G0.C-5 anti-pattern guard line 309; user pin 2026-05-01.

**Rationale.** Single helper at three call sites is easy to test in isolation and gives one consistent error message. Running inside the mutation transaction with `FOR NO KEY UPDATE` prevents the TOCTOU race where two admins simultaneously self-demote and end up with zero admins. `ConflictError` over `ValidationError` because the request itself is well-formed; the conflict is with current state.

**Considered & rejected.** (a) **DB CHECK constraint** — Postgres CHECK can't reference aggregate state. (b) **Trigger-based enforcement** — works but hides the rule from app code, making friendly error messaging harder. (c) **Promote-then-demote workflow** — would force admins through an extra step; the invariant still needs to hold mid-step. (d) **No-self-demote** — too restrictive; legitimate workflow is "I'm leaving, demote me to reviewer."

**Downstream impact.** Phase 1 admin-dashboard surfaces the violation as an inline form error on the user-edit page; Phase 1 Playwright E2E must include "demote-the-last-admin" as a critical-path case. The check does NOT special-case the bootstrap admin — they are just the first admin row from the DB's perspective.

### 5. Soft-delete cascade defaults

**Decision.** `softDelete(id)` flips `users.deleted_at = now()`; **nothing is hard-deleted**. Side effects:

| Related entity | Behavior on soft-delete |
|---|---|
| Open assessment `attempts` (Phase 1) | **Orphaned and preserved.** Joins to `users` continue to resolve; admin UI shows `user.deleted_at` next to the candidate name. The deleted user **cannot** resume an in-progress attempt (sessions invalidated per § 7). Admin can release/score the attempt as long as a grader is assigned. |
| Pending invitations they **sent** (`user_invitations.invited_by = id`) | **Stay valid.** Invitation belongs to the tenant, not the inviter; `invited_by` is provenance only. |
| Pending invitations **for** them (`user_invitations.email = user.email AND accepted_at IS NULL`) | **Hard-deleted in the same transaction.** The SKILL has no `revokeInvitation` surface to mark them; DELETE is the simplest correct behavior. |
| `audit_log` entries naming them (`actor_user_id = id`) | **Immutable.** Per CLAUDE.md load-bearing rule on `modules/14-audit-log/**` (append-only). FK keeps pointing; admin-UI dereferences with `user.deleted_at` shown as `(deleted)` badge. |
| `oauth_identities`, `user_credentials`, `totp_recovery_codes` | **Preserved.** ON DELETE CASCADE on the FK fires only on hard delete. Soft-delete leaves them so `restore(id)` produces a working login without re-enrollment. |
| Active `sessions` (Postgres + Redis) | **Swept** per § 7 mechanism (Redis sweep on disable/delete, more aggressive than reject-on-next-request). |

`restore(id)` reverses: clears `deleted_at`. Does **not** resurrect deleted `user_invitations` rows (admin re-invites if needed). Does **not** restore Postgres `sessions` rows (user logs in fresh). Auth credentials are intact, so the restored user logs in with their existing TOTP enrollment.

**Source.** SKILL public surface lines 28–29; `02-DATA:96–108` + `02-DATA:117, 124, 137` (CASCADE FKs); CLAUDE.md load-bearing rule on `14-audit-log/**`.

**Rationale.** Preserving auth credentials makes restore a one-click admin action, not a re-enrollment hassle. Audit-log immutability is non-negotiable per HR-grade requirement. Orphaning attempts (rather than cascade-deleting) preserves grading data and dispute-resolution evidence — a candidate-soft-deleted-mid-cohort scenario must not lose the cohort's data integrity.

**Considered & rejected.** (a) **Cascade soft-delete to attempts** — would lose data and break audit. (b) **Cascade soft-delete to invitations they sent** — irrelevant: invitations are tenant-owned, not inviter-owned. (c) **Hard-delete on softDelete if no children exist** — mixing soft/hard delete in one API is a foot-gun. (d) **Mark `user_invitations.email = user.email` rows as `revoked` instead of DELETE** — would require a `status` column on `user_invitations` that the existing schema doesn't have; DELETE is consistent with the schema-as-shipped.

**Downstream impact.** Phase 1 attempt-engine queries must `LEFT JOIN users` (not `INNER JOIN`) and surface `deleted_at` to the admin UI. Phase 3 audit-log UI must handle deleted-actor display. Window 5 itself only ships the user-side `softDelete`/`restore` mutations + the invitation-DELETE side effect; the cascade behaviors on attempts and audit-log are documented expectations for the modules that own those tables.

### 6. Role transitions

**Decision.**

- **Authority.** Only `role = 'admin'` users can change another user's role (enforced by `requireRole('admin')` on `PATCH /admin/users/:id`). Reviewer self-promotion: blocked by route auth before reaching the service. The service-layer additionally re-asserts `req.session.role === 'admin'` (defense in depth).
- **Allowed transitions.** Any role → any role (admin ↔ reviewer ↔ candidate). No state-machine restriction beyond the last-admin invariant (§ 4) and the user-status state machine (§ 7).
- **Self-mutation rules.**
  - An admin **may** demote themselves only if another active admin remains (last-admin invariant blocks otherwise).
  - An admin **may not** promote themselves — the route requires admin role to call, but the service-layer rejects PATCH-self with `role` in the patch unless the new role is "lower" than admin (i.e., demote-self is allowed; promote-self is not, even though structurally the caller already has admin).
  - The "bootstrap admin" is not a special status — they are just the first admin row inserted. The last-admin invariant protects them by virtue of being the only admin until a second is invited.
- **Audit.** Every role change emits `users.role.changed` with `actor_user_id`, `entity_id`, `before.role`, `after.role` — currently routed through the 14-audit-log stub (`// TODO(audit)` pattern from G0.B-2), wired to real writes in Phase 3.
- **Step-up MFA.** `04-AUTH:289` requires re-auth on role change. `PATCH /admin/users/:id` with `role` in the patch hits `requireFreshMfa(15)` decorator from 01-auth Window 4. If the caller's `last_totp_at < now - 15min` → 403 `mfa_required`; UI shows the TOTP modal then retries.

**Source.** `03-API:45`; `04-AUTH:121–129` + `:289`; SKILL public surface line 27.

**Rationale.** Free-form transitions match the actual operational pattern: a candidate gets promoted to reviewer after passing an internal exam; a reviewer leaves and is demoted to candidate to keep historical data intact. Restricting transitions adds complexity without preventing real bad-state cases (the only real bad state is "no admin," which the last-admin invariant catches).

**Considered & rejected.** (a) **Explicit state-machine of role transitions** — over-engineered for three roles with no business-logic state coupling. (b) **Disallow demoting bootstrap admin specifically** — special-casing the bootstrap admin requires marking which row is "bootstrap," which adds schema and logic; the last-admin invariant achieves the same protection without the special case. (c) **Self-promotion via second-admin approval flow** — Phase 3 capability if needed; not a Phase 0 concern.

**Downstream impact.** Phase 1 admin-dashboard surfaces a confirmation modal before role demotion. The `requireFreshMfa(15)` decorator must be exported by 01-auth Window 4 — the contract is already in `01-AUTH-DEC` § 1 (sessions schema includes `lastTotpAt`).

### 7. User status state machine + Redis sweep on disable/delete

**Decision.**

**Allowed status transitions.**

| From → To | Allowed? | Trigger |
|---|---|---|
| `pending` → `active` | yes | `acceptInvitation(token)` only |
| `pending` → `disabled` | yes | admin revoke-before-accept via `PATCH /admin/users/:id { status: 'disabled' }` |
| `active` → `disabled` | yes | admin toggle |
| `disabled` → `active` | yes | admin re-enable toggle |
| `disabled` → `pending` | **no** | not reachable — admin must re-invite from scratch |
| `active` → `pending` | **no** | not reachable — invitation is one-shot |

Enforced by `assertValidStatusTransition(from, to)` in `modules/03-users/src/invariants.ts`; throws `ValidationError` with code `"INVALID_STATUS_TRANSITION"`, HTTP 422.

**`disabled` user behavior.**
- Cannot log in: 01-auth sessionLoader (Window 4) rejects with `403 user_disabled` if it ever finds a session whose user has `status='disabled'`.
- Existing sessions invalidated immediately via the **Redis sweep** below.

**`pending` user behavior.**
- Cannot log in: Google SSO callback in 01-auth Window 4 returns 403 if `users.status != 'active'`. Magic-link / direct-credential paths similarly check.
- `acceptInvitation` is the only path to `active`.

**Redis sweep on disable / soft-delete (cross-module dep on 01-auth Window 4).**

03-users actively sweeps Redis on disable / soft-delete (the user pinned "Redis sweep on disable, more aggressive" over the cheaper reject-on-next-request tombstone alternative). The sweep relies on a per-user session index that 01-auth populates on every `sessions.create`:

| Trigger | Action |
|---|---|
| `updateUser({status: 'disabled'})` | `SMEMBERS aiq:user:sessions:<userId>` → `DEL` each member key (idempotent — missing keys are no-op for already-evicted sessions); `DEL aiq:user:sessions:<userId>`; Postgres `UPDATE sessions SET expires_at = now() WHERE user_id = $1`. |
| `softDelete(id)` | Same as above. |
| `updateUser({status: 'active'})` (re-enable) | No Redis action needed — the SET was already DEL'd; user logs in fresh and a new SET is created on next `sessions.create`. |
| `restore(id)` | Same — no Redis action. |

**01-auth carry-forward (Window 4 must add to `sessions.create`).** After the existing `SET aiq:sess:<sha256> <json> EX 28800` (per `01-AUTH-DEC` § 1), `sessions.create` ALSO runs `SADD aiq:user:sessions:<userId> aiq:sess:<sha256>` followed by `EXPIRE aiq:user:sessions:<userId> 32400` (re-armed each login; gives a 9h hard ceiling so abandoned sets cannot accumulate forever). `sessions.destroy` does **not** SREM — lazy-GC on the sweep-side is sufficient (see below).

**Lazy GC.** No active SREM on session destroy or natural Redis TTL expiry. Stale entries in the per-user SET don't affect correctness — the disable sweep does idempotent `DEL` on each member; missing keys are no-op. At login rates of ≤dozens per year per user, the SET stays bounded; the 9h `EXPIRE` re-arm caps abandoned-session-list growth in pathological cases.

**Source.** `02-DATA:102` (status enum); `04-AUTH:288` (force re-auth on status changes implied); user pin 2026-05-01 ("Redis sweep on disable, more aggressive"); `01-AUTH-DEC` § 1 (sessions Redis schema).

**Rationale.** Sweep-on-disable is faster to take effect than reject-on-next-request (a stolen-session attacker hitting a long-poll endpoint would otherwise hold the session until they trip a `requireAuth`). Per-user index over `SCAN aiq:sess:*` because SCAN is O(M total sessions per disable), pathological at scale. Lazy GC on session-destroy avoids serializing the destroy hot path. The 9h `EXPIRE` re-arm bounds the worst-case stale-entry count.

**Considered & rejected.** (a) **Tombstone (reject-on-next-request via `EXISTS aiq:user:disabled:<userId>` in sessionLoader)** — cheaper per request (one extra EXISTS) but doesn't immediately invalidate held connections; user explicitly preferred sweep. (b) **`SCAN aiq:sess:* MATCH …`** — O(M) per disable; pathological. (c) **Pub/sub session-eviction events** — over-engineered for Phase 0. (d) **Active SREM on session destroy** — adds work to a hot path with no correctness benefit since the SET self-bounds via `EXPIRE`.

**Downstream impact.** Window 4 (01-auth) must add `SADD aiq:user:sessions:<userId> …` + `EXPIRE 32400` to `sessions.create`. Add this as a sub-bullet to `01-auth/SKILL.md` § Decisions captured § 1 when Window 4 opens. Window 5 calls into a small `swepUserSessions(userId)` helper that lives in 03-users (it talks to Redis directly via `00-core` connection pool — no 01-auth import, just shared Redis primitives).

### 8. Email stub format (Phase 0 dev — `13-notifications/src/email-stub.ts`)

**Decision.** Phase 0 ships a minimal stub at `modules/13-notifications/src/email-stub.ts` that satisfies `inviteUser()`'s email dependency without an SMTP server. The stub:

1. Logs each "sent" email to console at `INFO` via `00-core` logger (`createLogger('email-stub')`).
2. Appends one JSONL record per email to a log file:
   - On VPS (`NODE_ENV='production'` AND `ASSESSIQ_DEV_EMAILS_LOG` unset): `/var/log/assessiq/dev-emails.log`. Directory created in the Phase-0 deploy step with `chmod 0750`, owned by the `assessiq` service user.
   - In local dev: `$ASSESSIQ_DEV_EMAILS_LOG` if set; else `~/.assessiq/dev-emails.log`. The `~` expands at runtime; directory auto-created on first write.
3. Returns synchronously; no async queue.

**JSONL field shape.** Each line is one well-formed JSON object — exact field set, no additions:

```ts
type DevEmail = {
  ts: string;          // ISO 8601 UTC, e.g. '2026-05-01T08:30:14.421Z'
  to: string;          // recipient email
  subject: string;
  body: string;        // plaintext for stub; rendered HTML in Phase 3
  template_id: string; // 'invitation.user' | 'invitation.assessment' | 'totp.recovery_codes' | … (catalog grows as features land)
};
```

The plaintext invitation token appears **inside `body`** as part of the user-clickable link. No structured-token field; matches eventual SMTP semantics where the token IS part of the email content.

**Rotation.** **None in Phase 0.** The file grows indefinitely; in dev this is fine. Phase 3 SMTP wiring deletes the stub adapter; no in-place rotation policy ever ships. If the file gets unwieldy in long-running dev sessions, the developer truncates manually.

**Source.** `PLAN` G0.C-5 line 284; user pin 2026-05-01 (field shape exact).

**Rationale.** JSONL (one JSON object per line) is the cheapest format that supports `tail -f | jq` and post-hoc grep without a parser. Synchronous append is fine at Phase-0 stub volume (≤dozens of emails/day in dev); async queue would complicate the stub for no benefit. Plaintext-token-in-body matches eventual SMTP — placing it in a sibling structured field would imply structured retrieval that Phase 0 doesn't need.

**Considered & rejected.** (a) **Plaintext log lines** — harder to grep on field, harder to migrate to structured logging. (b) **CSV log** — quoting hell with email bodies. (c) **Daily log rotation** — adds cron/state for a stub that disappears in Phase 3. (d) **`metadata` sibling field** carrying tenant_id/invitation_id/expires_at — not in the user-pinned shape; if Phase 1 needs it, add then.

**Downstream impact.** Phase 3 SMTP wiring lands `modules/13-notifications/src/smtp.ts` with the same `EmailAdapter` interface; the stub is removed. Until then, `inviteUser` developers retrieve invitation tokens from the JSONL log during local testing.

### 9. `listUsers` query semantics

**Decision.**

```ts
listUsers({
  role?: 'admin' | 'reviewer' | 'candidate',
  status?: 'active' | 'disabled' | 'pending',
  search?: string,            // case-insensitive prefix on name+email
  includeDeleted?: boolean,   // default false
  page?: number,              // default 1, 1-indexed
  pageSize?: number,          // default 20, max 100
}): Promise<{ items: User[]; page: number; pageSize: number; total: number }>
```

- **Search semantics.** Case-insensitive prefix match on `name` OR `email`:
  ```sql
  WHERE (lower(name)  LIKE lower($search) || '%'
      OR lower(email) LIKE lower($search) || '%')
  ```
  Substring search deferred — bloats query plans without UX gain at small N.
- **Default sort.** `created_at DESC, id DESC` (the second key gives stable ordering when timestamps tie, e.g., bulk import from a single batch).
- **Pagination.** Offset-based: `OFFSET (page - 1) * pageSize LIMIT pageSize`. **Cursor-based deferred to Phase 2** when user counts grow past offset-pagination's comfort zone (~10k rows).
- **`pageSize` cap.** Default 20, max 100. **Stricter** than `03-API:10`'s global cap of 200; the per-endpoint override is intentional for HR-grade PII data — bulk-export goes through the dedicated CSV-export endpoint (Phase 3).
- **`total`.** Computed via separate `SELECT count(*)` against the same WHERE clause in the same transaction. Acceptable cost at expected user-table size (≤10k per tenant).
- **`includeDeleted=false` (default).** Adds `deleted_at IS NULL` to the WHERE clause. `includeDeleted=true` removes the filter; UI surfaces `deleted_at` per row.

**Cursor-based upgrade path (Phase 2 sketch).** Replace `page` with `cursor` (opaque base64 of `{lastCreatedAt, lastId}`). Old offset-paginated calls return a `Deprecation:` header for one Phase-2 release; UI migrates within the deprecation window. No DB changes required.

**Source.** SKILL public surface line 24; `03-API:10` (global pagination convention; this endpoint overrides max).

**Rationale.** Prefix search hits a small `lower(email) text_pattern_ops` index (Window 5 migration adds it) reasonably well. Offset pagination is fine at <10k rows; cursor is a Phase-2 problem. PageSize cap of 100 (not 200) reflects HR-data sensitivity; mass pulls indicate misuse and should hit a hard ceiling.

**Considered & rejected.** (a) **Cursor pagination from day one** — adds opaque-cursor encoding + tie-breaker logic for no Phase-0 benefit. (b) **Substring `ILIKE '%' || $search || '%'`** — defeats the prefix index, scales linearly. (c) **Postgres full-text search** — overkill for Phase 0. (d) **PageSize cap = global 200** — too generous for PII.

**Downstream impact.** Window 5 migration `020_users.sql` adds `CREATE INDEX users_email_lower_idx ON users (tenant_id, lower(email) text_pattern_ops) WHERE deleted_at IS NULL;` for the prefix-search hot path. Phase 1 admin-dashboard binds the search box's debounce to ≥300ms to avoid hammering the DB on each keystroke.

### 10. Per-tenant email uniqueness

**Decision.**

- **DB constraint:** `UNIQUE (tenant_id, email)` (already in `02-DATA:107`). No schema change.
- **Case handling: lowercase at write.** All write paths (`createUser`, `updateUser`, `inviteUser`, `bulkImport`, `acceptInvitation` if email is in patch) call `normalizeEmail(email) = email.trim().toLowerCase()` before the DB write. Centralized in `modules/03-users/src/normalize.ts`.
- **No `citext` extension.** The data-model's only Postgres extension is `pgcrypto` (per `02-DATA:60–69` § uuidv7-vs-gen_random_uuid). Adding `citext` here would expand the extension surface for a one-table convenience.
- **Error contract on collision.** `ConflictError` from `00-core`:
  ```ts
  new ConflictError({
    code: 'USER_EMAIL_EXISTS',
    message: 'A user with this email already exists in this tenant.',
    details: { email },
  });
  ```
  HTTP status: **409 Conflict**.
- **Cross-tenant collisions are allowed.** `manish@x.com` can exist as a user in tenant A and tenant B independently — different tenants are different identity scopes.

**Source.** `02-DATA:107`; SKILL public surface line 26; user pin 2026-05-01.

**Rationale.** App-side lowercase is one extra line per write site (centralized via `normalizeEmail`) and avoids an extension dependency. The DB-level `UNIQUE (tenant_id, email)` then gives bulletproof enforcement against races: two concurrent `createUser` for the same email lose one to a `unique_violation` Postgres error, which the repo translates to `ConflictError`. `ConflictError` over `ValidationError` because the request itself is well-formed.

**Considered & rejected.** (a) **`citext` extension** — adds ops surface (extension upgrade path on Postgres major-version bumps). (b) **Functional UNIQUE index on `lower(email)`** — works but pessimizes plain-equality joins because the column itself isn't lowercased. (c) **App-only check (`SELECT … WHERE`) with no DB UNIQUE** — race condition; rejected immediately. (d) **Strip `+suffix` aliases (gmail-style) before hashing** — surprising behavior; explicitly NOT done. (e) **Reject mixed-case emails outright** — surprising for users typing their own email naturally.

**Downstream impact.** Window 5: `normalizeEmail()` lives in `modules/03-users/src/normalize.ts`. **Carry-forward to 01-auth Window 4:** Google SSO callback also runs `normalizeEmail()` on the IdP-supplied email before the `(tenant_id, email)` lookup; this guarantees the lookup matches the lowercase-at-write convention. Magic-link / future password paths likewise.

### 11. RLS-only scoping (CLAUDE.md hard rule #4 reaffirmation)

**Decision.** Every query in `modules/03-users/src/repository.ts` runs through the connection that has `SET LOCAL app.current_tenant = <tenant>` already set by `02-tenancy.tenantContextMiddleware`. Repositories MUST NOT include `WHERE tenant_id = $1` clauses — RLS is the enforcement layer; double-filtering hides RLS bugs and was the deliberate decision in `02-tenancy` Session 2 (committed in observation 124, 2026-05-01: `repository.ts` refactored to omit WHERE tenant_id filters on `tenant_settings` — intentional RLS-only scoping pattern).

**The only exception:** the bootstrap-admin INSERT in seed/migration code, which runs as the `assessiq_system` Postgres role (BYPASSRLS) and provides `tenant_id` explicitly. Phase-0 seed scripts (`tools/seed-bootstrap-admin.ts` if Window 5 ships one) are the only allowed users of this role.

**Source.** CLAUDE.md hard rule #4; `02-tenancy/SKILL.md` § Status (RLS-only scoping pattern); `02-DATA:565–581`.

**Rationale.** Defense-in-depth: RLS catches the bug where the app forgets `WHERE tenant_id`. Double-filtering masks RLS misconfiguration during development — the test passes because the WHERE clause matches; RLS never gets exercised. Phase 3 critique bounces any diff that violates this.

**Considered & rejected.** (a) **Belt-and-braces with both** — see above. (b) **RLS off + app-side only** — single point of failure. (c) **Session-var-or-WHERE depending on path** — too easy to slip into the wrong branch.

**Downstream impact.** `tools/lint-rls-policies.ts` (Phase 0 G0.A) is the structural enforcer for migrations. Code-review (Phase 3 critique) is the manual-discipline backup for repository code. Window 5's repository unit tests spin up a testcontainer Postgres (per the 02-tenancy pattern, observation 115) and assert cross-tenant isolation by setting `app.current_tenant` to tenant A and verifying a user inserted under tenant B is invisible.

### 12. `acceptInvitation` cross-module boundary (mirrors `01-AUTH-DEC` § 10)

**Decision.** `03-users.acceptInvitation(token)` is the only Phase-0 cross-module write coupling. **03-users orchestrates; 01-auth provides the `sessions.create` primitive.** Mirror of `01-AUTH-DEC` § 10:

```ts
// modules/03-users/src/invitations.ts
import { sessions } from '@assessiq/auth';                  // 01-auth public surface
import { ConflictError, NotFoundError, getRequestContext } from '@assessiq/core';

export async function acceptInvitation(
  token: string
): Promise<{ user: User; sessionToken: string }> {
  // 1. sha256(token) → lookup user_invitations.token_hash.
  //    Miss → NotFoundError 'INVITATION_NOT_FOUND' (404).
  //    Found but expires_at < now() AND accepted_at IS NULL
  //      → ConflictError 'INVITATION_EXPIRED' (409).
  //
  // 2. Atomic UPDATE … SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL RETURNING id.
  //    Zero-row → ConflictError 'INVITATION_ALREADY_USED' (409).
  //
  // 3. Resolve user: SELECT or INSERT into users (tenant_id, email, name, role,
  //    status='pending'). Email is normalizeEmail()'d. On INSERT: status flips
  //    to 'active' below; on existing-pending SELECT: UPDATE status to 'active'
  //    (idempotent). Existing-active is a no-op; existing-disabled or soft-deleted
  //    rejects with ConflictError before this line.
  //
  // 4. Mint session via 01-auth (no higher-level helper exists):
  const { token: sessionToken } = await sessions.create({
    userId: user.id,
    tenantId: user.tenant_id,
    role: user.role,
    totpVerified: false,    // admin/reviewer must enroll TOTP on first login
    ip: getRequestContext().ip,
    ua: getRequestContext().ua,
  });
  return { user, sessionToken };
}
```

`totpVerified: false` for admin/reviewer invitations forces enrollment on first login. The candidate magic-link path (assessment_invitations, Phase 1) mints sessions with `totpVerified: true` per `01-AUTH-DEC` § 8 — that does not apply here.

**Source.** SKILL public surface line 32; `01-AUTH-DEC` § 10 (boundary contract); `PLAN` G0.C-5 line 283.

**Rationale.** Mirroring 01-auth § 10 keeps the two pre-flights consistent. 03-users-orchestrates means 03-users owns the user-status transition (its domain) and consumes 01-auth as a single-purpose primitive provider. The reverse direction (`01-auth.acceptInvitation`) would invert the dependency graph (01 must not depend on 03; both depend on 00).

**Considered & rejected.** (a) **`01-auth.acceptInvitation()` helper** — see above (graph inversion). (b) **Pure event-driven** (03-users emits `user.invited.accepted`, 01-auth consumes) — over-engineered for one synchronous flow. (c) **`totpVerified: true` for invited admins** — would let them skip MFA enrollment on first login; security-rejected.

**Downstream impact.** Window 5 implements this. Window 4 (01-auth) ships `sessions.create` per `01-AUTH-DEC` § 10. The `@assessiq/auth` package import path matches the workspace package mapping established in Window 4's bootstrap (Window 4 must publish a `package.json` with that name).

### 13. `inviteUser` candidate-role scope (Phase 1 punt)

**Decision.** Window 5's `inviteUser({ email, role, assessmentIds? })` ships the admin/reviewer paths only:

| `role` argument | Phase 0 behavior |
|---|---|
| `'admin'` | Standard flow: creates `user_invitations` row + sends email with `/admin/invite/accept?token=…` link. |
| `'reviewer'` | Same as admin (same template, different copy). |
| `'candidate'` | Throws `NotImplementedError` code `"CANDIDATE_INVITATION_PHASE_1"` (HTTP 501). |
| `assessmentIds?` non-empty (any role) | Throws `NotImplementedError` code `"ASSESSMENT_INVITATION_PHASE_1"` (HTTP 501). |

Candidate onboarding in Phase 0 is two-step (admin discipline, no enforcement): (a) admin uses `createUser({ role: 'candidate' })` to create a `pending` candidate row, no email; (b) Phase 1's `POST /admin/assessments/:id/invite` (in 05-assessment-lifecycle) creates `assessment_invitations` rows + sends magic-link emails per `04-AUTH:144–166` Mode B. The two-step is documentation-only in Phase 0 because step (b) lands in Phase 1.

**Source.** SKILL public surface line 31 (`inviteUser({ email, role, assessmentIds? })`); `02-DATA:144–154` (`user_invitations`) vs `02-DATA:362–375` (`assessment_invitations`); `04-AUTH:135–166` (Mode B → `assessment_invitations`); `PLAN` Phase-1 module 05-assessment-lifecycle scope.

**Rationale.** Two-table separation matches the "who you are" vs "what you're invited to" boundary: `user_invitations` is identity-grant; `assessment_invitations` is task-grant. Conflating them in `inviteUser` would force Phase 0 to ship `assessment_invitations` semantics it can't yet honor (the assessment doesn't exist as an entity until Phase 1).

**Considered & rejected.** (a) **Single invitation table** — would force a status-flag union that's hard to query and audit. (b) **`inviteUser` creates only `user_invitations` and silently ignores `assessmentIds`** — silent data loss is worse than throwing. (c) **`inviteUser` creates `assessment_invitations` directly when `role='candidate'`** — cross-module coupling into 05-assessment-lifecycle which doesn't exist yet.

**Downstream impact.** Window 5 path-tests admin and reviewer roles only; the candidate-role path test asserts the 501. Phase 1's 05-assessment-lifecycle ships `inviteCandidatesToAssessment(assessmentId, userIds)` which creates `assessment_invitations` rows and sends magic-link emails. At that point, `inviteUser` may be extended to call into 05's API, or remain admin/reviewer-only depending on UX preference (decision deferred to Phase 1).

---

## Carry-forward to Window 4 (01-auth)

Three items pinned here that 01-auth Window 4 must absorb. The orchestrator should add a sub-bullet to `01-auth/SKILL.md` § Decisions captured § 1 (sessions schema) and § 8 (Google SSO callback) when Window 4 opens. None of them changes the `01-AUTH-DEC` pinned contract — all three are additions inside existing function bodies:

1. **`sessions.create` populates a per-user session index** (§ 7 above). After the existing `SET aiq:sess:<sha256> <json> EX 28800`, also run `SADD aiq:user:sessions:<userId> aiq:sess:<sha256>` followed by `EXPIRE aiq:user:sessions:<userId> 32400`. Required so that 03-users' sweep-on-disable / sweep-on-soft-delete can iterate an authoritative member list.

2. **sessionLoader rejects on `users.status != 'active'`** (§ 7 above). After the existing `aiq:sess:<sha256>` lookup succeeds, sessionLoader does a fast Postgres lookup (or a cached `aiq:user:status:<userId>` Redis key — implementation choice) and rejects with `403 user_disabled` / `403 user_deleted` if the user is no longer active. The Redis sweep above destroys most disabled-user sessions immediately, but this check is the belt for the suspenders (e.g., a session created milliseconds before disable, or a hash-collision corner case).

3. **`normalizeEmail()` in Google SSO callback** (§ 10 above). Before the `(tenant_id, email)` lookup against `users`, the IdP-supplied email runs through `normalizeEmail()` (`.trim().toLowerCase()`). Same rule for any future password / magic-link / OIDC paths that receive an external email.
