# Self-serve organisation sign-up: design (Z-71)

Rows: Z-70, Z-71, Z-72

**Date:** 2026-10-19 (revision 2, S31). **Status:** as-built (self-serve sign-up exists).
**Source:** owner review sheet Q3 (yes, build it), Z-70 free plan pack (approved with changes), Z-72 liability and DPA proposal, S30 design review (12 findings, all answered in this revision).
**Old task or feature checked:** `createTenant` in `modules/02-tenancy/src/service.ts` (super-admin only today), the email sign-in code in `modules/01-auth/src/email-otp.ts`, the candidate login in `candidate-login.ts`, the public `/try` demo, `modules/19-billing` plan columns and `TIER_LIMITS`, ROADMAP X2, Z-18, Z-70, Z-72.

> [!WARNING]
> This feature is load-bearing. It creates tenants and first admins. It touches `modules/01-auth`, `modules/02-tenancy`, `modules/19-billing` and `modules/14-audit-log`. Do not build it before the owner approves this design and the gate passes.

> [!NOTE]
> The section "S31 review result and corrections" at the end of this file is binding. Where it differs from an earlier section, the end section wins.

## Summary

- A visitor opens a public sign-up page, enters an organisation name, an admin name and an email, and passes a bot check.
- AssessIQ emails a sign-up code. A correct code creates the organisation, the first admin and a **Free** plan in one transaction.
- The visitor ticks the terms and the data processing addendum (DPA). AssessIQ stores the acceptance with user, time, IP hash and version.
- No staff action is needed. A platform owner can still block, stop or remove an organisation.

## Hard preconditions (the sign-up routes refuse to start without them)

| # | Precondition | How the code enforces it |
|---|---|---|
| P1 | `PLAN_TIERS_ENFORCED=true` | The route plugin checks the flag at boot and at each request. If it is false, the routes answer 404 and the page shows "sign-up is closed". A test covers both. |
| P2 | Turnstile keys are set | Missing site key or secret key means 404 on the routes. |
| P3 | The DPA and terms text have a version id set by the owner | No version id means 404. This also holds the page back until the lawyer approves the text (Z-72). |
| P4 | Redis is up | A Redis error fails closed (no code, no tenant). |

**Dependency on Z-18.** `PLAN_TIERS_ENFORCED` is `false` on the VPS today. `modules/19-billing/src/service.ts` returns early when it is false (about lines 803, 818 and 831), so no Free limit would act. **Recommendation: flip the flag (Z-18) before any Free sign-up opens.** The flip is the owner's decision and date. This design does not flip it. Because P1 is a hard precondition, sign-up cannot open by mistake while the flag is off.

## Flow

1. The visitor opens `/signup`.
2. The form asks for: organisation name, admin name, email, and two tick-boxes (terms, DPA). The Turnstile widget sits on the form.
3. `POST /api/public/signup/request` runs these checks in order, and stops at the first fail:
   1. The preconditions P1 to P4.
   2. Turnstile `siteverify` on the server (see "Bot check").
   3. The IP rate limit and the email rate limit (see "Rate limits and scope").
   4. The global daily cap of new sign-ups.
   5. The block list (email and domain), and the `SUPER_ADMIN_EMAILS` list.
   It always answers `200 { ok: true }` after the checks, so the answer does not show whether the email is new.
4. Only if the email has no organisation, the server stores a code and sends it. If the email already has an account, the server sends the "you already have an account, sign in" mail (see "Mail paths").
5. The visitor enters the 6-digit code. `POST /api/public/signup/verify` takes the code in one atomic step, then runs the create transaction (see "Tenant creation").
6. The server starts a session for the new admin and sends the admin to the setup page, which shows the Free limits.

## Separate key space and purpose (finding 1)

The admin sign-in code and the sign-up code must never share a Redis key.

- New helper file `modules/01-auth/src/signup-otp.ts`. It reuses the pure parts of `email-otp.ts` (code generator, constant-time compare, hash). It does NOT reuse the key builder.
- Key shape: `aiq:signup:otp:<purpose>:<hmac(email)>`. The purpose is the fixed string `signup`. The admin code keeps its own prefix. A unit test proves that one email can hold both codes with no collision.
- The code value in Redis is a sha256 of `code + per-record salt`, plus an attempt counter and the IP and user-agent hash (same binding as the admin code).
- **Atomic take.** Verify uses one Lua script: compare, then delete on success, in the same call. A wrong code adds one to the counter in the same script. After 5 wrong tries the record is deleted. Two parallel verifies cannot both pass, because only one script call sees the record.
- The Lua pattern follows `fixed-window-lua.ts` (the project already has a tested Lua helper).

## One organisation for each verified email (finding 2)

The database enforces this. Redis only helps.

- New table `signup_claims` (platform table, no tenant): `email_key text PRIMARY KEY`, `tenant_id uuid NULL`, `created_at`. `email_key` is the normalised email (see below) with plus-tags removed and, for known Gmail domains, dots removed. `UNIQUE` on `email_key` is the guard.
- The create transaction runs `INSERT INTO signup_claims ... ON CONFLICT (email_key) DO NOTHING`. If it returns 0 rows, the transaction stops with no tenant created and the visitor sees the same neutral screen. This makes the create **idempotent**: a repeated or parallel verify creates at most one tenant.
- The `signup_claims.tenant_id` is filled in the same transaction.
- Normal login identity still uses the exact lower-case email. `email_key` is only the sign-up guard.
- Plus-address and dot variants map to one `email_key` for the common mail hosts. Other tricks (many real mail boxes) are bounded only by the daily cap and the rate limits. This residual is accepted and stated.
- An email in `SUPER_ADMIN_EMAILS` cannot sign up. The check runs at request time and again inside the transaction.
- An email that matches an existing user of any tenant gets no new organisation (the check runs inside the transaction too, under the system role).

## Bot check (finding 4)

- Cloudflare Turnstile (owner decision).
- Server-side `siteverify` runs before the code is created. Timeout: 3 seconds. A timeout, a non-200 answer or `success=false` all fail closed: no code.
- The widget is created with an `action` value `signup-request`. The server checks that the returned `action` and the `hostname` match. This binds the token to this route and this site.
- **Single use.** After a good `siteverify`, the server stores `aiq:signup:ts:<sha256(token)>` in Redis with `SET NX EX 300`. A token that is already there is a replay and fails.
- The CSP must allow the Turnstile script and frame. The live CSP is report-only (Z-46). This is no blocker, but the enforcing policy (later) must keep `challenges.cloudflare.com`.

## Rate limits and scope (finding 3)

Follow the project rule: read the `scope` field of a 429 first, and use one bucket per scope.

| Scope | Key | Limit | Note |
|---|---|---|---|
| ip | `aiq:rl:signup:ip:<ip>` | 5 requests an hour | The IP comes only from `extractRateLimitClientIp`. If it returns null (enforce mode, unverified origin), the request fails closed. |
| email | `aiq:rl:signup:email:<hmac(email)>` | 3 requests a day | Counts requests, not only sends. |
| global | `aiq:rl:signup:day:<date>` | 50 a day (owner to confirm) | Counts completed code sends. Above the cap the form says "sign-up is busy, try tomorrow". |
| mail | see "Mail paths" | | |

- All buckets use `incrFixedWindow` from `fixed-window-lua.ts`.
- The IP is NOT the only control. The IP trust has a recorded residual (`docs/04-auth-flows.md` § Client IP trust). Turnstile and the global cap carry the load.
- No new bypass predicate. The admin rate-limit bypass (MFA mirror rule) does not apply to sign-up routes.

## Mail paths (finding 9)

`sendEmail` needs a tenant id (`email-otp.ts` about line 312). Sign-up has no tenant yet.

- The mail uses the platform sender path with the platform tenant id and the system actor. The build names this path in the code and in `docs/13-email-system.md`.
- Two mails exist: "your sign-up code" and "you already have an account, sign in". Both fall under a per-email cap of 3 a day and the global send cap. The "already have an account" mail is the third mail-bomb path. It uses the same per-email counter, so an attacker cannot send more than 3 mails a day to one address, whatever the mix.
- Neither mail holds a link that signs in. The code mail holds only the code. The other mail links to the normal sign-in page.

## Tenant creation (finding 11 and 12)

- Today `createTenant(input, createdBySuperAdminUserId)` needs a super admin. The build adds `createSelfServeTenant()` in `02-tenancy`. It runs under `withSystemRole("self-serve sign-up")`. The reason text is mandatory. It is never nested inside `withTenant`.
- One transaction creates: the `signup_claims` row, `tenants` (status `active`), `tenant_settings`, `tenant_plans` (tier `free`), the first `users` row (role `admin`, no password), the set entitlements for the 5 sample sets, the `tenant_legal_acceptances` rows, and the `audit_log` rows. If any step fails, everything rolls back. No tenant is left half made.
- **Slug rules.** The slug is derived from the name. Rules: lower-case ASCII only (unicode is folded, other characters are dropped); 3 to 40 characters; the slug is checked against an exact reserved list (`admin`, `api`, `www`, `assessiq`, `app`, `take`, `verify`, `embed`, `help`, `try`, `static`, `assets`, `brand`, `candidate`, `login`, `signup`, `support`, `mail`, `status`, plus every module name). A `UNIQUE` index on the normalised slug stops duplicates. On a clash the code adds a random 6-character suffix. The answer to the visitor never says that a slug existed.
- **Session mint (finding 12).** The server creates a new session id. It never reuses a pre-login cookie. It sets the same cookie flags as `cookieOpts` in `google-sso.ts` (HttpOnly, Secure, SameSite). It sets `totpVerified = !config.MFA_REQUIRED` for a tenant admin, the same rule as `google-sso.ts`.
- The new admin has role `admin` only. No code path in sign-up can set `super_admin`.

## Legal acceptance record (findings 10)

Table `tenant_legal_acceptances`:

| Column | Note |
|---|---|
| `id`, `tenant_id`, `user_id` | `tenant_id` is NOT NULL with RLS |
| `document` | `terms` or `dpa` |
| `version` | the version id that the form showed (precondition P3) |
| `accepted_at` | server time |
| `ip_hash` | HMAC of the IP with a server key, not the plain IP |
| `user_agent_hash` | HMAC of the user agent |

- Grants: INSERT and SELECT only. UPDATE, DELETE and TRUNCATE are revoked.
- RLS: one policy for each verb (SELECT and INSERT) with `WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid)`. No UPDATE or DELETE policy exists.
- The row is written inside the create transaction, under the system role, with the new tenant id.
- A new DPA version needs a new tick before the next assessment starts (Z-72 section 2). That gate is a later row.
- The lawyer approves the text before the page goes live (Z-72). Precondition P3 holds the page back.

## Free plan limits are enforced in the service, not in the page (finding 5, 6 and 7)

The page shows the limits. The service enforces them. Today `TIER_LIMITS.free` has 2 packs, 200 per drive and ratio 1.2. It has no total-candidate cap, no AI-attempt cap and no admin cap. The build adds these.

| Limit | Value | Where it is enforced | How it is race safe |
|---|---|---|---|
| Candidates in total | 5 | `19-billing` check called from the invite and the bulk-invite paths in `05-lifecycle` | The check takes `SELECT ... FROM tenant_plans WHERE tenant_id = $1 FOR UPDATE` and counts `invitations` in the same transaction. Parallel invites queue on the row lock. |
| Admins | 3 | `03-users` create and invite-admin path | Same row lock. |
| Credits | 25, hard stop | existing check, moved into the grade transaction | The grade transaction locks the plan row before it takes a credit. |
| AI-graded attempts | 5 in total | the grading start path in `07-ai-grading` (`assertTenantAiEnabled` area), in the write transaction | A counter column `ai_attempts_used` on `tenant_plans`, updated with `UPDATE ... WHERE ai_attempts_used < cap RETURNING`. Zero rows means refused. A parallel start cannot pass the 6th. |
| Export | none | export routes check `export_allowed` | n/a |
| Locked features | webhooks, API keys, embed, audit viewer | the route guards return 402 with "Contact us" | n/a |

- The AI cap counts the attempt when the admin starts the grading, in the same transaction that writes the grading row. A send-back does not refund it (stated; the owner may change this).
- Tests are required for each limit: the 6th candidate is blocked; the 6th AI attempt is blocked; a parallel case for both (two requests at the same time at count 4).
- These limits only act when `PLAN_TIERS_ENFORCED=true`. That is why P1 is a hard precondition.

## AI kill switch (finding 7)

- A platform setting `ai_grading_free_kill_switch` (boolean, default false). It may be per tenant or for all Free tenants.
- Only `super_admin` may change it. The route uses the super-admin chain and the audit action below.
- The grading path reads the switch inside the write transaction (`FOR SHARE`, same pattern as `assertTenantAiEnabled`). When it is on, a grading start answers 403 `AI_DISABLED` for a Free tenant. Draft calls and runs already in a lease follow the existing pause rules (known gap RW-63).
- The switch does not touch candidate code paths. It never starts an AI call (the no-ambient-AI rule holds).

## Audit events (finding 8)

New actions, written through the audit module under the system actor:

| Action | When | Rule |
|---|---|---|
| `signup.completed` | in the create transaction | tenant id, plan, DPA and terms version ids. No plain email. |
| `signup.rejected` | after the rate limit AND Turnstile pass, for a later reject (cap, block list, claim conflict) | reason class only. Stored once per HMAC(email) per day. |
| `tenant.ai_kill_switch_changed` | switch change | actor, scope, old and new value |
| `tenant.plan_limit_hit` | a Free limit blocks an action | which limit, tenant id |

- There is **no audit row for a request that fails the bot check or the rate limit**. This stops anonymous callers from adding permanent rows to an append-only table (storage DoS). Those events go to the normal log only, with counters.
- There is no `signup.requested` row.
- Email values in audit data use `HMAC-SHA256(server key, normalised email)`, never a plain hash (a plain hash is reversible by a dictionary).
- The audit rows never hold the plain code or the plain email of a rejected request.

## Abuse controls

- Bot check, IP, email and global rate limits, block list for domains and emails, daily cap.
- 5 candidates in total and 3 admins cap the mail volume from one organisation.
- AI kill switch (above).
- No auto-delete (owner decision). Staff remove an abusive organisation by hand with the existing tenant lifecycle.
- Free plan content (decided 2026-10-19): 5 candidates in total, 5 fixed sample sets (aptitude first), 5 AI-graded attempts, no end date, no auto-delete.

## Modules touched

| Module | Change |
|---|---|
| `02-tenancy` | `createSelfServeTenant`, reserved and normalised slug, `signup_claims`. (Load-bearing.) |
| `01-auth` | `signup-otp.ts`, public sign-up routes, Turnstile check, session mint. (Load-bearing.) |
| `19-billing` | Free limits (candidates, admins, AI attempts), kill switch read, locked-feature guards. (Entitlements and money: treat as gated.) |
| `14-audit-log` | New action names in the catalog. (Load-bearing, append-only.) |
| `03-users` | First admin row, admin cap. |
| `05-lifecycle` | Candidate cap check at invite. |
| `07-ai-grading` | Kill switch and AI cap in the write transaction. (Load-bearing.) |
| `13-notifications` | Platform sender path, two mail templates. |
| `apps/api`, `apps/web`, `apps/marketing` | Public routes, sign-up page, Turnstile script, CSP entry. |
| `16-help-system` | Help ids for the new screens. |
| docs | `02-data-model.md`, `03-api-contract.md`, `04-auth-flows.md`, `05-ai-pipeline.md` (kill switch), `06-deployment.md` (Turnstile keys, flag order), `13-email-system.md`. |

This work is **load-bearing** in four modules. Split the build in two rows to keep each gate at 3 security rows or fewer: (a) sign-up core (OTP, claim, tenant creation, acceptance, audit); (b) Free limits and kill switch.

## Gate

- This revision goes to one design-review gate (S31).
- The build then goes through one adversarial gate per build row. Use `docs/ai-playbook/gate-checklist.md`, areas 01-auth, 02-tenancy, 07-ai-grading and 14-audit-log.
- Attack list for the gate: tenant takeover by an existing admin email, slug squatting, race on double verify, code reuse across purposes, enumeration by timing, cross-tenant read of the acceptance table, rate-limit scope, Turnstile replay, sign-up before the plan limits are on, parallel invites over the cap, parallel AI starts over the cap.

## Not included

- Payments and prices (Q1, Q2).
- Single-person (B2C) sign-up.
- Any live change to `/terms` or `/privacy` (the lawyer first).
- Auto-delete (the owner said no).
- API-mode AI grading (Q8).
- Flipping `PLAN_TIERS_ENFORCED` (Z-18, owner date).

## What was considered and rejected

- Reusing the admin OTP key space with a flag: rejected (finding 1). A purpose prefix and an own Lua script are simpler to prove.
- A Redis-only "one tenant for each email" check: rejected. Redis can lose data and two parallel calls can pass. A unique database key is the only safe guard.
- Ignoring plus-addressing: rejected as the only plan, but full removal of the abuse is impossible (many real mail boxes). The daily cap bounds it.
- Forcing a work email: dropped by the owner.
- An audit row for every request: rejected (storage DoS).
- Limits only in the page: rejected (owner asked for code enforcement).

## Owner decisions and open points

1. Daily cap: 50 a day is still a proposal. The owner confirms.
2. Bot check: Cloudflare Turnstile (decided).
3. Z-18: the owner sets the date for `PLAN_TIERS_ENFORCED=true`. Recommendation: before any Free sign-up.
4. The page stays off until the lawyer approves the DPA text (P3 enforces it).
5. Does a send-back refund an AI attempt? Proposed: no.
6. Subject count and AI attempts: decided in the free plan pack (5 fixed sets, 5 AI attempts).

## Review history

| Review | Date | Verdict | Findings |
|---|---|---|---|
| S30 design review (Sonnet takeover) | 2026-10-19 | REVISE | 12. All are answered in this revision: 1 (key space, atomic take, claim row), 2 (database unique claim, plus-address residual, `SUPER_ADMIN_EMAILS`), 3 (IP not the only control), 4 (Turnstile server check, replay, action binding), 5 (P1 precondition), 6 (service-level limits with row locks), 7 (kill switch authority), 8 (audit only after the gates, HMAC), 9 (mail path and caps), 10 (acceptance table grants and RLS), 11 (slug rules), 12 (session mint). |
| S31 design review (Sonnet takeover) | 2026-10-19 | REVISE | See "S31 review result and corrections" at the end. All findings are answered. A third review is not run in S31; the build gate re-reads them. |

## S31 review result and corrections (binding)

**Verdict of the S31 design review (Sonnet takeover, read-only, against the code): REVISE.** 11 findings. They are detail gaps in the S30 fixes, not the same defect class. Every finding is answered below. The earlier text in this file stays only where this section does not change it. The build gate re-reads this section against the real code.

| # | Sev. | Finding (code evidence) | Decision |
|---|---|---|---|
| 1 | Med | The Lua "compare and delete" cannot hash: Redis Lua has no sha256, and the salt design needs a GET first. The existing `ATTEMPT_LUA` only counts. `email-otp.ts` compares in JS and deletes in a second call (about lines 396-413), so two parallel correct verifies can pass today. | The app computes `HMAC-SHA256(server key, "signup" + email_key + code)` with no salt (the key binds it). Redis holds a hash `{h, attempts}`. One Lua script reads `h`, compares it with the `ARGV` value, deletes the key on a match (returns 1), and on a miss adds one to `attempts` and deletes the key at 5 (returns 0). The compare is inside Lua, so only one caller sees the match. The compare is plain equality on a keyed HMAC, so timing leaks nothing useful. The build adds a parallel-verify test. The admin code path is NOT changed here. Proposed separate row: FU-OTP-ATOMIC (make the admin OTP verify atomic; load-bearing, 01-auth). |
| 2 | Med | `incrFixedWindow` always adds one. Solved-Turnstile traffic from rotating IPs can burn the global cap. The 3 a day email bucket lets an attacker burn a victim's quota. The `scope` union in `rate-limit.ts` (about line 65) has no email or global scope. | Add scopes `signup_ip`, `signup_email`, `signup_global` to the union (a 429 names its bucket). The global counter adds one only after Turnstile passes AND the email is new. At the cap, an alert goes to the owner and staff can raise the cap. Accepted residual: an attacker with a solved-Turnstile farm can fill the day's cap and delay real sign-ups. The cap limits damage; it is not a block. A burned email bucket delays one address for one day. |
| 3 | Med | No constant-time floor. The known-account path does a DB lookup and sends a different mail. | Copy the 800 ms floor and the constant-work resolve of `email-otp.ts` into the request route. Both branches do the same Redis and DB steps and both queue a mail. |
| 4 | Med | The candidate cap names the wrong table. The real table is `assessment_invitations`. Candidate users are also made without an invitation: `03-users` create and import, and the embed JIT user (`12-embed-sdk/jit-user.ts`). A row count falls when rows are deleted. `assertTierLimit` takes a caller-supplied `current`, and no lifecycle code calls it. | Count **distinct candidate user ids ever counted**. New table `tenant_candidate_counted (tenant_id, user_id, PRIMARY KEY (tenant_id, user_id))` with RLS. Every path that creates or invites a candidate (invite, bulk invite, user create, user import, embed JIT) calls ONE function `countCandidateOrRefuse(tx, tenantId, userId)`. It runs `SELECT ... FROM tenant_plans WHERE tenant_id=$1 FOR UPDATE`, then `INSERT ... ON CONFLICT DO NOTHING`, then counts, and throws `PLAN_LIMIT` above the cap. A delete does not lower the count. This replaces the caller-supplied `assertTierLimit(current)` pattern for this limit. A test covers each of the five paths and a parallel case. |
| 5 | Med | The design moves the credit check into the grade transaction, but `19-billing/src/service.ts` (about lines 770-772) says the grade transaction must never block completion. | **Withdrawn.** The credit check stays where it is. For Free, 5 candidates times 1 attempt is 5 credits, below the 25 credits, so the candidate cap already keeps credits in range. No change to the grade transaction. |
| 6 | Med | The AI counter rises before the AI call, which runs outside the transaction, so failures and reruns burn attempts. The cap must also cover admin-grade, admin-rerun, admin-accept, the platform-grade path and drafts (RW-63). | Count **distinct attempts with a committed AI grading**. Table `tenant_ai_attempts_counted (tenant_id, attempt_id, PRIMARY KEY (tenant_id, attempt_id))`. The row is inserted in the SAME transaction that writes the grading result (`ON CONFLICT DO NOTHING`). A rerun of the same attempt adds nothing. A failed call that wrote no grading adds nothing. Before a start, the path reads the count and the kill switch and refuses at 5. At commit, the insert runs under the plan row lock with a count check, so a 6th is refused. The AI runtime is single-flight on the VPS. All paths call one guard `assertFreeAiAllowance(tx, tenantId, attemptId)`: admin-grade, admin-rerun, admin-accept, platform grade. Drafts (known gap RW-63) use AI but write no grading; proposal: drafts also count the attempt. The owner decides. |
| 7 | Med | A unique violation on the slug aborts the Postgres transaction (`createTenant` throws, about `service.ts:136-149`). `createTenant` uses status `provisioning`; the design said `active`. | Use `INSERT ... ON CONFLICT (slug_key) DO NOTHING RETURNING id` in a loop of at most 5 tries with a fresh suffix. No exception aborts the transaction. Status: follow `createTenant` exactly (insert as `provisioning`, set `active` at the end of the same transaction), so every reader of the status sees one flow. |
| 8 | Med | The organisation name has no rule. A visitor can name an organisation "Google". The invitation mail goes out from the platform sender and certificates carry the name. | (a) A blocklist of well-known brand and authority names (a data file that staff can edit). (b) Column `tenants.org_verified boolean DEFAULT false` for self-serve. While false, invitation mail carries the line "Sent through AssessIQ by an organisation that AssessIQ has not verified". (c) **Owner question:** should certificates from an unverified organisation carry a small line "Issued by an organisation not verified by AssessIQ"? This is not a "Trial" mark, and the owner said no mark. Default until answered: no line on certificates. Staff set `org_verified` by hand. |
| 9 | Low-Med | `02-tenancy/purge.ts` (about line 89) deletes from every table with a `tenant_id` column. With no DELETE grant and no DELETE policy it fails or needs a grant. `signup_claims` has a `tenant_id` column too, so purge would free the email claim. The table keeps email data with no retention rule. | Name the claims column `claimed_tenant_id` (purge ignores it). The claim stays after a tenant purge, so the email stays used (staff can delete a claim by hand). `email_key` is `HMAC-SHA256(server key, normalised email)`, so the table holds no readable email. For `tenant_legal_acceptances`: purge runs under the system role. The build adds an explicit DELETE grant to the purge role only, and the purge first writes a minimal archive row (tenant id, document, version, accepted_at). **Lawyer question:** how long must acceptance evidence be kept after a purge? |
| 10 | Low | `audit_log.tenant_id` is NOT NULL (migration 0050). `signup.rejected` needs a named tenant. The table's `ip` and `user_agent` columns would hold the plain IP of anonymous callers. `email_log` keeps the plain code and address (see `erasure.ts` about lines 196-202), and the platform tenant never erases them. | Use the existing internal tenant id (the one the billing tests call `INTERNAL_TENANT_ID`). For `signup.*` rows set `ip` and `user_agent` to NULL (the hash goes in `after`). Sign-up mails must not store the plain code: call the sender with a "no body log" option, or store the template id and a redacted body. The build adds a rule that purges `email_log` rows of the internal tenant after 30 days, and a test that proves the code is not stored. |
| 11 | - | Checked and fine (reviewer): `PLAN_TIERS_ENFORCED` early returns at `service.ts:803,818,831`; the claims primary key stops two tenants for one `email_key`; the IP source fails closed. | No change. |

**Build rows implied (not built):** FU-OTP-ATOMIC; the five-path candidate counter; the AI allowance guard. They stay in the Z-71 build plan, split as: row (a) sign-up core, row (b) Free limits and kill switch.

**Owner questions added:** (1) a certificate line for unverified organisations (finding 8c); (2) should drafts count as AI attempts (finding 6).
