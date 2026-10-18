# Self-serve organisation sign-up: design (Z-71)

**Date:** 2026-10-19. **Status:** design only. No code. The build needs a design review and one adversarial gate (see "Gate" below).
**Source:** owner review sheet Q3 (yes, build it), Z-70 free plan pack (approved with changes), Z-72 liability and DPA proposal.
**Old task or feature checked:** `createTenant` in `modules/02-tenancy/src/service.ts` (super-admin only today), the email sign-in code in `modules/01-auth/src/email-otp.ts`, the public `/try` demo, `modules/19-billing` plan columns, ROADMAP X2, Z-18, Z-70, Z-72.

> [!WARNING]
> This feature is load-bearing. It creates tenants and first admins. It touches `modules/02-tenancy` and `modules/01-auth`. Do not build it before the owner approves this design and the gate passes.

## Summary

- A visitor opens a public sign-up page, enters an organisation name and a work email, and passes a bot check.
- AssessIQ emails a sign-in code. A correct code creates the organisation, the first admin and a **Free** plan.
- The visitor ticks the terms and the data processing addendum (DPA). AssessIQ stores the acceptance.
- No staff action is needed. A platform owner can still block or remove an organisation.

## Flow

1. The visitor opens `/signup` on the marketing site or the web app.
2. The form asks for: organisation name, admin name, work email, and two tick-boxes (terms, DPA). A bot check sits on the form.
3. `POST /api/public/signup/request` checks the bot token, the IP rate limit, the email rate limit and the block list. It always answers `200 { ok: true }`. It sends a code only when the email is new. This keeps the anti-enumeration rule of the sign-in code.
4. The visitor enters the 6-digit code. `POST /api/public/signup/verify` checks the code, then creates the tenant, the first admin, the plan row, the entitlements and the acceptance record in **one transaction**.
5. The server starts a session for the new admin (same cookie rules as the sign-in code) and sends the admin to the setup page.
6. The admin sees the Free plan limits (5 candidates, sample question sets) on the first screen.

## Bot check

- Cloudflare Turnstile sits on the form (owner decision 2026-10-19). The server checks the token with the provider before it sends any code. The page CSP must allow the Turnstile script and frame (see Z-46; the live CSP is report-only in the repo only).
- If the provider is down, the request fails closed: no code is sent.
- The IP rate limit uses `extractRateLimitClientIp`, as for other public routes (memory: IP trust behind Cloudflare).

## Email check

- The email is proven by the code. Nothing is created before the code is correct.
- A work email is not forced (the owner dropped the domain rule). Free mail addresses are allowed.
- An email that already belongs to an organisation gets no new organisation. The visitor sees the same screen as everyone else. The email says "you already have an account, sign in".
- The code uses the same rules as the admin code: 6 digits, sha256 in Redis, single use, 10 minutes, 5 attempts. The build should reuse the helpers in `email-otp.ts`, not copy them.

## Tenant creation path

- Today `createTenant(input, createdBySuperAdminUserId)` needs a super admin. The build adds a system-actor path that runs under `withSystemRole("self-serve sign-up")`. The reason text is mandatory.
- It creates, in one transaction: `tenants` (status `active`), `tenant_settings`, `tenant_plans` (tier `free`, 25 credits, AI override 5), the first `users` row (role `admin`, no password), the set entitlements for the sample sets, and the acceptance record.
- Slug: derived from the name, with a random suffix on a clash. The visitor cannot pick a reserved slug (`admin`, `api`, `www`, `assessiq`, and so on).
- No tenant exists in `provisioning` state after a failed verify. The transaction rolls back.

## DPA tick-box and acceptance record

- The form shows the terms and the DPA text with a version id. Both tick-boxes are required.
- New table `tenant_legal_acceptances`: `tenant_id`, `user_id`, `document` (`terms` or `dpa`), `version`, `accepted_at`, `ip`, `user_agent_hash`. It is append-only. It has `tenant_id` and the two RLS policies.
- A new DPA version needs a new tick before the next assessment starts (Z-72 section 2). The build of that gate is a later row.
- The lawyer approves the text before the page goes live (Z-72). Until then the page stays off.

## Free plan entitlements

See `docs/design/2026-10-18-free-plan-pack.md`. In short: 5 candidates in total, 25 credits, sample sets, results release, certificates without a mark, no export, AI grading for a few attempts. The limits only act when `PLAN_TIERS_ENFORCED=true` (Z-18). The build must not open sign-up while that flag is off.

## Abuse controls

- Bot check, IP and email rate limits, block list for domains and emails, 5 invites in total.
- AI kill switch: a platform setting that stops AI grading for Free organisations. Staff can turn it on at once.
- No auto-delete (owner decision). Staff remove an abusive organisation by hand with the existing tenant lifecycle.
- A global daily cap on new sign-ups (platform setting, 50 a day proposed; the owner has not confirmed). Above the cap the form shows "sign-up is busy, try tomorrow".
- Free plan content (decided 2026-10-19): 5 candidates in total, 5 fixed sample sets (aptitude first), 5 AI-graded attempts, no end date, no auto-delete.

## Audit events

New actions, written through the audit module under the system actor:

- `signup.requested` (no tenant yet: stored with the platform tenant id and a hashed email)
- `signup.completed` (tenant id, plan, DPA and terms version)
- `signup.rejected` (reason class only: bot, rate, blocked)
- `tenant.ai_kill_switch_changed` (platform setting)

The audit rows never hold the plain code or the plain email of a rejected request.

## Modules touched

| Module | Change |
|---|---|
| `02-tenancy` | System-actor tenant creation path. Reserved slugs. (Load-bearing.) |
| `01-auth` | Verify route mints a session for the new admin. Reuse OTP helpers. (Load-bearing.) |
| `19-billing` | Free plan row, AI override, kill switch read. |
| `14-audit-log` | New action names in the catalog. (Load-bearing, append-only.) |
| `03-users` | First admin row. |
| `apps/api`, `apps/web`, `apps/marketing` | Public routes, the sign-up page, bot check script, CSP entry. |
| `16-help-system` | Help ids for the new screens. |
| docs | `02-data-model.md`, `03-api-contract.md`, `04-auth-flows.md`, `05-ai-pipeline.md` (kill switch), `06-deployment.md` (bot-check keys). |

## Gate

- This design goes to a design review first.
- The build then goes through one adversarial gate (`01-auth`, `02-tenancy`). Use `docs/ai-playbook/gate-checklist.md`, areas auth, tenancy and audit-log.
- Attack list for the gate: tenant takeover by an existing admin email, slug squatting, race on double verify, code reuse, enumeration by timing, cross-tenant read of the acceptance table, rate-limit scope, bot-check bypass, and a sign-up before the plan limits are on.

## Not included

- Payments and prices (Q1, Q2).
- Single-person (B2C) sign-up.
- Any live change to `/terms` or `/privacy` (the lawyer first).
- Auto-delete (the owner said no).
- API-mode AI grading (Q8).

## Owner decisions and open points (2026-10-19)

1. Daily cap: 50 a day is still a proposal.
2. Bot check: Cloudflare Turnstile (decided).
3. The sign-up page stays off until the lawyer approves the DPA text (proposal, not yet confirmed).
4. Subject count and AI attempts: decided in the free plan pack (5 fixed sets, 5 AI attempts).

## Design review findings (S30, 2026-10-19)

**Verdict: REVISE.** Reviewer: Sonnet takeover (Codex is down), read-only, against the real code. Method: `docs/ai-playbook/gate-checklist.md` (areas 01-auth, 02-tenancy, 14-audit-log). The design stays a design. Nothing is built. Fix items 1 to 7 before any build, then run the build gate.

| # | Severity | Finding | Required change |
|---|---|---|---|
| 1 | High | Reusing the OTP helpers is unsafe. `modules/01-auth/src/email-otp.ts` keys Redis on the email hash alone (about lines 90-93 and 409-413). A sign-up code and an admin-login code for one email would share a key. Compare and delete are not atomic, so two parallel verifies can both pass and create two tenants. `users` is only `UNIQUE(tenant_id, email)`, so the database does not stop it. | Use a separate key prefix with a purpose field. Take the code with an atomic `GETDEL` or a Lua compare-and-delete. Add a one-use claim row as a unique guard. |
| 2 | High | "An email that already has an organisation gets no new one" is checked at request time only. `normalizeEmail` is trim and lower-case only. Plus-addressing, Gmail dots and unicode variants pass as new emails, so one person can make many organisations. | Re-check inside the create transaction. Add a global daily send cap. Block a sign-up email that matches a `SUPER_ADMIN_EMAILS` entry. State plainly that plus-address abuse is bounded only by the daily cap. |
| 3 | High | The IP is not a strong control. `extractClientIp` trusts `cf-connecting-ip` only after it checks `x-origin-verify`, and `docs/04-auth-flows.md` records IP spoofing as an accepted residual. Correction by the orchestrator: the helper `extractRateLimitClientIp` DOES exist (`modules/01-auth/src/middleware/rate-limit.ts`), so the design name is right. The weakness is real. | Do not use the IP as the only control. Turnstile and the global cap carry the load. |
| 4 | High | The design does not say how Turnstile is checked. | Run siteverify server-side with a short timeout. Fail closed. Make the token single use (replay) and bind it to the sign-up route. Make `PLAN_TIERS_ENFORCED=true` a hard precondition. |
| 5 | High | "Do not open sign-up while `PLAN_TIERS_ENFORCED` is false" is only a sentence. `modules/19-billing/src/service.ts` (about lines 803, 818, 831) returns early when the flag is off. | The sign-up routes refuse to start unless the flag is true. Add a test. |
| 6 | High | The Free limits are not implemented. `TIER_LIMITS.free` is 2 packs, 200 per drive, ratio 1.2. There is no total-candidate cap, no AI-attempt cap and no admin cap. The credit cap is checked at invite time, not in the grade transaction. Parallel invites can pass the 5-candidate limit. The AI override of 5 only changes an "included" number. | Enforce each limit with a row lock or a counter in the same transaction. Prove with a test that the 6th candidate and the 6th AI attempt are blocked, including a parallel case. |
| 7 | High | The AI kill switch has no stated authority. | Only `super_admin` may change it. Add the audit action. Check it inside the grading path, in the write transaction. |
| 8 | Medium | `signup.requested` for anonymous callers adds one permanent row per request to an append-only table (storage-DoS). A plain SHA-256 of an email is reversible by dictionary. | Write the audit row only after the rate limit and the Turnstile check pass. Use an HMAC of the email, not a plain hash. |
| 9 | Medium | `sendEmail` needs a `tenantId` (`email-otp.ts` about line 312). Sign-up has none. The "you already have an account" mail is a third mail-bomb path. | Name the sender and the tenant context. Cap that mail per email and per day. |
| 10 | Medium | `tenant_legal_acceptances` is not specified tightly. | Grant INSERT and SELECT only. Revoke UPDATE and DELETE. One RLS policy per verb with `WITH CHECK`. Store the IP as a hash, not plain. |
| 11 | Medium | Slug rules are loose. | Exact reserved list. A normalised unique key (case, unicode). The random suffix must not reveal that a slug exists. |
| 12 | Low | The session mint needs care. | Create a new session id. Use the same cookie flags as `cookieOpts` (`google-sso.ts`). Never reuse a pre-login cookie. |

**Not flagged (intentional):** sync-on-click AI, candidates without accounts, the move from super-admin-only tenant creation to a system-actor path.

**Next step for Z-71:** update this design for items 1 to 12, ask the owner to approve the revised text, then build, then run one adversarial gate on the diff (areas 01-auth, 02-tenancy, 14-audit-log).
