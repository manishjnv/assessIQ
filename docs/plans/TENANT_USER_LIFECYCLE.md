# Tenant & user lifecycle controls — implementation plan

**Owner**: super-admin offboarding/onboarding workstream
**Date opened**: 2026-05-20
**Status**: Phase A in progress
**Sessions estimated**: 3 (Phase A; B+C parallel; D+E together)

## Goal

Ship full lifecycle management at two grains:
- **Tenant lifecycle** (super-admin only): `active ⇄ suspended ⇄ archived → (purge after 6-month retention)`
- **User lifecycle** (tenant admin in-scope; super-admin override): `pending → active ⇄ disabled → soft-deleted → (purge after 6-month retention)`

Plus underpinnings to make non-active states safe by default: auth-chain block, write-block on existing super-admin endpoints, session revocation atomic with status flip, jargon-free user-facing messages, detailed activity logging for forensics.

## Architectural principles (frozen)

1. **Active is the only writable state.** Lifecycle transitions are the only mutations allowed otherwise.
2. **Lifecycle controls live on the entity they affect.** Tenant controls on tenant rows; user controls on user rows. Never overload — disabling the "first admin" does NOT cascade to the tenant.
3. **Session revocation is atomic with the lifecycle transition.** No "blocked but still has a valid cookie" window.
4. **One pre-auth message** for every failure (uniform timing + uniform body). State-aware messages only post-auth.
5. **Audit every transition** with its own catalog entry. Reasons captured but never shown to the affected user.
6. **Detailed activity logs** alongside structured audit rows: streamLogger JSONL at INFO for lifecycle events; WARN for super-admin overrides.
7. **Last-admin invariant** preserved at the tenant-admin path; super-admin has explicit override path with `is_override: true` audit flag.
8. **No hide-and-forget**: paused/archived/disabled entities stay visible to the right operator behind a "Show X" toggle (session-scoped, no localStorage).
9. **Symmetric vocabulary** at both grains (chips, error patterns, audit names) so operators learn it once.
10. **Two-step re-engagement**: unarchive first (lifecycle gesture), then configure (under normal active rules). No one-shot reactivate-with-config wizard.

## Decisions (locked in 2026-05-20)

| Decision | Value | Rationale |
|---|---|---|
| Soft-delete / archive retention before purge | 6 months | Operator preference; aligns with typical enterprise data-retention windows |
| Reason field on lifecycle actions | Optional everywhere | Lower friction; encouraged via UI placeholder text; audit captures when supplied |
| Mid-attempt candidate at tenant suspend | Hard cut (session revoked) | Autosave is last-write-wins; on resume, candidate continues from last save |
| "Show archived" / "Show disabled" toggles | Session-scoped (no localStorage) | Default-safe; operator opts in per session |
| Super-admin drill-down route | `/admin/platform/:tenantId/users` | Matches breadcrumb from Platform → tenant → users |
| Phase B vs Phase C ordering | Parallel after A; two Sonnet subagents | Saves cold-start cost vs sequential; non-overlapping files |
| Audit override flag | `is_override: true` in audit row jsonb | Queryable as security signal; super-admin override actions are filterable |

## Phase ordering + dependencies

```
                    ┌───────────────────────────────┐
                    │  Phase A — Foundation         │
                    │  • auth-chain tenant block    │
                    │  • write-block guard          │
                    │  • session revocation helpers │
                    │  • audit catalog              │
                    │  • detailed activity logging  │
                    └────────────┬──────────────────┘
                                 │
                  ┌──────────────┴────────────────┐
                  ▼                               ▼
   ┌────────────────────────┐      ┌──────────────────────────┐
   │ Phase B — Tenant       │      │ Phase C — User lifecycle │
   │ lifecycle              │      │ • disable/re-enable      │
   │ • suspend/resume       │      │ • cancel invite          │
   │ • archive/unarchive    │      │ • soft-delete/restore    │
   │ • Platform redesign    │      │ • Users-page UI          │
   └────────────┬───────────┘      └──────────────┬───────────┘
                │                                 │
                └──────────────┬──────────────────┘
                               ▼
            ┌────────────────────────────────────┐
            │ Phase D — Messaging + login UX     │
            └────────────────┬───────────────────┘
                             ▼
            ┌────────────────────────────────────┐
            │ Phase E — Docs + polish            │
            └────────────────────────────────────┘
```

---

## Phase A — Foundation

### Files touched

| File | Action | Why |
|---|---|---|
| `modules/14-audit-log/src/types.ts` | Extend ACTION_CATALOG | New lifecycle action names |
| `modules/02-tenancy/src/lifecycle.ts` | **NEW** | `assertTenantActive(tenantId)` helper |
| `modules/02-tenancy/src/index.ts` | Export | Public surface |
| `modules/03-users/src/lifecycle.ts` | **NEW** | `assertUserActive(userId, tenantId)` helper |
| `modules/03-users/src/index.ts` | Export | Public surface |
| `modules/01-auth/src/sessions.ts` | Add helper | `destroyAllForTenant(tenantId)` whole-tenant variant |
| `modules/01-auth/src/middleware/session-loader.ts` | Extend | Add `tenantIsActive` defense-in-depth check alongside `userIsActive` |
| `apps/api/src/routes/admin-super.ts` | Add guard | Call `assertTenantActive` at top of 5 existing write endpoints |
| `modules/01-auth/src/lifecycle-log.ts` | **NEW** | Structured streamLogger helper for lifecycle events (INFO + WARN-on-override) |

### Audit catalog additions

```ts
// Already in catalog from previous ships:
'tenant.archived', 'tenant.unarchived',

// New in Phase A:
'tenant.suspended', 'tenant.resumed',
'tenant.purged',                    // future scope; defined now for forward compat
'user.disabled', 'user.reenabled',
'user.invitation_cancelled',
'user.soft_deleted', 'user.restored',
```

### `assertTenantActive(tenantId)` contract

```
Input: tenantId: string
Side effects: none (read-only DB lookup under assessiq_system)
Throws:
  - NotFoundError { code: 'TENANT_NOT_FOUND' } if tenant doesn't exist
  - ConflictError { code: 'TENANT_NOT_ACTIVE', details: { status } } if status not in ('active', 'provisioning')
Returns: void on success
```

Provisioning is allowed for the createTenant orchestration window; everything else (suspended, archived) is blocked.

### `assertUserActive(userId, tenantId)` contract

```
Input: userId: string, tenantId: string
Side effects: none (read-only DB lookup under withTenant)
Throws:
  - NotFoundError { code: 'USER_NOT_FOUND' } if user doesn't exist
  - ConflictError { code: 'USER_NOT_ACTIVE', details: { status, deleted_at } } if status != 'active' OR deleted_at IS NOT NULL
Returns: void on success
```

### `sessions.destroyAllForTenant(tenantId)` contract

```
Input: tenantId: string
Side effects:
  - For each user_id with sessions in this tenant: clear Redis user index + delete Redis session keys
  - Postgres: DELETE FROM sessions WHERE tenant_id = $1 (RLS-scoped via withTenant)
Returns: { revokedCount: number, affectedUsers: string[] }
```

Implementation note: SELECT distinct user_ids first under the tenant context, then call existing `destroyAllForUser(userId, tenantId)` for each. Reuses the well-tested Redis-index sweep path.

### Session-loader extension

Add a parallel `tenantIsActive(tenantId)` lookup using the same pattern as `userIsActive` (the platform tenant is always active, so super-admins are unaffected). Block the session with `AuthnError("tenant not active")` and `sessions.destroy(token)` on failure — mirrors the user-status reject path.

### Write-block guards on existing super-admin endpoints

These 5 endpoints get `await assertTenantActive(tenantId)` at the top of the handler:
- `PATCH /api/admin/super/tenants/:tenantId/ai-generate-mode`
- `PATCH /api/admin/super/tenants/:tenantId/plan`
- `POST /api/admin/super/tenants/:tenantId/entitlements`
- `DELETE /api/admin/super/tenants/:tenantId/entitlements`
- `POST /api/admin/super/tenants/:tenantId/invitations/resend`

`POST /api/admin/super/companies` (create) is exempt — it creates a new tenant in `provisioning` state.
`GET` endpoints stay open (read access preserved per principle #1).

### Detailed activity logging

New helper `logLifecycleEvent(streamLogger, evt)` in `modules/01-auth/src/lifecycle-log.ts`:

```
Input: {
  action: ActionName,                  // e.g., 'user.disabled'
  actor: { userId, role, ip?, ua? },
  target: { entityType, entityId },
  before: { status?, ... },
  after: { status?, reason?, ... },
  sessionsRevoked?: { count, userIds? },
  isOverride?: boolean,                // true for super-admin last-admin override
}
Side effects:
  - streamLogger.info({ category: 'lifecycle', ...evt }, 'lifecycle event')
  - streamLogger.warn(...) instead when isOverride === true
Returns: void
```

This is for grep-able JSONL activity tracking. The audit_log row remains the SOR for compliance forensics; this is the supplementary operational log.

### Tests / verification

- Unit: `assertTenantActive` happy + sad paths (active / suspended / archived / not-found).
- Unit: `assertUserActive` happy + sad paths.
- Unit: `destroyAllForTenant` clears Redis + Postgres for all users in tenant.
- Integration: valid session, DB flipped to tenant.status='suspended', next request → 401.
- Integration: super-admin write endpoint on suspended tenant → 409 TENANT_NOT_ACTIVE.

### Risk + mitigation

Highest-risk phase. Auth chain regression breaks every authenticated request. Mitigations:
- Phase 3 line-by-line diff review (Opus)
- Adversarial gate (Sonnet + GLM-5.1 per `feedback-adversarial-reviewer-routing`)
- Health probe immediately post-deploy: `/api/health` + an authenticated GET that should still succeed
- Rollback path: revert commit + redeploy (~5 min RTO)

---

## Phase B — Tenant lifecycle endpoints + Platform redesign

### New endpoints

All super_admin + fresh-MFA gated. Body: `{ reason?: string }`.

| Endpoint | Transition | Side effects |
|---|---|---|
| `POST /api/admin/super/tenants/:id/suspend` | active → suspended | `destroyAllForTenant` + `tenant.suspended` audit + `logLifecycleEvent` |
| `POST /api/admin/super/tenants/:id/resume` | suspended → active | `tenant.resumed` audit + log |
| `POST /api/admin/super/tenants/:id/archive` | active or suspended → archived | `destroyAllForTenant` + `tenant.archived` audit + log |
| `POST /api/admin/super/tenants/:id/unarchive` | archived → active | `tenant.unarchived` audit + log |

Idempotent: calling suspend on already-suspended returns 200 + no-op. Wrong-direction transitions (e.g., resume from archived) return 409 `INVALID_LIFECYCLE_TRANSITION` with `allowed_states` in details.

### GET /tenants extension

Add to response per row:
- `admin_count: number` — active admins
- `reviewer_count: number` — active reviewers

Query param `?include_archived=true` to surface archived tenants. Default unchanged.

### Frontend redesign

- Column header "First admin" → "Primary contact"
- Per-row badge: `6 admins · 5 reviewers · 12 total`
- [Manage ▾] menu per row (replaces existing row-click-opens-billing):
  - Open billing
  - Manage users → drill-down link
  - Suspend tenant / Resume tenant (state-aware label)
  - Archive tenant / Unarchive tenant (state-aware label)
- State chip: `Active` (green) / `Suspended` (grey) / `Archived` (strikethrough)
- "Show archived" toggle above the table
- Confirmation modals with impact preview (sessions affected count, reason field)
- Read-only rendering for suspended/archived tenants (edit buttons absent, banner explains state)

---

## Phase C — User lifecycle endpoints + Users-page UI

### New tenant-admin endpoints (under `/api/admin/users/*`)

All gated by existing tenant-admin role chain. Body: `{ reason?: string }`.

| Endpoint | Transition | Side effects | Refuses on |
|---|---|---|---|
| `POST /api/admin/users/:userId/disable` | active → disabled | `destroyAllForUser` + `user.disabled` audit | self, last-active-admin, super_admin target, cross-tenant target |
| `POST /api/admin/users/:userId/reenable` | disabled → active | `user.reenabled` audit | cross-tenant target |
| `DELETE /api/admin/users/:userId` (soft-delete) | disabled → soft-deleted | `user.soft_deleted` audit | active state (must disable first), cross-tenant target |
| `POST /api/admin/users/:userId/restore` | soft-deleted → disabled | `user.restored` audit | cross-tenant target |
| `DELETE /api/admin/users/invitations/:invitationId` | pending invite → cancelled | delete `user_invitations` + delete pending `users` row + `user.invitation_cancelled` audit | accepted invitations, cross-tenant target |

### New super-admin override endpoints (under `/api/admin/super/users/*`)

Same set as above. Super-admin override capability:
- `confirm_last_admin: true` flag in body bypasses last-admin invariant
- Override requires `reason` to be non-empty
- Audit row jsonb includes `is_override: true`
- `logLifecycleEvent` fires at WARN level

### Frontend

`modules/10-admin-dashboard/src/pages/users.tsx` (read in Phase 0 of execution):
- State chips per row + state-aware actions menu
- Self-disable button absent
- Last-active-admin Disable button absent with tooltip
- "Show disabled" + "Show removed" toggles (session-scoped)
- Confirmation modals with impact preview

Super-admin drill-down: new route `/admin/platform/:tenantId/users` using same `Users` page component, fetched via super-admin-scoped list endpoint.

---

## Phase D — Messaging + login UX

### Pre-auth (login screen, magic-link landing, OTP entry)

Uniform copy for every failure: *"We couldn't sign you in. If you think this is wrong, contact your company administrator or AssessIQ support."*

Same HTTP code (400), same response body shape, same timing (extend existing 200 ms floor from candidate login to admin login + magic-link landing).

Below failure message: "Need help signing in?" link → help drawer with: *"Common reasons: incorrect email or code; expired magic link; your administrator has paused your account. Contact your administrator or [support@assessiq] to restore access."*

### Post-auth (state changed mid-session)

Auth chain rejects with `SESSION_REJECTED_INACTIVE` carrying `{ code, scope: 'user' | 'tenant' }`. Frontend switches on `scope`:

| Scope | Message |
|---|---|
| `'user'` | "Your account access has been paused by your administrator. Please contact them to restore access." |
| `'tenant'` | "Your company's AssessIQ access is currently paused. Please contact AssessIQ support to restore service." |

Frontend never displays `code` or internal vocabulary. Logs do.

---

## Phase E — Docs + polish

- `docs/03-api-contract.md`: 4 tenant + 5 user lifecycle endpoints + 1 invite-cancel, full schemas + error codes
- `docs/04-auth-flows.md`: new section "Lifecycle state machine + auth-chain block" with diagrams
- `modules/03-users/SKILL.md` § 7: extend state machine with `active ⇄ disabled → soft-deleted` graph + actor scopes
- `modules/02-tenancy/SKILL.md` (or `docs/06-deployment.md`): tenant lifecycle reference
- Optional polish (defer if time-pressed): audit-history viewer per tenant on Platform page

---

## Total estimate + session boundaries

| Session | Scope | Effort | Adversarial gate |
|---|---|---|---|
| **Session 1 (this)** | Phase A only | 2–3 h | Yes — Sonnet + GLM-5.1 on auth-chain diff |
| **Session 2** | Phase B + Phase C parallel | 3–4 h | Yes — both touch cross-tenant write paths |
| **Session 3** | Phase D + Phase E | 1–2 h | No (messaging + docs only) |

Total **~8–10 h** of focused work across 3 sessions. Each session: commit → deploy → docs → handoff per Definition of Done.

## Definition of Done per phase

1. Implementation typechecks clean.
2. Adversarial gate passed (where required).
3. Commit pushed.
4. Deploy to assessiq-vps complete; container healthy.
5. Docs updated in same PR (api-contract / auth-flows / SKILL).
6. SESSION_STATE handoff updated with agent utilization footer.
7. Live verification: an authenticated GET still returns 200; a manually-triggered lifecycle action via SQL produces both an `audit_log` row AND a JSONL lifecycle log entry.
