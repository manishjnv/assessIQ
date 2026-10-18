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

- Use a managed bot check on the form (for example Cloudflare Turnstile). The server checks the token with the provider before it sends any code.
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
- A global daily cap on new sign-ups (setting, for example 50 a day). Above the cap the form shows "sign-up is busy, try tomorrow". This is a proposal, not an owner decision.

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

## Owner questions

1. Is a global daily cap on sign-ups wanted? Proposed: 50 a day.
2. Which bot check? Proposed: Cloudflare Turnstile (free).
3. May the sign-up page open before the lawyer approves the DPA text? Proposed: no.
4. Subject count and AI attempts: see the free plan pack questions.
