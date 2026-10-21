# Free plan limits in code (reference)

Rows: Z-18, Z-70, Z-71

**Date:** 2026-10-20. **Status:** built behind `PLAN_TIERS_ENFORCED` (default `false`, `false` on the VPS). Nothing changes until the owner flips the flag.
**Source:** `docs/design/2026-10-18-free-plan-pack.md` (owner decisions 2026-10-19).
**Old task or feature checked:** PT1/PT-4 (`TIER_LIMITS`, `assertTierLimit`), Z-18, Z-70, Z-71.

## Summary

- The Free plan limits are now in `TIER_LIMITS.free`. They act only when `PLAN_TIERS_ENFORCED=true`.
- Two new checks exist: a total candidate cap (5) and an AI-attempt cap (5, with a kill switch).
- The credit hard stop is now 100 % of 25 credits (was 120 %).
- Webhooks, API keys, embed and the audit viewer stay locked on Free. `FEATURE_MIN_TIER` is unchanged.
- The owner must move the pilot tenant to a paid tier BEFORE the flag flips. See `tools/pilot-tenant-to-paid.sql` (not run) and `tools/free-tier-at-risk.sql` (read-only).

## Free limits mapped to entitlement keys

| Free limit | Key | Status | Enforced in this change |
|---|---|---|---|
| 5 candidates in total | `max_candidates_total` | New in `TIER_LIMITS` | Yes: `assertCandidateTotalCap` |
| 5 sample question sets | `licensed_packs` (was 2) | Existing key, new value | Yes: existing grant check |
| 25 credits, hard stop | `overage_hard_cap_ratio` 1.0 (was 1.2) | Existing key, new value | Yes: existing invite check |
| 5 AI-graded attempts | `ai_attempts_total` | New in `TIER_LIMITS` | Yes: `assertAiAttemptAllowed` |
| AI kill switch | `FREE_PLAN_AI_DISABLED` (env) | New | Yes |
| 1 attempt per candidate | `max_attempts_per_candidate` | Not built | No: waits for Z-71 |
| 3 admins | `max_admins` | Not built | No: waits for Z-71 |
| No data export | `export_allowed` | Not built | No: waits for Z-71 |
| No "Trial" mark on certificates | `certificate_label` | Not checked | Not verified in this change (Z-71) |
| Result release | none | Open on all tiers | n/a |
| Own tier name "Free" | `TIER_DISPLAY_NAMES.free` is still "Starter" | Not changed | No: waits for Z-71 |

## Old Starter exclusions

| Feature | Old rule | "All features on with limits" means | Recommendation | Abuse risk |
|---|---|---|---|---|
| Webhooks | Locked below Growth | A small endpoint count | Keep locked | High. Server-side request forgery (SSRF) and outbound spam from our servers. |
| API keys | Locked below Enterprise | A key with a low rate limit | Keep locked | High. Automated abuse and scraping with no human in the loop. |
| Embed | Locked below Enterprise | Embed on one allowed domain | Keep locked | Medium. Third-party framing of our pages. |
| Audit log viewer | Locked below Enterprise | Read-only view | Open for Free later (owner choice) | Low. Tenant-scoped read. |
| Certificates | Locked below Growth | Issued, no "Trial" mark | Open for Free (owner decision) | Medium. Brand and fraud: fake certificates. Signing stays server-side. |
| Full cohort report | Locked below Growth | Basic report only | Keep as is | Low. Display only. |
| Own email sender | Locked below Enterprise | Platform sender only | Keep locked | Medium. Spoofing and mail reputation. |
| Data export | Locked | Off for Free (owner) | Keep off | High. Personal data leaves the platform. |

Note on certificates: the owner decided certificates work on Free. The orchestrator lowered `FEATURE_MIN_TIER.certificates` from `pro` to `free` in this change (2026-10-19 review), so a Free tenant keeps certificates when the flag is ON. With the flag OFF nothing changes. Rollback: set it back to `pro`.

## What changed in code

- `modules/19-billing/src/service.ts`: `TIER_LIMITS` has two new keys. `assertCandidateTotalCap` and `assertAiAttemptAllowed` are new. `TierDenialCode` has `AI_GRADING_DISABLED`.
- `modules/19-billing/src/repository.ts`: `countCandidatesEver` and `countAiAttemptsEver`.
- `modules/00-core/src/config.ts` and `.env.example`: `FREE_PLAN_AI_DISABLED` (default `false`, not set on the VPS).
- `apps/api/src/routes/invitations.ts`, `admin-users.ts` (invite, create user, CSV import): candidate cap.
- `apps/api/src/routes/admin-super-evaluations.ts`: AI cap on `grade` and `rerun`. `modules/07-ai-grading` is not edited.
- Counting sources:
  - Candidates: `users` rows with `role='candidate'`. Soft delete only sets `deleted_at`, and erasure tombstones the row, so delete and re-add cannot reset the cap. The query runs inside `withTenant`.
  - AI attempts: distinct attempts with cached `attempts.ai_proposals` (written on Grade) or an `ai_answer_evaluated` billing event (written on Accept). This closes the gap between Grade and Accept. The attempt being graded is excluded, so a re-run is free.
- `per_drive_candidates` stays 200. It can never be reached when the total is 5, and the existing tests keep their meaning.

## What is NOT included

- No new table and no migration.
- No `max_attempts_per_candidate`, `max_admins`, `export_allowed` (Z-71).
- No change to `FEATURE_MIN_TIER`, the display name, help text or any UI.
- Embed JIT users (`resolveJitUser`) and super-admin created users are not capped. Embed is locked on Free. Super admin is trusted.
- The flag is not flipped anywhere.

## Rejected options

- **120 % credit ratio kept:** the owner said "25 credits hard stop". 120 % would allow 30. Ratio is now 1.0.
- **New table or column for the kill switch:** a platform setting table is Z-71 scope. An env flag read at call time needs no migration and no deploy of data. The per-tenant AI pause still exists for one tenant.
- **Count only `ai_answer_evaluated` events:** they are written on Accept. Several attempts could be graded before the first Accept. The proposals cache closes that.
- **Count invitations instead of users:** an admin can create users with no invitation.
- **Cap inside 07-ai-grading:** that module is load-bearing and not in scope. The route wrapper in apps/api is enough.

## Known limits

- Race closed (Z-71, migration 0222): the candidate cap is enforced by `countCandidateOrRefuse` inside the creating transaction. Two parallel creates at count 4: one wins, one gets `TIER_LIMIT_REACHED`. CSV import counts only new user ids. The AI-attempt cap is still check then act.
- Re-inviting an existing candidate by email counts as one new candidate.

## How to verify

1. `pnpm --filter @assessiq/billing test` (118 tests, 10 files).
2. `pnpm --filter @assessiq/api typecheck` and the four touched api test files.
3. With the flag off: invite, import and AI grade behave as before.
4. On a copy with the flag on: a Free tenant with 5 candidates gets 403 `TIER_LIMIT_REACHED` on the 6th invite. A paid tenant is never blocked.
5. Before any flip, run `tools/free-tier-at-risk.sql` and read every row with `at_risk = true`.

## Rollback

- Revert the commit. The flag stays `false`, so production never ran the new code paths.
- No migration, so no data rollback.

## Downstream impact

- Z-71 (self-serve sign-up): must add the remaining keys, rename the display tier to "Free", and add a DB-level guard for the race.
- `docs/06-deployment.md`: the flag note must say the flip needs the pilot tenant on a paid tier first, and that `FREE_PLAN_AI_DISABLED` exists.
- `modules/19-billing/SKILL.md`: updated in this change.
- Pilot tenant: `tools/pilot-tenant-to-paid.sql` is written, not run. It ends with `ROLLBACK`. The owner must approve the tier, then change the last line to `COMMIT`.

## Gate result (S32, 2026-10-19)

- Sonnet takeover gate, areas entitlements, billing, tenancy. Verdict **revise**, 1 real finding and 3 low ones.
- **Fixed:** a role flip reset the candidate count (create 5, promote to admin, count drops to 0). New `assertCandidateRoleChange` blocks a candidate from changing role on a capped tier and counts admin-to-candidate as one new candidate. Test added (56 billing tier tests pass). Also fixed: a non-UUID attempt id made the AI guard return 500 instead of 400.
- **Accepted:** the AI count is not a perfect ledger (see the SKILL note); only a super admin reaches those cases.
- **Checked, no issue:** tenant id for the AI cap comes from the attempt lookup, not the request; both grade and rerun use the guarded chain; flag off returns before any query; paid tiers never blocked; embed JIT is locked on Free.
- `invitations.ts` role check is dead code today (the invite schema allows only admin). It is harmless and stays as a guard.
