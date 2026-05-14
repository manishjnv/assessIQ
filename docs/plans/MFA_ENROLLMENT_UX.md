# MFA Enrollment UX — states, transitions, and implementation slice

> Goal: unblock `MFA_REQUIRED=true` prod flip without locking out existing Google SSO admins.
> Scope: enrollment nudge + recovery-code safety fix only. NO `MFA_REQUIRED=true` flip this session.

---

## Problem statement

`MFA_REQUIRED=false` today. Existing SSO admins have never been prompted to enroll TOTP.
Flipping to `true` in `require-auth.ts` immediately locks out every admin who hasn't gone through
`/admin/mfa` and completed `enrollConfirm`.

Two compounding bugs make this worse:

1. **No enrollment status signal.** `SessionInfo` exposes `mfaStatus: 'verified'|'pending'|'n/a'`
   but no `totpEnrolled: boolean`. The frontend cannot tell whether an admin has enrolled at all.
   `mfa.tsx` works around this with a heuristic: `POST enrollStart` → 409 = already enrolled.
   But that heuristic is fire-and-forget; no component outside `mfa.tsx` knows the enrollment state.

2. **Recovery codes discarded after enrollment.** `enrollConfirm` returns `{ recoveryCodes: string[] }`
   (10 plaintext codes). `mfa.tsx`'s `verify()` path calls the API and immediately navigates to
   `/admin` without ever rendering the codes. Any admin who enrolled today has NO recovery codes.
   This is a critical safety gap: if their TOTP device dies, the only recovery path is
   `adminResetTotp`, which requires another admin to intervene.

---

## UX state machine

```
                        ┌─────────────────────────────────────┐
                        │  Admin logs in via Google SSO        │
                        └──────────────┬──────────────────────┘
                                       │
                          totpEnrolled?│
                     ┌─────────────────┴────────────────────┐
                     │ no                                    │ yes
                     ▼                                       ▼
        ┌────────────────────────┐            ┌───────────────────────────┐
        │  NUDGE STATE           │            │  VERIFY STATE (existing)  │
        │  AdminShell shows      │            │  /admin/mfa shows TOTP    │
        │  dismissible banner:   │            │  input; totpVerified→true  │
        │  "Enable MFA to secure │            │  on success               │
        │  your account"         │            └──────────────┬────────────┘
        │  [Enroll Now] [Later]  │                           │
        └──────────┬─────────────┘                          │
                   │ click Enroll Now                        │
                   ▼                                        ▼
        ┌───────────────────────────────┐      ┌────────────────────────┐
        │  ENROLL STATE (/admin/mfa)    │      │  DASHBOARD (authed)    │
        │  a) Show QR + secret          │      └────────────────────────┘
        │  b) Confirm TOTP code         │
        │  c) *** SHOW RECOVERY CODES***│
        │     Copy-all + Download .txt  │
        │     "I've saved my codes" ✓   │
        │  d) Navigate to /admin        │
        └───────────────────────────────┘
```

### States not in this slice (deferred)

| State | Reason deferred |
|---|---|
| Recovery-code regeneration UI | Requires separate surface; low urgency pre-`true` flip |
| Admin-reset-TOTP UI (by super_admin) | Backend exists; UI pass is a separate slice |
| "MFA required" hard-gate redirect | Happens when `MFA_REQUIRED=true` is flipped — that flip is explicitly OUT of scope |
| Enrollment reminder email | Notification module work; nice-to-have |

---

## Proposed slice — what ships this session

### In scope

1. **`GET /api/auth/whoami` → `totpEnrolled: boolean`**
   Add `totp_enrolled_at IS NOT NULL` check to the whoami query; surface as `totpEnrolled` in the
   response. Also add to `SessionInfo` type in `apps/web/src/lib/session.ts`.

2. **AdminShell nudge banner** (when `!session.totpEnrolled && session.role !== 'candidate'`)
   Dismissible (sessionStorage key `mfa-nudge-dismissed`), links to `/admin/mfa`.
   Renders above the main content area inside `AdminShell.tsx`.

3. **`mfa.tsx` recovery-code display fix**
   In the `verify()` path, capture `{ recoveryCodes }` from `enrollConfirm`, show a modal/panel
   with copy-all and .txt download, gate the `/admin` redirect on explicit "I've saved my codes"
   checkbox + button. Recovery codes are not persisted anywhere beyond this moment.

### Out of scope

- `MFA_REQUIRED=true` flip
- Recovery-code regeneration
- Admin-reset-TOTP surface
- `adminResetTotp` backend changes
- New DB columns (only need `totp_enrolled_at`, already in schema from Phase 0)

### Files changed

| File | Change |
|---|---|
| `apps/api/src/routes/auth/whoami.ts` | Add `totpEnrolled: boolean` to response (load-bearing — Opus review + codex:rescue) |
| `modules/01-auth/src/totp.ts` | Add `getEnrollmentStatus(userId)` helper returning `{ enrolled: boolean }` (load-bearing) |
| `apps/web/src/lib/session.ts` | Add `totpEnrolled: boolean` to `SessionInfo` |
| `modules/10-admin-dashboard/src/components/AdminShell.tsx` | Add dismissible nudge banner |
| `apps/web/src/pages/admin/mfa.tsx` | Capture recovery codes from enrollConfirm, show + gate redirect |

### Tests

- `modules/01-auth/__tests__/totp-enrollment-status.test.ts` — unit tests for `getEnrollmentStatus`
- `apps/web/src/pages/admin/mfa.test.tsx` — React Testing Library: recovery-code panel renders, copy/download available, button enables only after checkbox, redirect fires after click

### Acceptance

- [ ] `pnpm -F @assessiq/auth typecheck` clean
- [ ] `pnpm -F assessiq-web typecheck` clean
- [ ] New unit tests pass
- [ ] VPS deploy: `assessiq-api` + `assessiq-frontend` rebuilt + recreated
- [ ] Production smoke: `GET /api/auth/whoami` returns `totpEnrolled` field
- [ ] Production smoke: AdminShell shows nudge for an unenrolled admin, not for an enrolled one
- [ ] Production smoke: mfa.tsx enrollment flow displays recovery codes before redirecting
- [ ] codex:rescue adversarial verdict logged (01-auth is load-bearing)

---

## Security invariants (hard rules, not negotiable)

- TOTP secret NEVER logged (enforced by existing totp.ts — do not add debug logging)
- Recovery codes hashed at rest (existing schema has `recovery_code_hash[]` — plain codes shown once, never stored plain, never re-shown)
- Every mutation in this slice uses `auditInTx` in the same transaction (G3.D contract)
- `totpEnrolled` is read-only from the frontend — only the backend sets it via `enrollConfirm`
